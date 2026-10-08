/**
 * 24994 — Tests pinning the canonical error shape for tribe.send:
 *   tribe.send: <what failed> - <short plain reason>
 *
 * The long form, with capability names and bead numbers, moves to the log
 * and to `detail`, never to the one line.
 */
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type ActiveSessionInfo, type HandlerOpts } from "./handlers.ts"
import { parseExpectedMembers, type DeclaredRoster } from "./membership-declared-roster.ts"
import { registerSession } from "./session.ts"

const PROJECT_ID = "send-error-shapes"
const VALID_HASH = "cd".repeat(32)

function makeContext(
  db: Database,
  stmts: TribeStatements,
  sessionId: string,
  name: string,
  claudeSessionId: string | null = null,
): TribeContext {
  return createTribeContext({
    db,
    stmts,
    sessionId,
    sessionRole: "member",
    initialName: name,
    domains: [],
    claudeSessionId,
    claudeSessionName: claudeSessionId ? name : null,
  })
}

function addSession(
  db: Database,
  stmts: TribeStatements,
  sessionId: string,
  name: string,
  updatedAt: number = Date.now(),
): void {
  const ctx = makeContext(db, stmts, sessionId, name)
  registerSession(ctx, PROJECT_ID, () => false, null, process.pid, "pull", "/repo", null, "codex", null, null)
  db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [updatedAt, sessionId])
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

function makeOpts(info: ActiveSessionInfo[] = [], expectedMembers?: () => DeclaredRoster | undefined): HandlerOpts {
  const ids = new Set(info.map((row) => row.id))
  return {
    cleanup: () => undefined,
    userRenamed: false,
    setUserRenamed: () => undefined,
    getActiveSessionIds: () => ids,
    hasActiveTransport: (id) => ids.has(id),
    getActiveSessionInfo: () => info,
    getExpectedMembers: expectedMembers,
  }
}

