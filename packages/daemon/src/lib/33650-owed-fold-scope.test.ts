/**
 * 33650 (@cto 5c8dd3b9) — the owed expired view reads only the history of the
 * obligations it shows.
 *
 * `tribe pending --expired --owed` lists live expired balls, each enriched by
 * that obligation's earlier generations (superseded_count, first opened_at,
 * settlement_conflict). It read EVERY ball outcome fact and EVERY reply ever
 * journaled to do that, on the daemon's one SQLite thread, so a cold cache held
 * every other caller past its 10 s limit (33937).
 *
 * The scope is the obligation's canonical payload identity, (request_id,
 * recipient), across hot and archive and across every generation; replies are
 * read for the request id and every generation's message id. `ref` alone is not
 * that identity: a legacy fact can carry a third id there.
 *
 * Oracle: the full fold (the non-owed read, still reachable as a function)
 * filtered to live rows must equal the owed read, row for row.
 *
 * @failure  Every `pending --expired --owed` call reads the whole journal; on a
 *           cold page cache that blocks the whole Wire for seconds.
 * @level    l1 (handler over a scratch SQLite store, no daemon process)
 * @consumer /inbox expired-owed rail, /do step 3, `tribe pending --expired --owed`
 * @testonly none
 */
import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { pendingExpiredRead, type HandlerOpts } from "./handlers.ts"
import { logEvent } from "./messaging.ts"

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 10, 14, 18, 0, 0)

type Row = {
  request_id: string
  recipient: string
  message_id: string
  opened_at: string
  backing: string
  superseded_count?: number
  settlement_conflict?: Array<{ settlement: string }>
}
type ToolJson = { pending?: Row[]; error?: string }

function makeOpts(): HandlerOpts {
  return {
    cleanup: () => undefined,
    userRenamed: false,
    setUserRenamed: () => undefined,
    getActiveSessionIds: () => new Set<string>(),
    hasActiveTransport: () => false,
    isReconnectGraceProtected: () => false,
    getActiveSessionInfo: () => [],
  }
}

function json(result: ReturnType<typeof pendingExpiredRead>): ToolJson {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}") as ToolJson
}

