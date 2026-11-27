/**
 * @failure Fetching a direct actionable row by id (`tribe.fetch({ ids: [id] })`) leaves it unread across
 *          inbox-status (Stop hook `unread_count` / `unread_ids`), inbox-wait, default fetch, and health, because
 *          an id-fetch is a snapshot read that rightly does not advance the high-water `mailbox_cursors` cursor
 *          (#38555 slice 3, @cto 8c2f07eb).
 * @level l2
 * @consumer tools/tribe-idle-attention-hook.ts (via inbox-status unread_count / unread_ids), tribe.fetch attention,
 *           inbox-wait attention, Hab busy-not-draining (projectHealthCadence inbox_lag).
 * @testonly none: every write and read goes through the production handleToolCall / readAttentionProjection /
 *           projectHealthCadence paths.
 *
 * #38555 slice 3 (@cto 8c2f07eb): a receipt-bearing `tribe.fetch({ ids })` records a per-(recipient, message_id)
 * read mark in `message_reads` for each actionable row returned to its own recipient. All four attention readers
 * agree without advancing `mailbox_cursors.last_actionable_seq` or `last_attention_read_at`:
 *   1. Fetching a verdict or response by id (push or pull seat) drops it from unread_count / unread_ids everywhere.
 *   2. An older unread row NOT in `ids` stays unread (no high-water swallow, #31840).
 *   3. `receipt: false` (host / workmon probes) writes nothing and leaves the row unread.
 *   4. Another seat fetching the row by id does not mark it read for the recipient.
 *   5. An open untaken request ball fetched by id stays owed in pending_balls and Branch 2 until TAKING or reply.
 */
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, readAttentionProjection, type HandlerOpts } from "./handlers.ts"
import { projectHealthCadence } from "./health-cadence.ts"
import { registerSession } from "./session.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const SEAT = "@dev/16"
const OTHER = "@chief"
const SENDER = "@cto"
const NOW = Date.now()

type Fixture = {
  dir: string
  seatCtx: TribeContext
  otherCtx: TribeContext
  stmts: TribeStatements
  db: ReturnType<typeof openDatabase>
}
const opened: Fixture[] = []

