/**
 * @failure A wait can wake on a row the mailbox cursor is already past - the
 *          bead's SETTLED specimens. Settlement deletes the pending_request row,
 *          so the tracked-tail wake cannot fire for them; the showing path is
 *          the durable qualifying tail (getLatestInboxWaitMessage with
 *          $unacknowledged_only = 0) named by a resumed chunk. Without the
 *          `replay` marker such a wake is indistinguishable from a fresh
 *          instruction, and the seat pays a record check or acts on settled
 *          work (27407 specimens b5da007c/f37561bd, 2eb3d3c6 acked ten times).
 * @level   l1
 * @consumer 27407; createInboxWaitManager's durable-tail wake path
 *           (with-dispatcher latestInboxWaitMessage(..., false)), read by
 *           tribe.inbox.wait clients and the seat turn loop.
 * @testonly none
 *
 * The landed fixture covered an OPEN untaken ball (the 22203 tracked branch).
 * This file covers the settled shape the bead actually names: pending ownership
 * CLOSED and the mailbox cursor already past the row.
 */
import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { createInboxWaitManager, readInboxWaitWokenBy, type InboxStatus } from "./inbox-wait.ts"

const SEAT = "@dev/3"
const SENDER = "@chief"
const FIRST_SENT_MS = Date.UTC(2026, 9, 4, 6, 0, 0)
const REQUEST_ID = "req-settled"

type Fixture = { dir: string; db: Database; stmts: TribeStatements }
const opened: Fixture[] = []

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tribe-27407-settled-"))
  const db = openDatabase(join(dir, "tribe.db"))
  const built = { dir, db, stmts: createStatements(db) }
  opened.push(built)
  return built
}

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.db.close()
    rmSync(item.dir, { recursive: true, force: true })
  }
})

/**
 * The bead's specimen shape: a direct request that was ACKED (cursor past it)
 * and SETTLED (pending ownership closed), so only the message row survives.
 */
function settledRequest(stmts: TribeStatements): number {
  const inserted = stmts.insertMessage.run({
    $id: REQUEST_ID,
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
    $request: REQUEST_ID,
    $reply: null,
    $summary: null,
  })
  const seq = Number(inserted.lastInsertRowid)
  stmts.openPendingRequest.run({
    $request_id: REQUEST_ID,
    $recipient: SEAT,
    $sender: SENDER,
    $opened_at: FIRST_SENT_MS,
    $expires_at: FIRST_SENT_MS + 60_000,
    $message_id: REQUEST_ID,
    $fanout: "first",
  })
  stmts.advanceMailboxCursor.run({ $recipient: SEAT, $seq: seq + 100, $now: FIRST_SENT_MS + 600_000 })
  stmts.closePendingRequest.run({ $request_id: REQUEST_ID, $recipient: SEAT })
  return seq
}

const EMPTY_STATUS: InboxStatus = { session: SEAT, unread_count: 0, oldest_unread_age_min: 0, oldest_unread_ts: 0 }
const EMPTY_ATTENTION = {
  actionable_unread: [],
  pending_balls: [],
  pending_balls_summary: { total: 0, oldest_age_ms: 0, truncated: false },
}

/** The exact selector pair with-dispatcher wires: durable tail and cursor-aware tail. */
function qualifyingSeq(stmts: TribeStatements, session: string, unacknowledgedOnly: boolean): number {
  const row = stmts.getLatestInboxWaitMessage.get({
    $name: session,
    $include_correlated_replies: 0,
    $unacknowledged_only: unacknowledgedOnly ? 1 : 0,
  }) as { rowid: number } | null
  return row?.rowid ?? 0
}

function manager(stmts: TribeStatements) {
  return createInboxWaitManager(
    () => EMPTY_STATUS,
    () => EMPTY_ATTENTION,
    (session) => qualifyingSeq(stmts, session, false),
    (session) => qualifyingSeq(stmts, session, true),
    (session, seq, wakeOnCorrelatedReply) => readInboxWaitWokenBy(stmts, session, seq, wakeOnCorrelatedReply),
  )
}

describe("27407 a SETTLED row is not presented as new", () => {
  it("does not wake a fresh wait on a settled, already-read row", async () => {
    const { stmts } = fixture()
    settledRequest(stmts)

    // A fresh logical wait keys on the cursor-aware tail; the settled row is
    // below the cursor, so it must not surface as work.
    const result = await manager(stmts).wait(SEAT, "conn-1", 0, { consumesMailbox: true })

    expect(result.status).toBe("timeout")
    expect(result.woken_by).toBeUndefined()
  })

  it("names the settled row a replay with its first-sent time when the durable tail wakes a resumed chunk", async () => {
    const { stmts } = fixture()
    const seq = settledRequest(stmts)

    // A resumed chunk carries its logical baseline; the durable qualifying tail
    // is still the settled row, so the chunk wakes immediately and names it.
    const result = await manager(stmts).wait(SEAT, "conn-1", 5_000, { afterSeq: 0, consumesMailbox: true })

    expect(result.status).toBe("woken")
    expect(result.woken_by).toMatchObject({
      kind: "message",
      seq,
      message_id: REQUEST_ID,
      sender: SENDER,
      sent_at: new Date(FIRST_SENT_MS).toISOString(),
      replay: true,
    })
  })
})
