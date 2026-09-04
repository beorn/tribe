import { afterEach, describe, expect, it, vi } from "vitest"
import type { MessageInsertedInfo } from "./lib/context.ts"
import { createTribeContext } from "./lib/context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./lib/database.ts"
import { messagingTools } from "./lib/compose/messaging-tools.ts"
import { readAttentionProjection, type AttentionProjection, type HandlerOpts } from "./lib/handlers.ts"
import { createInboxWaitManager, type InboxStatus } from "./lib/inbox-wait.ts"
import { sendMessage } from "./lib/messaging.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function status(session: string, unread: number, oldestTs = Date.now() - 120_000): InboxStatus {
  return {
    session,
    unread_count: unread,
    oldest_unread_age_min: unread > 0 ? 2 : 0,
    oldest_unread_ts: unread > 0 ? oldestTs : 0,
  }
}

const EMPTY_ATTENTION = {
  actionable_unread: [],
  pending_balls: [],
  pending_balls_summary: { total: 0, oldest_age_ms: 0, truncated: false },
}

function createTestInboxWaitManager(readStatus: (session: string) => InboxStatus) {
  const readAttention = (session: string): AttentionProjection => {
    const unread = readStatus(session).unread_count
    return {
      actionable_unread: Array.from({ length: unread }, (_, index) => ({
        id: `actionable-${index}`,
        rowid: index + 1,
        type: "request",
        from: "@sender",
        to: session,
        content: "actionable test fixture",
        bead: null,
        ref: null,
        ts: new Date(0).toISOString(),
        delivery: "pull",
        topic: null,
        room_id: null,
        summary: null,
      })),
      pending_balls: [],
      pending_balls_summary: { total: 0, oldest_age_ms: 0, truncated: false },
    }
  }
  return createInboxWaitManager(
    readStatus,
    readAttention,
    () => 0,
    (session) => (readStatus(session).unread_count > 0 ? 1 : 0),
  )
}

function realAttentionReader(
  db: ReturnType<typeof openDatabase>,
  stmts: TribeStatements,
): (session: string) => AttentionProjection {
  const reader = makeContext(db, stmts, "attention-reader", "@attention-reader")
  return (session) => readAttentionProjection(reader, session).attention
}

