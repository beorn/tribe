/**
 * @failure A request sent with --ref, answered with response + reply, settles zero rows while
 *          tribe.pending lists the same ball as owed — or an unmatched reply id settles silently.
 * @level l2
 * @consumer The ball tracker: reply settlement in messaging.ts / handlers.ts and the pending listing.
 * @testonly none
 * 27229: a reply to a referenced request must report closed 1 and unlist it; an id matching no ball
 * must return closed 0 WITH a cause and reply_close_failed, never a silent zero. Live specimen
 * (2026-10-03): the reply carried a hybrid id (request first group + ref tail) that was never a ball.
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

const PROJECT_ID = "27229-reply-settle-ref"
const REQUEST_ID = "1ecd527e-3544-4e9d-a3de-1d9f78df2673"
const REF = "eb79ed59-f45e-4490-93f7-2b0d8da0809e"

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
    ["sess-chief", "@chief"],
    ["sess-agent-1", "@agent/1"],
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
        pushTransportPids: [],
      })),
  }
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Record<string, unknown>
}

describe("#27229 a reply to a referenced request settles its listed ball", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements
  let chief: TribeContext
  let agent1: TribeContext
  const opts = () => makeOpts(["sess-chief", "sess-agent-1"])

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "27229-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
    chief = makeContext(db, stmts, "@chief", "sess-chief")
    agent1 = makeContext(db, stmts, "@agent/1", "sess-agent-1")
    registerSession(chief, PROJECT_ID, () => true, null, 1001, "push", "/repo", null, "claude", null, null)
    registerSession(agent1, PROJECT_ID, () => true, null, 1002, "push", "/repo", null, "claude", null, null)
    const sid = "sid-"
    db.prepare("UPDATE sessions SET identity_sid = ?, identity_gen = 1 WHERE id = ?").run(
      sid + chief.sessionId,
      chief.sessionId,
    )
    db.prepare("UPDATE sessions SET identity_sid = ?, identity_gen = 1 WHERE id = ?").run(
      sid + agent1.sessionId,
      agent1.sessionId,
    )
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("A: explicit request id + ref; reply with the request id settles", () => {
    const sent = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        {
          to: "@agent/1",
          message: "27178: full final scoped guard receipt needed",
          type: "request",
          request: REQUEST_ID,
          ref: REF,
          summary: "27178: full final scoped guard receipt needed",
        },
        opts(),
      ),
    )
    const pending = parseToolJson(handleToolCall(agent1, "tribe.pending", { owner: "@agent/1" }, opts()))
    const reply = parseToolJson(
      handleToolCall(
        agent1,
        "tribe.send",
        { to: "@chief", message: "CUSTODY DELIVERED", type: "response", reply: REQUEST_ID },
        opts(),
      ),
    )
    expect(reply.tracker).toMatchObject({ closed: 1 })
  })

  it("B: implicit request (request:true) + ref; reply with the message id settles", () => {
    const sent = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        { to: "@agent/1", message: "answer me", type: "request", request: true, ref: REF },
        opts(),
      ),
    )
    const messageId = (sent.request_id ?? sent.id) as string
    const pending = parseToolJson(handleToolCall(agent1, "tribe.pending", { owner: "@agent/1" }, opts()))
    const reply = parseToolJson(
      handleToolCall(
        agent1,
        "tribe.send",
        { to: "@chief", message: "answered", type: "response", reply: messageId },
        opts(),
      ),
    )
    expect(reply.tracker).toMatchObject({ closed: 1 })
  })

  it("C: auto-tracked request carrying --ref; reply by message id settles and unlists", () => {
    const sent = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        {
          to: "@agent/1",
          message: "auto-tracked with a ref",
          type: "request",
          ref: REF,
          summary: "auto-tracked with a ref",
        },
        opts(),
      ),
    )
    const ballId = (sent.request_id ?? sent.id) as string
    expect(typeof ballId).toBe("string")
    const before = parseToolJson(handleToolCall(agent1, "tribe.pending", { owner: "@agent/1" }, opts()))
    const listsBefore = (before.pending as Array<{ request_id: string }>).some((p) => p.request_id === ballId)
    expect(listsBefore).toBe(true)
    const reply = parseToolJson(
      handleToolCall(
        agent1,
        "tribe.send",
        { to: "@chief", message: "answered", type: "response", reply: ballId },
        opts(),
      ),
    )
    expect(reply.tracker).toMatchObject({ closed: 1 })
    const after = parseToolJson(handleToolCall(agent1, "tribe.pending", { owner: "@agent/1" }, opts()))
    const listsAfter = (after.pending as Array<{ request_id: string }>).some((p) => p.request_id === ballId)
    expect(listsAfter).toBe(false)
  })

  it("D: an unmatched reply id settles 0 loudly (cause + reply_close_failed), never silently", () => {
    const reply = parseToolJson(
      handleToolCall(
        agent1,
        "tribe.send",
        { to: "@chief", message: "typo id", type: "response", reply: "00000000-0000-4000-8000-000000000000" },
        opts(),
      ),
    )
    expect(reply.tracker).toMatchObject({ closed: 0 })
    expect(typeof (reply.tracker as { cause?: string }).cause).toBe("string")
    expect(reply.reply_close_failed).toBe(true)
  })
})
