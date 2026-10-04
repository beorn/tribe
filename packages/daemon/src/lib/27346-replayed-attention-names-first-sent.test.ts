/**
 * @failure selectAttention keeps an OWNED TRACKED actionable in
 *          `actionable_unread` past the mailbox cursor on purpose (the tracked
 *          branch carries no cursor condition), so a settled-but-untaken
 *          request is re-presented on every fetch. Without the `replay` flag
 *          that re-presentation is indistinguishable from a fresh instruction,
 *          and a pane that drains the envelope hours later reads the old row as
 *          new work (specimens ab0dbd7e, daf2f96f) — 27346.
 * @level   l1
 * @consumer 27346; readAttentionProjection consumers (tribe.fetch
 *           attention.actionable_unread, inbox-wait carriage) and @tribe/wire's
 *           replayEnvelopeMeta, which stamps the channel envelope.
 * @testonly none
 *
 * 27346 - a re-presented attention row must name itself a replay.
 *
 * selectAttention keeps an OWNED TRACKED actionable in `actionable_unread`
 * past the mailbox cursor on purpose: the tracked branch carries no cursor
 * condition, so an untaken ball is re-presented until TAKING or settlement
 * (22203). The untracked branch retires on the mailbox cursor. The standard
 * drain reads with `receipt:false` (21757), so it never advances that cursor
 * either, and every re-presentation becomes a fresh <channel> envelope the
 * pane reads as new (specimens ab0dbd7e, daf2f96f).
 *
 * "Already shown" therefore has two delivery records and the row is a replay
 * once EITHER is past it: the mailbox cursor (a MODEL read acknowledged it)
 * and the ambient per-session cursor (the seat's transport was handed it, which
 * the `receipt:false` drain does advance). The first half of this file pins the
 * projection; the `paneDrain` cases at the end drive the exact
 * `tribe.fetch {limit:500, receipt:false}` call the wire adapter's
 * `drainDaemonInbox` makes, twice, so the counterexample on review1837 — a
 * second drain re-forwarded as `replay=false` — is covered at that boundary.
 * A fresh case is retained: the first drain of a never-delivered row is
 * `replay=false`.
 *
 * 27407 named the WAKE rail of this family. This is the FETCH/pane rail:
 * before this change an attention row carried no `replay` flag, so a
 * re-presented row was indistinguishable from a fresh one.
 *
 * RED-first: this file fails on the pre-fix projection, which carries no
 * `replay` on a row the mailbox cursor is already past, and stamps a second
 * `receipt:false` drain of the same row `replay=false`. Receipt:
 * /hh/var/@dev/luna6/27346-pane-boundary/RED-boundary-before-fix.log.
 */
import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, readAttentionProjection, type HandlerOpts } from "./handlers.ts"
import { registerSession } from "./session.ts"

const SEAT = "@dev/3"
const SENDER = "@chief"
const FIRST_SENT_MS = Date.UTC(2026, 9, 4, 6, 0, 0)

