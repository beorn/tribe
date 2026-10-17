/**
 * @failure a request whose ball was CLOSED but whose row the seat has not yet
 *          read still renders as an owed actionable: `selectAttention`'s
 *          untracked branch (database.ts:3164-3174) selects a direct
 *          actionable above the mailbox cursor with no tracker condition at
 *          all, so deleting the `pending_request` row only removes the TRACKED
 *          branch's copy. The row that remains carries no settlement label, so
 *          a turn built from it reads the closed request as work that is still
 *          owed — 29327's acceptance, on the daemon's own rail.
 * @failure a batch that cannot read the tracker must SAY SO: the lookup is
 *          budgeted (`SETTLEMENT_LOOKUP_BUDGET`) and crossing it reports
 *          `settlement_lookup`, because reading the surplus as "owed" is the
 *          defect this file exists to prevent.
 * @level   l1
 * @consumer 29327; readAttentionProjection consumers (tribe.fetch
 *           attention.actionable_unread, inbox-wait carriage)
 * @testonly none
 *
 * 29327 - the daemon tracker is the ONE decision-maker for "still owed"
 * (@cto verdict af6e760c, 2026-10-17T03:23:03Z): an open `pending_request` row
 * for that exact id means owed, and NO row means not owed. An unread request
 * whose ball is closed must therefore render as SETTLED — labeled, never
 * silently dropped, and never presented as owed.
 *
 * The cases: the closed row is labeled AND kept; the settler is named from the
 * daemon's own `event.ball.settled` fact (never from a reply row, which is not
 * a second settlement authority) and marked `by_another_owner` when someone
 * other than the ball's owner closed it; an OPEN ball's row and a row that
 * never had a ball stay unlabeled, so the label can only come from the tracker;
 * and an over-budget batch reports an unavailable lookup rather than guessing.
 *
 * RED-first: on the pre-fix projection the closed-ball row carries no
 * `settled` field at all, which is exactly the reported defect.
 */
import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { SETTLEMENT_LOOKUP_BUDGET, readAttentionProjection } from "./handlers.ts"
import { registerSession } from "./session.ts"

const SEAT = "@dev/brain"
const SENDER = "@chief"
const TS = Date.UTC(2026, 9, 17, 3, 0, 0)

type Fixture = { dir: string; db: Database; stmts: TribeStatements; ctx: TribeContext }
const opened: Fixture[] = []

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tribe-29327-"))
  const db = openDatabase(join(dir, "tribe.db"))
  const stmts = createStatements(db)
  const ctx = createTribeContext({
    db,
    stmts,
    sessionId: "sess-29327",
    sessionRole: "member",
    initialName: SEAT,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
  registerSession(ctx, undefined, () => false, null, 0, "pull")
  const built = { dir, db, stmts, ctx }
  opened.push(built)
  return built
}

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.db.close()
    rmSync(item.dir, { recursive: true, force: true })
  }
})

/** One direct request row plus its open tracker ball. Returns the row's rowid. */
function trackedRequest(stmts: TribeStatements, id: string): number {
  const inserted = stmts.insertMessage.run({
    $id: id,
    $type: "request",
    $sender: SENDER,
    $recipient: SEAT,
    $kind: "direct",
    $content: "please take this",
    $bead_id: null,
    $ref: null,
    $ts: TS,
    $delivery: "push",
    $topic: null,
    $room_id: null,
    $request: id,
    $reply: null,
    $summary: null,
  })
  const seq = Number(inserted.lastInsertRowid)
  stmts.openPendingRequest.run({
    $request_id: id,
    $recipient: SEAT,
    $sender: SENDER,
    $opened_at: TS,
    $expires_at: TS + 60_000,
    $message_id: id,
    $fanout: "first",
  })
  return seq
}

type Row = {
  id: string
  settled?: boolean
  settled_by?: string
  settled_at?: string
  by_another_owner?: boolean
}

/** The daemon's own settlement fact, exactly as `settlePendingRows` journals it
 *  (schema v1). It is the only record allowed to NAME a settler: the obligation
 *  itself was already decided by the tracker's missing row. */
function settledFact(stmts: TribeStatements, ballId: string, opts: { settlement: string; settledBy: string }): void {
  stmts.insertMessage.run({
    $id: `fact-${ballId}`,
    $type: "event.ball.settled",
    $sender: "daemon",
    $recipient: SEAT,
    $kind: "event",
    $content: JSON.stringify({
      schema_version: 1,
      request_id: ballId,
      recipient: SEAT,
      sender: SENDER,
      opened_at: TS,
      expires_at: TS + 60_000,
      message_id: ballId,
      fanout: "first",
      summary: null,
      settlement: opts.settlement,
      settled_at: TS + 90_000,
      settled_by: opts.settledBy,
    }),
    $bead_id: null,
    $ref: ballId,
    $ts: TS + 90_000,
    $delivery: "pull",
    $topic: null,
    $room_id: null,
    $request: null,
    $reply: null,
    $summary: null,
  })
}

