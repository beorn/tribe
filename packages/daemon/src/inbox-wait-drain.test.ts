/**
 * One-call idle loop — wait-and-drain blocking receive (v3 spec).
 *
 * `tribe.inbox.wait` must never return while leaving its own wake condition
 * standing: every return (immediate, early wake, or timeout) atomically drains
 * the inbox and returns the drained batch. The old status-only shape survives
 * behind `peek: true` for observer/watchdog callers.
 *
 * Pins:
 * - stale actionable row at arm-time is returned AND drained immediately;
 *   the next call blocks the full window
 * - ambient notify/status/health rows never wake the wait but are delivered
 *   on the timeout drain
 * - cursor advances exactly once per return; concurrent waiters are safe
 * - abort (connection close) does NOT drain — undelivered rows survive
 * - `pending --close` on a still-unread request marks the row read
 */

import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./lib/context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./lib/database.ts"
import { handleToolCall, type HandlerOpts } from "./lib/handlers.ts"
import { drainInboxByName } from "./lib/inbox-drain.ts"
import { createInboxWaitManager, type InboxStatus } from "./lib/inbox-wait.ts"
import { registerSession } from "./lib/session.ts"

const NAME = "@ci"
const SESSION_ID = "sess-ci"
const PROJECT_ID = "wait-drain-proj"

type ToolJson = Record<string, unknown>
type WaitJson = ToolJson & {
  events?: Array<{ id: string; rowid: number; type: string; content: string }>
  timed_out?: boolean
  aborted?: boolean
  waited_ms?: number
  unread_count?: number
}

