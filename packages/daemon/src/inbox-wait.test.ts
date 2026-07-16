import { afterEach, describe, expect, it, vi } from "vitest"
import type { MessageInsertedInfo } from "./lib/context.ts"
import { createTribeContext } from "./lib/context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./lib/database.ts"
import { handleToolCall, type HandlerOpts } from "./lib/handlers.ts"
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
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

function makeContext(db: ReturnType<typeof openDatabase>, stmts: TribeStatements, sessionId: string, name: string) {
  return createTribeContext({
    db,
    stmts,
    sessionId,
    sessionRole: "member",
    initialName: name,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
}

function makeOpts(inboxWait?: HandlerOpts["inboxWait"]): HandlerOpts {
  return {
    cleanup: () => {},
    userRenamed: false,
    setUserRenamed: () => {},
    getActiveSessionIds: () => new Set<string>(),
    getActiveSessionInfo: () => [],
    inboxWait,
  }
}

describe("createInboxWaitManager", () => {
  it("returns immediately when actionable unread messages already exist", async () => {
    const manager = createInboxWaitManager((session) => status(session, 3))
    const result = await manager.wait("@ci", "conn-1", 30_000)
    expect(result).toMatchObject({
      session: "@ci",
      unread_count: 3,
      timed_out: false,
      aborted: false,
      waited_ms: 0,
    })
  })

  it("ignores ambient traffic and wakes on actionable direct messages", async () => {
    vi.useFakeTimers()
    let unread = 0
    const manager = createInboxWaitManager((session) => status(session, unread))

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
    const manager = createInboxWaitManager((session) => status(session, unread))

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
      session: "@ci",
      unread_count: 1,
      timed_out: false,
      aborted: false,
    })
  })

  it("does not wake when the drain-cursor count is still zero (wake keyed on the cursor, not structural match)", async () => {
    // Goal 2 — the wake must agree with the snapshot. The snapshot returns
    // immediately only when `readStatus().unread_count > 0` (the drain-cursor ×
    // actionable-class count from Agent3's mailbox cursor). The wake path must
    // use the SAME predicate: a structurally-matching actionable direct that the
    // count still excludes — a self-directed one (sender == recipient), or one
    // already acknowledged by the cursor — must NOT settle a blocked waiter.
    // Reproduces the chief 5ms-return case at the wake seam: an early return
    // with `unread_count: 0` is a wait that failed to block.
    vi.useFakeTimers()
    let unread = 0
    const manager = createInboxWaitManager((session) => status(session, unread))

    const wait = manager.wait("@chief", "conn-1", 1_000)
    let settled = false
    void wait.then(() => {
      settled = true
    })

    // Structurally an actionable direct to @chief, but the count still reads 0
    // (e.g. self-directed / already-drained). Must not wake the waiter.
    manager.onMessageInserted(
      message({
        type: "request",
        kind: "direct",
        recipient: "@chief",
        sender: "@chief",
        content: "note to self",
      }),
    )
    vi.advanceTimersByTime(50)
    await Promise.resolve()
    expect(settled).toBe(false)

    // A genuine NEW actionable moves the count past the cursor — that DOES wake.
    unread = 1
    manager.onMessageInserted(
      message({
        type: "request",
        kind: "direct",
        recipient: "@chief",
        sender: "@agent/2",
        content: "real work past the cursor",
      }),
    )
    const result = await wait
    expect(result).toMatchObject({
      session: "@chief",
      unread_count: 1,
      timed_out: false,
      aborted: false,
    })
  })

  it("times out when no actionable message arrives", async () => {
    vi.useFakeTimers()
    const manager = createInboxWaitManager((session) => status(session, 0))

    const wait = manager.wait("@ci", "conn-1", 100)
    vi.advanceTimersByTime(100)

    const result = await wait
    expect(result).toMatchObject({
      session: "@ci",
      unread_count: 0,
      timed_out: true,
      aborted: false,
    })
  })

  it("aborts pending waits when the connection closes", async () => {
    vi.useFakeTimers()
    const manager = createInboxWaitManager((session) => status(session, 0))

    const wait = manager.wait("@ci", "conn-1", 1_000)
    manager.cancelConnection("conn-1")

    const result = await wait
    expect(result).toMatchObject({
      session: "@ci",
      unread_count: 0,
      timed_out: false,
      aborted: true,
    })
  })
})

