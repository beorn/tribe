/**
 * 27407 - a re-presented tracked ball must not read as a fresh instruction.
 *
 * The tracker deliberately keeps an untaken ball actionable past its mailbox
 * cursor (22203: "keeps an untaken direct request actionable without rewinding
 * its mailbox cursor"). So the wake itself cannot be suppressed; it must SAY it
 * is a replay and when the row was first sent. Before this change `woken_by`
 * carried neither field, so a wake on an old, already-acknowledged request was
 * indistinguishable from a fresh one and the seat paid a record check - or, if
 * it trusted the pane, did the wrong work (specimens b5da007c/f37561bd and
 * 2eb3d3c6, acked ten times).
 *
 * RED-first: this file fails on the pre-fix `woken_by`, which names the row but
 * carries no `sent_at` and no `replay`.
 */
import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { readInboxWaitWokenBy } from "./inbox-wait.ts"

const SEAT = "@dev/3"
const SENDER = "@chief"
const FIRST_SENT_MS = Date.UTC(2026, 9, 4, 6, 0, 0)

type Fixture = { dir: string; db: Database; stmts: TribeStatements }
const opened: Fixture[] = []

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tribe-27407-"))
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

/** One tracked ball: a direct request to SEAT with an open pending row. */
function openBall(stmts: TribeStatements): number {
  const inserted = stmts.insertMessage.run({
    $id: "req-old",
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
    $request: "req-old",
    $reply: null,
    $summary: null,
  })
  const seq = Number(inserted.lastInsertRowid)
  stmts.openPendingRequest.run({
    $request_id: "req-old",
    $recipient: SEAT,
    $sender: SENDER,
    $opened_at: FIRST_SENT_MS,
    $expires_at: FIRST_SENT_MS + 60_000,
    $message_id: "req-old",
    $fanout: "first",
  })
  return seq
}

describe("27407 a re-presented tracked ball names itself a replay", () => {
  it("carries the first-sent time and replay=true once the mailbox cursor is past the row", () => {
    const { stmts } = fixture()
    const seq = openBall(stmts)
    // The seat already read and acknowledged this row, so the cursor sits past
    // it. The ball is still untaken, so the tracker keeps re-presenting it.
    stmts.advanceMailboxCursor.run({ $recipient: SEAT, $seq: seq + 100, $now: FIRST_SENT_MS + 5 * 60_000 })

    const woken = readInboxWaitWokenBy(stmts, SEAT, seq, false)

    expect(woken).toMatchObject({
      kind: "message",
      seq,
      message_id: "req-old",
      type: "request",
      sender: SENDER,
      request_id: "req-old",
      sent_at: new Date(FIRST_SENT_MS).toISOString(),
      replay: true,
    })
  })

  it("carries sent_at but replay=false for a row the mailbox has never read", () => {
    const { stmts } = fixture()
    const seq = openBall(stmts)

    const woken = readInboxWaitWokenBy(stmts, SEAT, seq, false)

    expect(woken).toMatchObject({
      kind: "message",
      message_id: "req-old",
      sent_at: new Date(FIRST_SENT_MS).toISOString(),
      replay: false,
    })
  })
})