type Fixture = { dir: string; db: Database; stmts: TribeStatements; ctx: TribeContext }
const opened: Fixture[] = []

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tribe-27346-"))
  const db = openDatabase(join(dir, "tribe.db"))
  const stmts = createStatements(db)
  const ctx = createTribeContext({
    db,
    stmts,
    sessionId: "sess-27346",
    sessionRole: "member",
    initialName: SEAT,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
  // The pane drain advances the AMBIENT cursor through a real sessions row
  // (`advanceInboxCursor` is an UPDATE on sessions). Without a registered seat
  // the boundary under test silently no-ops, which is exactly the kind of gap
  // the boundary test exists to close.
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

const handlerOpts = (): HandlerOpts => ({
  cleanup: () => {},
  userRenamed: false,
  setUserRenamed: () => {},
  getActiveSessionIds: () => new Set<string>(),
  hasActiveTransport: () => false,
  getActiveSessionInfo: () => [],
})

type DrainRow = { id: string; rowid: number; ts?: string; replay?: boolean }
type DrainResult = { attention?: { actionable_unread?: DrainRow[] }; events?: DrainRow[] }

/**
 * The exact call the pane drain makes: `drainDaemonInbox` in
 * packages/wire/src/stdio-adapter.ts issues `tribe.fetch {limit:500,
 * receipt:false}` and forwards each `attention.actionable_unread` row as a
 * <channel> envelope. Nothing here advances a cursor by hand — that is the
 * point (21757): a `receipt:false` read must not be assumed to move the
 * mailbox cursor.
 */
async function paneDrain(ctx: TribeContext): Promise<DrainResult> {
  const result = await handleToolCall(ctx, "tribe.fetch", { limit: 500, receipt: false }, handlerOpts())
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as DrainResult
}

function rowById(result: DrainResult, id: string): DrainRow | undefined {
  return result.attention?.actionable_unread?.find((row) => row.id === id)
}

/** One tracked ball: a direct request to SEAT with an open pending row. */
function openBall(stmts: TribeStatements): number {
  const inserted = stmts.insertMessage.run({
    $id: "req-27346",
    $type: "request",
    $sender: SENDER,
    $recipient: SEAT,
    $kind: "direct",
    $content: "please take this",
    $bead_id: null,
    $ref: null,
    $ts: FIRST_SENT_MS,
    $delivery: "push",
    $topic: null,
    $room_id: null,
    $request: "req-27346",
    $reply: null,
    $summary: null,
  })
  const seq = Number(inserted.lastInsertRowid)
  stmts.openPendingRequest.run({
    $request_id: "req-27346",
    $recipient: SEAT,
    $sender: SENDER,
    $opened_at: FIRST_SENT_MS,
    $expires_at: FIRST_SENT_MS + 60_000,
    $message_id: "req-27346",
    $fanout: "first",
  })
  return seq
}

describe("27346 a re-presented attention row names itself a replay", () => {
  it("carries replay=true and the original send time once the mailbox cursor is past the row", () => {
    const { stmts, ctx } = fixture()
    const seq = openBall(stmts)
    // The seat already read this row, so the cursor sits past it; the ball is
    // still untaken, so selectAttention keeps re-presenting it.
    stmts.advanceMailboxCursor.run({ $recipient: SEAT, $seq: seq + 100, $now: FIRST_SENT_MS + 5 * 60_000 })

    const projected = readAttentionProjection(ctx, SEAT)
    const row = projected.attention.actionable_unread.find((event) => event.id === "req-27346")

    expect(row).toMatchObject({
      id: "req-27346",
      replay: true,
      ts: new Date(FIRST_SENT_MS).toISOString(),
    })
  })

  it("carries replay=false for a row the mailbox has never read", () => {
    const { stmts, ctx } = fixture()
    openBall(stmts)

    const projected = readAttentionProjection(ctx, SEAT)
    const row = projected.attention.actionable_unread.find((event) => event.id === "req-27346")

    expect(row).toMatchObject({ id: "req-27346", replay: false })
  })

  it("does not surface a SETTLED, already-read row to the pane feed", () => {
    const { stmts, ctx } = fixture()
    const seq = openBall(stmts)
    stmts.advanceMailboxCursor.run({ $recipient: SEAT, $seq: seq + 100, $now: FIRST_SENT_MS + 600_000 })
    // Settlement CLOSES the pending row, so the tracked branch (22203) cannot
    // return it and the cursor gates the untracked branch: the pane feed the
    // drain forwards carries no attention row for it. The bead's specimens were
    // this shape; what reached their pane was the launch-goal replay (#27362).
    stmts.closePendingRequest.run({ $request_id: "req-27346", $recipient: SEAT })

    const projected = readAttentionProjection(ctx, SEAT)
    expect(projected.attention.actionable_unread.find((event) => event.id === "req-27346")).toBeUndefined()

    // Not presented as new is not the same as lost: the row stays durable in
    // history (fetchable by id), it is simply not attention.
    expect(stmts.selectMessageById.get({ $id: "req-27346" })).toMatchObject({ rowid: seq })
  })

  it("names the row a replay on the SECOND receipt:false drain, with its first-sent time", async () => {
    const { stmts, ctx } = fixture()
    openBall(stmts)

    // The pane rail never acknowledges the mailbox cursor (21757), so the two
    // drains below each see the same owned, untaken row. Before the fix the
    // replay determination only consulted the mailbox cursor, so the SECOND
    // presentation of the same row was stamped replay=false — a pane read it
    // as a second, fresh instruction (@dev/11 counterexample on review1837).
    const first = await paneDrain(ctx)
    expect(rowById(first, "req-27346")).toMatchObject({
      id: "req-27346",
      replay: false,
      ts: new Date(FIRST_SENT_MS).toISOString(),
    })
    expect(stmts.getMailboxCursor.get({ $recipient: SEAT })).toBeNull()

    const second = await paneDrain(ctx)
    expect(rowById(second, "req-27346")).toMatchObject({
      id: "req-27346",
      replay: true,
      ts: new Date(FIRST_SENT_MS).toISOString(),
    })
  })

  it("presents a settled ball through the pane drain as a replay, never as new", async () => {
    const { stmts, ctx } = fixture()
    const seq = openBall(stmts)

    // First drain: the ball is open and genuinely new, so its row is
    // replay=false. Its envelope still carries the first-sent time (the wire
    // `replayEnvelopeMeta` stamps it on every row), because this envelope may
    // already be queued in the host when the ball settles below and it cannot
    // be revised afterwards.
    const first = await paneDrain(ctx)
    expect(rowById(first, "req-27346")).toMatchObject({ replay: false })

    stmts.closePendingRequest.run({ $request_id: "req-27346", $recipient: SEAT })

    // Second drain: the row is still unacknowledged (receipt:false never moved
    // the mailbox cursor, 21757), so the projection still carries it — but the
    // ambient cursor the first drain advanced says it was already handed to the
    // pane, so it names itself a replay with its original send time instead of
    // reading as a second new instruction. AC2/AC3.
    const second = await paneDrain(ctx)
    expect(rowById(second, "req-27346")).toMatchObject({
      id: "req-27346",
      replay: true,
      ts: new Date(FIRST_SENT_MS).toISOString(),
    })
    // A replay is not a loss: the row stays durable in history.
    expect(stmts.selectMessageById.get({ $id: "req-27346" })).toMatchObject({ rowid: seq })
  })
})
