/**
 * @failure A direct type=notify sent with request tracking opens a ball the
 *   recipient owns, but inbox-wait never woke on it and the default attention
 *   read did not show it: every wake/attention arm filtered by message type,
 *   and the insert path only reported newly opened owners for broadcasts.
 *   The recipient sat on an owed ball it could not see (@dev/review2 aac25f7f,
 *   measured 2026-10-18).
 * @level l2 — real statements + the real wait manager + the real wake tail.
 * @consumer @i/21-wire/30029-tracked-notify-ball-does-not-wake-inbox-wait
 * @testonly none
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { readAttentionProjection, type HandlerOpts } from "./handlers.ts"
import { createInboxWaitManager, type InboxStatus } from "./inbox-wait.ts"
import { sendMessage } from "./messaging.ts"

const WAITER = "@waiter"
const PEER = "@sender"
const BALL = "req-30029"

type Fixture = {
  dir: string
  db: ReturnType<typeof openDatabase>
  stmts: TribeStatements
  waiter: TribeContext
  peer: TribeContext
  manager: ReturnType<typeof createInboxWaitManager>
}
const opened: Fixture[] = []

function makeOpts(): HandlerOpts {
  return {
    cleanup: () => {},
    userRenamed: false,
    setUserRenamed: () => {},
    getActiveSessionIds: () => new Set<string>(),
    hasActiveTransport: () => false,
    getActiveSessionInfo: () => [],
    inboxWait: undefined,
  }
}

function tailSeq(stmts: TribeStatements, session: string, correlated: boolean): number {
  const direct = stmts.getLatestInboxWaitMessage.get({
    $name: session,
    $include_correlated_replies: correlated ? 1 : 0,
    $unacknowledged_only: 0,
  }) as { rowid: number } | null
  const tracked = stmts.getLatestTrackedInboxWaitMessage.get({ $name: session }) as { rowid: number } | null
  return Math.max(direct?.rowid ?? 0, tracked?.rowid ?? 0)
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tribe-30029-"))
  const db = openDatabase(join(dir, "tribe.db"))
  const stmts = createStatements(db)
  const status = (session: string): InboxStatus => ({
    session,
    unread_count: 0,
    oldest_unread_age_min: 0,
    oldest_unread_ts: 0,
  })
  const reader = createTribeContext({
    db,
    stmts,
    sessionId: "attention-reader",
    sessionRole: "member",
    initialName: "@attention-reader",
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
  const manager = createInboxWaitManager(
    status,
    (session) => readAttentionProjection(reader, session, Date.now(), 0, makeOpts()).attention,
    (session, correlated) => tailSeq(stmts, session, correlated),
    (session, correlated) => tailSeq(stmts, session, correlated),
  )
  const mk = (id: string, name: string) =>
    createTribeContext({
      db,
      stmts,
      sessionId: id,
      sessionRole: "member",
      initialName: name,
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
      onMessageInserted: (info) => manager.onMessageInserted(info),
    })
  const built = { dir, db, stmts, waiter: mk("waiter", WAITER), peer: mk("peer", PEER), manager }
  opened.push(built)
  return built
}

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.db.close()
    rmSync(item.dir, { recursive: true, force: true })
  }
})

function rowidOf(f: Fixture, id: string): number {
  return (f.db.prepare("SELECT rowid FROM messages WHERE id = ?").get(id) as { rowid: number }).rowid
}

/** A direct tracked notify from the peer: opens a ball the WAITER owns. */
function trackedNotify(f: Fixture) {
  return sendMessage(
    f.peer,
    WAITER,
    "a tracked notify",
    "notify",
    undefined,
    undefined,
    "direct",
    {},
    { request: BALL },
  )
}

describe("30029 a tracked notify that opens a ball wakes its owner", () => {
  it("wakes a wait that is already parked, with no correlated-reply opt-in", async () => {
    const f = fixture()
    const parked = f.manager.wait(WAITER, "conn-parked", 2_000, { wakeOnCorrelatedReply: false })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const row = trackedNotify(f)

    const pending = f.db.prepare("SELECT recipient FROM pending_request WHERE request_id = ?").get(BALL) as {
      recipient: string
    } | null
    expect(pending?.recipient).toBe(WAITER)

    const woken = await parked
    expect(woken.status).toBe("woken")
    expect(woken.attention.actionable_unread.map((r) => r.id)).toContain(row.id)
  })

  it("is in the wake tail and the default attention read when the row lands first", async () => {
    const f = fixture()
    const row = trackedNotify(f)

    expect(tailSeq(f.stmts, WAITER, false)).toBe(rowidOf(f, row.id))
    const attention = readAttentionProjection(f.waiter, WAITER, Date.now(), 0, makeOpts()).attention
    expect(attention.actionable_unread.map((r) => r.id)).toContain(row.id)

    const woken = await f.manager.wait(WAITER, "conn-after", 2_000, { wakeOnCorrelatedReply: false })
    expect(woken.status).toBe("woken")
    expect(woken.attention.actionable_unread.map((r) => r.id)).toContain(row.id)
  })

  it("stays quiet on a plain untracked notify: no ball, no attention, no wake", async () => {
    const f = fixture()
    const parked = f.manager.wait(WAITER, "conn-plain", 400, { wakeOnCorrelatedReply: false })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const row = sendMessage(f.peer, WAITER, "a plain notify", "notify")

    expect((await parked).status).toBe("timeout")
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM pending_request").get()).toEqual({ n: 0 })
    const attention = readAttentionProjection(f.waiter, WAITER, Date.now(), 0, makeOpts()).attention
    expect(attention.actionable_unread.map((r) => r.id)).not.toContain(row.id)
    expect(tailSeq(f.stmts, WAITER, false)).not.toBe(rowidOf(f, row.id))
  })
})
