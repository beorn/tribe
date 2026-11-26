/**
 * @failure A request whose ball was closed by hand keeps counting as unread
 *          forever. `closePendingRequest` deletes the tracker row, so the copy
 *          left in `selectAttention`'s untracked branch is presented labeled
 *          `settled` (29327) but nothing retires it from the COUNTS: the
 *          mailbox `unread_count`, inbox-status (the Stop hook's
 *          `unread_count`/`unread_ids`) and health keep reading it as owed.
 *          A read by id deliberately cannot move the cursor (38555), so no read
 *          path clears it and the Stop hook re-blocks the seat every turn.
 * @level   l2
 * @consumer Stop hook via inbox-status (`unread_count`, `unread_ids`),
 *           `tribe members`/health unread, `tribe.fetch` attention
 * @testonly none: every reader is the production path; the fixture writes only
 *           rows and tracker records the daemon itself writes.
 *
 * 38730 (@cto e324926d): split the COUNT from the PRESENTATION. The count — the
 * mailbox unread count, inbox-status and the Stop hook — is "what is owed", so a
 * closed ball never counts, at once. The presentation keeps 29327: the next
 * default fetch still shows the row labeled `settled`, and that read's cursor
 * retires it like any row it shows. Neither ruling is traded away.
 */
import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { readAttentionProjection, handleToolCall, type HandlerOpts } from "./handlers.ts"
import { projectHealthCadence } from "./health-cadence.ts"
import { registerSession } from "./session.ts"

const HOUR = 3_600_000
const SEAT = "@chief/chat"
const SENDER = "@chief"
const TS = Date.UTC(2026, 10, 25, 17, 0, 51)

type Fixture = { dir: string; db: Database; stmts: TribeStatements; ctx: TribeContext }
const opened: Fixture[] = []

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tribe-38730-"))
  const db = openDatabase(join(dir, "tribe.db"))
  const stmts = createStatements(db)
  const ctx = createTribeContext({
    db,
    stmts,
    sessionId: "sess-38730",
    sessionRole: "member",
    initialName: SEAT,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
  registerSession(ctx, undefined, () => false, null, 0, "push")
  const built = { dir, db, stmts, ctx }
  opened.push(built)
  return built
}

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.db.close()
    // raw-delete-allow: this test's own mkdtemp root under os.tmpdir(); removely is not a dependency of vendor/tribe, and nothing here is outside the fixture.
    rmSync(item.dir, { recursive: true, force: true })
  }
})

const handlerOpts = (): HandlerOpts => ({
  cleanup: () => {},
  userRenamed: false,
  setUserRenamed: () => {},
  getActiveSessionIds: () => new Set<string>(),
  hasActiveTransport: () => false,
  isReconnectGraceProtected: () => false,
  getActiveSessionInfo: () => [],
})

/** One direct request row plus its open tracker ball. */
function trackedRequest(f: Fixture, id: string): void {
  f.stmts.insertMessage.run({
    $id: id,
    $type: "request",
    $sender: SENDER,
    $recipient: SEAT,
    $kind: "direct",
    $content: `please take ${id}`,
    $bead_id: null,
    $ref: null,
    $ts: TS,
    $delivery: "push",
    $topic: null,
    $room_id: null,
    $request: id,
    $reply: null,
    $summary: id,
  })
  f.stmts.openPendingRequest.run({
    $request_id: id,
    $recipient: SEAT,
    $sender: SENDER,
    $opened_at: TS,
    $expires_at: TS + HOUR,
    $message_id: id,
    $fanout: "first",
  })
}

/** Settled out of band: the tracker row is gone, nothing replied. */
function handClose(f: Fixture, id: string): void {
  f.stmts.closePendingRequest.run({ $request_id: id, $recipient: SEAT })
}

/** The mailbox count (`tribe members` / health unread). */
function unreadCount(f: Fixture): number {
  return (f.stmts.getUnreadDms.get({ $name: SEAT }) as { count: number }).count
}

