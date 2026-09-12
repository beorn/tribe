/**
 * 24581 — refuse a TRACKED ball on a recipient whose
 * mailbox_read_capability.state is unavailable. Untracked notify to a
 * relay still delivers. Names with no sessions row keep the existing
 * unresolved/offline path (not this rule).
 */
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type ActiveSessionInfo, type HandlerOpts } from "./handlers.ts"
import { registerSession } from "./session.ts"

const PROJECT_ID = "pending-mailbox-deaf-send"
const VALID_HASH = "ab".repeat(32)

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

function addSession(
  db: Database,
  stmts: TribeStatements,
  sessionId: string,
  name: string,
  mailboxAuthorityHash: string | null,
): void {
  const ctx = makeContext(db, stmts, sessionId, name)
  registerSession(
    ctx,
    PROJECT_ID,
    () => false,
    null,
    process.pid,
    "pull",
    "/repo",
    null,
    "codex",
    null,
    null,
    mailboxAuthorityHash,
  )
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
  }
}

function optsWithLive(info: ActiveSessionInfo[]): HandlerOpts {
  const ids = new Set(info.map((row) => row.id))
  return {
    cleanup: () => undefined,
    userRenamed: false,
    setUserRenamed: () => undefined,
    getActiveSessionIds: () => ids,
    hasActiveTransport: (id) => ids.has(id),
    getActiveSessionInfo: () => info,
  }
}

describe("24581: tracked send to mailbox-deaf recipient is refused", () => {
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

  it("refuses a tracked request to telegram (connected, mailbox authority missing)", () => {
    addSession(db, stmts, "sess-telegram", "telegram", null)
    const sender = makeContext(db, stmts, "sess-dev12", "@dev/12")
    const sent = parseToolJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: "telegram", message: "who holds admission", type: "request" },
        optsWithLive([liveInfo("sess-telegram", "telegram")]),
      ),
    )
    expect(String(sent.error ?? "")).toContain("mailbox_read_capability.state is unavailable")
    expect(String(sent.error ?? "")).toContain("self-mailbox-authority-missing")
    const remaining = stmts.selectPendingForRecipient.all({ $recipient: "telegram" }) as unknown[]
    expect(remaining).toHaveLength(0)
  })

  it("delivers an untracked notify to telegram and opens no ball", () => {
    addSession(db, stmts, "sess-telegram", "telegram", null)
    const sender = makeContext(db, stmts, "sess-dev12", "@dev/12")
    const sent = parseToolJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: "telegram", message: "status only", type: "notify" },
        optsWithLive([liveInfo("sess-telegram", "telegram")]),
      ),
    )
    expect(sent.error).toBeUndefined()
    expect(sent.sent).toBe(true)
    const remaining = stmts.selectPendingForRecipient.all({ $recipient: "telegram" }) as unknown[]
    expect(remaining).toHaveLength(0)
  })

  it("NEGATIVE: tracked request to a seat with registered mailbox authority still opens", () => {
    addSession(db, stmts, "sess-dev6", "@dev/6", VALID_HASH)
    const sender = makeContext(db, stmts, "sess-dev12", "@dev/12")
    const sent = parseToolJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: "@dev/6", message: "work", type: "request" },
        optsWithLive([liveInfo("sess-dev6", "@dev/6")]),
      ),
    )
    expect(sent.error).toBeUndefined()
    const remaining = stmts.selectPendingForRecipient.all({ $recipient: "@dev/6" }) as unknown[]
    expect(remaining).toHaveLength(1)
  })
})