function message(overrides: Partial<MessageInsertedInfo>): MessageInsertedInfo {
  return {
    id: "msg-1",
    ts: Date.now(),
    rowid: 1,
    type: "notify",
    kind: "broadcast",
    sender: "@daemon",
    senderRole: "daemon",
    recipient: "*",
    content: "ambient",
    bead_id: null,
    delivery: "pull",
    topic: null,
    roomId: null,
    correlatedReply: null,
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

/**
 * `waited_ms` is WALL CLOCK, measured as `Date.now() - startedAt`. In the tests
 * below that run on real timers, a wake that returned without ever waiting
 * still reads 1-2ms whenever the machine is busy — so asserting exactly 0 made
 * them fail under full-suite parallel load, on main, for everyone. One such
 * failure ("rechecks after subscribing…", waited_ms 1 where 0 was expected)
 * masqueraded as a regression during a landing because the run's failure COUNT
 * happened to match.
 *
 * The claim these assertions exist to make is "this wake did not block", not
 * "this wake took zero milliseconds". Bounding keeps the claim and drops the
 * dependence on scheduler luck: 50ms is far below any real wait in this file
 * (the shortest is 1_000ms) yet far above scheduling jitter, so a wake that
 * genuinely blocked still fails.
 *
 * Tests driven by fake timers keep their exact assertions — there `waited_ms`
 * is deterministic and a bound would weaken them.
 */
const IMMEDIATE_WAKE_MS = 50
const immediateWakeMs = {
  asymmetricMatch: (actual: unknown): boolean =>
    typeof actual === "number" && actual >= 0 && actual <= IMMEDIATE_WAKE_MS,
  toString: () => `ImmediateWake(<=${IMMEDIATE_WAKE_MS}ms)`,
}

function makeContext(
  db: ReturnType<typeof openDatabase>,
  stmts: TribeStatements,
  sessionId: string,
  name: string,
  onMessageInserted?: (info: MessageInsertedInfo) => void,
) {
  return createTribeContext({
    db,
    stmts,
    sessionId,
    sessionRole: "member",
    initialName: name,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
    onMessageInserted,
  })
}

function makeOpts(inboxWait?: HandlerOpts["inboxWait"]): HandlerOpts {
  return {
    cleanup: () => {},
    userRenamed: false,
    setUserRenamed: () => {},
    getActiveSessionIds: () => new Set<string>(),
    hasActiveTransport: () => false,
    getActiveSessionInfo: () => [],
    inboxWait,
  }
}

describe("createInboxWaitManager", () => {
  it("returns one canonical wake with the current attention projection", async () => {
    const attention = {
      actionable_unread: [{ id: "actionable-1" }],
      pending_balls: [{ request_id: "request-1" }],
      pending_balls_summary: { total: 1, oldest_age_ms: 5_000, truncated: false },
    }
    const manager = createInboxWaitManager(
      (session) => status(session, 3),
      () => attention,
      () => 0,
      () => 1,
    )
    const result = await manager.wait("@ci", "conn-1", 0)
    expect(result).toMatchObject({
      status: "woken",
      session: "@ci",
      unread_count: 1,
      timed_out: false,
      aborted: false,
      waited_ms: immediateWakeMs,
      effective_timeout_ms: 0,
      attention,
    })
  })

  it("carries a pending ball without treating it as inbox activity", async () => {
    const attention = {
      actionable_unread: [],
      pending_balls: [{ request_id: "request-1" }],
      pending_balls_summary: { total: 1, oldest_age_ms: 5_000, truncated: false },
    }
    const manager = createInboxWaitManager(
      (session) => status(session, 0),
      () => attention,
    )

    await expect(manager.wait("@ci", "conn-pending", 0)).resolves.toMatchObject({
      status: "timeout",
      timed_out: true,
      attention,
    })
  })

  it("rechecks after subscribing so a row in the registration gap cannot be lost", async () => {
    let durableReads = 0
    const manager = createInboxWaitManager(
      (session) => status(session, 0),
      () => EMPTY_ATTENTION,
      () => (durableReads++ === 0 ? 0 : 1),
      () => 0,
    )

    await expect(manager.wait("@ci", "conn-race", 1_000)).resolves.toMatchObject({
      status: "woken",
      timed_out: false,
      waited_ms: immediateWakeMs,
    })
  })

  it("ignores ambient traffic and wakes on actionable direct messages", async () => {
    vi.useFakeTimers()
    let unread = 0
    const manager = createTestInboxWaitManager((session) => status(session, unread))

    const wait = manager.wait("@ci", "conn-1", 1_000)
    let settled = false
    wait.then(() => {
      settled = true
    })

    manager.onMessageInserted(
      message({
        type: "status",
        kind: "broadcast",
        recipient: "*",
        sender: "daemon",
        content: "ambient update",
      }),
    )

    vi.advanceTimersByTime(50)
    await Promise.resolve()
    expect(settled).toBe(false)

    unread = 1
    manager.onMessageInserted(
      message({
        type: "query",
        kind: "direct",
        recipient: "@ci",
        sender: "@chief",
        content: "need a CI verdict",
      }),
    )

    const result = await wait
    expect(result).toMatchObject({
      status: "woken",
      session: "@ci",
      unread_count: 1,
      timed_out: false,
      aborted: false,
    })
    expect(result.waited_ms).toBeGreaterThanOrEqual(0)
  })

  it("does not wake on direct notify messages", async () => {
    vi.useFakeTimers()
    let unread = 0
    const manager = createTestInboxWaitManager((session) => status(session, unread))

    const wait = manager.wait("@ci", "conn-1", 1_000)
    let settled = false
    wait.then(() => {
      settled = true
    })

    manager.onMessageInserted(
      message({
        type: "notify",
        kind: "direct",
        recipient: "@ci",
        sender: "@chief",
        content: "policy note",
      }),
    )

    vi.advanceTimersByTime(50)
    await Promise.resolve()
    expect(settled).toBe(false)

    unread = 1
    manager.onMessageInserted(
      message({
        type: "request",
        kind: "direct",
        recipient: "@ci",
        sender: "@chief",
        content: "please ack this policy",
      }),
    )

    const result = await wait
    expect(result).toMatchObject({
      status: "woken",
      session: "@ci",
      unread_count: 1,
      timed_out: false,
      aborted: false,
    })
  })

  it("does not wake on the retired daemon-only ball reminder type", async () => {
    vi.useFakeTimers()
    let unread = 0
    const manager = createTestInboxWaitManager((session) => status(session, unread))
    const wait = manager.wait("@author", "conn-1", 1_000)

    manager.onMessageInserted(
      message({
        type: "ball:reminder",
        kind: "direct",
        recipient: "@author",
        sender: "daemon",
        content: "Pending ball needs a sender decision",
      }),
    )
    await Promise.resolve()
    vi.advanceTimersByTime(1_000)

    await expect(wait).resolves.toMatchObject({
      session: "@author",
      unread_count: 0,
      timed_out: true,
      aborted: false,
    })
  })

  it("does not return early when a structural match is still drained by the mailbox cursor", async () => {
    vi.useFakeTimers()
    let unread = 0
    const manager = createTestInboxWaitManager((session) => status(session, unread))
    const wait = manager.wait("@chief", "conn-cursor", 1_000)
    let settled = false
    void wait.then(() => {
      settled = true
    })

    manager.onMessageInserted(
      message({
        type: "request",
        kind: "direct",
        recipient: "@chief",
        sender: "@chief",
      }),
    )
    await vi.advanceTimersByTimeAsync(50)
    expect(settled).toBe(false)

    unread = 1
    manager.onMessageInserted(
      message({
        type: "request",
        kind: "direct",
        recipient: "@chief",
        sender: "@agent/2",
      }),
    )
    await expect(wait).resolves.toMatchObject({ unread_count: 1, timed_out: false, aborted: false })
  })

  it("keeps replies quiet by default and opt-in wakes only on a validated tracked-request reply", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "tribe-inbox-wait-reply-"))
    const db = openDatabase(join(tmpDir, "tribe.db"))
    const stmts = createStatements(db)
    const manager = createTestInboxWaitManager((session) => status(session, 0))
    const requester = makeContext(db, stmts, "requester", "@requester", manager.onMessageInserted)
    const otherRequester = makeContext(db, stmts, "other-requester", "@other", manager.onMessageInserted)
    const responder = makeContext(db, stmts, "responder", "@responder", manager.onMessageInserted)

    const sendRequest = (requestId: string): void => {
      sendMessage(
        requester,
        "@responder",
        "please respond",
        "request",
        undefined,
        undefined,
        "direct",
        {},
        {
          request: requestId,
        },
      )
    }
    const sendReply = (type: "notify" | "response" | "status", reply: string): void => {
      sendMessage(responder, "@requester", "correlated reply", type, undefined, undefined, "direct", {}, { reply })
    }

    try {
      sendRequest("req-default")
      const defaultWait = manager.wait("@requester", "conn-default", 1_000)
      let defaultSettled = false
      void defaultWait.then(() => {
        defaultSettled = true
      })
      sendReply("response", "req-default")
      await Promise.resolve()
      expect(defaultSettled).toBe(false)
      manager.cancelConnection("conn-default")
      await defaultWait

      sendRequest("req-notify")
      const notifyWait = manager.wait("@requester", "conn-notify", 1_000, { wakeOnCorrelatedReply: true })
      let notifySettled = false
      void notifyWait.then(() => {
        notifySettled = true
      })
      sendReply("notify", "req-notify")
      await Promise.resolve()
      expect(notifySettled).toBe(false)
      manager.cancelConnection("conn-notify")
      await notifyWait

      for (const type of ["response", "status"] as const) {
        const requestId = `req-${type}`
        const connId = `conn-${type}`
        sendRequest(requestId)
        const wait = manager.wait("@requester", connId, 1_000, { wakeOnCorrelatedReply: true })
        let result: Awaited<typeof wait> | undefined
        void wait.then((value) => {
          result = value
        })

        sendReply(type, `missing-${requestId}`)
        await Promise.resolve()
        expect(result).toBeUndefined()

        sendReply(type, requestId)
        await Promise.resolve()
        const settled = result !== undefined
        if (!settled) manager.cancelConnection(connId)
        expect(settled).toBe(true)
        expect(result).toMatchObject({ unread_count: 0, timed_out: false, aborted: false })
        await wait
      }

      sendMessage(
        otherRequester,
        "@responder",
        "other request",
        "request",
        undefined,
        undefined,
        "direct",
        {},
        { request: "req-other" },
      )
      const unrelatedWait = manager.wait("@requester", "conn-unrelated", 1_000, {
        wakeOnCorrelatedReply: true,
      })
      let unrelatedSettled = false
      void unrelatedWait.then(() => {
        unrelatedSettled = true
      })
      sendMessage(
        responder,
        "@requester",
        "valid reply for another requester",
        "response",
        undefined,
        undefined,
        "direct",
        {},
        { reply: "req-other" },
      )
      await Promise.resolve()
      expect(unrelatedSettled).toBe(false)
      manager.cancelConnection("conn-unrelated")
      await unrelatedWait
    } finally {
      db.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("fresh opt-in wait wakes for a pre-existing validated reply only", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "tribe-inbox-wait-current-reply-"))
    const db = openDatabase(join(tmpDir, "tribe.db"))
    const stmts = createStatements(db)
    const manager = createInboxWaitManager(
      (session) => status(session, 0),
      realAttentionReader(db, stmts),
      (session, wakeOnCorrelatedReply) => realLatestInboxWaitSeq(stmts, session, wakeOnCorrelatedReply),
      (session, wakeOnCorrelatedReply) => realLatestInboxWaitSeq(stmts, session, wakeOnCorrelatedReply, true),
    )
    const requester = makeContext(db, stmts, "requester", "@requester", manager.onMessageInserted)
    const responder = makeContext(db, stmts, "responder", "@responder", manager.onMessageInserted)

    try {
      sendMessage(
        responder,
        "@requester",
        "unvalidated response",
        "response",
        undefined,
        undefined,
        "direct",
        {},
        { reply: "missing-request" },
      )
      await expect(
        manager.wait("@requester", "conn-unvalidated-current", 0, { wakeOnCorrelatedReply: true }),
      ).resolves.toMatchObject({ status: "timeout", timed_out: true })

      sendMessage(
        requester,
        "@responder",
        "please respond",
        "request",
        undefined,
        undefined,
        "direct",
        {},
        { request: "req-current" },
      )
      sendMessage(
        responder,
        "@requester",
        "validated status",
        "status",
        undefined,
        undefined,
        "direct",
        {},
        { reply: "req-current" },
      )

      await expect(manager.wait("@requester", "conn-default-current", 0)).resolves.toMatchObject({
        status: "timeout",
        timed_out: true,
      })
      await expect(
        manager.wait("@requester", "conn-validated-current", 0, { wakeOnCorrelatedReply: true }),
      ).resolves.toMatchObject({
        status: "woken",
        timed_out: false,
        waited_ms: immediateWakeMs,
      })
    } finally {
      db.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("re-armed opt-in wait wakes for a validated reply that landed between chunks", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "tribe-inbox-wait-reply-gap-"))
    const db = openDatabase(join(tmpDir, "tribe.db"))
    const stmts = createStatements(db)
    const manager = createInboxWaitManager(
      (session) => status(session, 0),
      realAttentionReader(db, stmts),
      (session, wakeOnCorrelatedReply) => realLatestInboxWaitSeq(stmts, session, wakeOnCorrelatedReply),
    )
    const requester = makeContext(db, stmts, "requester", "@requester", manager.onMessageInserted)
    const responder = makeContext(db, stmts, "responder", "@responder", manager.onMessageInserted)

    try {
      sendMessage(
        requester,
        "@responder",
        "please respond",
        "request",
        undefined,
        undefined,
        "direct",
        {},
        { request: "req-gap" },
      )
      const baseline = await manager.wait("@requester", "conn-baseline", 0, { wakeOnCorrelatedReply: true })

      sendMessage(
        responder,
        "@requester",
        "unvalidated response while between chunks",
        "response",
        undefined,
        undefined,
        "direct",
        {},
        { reply: "missing-request" },
      )
      await expect(
        manager.wait("@requester", "conn-after-invalid-gap", 1, {
          wakeOnCorrelatedReply: true,
          afterSeq: baseline.baseline_seq,
        }),
      ).resolves.toMatchObject({ status: "timeout", timed_out: true })

      sendMessage(
        responder,
        "@requester",
        "reply while between chunks",
        "response",
        undefined,
        undefined,
        "direct",
        {},
        { reply: "req-gap" },
      )
      expect(
        db
          .prepare("SELECT correlated_reply_requester FROM messages WHERE recipient = ? AND content = ? ORDER BY rowid")
          .all("@requester", "unvalidated response while between chunks"),
      ).toEqual([{ correlated_reply_requester: null }])
      expect(
        db
          .prepare("SELECT correlated_reply_requester FROM messages WHERE recipient = ? AND content = ?")
          .get("@requester", "reply while between chunks"),
      ).toEqual({ correlated_reply_requester: "@requester" })

      await expect(
        manager.wait("@requester", "conn-default-after-gap", 1, {
          afterSeq: baseline.baseline_seq,
        }),
      ).resolves.toMatchObject({ status: "timeout", timed_out: true })

      await expect(
        manager.wait("@requester", "conn-after-gap", 1, {
          wakeOnCorrelatedReply: true,
          afterSeq: baseline.baseline_seq,
        }),
      ).resolves.toMatchObject({
        status: "woken",
        timed_out: false,
        aborted: false,
        waited_ms: immediateWakeMs,
      })
    } finally {
      db.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("times out when no actionable message arrives", async () => {
    vi.useFakeTimers()
    const manager = createTestInboxWaitManager((session) => status(session, 0))

    const wait = manager.wait("@ci", "conn-1", 100)
    vi.advanceTimersByTime(100)

    const result = await wait
    expect(result).toMatchObject({
      status: "timeout",
      session: "@ci",
      unread_count: 0,
      timed_out: true,
      aborted: false,
    })
  })

  it("keeps deadline attention on a raw timeout so an outer logical wait can continue", async () => {
    vi.useFakeTimers()
    const attention = {
      actionable_unread: [{ id: "response-at-deadline", type: "response" }],
      pending_balls: [],
      pending_balls_summary: { total: 0, oldest_age_ms: 0, truncated: false },
    }
    const manager = createInboxWaitManager(
      (session) => status(session, 0),
      () => attention,
    )

    const wait = manager.wait("@ci", "conn-1", 100)
    vi.advanceTimersByTime(100)

    await expect(wait).resolves.toMatchObject({
      status: "timeout",
      session: "@ci",
      // Was asserted as 0, which pinned the contradiction this payload used to
      // carry: a caller handed one actionable row and told the count is zero
      // reads the count, concludes nothing arrived, and sleeps on top of it.
      // The point of this test — attention survives a raw timeout so an outer
      // logical wait can continue — is unchanged and still asserted below.
      unread_count: 1,
      timed_out: true,
      aborted: false,
      attention,
    })
  })

  it("aborts pending waits when the connection closes", async () => {
    vi.useFakeTimers()
    const manager = createTestInboxWaitManager((session) => status(session, 0))

    const wait = manager.wait("@ci", "conn-1", 1_000)
    manager.cancelConnection("conn-1")

    const result = await wait
    expect(result).toMatchObject({
      status: "aborted",
      session: "@ci",
      unread_count: 0,
      timed_out: false,
      aborted: true,
    })
  })

  it("returns a reconnect signal to every pending wait during daemon shutdown", async () => {
    vi.useFakeTimers()
    const manager = createTestInboxWaitManager((session) => status(session, 0))

    const wait = manager.wait("@ci", "conn-1", 60_000)
    manager.shutdown()

    await expect(wait).resolves.toMatchObject({
      status: "woken",
      timed_out: false,
      aborted: false,
      reconnect: true,
    })
  })

  /**
   * CTO residual 2026-07-25 on @tent/tooling/21420: live @dev/3 sat in
   * `tribe inbox-wait` while a type=assign addressed to it had already landed.
   * Unit tests above mock unread_count and never send a real assign through
   * the insert → unread SQL → wake path. This pins every default-wake type
   * (request/query/verdict/assign) against the real getUnreadDms projection.
   */
  function realUnreadReader(stmts: TribeStatements): (session: string) => InboxStatus {
    return (session: string): InboxStatus => {
      const row = stmts.getUnreadDms.get({ $name: session }) as { count: number; oldest_ts: number } | undefined
      const unread = row?.count ?? 0
      const oldestTs = row?.oldest_ts ?? 0
      return {
        session,
        unread_count: unread,
        oldest_unread_age_min: oldestTs > 0 ? Math.floor((Date.now() - oldestTs) / 60_000) : 0,
        oldest_unread_ts: oldestTs,
      }
    }
  }

  function realLatestInboxWaitSeq(
    stmts: TribeStatements,
    session: string,
    wakeOnCorrelatedReply = false,
    unacknowledgedOnly = false,
  ): number {
    const row = stmts.getLatestInboxWaitMessage.get({
      $name: session,
      $include_correlated_replies: wakeOnCorrelatedReply ? 1 : 0,
      $unacknowledged_only: unacknowledgedOnly ? 1 : 0,
    }) as { rowid: number } | undefined
    return row?.rowid ?? 0
  }

  it("wakes on real DB assign (and every other actionable type) without a mock unread counter", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "tribe-inbox-wait-assign-"))
    const db = openDatabase(join(tmpDir, "tribe.db"))
    const stmts = createStatements(db)
    const readStatus = realUnreadReader(stmts)
    const manager = createInboxWaitManager(
      readStatus,
      realAttentionReader(db, stmts),
      (session, wakeOnCorrelatedReply) => realLatestInboxWaitSeq(stmts, session, wakeOnCorrelatedReply),
      (session, wakeOnCorrelatedReply) => realLatestInboxWaitSeq(stmts, session, wakeOnCorrelatedReply, true),
    )
    const chief = makeContext(db, stmts, "chief", "@chief", manager.onMessageInserted)

    try {
      for (const type of ["request", "query", "verdict", "assign"] as const) {
        const recipient = `@seat-${type}`
        const wait = manager.wait(recipient, `conn-${type}`, 2_000)
        let settled: Awaited<typeof wait> | undefined
        void wait.then((value) => {
          settled = value
        })

        await Promise.resolve()
        expect(settled).toBeUndefined()
        expect(readStatus(recipient).unread_count).toBe(0)

        sendMessage(chief, recipient, `wake via ${type}`, type, undefined, undefined, "direct")
        await Promise.resolve()
        await Promise.resolve()

        expect(settled, `${type} must wake inbox.wait`).toBeDefined()
        expect(settled).toMatchObject({
          status: "woken",
          session: recipient,
          timed_out: false,
          aborted: false,
        })
        expect(settled!.unread_count).toBeGreaterThan(0)
        await wait
      }
    } finally {
      db.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("wakes immediately for a pre-existing unacknowledged actionable row", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "tribe-inbox-wait-new-row-"))
    const db = openDatabase(join(tmpDir, "tribe.db"))
    const stmts = createStatements(db)
    const readStatus = realUnreadReader(stmts)
    const manager = createInboxWaitManager(
      readStatus,
      realAttentionReader(db, stmts),
      (session, wakeOnCorrelatedReply) => realLatestInboxWaitSeq(stmts, session, wakeOnCorrelatedReply),
      (session, wakeOnCorrelatedReply) => realLatestInboxWaitSeq(stmts, session, wakeOnCorrelatedReply, true),
    )
    const chief = makeContext(db, stmts, "chief", "@chief", manager.onMessageInserted)
    const seat = "@dev/1"

    try {
      sendMessage(chief, seat, "still unacknowledged before the wait", "verdict", undefined, undefined, "direct")
      expect(readStatus(seat).unread_count).toBe(1)

      await expect(manager.wait(seat, "conn-current-row", 2_000)).resolves.toMatchObject({
        status: "woken",
        session: seat,
        timed_out: false,
        aborted: false,
        waited_ms: immediateWakeMs,
      })
    } finally {
      db.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("does not wake for an acknowledged historical actionable row", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "tribe-inbox-wait-acknowledged-row-"))
    const db = openDatabase(join(tmpDir, "tribe.db"))
    const stmts = createStatements(db)
    const readStatus = realUnreadReader(stmts)
    const manager = createInboxWaitManager(
      readStatus,
      realAttentionReader(db, stmts),
      (session, wakeOnCorrelatedReply) => realLatestInboxWaitSeq(stmts, session, wakeOnCorrelatedReply),
      (session, wakeOnCorrelatedReply) => realLatestInboxWaitSeq(stmts, session, wakeOnCorrelatedReply, true),
    )
    const chief = makeContext(db, stmts, "chief", "@chief", manager.onMessageInserted)
    const seat = "@dev/1"

    try {
      sendMessage(chief, seat, "already handled before the wait", "verdict", undefined, undefined, "direct")
      const latest = stmts.getLatestActionableAttention.get({ $name: seat }) as { rowid: number }
      stmts.advanceMailboxCursor.run({ $recipient: seat, $seq: latest.rowid, $now: Date.now() })
      expect(readStatus(seat).unread_count).toBe(0)

      await expect(manager.wait(seat, "conn-acknowledged-row", 0)).resolves.toMatchObject({
        status: "timeout",
        timed_out: true,
        aborted: false,
      })
    } finally {
      db.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("re-armed wait returns immediately when assign landed between chunks (reconnect gap)", async () => {
    // CLI wait closes the socket after each chunk (callInboxWaitChunk finally
    // client.close → cancelConnection). An assign that arrives in the gap
    // between chunks must still wake the next wait from the logical wait's
    // durable baseline, without treating rows older than that baseline as new.
    const tmpDir = mkdtempSync(join(tmpdir(), "tribe-inbox-wait-gap-"))
    const db = openDatabase(join(tmpDir, "tribe.db"))
    const stmts = createStatements(db)
    const readStatus = realUnreadReader(stmts)
    const manager = createInboxWaitManager(
      readStatus,
      realAttentionReader(db, stmts),
      (session, wakeOnCorrelatedReply) => realLatestInboxWaitSeq(stmts, session, wakeOnCorrelatedReply),
    )
    const chief = makeContext(db, stmts, "chief", "@chief", manager.onMessageInserted)
    const seat = "@dev/3"

    try {
      const first = manager.wait(seat, "conn-chunk-1", 5_000)
      manager.cancelConnection("conn-chunk-1") // simulate chunk socket close
      const firstResult = await first
      expect(firstResult).toMatchObject({ aborted: true, unread_count: 0, baseline_seq: 0 })

      // Assign lands while NO waiter is registered (inter-chunk gap).
      sendMessage(chief, seat, "assign while between chunks", "assign", undefined, undefined, "direct")
      expect(readStatus(seat).unread_count).toBeGreaterThan(0)

      // Next chunk re-arms — must wake immediately from the durable logical baseline.
      const second = await manager.wait(seat, "conn-chunk-2", 5_000, { afterSeq: firstResult.baseline_seq })
      expect(second).toMatchObject({
        status: "woken",
        session: seat,
        timed_out: false,
        aborted: false,
      })
      expect(second.unread_count).toBeGreaterThan(0)
      expect(second.waited_ms).toBeLessThanOrEqual(IMMEDIATE_WAKE_MS)
    } finally {
      db.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("re-armed wait keeps tracked gap work actionable after delivery acknowledgement", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "tribe-inbox-wait-gap-ack-"))
    const db = openDatabase(join(tmpDir, "tribe.db"))
    const stmts = createStatements(db)
    const readStatus = realUnreadReader(stmts)
    const manager = createInboxWaitManager(
      readStatus,
      realAttentionReader(db, stmts),
      (session, wakeOnCorrelatedReply) => realLatestInboxWaitSeq(stmts, session, wakeOnCorrelatedReply),
    )
    const chief = makeContext(db, stmts, "chief", "@chief", manager.onMessageInserted)
    const seat = "@dev/3"

    try {
      const baseline = await manager.wait(seat, "conn-baseline", 0)
      expect(baseline).toMatchObject({ timed_out: true, baseline_seq: 0 })

      sendMessage(chief, seat, "assign while between chunks", "assign", undefined, undefined, "direct")
      const latest = stmts.getLatestActionableAttention.get({ $name: seat }) as { rowid: number }
      stmts.advanceMailboxCursor.run({ $recipient: seat, $seq: latest.rowid, $now: Date.now() })
      expect(readStatus(seat).unread_count).toBe(1)

      await expect(
        manager.wait(seat, "conn-after-ack", 5_000, { afterSeq: baseline.baseline_seq }),
      ).resolves.toMatchObject({
        status: "woken",
        session: seat,
        timed_out: false,
        aborted: false,
        unread_count: 1,
        waited_ms: immediateWakeMs,
      })
    } finally {
      db.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("does not lose a live waiter when assign lands under a concurrent cursor advance race", async () => {
    // If onMessageInserted fires while getUnreadDms still returns 0 (cursor
    // lag / concurrent ack), the waiter must still wake from the message
    // type alone — otherwise live assign is silent and the seat times out.
    const tmpDir = mkdtempSync(join(tmpdir(), "tribe-inbox-wait-race-"))
    const db = openDatabase(join(tmpDir, "tribe.db"))
    const stmts = createStatements(db)
    let forceZeroUnread = false
    const readStatus = (session: string): InboxStatus => {
      if (forceZeroUnread) return status(session, 0)
      return realUnreadReader(stmts)(session)
    }
    const manager = createInboxWaitManager(
      readStatus,
      realAttentionReader(db, stmts),
      (session, wakeOnCorrelatedReply) => realLatestInboxWaitSeq(stmts, session, wakeOnCorrelatedReply),
    )
    const chief = makeContext(db, stmts, "chief", "@chief", manager.onMessageInserted)
    const seat = "@dev/3"

    try {
      const wait = manager.wait(seat, "conn-race", 2_000)
      let settled: Awaited<typeof wait> | undefined
      void wait.then((value) => {
        settled = value
      })

      forceZeroUnread = true // simulate unread lag at insert notification time
      sendMessage(chief, seat, "assign during unread lag", "assign", undefined, undefined, "direct")
      await Promise.resolve()
      await Promise.resolve()

      // Capture wake state BEFORE any cancel — cancel would set settled via abort.
      const wokenDespiteLag = settled !== undefined && settled.aborted !== true
      forceZeroUnread = false
      // Durable projection still sees the assign once lag ends.
      expect(readStatus(seat).unread_count).toBeGreaterThan(0)
      if (!wokenDespiteLag) manager.cancelConnection("conn-race")
      await wait
      expect(wokenDespiteLag, "assign must wake a live waiter even when getUnreadDms lags at insert time").toBe(true)
    } finally {
      db.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe("tribe.inbox.wait handler wiring", () => {
  it("delegates through the registry with the transport connection as cancellation owner", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "tribe-inbox-wait-"))
    const db = openDatabase(join(tmpDir, "tribe.db"))
    const stmts = createStatements(db)
    let observed:
      | {
          session: string
          connId: string
          timeoutMs: number
          wakeOnCorrelatedReply: boolean | undefined
        }
      | undefined
    try {
      const ctx = makeContext(db, stmts, "session-1", "@ci")
      const tool = messagingTools().find((candidate) => candidate.name === "tribe.inbox.wait")
      if (!tool) throw new Error("tribe.inbox.wait registry tool is missing")
      const result = await tool.handler(
        { timeout_ms: 24 * 60 * 60_000, wake_on_correlated_reply: true },
        {
          connId: "transport-1",
          extra: {
            ctx,
            opts: makeOpts({
              wait: async (session, connId, timeoutMs, options) => {
                observed = {
                  session,
                  connId,
                  timeoutMs,
                  wakeOnCorrelatedReply: options?.wakeOnCorrelatedReply,
                }
                return {
                  status: "woken",
                  session,
                  unread_count: 7,
                  oldest_unread_age_min: 12,
                  oldest_unread_ts: 42,
                  waited_ms: timeoutMs,
                  effective_timeout_ms: timeoutMs,
                  timed_out: false,
                  aborted: false,
                  attention: EMPTY_ATTENTION,
                }
              },
            }),
          },
        },
      )
      const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}") as {
        session?: string
        unread_count?: number
        waited_ms?: number
        effective_timeout_ms?: number
        timed_out?: boolean
      }
      expect(parsed.session).toBe("@ci")
      expect(parsed.unread_count).toBe(7)
      expect(parsed.waited_ms).toBe(30 * 60_000)
      expect(parsed.effective_timeout_ms).toBe(30 * 60_000)
      expect(parsed.timed_out).toBe(false)
      expect(observed).toEqual({
        session: "@ci",
        connId: "transport-1",
        timeoutMs: 30 * 60_000,
        wakeOnCorrelatedReply: true,
      })
    } finally {
      db.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