/** inbox-status: exactly what the Stop hook reads (with-dispatcher readInboxStatus). */
function inboxStatus(f: Fixture): { unread_count: number; unread_ids: string[] } {
  const projection = readAttentionProjection(f.ctx, SEAT, Date.now(), 0, handlerOpts())
  return {
    unread_count: projection.actionableCount,
    unread_ids: projection.unreadRows.map((row) => row.id),
  }
}

function healthRows(f: Fixture): number {
  const lag = projectHealthCadence(f.db, {
    now: Date.now(),
    connectedSessionNames: [],
    requestedSessionNames: [SEAT],
  }).inbox_lag.find((entry) => entry.session === SEAT)
  return (lag?.actionable_rows ?? 0) + (lag?.actionable_held_rows ?? 0)
}

type Attention = { attention?: { actionable_unread?: Array<{ id: string; settled?: boolean }> } }

async function fetchAttention(f: Fixture, extra: Record<string, unknown> = {}): Promise<Attention> {
  const result = await handleToolCall(f.ctx, "tribe.fetch", { limit: 50, ...extra }, handlerOpts())
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Attention
}

describe("38730 a hand-closed request stops counting at once and is still shown settled once", () => {
  it("drops both hand-closed requests from every count, presents them settled on the next fetch, then never again", async () => {
    const f = fixture()
    trackedRequest(f, "9a16edd2")
    trackedRequest(f, "a103fb7a")
    expect(unreadCount(f)).toBe(2)
    expect(inboxStatus(f)).toEqual({ unread_count: 2, unread_ids: ["9a16edd2", "a103fb7a"] })

    handClose(f, "9a16edd2")
    handClose(f, "a103fb7a")

    // The count is "what is owed": the moment the ball closes, nothing is.
    expect(unreadCount(f)).toBe(0)
    expect(inboxStatus(f)).toEqual({ unread_count: 0, unread_ids: [] })
    expect(healthRows(f)).toBe(0)

    // 29327 holds: the presentation still shows the row, labeled settled.
    const first = await fetchAttention(f, { receipt: true })
    expect(first.attention?.actionable_unread).toEqual([
      expect.objectContaining({ id: "9a16edd2", settled: true }),
      expect.objectContaining({ id: "a103fb7a", settled: true }),
    ])
    expect(unreadCount(f)).toBe(0)
    expect(inboxStatus(f)).toEqual({ unread_count: 0, unread_ids: [] })

    // That read's cursor retires them like any row it showed.
    const second = await fetchAttention(f, { receipt: true })
    expect(second.attention?.actionable_unread).toEqual([])
  })

  it("keeps an open ball counting, before and after it is presented", async () => {
    const f = fixture()
    trackedRequest(f, "req-still-open")

    expect(unreadCount(f)).toBe(1)
    expect(inboxStatus(f)).toEqual({ unread_count: 1, unread_ids: ["req-still-open"] })
    expect(healthRows(f)).toBe(1)

    const first = await fetchAttention(f, { receipt: true })
    expect(first.attention?.actionable_unread).toEqual([expect.objectContaining({ id: "req-still-open" })])
    expect(first.attention?.actionable_unread?.[0]?.settled).toBeUndefined()

    // An open ball is owed however many times it is presented (22203).
    expect(unreadCount(f)).toBe(1)
    expect(inboxStatus(f)).toEqual({ unread_count: 1, unread_ids: ["req-still-open"] })
  })

  it("fetch --ids still answers a hand-closed row labeled settled", async () => {
    const f = fixture()
    trackedRequest(f, "req-by-id")
    handClose(f, "req-by-id")

    const result = await handleToolCall(f.ctx, "tribe.fetch", { ids: ["req-by-id"] }, handlerOpts())
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
    const parsed = JSON.parse(text) as { events?: Array<{ id: string; settlement?: string }> }
    expect(parsed.events?.find((row) => row.id === "req-by-id")?.settlement).toBe("settled")
    expect(unreadCount(f)).toBe(0)
  })
})
