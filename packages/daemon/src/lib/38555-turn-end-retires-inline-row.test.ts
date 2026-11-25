/**
 * @failure A seat handed a no-reply verdict inline (body in the pane) handles it in text alone and ends its turn;
 *          the Stop hook still blocks on it, because the acted-after rule saw no later send and Claude pane seats
 *          write no turn-start receipt (live 2026-11-25 09:14 PST, yrd verdict 8e7af330).
 * @level l2
 * @consumer tools/tribe-idle-attention-hook.ts (writes `tribe turn-ended`, then reads inbox-status unread_ids),
 *           tribe.fetch attention, inbox-wait attention, Hab busy-not-draining (projectHealthCadence inbox_lag).
 * @testonly none: every reader is the production path; the fixture writes only rows, delivery cursors and the
 *           turn-end receipt through the statement `cli_turn_end_receipt_by_launch_v1` runs.
 *
 * #38555 slice 2 (@cto ac37d401): a turn-end receipt is an act. A non-ball row delivered with its body before the
 * receipt is retired in all four readers; a ball opened the same way stays owed, a bodiless directive stays unread,
 * a pull seat's row stays unread, and a row delivered after the receipt waits for the next one.
 */
import { mkdtempSync, realpathSync } from "node:fs"
import { safeRemoveSync } from "removely"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, readAttentionProjection, type HandlerOpts } from "./handlers.ts"
import { projectHealthCadence } from "./health-cadence.ts"
import { registerSession } from "./session.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const SEAT = "@dev/turn-end"
const SENDER = "@yrd-service"
const LAUNCH_ID = "launch-38555-turn-end"
const LAUNCH_PARENT_PID = 4242
const NOW = Date.now()

type Fixture = { dir: string; ctx: TribeContext; stmts: TribeStatements; db: ReturnType<typeof openDatabase> }
const opened: Fixture[] = []

function fixture(delivery: "push" | "pull"): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tribe-38555-turn-end-"))
  const db = openDatabase(join(dir, "tribe.db"))
  const stmts = createStatements(db)
  const ctx = createTribeContext({
    db,
    stmts,
    sessionId: `sess-38555-turn-end-${delivery}`,
    sessionRole: "member",
    initialName: SEAT,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
  registerSession(ctx, undefined, () => false, null, 0, delivery)
  // The launch identity the token-verified dispatcher path resolves the seat to.
  db.prepare(
    "UPDATE sessions SET started_at = $startedAt, launch_id = $launchId, launch_parent_pid = $pid WHERE name = $name",
  ).run({ $startedAt: NOW - 2 * HOUR, $launchId: LAUNCH_ID, $pid: LAUNCH_PARENT_PID, $name: SEAT })
  const built = { dir, ctx, stmts, db }
  opened.push(built)
  return built
}

const handlerOpts = (): HandlerOpts => ({
  cleanup: () => {},
  userRenamed: false,
  setUserRenamed: () => {},
  getActiveSessionIds: () => new Set<string>(),
  hasActiveTransport: () => false,
  isReconnectGraceProtected: () => false,
  getActiveSessionInfo: () => [],
})

/** A direct row to the seat, plus (for a push seat) the completed socket write that carried it. */
function deliver(f: Fixture, row: { id: string; type: string; ts: number; ball?: boolean }): void {
  const push =
    (
      f.db.prepare("SELECT delivery FROM sessions WHERE name = $name").get({ $name: SEAT }) as {
        delivery: string
      }
    ).delivery === "push"
  const inserted = f.stmts.insertMessage.run({
    $id: row.id,
    $type: row.type,
    $sender: SENDER,
    $recipient: SEAT,
    $kind: "direct",
    $content: row.id,
    $bead_id: null,
    $ref: null,
    $ts: row.ts,
    $delivery: push ? "push" : "pull",
    $topic: null,
    $room_id: null,
    $request: row.ball === true ? row.id : null,
    $reply: null,
    $summary: row.id,
  })
  if (row.ball === true) {
    f.stmts.openPendingRequest.run({
      $request_id: row.id,
      $recipient: SEAT,
      $sender: SENDER,
      $opened_at: row.ts,
      $expires_at: NOW + HOUR,
      $message_id: row.id,
      $fanout: "first",
    })
  }
  if (push) {
    f.db
      .prepare("UPDATE sessions SET last_delivered_seq = $seq, last_delivered_ts = $ts WHERE name = $name")
      .run({ $seq: Number(inserted.lastInsertRowid), $ts: row.ts, $name: SEAT })
  }
}

/** The seat's turn ended (no send): the receipt `tribe turn-ended` writes for this launch. */
function turnEnds(f: Fixture, at: number): void {
  f.stmts.upsertTurnEndReceipt.run({
    $session: SEAT,
    $launch_id: LAUNCH_ID,
    $launch_parent_pid: LAUNCH_PARENT_PID,
    $received_at: at,
  })
}

/** The four readers, each through the call its consumer makes. */
async function readers(f: Fixture): Promise<Record<string, boolean>> {
  // inbox-status: with-dispatcher readInboxStatus maps readAttentionProjection(...).attentionRows to unread_ids.
  const status = readAttentionProjection(f.ctx, SEAT, Date.now(), 0, handlerOpts()).attentionRows.length > 0
  // inbox-wait: with-dispatcher wires readAttentionProjection(...).attention as its attention carriage.
  const wait = readAttentionProjection(f.ctx, SEAT, Date.now(), 0, handlerOpts()).attention.actionable_unread.length > 0
  // default fetch: the tool's attention.actionable_unread (receipt:false so the read moves no cursor).
  const result = await handleToolCall(f.ctx, "tribe.fetch", { limit: 50, receipt: false }, handlerOpts())
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  const fetched = (JSON.parse(text) as { attention?: { actionable_unread?: unknown[] } }).attention?.actionable_unread
  const fetch = (fetched?.length ?? 0) > 0
  // health: busy-not-draining's actionable reading.
  const lag = projectHealthCadence(f.db, {
    now: NOW,
    connectedSessionNames: [],
    requestedSessionNames: [SEAT],
  }).inbox_lag.find((entry) => entry.session === SEAT)
  const health = (lag?.actionable_rows ?? 0) + (lag?.actionable_held_rows ?? 0) > 0
  return { status, wait, fetch, health }
}

const owedBallIds = (f: Fixture): string[] =>
  readAttentionProjection(f.ctx, SEAT, Date.now(), 0, handlerOpts()).pendingBalls.map((ball) => ball.request_id)

const ALL_UNREAD = { status: true, wait: true, fetch: true, health: true }
const ALL_RETIRED = { status: false, wait: false, fetch: false, health: false }

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.db.close()
    safeRemoveSync(item.dir, { within: realpathSync(tmpdir()) })
  }
})

