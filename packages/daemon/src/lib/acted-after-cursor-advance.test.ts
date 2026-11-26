/**
 * @failure A push seat that receives an inline non-ball attention row (such as a verified persona fleet
 *          broadcast with attention_required=1 or a direct verdict/status/response) and acts after it has
 *          that row omitted by selectAttention (via actedSinceDeliverySql) while selectUnreturnedAttention
 *          still counts it as an unreturned skipped row, permanently pinning mailbox_cursors.last_actionable_seq
 *          at (acted_row.rowid - 1). Every later direct status/response row stays permanently unread across
 *          default consuming tribe.fetch and since+advance reads, blocking the Stop hook.
 * @level l2
 * @consumer tribe.fetch (handleFetch cursor advance + recovered events), tribe inbox --consume (since+advance),
 *           tools/tribe-idle-attention-hook.ts (via readAttentionProjection).
 * @testonly none: exercises real SQLite statements, handleToolCall("tribe.fetch"), and readAttentionProjection.
 */
import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, readAttentionProjection, TRIBE_COORD_METHODS, type HandlerOpts } from "./handlers.ts"
import { sendMessage } from "./messaging.ts"
import { registerSession } from "./session.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = Date.now()

type SyncToolResult = Exclude<ReturnType<typeof handleToolCall>, Promise<unknown>>

function parseToolResult(result: ReturnType<typeof handleToolCall>): Record<string, unknown> {
  return JSON.parse((result as SyncToolResult).content[0]!.text) as Record<string, unknown>
}

