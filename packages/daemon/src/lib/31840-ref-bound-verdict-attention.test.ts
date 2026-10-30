/**
 * @failure A direct verdict that carries a ref naming the recipient's open ball
 *   but no reply is neither counted in actionable_unread nor a wake, so a
 *   verdict lands silently and the waiter times out beside an unread_count of
 *   zero (@dev/2, 2026-10-29 20:14 PDT; the content was recovered only by an
 *   explicit fetch --ids after the sender said it existed).
 * @level l2 — real statements, the real attention projection and the real wait manager.
 * @consumer @km/tribe/31840-a-verdict-carrying-ref-but-no
 * @testonly none
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, readAttentionProjection, TRIBE_COORD_METHODS, type HandlerOpts } from "./handlers.ts"
import { createInboxWaitManager, type InboxStatus } from "./inbox-wait.ts"
import { sendMessage } from "./messaging.ts"

const REQUESTER = "@requester"
const PEER = "@responder"
const OTHER = "@third-party"
const BALL = "req-31840"

type Fixture = {
  dir: string
  db: ReturnType<typeof openDatabase>
  stmts: TribeStatements
  requester: TribeContext
  peer: TribeContext
  other: TribeContext
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

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tribe-31840-"))
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
    (session) =>
      readAttentionProjection(reader, session, Date.now(), 0, makeOpts()).attention.actionable_unread.at(-1)?.rowid ??
      0,
    (session) =>
      readAttentionProjection(reader, session, Date.now(), 0, makeOpts()).attention.actionable_unread.at(-1)?.rowid ??
      0,
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
  const built = {
    dir,
    db,
    stmts,
    requester: mk("requester", REQUESTER),
    peer: mk("peer", PEER),
    other: mk("other", OTHER),
    manager,
  }
  opened.push(built)
  return built
}

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.db.close()
    rmSync(item.dir, { recursive: true, force: true })
  }
})

/** @requester opens the ball; the peer answers with a verdict that carries the
 *  ref and NO reply, which is the shape @dev/2 lost. */
function openBallAndVerdict(f: Fixture) {
  const ball = sendMessage(
    f.requester,
    PEER,
    "please answer",
    "request",
    undefined,
    undefined,
    "direct",
    {},
    {
      request: BALL,
    },
  )
  const row = sendMessage(f.peer, REQUESTER, "verdict on your ball", "verdict", undefined, BALL)
  return { ball, row }
}

describe("31840 a ref-bound verdict with no reply is attention and wakes", () => {
  it("counts the verdict as unread attention for the requester", () => {
    const f = fixture()
    const { row } = openBallAndVerdict(f)
    const attention = readAttentionProjection(f.requester, REQUESTER, Date.now(), 0, makeOpts()).attention
    expect(attention.actionable_unread.map((r) => r.id)).toContain(row.id)
  })

  it("wakes a wait that is already parked when the ref-only verdict arrives", async () => {
    const f = fixture()
    const ball = sendMessage(
      f.requester,
      PEER,
      "please answer",
      "request",
      undefined,
      undefined,
      "direct",
      {},
      {
        request: BALL,
      },
    )
    expect(ball.id).toBeTruthy()
    const parked = f.manager.wait(REQUESTER, "conn-verdict", 3_000, {})
    await new Promise((resolve) => setTimeout(resolve, 50))
    sendMessage(f.peer, REQUESTER, "verdict on your ball", "verdict", undefined, BALL)
    const woken = await parked
    expect(woken.status).toBe("woken")
  })
})

describe("31840 second reproduction attempt: the cursor move a drain performs", () => {
  it("shows whether an acknowledged drain retires a verdict the model never saw", () => {
    const f = fixture()
    const { row } = openBallAndVerdict(f)
    // Exactly what cli_inbox_drain does after it hands rows to a live caller:
    // readUnackedAttentionRows(...) then advanceMailboxCursor to the last row.
    const before = readAttentionProjection(f.requester, REQUESTER, Date.now(), 0, makeOpts()).attention
    expect(before.actionable_unread.map((r) => r.id)).toContain(row.id)
    f.stmts.advanceMailboxCursor.run({ $recipient: REQUESTER, $seq: row.rowid, $now: Date.now() })
    const after = readAttentionProjection(f.requester, REQUESTER, Date.now(), 0, makeOpts()).attention
    // Documents the current behaviour rather than asserting a wish: once a drain
    // acknowledges the row, the VERDICT BODY IS GONE from the model-facing count
    // and from every later wake, even though no model read ever returned it.
    expect(after.actionable_unread.map((r) => r.id)).not.toContain(row.id)
  })
})