function makeContext(db: Database, stmts: TribeStatements, sessionId = SESSION_ID, name = NAME): TribeContext {
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

function readStatus(stmts: TribeStatements) {
  return (session: string): InboxStatus => {
    const row = stmts.getUnreadDms.get({ $name: session }) as { count: number; oldest_ts: number } | undefined
    const unread_count = row?.count ?? 0
    const oldest_ts = row?.oldest_ts ?? 0
    return {
      session,
      unread_count,
      oldest_unread_age_min: oldest_ts > 0 ? Math.floor((Date.now() - oldest_ts) / 60_000) : 0,
      oldest_unread_ts: oldest_ts,
    }
  }
}

function makeManager(db: Database, stmts: TribeStatements) {
  return createInboxWaitManager(readStatus(stmts), (session: string) => drainInboxByName(db, stmts, session))
}

function makeOpts(inboxWait: HandlerOpts["inboxWait"]): HandlerOpts {
  return {
    cleanup: () => {},
    userRenamed: false,
    setUserRenamed: () => {},
    getActiveSessionIds: () => new Set([SESSION_ID]),
    getActiveSessionInfo: () => [],
    inboxWait,
  }
}

function parseToolJson(result: Awaited<ReturnType<typeof handleToolCall>>): ToolJson {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as ToolJson
}

let messageSeq = 0

function insertRow(
  stmts: TribeStatements,
  overrides: Partial<{
    type: string
    sender: string
    recipient: string
    kind: string
    content: string
    request: string | null
  }>,
): { id: string; rowid: number; info: Parameters<ReturnType<typeof makeManager>["onMessageInserted"]>[0] } {
  messageSeq += 1
  const id = `msg-${messageSeq}`
  const row = {
    type: "notify",
    sender: "@chief",
    recipient: NAME,
    kind: "direct",
    content: `content-${messageSeq}`,
    request: null as string | null,
    ...overrides,
  }
  const res = stmts.insertMessage.run({
    $id: id,
    $type: row.type,
    $sender: row.sender,
    $recipient: row.recipient,
    $kind: row.kind,
    $content: row.content,
    $bead_id: null,
    $ref: null,
    $ts: Date.now(),
    $delivery: "pull",
    $topic: null,
    $room_id: null,
    $request: row.request,
    $reply: null,
  })
  const rowid = Number(res.lastInsertRowid)
  return {
    id,
    rowid,
    info: {
      id,
      ts: Date.now(),
      rowid,
      type: row.type,
      kind: row.kind as "direct" | "broadcast",
      sender: row.sender,
      senderRole: "member",
      recipient: row.recipient,
      content: row.content,
      bead_id: null,
      delivery: "pull",
      topic: null,
      roomId: null,
    },
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe("tribe.inbox.wait — wait-and-drain (20843 v3)", () => {
  let tmpDir: string
  let db: ReturnType<typeof openDatabase>
  let stmts: TribeStatements
  let ctx: TribeContext
  let manager: ReturnType<typeof makeManager>
  let opts: HandlerOpts

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-wait-drain-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
    ctx = makeContext(db, stmts)
    registerSession(ctx, PROJECT_ID, () => true, null, 1234, "pull", "/repo", null, "codex")
    manager = makeManager(db, stmts)
    opts = makeOpts(manager)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns AND drains a stale actionable row immediately; the next call blocks the full window", async () => {
    const { id } = insertRow(stmts, { type: "request", request: "req-stale" })

    const first = parseToolJson(await handleToolCall(ctx, "tribe.inbox.wait", { timeout_ms: 5_000 }, opts)) as WaitJson
    expect(first.timed_out).toBe(false)
    expect(first.events?.map((e) => e.id)).toContain(id)

    // Drained: an immediate re-arm must NOT re-wake on the same row (the
    // busy-loop regression this bead exists to kill).
    const startedAt = Date.now()
    const second = parseToolJson(await handleToolCall(ctx, "tribe.inbox.wait", { timeout_ms: 150 }, opts)) as WaitJson
    expect(second.timed_out).toBe(true)
    expect(second.events).toEqual([])
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140)
  })

  it("ambient rows never wake the wait but are delivered on the timeout drain", async () => {
    const waitPromise = handleToolCall(ctx, "tribe.inbox.wait", { timeout_ms: 300 }, opts)
    let settled = false
    void Promise.resolve(waitPromise).then(() => {
      settled = true
    })

    await sleep(20)
    const ambient = insertRow(stmts, { type: "status", kind: "broadcast", recipient: "*", sender: "@agent/9" })
    manager.onMessageInserted(ambient.info)
    await sleep(60)
    expect(settled).toBe(false)

    const result = parseToolJson(await waitPromise) as WaitJson
    expect(result.timed_out).toBe(true)
    expect(result.events?.map((e) => e.id)).toContain(ambient.id)
  })

  it("an actionable arrival mid-wait wakes and returns the drained batch", async () => {
    const waitPromise = handleToolCall(ctx, "tribe.inbox.wait", { timeout_ms: 5_000 }, opts)
    await sleep(20)
    const actionable = insertRow(stmts, { type: "assign", request: null })
    manager.onMessageInserted(actionable.info)

    const result = parseToolJson(await waitPromise) as WaitJson
    expect(result.timed_out).toBe(false)
    expect(result.events?.map((e) => e.id)).toContain(actionable.id)
    expect(result.waited_ms).toBeLessThan(4_000)
  })

  it("concurrent waiters are safe: one actionable row is delivered to exactly one return", async () => {
    const waitA = handleToolCall(ctx, "tribe.inbox.wait", { timeout_ms: 5_000 }, opts)
    const waitB = handleToolCall(ctx, "tribe.inbox.wait", { timeout_ms: 5_000 }, opts)
    await sleep(20)
    const actionable = insertRow(stmts, { type: "request", request: "req-conc" })
    manager.onMessageInserted(actionable.info)

    const [a, b] = (await Promise.all([waitA, waitB])).map((r) => parseToolJson(r) as WaitJson)
    const deliveries = [a, b].filter((r) => (r.events ?? []).some((e) => e.id === actionable.id))
    expect(deliveries).toHaveLength(1)
  })

  it("abort does not drain — undelivered rows survive for the next call", async () => {
    const waitPromise = handleToolCall(ctx, "tribe.inbox.wait", { timeout_ms: 5_000 }, opts)
    await sleep(20)
    manager.cancelConnection(SESSION_ID)
    const aborted = parseToolJson(await waitPromise) as WaitJson
    expect(aborted.aborted).toBe(true)
    expect(aborted.events ?? []).toEqual([])

    const pendingRow = insertRow(stmts, { type: "request", request: "req-after-abort" })
    const next = parseToolJson(await handleToolCall(ctx, "tribe.inbox.wait", { timeout_ms: 1_000 }, opts)) as WaitJson
    expect(next.events?.map((e) => e.id)).toContain(pendingRow.id)
  })

  it("peek preserves observer semantics: status only, nothing drained", async () => {
    const { id } = insertRow(stmts, { type: "request", request: "req-peek" })

    const peeked = parseToolJson(
      await handleToolCall(ctx, "tribe.inbox.wait", { timeout_ms: 1_000, peek: true }, opts),
    ) as WaitJson
    expect(peeked.unread_count).toBe(1)
    expect(peeked.events).toBeUndefined()

    // Still undrained — a normal wait returns the row.
    const drained = parseToolJson(await handleToolCall(ctx, "tribe.inbox.wait", { timeout_ms: 1_000 }, opts)) as WaitJson
    expect(drained.events?.map((e) => e.id)).toContain(id)
  })

  it("cursor advances exactly once per return: no row is duplicated across sequential calls", async () => {
    insertRow(stmts, { type: "request", request: "req-a" })
    insertRow(stmts, { type: "notify", kind: "broadcast", recipient: "*", sender: "@agent/9" })

    const first = parseToolJson(await handleToolCall(ctx, "tribe.inbox.wait", { timeout_ms: 1_000 }, opts)) as WaitJson
    expect(first.events).toHaveLength(2)

    const second = parseToolJson(await handleToolCall(ctx, "tribe.inbox.wait", { timeout_ms: 0 }, opts)) as WaitJson
    expect(second.events).toEqual([])
  })
})