describe("38555 slice 2: a turn-end receipt retires the inline no-reply row that turn handled", () => {
  it("retires a no-reply verdict handed inline, after a turn-end receipt with no send, in every reader", async () => {
    const f = fixture("push")
    deliver(f, { id: "v-0914", type: "verdict", ts: NOW - 45 * MINUTE })
    expect(await readers(f)).toEqual(ALL_UNREAD)
    turnEnds(f, NOW - 40 * MINUTE)
    expect(await readers(f)).toEqual(ALL_RETIRED)
  })

  it.each([
    { kind: "tracked request (bodiless directive)", row: { id: "req-ball", type: "request", ball: true } },
    { kind: "verdict sent with request tracking", row: { id: "v-ball", type: "verdict", ball: true } },
  ])("keeps a ball opened by a $kind owed and unread after a turn-end receipt", async ({ row }) => {
    const f = fixture("push")
    deliver(f, { ...row, ts: NOW - 45 * MINUTE })
    turnEnds(f, NOW - 40 * MINUTE)
    expect(owedBallIds(f)).toEqual([row.id])
    expect(await readers(f)).toEqual(ALL_UNREAD)
  })

  it("keeps a bodiless directive row unread after a turn-end receipt", async () => {
    const f = fixture("push")
    deliver(f, { id: "req-directive", type: "request", ts: NOW - 45 * MINUTE })
    turnEnds(f, NOW - 40 * MINUTE)
    expect(await readers(f)).toEqual(ALL_UNREAD)
  })

  it("keeps a pull seat's row unread after a turn-end receipt", async () => {
    const f = fixture("pull")
    deliver(f, { id: "v-pull", type: "verdict", ts: NOW - 45 * MINUTE })
    turnEnds(f, NOW - 40 * MINUTE)
    expect(await readers(f)).toEqual(ALL_UNREAD)
  })

  it("keeps a row delivered after the turn-end receipt unread until the next receipt", async () => {
    const f = fixture("push")
    turnEnds(f, NOW - 40 * MINUTE)
    deliver(f, { id: "v-late", type: "verdict", ts: NOW - 30 * MINUTE })
    expect(await readers(f)).toEqual(ALL_UNREAD)
    turnEnds(f, NOW - 20 * MINUTE)
    expect(await readers(f)).toEqual(ALL_RETIRED)
  })
})