describe("31840 self path: a narrowed read must not acknowledge what it did not return", () => {
  it.each(["health:cpu", "HeAlTh:cpu", "bead:changed"])(
    "drains past a trust-rejected direct on %s without replaying eligible verdicts",
    async (topic) => {
      const f = fixture()
      f.stmts.insertMessage.run({
        $id: "trust-rejected",
        $type: "verdict",
        $sender: "@unrostered",
        $recipient: REQUESTER,
        $kind: "direct",
        $content: "untrusted direct",
        $bead_id: null,
        $ref: null,
        $ts: Date.now(),
        $delivery: "pull",
        $topic: topic,
        $room_id: null,
        $request: null,
        $reply: null,
      })
      const seen = sendMessage(f.peer, REQUESTER, "eligible verdict", "verdict")
      expect(seen.rowid).toBe(2)
      for (let drain = 0; drain < 6; drain += 1) {
        const result = await handleToolCall(f.requester, TRIBE_COORD_METHODS.fetch, { limit: 1 }, makeOpts())
        const body = JSON.parse((result.content[0] as { text: string }).text) as {
          attention: { actionable_unread: Array<{ id: string }> }
          events: Array<{ id: string }>
        }
        const returned = [...body.attention.actionable_unread, ...body.events].map((row) => row.id)
        expect(returned).not.toContain("trust-rejected")
        expect(returned).toEqual(drain === 0 ? [seen.id] : [])
      }
      expect(f.stmts.getMailboxCursor.get({ $recipient: REQUESTER })).toMatchObject({ last_actionable_seq: 2 })
    },
  )

  it("keeps an unread direct that a --from-narrowed since+advance page never returned", async () => {
    const f = fixture()
    // Two unread directs for the reader from different senders. The reader asks
    // for one peer's traffic only, which is the ordinary way a seat reads a
    // thread back.
    // Untracked attention on purpose: a `request` owns a ball, and the tracked
    // branch of selectAttention keeps an untaken ball visible past the cursor,
    // which would hide the defect behind a second mechanism. A verdict with no
    // request is exactly the shape @dev/2 lost.
    const unseen = sendMessage(f.other, REQUESTER, "verdict from the other peer", "verdict")
    const seen = sendMessage(f.peer, REQUESTER, "verdict for you", "verdict")
    expect(unseen.rowid).toBeLessThan(seen.rowid)

    const page = await handleToolCall(
      f.requester,
      TRIBE_COORD_METHODS.fetch,
      { since: unseen.rowid - 1, from: PEER, advance: true },
      makeOpts(),
    )
    const body = JSON.parse((page.content[0] as { text: string }).text) as {
      attention: unknown
      events: Array<{ id: string }>
    }
    // The page really was narrowed: it returned the peer row and not the other one.
    expect(body.events.map((row) => row.id)).toContain(seen.id)
    expect(body.events.map((row) => row.id)).not.toContain(unseen.id)

    // The row the page never returned must still be the reader's unread attention.
    const after = readAttentionProjection(f.requester, REQUESTER, Date.now(), 0, makeOpts()).attention
    expect(after.actionable_unread.map((row) => row.id)).toContain(unseen.id)

    // And the acknowledgement must not have jumped over it: the cursor is a
    // high-water mark, so any move past the skipped row retires it for good.
    const cursor = f.stmts.getMailboxCursor.get({ $recipient: REQUESTER }) as {
      last_actionable_seq: number
    } | null
    expect(cursor === null || cursor.last_actionable_seq < unseen.rowid).toBe(true)

    // A full drain WITHOUT the narrowing does acknowledge both: the fix holds
    // the cursor at the skipped row, it does not wedge the mailbox there.
    await handleToolCall(f.requester, TRIBE_COORD_METHODS.fetch, { advance: true }, makeOpts())
    const acknowledged = f.stmts.getMailboxCursor.get({ $recipient: REQUESTER }) as { last_actionable_seq: number }
    expect(acknowledged.last_actionable_seq).toBe(seen.rowid)
    const drained = readAttentionProjection(f.requester, REQUESTER, Date.now(), 0, makeOpts()).attention
    expect(drained.actionable_unread.map((row) => row.id)).toEqual([])
  })
})
