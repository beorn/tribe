/**
 * The expired view renders journal history as open obligations — pre-fix RED.
 *
 * A standing incident re-sends one condition across generations, each under a
 * fresh message id. Every generation's deadline fact stays keyed by that
 * message id, so the read fold — keyed [request_id, recipient, message_id] —
 * renders per-message HISTORY as per-obligation POPULATION: the live pile
 * showed 255 rows for 198 identities, fifteen for one wait-watch condition,
 * and 200 of them unanswered ghosts no close can reach (closed 0 rows —
 * there is no pending_request row behind them).
 *
 * Contract pinned here: one obligation per (request_id, recipient) — the
 * LATEST generation — with the rest disclosed as superseded_count, never
 * multiplied into phantom obligations.
 *
 * Second half of the contract (chief's verdict on the same incident): the
 * distinction a reader needs is "still needs a decision from me" versus
 * "overtaken by events". Each row carries backing: "live" (a pending_request
 * row still stands behind it — genuinely owed) or "journal" (history), and
 * owed: true filters the view to the live-backed rows. That filter is the
 * coordinator's needs-a-decision query.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"
import { logEvent } from "./messaging.ts"

type ToolJson = Record<string, unknown>
type Row = {
  request_id: string
  message_id: string
  superseded_count?: number
  settlement?: string | null
  backing?: string
}

function makeOpts(): HandlerOpts {
  return {
    cleanup: () => undefined,
    userRenamed: false,
    setUserRenamed: () => undefined,
    getActiveSessionIds: () => new Set(["sess-chief"]),
    hasActiveTransport: (sessionId) => sessionId === "sess-chief",
    getActiveSessionInfo: () => [],
  }
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): ToolJson {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as ToolJson
}

describe("expired view collapses generations of one obligation", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "expired-collapse-"))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function setup() {
    const db = openDatabase(join(tmpDir, "tribe.db"))
    const stmts = createStatements(db)
    const ctx = createTribeContext({
      db,
      stmts,
      sessionId: "sess-chief",
      sessionRole: "member",
      initialName: "@chief",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    return { db, stmts, ctx }
  }

  /** The exact fact shape recordExpiredPendingRequests journals per boundary. */
  function journalExpiry(
    ctx: ReturnType<typeof createTribeContext>,
    req: string,
    messageId: string,
    openedAt: number,
  ): void {
    logEvent(
      ctx,
      "ball.expired",
      undefined,
      {
        schema_version: 2,
        request_id: req,
        recipient: "@chief",
        sender: "@watcher",
        opened_at: openedAt,
        expires_at: openedAt + 1000,
        message_id: messageId,
        fanout: "first",
        summary: `generation ${messageId}`,
        observation: "deadline-passed",
        observed_at: openedAt + 1500,
      },
      { sender: "daemon", ref: req, ts: openedAt + 1500 },
    )
  }

  it("three generations of one condition render as ONE obligation, history disclosed", () => {
    const { ctx } = setup()
    const REQ = "wait-watch:seat @chief:demand-unconsumed"
    journalExpiry(ctx, REQ, "gen-m1", 1000)
    journalExpiry(ctx, REQ, "gen-m2", 61000)
    journalExpiry(ctx, REQ, "gen-m3", 121000)

    const res = parseToolJson(handleToolCall(ctx, "tribe.pending", { owner: "@chief", expired: true }, makeOpts()))
    const rows = ((res.pending ?? []) as Row[]).filter((r) => r.request_id === REQ)

    expect(rows).toHaveLength(1)
    expect(rows[0]!.message_id).toBe("gen-m3")
    expect(rows[0]!.superseded_count).toBe(2)
    expect(rows[0]!.backing).toBe("journal")
    // Content is the newest generation; the AGE is the condition's whole
    // standing life — owed since the first opening.
    expect((rows[0] as unknown as { opened_at: string }).opened_at).toBe(new Date(1000).toISOString())
  })

  it("distinct obligations do not collapse into each other", () => {
    const { ctx } = setup()
    journalExpiry(ctx, "wait-watch:seat @dev/1:demand-unconsumed", "a-m1", 1000)
    journalExpiry(ctx, "wait-watch:seat @dev/2:demand-unconsumed", "b-m1", 2000)

    const res = parseToolJson(handleToolCall(ctx, "tribe.pending", { owner: "@chief", expired: true }, makeOpts()))
    const rows = (res.pending ?? []) as Row[]

    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.superseded_count === 0)).toBe(true)
  })

  it("owed keeps only live-backed obligations; journal rows are history", () => {
    const { ctx, stmts } = setup()
    const now = Date.now()
    // Genuinely owed: a live request whose declared deadline has passed —
    // with an OLDER journal generation of the same condition that must fold
    // under it rather than render as a second obligation.
    stmts.openPendingRequest.run({
      $request_id: "live-req",
      $recipient: "@chief",
      $sender: "@watcher",
      $opened_at: now - 3_600_000,
      $expires_at: now - 60_000,
      $message_id: "live-m1",
      $fanout: "first",
    })
    journalExpiry(ctx, "live-req", "live-m0", 1000)
    // History, unsettled: a journal fact with no row behind it — the ghost
    // class no close can reach.
    journalExpiry(ctx, "ghost-req", "ghost-m1", 2000)
    // History, settled: a live expired ball closed through the real path,
    // leaving only its settlement fact.
    stmts.openPendingRequest.run({
      $request_id: "settled-req",
      $recipient: "@chief",
      $sender: "@watcher",
      $opened_at: now - 7_200_000,
      $expires_at: now - 3_600_000,
      $message_id: "settled-m1",
      $fanout: "first",
    })
    handleToolCall(ctx, "tribe.pending", { close: "settled-req" }, makeOpts())

    const owedView = parseToolJson(
      handleToolCall(ctx, "tribe.pending", { owner: "@chief", expired: true, owed: true }, makeOpts()),
    )
    const owedRows = (owedView.pending ?? []) as Row[]
    expect(owedRows).toHaveLength(1)
    expect(owedRows[0]!.request_id).toBe("live-req")
    expect(owedRows[0]!.backing).toBe("live")
    expect(owedRows[0]!.settlement).toBeNull()
    expect(owedRows[0]!.superseded_count).toBe(1)
    expect(owedView.owed).toBe(true)

    const fullView = parseToolJson(handleToolCall(ctx, "tribe.pending", { owner: "@chief", expired: true }, makeOpts()))
    const fullRows = (fullView.pending ?? []) as Row[]
    expect(fullRows).toHaveLength(3)
    const byId = new Map(fullRows.map((r) => [r.request_id, r]))
    expect(byId.get("live-req")!.backing).toBe("live")
    expect(byId.get("ghost-req")!.backing).toBe("journal")
    expect(byId.get("ghost-req")!.settlement).toBeNull()
    expect(byId.get("settled-req")!.backing).toBe("journal")
    expect(byId.get("settled-req")!.settlement).toBe("manual-close")
  })

  it("owed without expired refuses loudly", () => {
    const { ctx } = setup()
    const res = parseToolJson(handleToolCall(ctx, "tribe.pending", { owed: true }, makeOpts()))
    expect(res.error).toMatch(/owed filters the expired view/)
  })
})