describe("33650: the owed expired view folds only its obligations' history", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements
  let ctx: TribeContext

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "33650-owed-fold-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
    ctx = createTribeContext({
      db,
      stmts,
      sessionId: "sess-33650",
      sessionRole: "member",
      initialName: "@chief",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function openLive(request: string, recipient: string, message: string, openedAt: number, fanout = "first") {
    stmts.openPendingRequest.run({
      $request_id: request,
      $recipient: recipient,
      $sender: "@yrd",
      $opened_at: openedAt,
      $expires_at: openedAt + 1_200_000 < NOW ? openedAt + 1_200_000 : NOW - 60_000,
      $message_id: message,
      $fanout: fanout,
    })
  }

  /** A generation's deadline fact, with `ref` settable to model legacy rows. */
  function deadline(
    request: string,
    recipient: string,
    message: string,
    openedAt: number,
    ref = request,
    fanout: "first" | "all" = "first",
  ) {
    const expiresAt = openedAt + 1_200_000
    logEvent(
      ctx,
      "ball.expired",
      undefined,
      {
        schema_version: 2,
        request_id: request,
        recipient,
        sender: "@yrd",
        opened_at: openedAt,
        expires_at: expiresAt,
        message_id: message,
        fanout,
        summary: `gen ${message}`,
        observation: "deadline-passed",
        observed_at: expiresAt + 1,
      },
      { sender: "daemon", ref, ts: expiresAt + 1 },
    )
  }

  function settled(
    request: string,
    recipient: string,
    message: string,
    openedAt: number,
    settlement: string,
    settledAt: number,
    fanout: "first" | "all" = "first",
  ) {
    logEvent(
      ctx,
      "ball.settled",
      undefined,
      {
        schema_version: 1,
        request_id: request,
        recipient,
        sender: "@yrd",
        opened_at: openedAt,
        expires_at: openedAt + 1_200_000,
        message_id: message,
        fanout,
        summary: `gen ${message}`,
        settlement,
        settled_at: settledAt,
        settled_by: recipient,
      },
      { sender: "daemon", ref: request, ts: settledAt },
    )
  }

  const insertReply = () =>
    db.prepare(
      `INSERT INTO messages (id, type, sender, recipient, kind, content, ts, delivery, reply)
       VALUES ($id, 'response', $sender, '@yrd', 'direct', 'answer', $ts, 'push', $reply)`,
    )
  let replySeq = 0
  function reply(sender: string, replyTo: string, ts: number) {
    insertReply().run({ $id: `reply-${replySeq++}`, $sender: sender, $ts: ts, $reply: replyTo } as never)
  }

  /** Every shape the scope must keep, buried in unrelated history. */
  function seed(unrelated: number) {
    // live-a: gen m1 (archived, legacy third-id ref, unanswered), gen m2
    // (answered by message id), live gen m3.
    deadline("live-a", "@chief", "live-a-m1", NOW - 50 * HOUR, "legacy-third-id")
    deadline("live-a", "@chief", "live-a-m2", NOW - 30 * HOUR)
    reply("@chief", "live-a-m2", NOW - 30 * HOUR + 1000)
    // Same request id, another recipient: a separate identity.
    deadline("live-a", "@dev/9", "live-a-m2", NOW - 30 * HOUR)
    // live-b fanout=all: @dev/2's older generation carries contradicting
    // settlements; @dev/3's older generation was answered only by @dev/2.
    settled("live-b", "@dev/2", "live-b-m1", NOW - 40 * HOUR, "manual-close", NOW - 39 * HOUR, "all")
    settled("live-b", "@dev/2", "live-b-m1", NOW - 40 * HOUR, "answered", NOW - 38 * HOUR, "all")
    deadline("live-b", "@dev/3", "live-b-m1", NOW - 40 * HOUR, "live-b", "all")
    reply("@dev/2", "live-b", NOW - 39 * HOUR)
    // live-e: a replayed journal generation opened AFTER the live row replaces
    // it in the collapse, so the owed view must not list live-e at all.
    deadline("live-e", "@chief", "live-e-m9", NOW - 1 * HOUR)
    for (let i = 0; i < unrelated; i++) {
      const at = NOW - (60 + (i % 400)) * HOUR
      deadline(`old-${i}`, `@dev/${i % 7}`, `old-${i}-m1`, at)
      settled(`old-${i}`, `@dev/${i % 7}`, `old-${i}-m2`, at + HOUR, i % 3 === 0 ? "answered" : "gc-expired", at + 2 * HOUR)
      reply(`@dev/${i % 7}`, `old-${i}-m1`, at + 1000)
    }
    // Move everything older than 45 h to the archive by the daemon's own mover.
    stmts.archiveExpiredMessages.run({ $cutoff: NOW - 45 * HOUR, $archived_at: NOW } as never)
    stmts.deleteExpiredMessages.run({ $cutoff: NOW - 45 * HOUR } as never)
    // Interrupted archive: one archived fact also still present hot.
    db.run(
      `INSERT INTO messages (id, type, sender, recipient, kind, content, ts, delivery, ref)
       SELECT id, type, sender, recipient, kind, content, ts, delivery, ref FROM messages_archive
       WHERE kind = 'event' AND CASE WHEN json_valid(content) THEN json_extract(content, '$.message_id') END = 'live-a-m1'`,
    )

    openLive("live-a", "@chief", "live-a-m3", NOW - 2 * HOUR)
    openLive("live-b", "@dev/2", "live-b-m2", NOW - 2 * HOUR, "all")
    openLive("live-b", "@dev/3", "live-b-m2", NOW - 2 * HOUR, "all")
    openLive("live-e", "@chief", "live-e-m3", NOW - 3 * HOUR)
    stmts.openPendingRequest.run({
      $request_id: "not-expired",
      $recipient: "@chief",
      $sender: "@yrd",
      $opened_at: NOW - 60_000,
      $expires_at: NOW + HOUR,
      $message_id: "not-expired-m1",
      $fanout: "first",
    })
  }

  function fullFoldLive(owner?: string): Row[] {
    const query = owner === undefined ? { all: true, now: NOW } : { owner, now: NOW }
    return (json(pendingExpiredRead(ctx, makeOpts(), query)).pending ?? []).filter((row) => row.backing === "live")
  }

  function owedWithoutFold(owner?: string): Row[] {
    const outcomes = vi.spyOn(stmts.selectPendingOutcomeFactsByType, "all")
    const replies = vi.spyOn(stmts.selectPendingReplyFacts, "all")
    try {
      const query = owner === undefined ? { all: true, owed: true, now: NOW } : { owner, owed: true, now: NOW }
      const view = json(pendingExpiredRead(ctx, makeOpts(), query))
      expect(view.error).toBeUndefined()
      expect(outcomes, "owed read touched the whole-journal outcome fold").not.toHaveBeenCalled()
      expect(replies, "owed read touched the whole-journal reply fold").not.toHaveBeenCalled()
      return view.pending ?? []
    } finally {
      outcomes.mockRestore()
      replies.mockRestore()
    }
  }

  it("the fixture exercises every scope edge through the full fold", () => {
    seed(50)
    const byKey = new Map(fullFoldLive().map((row) => [`${row.request_id} ${row.recipient}`, row]))
    expect([...byKey.keys()].toSorted()).toEqual(["live-a @chief", "live-b @dev/2", "live-b @dev/3"])
    // m1 (third-id ref, archived and duplicated hot) counts; m2 was answered by message id.
    expect(byKey.get("live-a @chief")!.superseded_count).toBe(1)
    expect(byKey.get("live-a @chief")!.opened_at).toBe(new Date(NOW - 50 * HOUR).toISOString())
    expect(byKey.get("live-b @dev/2")!.settlement_conflict?.map((entry) => entry.settlement)).toEqual([
      "manual-close",
      "answered",
    ])
    expect(byKey.get("live-b @dev/3")!.superseded_count).toBe(1)
  })

  it.each([
    ["every owner", undefined],
    ["@chief", "@chief"],
    ["@dev/2", "@dev/2"],
    ["@dev/3", "@dev/3"],
    ["an owner with only history", "@dev/9"],
  ])("owed read (%s) equals the full fold's live rows without reading the whole journal", (_label, owner) => {
    seed(200)
    const expected = fullFoldLive(owner)
    expect(JSON.stringify(owedWithoutFold(owner))).toBe(JSON.stringify(expected))
  })
})