describe("24994: canonical one-line error shape for tribe.send", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), `${PROJECT_ID}-`))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("pins self-mailbox-authority-missing refusal to one line with last seen time and preserves detail", () => {
    const fiveMinsAgo = Date.now() - 5 * 60_000
    addSession(db, stmts, "sess-adhoc", "@adhoc/1", fiveMinsAgo)
    const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
    const sent = parseToolJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: "@adhoc/1", message: "ping", type: "request" },
        makeOpts([liveInfo("sess-adhoc", "@adhoc/1")]),
      ),
    )

    expect(sent.error).toBe("tribe.send: failed to deliver to @adhoc/1 - not online (last seen 5 mins ago)")
    expect(String(sent.detail)).toContain(
      "mailbox_read_capability.state is unavailable (self-mailbox-authority-missing)",
    )
    expect(String(sent.detail)).toContain('Restore mailbox authority for "@adhoc/1"')
  })

  it("pins no-live-transport refusal to one line and preserves detail", () => {
    const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
    const sent = parseToolJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: "@dev/2", message: "ping", type: "request" },
        makeOpts([]), // no session and no live transport
      ),
    )

    expect(sent.error).toBe("tribe.send: failed to deliver to @dev/2 - not online (no connected transport)")
    expect(String(sent.detail)).toContain("no connected, PID-live transport was observed")
  })

  it("pins no-broadcast-owner refusal to one line when no broadcast owners are live", () => {
    const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
    const sent = parseToolJson(
      handleToolCall(sender, "tribe.send", { to: "*", message: "anyone there?", request: true }, makeOpts([])),
    )

    expect(sent.error).toBe("tribe.send: failed to deliver to * - no online recipients")
    expect(String(sent.detail)).toContain("no answer-capable broadcast owner was observed")
  })

  it("pins summary-required refusal to one line for LLM senders omitting summary", () => {
    const sender = makeContext(db, stmts, "sess-llm", "@dev/7", "claude-uuid-1234")
    const sent = parseToolJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: "@chief", message: "hello without summary", type: "notify" },
        makeOpts([]),
      ),
    )

    expect(sent.error).toBe("tribe.send: summary required - author a one-line summary before sending")
  })

  describe("argument validation refusals", () => {
    it("pins invalid to", () => {
      const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
      const sent = parseToolJson(handleToolCall(sender, "tribe.send", { to: "", message: "hi" }, makeOpts()))
      expect(sent.error).toBe("tribe.send: invalid to - must be a non-empty string or array of non-empty strings")
    })

    it("pins invalid delivery", () => {
      const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
      const sent = parseToolJson(
        handleToolCall(sender, "tribe.send", { to: "@chief", message: "hi", delivery: "express" }, makeOpts()),
      )
      expect(sent.error).toBe("tribe.send: invalid delivery - must be 'push' or 'pull'")
    })

    it('refuses an unknown type (a quoted `"request"` from an MCP tool call) and stores nothing', () => {
      // 28200: the daemon accepted any type string, so an agent's tool call
      // carrying a quoted `"request"` was STORED as a type no consumer or ball
      // rule recognises, and the sender believed it had asked. The CLI refuses
      // this (wire/src/cli/send.ts:995); the daemon must too.
      const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
      const sent = parseToolJson(
        handleToolCall(sender, "tribe.send", { to: "@chief", message: "hi", type: '"request"' }, makeOpts([])),
      )

      expect(sent.error).toBe(
        "tribe.send: invalid type '\"request\"' - expected one of: assign, status, query, response, notify, request, verdict",
      )
      const stored = db.query("SELECT COUNT(*) AS n FROM messages WHERE type = '\"request\"'").get() as { n: number }
      expect(stored.n, "a refused type must store nothing").toBe(0)
    })

    it("keeps an explicit null type as omitted -> notify (28200 follow-up)", () => {
      // @cto 74b5accb: the old `(a.type as string) ?? "notify"` turned null into
      // notify, so a harness that serializes an unset optional as null was
      // always stored as notify. The refusal must keep that: only a NON-null
      // unknown value is refused. A census cannot see the null population
      // because those rows are indistinguishable from omitted ones.
      addSession(db, stmts, "sess-chief", "@chief", Date.now())
      const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
      const res = parseToolJson(
        handleToolCall(
          sender,
          "tribe.send",
          { to: "@chief", message: "hi", type: null },
          makeOpts([liveInfo("sess-chief", "@chief")]),
        ),
      )

      expect(res.error).toBeUndefined()
      const stored = db.prepare("SELECT type FROM messages WHERE id = ?").get(res.id as string) as { type: string }
      expect(stored.type).toBe("notify")
    })

    it("still accepts a topic type outside the message-type list (github:push)", () => {
      // The daemon's vocabulary is OPEN: wire's actionable-recovery-journey
      // sends github:push through this path and expects it stored as an ambient
      // row. The 28200 refusal targets a QUOTED value, never the topic
      // namespace, or it would break that contract (the tribe CI red).
      addSession(db, stmts, "sess-chief", "@chief", Date.now())
      const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
      const res = parseToolJson(
        handleToolCall(
          sender,
          "tribe.send",
          { to: "@chief", message: "github ambient", type: "github:push" },
          makeOpts([liveInfo("sess-chief", "@chief")]),
        ),
      )

      expect(res.error).toBeUndefined()
      const stored = db.prepare("SELECT type FROM messages WHERE id = ?").get(res.id as string) as { type: string }
      expect(stored.type).toBe("github:push")
    })

    it("pins invalid request", () => {
      const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
      const sent = parseToolJson(
        handleToolCall(sender, "tribe.send", { to: "@chief", message: "hi", request: 123 }, makeOpts()),
      )
      expect(sent.error).toBe("tribe.send: invalid request - must be true or a non-empty string")
    })

    it("pins invalid request 'true' literal string", () => {
      const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
      const sent = parseToolJson(
        handleToolCall(sender, "tribe.send", { to: "@chief", message: "hi", request: "true" }, makeOpts()),
      )
      expect(sent.error).toBe(
        'tribe.send: invalid request - "true" is reserved for generated tracking, pass boolean true',
      )
    })

    it("pins invalid expires_in_ms", () => {
      const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
      const sent = parseToolJson(
        handleToolCall(sender, "tribe.send", { to: "@chief", message: "hi", expires_in_ms: -50 }, makeOpts()),
      )
      expect(sent.error).toBe("tribe.send: invalid expires_in_ms - must be a positive integer no greater than 86400000")
    })

    it("pins invalid incident shape", () => {
      const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
      const sent = parseToolJson(
        handleToolCall(sender, "tribe.send", { to: "@chief", message: "hi", incident: "not-an-object" }, makeOpts()),
      )
      expect(sent.error).toBe("tribe.send: invalid incident - must be an object {emitter, subject, condition, active?}")
    })
  })
})
