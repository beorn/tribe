/**
 * @failure The Stop hook blocks a seat on rows it already read and acted on: a verdict or response pushed to the
 *          pane with its body stays in inbox-status `unread_ids` (and the default fetch's actionable_unread, and
 *          inbox-wait's attention) until a default fetch moves the mailbox cursor, while the health page has
 *          already retired the same row (#30649). Two readers disagree about one row.
 * @level l2
 * @consumer tools/tribe-idle-attention-hook.ts (via inbox-status unread_ids), tribe.fetch attention, inbox-wait
 *           attention, Hab busy-not-draining (projectHealthCadence inbox_lag).
 * @testonly none: every reader here is the production path; the fixture writes only rows, delivery cursors and
 *           turn-start receipts the daemon itself writes.
 *
 * #38555 (@cto 8da79000): one predicate (acted-after.ts) gives the same answer through all four readers for a
 * handled inline row (retired), an unhandled inline row, a ball and a directive (all still unread), and a pull
 * seat's row stays unread after a send.
 */
import { mkdtempSync, rmSync } from "node:fs"
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
const SEAT = "@dev/handled"
const SENDER = "@chief"
const NOW = Date.now()

type Fixture = { dir: string; ctx: TribeContext; stmts: TribeStatements; db: ReturnType<typeof openDatabase> }
const opened: Fixture[] = []

function fixture(delivery: "push" | "pull"): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tribe-38555-"))
  const db = openDatabase(join(dir, "tribe.db"))
  const stmts = createStatements(db)
  const ctx = createTribeContext({
    db,
    stmts,
    sessionId: `sess-38555-${delivery}`,
    sessionRole: "member",
    initialName: SEAT,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
  registerSession(ctx, undefined, () => false, null, 0, delivery)
  db.prepare("UPDATE sessions SET started_at = $startedAt WHERE name = $name").run({
    $startedAt: NOW - 2 * HOUR,
    $name: SEAT,
  })
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

/** What the seat writes after reading: a turn artifact, never an event. */
function seatSends(f: Fixture, ts: number): void {
  f.stmts.insertMessage.run({
    $id: `seat-send-${ts}`,
    $type: "response",
    $sender: SEAT,
    $recipient: SENDER,
    $kind: "direct",
    $content: "answered",
    $bead_id: null,
    $ref: null,
    $ts: ts,
    $delivery: "push",
    $topic: null,
    $room_id: null,
    $request: null,
    $reply: null,
    $summary: null,
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

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.db.close()
    rmSync(item.dir, { recursive: true, force: true })
  }
})

describe("38555 one acted-after rule, the same answer through every attention reader", () => {
  it.each([
    {
      kind: "handled inline row",
      row: { id: "v-handled", type: "verdict", ts: NOW - 45 * MINUTE },
      sendAt: NOW - 40 * MINUTE,
      unread: false,
    },
    {
      kind: "unhandled inline row",
      row: { id: "v-unhandled", type: "verdict", ts: NOW - 30 * MINUTE },
      sendAt: NOW - 40 * MINUTE,
      unread: true,
    },
    {
      kind: "ball",
      row: { id: "req-ball", type: "request", ts: NOW - 45 * MINUTE, ball: true },
      sendAt: NOW - 40 * MINUTE,
      unread: true,
    },
    {
      kind: "directive",
      row: { id: "req-directive", type: "request", ts: NOW - 45 * MINUTE },
      sendAt: NOW - 40 * MINUTE,
      unread: true,
    },
  ])(
    "$kind on a push seat: unread=$unread in inbox-status, inbox-wait, fetch and health",
    async ({ row, sendAt, unread }) => {
      const f = fixture("push")
      deliver(f, row)
      seatSends(f, sendAt)
      expect(await readers(f)).toEqual({ status: unread, wait: unread, fetch: unread, health: unread })
    },
  )

  it("retires an inline row only on an action strictly after it, never one at the same instant", async () => {
    const f = fixture("push")
    deliver(f, { id: "v-same-ms", type: "verdict", ts: NOW - 45 * MINUTE })
    seatSends(f, NOW - 45 * MINUTE)
    expect(await readers(f)).toEqual({ status: true, wait: true, fetch: true, health: true })
  })

  it("keeps a pull seat's row unread after a send, in every reader", async () => {
    const f = fixture("pull")
    deliver(f, { id: "v-pull", type: "verdict", ts: NOW - 45 * MINUTE })
    seatSends(f, NOW - 40 * MINUTE)
    expect(await readers(f)).toEqual({ status: true, wait: true, fetch: true, health: true })
  })
})