function rowsOf(ctx: TribeContext, owner = SEAT): Row[] {
  return readAttentionProjection(ctx, owner).attention.actionable_unread as Row[]
}

describe("29327 an unread request whose ball is closed renders settled", () => {
  it("labels the closed ball's still-unread request row settled, and never drops it", () => {
    const { stmts, ctx } = fixture()
    trackedRequest(stmts, "req-29327-closed")
    // The ball ends — this is exactly what messaging.ts:345 does on a reply.
    stmts.closePendingRequest.run({ $request_id: "req-29327-closed", $recipient: SEAT })

    const rows = rowsOf(ctx)
    const row = rows.find((item) => item.id === "req-29327-closed")

    // Never dropped silently: the row is still presented.
    expect(row, "a closed ball's unread request must still be presented, labeled").toBeDefined()
    // Rendered settled rather than owed.
    expect(row?.settled).toBe(true)
    // No settlement fact survives this fixture, so no settler may be invented:
    // the obligation is decided by the tracker, the NAME only by the record.
    expect(row?.settled_by).toBeUndefined()
  })

  it("names the settler and the time from the daemon's own settlement fact", () => {
    const { stmts, ctx } = fixture()
    trackedRequest(stmts, "req-29327-named")
    settledFact(stmts, "req-29327-named", { settlement: "answered", settledBy: "@dev/brain" })
    stmts.closePendingRequest.run({ $request_id: "req-29327-named", $recipient: SEAT })

    const row = rowsOf(ctx).find((item) => item.id === "req-29327-named")

    expect(row?.settled).toBe(true)
    expect(row?.settled_by).toBe("@dev/brain")
    expect(row?.settled_at).toBe(new Date(TS + 90_000).toISOString())
    // The ball's own owner settled it, so nothing was settled by a third party.
    expect(row?.by_another_owner).toBeUndefined()
  })

  it("marks a ball another owner's answer closed under fanout=first", () => {
    const { stmts, ctx } = fixture()
    trackedRequest(stmts, "req-29327-other")
    settledFact(stmts, "req-29327-other", { settlement: "answered", settledBy: "@dev/7" })
    stmts.closePendingRequest.run({ $request_id: "req-29327-other", $recipient: SEAT })

    const row = rowsOf(ctx).find((item) => item.id === "req-29327-other")

    expect(row?.settled).toBe(true)
    expect(row?.settled_by).toBe("@dev/7")
    expect(row?.by_another_owner).toBe(true)
  })

  it("reports an unavailable lookup instead of reading the surplus as owed", () => {
    const { stmts, ctx } = fixture()
    trackedRequest(stmts, "req-29327-over-budget")
    stmts.closePendingRequest.run({ $request_id: "req-29327-over-budget", $recipient: SEAT })
    // Over the batch budget, so the tracker read cannot decide the batch.
    for (let index = 0; index <= SETTLEMENT_LOOKUP_BUDGET; index += 1) {
      trackedRequest(stmts, `req-29327-budget-${index}`)
    }

    const attention = readAttentionProjection(ctx, SEAT).attention
    const row = attention.actionable_unread.find((item) => item.id === "req-29327-over-budget")

    expect(attention.settlement_lookup?.status).toBe("unavailable")
    expect(attention.settlement_lookup?.detail).toMatch(/exceed the settlement lookup budget/)
    // The undecided row is still presented, and claims nothing.
    expect(row, "an undecided row is never dropped").toBeDefined()
    expect(row?.settled).toBeUndefined()
  })

  it("leaves an OPEN ball's request row unlabeled, so owed work still reads as owed", () => {
    const { stmts, ctx } = fixture()
    trackedRequest(stmts, "req-29327-open")

    const row = rowsOf(ctx).find((item) => item.id === "req-29327-open")

    expect(row).toBeDefined()
    expect(row?.settled).toBeUndefined()
  })

  it("does not label an actionable that never opened a ball", () => {
    const { stmts, ctx } = fixture()
    stmts.insertMessage.run({
      $id: "query-29327-untracked",
      $type: "query",
      $sender: SENDER,
      $recipient: SEAT,
      $kind: "direct",
      $content: "an actionable row that was never tracked",
      $bead_id: null,
      $ref: null,
      $ts: TS,
      $delivery: "push",
      $topic: null,
      $room_id: null,
      $request: null,
      $reply: null,
      $summary: null,
    })

    const row = rowsOf(ctx).find((item) => item.id === "query-29327-untracked")

    expect(row, "an untracked actionable is presented; the label must key on the tracker").toBeDefined()
    expect(row?.settled).toBeUndefined()
  })
})