describe("drainInboxByName — unknown session safety", () => {
  let tmpDir: string
  let db: ReturnType<typeof openDatabase>
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-drain-unknown-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("creates an at-tail session row for an unknown name instead of replaying journal history", () => {
    insertRow(stmts, { type: "notify", kind: "broadcast", recipient: "*", sender: "@agent/9" })
    insertRow(stmts, { type: "notify", kind: "broadcast", recipient: "*", sender: "@agent/9" })

    const result = drainInboxByName(db, stmts, "@never-joined")
    expect(result.events).toEqual([])

    // New rows after the implicit registration DO arrive.
    const fresh = insertRow(stmts, { type: "request", recipient: "@never-joined", request: "req-x" })
    const next = drainInboxByName(db, stmts, "@never-joined")
    expect(next.events.map((e) => e.id)).toEqual([fresh.id])
  })
})

describe("pending --close marks a still-unread request row read (20843 S3)", () => {
  let tmpDir: string
  let db: ReturnType<typeof openDatabase>
  let stmts: TribeStatements
  let ctx: TribeContext
  let opts: HandlerOpts

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-pending-close-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
    ctx = makeContext(db, stmts)
    registerSession(ctx, PROJECT_ID, () => true, null, 1234, "pull", "/repo", null, "codex")
    const manager = makeManager(db, stmts)
    opts = makeOpts(manager)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("closing an unread request marks its row read so it cannot re-wake the idle loop", async () => {
    const { id } = insertRow(stmts, { type: "request", request: "req-ball" })
    stmts.openPendingRequest.run({
      $request_id: "req-ball",
      $recipient: NAME,
      $sender: "@chief",
      $opened_at: Date.now(),
      $message_id: id,
      $fanout: "first",
    })

    const closed = parseToolJson(handleToolCall(ctx, "tribe.pending", { close: "req-ball" }, opts) as never) as ToolJson
    expect(closed.closed).toBe(1)
    expect(closed.marked_read).toBe(true)
    expect(typeof closed.note).toBe("string")

    // The closed-but-previously-unread row no longer counts as unread and no
    // longer appears in the drain.
    const status = stmts.getUnreadDms.get({ $name: NAME }) as { count: number }
    expect(status.count).toBe(0)
    const drained = parseToolJson(await handleToolCall(ctx, "tribe.inbox.wait", { timeout_ms: 0 }, opts)) as WaitJson
    expect(drained.events?.map((e) => e.id) ?? []).not.toContain(id)
  })

  it("closing an already-read request reports marked_read false", async () => {
    const { id } = insertRow(stmts, { type: "request", request: "req-read" })
    stmts.openPendingRequest.run({
      $request_id: "req-read",
      $recipient: NAME,
      $sender: "@chief",
      $opened_at: Date.now(),
      $message_id: id,
      $fanout: "first",
    })
    // Drain first — the row is now read via the cursor.
    await handleToolCall(ctx, "tribe.inbox.wait", { timeout_ms: 0 }, opts)

    const closed = parseToolJson(handleToolCall(ctx, "tribe.pending", { close: "req-read" }, opts) as never) as ToolJson
    expect(closed.closed).toBe(1)
    expect(closed.marked_read).toBe(false)
  })
})