function fixture(delivery: "push" | "pull"): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `tribe-38555-id-fetch-${delivery}-`))
  const db = openDatabase(join(dir, "tribe.db"))
  const stmts = createStatements(db)
  const seatCtx = createTribeContext({
    db,
    stmts,
    sessionId: `sess-seat-${delivery}`,
    sessionRole: "member",
    initialName: SEAT,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
  const otherCtx = createTribeContext({
    db,
    stmts,
    sessionId: `sess-other-${delivery}`,
    sessionRole: "member",
    initialName: OTHER,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
  registerSession(seatCtx, undefined, () => false, null, 0, delivery)
  registerSession(otherCtx, undefined, () => false, null, 0, "push")
  db.prepare("UPDATE sessions SET started_at = $startedAt WHERE name IN ($seat, $other)").run({
    $startedAt: NOW - 2 * HOUR,
    $seat: SEAT,
    $other: OTHER,
  })
  const built = { dir, seatCtx, otherCtx, stmts, db }
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

function insertDirect(
  f: Fixture,
  row: { id: string; type: string; ts: number; ball?: boolean; attentionRequired?: boolean },
): void {
  f.stmts.insertMessage.run({
    $id: row.id,
    $type: row.type,
    $sender: SENDER,
    $recipient: SEAT,
    $kind: "direct",
    $content: `full body for ${row.id}`,
    $bead_id: null,
    $ref: null,
    $ts: row.ts,
    $delivery: "pull",
    $topic: null,
    $room_id: null,
    $request: row.ball === true ? row.id : null,
    $reply: null,
    $summary: `summary for ${row.id}`,
    $attention_required: row.attentionRequired === true ? 1 : 0,
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
}

function insertBroadcast(
  f: Fixture,
  row: { id: string; type?: string; ts: number; attentionRequired?: boolean },
): void {
  f.stmts.insertMessage.run({
    $id: row.id,
    $type: row.type ?? "notify",
    $sender: SENDER,
    $recipient: "*",
    $kind: "broadcast",
    $content: `broadcast body for ${row.id}`,
    $bead_id: null,
    $ref: null,
    $ts: row.ts,
    $delivery: "pull",
    $topic: null,
    $room_id: null,
    $request: null,
    $reply: null,
    $summary: `broadcast summary for ${row.id}`,
    $attention_required: row.attentionRequired === false ? 0 : 1,
  })
}

async function unreadIdsAcrossReaders(f: Fixture): Promise<{
  status: string[]
  wait: string[]
  fetch: string[]
  healthCount: number
}> {
  const projected = readAttentionProjection(f.seatCtx, SEAT, Date.now(), 0, handlerOpts())
  const status = projected.unreadRows.map((r) => r.id)
  const wait = projected.attention.actionable_unread.map((r) => String(r.id))
  const res = await handleToolCall(
    f.seatCtx,
    "tribe.fetch",
    { limit: 50, receipt: false, advance: false },
    handlerOpts(),
  )
  const text = (res as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  const parsed = JSON.parse(text) as { attention?: { actionable_unread?: Array<{ id: string }> } }
  const fetch = (parsed.attention?.actionable_unread ?? []).map((r) => r.id)
  const lag = projectHealthCadence(f.db, {
    now: NOW,
    connectedSessionNames: [],
    requestedSessionNames: [SEAT],
  }).inbox_lag.find((entry) => entry.session === SEAT)
  const healthCount = (lag?.actionable_rows ?? 0) + (lag?.actionable_held_rows ?? 0)
  return { status, wait, fetch, healthCount }
}

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.db.close()
    safeRemoveSync(item.dir, { within: realpathSync(tmpdir()) })
  }
})

describe("38555 slice 3: tribe.fetch({ ids }) counts as read for that seat across all four readers", () => {
  it.each(["push", "pull"] as const)(
    "fetching a verdict and a response by id on a %s seat drops them from unread_count everywhere without moving the cursor",
    async (delivery) => {
      const f = fixture(delivery)
      const verdictId = "8ac75f3b-0000-4000-8000-000000000001"
      const responseId = "97513e25-0000-4000-8000-000000000002"
      insertDirect(f, { id: verdictId, type: "verdict", ts: NOW - 20 * MINUTE })
      insertDirect(f, { id: responseId, type: "response", ts: NOW - 15 * MINUTE, attentionRequired: true })

      expect(await unreadIdsAcrossReaders(f)).toEqual({
        status: [verdictId, responseId],
        wait: [verdictId, responseId],
        fetch: [verdictId, responseId],
        healthCount: 2,
      })

      await handleToolCall(f.seatCtx, "tribe.fetch", { ids: [verdictId, responseId] }, handlerOpts())

      expect(await unreadIdsAcrossReaders(f)).toEqual({
        status: [],
        wait: [],
        fetch: [],
        healthCount: 0,
      })
      const cursor = f.db
        .prepare("SELECT last_actionable_seq, last_attention_read_at FROM mailbox_cursors WHERE recipient = ?")
        .get(SEAT) as { last_actionable_seq: number; last_attention_read_at: number | null } | null
      expect(cursor).toBeNull()
    },
  )

  it("keeps an older unread row NOT in ids unread (no high-water swallow)", async () => {
    const f = fixture("pull")
    const olderId = "50f62f38-0000-4000-8000-000000000003"
    const newerId = "a1922199-0000-4000-8000-000000000004"
    insertDirect(f, { id: olderId, type: "verdict", ts: NOW - 30 * MINUTE })
    insertDirect(f, { id: newerId, type: "verdict", ts: NOW - 10 * MINUTE })

    await handleToolCall(f.seatCtx, "tribe.fetch", { ids: [newerId] }, handlerOpts())

    expect(await unreadIdsAcrossReaders(f)).toEqual({
      status: [olderId],
      wait: [olderId],
      fetch: [olderId],
      healthCount: 1,
    })
  })

  it("does not mark a row read when receipt is false (host or workmon probe)", async () => {
    const f = fixture("pull")
    const verdictId = "f9c991eb-0000-4000-8000-000000000005"
    insertDirect(f, { id: verdictId, type: "verdict", ts: NOW - 20 * MINUTE })

    await handleToolCall(f.seatCtx, "tribe.fetch", { ids: [verdictId], receipt: false }, handlerOpts())

    expect(await unreadIdsAcrossReaders(f)).toEqual({
      status: [verdictId],
      wait: [verdictId],
      fetch: [verdictId],
      healthCount: 1,
    })
  })

  it("does not mark a row read for its recipient when a different seat fetches it by id", async () => {
    const f = fixture("pull")
    const verdictId = "11111111-0000-4000-8000-000000000006"
    insertDirect(f, { id: verdictId, type: "verdict", ts: NOW - 20 * MINUTE })

    await handleToolCall(f.otherCtx, "tribe.fetch", { ids: [verdictId] }, handlerOpts())

    expect(await unreadIdsAcrossReaders(f)).toEqual({
      status: [verdictId],
      wait: [verdictId],
      fetch: [verdictId],
      healthCount: 1,
    })
  })

  it("keeps an open untaken request ball owed in pending_balls and attention after id-fetch until TAKING or reply", async () => {
    const f = fixture("pull")
    const reqId = "22222222-0000-4000-8000-000000000007"
    insertDirect(f, { id: reqId, type: "request", ts: NOW - 20 * MINUTE, ball: true })

    await handleToolCall(f.seatCtx, "tribe.fetch", { ids: [reqId] }, handlerOpts())

    const projected = readAttentionProjection(f.seatCtx, SEAT, Date.now(), 0, handlerOpts())
    expect(projected.pendingBalls.map((b) => b.request_id)).toEqual([reqId])
    expect(projected.owedPendingBalls.map((b) => b.request_id)).toEqual([reqId])
    expect(projected.unreadRows.map((r) => r.id)).toEqual([reqId])
  })

  it("migrates a v48 database cleanly to v49 and creates message_reads + index", () => {
    const f = fixture("pull")
    f.db.run("DROP TABLE message_reads")
    f.db.run("UPDATE _schema_meta SET value = '48' WHERE key = 'version'")
    const dbPath = join(f.dir, "tribe.db")
    f.db.close()

    const reopened = openDatabase(dbPath)
    f.db = reopened
    const version = reopened.prepare("SELECT value FROM _schema_meta WHERE key = 'version'").get() as { value: string }
    expect(Number(version.value)).toBeGreaterThanOrEqual(49)
    const table = reopened
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_reads'")
      .get() as { name: string } | null
    expect(table?.name).toBe("message_reads")
    const index = reopened
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_message_reads_message_id'")
      .get() as { name: string } | null
    expect(index?.name).toBe("idx_message_reads_message_id")
  })

  it.each(["push", "pull"] as const)(
    "#39021 (%s): id-fetch retires an attention broadcast for the reader alone across all attention queries without moving the cursor",
    async (delivery) => {
      const f = fixture(delivery)
      const olderDirectId = "33333333-0000-4000-8000-000000000001"
      const bcastId = "33333333-0000-4000-8000-000000000002"
      insertDirect(f, { id: olderDirectId, type: "verdict", ts: NOW - 25 * MINUTE })
      insertBroadcast(f, { id: bcastId, type: "notify", ts: NOW - 20 * MINUTE, attentionRequired: true })

      // Before id-fetch: SEAT sees both rows, OTHER sees the broadcast.
      expect(await unreadIdsAcrossReaders(f)).toEqual({
        status: [olderDirectId, bcastId],
        wait: [olderDirectId, bcastId],
        fetch: [olderDirectId, bcastId],
        healthCount: 1,
      })
      expect(f.stmts.countUnackedAttention.get({ $name: SEAT })).toEqual({ count: 2 })
      expect(f.stmts.getLatestActionableAttention.get({ $name: SEAT })).toMatchObject({ id: bcastId })
      expect(
        f.stmts.getLatestInboxWaitMessage.get({
          $name: SEAT,
          $unacknowledged_only: 1,
          $include_correlated_replies: 0,
        }),
      ).toMatchObject({ rowid: expect.any(Number) })
      expect(
        readAttentionProjection(f.otherCtx, OTHER, Date.now(), 0, handlerOpts()).unreadRows.map((r) => r.id),
      ).toEqual([bcastId])

      // receipt: false leaves the broadcast unread.
      await handleToolCall(f.seatCtx, "tribe.fetch", { ids: [bcastId], receipt: false }, handlerOpts())
      expect(
        readAttentionProjection(f.seatCtx, SEAT, Date.now(), 0, handlerOpts()).unreadRows.map((r) => r.id),
      ).toEqual([olderDirectId, bcastId])

      // Receipt-bearing id-fetch retires ONLY the broadcast for SEAT; older direct stays unread, cursor stays 0.
      await handleToolCall(f.seatCtx, "tribe.fetch", { ids: [bcastId] }, handlerOpts())
      expect(f.stmts.getMailboxCursor.get({ $recipient: SEAT })).toBeNull()
      expect(await unreadIdsAcrossReaders(f)).toEqual({
        status: [olderDirectId],
        wait: [olderDirectId],
        fetch: [olderDirectId],
        healthCount: 1,
      })
      expect(f.stmts.countUnackedAttention.get({ $name: SEAT })).toEqual({ count: 1 })
      expect(f.stmts.getLatestActionableAttention.get({ $name: SEAT })).toMatchObject({ id: olderDirectId })

      // OTHER still sees the broadcast unread (per-reader isolation).
      expect(
        readAttentionProjection(f.otherCtx, OTHER, Date.now(), 0, handlerOpts()).unreadRows.map((r) => r.id),
      ).toEqual([bcastId])
      expect(f.stmts.countUnackedAttention.get({ $name: OTHER })).toEqual({ count: 1 })

      // Now SEAT reads the older direct by id too: every attention reader (including inbox-wait) drops to zero.
      await handleToolCall(f.seatCtx, "tribe.fetch", { ids: [olderDirectId] }, handlerOpts())
      expect(await unreadIdsAcrossReaders(f)).toEqual({
        status: [],
        wait: [],
        fetch: [],
        healthCount: 0,
      })
      expect(f.stmts.countUnackedAttention.get({ $name: SEAT })).toEqual({ count: 0 })
      expect(f.stmts.getLatestActionableAttention.get({ $name: SEAT })).toBeNull()
      expect(
        f.stmts.getLatestInboxWaitMessage.get({
          $name: SEAT,
          $unacknowledged_only: 1,
          $include_correlated_replies: 0,
        }),
      ).toEqual({ rowid: null })

      // A later default fetch advances mailbox_cursors cleanly past the already-id-read broadcast
      // (proving selectUnreturnedAttention does not pin the cursor behind it).
      const newerDirectId = "33333333-0000-4000-8000-000000000003"
      insertDirect(f, { id: newerDirectId, type: "verdict", ts: NOW - 5 * MINUTE })
      const newerRowid = (
        f.db.prepare("SELECT rowid FROM messages WHERE id = ?").get(newerDirectId) as { rowid: number }
      ).rowid
      await handleToolCall(f.seatCtx, "tribe.fetch", {}, handlerOpts())
      expect(f.stmts.getMailboxCursor.get({ $recipient: SEAT })).toMatchObject({ last_actionable_seq: newerRowid })
    },
  )
})
