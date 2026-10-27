/**
 * @failure A direct status whose ref names an open ball the waiter REQUESTED
 *   is durable attention (insertMessage's C2 classification) but could never
 *   wake that waiter's inbox-wait at any setting: the opt-in arm matched only
 *   `correlated_reply_requester`, a column a structured `reply` sets and a
 *   ref-only TAKING/progress status leaves NULL. The wait slept to its
 *   timeout and then reported plain "timeout" beside unread_count 1 (@dev/7,
 *   2026-10-15 11:31 PDT).
 * @level l2 — real statements + the real wait manager + the real wake tail.
 * @consumer @i/21-wire/29535-tribe-inbox-wait-does-not-wake; @cto ruling
 *   2026-10-15 (option b narrowed to the requester side under the existing
 *   opt-in; attention stays wider than waking by design, 27735).
 * @testonly none
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { assertSingleStatement } from "@bearly/sqlite"
import { afterEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { shouldDeliver } from "./compose/with-broadcast.ts"
import { settlesRequestOpenedBy, type MessageInsertedInfo } from "./context.ts"
import {
  createStatements,
  openDatabase,
  SELECT_CORRELATED_REQUEST_FOR_RESPONSE_SQL,
  type TribeStatements,
} from "./database.ts"
import { readAttentionProjection, type HandlerOpts } from "./handlers.ts"
import { createInboxWaitManager, readInboxWaitWokenBy, type InboxStatus } from "./inbox-wait.ts"
import { sendMessage } from "./messaging.ts"

const REQUESTER = "@requester"
const PEER = "@responder"
const BALL = "req-29535"

type Fixture = {
  dir: string
  db: ReturnType<typeof openDatabase>
  stmts: TribeStatements
  requester: TribeContext
  peer: TribeContext
  /** A session whose name carries no sigil: the classifier calls its rows ambient. */
  relay: TribeContext
  manager: ReturnType<typeof createInboxWaitManager>
  /** Every info the insert path handed the manager, so a test can ask of the same
   *  object the questions its OTHER consumers ask (focus-mode push). */
  inserted: MessageInsertedInfo[]
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

