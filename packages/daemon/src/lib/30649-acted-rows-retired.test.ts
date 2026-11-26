/**
 * @failure A push seat that read a channel-delivered non-ball row inline and ran a
 *          turn afterwards is still paged as busy-not-draining for it: the daemon's
 *          actionable reading never learns that the seat acted, and the page fires
 *          on seats that owe nothing.
 * @level l2
 * @consumer Hab attention (busy-not-draining), chief supervision, `cli_health` inbox_lag.
 * @testonly none: the projection is production code; the fixture writes only rows
 *           and turn-start receipts the daemon itself writes.
 *
 * 30649 Part 1 — RED-first: pre-fix the delivered yrd verdict still counts as
 * actionable demand 45 minutes later, even though the seat sent its answer or
 * started its next turn five minutes after it.
 *
 * The retirement is narrow on purpose: only a row the socket carried WITH its body
 * (`delivery = 'push'`, non-ball), only when the seat acted after it, only inside
 * the session that received it. A pull seat, a restarted session, a directive row
 * and a send that predates the row all keep counting, so a seat that really left
 * a request unanswered still pages.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { projectHealthCadence } from "./health-cadence.ts"
import { registerSession } from "./session.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const SEAT = "@dev/acted"
const SENDER = "@chief"
const NOW = Date.UTC(2026, 10, 10, 23, 30, 0)
const LAUNCH_ID = "launch-30649-a"
const LAUNCH_PARENT_PID = 4242

type Fixture = { dir: string; ctx: TribeContext; stmts: TribeStatements; db: ReturnType<typeof openDatabase> }
const opened: Fixture[] = []

function fixture(delivery: "push" | "pull"): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tribe-30649-"))
  const db = openDatabase(join(dir, "tribe.db"))
  const stmts = createStatements(db)
  const ctx = createTribeContext({
    db,
    stmts,
    sessionId: `sess-30649-${delivery}`,
    sessionRole: "member",
    initialName: SEAT,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
  registerSession(ctx, undefined, () => false, null, 0, delivery)
  // registerSession stamps the real clock; the rows here live at NOW, so pin a
  // session start before them and the launch the turn-start receipts belong to.
  db.prepare(
    "UPDATE sessions SET started_at = $startedAt, launch_id = $launchId, launch_parent_pid = $pid WHERE name = $name",
  ).run({ $startedAt: NOW - 2 * HOUR, $launchId: LAUNCH_ID, $pid: LAUNCH_PARENT_PID, $name: SEAT })
  const built = { dir, ctx, stmts, db }
  opened.push(built)
  return built
}

function insertIncoming(
  f: Fixture,
  message: { id: string; type: string; ts: number; delivery?: "push" | "pull" },
): number {
  const inserted = f.stmts.insertMessage.run({
    $id: message.id,
    $type: message.type,
    $sender: SENDER,
    $recipient: SEAT,
    $kind: "direct",
    $content: message.id,
    $bead_id: null,
    $ref: null,
    $ts: message.ts,
    $delivery: message.delivery ?? "push",
    $topic: null,
    $room_id: null,
    $request: null,
    $reply: null,
    $summary: message.id,
  })
  return Number(inserted.lastInsertRowid)
}

/** A direct row plus the completed socket write that carried it. */
function deliver(f: Fixture, message: { id: string; type: string; ts: number; delivery?: "push" | "pull" }): number {
  const seq = insertIncoming(f, message)
  f.db
    .prepare("UPDATE sessions SET last_delivered_seq = $seq, last_delivered_ts = $ts WHERE name = $name")
    .run({ $seq: seq, $ts: message.ts, $name: SEAT })
  return seq
}

/** What the seat itself writes: a turn artifact, never an event. */
function seatSends(f: Fixture, ts: number, id = `seat-send-${ts}`): void {
  f.stmts.insertMessage.run({
    $id: id,
    $type: "response",
    $sender: SEAT,
    $recipient: SENDER,
    $kind: "direct",
    $content: id,
    $bead_id: null,
    $ref: null,
    $ts: ts,
    $delivery: "push",
    $topic: null,
    $room_id: null,
    $request: null,
    $reply: null,
    $summary: id,
  })
}

function seatStartsTurn(f: Fixture, receivedAt: number, turn = `turn-${receivedAt}`): void {
  f.stmts.insertTurnStartReceipt.run({
    $session: SEAT,
    $launch_id: LAUNCH_ID,
    $launch_parent_pid: LAUNCH_PARENT_PID,
    $controller_session_id: "controller-1",
    $provider_session_id: "provider-1",
    $provider_turn_id: turn,
    $started_at: receivedAt,
    $received_at: receivedAt,
  })
}

