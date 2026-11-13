/**
 * 33213 — an idle Claude push seat was paged for a row the socket had already
 * handed it with its body. RED-first: on the pre-fix projection every one of the
 * first four expectations fails, because a completed `socket.write()` and "the
 * model read it" were the same thing to the health reader.
 *
 * The split (see health-cadence.ts `INLINE_DELIVERY_LAG_GRACE_MS`): a direct row
 * written to a push seat socket WITH its body is held back for ten minutes; a
 * directive row (request/query/assign, written body-less), a never-written row,
 * and every row on a pull seat count from the first second.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { projectHealthCadence } from "./health-cadence.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"
import { registerSession } from "./session.ts"

const MINUTE = 60_000
const SEAT = "@dev/grace"
const SENDER = "@chief"
const NOW = Date.UTC(2026, 10, 10, 23, 30, 0)

type Fixture = { dir: string; ctx: TribeContext; stmts: TribeStatements; db: ReturnType<typeof openDatabase> }
const opened: Fixture[] = []

function fixture(delivery: "push" | "pull"): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tribe-33213-"))
  const db = openDatabase(join(dir, "tribe.db"))
  const stmts = createStatements(db)
  const ctx = createTribeContext({
    db,
    stmts,
    sessionId: `sess-33213-${delivery}`,
    sessionRole: "member",
    initialName: SEAT,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
  registerSession(ctx, undefined, () => false, null, 0, delivery)
  const built = { dir, ctx, stmts, db }
  opened.push(built)
  return built
}

function sendOnly(
  fixture: Fixture,
  message: { id: string; type: string; ts: number; delivery?: "push" | "pull" },
): number {
  const inserted = fixture.stmts.insertMessage.run({
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

/** A direct row plus the socket write that carried it — what the daemon records. */
function sendAndDeliver(
  fixture: Fixture,
  message: { id: string; type: string; ts: number; delivery?: "push" | "pull" },
): number {
  const seq = sendOnly(fixture, message)
  fixture.db
    .prepare("UPDATE sessions SET last_delivered_seq = $seq, last_delivered_ts = $ts WHERE name = $name")
    .run({ $seq: seq, $ts: message.ts, $name: SEAT })
  return seq
}

function inboxRow(fixture: Fixture) {
  const projection = projectHealthCadence(fixture.db, {
    now: NOW,
    connectedSessionNames: [],
    requestedSessionNames: [SEAT],
  })
  const row = projection.inbox_lag.find((entry) => entry.session === SEAT)
  if (row === undefined) throw new Error(`no inbox_lag row for ${SEAT}`)
  return { row, warnings: projection.warnings }
}

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.db.close()
    rmSync(item.dir, { recursive: true, force: true })
  }
})