describe("acted-after inline rows never pin mailbox_cursors in selectUnreturnedAttention or since+advance", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-acted-after-cursor-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeSeat(
    id: string,
    name: string,
    opts: { delivery?: "push" | "pull"; filterMode?: "focus" | "normal" | "ambient" } = {},
  ): TribeContext {
    const ctx = createTribeContext({
      db,
      stmts,
      sessionId: id,
      initialName: name,
      sessionRole: "member",
      domains: ["silvercode"],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    registerSession(ctx, name, () => true, undefined, process.pid, opts.delivery ?? "push", tmpDir)
    db.prepare("UPDATE sessions SET identity_sid = ?, started_at = ? WHERE id = ?").run(`sid-${id}`, NOW - 2 * HOUR, id)
    if (opts.filterMode) {
      stmts.setSessionFilter.run({
        $id: id,
        $mode: opts.filterMode,
        $until: null,
        $mute: null,
        $now: Date.now(),
      })
    }
    return ctx
  }

  function makeOpts(activeIds: readonly string[]): HandlerOpts {
    const active = new Set(activeIds)
    return {
      cleanup: () => {},
      userRenamed: false,
      setUserRenamed: () => {},
      getActiveSessionIds: () => new Set(active),
      hasActiveTransport: (id) => active.has(id),
      isReconnectGraceProtected: () => false,
      getActiveSessionInfo: () => [],
    }
  }

  function markDeliveredInline(seatName: string, rowid: number, ts: number): void {
    db.prepare("UPDATE sessions SET last_delivered_seq = ?, last_delivered_ts = ? WHERE name = ?").run(
      rowid,
      ts,
      seatName,
    )
  }

  function insertRow(args: {
    id: string
    type: string
    sender: string
    recipient: string
    kind: "direct" | "broadcast"
    ts: number
    delivery?: "push" | "pull"
    attentionRequired?: 0 | 1
    ref?: string | null
    request?: string | null
  }): number {
    const res = stmts.insertMessage.run({
      $id: args.id,
      $type: args.type,
      $sender: args.sender,
      $recipient: args.recipient,
      $kind: args.kind,
      $content: `body-${args.id}`,
      $bead_id: null,
      $ref: args.ref ?? null,
      $ts: args.ts,
      $delivery: args.delivery ?? "push",
      $topic: null,
      $room_id: null,
      $request: args.request ?? null,
      $reply: null,
      $summary: `summary-${args.id}`,
      $attention_required: args.attentionRequired ?? 0,
      $wakes_owner: 0,
      $is_incident: 0,
      $incident_data: null,
      $between_personas: args.kind === "direct" ? 1 : 0,
      $sender_authority: "verified",
      $session_id: "sess-sender",
    })
    return Number(res.lastInsertRowid)
  }

  it("advances mailbox_cursors past an acted-after fleet broadcast on default consuming fetch (@cto live repro)", async () => {
    const cto = makeSeat("sess-cto", "@cto", { delivery: "push", filterMode: "focus" })
    const opts = makeOpts(["sess-cto"])

    // 0. Baseline cursor before the broadcast (matches an already-active seat like @cto).
    const baselineRowid = insertRow({
      id: "baseline-prior-direct",
      type: "status",
      sender: "@chief",
      recipient: "@cto",
      kind: "direct",
      ts: NOW - 50 * MINUTE,
      delivery: "push",
      attentionRequired: 1,
    })
    stmts.advanceMailboxCursor.run({ $recipient: "@cto", $seq: baselineRowid, $now: NOW - 49 * MINUTE })
    stmts.advanceInboxCursor.run({ $id: "sess-cto", $seq: baselineRowid, $now: NOW - 49 * MINUTE })

    // 1. Verified persona fleet broadcast (attention_required=1, kind='broadcast', recipient='*')
    const bcastRowid = insertRow({
      id: "b0d9b1d6-fleet-broadcast",
      type: "notify",
      sender: "@chief",
      recipient: "*",
      kind: "broadcast",
      ts: NOW - 30 * MINUTE,
      delivery: "push",
      attentionRequired: 1,
    })
    markDeliveredInline("@cto", bcastRowid, NOW - 30 * MINUTE)

    // 2. @cto acts strictly after the broadcast (e.g. sends a reply), retiring it via actedSinceDeliverySql,
    //    and its ambient inbox cursor has already advanced past the broadcast.
    const actedSendRowid = insertRow({
      id: "cto-acted-send",
      type: "response",
      sender: "@cto",
      recipient: "@chief",
      kind: "direct",
      ts: NOW - 25 * MINUTE,
      delivery: "push",
    })
    stmts.advanceInboxCursor.run({ $id: "sess-cto", $seq: actedSendRowid, $now: NOW - 24 * MINUTE })

    // 3. Two later direct rows arrive with attention_required=1 (status + response, no open ball).
    const statusRowid = insertRow({
      id: "75253392-direct-status",
      type: "status",
      sender: "@dev/6",
      recipient: "@cto",
      kind: "direct",
      ts: NOW - 10 * MINUTE,
      delivery: "push",
      attentionRequired: 1,
      ref: "closed-ball-ref",
    })
    const respRowid = insertRow({
      id: "d251fb7f-direct-response",
      type: "response",
      sender: "@dev/luna5",
      recipient: "@cto",
      kind: "direct",
      ts: NOW - 5 * MINUTE,
      delivery: "push",
      attentionRequired: 1,
      ref: "notify-ref",
    })
    markDeliveredInline("@cto", respRowid, NOW - 5 * MINUTE)

    // Pre-fetch: acted-after broadcast is retired, only the two newer direct rows are unread.
    const before = readAttentionProjection(cto, "@cto", NOW, actedSendRowid, opts).attention
    expect(before.actionable_unread.map((r) => r.id)).toEqual(["75253392-direct-status", "d251fb7f-direct-response"])
    expect(statusRowid).toBeGreaterThan(bcastRowid)

    // 4. @cto performs a default consuming tribe.fetch (receipt: true).
    const fetchResult = parseToolResult(
      handleToolCall(cto, TRIBE_COORD_METHODS.fetch, { limit: 50, receipt: true }, opts),
    )

    // Mailbox cursor must advance past the latest direct row, NOT stay pinned at bcastRowid - 1.
    const cursor = stmts.getMailboxCursor.get({ $recipient: "@cto" }) as { last_actionable_seq: number } | null
    expect(cursor?.last_actionable_seq).toBeGreaterThanOrEqual(respRowid)

    // selectUnackedAttention must not re-inject the acted-after broadcast into recovered events either.
    const events = (fetchResult.events as Array<{ id: string }>) ?? []
    expect(events.map((e) => e.id)).not.toContain("b0d9b1d6-fleet-broadcast")

    // Post-fetch: actionable_unread is empty (Stop hook clears).
    const after = readAttentionProjection(cto, "@cto", NOW, respRowid, opts).attention
    expect(after.actionable_unread).toEqual([])
  })

  it("advances mailbox_cursors past an acted-after direct attention row on default consuming fetch", async () => {
    const seat = makeSeat("sess-dev16", "@dev/16", { delivery: "push", filterMode: "focus" })
    const opts = makeOpts(["sess-dev16"])

    // Advance session inbox pull cursor past row 1 so default fetch recovery (selectUnackedAttention) also runs.
    const earlierDirect = insertRow({
      id: "direct-acted-earlier",
      type: "verdict",
      sender: "@cto",
      recipient: "@dev/16",
      kind: "direct",
      ts: NOW - 40 * MINUTE,
      delivery: "push",
      attentionRequired: 1,
    })
    markDeliveredInline("@dev/16", earlierDirect, NOW - 40 * MINUTE)
    stmts.advanceInboxCursor.run({ $id: "sess-dev16", $seq: earlierDirect, $now: NOW - 39 * MINUTE })

    // Seat acts after earlierDirect.
    insertRow({
      id: "dev16-acted-send",
      type: "status",
      sender: "@dev/16",
      recipient: "@cto",
      kind: "direct",
      ts: NOW - 35 * MINUTE,
      delivery: "push",
    })

    // Later unread direct row arrives.
    const laterDirect = insertRow({
      id: "direct-unread-later",
      type: "response",
      sender: "@chief",
      recipient: "@dev/16",
      kind: "direct",
      ts: NOW - 10 * MINUTE,
      delivery: "push",
      attentionRequired: 1,
    })
    markDeliveredInline("@dev/16", laterDirect, NOW - 10 * MINUTE)

    const fetched = parseToolResult(handleToolCall(seat, TRIBE_COORD_METHODS.fetch, { limit: 50, receipt: true }, opts))
    const events = (fetched.events as Array<{ id: string }>) ?? []
    expect(events.map((e) => e.id)).not.toContain("direct-acted-earlier")

    const cursor = stmts.getMailboxCursor.get({ $recipient: "@dev/16" }) as { last_actionable_seq: number } | null
    expect(cursor?.last_actionable_seq).toBeGreaterThanOrEqual(laterDirect)

    const after = readAttentionProjection(seat, "@dev/16", NOW, laterDirect, opts).attention
    expect(after.actionable_unread).toEqual([])
  })

  it("acknowledges an untracked attention_required=1 broadcast returned in a since+advance read (tribe inbox --consume)", async () => {
    // Pull seat with an existing mailbox cursor exercises the since+advance path where
    // broadcastAttentionCursorSql reads mailbox_cursors.last_actionable_seq and projectedAttentionIds is empty.
    const seat = makeSeat("sess-pull", "@dev/pull", { delivery: "pull", filterMode: "focus" })
    const opts = makeOpts(["sess-pull"])

    const baselineRowid = insertRow({
      id: "baseline-pull-direct",
      type: "status",
      sender: "@chief",
      recipient: "@dev/pull",
      kind: "direct",
      ts: NOW - 40 * MINUTE,
      delivery: "pull",
      attentionRequired: 1,
    })
    stmts.advanceMailboxCursor.run({ $recipient: "@dev/pull", $seq: baselineRowid, $now: NOW - 39 * MINUTE })
    stmts.advanceInboxCursor.run({ $id: "sess-pull", $seq: baselineRowid, $now: NOW - 39 * MINUTE })

    const bcastRowid = insertRow({
      id: "bcast-since-advance",
      type: "notify",
      sender: "@chief",
      recipient: "*",
      kind: "broadcast",
      ts: NOW - 20 * MINUTE,
      delivery: "push",
      attentionRequired: 1,
    })
    const directRowid = insertRow({
      id: "direct-after-bcast",
      type: "status",
      sender: "@dev/6",
      recipient: "@dev/pull",
      kind: "direct",
      ts: NOW - 10 * MINUTE,
      delivery: "pull",
      attentionRequired: 1,
    })
    expect(directRowid).toBeGreaterThan(bcastRowid)

    // since+advance fetch returns both rows in `events` with attention=null (projectedAttentionIds is empty).
    const fetched = parseToolResult(
      handleToolCall(
        seat,
        TRIBE_COORD_METHODS.fetch,
        { since: baselineRowid, advance: true, receipt: true, limit: 50 },
        opts,
      ),
    )
    const eventIds = ((fetched.events as Array<{ id: string }>) ?? []).map((e) => e.id)
    expect(eventIds).toContain("bcast-since-advance")
    expect(eventIds).toContain("direct-after-bcast")

    const cursor = stmts.getMailboxCursor.get({ $recipient: "@dev/pull" }) as { last_actionable_seq: number } | null
    expect(cursor?.last_actionable_seq).toBeGreaterThanOrEqual(directRowid)

    const after = readAttentionProjection(seat, "@dev/pull", NOW, directRowid, opts).attention
    expect(after.actionable_unread).toEqual([])
  })

  it("still caps mailbox_cursors before an UNHANDLED skipped attention row on a --from-narrowed since+advance read (#31840 guardrail)", async () => {
    const reader = makeSeat("sess-reader", "@dev/reader", { delivery: "push", filterMode: "focus" })
    const senderA = makeSeat("sess-a", "@dev/a", { delivery: "push" })
    const senderB = makeSeat("sess-b", "@dev/b", { delivery: "push" })
    const opts = makeOpts(["sess-reader", "sess-a", "sess-b"])

    // Unhandled verdict from @dev/a (reader has NOT acted after it).
    const skipped = sendMessage(senderA, "@dev/reader", "unseen verdict from a", "verdict")
    const seen = sendMessage(senderB, "@dev/reader", "seen verdict from b", "verdict")
    expect(skipped.rowid).toBeLessThan(seen.rowid)

    // Narrowed since+advance read from @dev/b only skips @dev/a's row.
    handleToolCall(
      reader,
      TRIBE_COORD_METHODS.fetch,
      { since: skipped.rowid - 1, from: "@dev/b", advance: true, receipt: true },
      opts,
    )

    const cursor = stmts.getMailboxCursor.get({ $recipient: "@dev/reader" }) as { last_actionable_seq: number } | null
    expect(cursor === null || cursor.last_actionable_seq < skipped.rowid).toBe(true)

    const after = readAttentionProjection(reader, "@dev/reader", Date.now(), 0, opts).attention
    expect(after.actionable_unread.map((r) => r.id)).toContain(skipped.id)
  })
})
