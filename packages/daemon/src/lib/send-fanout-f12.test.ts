/**
 * F12 (#30913, @cto 8b22f164):
 * A request, query, or assign with more than one recipient (or broadcast "*")
 * and no explicit --fanout is refused by name; nothing is sent.
 */
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type ActiveSessionInfo, type HandlerOpts } from "./handlers.ts"
import { registerSession } from "./session.ts"

const PROJECT_ID = "send-fanout-f12"
const F12_EXPECTED_REASON =
  "several recipients: pass --fanout all (each owes an answer) or --fanout first (any one answer settles it)"

function makeContext(db: Database, stmts: TribeStatements, sessionId: string, name: string): TribeContext {
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

function addVerifiedSession(db: Database, stmts: TribeStatements, sessionId: string, name: string): TribeContext {
  const ctx = makeContext(db, stmts, sessionId, name)
  registerSession(ctx, PROJECT_ID, () => false, null, process.pid, "pull", "/repo", null, "codex", null, null)
  db.run("UPDATE sessions SET identity_sid = ?, mailbox_authority_hash = ? WHERE id = ?", [
    `sid-${sessionId}`,
    createHash("sha256").update(sessionId).digest("hex"),
    sessionId,
  ])
  return ctx
}

function nonEventMessageCount(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind <> 'event'").get() as { n: number }).n
}

function pendingCount(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM pending_request").get() as { n: number }).n
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Record<string, unknown>
}

function liveInfo(id: string, name: string): ActiveSessionInfo {
  return {
    id,
    name,
    pid: process.pid,
    cwd: "/repo",
    role: "member",
    claudeSessionId: null,
    registeredAt: Date.now(),
    launchId: null,
    launchParentPid: null,
    transportPids: [process.pid],
    pushTransportPids: [],
  }
}

function makeOpts(info: ActiveSessionInfo[]): HandlerOpts {
  const ids = new Set(info.map((row) => row.id))
  return {
    cleanup: () => undefined,
    userRenamed: false,
    setUserRenamed: () => undefined,
    getActiveSessionIds: () => ids,
    hasActiveTransport: (id) => ids.has(id),
    isReconnectGraceProtected: () => false,
    getActiveSessionInfo: () => info,
  }
}

describe("F12 (#30913): multi-recipient request/query/assign requires explicit --fanout", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements
  let chief: TribeContext
  let agent1: TribeContext
  let agent2: TribeContext
  let opts: HandlerOpts

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), `${PROJECT_ID}-`))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
    chief = addVerifiedSession(db, stmts, "sess-chief", "@chief")
    agent1 = addVerifiedSession(db, stmts, "sess-agent-1", "@agent/1")
    agent2 = addVerifiedSession(db, stmts, "sess-agent-2", "@agent/2")
    opts = makeOpts([
      liveInfo("sess-chief", "@chief"),
      liveInfo("sess-agent-1", "@agent/1"),
      liveInfo("sess-agent-2", "@agent/2"),
    ])
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  /**
   * @failure Multi-recipient request/query/assign silently defaults to fanout first, closing other owners' balls on the first reply (#30913).
   * @level l2
   * @consumer Any caller sending a tracked multi-recipient message through MCP or CLI.
   * @seam handleSend validation before message persistence or ball opening.
   */
  it.each(["request", "query", "assign"] as const)(
    "refuses two recipients for type=%s with no fanout and stores nothing",
    (type) => {
      const res = parseToolJson(
        handleToolCall(
          chief,
          "tribe.send",
          {
            to: ["@agent/1", "@agent/2"],
            type,
            message: "Please review this change and report back with your findings.",
            summary: "Review requested from both owners",
          },
          opts,
        ),
      )

      expect(res.error).toBe(`tribe.send: ${F12_EXPECTED_REASON}`)
      expect(res.sent).toBeUndefined()
      expect(nonEventMessageCount(db)).toBe(0)
      expect(pendingCount(db)).toBe(0)
    },
  )

  it("refuses comma-separated multi-recipient request with omitted or null fanout and stores nothing", () => {
    const omitted = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        {
          to: "@agent/1,@agent/2",
          type: "request",
          message: "Please review this change and report back with your findings.",
          summary: "Review requested",
        },
        opts,
      ),
    )
    expect(omitted.error).toBe(`tribe.send: ${F12_EXPECTED_REASON}`)

    const explicitNull = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        {
          to: ["@agent/1", "@agent/2"],
          type: "request",
          fanout: null,
          message: "Please review this change and report back with your findings.",
          summary: "Review requested",
        },
        opts,
      ),
    )
    expect(explicitNull.error).toBe(`tribe.send: ${F12_EXPECTED_REASON}`)
    expect(nonEventMessageCount(db)).toBe(0)
    expect(pendingCount(db)).toBe(0)
  })

  it("refuses an invalid fanout value by name and stores nothing", () => {
    const res = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        {
          to: ["@agent/1", "@agent/2"],
          type: "request",
          fanout: "every",
          message: "Please review this change and report back with your findings.",
          summary: "Review requested",
        },
        opts,
      ),
    )
    expect(res.error).toBe("tribe.send: invalid fanout 'every' - expected one of: first, all")
    expect(nonEventMessageCount(db)).toBe(0)
    expect(pendingCount(db)).toBe(0)
  })

  it("refuses broadcast '*' request/query/assign without fanout unless solicitation=true", () => {
    const refused = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        {
          to: "*",
          type: "request",
          message: "Everyone check your local tree and reply with your current branch.",
          summary: "Broadcast check",
        },
        opts,
      ),
    )
    expect(refused.error).toBe(`tribe.send: ${F12_EXPECTED_REASON}`)
    expect(nonEventMessageCount(db)).toBe(0)
    expect(pendingCount(db)).toBe(0)

    const solicited = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        {
          to: "*",
          type: "request",
          solicitation: true,
          message: "Who owns the leftover scratch worktree? Claim only if it is yours.",
          summary: "Scratch owner check",
        },
        opts,
      ),
    )
    expect(solicited.sent).toBe(true)
  })

  it("with --fanout all opens one ball per recipient and one answer closes only its own", () => {
    const opened = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        {
          to: ["@agent/1", "@agent/2"],
          type: "request",
          fanout: "all",
          message: "Each owner must review the migration and reply independently.",
          summary: "Independent review from both owners",
        },
        opts,
      ),
    )
    expect(opened.sent).toBe(true)
    const requestId = opened.request_id as string
    expect(typeof requestId).toBe("string")

    const beforeRows = db
      .prepare("SELECT recipient, fanout FROM pending_request WHERE request_id = ? ORDER BY recipient")
      .all(requestId) as Array<{ recipient: string; fanout: string }>
    expect(beforeRows).toEqual([
      { recipient: "@agent/1", fanout: "all" },
      { recipient: "@agent/2", fanout: "all" },
    ])

    const reply = parseToolJson(
      handleToolCall(
        agent1,
        "tribe.send",
        {
          to: "@chief",
          type: "response",
          reply: requestId,
          message: "Reviewed my half of the migration; no blocking issues found.",
          summary: "agent/1 review done",
        },
        opts,
      ),
    )
    expect(reply.sent).toBe(true)

    const afterRows = db
      .prepare("SELECT recipient FROM pending_request WHERE request_id = ? ORDER BY recipient")
      .all(requestId) as Array<{ recipient: string }>
    expect(afterRows).toEqual([{ recipient: "@agent/2" }])
  })

  it("with --fanout first lets the first answer settle every owner", () => {
    const opened = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        {
          to: ["@agent/1", "@agent/2"],
          type: "request",
          fanout: "first",
          message: "Whichever seat is free first, please pick up this verification task.",
          summary: "First available seat take verification",
        },
        opts,
      ),
    )
    expect(opened.sent).toBe(true)
    const requestId = opened.request_id as string

    handleToolCall(
      agent2,
      "tribe.send",
      {
        to: "@chief",
        type: "response",
        reply: requestId,
        message: "Taking the verification task now and will post the proof shortly.",
        summary: "agent/2 took it",
      },
      opts,
    )

    const remaining = db.prepare("SELECT recipient FROM pending_request WHERE request_id = ?").all(requestId) as Array<{
      recipient: string
    }>
    expect(remaining).toEqual([])
  })

  it("leaves a single recipient unchanged without fanout (string, one-element array, and deduped duplicate array)", () => {
    const single = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        {
          to: "@agent/1",
          type: "request",
          message: "Please verify the release checklist and reply with the result.",
          summary: "Verify release checklist",
        },
        opts,
      ),
    )
    expect(single.sent).toBe(true)
    const rows = db
      .prepare("SELECT recipient FROM pending_request WHERE request_id = ?")
      .all(single.request_id as string) as Array<{ recipient: string }>
    expect(rows).toEqual([{ recipient: "@agent/1" }])

    const oneElemArray = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        {
          to: ["@agent/1"],
          type: "request",
          message: "One-element recipient array should deliver as a single recipient.",
          summary: "Single-element array check",
        },
        opts,
      ),
    )
    expect(oneElemArray.sent).toBe(true)
    expect(
      db.prepare("SELECT recipient FROM pending_request WHERE request_id = ?").all(oneElemArray.request_id as string),
    ).toEqual([{ recipient: "@agent/1" }])

    const dedupedArray = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        {
          to: ["@agent/1", "@agent/1"],
          type: "request",
          message: "Duplicate single recipient should dedup and deliver without fanout.",
          summary: "Deduped single recipient check",
        },
        opts,
      ),
    )
    expect(dedupedArray.sent).toBe(true)
    expect(
      db.prepare("SELECT recipient FROM pending_request WHERE request_id = ?").all(dedupedArray.request_id as string),
    ).toEqual([{ recipient: "@agent/1" }])
  })

  it("leaves multi-recipient notify and status unchanged without fanout", () => {
    const notifyRes = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        {
          to: ["@agent/1", "@agent/2"],
          type: "notify",
          message: "Main is green again after the hotfix landed.",
          summary: "Main is green",
        },
        opts,
      ),
    )
    expect(notifyRes.sent).toBe(true)

    const statusRes = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        {
          to: ["@agent/1", "@agent/2"],
          type: "status",
          message: "Deploy progress: step 2 of 3 completed cleanly.",
          summary: "Deploy step 2 done",
        },
        opts,
      ),
    )
    expect(statusRes.sent).toBe(true)
  })
})