/** The real wake tail, exactly as the manager reads it. */
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
  const dir = mkdtempSync(join(tmpdir(), "tribe-29535-"))
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
  const inserted: MessageInsertedInfo[] = []
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
      onMessageInserted: (info) => {
        inserted.push(info)
        manager.onMessageInserted(info)
      },
    })
  const built = {
    dir,
    db,
    stmts,
    requester: mk("requester", REQUESTER),
    peer: mk("peer", PEER),
    relay: mk("relay-session", "relay"),
    manager,
    inserted,
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

function rowidOf(f: Fixture, id: string): number {
  return (f.db.prepare("SELECT rowid FROM messages WHERE id = ?").get(id) as { rowid: number }).rowid
}

/** @requester opens the ball; `sender` writes a row back referencing it. */
function openBallAndReply(
  f: Fixture,
  type: "status" | "notify" | "response",
  sender: TribeContext = f.peer,
  to: string = REQUESTER,
): { ball: ReturnType<typeof sendMessage>; row: ReturnType<typeof sendMessage> } {
  const ball = sendMessage(
    f.requester,
    PEER,
    "please answer",
    "request",
    undefined,
    undefined,
    "direct",
    {},
    { request: BALL },
  )
  const row = sendMessage(sender, to, "a receipt on your ball", type, undefined, BALL)
  return { ball, row }
}

describe("29535 a ref-bound status wakes only its requester, and only under the flag", () => {
  it("wakes on the flag and stays quiet without it — one test, both sides of the switch", async () => {
    const f = fixture()
    const { row } = openBallAndReply(f, "status")
    const rowid = rowidOf(f, row.id)

    // The row IS attention — that was never the bug.
    const attention = readAttentionProjection(f.requester, REQUESTER, Date.now(), 0, makeOpts()).attention
    expect(attention.actionable_unread.map((r) => r.id)).toContain(row.id)

    // Flag on: the ref-bound status is the qualifying tail itself, which is
    // the point — a ref-only status carries no correlated_reply_requester.
    expect(tailSeq(f.stmts, REQUESTER, true)).toBe(rowid)
    // Flag off: unchanged by design.
    expect(tailSeq(f.stmts, REQUESTER, false)).not.toBe(rowid)

    const woken = await f.manager.wait(REQUESTER, "conn-on", 2_000, { wakeOnCorrelatedReply: true })
    expect(woken.status).toBe("woken")
    expect(woken.attention.actionable_unread.map((r) => r.id)).toContain(row.id)

    const quiet = await f.manager.wait(REQUESTER, "conn-off", 400, { wakeOnCorrelatedReply: false })
    expect(quiet.status).toBe("timeout")
    // Acceptance 3, the daemon half: a terminal timeout carries the rows it
    // could not wake on, so a reader is never told "nothing arrived".
    expect(quiet.unread_count).toBeGreaterThan(0)
    expect(quiet.attention.actionable_unread.length).toBeGreaterThan(0)
  })

  // 29541: the same row, but the wait is ALREADY PARKED when it lands. The case
  // above starts its wait after the row exists, so it only ever reads the
  // wait-start snapshot the SQL tail feeds; a live `tribe inbox-wait` is parked
  // first and must be woken by the INSERT, which is the path the daemon drives
  // through onMessageInserted. The reported bug was this shape, not that one.
  it("wakes a wait that is already parked when the ref-bound status arrives — requester only", async () => {
    const f = fixture()
    sendMessage(f.requester, PEER, "please answer", "request", undefined, undefined, "direct", {}, { request: BALL })

    const parked = f.manager.wait(REQUESTER, "conn-parked", 2_000, { wakeOnCorrelatedReply: true })
    // Let the wait register before anything is inserted, so the wake can only
    // come from the insert-driven re-check.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const row = sendMessage(f.peer, REQUESTER, "a receipt arriving mid-wait", "status", undefined, BALL)

    const woken = await parked
    expect(woken.status).toBe("woken")
    expect(woken.attention.actionable_unread.map((r) => r.id)).toContain(row.id)

    // 29541 F3: the same parked path on the OWNER side stays quiet. The peer
    // requests the ball, so @requester is its OWNER, and the seat that requested
    // it (@responder) sends the precision into the parked wait's mailbox. The row
    // is attention for the owner, but the opt-in arm asks only the requester side.
    // The wait continues from the ball's own row (afterSeq), or the fresh-wait
    // shortcut would settle it on that actionable request row before anything in
    // this case is sent — a different wake, not the one under test.
    const owner = fixture()
    const ballRow = sendMessage(
      owner.peer,
      REQUESTER,
      "please answer",
      "request",
      undefined,
      undefined,
      "direct",
      {},
      { request: BALL },
    )
    const ownerParked = owner.manager.wait(REQUESTER, "conn-owner", 400, {
      wakeOnCorrelatedReply: true,
      afterSeq: rowidOf(owner, ballRow.id),
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const precision = sendMessage(owner.peer, REQUESTER, "a precision arriving mid-wait", "status", undefined, BALL)
    const quiet = await ownerParked
    // Still no LIVE wake on the owner side: the wait ran to its 400 ms deadline. 30414: that deadline is not
    // quiet, though — the precision is attention for the owner (C2, either party) and ARRIVED during the window,
    // so the deadline settles woken naming it instead of a plain timeout beside unread_count 1.
    expect(quiet.waited_ms).toBeGreaterThanOrEqual(390)
    expect(quiet.status).toBe("woken")
    expect(quiet.timed_out).toBe(false)
    expect(quiet.attention.actionable_unread.map((r) => r.id)).toContain(precision.id)
  })

  it("stays quiet on the owner side, on a notify, and on a closed ball", () => {
    // Owner side: the PEER opens the ball, so @requester is its OWNER, and the
    // ball's requester sends the precision INTO the waiter's mailbox. The row
    // is attention for the owner (C2 covers either party) but must not wake
    // it: the opt-in arm asks only the requester side. Flip side to "either"
    // in the wake arm and this assertion is the one that fails.
    const ownerCase = fixture()
    sendMessage(
      ownerCase.peer,
      REQUESTER,
      "please answer",
      "request",
      undefined,
      undefined,
      "direct",
      {},
      { request: BALL },
    )
    const precision = sendMessage(ownerCase.peer, REQUESTER, "a precision on your ball", "status", undefined, BALL)
    const ownerAttention = readAttentionProjection(ownerCase.requester, REQUESTER, Date.now(), 0, makeOpts()).attention
    expect(ownerAttention.actionable_unread.map((r) => r.id)).toContain(precision.id)
    expect(tailSeq(ownerCase.stmts, REQUESTER, true)).not.toBe(rowidOf(ownerCase, precision.id))

    // A notify with the same ref is attention but never a wake: the arm is
    // limited to the correlated reply types.
    const notifyCase = fixture()
    const { row: notifyRow } = openBallAndReply(notifyCase, "notify")
    expect(tailSeq(notifyCase.stmts, REQUESTER, true)).not.toBe(rowidOf(notifyCase, notifyRow.id))

    // A closed ball's ref no longer names anything pending. Closure is
    // simulated by deleting the pending_request row — exactly what closure
    // does — and deliberately WITHOUT adding a row to the waiter's mailbox,
    // so a settling reply cannot move the newest-row tail and mask this.
    const closedCase = fixture()
    const { row: statusRow } = openBallAndReply(closedCase, "status")
    const statusRowid = rowidOf(closedCase, statusRow.id)
    expect(tailSeq(closedCase.stmts, REQUESTER, true)).toBe(statusRowid)
    closedCase.db.prepare("DELETE FROM pending_request WHERE request_id = ?").run(BALL)
    expect(tailSeq(closedCase.stmts, REQUESTER, true)).toBe(0)
  })

  // 29541 F1: the ref-bound arm belongs to inbox-wait's OPT-IN alone. Focus-mode
  // push decides by settlesRequestOpenedBy, so widening that shared question
  // would have woken a focus-mode seat on every TAKING-style status with no
  // opt-in at all — a default wake class the 29535 ruling excluded ("attention
  // is wider than waking"). Pin both halves, on the real inserted object.
  it("keeps focus-mode push quiet on a ref-bound status while the opt-in wake sees it", () => {
    const f = fixture()
    const { row } = openBallAndReply(f, "status")
    const info = f.inserted.find((i) => i.id === row.id)
    expect(info).toBeDefined()

    // The opt-in arm's question: yes, this ref names the ball the waiter requested.
    expect(info?.refBoundOpenRequest?.requester).toBe(REQUESTER)

    // Focus-mode push's question: no. It stays the settlement-only one.
    expect(settlesRequestOpenedBy(info as MessageInsertedInfo, REQUESTER)).toBe(false)
    const focus = { filter_mode: "focus", filter_mute: null, filter_until: null }
    expect(
      shouldDeliver(
        {
          kind: "direct",
          type: (info as MessageInsertedInfo).type,
          replyHint: "no",
          topic: null,
          settlesOwnRequest: settlesRequestOpenedBy(info as MessageInsertedInfo, REQUESTER),
        },
        focus,
      ),
    ).toBe(false)

    // And focus mode has not simply gone deaf: the actionable class still lands,
    // so the assertion above is about this class and not about the mode.
    expect(
      shouldDeliver({ kind: "direct", type: "assign", replyHint: "no", topic: null, settlesOwnRequest: false }, focus),
    ).toBe(true)
  })
  // 29543: the wake arm asked only "does this ref name an open ball the waiter
  // REQUESTED", while the insert path answering the same question ALSO requires
  // the sender and recipient to be explicit personas ($between_personas). So a
  // row its own classifier calls ambient could wake a wait — waking WIDER than
  // attention, the one direction 29535 rests on ("attention is wider than
  // waking"). The measured case is a bare-named sender: `relay` sends a direct
  // status to @requester whose ref names @requester's open ball.
  it("stays quiet for a bare-named sender whose own classifier calls the row ambient", async () => {
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
      { request: BALL },
    )

    // The path that actually runs: parked FIRST, so any wake can only come from
    // the insert-driven re-check. afterSeq pins the baseline to the ball's own
    // row, as 29541's parked requester case does, so the fresh-wait shortcut on
    // that actionable row cannot settle this one.
    const parked = f.manager.wait(REQUESTER, "conn-bare", 500, {
      wakeOnCorrelatedReply: true,
      afterSeq: rowidOf(f, ball.id),
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const row = sendMessage(f.relay, REQUESTER, "a receipt from a bare name", "status", undefined, BALL)

    // The classifier's own answer for this row, read back from the store.
    const stored = f.db.prepare("SELECT attention_required FROM messages WHERE id = ?").get(row.id) as {
      attention_required: number
    }
    expect(stored.attention_required).toBe(0)
    expect(
      readAttentionProjection(f.requester, REQUESTER, Date.now(), 0, makeOpts()).attention.actionable_unread.map(
        (r) => r.id,
      ),
    ).not.toContain(row.id)

    // The SQL half of the wake question, the JS half's input on the real
    // inserted object, and the behaviour a seat actually feels.
    expect(tailSeq(f.stmts, REQUESTER, true)).not.toBe(rowidOf(f, row.id))
    expect(f.inserted.find((i) => i.id === row.id)?.refBoundOpenRequest ?? null).toBeNull()
    expect((await parked).status).toBe("timeout")
  })

  // 31171 (@adhoc/8 51m wedge): @requester opens a request ball; @responder first
  // sends a TAKING receipt as `type: "response"` with `reply: BALL` (which closes
  // and deletes the `pending_request` row), and later sends the actual final
  // `type: "response"` correlated to `BALL` via `ref: BALL` (or `reply: BALL`).
  // Drain SQL (`selectAttention` and focus-mode `getInboxRows`) classifies the
  // follow-up response as `attention_required = 1`, so it must also wake focus-mode
  // push (`settlesRequestOpenedBy` -> `shouldDeliver`) and `inbox-wait` under
  // `wakeOnCorrelatedReply: true`.
  it.each(["ref", "reply"] as const)(
    "31171 wakes focus-mode push and opt-in inbox-wait on a follow-up response (%s) after an earlier TAKING response settled the ball",
    async (correlationField) => {
      const f = fixture()
      sendMessage(
        f.requester,
        PEER,
        "review landing 2",
        "request",
        undefined,
        undefined,
        "direct",
        {},
        { request: BALL },
      )

      const taking = sendMessage(
        f.peer,
        REQUESTER,
        "TAKING req-29535 · ETA 10m",
        "response",
        undefined,
        undefined,
        "direct",
        {},
        { reply: BALL },
      )
      expect(taking.tracker).toEqual({ request_id: BALL, closed: 1 })
      const takingRowid = rowidOf(f, taking.id)

      // @requester drains the TAKING response and parks waiting for the real verdict/response.
      f.stmts.advanceMailboxCursor.run({ $recipient: REQUESTER, $seq: takingRowid, $now: Date.now() })
      const parked = f.manager.wait(REQUESTER, `conn-31171-${correlationField}`, 1_000, {
        wakeOnCorrelatedReply: true,
        afterSeq: takingRowid,
      })
      await new Promise((resolve) => setTimeout(resolve, 50))

      const finalResponse =
        correlationField === "ref"
          ? sendMessage(f.peer, REQUESTER, "landing 2 GO", "response", undefined, BALL)
          : sendMessage(
              f.peer,
              REQUESTER,
              "landing 2 GO",
              "response",
              undefined,
              undefined,
              "direct",
              {},
              { reply: BALL },
            )
      const finalRowid = rowidOf(f, finalResponse.id)

      // 1. Drain SQL: both attention projection (`selectAttention`) and focus-mode
      //    `getInboxRows` include the follow-up response as unread attention.
      const attention = readAttentionProjection(f.requester, REQUESTER, Date.now(), 0, makeOpts()).attention
      expect(attention.actionable_unread.map((r) => r.id)).toContain(finalResponse.id)
      const drainRows = f.stmts.getInboxRows.all({
        $since: takingRowid,
        $name: REQUESTER,
        $filter_mode: "focus",
        $filter_until: null,
        $filter_mute: null,
        $now: Date.now(),
        $limit: 50,
      }) as Array<{ id: string; attention_required: number }>
      expect(drainRows.map((r) => r.id)).toContain(finalResponse.id)

      // 2. Push predicate: focus-mode `shouldDeliver` must deliver the wakeup.
      const finalInfo = f.inserted.find((i) => i.id === finalResponse.id)
      expect(finalInfo).toBeDefined()
      expect(settlesRequestOpenedBy(finalInfo as MessageInsertedInfo, REQUESTER)).toBe(true)
      const focus = { filter_mode: "focus", filter_mute: null, filter_until: null }
      expect(
        shouldDeliver(
          {
            kind: "direct",
            type: (finalInfo as MessageInsertedInfo).type,
            replyHint: "no",
            topic: null,
            settlesOwnRequest: settlesRequestOpenedBy(finalInfo as MessageInsertedInfo, REQUESTER),
          },
          focus,
        ),
      ).toBe(true)

      // 3. Opt-in inbox-wait SQL tail and live insert-driven wake must both fire immediately.
      expect(tailSeq(f.stmts, REQUESTER, true)).toBe(finalRowid)
      const woken = await parked
      expect(woken.status).toBe("woken")
      expect(woken.waited_ms).toBeLessThan(500)
      expect(woken.attention.actionable_unread.map((r) => r.id)).toContain(finalResponse.id)

      // C3: readInboxWaitWokenBy populates settles_request_id = reply ?? ref for settles-type rows.
      const wokenBy = readInboxWaitWokenBy(f.stmts, REQUESTER, finalRowid, true)
      expect(wokenBy).toMatchObject({
        kind: "message",
        seq: finalRowid,
        message_id: finalResponse.id,
        type: "response",
        settles_request_id: BALL,
      })
    },
  )

  it("31171 C1/C2/C3: ref-only response leaves pending_request untouched, foreign ref stays quiet, status keeps settles_request_id null, and selectCorrelatedRequestForResponse uses only existing indexes", () => {
    const f = fixture()
    const OTHER_BALL = "req-31171-other"
    const FOREIGN_BALL = "req-31171-foreign"

    // Open two balls from @requester to @responder, plus one foreign ball from @responder to relay.
    sendMessage(f.requester, PEER, "first request", "request", undefined, undefined, "direct", {}, { request: BALL })
    sendMessage(
      f.requester,
      PEER,
      "unrelated open request",
      "request",
      undefined,
      undefined,
      "direct",
      {},
      { request: OTHER_BALL },
    )
    sendMessage(
      f.peer,
      "relay",
      "foreign request not opened by @requester",
      "request",
      undefined,
      undefined,
      "direct",
      {},
      { request: FOREIGN_BALL },
    )

    // C2(i): a ref-only response wakes @requester without mutating pending_request
    // (tracker is undefined / closed stays 0, and both open balls of @requester stay open).
    const refOnlyResponse = sendMessage(f.peer, REQUESTER, "progress/answer with ref only", "response", undefined, BALL)
    expect(refOnlyResponse.tracker).toBeUndefined()
    const openForPeer = f.stmts.selectPendingForRecipient.all({ $recipient: PEER }) as Array<{ request_id: string }>
    expect(openForPeer.map((r) => r.request_id).sort()).toEqual([BALL, OTHER_BALL].sort())
    const refOnlyInfo = f.inserted.find((i) => i.id === refOnlyResponse.id)
    expect(refOnlyInfo?.correlatedReply).toEqual({ requestId: BALL, requester: REQUESTER })
    expect(settlesRequestOpenedBy(refOnlyInfo as MessageInsertedInfo, REQUESTER)).toBe(true)

    // C2(ii): a direct response whose ref names a request the recipient (@requester) did NOT open
    // stays correlatedReply = null and does not wake focus-mode push or opt-in inbox-wait.
    const foreignRefResponse = sendMessage(
      f.peer,
      REQUESTER,
      "response referencing someone else's request",
      "response",
      undefined,
      FOREIGN_BALL,
    )
    const foreignInfo = f.inserted.find((i) => i.id === foreignRefResponse.id)
    expect(foreignInfo?.correlatedReply).toBeNull()
    expect(settlesRequestOpenedBy(foreignInfo as MessageInsertedInfo, REQUESTER)).toBe(false)
    expect(tailSeq(f.stmts, REQUESTER, true)).not.toBe(rowidOf(f, foreignRefResponse.id))

    // C3: readInboxWaitWokenBy never sets settles_request_id on a status row, even when its ref names BALL.
    const statusRow = sendMessage(f.peer, REQUESTER, "status on open ball", "status", undefined, BALL)
    const statusWokenBy = readInboxWaitWokenBy(f.stmts, REQUESTER, rowidOf(f, statusRow.id), true)
    expect(statusWokenBy).toMatchObject({
      kind: "message",
      type: "status",
      settles_request_id: null,
    })

    // C1: EXPLAIN QUERY PLAN for selectCorrelatedRequestForResponse's own SQL uses only SEARCH ... USING INDEX, never SCAN.
    const planRows = f.db
      .prepare(assertSingleStatement(`EXPLAIN QUERY PLAN ${SELECT_CORRELATED_REQUEST_FOR_RESPONSE_SQL}`))
      .all({ $target_id: BALL, $responder: PEER, $requester: REQUESTER }) as Array<{ detail: string }>
    const searchDetails = planRows.map((r) => r.detail).filter((d) => d.startsWith("SEARCH ") || d.startsWith("SCAN "))
    expect(searchDetails.length).toBe(6)
    for (const detail of searchDetails) {
      expect(detail).toMatch(/^SEARCH /)
      expect(detail).not.toMatch(/^SCAN /)
    }
  })
})
