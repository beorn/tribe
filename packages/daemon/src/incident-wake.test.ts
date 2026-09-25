/**
 * @failure An incident page sits unseen while its owner is parked in inbox-wait, or a watcher re-asserting the same
 *          condition every tick wakes its owner every tick.
 * @level l1
 * @consumer 25662 bridge-lost paging, and every incident emitter (vault-db-page, sysmon rows, cas-refused)
 * @testonly none
 *
 * An incident wakes its idle owner (25662 P3 3, @cto 5bae7b68 and 66284cb6).
 *
 * inbox-wait used to wake on request, query, verdict and assign only, so a page sent as an incident reached an idle
 * owner at their next turn, 15 to 30 minutes later on a parked seat. The wake fires on an incident's OPEN edge and on
 * an upsert whose SUMMARY (the condition) changed. A repeat whose body carries a new observation, and the clear, never
 * wake. The edge is a durable fact on the message row, so the live insert path and the SQL path a wait reads at start
 * or after a CLI reconnect agree.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createTribeContext, type TribeContext } from "./lib/context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./lib/database.ts"
import { handleToolCall, readAttentionProjection, type HandlerOpts } from "./lib/handlers.ts"
import { createInboxWaitManager, type InboxStatus } from "./lib/inbox-wait.ts"
import { sendMessage } from "./lib/messaging.ts"

const OWNER = "@chief"
const INCIDENT = { emitter: "tribe-health", subject: "@dev/3", condition: "bridge-lost" }
const QUIET_MS = 150

let dir: string
let db: ReturnType<typeof openDatabase>
let stmts: TribeStatements

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tribe-incident-wake-"))
  db = openDatabase(join(dir, "tribe.db"))
  stmts = createStatements(db)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function latestWakeSeq(session: string, unacknowledgedOnly: boolean): number {
  const row = stmts.getLatestInboxWaitMessage.get({
    $name: session,
    $include_correlated_replies: 0,
    $unacknowledged_only: unacknowledgedOnly ? 1 : 0,
  }) as { rowid: number } | undefined
  return row?.rowid ?? 0
}

function context(sessionId: string, name: string, onMessageInserted?: TribeContext["onMessageInserted"]) {
  return createTribeContext({
    db,
    stmts,
    sessionId,
    sessionRole: "member",
    initialName: name,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
    onMessageInserted,
  })
}

function rig() {
  const reader = context("attention-reader", "@attention-reader")
  const status = (session: string): InboxStatus => ({
    session,
    unread_count: 0,
    oldest_unread_age_min: 0,
    oldest_unread_ts: 0,
  })
  const manager = createInboxWaitManager(
    status,
    (session) => readAttentionProjection(reader, session).attention,
    (session) => latestWakeSeq(session, false),
    (session) => latestWakeSeq(session, true),
  )
  const watcher = context("daemon", "daemon", manager.onMessageInserted)
  const peer = context("peer", "@cto", manager.onMessageInserted)
  const owner = context("owner", OWNER, manager.onMessageInserted)
  const page = (summary: string, body: string, active = true) =>
    sendMessage(
      watcher,
      OWNER,
      body,
      "health:bridge-lost",
      undefined,
      undefined,
      "direct",
      { summary },
      { incident: { ...INCIDENT, active } },
    )
  return { manager, peer, owner, page }
}

const opts = (): HandlerOpts => ({
  cleanup: () => {},
  userRenamed: false,
  setUserRenamed: () => {},
  getActiveSessionIds: () => new Set<string>(),
  hasActiveTransport: () => false,
  getActiveSessionInfo: () => [],
})

describe("an incident wakes its idle owner", () => {
  test("the open edge wakes a parked owner, and the wake carries the condition in pending_balls", async () => {
    const { manager, page } = rig()
    const parked = manager.wait(OWNER, "conn-open", 5_000)
    page("@dev/3's tribe bridge is lost", "@dev/3's tribe bridge is lost 3 min")
    const woken = await parked
    expect(woken).toMatchObject({ status: "woken", timed_out: false })
    expect(woken.attention.pending_balls).toMatchObject([
      { request_kind: "incident", summary: "@dev/3's tribe bridge is lost" },
    ])
    // The attention doctrine holds: an incident is never recipient-actionable work.
    expect(woken.attention.actionable_unread).toEqual([])
  })

  test("a repeat whose body carries a new observation does not wake; a changed summary does", async () => {
    const { manager, page } = rig()
    page("@dev/3's tribe bridge is lost", "lost 3 min")
    const baseline = latestWakeSeq(OWNER, false)

    const repeat = manager.wait(OWNER, "conn-repeat", QUIET_MS, { afterSeq: baseline })
    page("@dev/3's tribe bridge is lost", "lost 4 min")
    await expect(repeat).resolves.toMatchObject({ status: "timeout" })

    const changed = manager.wait(OWNER, "conn-changed", 5_000, { afterSeq: latestWakeSeq(OWNER, false) })
    page("@dev/3 still lost: membership reads it foreign-identity-transport", "refused reconnect")
    await expect(changed).resolves.toMatchObject({ status: "woken" })
  })

  test("the clear settles the ball and never wakes", async () => {
    const { manager, page } = rig()
    page("@dev/3's tribe bridge is lost", "lost 3 min")
    const cleared = manager.wait(OWNER, "conn-clear", QUIET_MS, { afterSeq: latestWakeSeq(OWNER, false) })
    page("@dev/3's tribe bridge is lost", "cleared: @dev/3's transport is live again", false)
    await expect(cleared).resolves.toMatchObject({ status: "timeout" })
  })

  test("a request still wakes, as before", async () => {
    const { manager, peer } = rig()
    const parked = manager.wait(OWNER, "conn-request", 5_000)
    sendMessage(peer, OWNER, "please look", "request")
    await expect(parked).resolves.toMatchObject({ status: "woken" })
  })

  test("a wait that re-arms after the open (a CLI reconnect with an older baseline) wakes at once", async () => {
    const { manager, page } = rig()
    const baseline = latestWakeSeq(OWNER, false)
    page("@dev/3's tribe bridge is lost", "lost 3 min")
    await expect(manager.wait(OWNER, "conn-rearm", 5_000, { afterSeq: baseline })).resolves.toMatchObject({
      status: "woken",
      waited_ms: 0,
    })
  })

  test("an archived edge stays an edge (the v27 attention_required lesson: an explicit column list drops what it omits)", () => {
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000
    stmts.insertMessage.run({
      $id: "edge-old",
      $type: "health:bridge-lost",
      $sender: "daemon",
      $recipient: OWNER,
      $kind: "direct",
      $content: "lost 3 min",
      $bead_id: null,
      $ref: null,
      $ts: old,
      $delivery: "push",
      $topic: null,
      $room_id: null,
      $request: null,
      $reply: null,
      $wakes_owner: 1,
    })
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    stmts.archiveExpiredMessages.run({ $cutoff: cutoff, $archived_at: Date.now() })
    expect(db.prepare("SELECT wakes_owner FROM messages_archive WHERE id = 'edge-old'").get()).toEqual({
      wakes_owner: 1,
    })
  })

  test("a fresh wait wakes once for an unread edge, and not again after the owner's fetch returned it", async () => {
    const { manager, owner, page } = rig()
    page("@dev/3's tribe bridge is lost", "lost 3 min")
    await expect(manager.wait(OWNER, "conn-fresh", 5_000)).resolves.toMatchObject({ status: "woken" })

    handleToolCall(owner, "tribe.fetch", { limit: 10 }, opts())
    await expect(manager.wait(OWNER, "conn-after-fetch", QUIET_MS)).resolves.toMatchObject({ status: "timeout" })
  })
})
