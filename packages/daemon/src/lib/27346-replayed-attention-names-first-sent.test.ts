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
 * 27407 named the WAKE rail of this family. This is the FETCH/pane rail:
 * before this change an attention row carried no `replay` flag, so a
 * re-presented row was indistinguishable from a fresh one.
 *
 * RED-first: this file fails on the pre-fix projection, which carries no
 * `replay` on a row the mailbox cursor is already past.
 */
import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { readAttentionProjection } from "./handlers.ts"

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
})