function inboxRow(f: Fixture) {
  const projection = projectHealthCadence(f.db, {
    now: NOW,
    connectedSessionNames: [],
    requestedSessionNames: [SEAT],
  })
  const row = projection.inbox_lag.find((entry) => entry.session === SEAT)
  if (row === undefined) throw new Error(`no inbox_lag row for ${SEAT}`)
  return row
}

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.db.close()
    rmSync(item.dir, { recursive: true, force: true })
  }
})

describe("30649 an inline-delivered non-ball row the seat acted after is not demand", () => {
  it("retires a delivered verdict once the seat sends after it", () => {
    const f = fixture("push")
    deliver(f, { id: "verdict-answered", type: "verdict", ts: NOW - 45 * MINUTE })
    seatSends(f, NOW - 40 * MINUTE)

    const row = inboxRow(f)

    expect(row).toMatchObject({
      actionable_rows: 0,
      actionable_held_rows: 0,
      actionable_causes: [],
      actionable_oldest_age_ms: 0,
      oldest_actionable: null,
      waking_rows: 0,
    })
  })

  it("retires a delivered verdict on a turn start recorded after it", () => {
    const f = fixture("push")
    deliver(f, { id: "verdict-read-inline", type: "verdict", ts: NOW - 45 * MINUTE })
    seatStartsTurn(f, NOW - 40 * MINUTE)

    expect(inboxRow(f)).toMatchObject({
      actionable_rows: 0,
      actionable_held_rows: 0,
      actionable_causes: [],
      oldest_actionable: null,
      waking_rows: 0,
    })
  })

  it("keeps counting the same row when the seat's send came before it", () => {
    const f = fixture("push")
    seatSends(f, NOW - 50 * MINUTE)
    deliver(f, { id: "verdict-after-send", type: "verdict", ts: NOW - 45 * MINUTE })

    expect(inboxRow(f)).toMatchObject({
      actionable_rows: 1,
      actionable_causes: [{ cause: "delivered-inline-unfetched", rows: 1, oldest_age_ms: 45 * MINUTE }],
      oldest_actionable: { id: "verdict-after-send", type: "verdict" },
    })
  })

  it("retires nothing on a pull seat, where no socket carried the body", () => {
    const f = fixture("pull")
    deliver(f, { id: "verdict-pull", type: "verdict", ts: NOW - 45 * MINUTE })
    seatSends(f, NOW - 40 * MINUTE)

    // #38676 residual: the row stays, and the seat's own delivery mode names it a pending fetch.
    expect(inboxRow(f)).toMatchObject({
      actionable_rows: 1,
      actionable_causes: [{ cause: "pull-unfetched", rows: 1, oldest_age_ms: 45 * MINUTE }],
    })
  })

  it("retires nothing for a restarted session's send, even with the high-water mark carried over", () => {
    const f = fixture("push")
    const seq = deliver(f, { id: "verdict-before-restart", type: "verdict", ts: NOW - 45 * MINUTE })
    // The previous generation was handed the row; the new session registered after
    // it and happens to have a high-water mark that covers the same sequence space.
    f.db
      .prepare(
        "UPDATE sessions SET started_at = $startedAt, last_delivered_seq = $seq, launch_id = $launchId, launch_parent_pid = $pid WHERE name = $name",
      )
      .run({ $startedAt: NOW - 30 * MINUTE, $seq: seq, $launchId: "launch-30649-b", $pid: 4343, $name: SEAT })
    seatSends(f, NOW - 25 * MINUTE)

    expect(inboxRow(f)).toMatchObject({
      actionable_rows: 1,
      actionable_causes: [{ cause: "delivered-inline-unfetched", rows: 1, oldest_age_ms: 45 * MINUTE }],
    })
  })

  it("keeps a delivered directive in demand even when the seat acts after it", () => {
    const f = fixture("push")
    deliver(f, { id: "request-open", type: "request", ts: NOW - 45 * MINUTE })
    seatSends(f, NOW - 40 * MINUTE)

    expect(inboxRow(f)).toMatchObject({
      actionable_rows: 1,
      actionable_causes: [{ cause: "directive-unread", rows: 1, oldest_age_ms: 45 * MINUTE }],
      oldest_actionable: { id: "request-open", type: "request" },
    })
  })
})
