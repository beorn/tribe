/**
 * @ag/tribe/an-advertised-ball-owner-disappears-before-it-can-settle
 *
 * A `closed: 0` ball result used to hand back a shrug: "expired, settled
 * out-of-band, or never tracked" — a list of possibilities the owner had to
 * rule out by hand, when the journal already held the one true answer.
 * `settlePendingRows` (messaging.ts) journals an `event.ball.settled` fact for
 * every row it releases, and a live deadline observation is a separate
 * `event.ball.expired` fact — `pendingCloseCause`/`formatPendingCloseCause`
 * fold those into the exact sentence a `closed: 0` result now carries.
 *
 * Covers: the fanout='first' loser (a sibling's answer settled your row), the
 * fanout='all' sibling shape (your own row survives, and a second reply from
 * you cites your own earlier settlement), a manual close, a scoped prune, a
 * never-tracked id (both on reply and on `tribe.pending close`), and the
 * archived tier (the settlement fact moved out of `messages` and the cause
 * must still resolve from `messages_archive`).
 */

import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"
import { registerSession } from "./session.ts"

const PROJECT_ID = "ball-close-cause"

type TrackerJson = {
  request_id: string
  closed: number
  cause?: string
  cause_fact?: Record<string, unknown>
}

function makeContext(db: Database, stmts: TribeStatements, name: string, sessionId: string): TribeContext {
  return createTribeContext({
    db,
    stmts,
    sessionId,
    sessionRole: "member",
    initialName: name,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
}

function makeOpts(activeIds: readonly string[]): HandlerOpts {
  const names = new Map([
    ["sess-ci", "@ci"],
    ["sess-dev3", "@dev/3"],
    ["sess-dev9", "@dev/9"],
  ])
  return {
    cleanup: () => undefined,
    userRenamed: false,
    setUserRenamed: () => undefined,
    getActiveSessionIds: () => new Set(activeIds),
    hasActiveTransport: (sessionId) => activeIds.includes(sessionId),
    getActiveSessionInfo: () =>
      activeIds.map((id) => ({
        id,
        name: names.get(id) ?? id,
        pid: process.pid,
        cwd: "/repo",
        role: "member",
        claudeSessionId: null,
        registeredAt: Date.now(),
        launchId: null,
        launchParentPid: null,
        transportPids: [process.pid],
      })),
  }
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Record<string, unknown>
}

function pendingRecipients(db: Database, requestId: string): string[] {
  const rows = db
    .prepare("SELECT recipient FROM pending_request WHERE request_id = ? ORDER BY recipient ASC")
    .all(requestId) as Array<{ recipient: string }>
  return rows.map((row) => row.recipient)
}

const ALL_ACTIVE = ["sess-ci", "sess-dev3", "sess-dev9"]

describe("a closed: 0 ball result names its exact cause from the journal", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements
  let ci: TribeContext
  let dev3: TribeContext
  let dev9: TribeContext

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ball-close-cause-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)

    ci = makeContext(db, stmts, "@ci", "sess-ci")
    dev3 = makeContext(db, stmts, "@dev/3", "sess-dev3")
    dev9 = makeContext(db, stmts, "@dev/9", "sess-dev9")

    registerSession(ci, PROJECT_ID, () => true, null, 2001, "push", "/repo", null, "claude")
    registerSession(dev3, PROJECT_ID, () => true, null, 2002, "push", "/repo", null, "claude")
    registerSession(dev9, PROJECT_ID, () => true, null, 2003, "push", "/repo", null, "claude")
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("fanout='first': the loser's cause names the winner, the reason, and the timestamp", () => {
    parseToolJson(
      handleToolCall(
        ci,
        "tribe.send",
        { to: "*", message: "who can take this", type: "request", request: "req-fan-first", fanout: "first" },
        makeOpts(ALL_ACTIVE),
      ),
    )
    expect(pendingRecipients(db, "req-fan-first")).toEqual(["@dev/3", "@dev/9"])

    const tBefore = Date.now()
    const firstReply = parseToolJson(
      handleToolCall(
        dev3,
        "tribe.send",
        { to: "@ci", message: "I've got it", type: "response", reply: "req-fan-first" },
        makeOpts(ALL_ACTIVE),
      ),
    )
    const tAfter = Date.now()
    // The first answer settles EVERY owner's row, not just the replier's —
    // that is what makes @dev/9's later reply a miss.
    expect((firstReply.tracker as TrackerJson).closed).toBeGreaterThan(0)
    expect(pendingRecipients(db, "req-fan-first")).toEqual([])

    const loserReply = parseToolJson(
      handleToolCall(
        dev9,
        "tribe.send",
        { to: "@ci", message: "I've got it too", type: "response", reply: "req-fan-first" },
        makeOpts(ALL_ACTIVE),
      ),
    )
    const tracker = loserReply.tracker as TrackerJson
    expect(tracker.closed).toBe(0)
    expect(loserReply.reply_close_failed).toBe(true)
    expect(tracker.cause_fact).toMatchObject({
      kind: "settled",
      settlement: "answered",
      settled_by: "@dev/3",
      recipient: "@dev/9",
      fanout: "first",
      by_another_owner: true,
    })
    const settledAt = (tracker.cause_fact as { settled_at: number }).settled_at
    expect(settledAt).toBeGreaterThanOrEqual(tBefore)
    expect(settledAt).toBeLessThanOrEqual(tAfter)
    expect((tracker.cause_fact as { expired_at?: number }).expired_at).toBeUndefined()
    expect(tracker.cause).toBe(
      `closed 0 rows for req-fan-first: answered by @dev/3 at ${new Date(settledAt).toISOString()} ` +
        "(fanout first: the first answer settled every owner's row, including @dev/9's)",
    )
  })

  it("fanout='all': a sibling's row survives, and a second reply cites your own earlier settlement", () => {
    parseToolJson(
      handleToolCall(
        ci,
        "tribe.send",
        { to: "*", message: "everyone ack", type: "request", request: "req-fan-all", fanout: "all" },
        makeOpts(ALL_ACTIVE),
      ),
    )
    expect(pendingRecipients(db, "req-fan-all")).toEqual(["@dev/3", "@dev/9"])

    const firstReply = parseToolJson(
      handleToolCall(
        dev3,
        "tribe.send",
        { to: "@ci", message: "ack", type: "response", reply: "req-fan-all" },
        makeOpts(ALL_ACTIVE),
      ),
    )
    expect((firstReply.tracker as TrackerJson).closed).toBe(1)
    // fanout='all': only the replying owner's row closes — the sibling's
    // obligation is untouched (AC3 shape 2).
    expect(pendingRecipients(db, "req-fan-all")).toEqual(["@dev/9"])

    const siblingReply = parseToolJson(
      handleToolCall(
        dev9,
        "tribe.send",
        { to: "@ci", message: "ack too", type: "response", reply: "req-fan-all" },
        makeOpts(ALL_ACTIVE),
      ),
    )
    expect((siblingReply.tracker as TrackerJson).closed).toBe(1)
    expect(pendingRecipients(db, "req-fan-all")).toEqual([])

    // A second reply from @dev/3 finds only their OWN earlier settlement —
    // never blamed on @dev/9, and no fanout-first clause (this is fanout=all).
    const secondReply = parseToolJson(
      handleToolCall(
        dev3,
        "tribe.send",
        { to: "@ci", message: "ack again", type: "response", reply: "req-fan-all" },
        makeOpts(ALL_ACTIVE),
      ),
    )
    const tracker = secondReply.tracker as TrackerJson
    expect(tracker.closed).toBe(0)
    expect(secondReply.reply_close_failed).toBe(true)
    expect(tracker.cause_fact).toMatchObject({
      kind: "settled",
      settlement: "answered",
      settled_by: "@dev/3",
      recipient: "@dev/3",
      fanout: "all",
      by_another_owner: false,
    })
    const settledAt = (tracker.cause_fact as { settled_at: number }).settled_at
    expect(tracker.cause).toBe(
      `closed 0 rows for req-fan-all: answered by @dev/3 at ${new Date(settledAt).toISOString()}`,
    )
  })

  it("manual close then reply: the cause names the manual closer", () => {
    parseToolJson(
      handleToolCall(
        ci,
        "tribe.send",
        { to: "@dev/3", message: "please review", type: "request", request: "req-manual" },
        makeOpts(ALL_ACTIVE),
      ),
    )

    const tBefore = Date.now()
    const closeResult = parseToolJson(
      handleToolCall(dev3, "tribe.pending", { owner: "@dev/3", close: "req-manual" }, makeOpts(ALL_ACTIVE)),
    )
    const tAfter = Date.now()
    expect(closeResult.closed).toBe(1)
    expect(pendingRecipients(db, "req-manual")).toEqual([])

    const reply = parseToolJson(
      handleToolCall(
        dev3,
        "tribe.send",
        { to: "@ci", message: "reviewed (too late)", type: "response", reply: "req-manual" },
        makeOpts(ALL_ACTIVE),
      ),
    )
    const tracker = reply.tracker as TrackerJson
    expect(tracker.closed).toBe(0)
    expect(reply.reply_close_failed).toBe(true)
    expect(tracker.cause_fact).toMatchObject({
      kind: "settled",
      settlement: "manual-close",
      settled_by: "@dev/3",
      recipient: "@dev/3",
      by_another_owner: false,
    })
    const settledAt = (tracker.cause_fact as { settled_at: number }).settled_at
    expect(settledAt).toBeGreaterThanOrEqual(tBefore)
    expect(settledAt).toBeLessThanOrEqual(tAfter)
    expect(tracker.cause).toBe(
      `closed 0 rows for req-manual: @dev/3 closed it manually (manual-close) at ${new Date(settledAt).toISOString()}`,
    )
  })

  it("a prune settles it as gc-expired, named by the pruner, with its deadline noted", () => {
    const HOUR = 60 * 60_000
    const now = Date.now()
    // A stale ball whose declared deadline has already passed — opened long
    // enough ago that a 1-hour prune threshold reaches it, expired long
    // enough ago that the very next daemon call records the deadline-passed
    // observation before the prune settles it (recordExpiredPendingRequests
    // runs at the top of every handleToolCall).
    stmts.openPendingRequest.run({
      $request_id: "req-stale",
      $recipient: "@dev/9",
      $sender: "@ci",
      $opened_at: now - 3 * HOUR,
      $expires_at: now - 2 * HOUR,
      $message_id: "msg-req-stale",
      $fanout: "first",
    })

    const tBefore = Date.now()
    const pruneResult = parseToolJson(
      handleToolCall(dev9, "tribe.pending", { owner: "@dev/9", prune: true, stale_ms: HOUR }, makeOpts(ALL_ACTIVE)),
    )
    const tAfter = Date.now()
    expect(pruneResult.pruned).toBe(1)
    expect(pendingRecipients(db, "req-stale")).toEqual([])

    const reply = parseToolJson(
      handleToolCall(
        dev9,
        "tribe.send",
        { to: "@ci", message: "sorry, missed this", type: "response", reply: "req-stale" },
        makeOpts(ALL_ACTIVE),
      ),
    )
    const tracker = reply.tracker as TrackerJson
    expect(tracker.closed).toBe(0)
    expect(reply.reply_close_failed).toBe(true)
    expect(tracker.cause_fact).toMatchObject({
      kind: "settled",
      settlement: "gc-expired",
      settled_by: "@dev/9",
      recipient: "@dev/9",
      by_another_owner: false,
    })
    const fact = tracker.cause_fact as { settled_at: number; expired_at?: number }
    expect(fact.settled_at).toBeGreaterThanOrEqual(tBefore)
    expect(fact.settled_at).toBeLessThanOrEqual(tAfter)
    // AC4: the row's disappearance is journalled with a reason the owner can
    // read, including that its declared deadline had already passed.
    expect(fact.expired_at).toBeDefined()
    expect(tracker.cause).toBe(
      `closed 0 rows for req-stale: settled gc-expired by @dev/9 (pending prune) at ${new Date(fact.settled_at).toISOString()}; ` +
        `its deadline had passed at ${new Date(fact.expired_at as number).toISOString()}`,
    )
  })

  it("never tracked: a reply and a close both name it, never a list of possibilities", () => {
    const reply = parseToolJson(
      handleToolCall(
        dev3,
        "tribe.send",
        { to: "@ci", message: "responding to nothing", type: "response", reply: "totally-unknown-id" },
        makeOpts(ALL_ACTIVE),
      ),
    )
    const tracker = reply.tracker as TrackerJson
    expect(tracker.closed).toBe(0)
    expect(reply.reply_close_failed).toBe(true)
    expect(tracker.cause_fact).toEqual({ kind: "never-tracked" })
    expect(tracker.cause).toBe(
      "closed 0 rows for totally-unknown-id: never tracked — no ball was ever opened for this id to @dev/3 " +
        "(check the id against tribe pending --owner @dev/3)",
    )

    // The batch close form surfaces the same cause as closeOneBall's `reason`
    // (the single-id close path drops `reason` from its response and relies
    // on `warning`, which is covered by the fanout/manual-close tests above).
    const closeResult = parseToolJson(
      handleToolCall(dev3, "tribe.pending", { owner: "@dev/3", close: ["totally-unknown-id"] }, makeOpts(ALL_ACTIVE)),
    )
    const results = closeResult.results as Array<{ request_id: string; closed: number; reason?: string }>
    expect(results).toEqual([
      {
        request_id: "totally-unknown-id",
        closed: 0,
        reason:
          "closed 0 rows for totally-unknown-id: never tracked — no ball was ever opened for this id to @dev/3 " +
          "(check the id against tribe pending --owner @dev/3)",
      },
    ])
  })

  it("finds the cause after its settlement fact has moved into the archive tier", () => {
    parseToolJson(
      handleToolCall(
        ci,
        "tribe.send",
        { to: "@dev/3", message: "please review", type: "request", request: "req-archived" },
        makeOpts(ALL_ACTIVE),
      ),
    )
    parseToolJson(
      handleToolCall(
        dev3,
        "tribe.send",
        { to: "@ci", message: "reviewed", type: "response", reply: "req-archived" },
        makeOpts(ALL_ACTIVE),
      ),
    )
    const settledRow = db
      .prepare("SELECT rowid, id FROM messages WHERE kind = 'event' AND type = 'event.ball.settled' AND ref = ?")
      .get("req-archived") as { rowid: number; id: string }
    expect(settledRow).toBeDefined()

    // Move the fact from `messages` to `messages_archive` exactly as the
    // retention sweep's own archiveExpiredMessages statement does (same
    // explicit column list, same `rowid AS seq`), then delete the live row —
    // the live query must never see it again.
    db.prepare(
      `INSERT INTO messages_archive (
         seq, id, type, sender, recipient, kind, content, bead_id, ref, ts,
         delivery, topic, room_id, request, reply, correlated_reply_requester, summary, session_id,
         attention_required, archived_at
       )
       SELECT
         rowid, id, type, sender, recipient, kind, content, bead_id, ref, ts,
         delivery, topic, room_id, request, reply, correlated_reply_requester, summary, session_id,
         attention_required, $archived_at
       FROM messages WHERE rowid = $rowid`,
    ).run({ $rowid: settledRow.rowid, $archived_at: Date.now() })
    db.prepare("DELETE FROM messages WHERE rowid = ?").run(settledRow.rowid)
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM messages WHERE kind = 'event' AND type = 'event.ball.settled'").get(),
    ).toEqual({ c: 0 })
    expect(
      db
        .prepare("SELECT COUNT(*) AS c FROM messages_archive WHERE kind = 'event' AND type = 'event.ball.settled'")
        .get(),
    ).toEqual({ c: 1 })

    const secondReply = parseToolJson(
      handleToolCall(
        dev3,
        "tribe.send",
        { to: "@ci", message: "reviewed again", type: "response", reply: "req-archived" },
        makeOpts(ALL_ACTIVE),
      ),
    )
    const tracker = secondReply.tracker as TrackerJson
    expect(tracker.closed).toBe(0)
    expect(tracker.cause_fact).toMatchObject({
      kind: "settled",
      settlement: "answered",
      settled_by: "@dev/3",
      recipient: "@dev/3",
    })
    expect(tracker.cause).toContain("answered by @dev/3 at")
  })
})
