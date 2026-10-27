import { afterEach, describe, expect, it, vi } from "vitest"
import type { MessageInsertedInfo } from "./lib/context.ts"
import { createTribeContext } from "./lib/context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./lib/database.ts"
import { messagingTools } from "./lib/compose/messaging-tools.ts"
import { readAttentionProjection, type AttentionProjection, type HandlerOpts } from "./lib/handlers.ts"
import { createInboxWaitManager, readInboxWaitWokenBy, type InboxStatus } from "./lib/inbox-wait.ts"
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
        is_incident: false,
        from_authority: null,
        from_session_id: null,
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
  return (session) => readAttentionProjection(reader, session, Date.now(), 0, makeOpts()).attention
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
    const unread = 0
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

  it("keeps replies quiet by default and the opt-in wakes only the requester, on a status or a settling reply", async () => {
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

      for (const type of ["notify", "status"] as const) {
        const requestId = `req-${type}`
        const connId = `conn-${type}`
        sendRequest(requestId)
        const pending = db.prepare("SELECT * FROM pending_request WHERE request_id = ?").get(requestId)
        expect(pending).not.toBeNull()
        const progressWait = manager.wait("@requester", connId, 1_000, { wakeOnCorrelatedReply: true })
        let progressSettled = false
        void progressWait.then(() => {
          progressSettled = true
        })
        sendReply(type, requestId)
        await Promise.resolve()
        // 29541: under the opt-in, a progress `status` whose ref names the ball its
        // sender REQUESTED now wakes — 29535's ruling (option b, requester side only),
        // which a wait that starts after the row already honoured; the parked path now
        // agrees with it. A `notify` rides the same ref but is not a correlated reply
        // type, so it stays quiet. Neither type settles the ball.
        expect(progressSettled).toBe(type === "status")
        expect(db.prepare("SELECT * FROM pending_request WHERE request_id = ?").get(requestId)).toEqual(pending)
        manager.cancelConnection(connId)
        await progressWait
      }

      {
        const requestId = "req-response"
        const connId = "conn-response"
        sendRequest(requestId)
        const wait = manager.wait("@requester", connId, 1_000, { wakeOnCorrelatedReply: true })
        let result: Awaited<typeof wait> | undefined
        void wait.then((value) => {
          result = value
        })

        sendReply("response", `missing-${requestId}`)
        await Promise.resolve()
        expect(result).toBeUndefined()

        sendReply("response", requestId)
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

  it.each(["response", "historical status"] as const)(
    "fresh opt-in wait wakes for a pre-existing validated %s only",
    async (kind) => {
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
          "validated response",
          "response",
          undefined,
          undefined,
          "direct",
          {},
          { reply: "req-current" },
        )
        if (kind === "historical status") {
          // Before final-type settlement, stored status rows carried validated reply correlation.
          // The current writer never creates them; retain the journal reader's historical contract.
          db.prepare("UPDATE messages SET type = 'status' WHERE reply = ?").run("req-current")
        }

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
    },
  )

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
      // 30414: the unvalidated response settles nothing and wakes nothing live, but it is a direct response to the
      // waiter that ARRIVED after this wait's baseline, so the deadline reports it instead of a plain timeout.
      await expect(
        manager.wait("@requester", "conn-after-invalid-gap", 1, {
          wakeOnCorrelatedReply: true,
          afterSeq: baseline.baseline_seq,
        }),
      ).resolves.toMatchObject({
        status: "woken",
        timed_out: false,
        unread_count: 1,
      })

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

      // 30414: both responses are direct responses to the waiter, so the attention projection lists them, and
      // both ARRIVED after this wait's baseline. A default-mode wait still does not wake on them live, but its
      // deadline is not quiet either: it settles woken naming the newest retained row instead of a plain timeout.
      await expect(
        manager.wait("@requester", "conn-default-after-gap", 1, {
          afterSeq: baseline.baseline_seq,
        }),
      ).resolves.toMatchObject({
        status: "woken",
        timed_out: false,
        aborted: false,
        unread_count: 2,
      })

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

  it("keeps attention that predates the wait on a raw timeout so an outer logical wait can continue", async () => {
    vi.useFakeTimers()
    // 30414: the row is older than the wait. A fresh wait's baseline covers attention present at its start, and a
    // resumed chunk is handed a baseline at or past it, so neither manufactures a wake from it (a15abfb7).
    const attention = {
      actionable_unread: [{ id: "response-before-wait", rowid: 5, type: "response" }],
      pending_balls: [],
      pending_balls_summary: { total: 0, oldest_age_ms: 0, truncated: false },
    }
    const manager = createInboxWaitManager(
      (session) => status(session, 0),
      () => attention,
    )

    const fresh = manager.wait("@ci", "conn-fresh", 100)
    const resumed = manager.wait("@ci", "conn-resumed", 100, { afterSeq: 5 })
    vi.advanceTimersByTime(100)

    for (const wait of [fresh, resumed]) {
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
        baseline_seq: 5,
      })
    }
  })

  it("settles woken at the deadline when an actionable row arrived during the window (30414)", async () => {
    vi.useFakeTimers()
    // The wake predicate never fired for this row (a response wakes only when correlated), yet it is retained
    // actionable attention that arrived after the baseline. Plain timeout here told @dev/10 a 2-minute window was
    // quiet while the payload carried the row (#30414, recurrence of #22378).
    const attention = {
      actionable_unread: [{ id: "response-during-wait", rowid: 7, type: "response" }],
      pending_balls: [],
      pending_balls_summary: { total: 0, oldest_age_ms: 0, truncated: false },
    }
    const manager = createInboxWaitManager(
      (session) => status(session, 0),
      () => attention,
    )

    const resumed = manager.wait("@ci", "conn-resumed", 100, { afterSeq: 5 })
    const polled = manager.wait("@ci", "conn-polled", 0, { afterSeq: 5 })
    vi.advanceTimersByTime(100)

    for (const wait of [resumed, polled]) {
      await expect(wait).resolves.toMatchObject({
        status: "woken",
        session: "@ci",
        unread_count: 1,
        timed_out: false,
        aborted: false,
        attention,
        baseline_seq: 7,
      })
    }
  })

  it("AC2 (30414, superseded by 31171): a response whose ref names a closed ball opened by the requester live-wakes; status/notify on a closed ball and a response to a foreign closed ball do not live-wake", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "tribe-inbox-wait-closed-ref-"))
    const db = openDatabase(join(tmpDir, "tribe.db"))
    const stmts = createStatements(db)
    const manager = createInboxWaitManager(
      (session) => status(session, 0),
      realAttentionReader(db, stmts),
      (session, wakeOnCorrelatedReply) => realLatestInboxWaitSeq(stmts, session, wakeOnCorrelatedReply),
      (session, wakeOnCorrelatedReply) => realLatestInboxWaitSeq(stmts, session, wakeOnCorrelatedReply, true),
      (session, seq, wakeOnCorrelatedReply) => readInboxWaitWokenBy(stmts, session, seq, wakeOnCorrelatedReply),
    )
    const requester = makeContext(db, stmts, "requester", "@requester", manager.onMessageInserted)
    const responder = makeContext(db, stmts, "responder", "@responder", manager.onMessageInserted)
    const other = makeContext(db, stmts, "other", "@other", manager.onMessageInserted)

    try {
      // 1. Requester-opened ball is settled by an earlier response (e.g. TAKING response+reply).
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
          request: "req-settled",
        },
      )
      const answer = sendMessage(
        responder,
        "@requester",
        "the answer",
        "response",
        undefined,
        undefined,
        "direct",
        {},
        {
          reply: "req-settled",
        },
      )
      expect(db.prepare("SELECT * FROM pending_request WHERE request_id = ?").get("req-settled")).toBeNull()
      stmts.advanceMailboxCursor.run({ $recipient: "@requester", $seq: answer.rowid, $now: Date.now() })

      const wait = manager.wait("@requester", "conn-closed-ref", 400, { wakeOnCorrelatedReply: true })
      let result: Awaited<typeof wait> | undefined
      void wait.then((value) => {
        result = value
      })

      // 31171 (superseding 30414 AC2): a follow-up direct response whose ref names the
      // closed ball that @requester opened live-wakes immediately with settles_request_id = ref.
      const followUp = sendMessage(
        responder,
        "@requester",
        "follow-up on the settled thread",
        "response",
        undefined,
        "req-settled",
        "direct",
      )
      await Promise.resolve()
      expect(result).toBeDefined()

      await expect(wait).resolves.toMatchObject({
        status: "woken",
        timed_out: false,
        aborted: false,
        unread_count: 1,
        woken_by: {
          kind: "message",
          seq: followUp.rowid,
          message_id: followUp.id,
          type: "response",
          sender: "@responder",
          settles_request_id: "req-settled",
          replay: false,
        },
      })
      expect(result?.attention.actionable_unread.map((row) => row.id)).toContain(followUp.id)
      stmts.advanceMailboxCursor.run({ $recipient: "@requester", $seq: followUp.rowid, $now: Date.now() })

      // 2. Sibling quiet case (a): status and notify with ref to a closed ball stay quiet (no live wake, no attention).
      const quietStatusWait = manager.wait("@requester", "conn-closed-status", 40, { wakeOnCorrelatedReply: true })
      let quietStatusResult: Awaited<typeof quietStatusWait> | undefined
      void quietStatusWait.then((value) => {
        quietStatusResult = value
      })
      sendMessage(responder, "@requester", "status on closed ball", "status", undefined, "req-settled", "direct")
      sendMessage(responder, "@requester", "notify on closed ball", "notify", undefined, "req-settled", "direct")
      await Promise.resolve()
      expect(quietStatusResult).toBeUndefined()
      await expect(quietStatusWait).resolves.toMatchObject({
        status: "timeout",
        timed_out: true,
        aborted: false,
        unread_count: 0,
      })

      // 3. Sibling quiet case (b): a direct response whose ref names a closed ball NOT opened by @requester
      //    does not live-wake, and settles woken at the deadline on retained attention (30414).
      sendMessage(
        other,
        "@responder",
        "foreign request",
        "request",
        undefined,
        undefined,
        "direct",
        {},
        {
          request: "req-foreign-settled",
        },
      )
      sendMessage(
        responder,
        "@other",
        "foreign answer",
        "response",
        undefined,
        undefined,
        "direct",
        {},
        {
          reply: "req-foreign-settled",
        },
      )
      expect(db.prepare("SELECT * FROM pending_request WHERE request_id = ?").get("req-foreign-settled")).toBeNull()

      const foreignWait = manager.wait("@requester", "conn-foreign-closed-ref", 40, { wakeOnCorrelatedReply: true })
      let foreignResult: Awaited<typeof foreignWait> | undefined
      void foreignWait.then((value) => {
        foreignResult = value
      })
      const foreignFollowUp = sendMessage(
        responder,
        "@requester",
        "response referencing a foreign closed ball",
        "response",
        undefined,
        "req-foreign-settled",
        "direct",
      )
      await Promise.resolve()
      expect(foreignResult).toBeUndefined()
      await expect(foreignWait).resolves.toMatchObject({
        status: "woken",
        timed_out: false,
        aborted: false,
        unread_count: 1,
        woken_by: {
          kind: "message",
          seq: foreignFollowUp.rowid,
          message_id: foreignFollowUp.id,
          type: "response",
          sender: "@responder",
          settles_request_id: null,
          replay: false,
        },
      })
    } finally {
      db.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
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

  // 24664: a parked wait is consumer evidence for answer capability, but only
  // the mailbox owner's own wait. An operator watching another seat's mailbox
  // consumes nothing, exactly as it never writes that seat's read receipt.
  it("reports a live waiter only while the mailbox owner's own wait is parked", async () => {
    vi.useFakeTimers()
    const manager = createTestInboxWaitManager((session) => status(session, 0))
    expect(manager.hasLiveWaiter("@ci")).toBe(false)

    const observer = manager.wait("@ci", "conn-operator", 5_000)
    expect(manager.hasLiveWaiter("@ci")).toBe(false)

    const cancelled = manager.wait("@ci", "conn-ci", 1_000, { consumesMailbox: true })
    expect(manager.hasLiveWaiter("@ci")).toBe(true)
    expect(manager.hasLiveWaiter("@chief")).toBe(false)
    manager.cancelConnection("conn-ci")
    await cancelled
    expect(manager.hasLiveWaiter("@ci")).toBe(false)

    const timedOut = manager.wait("@ci", "conn-ci", 1_000, { consumesMailbox: true })
    expect(manager.hasLiveWaiter("@ci")).toBe(true)
    vi.advanceTimersByTime(1_000)
    await timedOut
    expect(manager.hasLiveWaiter("@ci")).toBe(false)

    manager.shutdown()
    await observer
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

  it("does not retire the row it reports: the wait leaves it fetch-visible and the mailbox cursor unmoved", async () => {
    // 28542 — a wait reports the row; it never consumes it. The follow-up
    // fetch is the read that acknowledges, so after a woken chunk the row must
    // still be unread and the mailbox cursor must not have moved.
    const tmpDir = mkdtempSync(join(tmpdir(), "tribe-inbox-wait-non-retiring-"))
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
    const cursorBefore = stmts.getMailboxCursor.get({ $recipient: seat }) as { last_actionable_seq: number } | undefined

    try {
      sendMessage(
        chief,
        seat,
        "the wait reports this row but must not consume it",
        "verdict",
        undefined,
        undefined,
        "direct",
      )

      await expect(manager.wait(seat, "conn-non-retiring", 2_000)).resolves.toMatchObject({
        status: "woken",
        session: seat,
        timed_out: false,
        aborted: false,
      })

      const cursorAfter = stmts.getMailboxCursor.get({ $recipient: seat }) as
        | { last_actionable_seq: number }
        | undefined
      expect(cursorAfter?.last_actionable_seq ?? 0).toBe(cursorBefore?.last_actionable_seq ?? 0)
      expect(readStatus(seat).unread_count).toBe(1)
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
          consumesMailbox: boolean | undefined
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
                  consumesMailbox: options?.consumesMailbox,
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
              hasLiveWaiter: () => false,
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
        // The caller waits on its own mailbox, so the wait is consumer evidence (24664).
        consumesMailbox: true,
      })
    } finally {
      db.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
