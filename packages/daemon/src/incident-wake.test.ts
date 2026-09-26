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
import { createInboxWaitManager, readInboxWaitWokenBy, type InboxStatus } from "./lib/inbox-wait.ts"
import { sendMessage } from "./lib/messaging.ts"
import { registerSession } from "./lib/session.ts"

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
    (session, seq, wakeOnCorrelatedReply) => readInboxWaitWokenBy(stmts, session, seq, wakeOnCorrelatedReply),
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
  return { manager, watcher, peer, owner, page }
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

  test("a relay read with receipt:false leaves the edge unread; the owner's own read acknowledges it, and a fresh wait sleeps (25662 P4)", async () => {
    // review-adhoc5's RELAY-2 probe (probes/25662w/zz-adhoc5-relay.test.ts), kept as a row. A registered owner, so the
    // relay read moves the ambient cursor past the edge; only the owner's own read may acknowledge it.
    const active = new Set<string>()
    const regOpts: HandlerOpts = {
      ...opts(),
      getActiveSessionIds: () => active,
      hasActiveTransport: (id) => active.has(id),
    }
    const { manager, page } = rig()
    const ownerCtx = context("sess-owner", "boot-sess-owner", manager.onMessageInserted)
    active.add("sess-owner")
    handleToolCall(ownerCtx, "tribe.join", { name: OWNER, delivery: "pull" }, regOpts)
    registerSession(ownerCtx, undefined, regOpts.hasActiveTransport, null, 0, "pull", undefined, null, null, null, null)
    // A readable mailbox: the sid its verified identity token recorded on the row (25074 3d-3).
    db.prepare("UPDATE sessions SET identity_sid = ?, identity_gen = 1 WHERE id = ?").run(
      `sid-${ownerCtx.sessionId}`,
      ownerCtx.sessionId,
    )
    const sent = page("@dev/3's tribe bridge is lost", "lost 3 min")
    const read = (args: Record<string, unknown>) =>
      JSON.parse(
        (
          handleToolCall(ownerCtx, "tribe.fetch", { limit: 10, ...args }, regOpts) as {
            content: Array<{ text: string }>
          }
        ).content[0]?.text ?? "{}",
      ) as { events?: Array<{ id: string }> }
    const ambientCursor = () =>
      (
        db.prepare("SELECT last_inbox_pull_seq AS c FROM sessions WHERE id = 'sess-owner'").get() as {
          c: number
        } | null
      )?.c

    read({ receipt: false })
    expect(ambientCursor()).toBeGreaterThanOrEqual(sent.rowid)
    expect(latestWakeSeq(OWNER, true)).toBe(sent.rowid)

    const own = read({})
    expect((own.events ?? []).map((e) => e.id)).toContain(sent.id)
    expect(latestWakeSeq(OWNER, true)).toBe(0)
    await expect(manager.wait(OWNER, "conn-relay", QUIET_MS)).resolves.toMatchObject({ status: "timeout" })
  })
  test("a woken result names the edge that woke it, even behind 12 older incidents the preview shows first (25662 row 17)", async () => {
    const { manager, watcher } = rig()
    const pageSubject = (subject: string) =>
      sendMessage(
        watcher,
        OWNER,
        `${subject}'s tribe bridge is lost (body)`,
        "health:bridge-lost",
        undefined,
        undefined,
        "direct",
        { summary: `${subject}'s tribe bridge is lost` },
        { incident: { ...INCIDENT, subject } },
      )
    for (let n = 1; n <= 12; n++) pageSubject(`@dev/${n}`)
    // The preview sorts by opened_at, then request_id: pages sent in one millisecond would order "@dev/13" before
    // "@dev/2". The 12 are a minute older, as they would be live.
    db.prepare("UPDATE pending_request SET opened_at = opened_at - 60000 WHERE recipient = ?").run(OWNER)
    const parked = manager.wait(OWNER, "conn-edge", 5_000, { afterSeq: latestWakeSeq(OWNER, false) })
    const edge = pageSubject("@dev/13")
    const woken = await parked
    const request = db.prepare("SELECT request FROM messages WHERE id = ?").get(edge.id) as { request: string }
    // The preview is the 10 oldest balls, so the edge that woke the owner is not in it.
    expect(woken.attention.pending_balls).toHaveLength(10)
    expect(woken.attention.pending_balls.map((ball) => ball.summary)).not.toContain("@dev/13's tribe bridge is lost")
    expect(woken.woken_by).toEqual({
      kind: "message",
      seq: edge.rowid,
      message_id: edge.id,
      type: "health:bridge-lost",
      sender: "daemon",
      summary: "@dev/13's tribe bridge is lost",
      request_id: request.request,
      settles_request_id: null,
    })
    // A fresh wait that wakes at once, on the SQL path, names the newest unread edge the same way.
    const fresh = await manager.wait(OWNER, "conn-edge-fresh", 5_000)
    expect(fresh.woken_by).toMatchObject({ kind: "message", message_id: edge.id })
  })

  test("a correlated reply names the request it settled and the reply (25662 row 17)", async () => {
    const { manager, peer, owner } = rig()
    const asked = sendMessage(
      owner,
      "@cto",
      "please rule",
      "request",
      undefined,
      undefined,
      "direct",
      {},
      { request: true },
    )
    const parked = manager.wait(OWNER, "conn-reply", 5_000, { wakeOnCorrelatedReply: true })
    const answer = sendMessage(
      peer,
      OWNER,
      "ruled",
      "response",
      undefined,
      undefined,
      "direct",
      { summary: "ruled" },
      { reply: asked.id },
    )
    await expect(parked).resolves.toMatchObject({
      status: "woken",
      woken_by: {
        kind: "message",
        message_id: answer.id,
        sender: "@cto",
        type: "response",
        settles_request_id: asked.id,
      },
    })
  })
  test("an incident with no summary takes its identity as its summary: a body that changes every send wakes once, still upserts, and the clear delivers (25662 row 18A)", async () => {
    const { manager, watcher } = rig()
    const send = (message: string, active = true) =>
      handleToolCall(
        watcher,
        "tribe.send",
        { to: OWNER, message, type: "notify", incident: { ...INCIDENT, active } },
        opts(),
      )
    const opened = manager.wait(OWNER, "conn-18a-open", 5_000, { afterSeq: latestWakeSeq(OWNER, false) })
    send("3 balls stale for 12 min")
    await expect(opened).resolves.toMatchObject({
      status: "woken",
      woken_by: { summary: "tribe-health · @dev/3 · bridge-lost" },
    })

    const repeat = manager.wait(OWNER, "conn-18a-repeat", QUIET_MS, { afterSeq: latestWakeSeq(OWNER, false) })
    send("4 balls stale for 19 min")
    await expect(repeat).resolves.toMatchObject({ status: "timeout" })
    // The repeat still upserted: the ball now points at the newest observation, which fetch returns.
    expect(
      db
        .prepare(
          `SELECT m.content, m.summary FROM pending_request AS p JOIN messages AS m ON m.id = p.message_id
           WHERE p.recipient = ? AND p.request_kind = 'incident'`,
        )
        .get(OWNER),
    ).toEqual({ content: "4 balls stale for 19 min", summary: "tribe-health · @dev/3 · bridge-lost" })

    send("cleared: the bridge is back", false)
    expect(
      db.prepare("SELECT content, kind FROM messages WHERE recipient = ? ORDER BY rowid DESC LIMIT 1").get(OWNER),
    ).toEqual({ content: "cleared: the bridge is back", kind: "direct" })
    expect(
      db
        .prepare("SELECT COUNT(*) AS open FROM pending_request WHERE recipient = ? AND request_kind = 'incident'")
        .get(OWNER),
    ).toEqual({ open: 0 })
  })
})
