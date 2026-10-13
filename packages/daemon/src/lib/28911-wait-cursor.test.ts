/**
 * @failure inbox-wait --wake-on-correlated-reply re-fires on a row already
 *   delivered and handled: a settled wait chunk returns its STARTING
 *   baseline_seq, so the CLI's resumed chunk (afterSeq = that baseline)
 *   re-derives latest > baseline and wakes again on the same row — even
 *   after the seat read it and the mailbox cursor advanced past it; a
 *   timed-out chunk likewise resumes from a baseline that predates rows its
 *   own snapshot delivered (28911, retro F-25: luna3 looped, dsh1 replayed
 *   after timeout).
 * @level l2 — real statements + real fetch ack path + real wait manager.
 * @consumer @ag/tribe/28911; createInboxWaitManager chunk baseline contract.
 * @testonly none
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { messagingTools } from "./compose/messaging-tools.ts"
import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { readAttentionProjection, type HandlerOpts } from "./handlers.ts"
import { createInboxWaitManager, type InboxStatus } from "./inbox-wait.ts"
import { sendMessage } from "./messaging.ts"

const SEAT = "@requester"
const PEER = "@responder"

type Fixture = {
  dir: string
  db: ReturnType<typeof openDatabase>
  stmts: TribeStatements
  seat: TribeContext
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

function latestSeq(stmts: TribeStatements, session: string, correlated: boolean, unackOnly: boolean): number {
  const direct = stmts.getLatestInboxWaitMessage.get({
    $name: session,
    $include_correlated_replies: correlated ? 1 : 0,
    $unacknowledged_only: unackOnly ? 1 : 0,
  }) as { rowid: number } | null
  const tracked = stmts.getLatestTrackedInboxWaitMessage.get({ $name: session }) as { rowid: number } | null
  return Math.max(direct?.rowid ?? 0, tracked?.rowid ?? 0)
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tribe-28911-"))
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
    (session, correlated) => latestSeq(stmts, session, correlated, false),
    (session, correlated) => latestSeq(stmts, session, correlated, true),
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
      onMessageInserted: manager.onMessageInserted,
    })
  const built = { dir, db, stmts, seat: mk("seat", SEAT), peer: mk("peer", PEER), manager }
  opened.push(built)
  return built
}

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.db.close()
    rmSync(item.dir, { recursive: true, force: true })
  }
})

function openRequest(f: Fixture): void {
  sendMessage(f.seat, PEER, "please answer", "request", undefined, undefined, "direct", {}, { request: "req-28911" })
}

function correlatedResponse(f: Fixture): number {
  const sent = sendMessage(
    f.peer,
    SEAT,
    "the answer",
    "response",
    undefined,
    undefined,
    "direct",
    {},
    { reply: "req-28911" },
  )
  const row = f.db.prepare("SELECT rowid FROM messages WHERE id = ?").get(sent.id) as { rowid: number }
  return row.rowid
}

async function fetchAsSeat(f: Fixture): Promise<void> {
  const tool = messagingTools().find((candidate) => candidate.name === "tribe.fetch")
  if (!tool) throw new Error("tribe.fetch registry tool is missing")
  await tool.handler({}, { connId: "conn-seat", extra: { ctx: f.seat, opts: makeOpts() } })
}

describe("28911 a settled chunk's baseline covers what it delivered", () => {
  it("does not wake the resumed chunk on a correlated reply the seat already read (cursor advanced)", async () => {
    const f = fixture()
    openRequest(f)

    // Chunk 1 starts before the reply exists and is woken live by its insert.
    const firstPromise = f.manager.wait(SEAT, "conn-1", 5_000, { wakeOnCorrelatedReply: true, consumesMailbox: true })
    const seq = correlatedResponse(f)
    const first = await firstPromise
    expect(first.status).toBe("woken")

    // The seat handles it: a receipt fetch advances the mailbox cursor past it.
    await fetchAsSeat(f)
    const cursor = f.stmts.getMailboxCursor.get({ $recipient: SEAT }) as { last_actionable_seq: number } | null
    expect(cursor?.last_actionable_seq ?? 0).toBeGreaterThanOrEqual(seq)

    // The resumed chunk (CLI afterSeq = returned baseline) must not re-fire.
    const second = await f.manager.wait(SEAT, "conn-2", 0, {
      wakeOnCorrelatedReply: true,
      consumesMailbox: true,
      afterSeq: first.baseline_seq,
    })
    expect(second.status).toBe("timeout")
    expect(second.woken_by).toBeUndefined()
  })

  it("advances the returned baseline past a row delivered by a woken chunk, fetch or not", async () => {
    const f = fixture()
    openRequest(f)

    const firstPromise = f.manager.wait(SEAT, "conn-1", 5_000, { wakeOnCorrelatedReply: true, consumesMailbox: true })
    const seq = correlatedResponse(f)
    const first = await firstPromise
    expect(first.status).toBe("woken")
    expect(first.baseline_seq).toBeGreaterThanOrEqual(seq)

    const second = await f.manager.wait(SEAT, "conn-2", 0, {
      wakeOnCorrelatedReply: true,
      consumesMailbox: true,
      afterSeq: first.baseline_seq,
    })
    expect(second.status).toBe("timeout")
    expect(second.woken_by).toBeUndefined()
  })

  it("advances the returned baseline past rows a timed-out chunk's snapshot delivered", async () => {
    const f = fixture()
    openRequest(f)
    const seq = correlatedResponse(f)

    // A non-correlated wait times out (0ms) with the row already in its
    // snapshot; resuming the logical wait must not replay it as a wake.
    const first = await f.manager.wait(SEAT, "conn-1", 0, { consumesMailbox: true })
    expect(first.status).toBe("timeout")
    expect(first.baseline_seq).toBeGreaterThanOrEqual(seq)

    const second = await f.manager.wait(SEAT, "conn-2", 0, {
      wakeOnCorrelatedReply: true,
      consumesMailbox: true,
      afterSeq: first.baseline_seq,
    })
    expect(second.status).toBe("timeout")
    expect(second.woken_by).toBeUndefined()
  })
})
