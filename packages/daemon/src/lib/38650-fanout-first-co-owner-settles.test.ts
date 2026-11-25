/**
 * @failure A fanout:'first' request settled by one owner (a manual close, or the
 *          emitter's clear) leaves every OTHER owner's `pending_request` row in
 *          place, so that owner's copy renders as an owed ball forever: the
 *          tracked branch of `selectAttention` re-presents an untaken ball past
 *          the mailbox cursor on purpose (22203) and no read can clear it. The
 *          live report (@chief, 2026-11-25 19:40Z, request 348785e7): the row
 *          renders settled:true, by_another_owner:true, and inbox-status still
 *          counts unread=1 on every turn end.
 * @level    l2
 * @consumer tribe.fetch attention; tools/tribe-idle-attention-hook.ts (turn end)
 * @testonly none
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

const PROJECT_ID = "38650-co-owner-settles"

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

function makeOpts(): HandlerOpts {
  const ids = ["sess-chief", "sess-cto", "sess-chat"]
  return {
    cleanup: () => undefined,
    userRenamed: false,
    setUserRenamed: () => undefined,
    getActiveSessionIds: () => new Set(ids),
    hasActiveTransport: (sessionId) => ids.includes(sessionId),
    isReconnectGraceProtected: () => false,
    getActiveSessionInfo: () => [],
  }
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Record<string, unknown>
}

describe("#38650 one owner settling a fanout:first ball releases the co-owner", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements
  let chief: TribeContext
  let cto: TribeContext
  let chat: TribeContext
  const opts = () => makeOpts()

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "38650-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
    chief = makeContext(db, stmts, "@chief", "sess-chief")
    cto = makeContext(db, stmts, "@cto", "sess-cto")
    chat = makeContext(db, stmts, "@chief/chat", "sess-chat")
    for (const [ctx, pid] of [
      [chief, 1001],
      [cto, 1002],
      [chat, 1003],
    ] as const) {
      registerSession(ctx, PROJECT_ID, () => true, null, pid, "push", "/repo", null, "claude", null, null)
      db.prepare("UPDATE sessions SET identity_sid = ?, identity_gen = 1 WHERE id = ?").run(
        `sid-${ctx.sessionId}`,
        ctx.sessionId,
      )
    }
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const sendBall = (): string => {
    const sent = parseToolJson(
      handleToolCall(
        chat,
        "tribe.send",
        {
          to: ["@chief", "@cto"],
          message: "who takes the seed report?",
          type: "request",
          request: true,
          fanout: "first",
          summary: "who takes the seed report?",
        },
        opts(),
      ),
    )
    const requestId = (sent.request_id ?? sent.id) as string
    expect(typeof requestId).toBe("string")
    const opened = stmts.selectPendingSettlementsForRequest.all({ $request_id: requestId }) as Array<{
      recipient: string
    }>
    expect(opened.map((row) => row.recipient).sort()).toEqual(["@chief", "@cto"])
    return requestId
  }

  it("a response settles both owners' rows and the co-owner's attention is empty", () => {
    const requestId = sendBall()
    const reply = parseToolJson(
      handleToolCall(
        cto,
        "tribe.send",
        { to: "@chief/chat", message: "I take it", type: "response", reply: requestId },
        opts(),
      ),
    )
    expect(reply.tracker).toMatchObject({ closed: 2 })
    expect(stmts.selectPendingSettlementsForRequest.all({ $request_id: requestId })).toEqual([])
    handleToolCall(chief, "tribe.fetch", {}, opts())
    expect(stmts.countUnackedAttention.get({ $name: "@chief" })).toEqual({ count: 0 })
  })

  it("a manual close by one owner releases the co-owner's row too", () => {
    const requestId = sendBall()
    parseToolJson(handleToolCall(cto, "tribe.pending", { close: requestId }, opts()))
    expect(stmts.selectPendingSettlementsForRequest.all({ $request_id: requestId })).toEqual([])
    handleToolCall(chief, "tribe.fetch", {}, opts())
    expect(stmts.countUnackedAttention.get({ $name: "@chief" })).toEqual({ count: 0 })
  })
})
