import { afterEach, describe, expect, it, vi } from "vitest"
import type { MessageInsertedInfo } from "./lib/context.ts"
import { createTribeContext } from "./lib/context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./lib/database.ts"
import { handleToolCall, type HandlerOpts } from "./lib/handlers.ts"
import { createInboxWaitManager, type InboxStatus } from "./lib/inbox-wait.ts"
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

function makeManager(unreadRef: { value: number }, drainCalls: string[] = []) {
  return createInboxWaitManager(
    (session) => status(session, unreadRef.value),
    (session) => {
      drainCalls.push(session)
      const n = unreadRef.value
      unreadRef.value = 0
      return {
        cursor: 100 + n,
        events: Array.from({ length: n }, (_, i) => ({
          id: `drained-${i}`,
          rowid: 100 + i,
          type: "request",
          from: "@chief",
          to: session,
          content: `row ${i}`,
          bead: null,
          ref: null,
          ts: new Date().toISOString(),
          delivery: "pull",
          topic: null,
          room_id: null,
          summary: null,
        })),
      }
    },
  )
}

describe("createInboxWaitManager — wait-and-drain (20843 v3)", () => {
  it("drains and returns immediately when actionable unread messages already exist", async () => {
    const drainCalls: string[] = []
    const manager = makeManager({ value: 3 }, drainCalls)
    const result = await manager.wait("@ci", "conn-1", 30_000)
    expect(result).toMatchObject({
      session: "@ci",
      timed_out: false,
      aborted: false,
      waited_ms: 0,
    })
    expect((result as { events: unknown[] }).events).toHaveLength(3)
    expect(drainCalls).toEqual(["@ci"])
  })

  it("ignores ambient traffic and wakes on actionable direct messages", async () => {
    vi.useFakeTimers()
    const unread = { value: 0 }
    const manager = makeManager(unread)

    const wait = manager.wait("@ci", "conn-1", 1_000)
    let settled = false
    void wait.then(() => {
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

    unread.value = 1
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
      timed_out: false,
      aborted: false,
    })
    expect((result as { events: unknown[] }).events).toHaveLength(1)
    expect(result.waited_ms).toBeGreaterThanOrEqual(0)
  })

  it("does not wake on direct notify messages", async () => {
    vi.useFakeTimers()
    const unread = { value: 0 }
    const manager = makeManager(unread)

    const wait = manager.wait("@ci", "conn-1", 1_000)
    let settled = false
    void wait.then(() => {
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

    unread.value = 1
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
      timed_out: false,
      aborted: false,
    })
    expect((result as { events: unknown[] }).events).toHaveLength(1)
  })

  it("times out when no actionable message arrives and performs the final drain", async () => {
    vi.useFakeTimers()
    const drainCalls: string[] = []
    const manager = makeManager({ value: 0 }, drainCalls)

    const wait = manager.wait("@ci", "conn-1", 100)
    vi.advanceTimersByTime(100)

    const result = await wait
    expect(result).toMatchObject({
      session: "@ci",
      timed_out: true,
      aborted: false,
    })
    expect((result as { events: unknown[] }).events).toEqual([])
    // Exactly one drain per return — the timeout drain delivers any ambient
    // rows that arrived during the window.
    expect(drainCalls).toEqual(["@ci"])
  })

  it("aborts pending waits when the connection closes WITHOUT draining", async () => {
    vi.useFakeTimers()
    const drainCalls: string[] = []
    const manager = makeManager({ value: 0 }, drainCalls)

    const wait = manager.wait("@ci", "conn-1", 1_000)
    manager.cancelConnection("conn-1")

    const result = await wait
    expect(result).toMatchObject({
      session: "@ci",
      timed_out: false,
      aborted: true,
    })
    // The response is undeliverable — draining would silently consume rows.
    expect(drainCalls).toEqual([])
    expect((result as { events: unknown[] }).events).toEqual([])
  })

  it("peek preserves the status-only observer contract", async () => {
    const drainCalls: string[] = []
    const manager = makeManager({ value: 2 }, drainCalls)
    const result = await manager.wait("@ci", "conn-1", 30_000, { peek: true })
    expect(result).toMatchObject({
      session: "@ci",
      unread_count: 2,
      timed_out: false,
      aborted: false,
    })
    expect((result as { events?: unknown[] }).events).toBeUndefined()
    expect(drainCalls).toEqual([])
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
