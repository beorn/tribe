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
type Row = { request_id: string; message_id: string; superseded_count?: number; settlement?: string | null }

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
})