describe("tribe.inbox.wait handler wiring", () => {
  it("delegates to the shared inbox wait primitive", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "tribe-inbox-wait-"))
    const db = openDatabase(join(tmpDir, "tribe.db"))
    const stmts = createStatements(db)
    try {
      const ctx = makeContext(db, stmts, "conn-1", "@ci")
      const result = await handleToolCall(
        ctx,
        "tribe.inbox.wait",
        { timeout_ms: 1234 },
        makeOpts({
          wait: async (session, _connId, timeoutMs) => ({
            session,
            unread_count: 7,
            oldest_unread_age_min: 12,
            oldest_unread_ts: 42,
            waited_ms: timeoutMs,
            timed_out: false,
            aborted: false,
          }),
        }),
      )
      const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}") as {
        session?: string
        unread_count?: number
        waited_ms?: number
        timed_out?: boolean
      }
      expect(parsed.session).toBe("@ci")
      expect(parsed.unread_count).toBe(7)
      expect(parsed.waited_ms).toBe(1234)
      expect(parsed.timed_out).toBe(false)
    } finally {
      db.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe("inbox wait keyed on the drain cursor (Goal 2, real mailbox)", () => {
  it("blocks after the backlog is drained; self-directed does not wake, a new actionable does", async () => {
    vi.useFakeTimers()
    const tmpDir = mkdtempSync(join(tmpdir(), "tribe-g2-"))
    const db = openDatabase(join(tmpDir, "tribe.db"))
    const stmts = createStatements(db)
    try {
      const readInboxStatus = (name: string): InboxStatus => {
        const row = stmts.getUnreadDms.get({ $name: name }) as { count: number; oldest_ts: number } | undefined
        const oldest_ts = row?.oldest_ts ?? 0
        return {
          session: name,
          unread_count: row?.count ?? 0,
          oldest_unread_age_min: oldest_ts > 0 ? Math.floor((Date.now() - oldest_ts) / 60_000) : 0,
          oldest_unread_ts: oldest_ts,
        }
      }
      const manager = createInboxWaitManager(readInboxStatus)
      const daemonCtx = createTribeContext({
        db,
        stmts,
        sessionId: "daemon",
        sessionRole: "daemon",
        initialName: "daemon",
        domains: [],
        claudeSessionId: null,
        claudeSessionName: null,
        onMessageInserted: (info) => manager.onMessageInserted(info),
      })
      const drainAll = (name: string): void => {
        for (;;) {
          const tail = (stmts.getMessageTailSeq.get() as { seq: number } | null)?.seq ?? 0
          const rows = stmts.selectUnackedActionables.all({ $name: name, $upto: tail, $limit: 100 }) as Array<{
            rowid: number
          }>
          if (rows.length === 0) break
          stmts.advanceMailboxCursor.run({ $recipient: name, $seq: rows[rows.length - 1]!.rowid, $now: Date.now() })
        }
      }
      const sendActionable = (from: string, content: string): void => {
        sendMessage(
          daemonCtx,
          "@chief",
          content,
          "request",
          undefined,
          undefined,
          "direct",
          {},
          {},
          {
            sender: from,
            senderRole: "member",
          },
        )
      }

      // Standing backlog, then fully drained via Agent3's cursor — this is the
      // chief 5ms-return state (unread was > 0 forever until the cursor moved).
      for (let i = 0; i < 5; i++) sendActionable("@agent/2", `old ${i}`)
      drainAll("@chief")
      expect(readInboxStatus("@chief").unread_count).toBe(0)

      // The wait now BLOCKS. A self-directed actionable (excluded by the
      // drain-cursor × class count) must not wake it — it stays blocked to the
      // timeout. Pre-fix, the structural wake settles early with unread_count 0
      // (a wait that does not block) — that is the reproduced regression.
      const wait1 = manager.wait("@chief", "conn-1", 1_000)
      let settled1 = false
      void wait1.then(() => {
        settled1 = true
      })
      sendActionable("@chief", "note to self")
      await vi.advanceTimersByTimeAsync(100)
      expect(settled1).toBe(false)
      await vi.advanceTimersByTimeAsync(1_000)
      const r1 = await wait1
      expect(r1.timed_out).toBe(true)
      expect(r1.unread_count).toBe(0)

      // A genuine NEW actionable past the cursor DOES wake a fresh wait.
      const wait2 = manager.wait("@chief", "conn-2", 1_000)
      sendActionable("@agent/2", "new request past the cursor")
      const r2 = await wait2
      expect(r2.timed_out).toBe(false)
      expect(r2.unread_count).toBe(1)
    } finally {
      db.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