// @failure The health reader pages an idle seat for a row the socket already
// delivered with its body, and the page cannot say whether the transport or the
// seat is at fault.
// @level l2
// @consumer Hab attention, chief supervision, captured Wire health readers
describe("33213 a body delivered to a push seat is not attention until it goes unread", () => {
  it("does not count a row written to its socket still inside the grace", () => {
    const f = fixture("push")
    // The reproduced shape: written 56 ms after send, seat still inside its turn.
    sendAndDeliver(f, { id: "verdict-fresh", type: "verdict", ts: NOW - 4 * MINUTE })

    const { row, warnings } = inboxRow(f)

    expect(row).toMatchObject({
      actionable_rows: 0,
      actionable_held_rows: 1,
      actionable_causes: [],
      actionable_oldest_age_ms: 0,
      oldest_actionable: null,
      // coordination-watch refuses a waking count larger than the actionable one
      // it is a subset of, so the grace has to reach this subset too.
      waking_rows: 0,
      waking_oldest_age_ms: 0,
    })
    expect(warnings).toEqual([])
  })

  it("counts the same row once it has gone unfetched past the grace, and the page says why", () => {
    const f = fixture("push")
    sendAndDeliver(f, { id: "verdict-stale", type: "verdict", ts: NOW - 45 * MINUTE })

    const { row, warnings } = inboxRow(f)

    expect(row).toMatchObject({
      actionable_rows: 1,
      actionable_held_rows: 0,
      actionable_oldest_age_ms: 45 * MINUTE,
      actionable_causes: [{ cause: "delivered-inline-unfetched", rows: 1, oldest_age_ms: 45 * MINUTE }],
      oldest_actionable: { id: "verdict-stale", type: "verdict" },
    })
    expect(warnings.join("\n")).toContain("1 actionable row(s) [1 written to its socket, unfetched for 45m]")
  })

  // The three readings @cto asked for, in one place: what the write path records,
  // what the session high-water mark holds, and what a fetch can still report.
  // A writable socket accepts the bytes and never acknowledges them; the health
  // reader says exactly that and nothing more.
  it("records the socket write and the high-water mark, and leaves the pull cursor alone", () => {
    const f = fixture("push")
    const seq = sendAndDeliver(f, { id: "verdict-socket-only", type: "verdict", ts: NOW - 45 * MINUTE })

    const delivered = f.stmts.getLastDelivered.get({ $id: "sess-33213-push" }) as {
      last_delivered_ts: number
      last_delivered_seq: number
    }
    expect(delivered.last_delivered_seq).toBe(seq)

    // What a drain advances is last_inbox_pull_seq, and a socket write never
    // touches it, so the row is still reportable by a fetch whatever the reader
    // says about the transport.
    const pull = f.db
      .prepare("SELECT last_inbox_pull_seq FROM sessions WHERE id = $id")
      .get({ $id: "sess-33213-push" }) as { last_inbox_pull_seq: number }
    expect(pull.last_inbox_pull_seq).toBe(0)
    const row = f.db.prepare("SELECT delivery FROM messages WHERE id = $id").get({ $id: "verdict-socket-only" }) as {
      delivery: string
    }
    expect(row.delivery).toBe("push")

    expect(inboxRow(f).warnings.join("\n")).toContain("[1 written to its socket, unfetched for 45m]")
  })

  it("counts a directive row at once even though the socket wrote it", () => {
    const f = fixture("push")
    sendAndDeliver(f, { id: "request-fresh", type: "request", ts: NOW - 30_000 })

    const { row } = inboxRow(f)

    expect(row).toMatchObject({
      actionable_rows: 1,
      actionable_held_rows: 0,
      actionable_causes: [{ cause: "directive-unread", rows: 1, oldest_age_ms: 30_000 }],
      oldest_actionable: { id: "request-fresh" },
    })
  })

  it("counts a body row at once on a pull seat, where no socket ever carried it", () => {
    const f = fixture("pull")
    sendAndDeliver(f, { id: "verdict-pull", type: "verdict", ts: NOW - 30_000 })

    const { row } = inboxRow(f)

    expect(row).toMatchObject({
      actionable_rows: 1,
      actionable_held_rows: 0,
      actionable_causes: [{ cause: "never-delivered", rows: 1, oldest_age_ms: 30_000 }],
    })
  })

  it("partitions one mailbox into the three cases the page names", () => {
    const f = fixture("push")
    sendAndDeliver(f, { id: "verdict-expired", type: "verdict", ts: NOW - 40 * MINUTE })
    sendAndDeliver(f, { id: "request-open", type: "request", ts: NOW - 10 * MINUTE })
    sendAndDeliver(f, { id: "verdict-held", type: "verdict", ts: NOW - MINUTE })
    // Never delivered: inserted last, so the seat's high-water mark stays behind it.
    sendOnly(f, { id: "verdict-undelivered", type: "verdict", ts: NOW - 20 * MINUTE })

    const { row } = inboxRow(f)

    expect(row.actionable_rows).toBe(3)
    expect(row.actionable_held_rows).toBe(1)
    expect(new Map(row.actionable_causes.map((entry) => [entry.cause, entry.rows]))).toEqual(
      new Map([
        ["delivered-inline-unfetched", 1],
        ["directive-unread", 1],
        ["never-delivered", 1],
      ]),
    )
  })

  it("clears the count on a fetch, and the fetch still shows the delivered row once as a replay", async () => {
    const f = fixture("push")
    // Delivered inline and never fetched: the socket write alone is the delivery
    // record, so the drain presents it as a replay rather than as new work.
    const seq = sendAndDeliver(f, { id: "verdict-replayed", type: "verdict", ts: NOW - 45 * MINUTE })
    // The ambient cursor is this seat's TRANSPORT record (it advances on a pane
    // drain), not the model's read — so it says "already shown", never "read".
    f.db
      .prepare("UPDATE sessions SET last_inbox_pull_seq = $seq WHERE name = $name")
      .run({ $seq: seq + 100, $name: SEAT })
    expect(inboxRow(f).row.actionable_rows).toBe(1)

    const options = (): HandlerOpts => ({
      cleanup: () => {},
      userRenamed: false,
      setUserRenamed: () => {},
      getActiveSessionIds: () => new Set<string>(),
      hasActiveTransport: () => false,
      isReconnectGraceProtected: () => false,
      getActiveSessionInfo: () => [],
    })
    const drain = async (receipt: boolean) => {
      const result = await handleToolCall(f.ctx, "tribe.fetch", { limit: 500, receipt }, options())
      const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
      return JSON.parse(text) as {
        attention?: { actionable_unread?: Array<{ id: string; replay?: boolean }> }
      }
    }

    const paneDrain = await drain(false)
    expect(paneDrain.attention?.actionable_unread).toHaveLength(1)
    expect(paneDrain.attention?.actionable_unread?.[0]).toMatchObject({ id: "verdict-replayed", replay: true })

    // The model's own read is the only thing that advances the mailbox cursor.
    await drain(true)
    expect(inboxRow(f).row).toMatchObject({
      actionable_rows: 0,
      actionable_held_rows: 0,
      actionable_causes: [],
      oldest_actionable: null,
    })
    expect(inboxRow(f).warnings).toEqual([])
  })
})
