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

import tribeHabModule from "../../../../hab.projects.ts"
import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { prefixFallbackDeliveryResolver } from "./delivery-resolution.ts"
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

  /**
   * @failure A tracked request falls back to a connected owner who cannot read it.
   * @level l2
   * @consumer Requests using the deployed @ci -> @chief fallback policy.
   */
  it.each([
    ["unreadable", null, 0],
    ["readable", VALID_HASH, 1],
  ] as const)("checks the %s final owner before opening a fallback ball", (_state, hash, expectedBalls) => {
    addSession(db, stmts, "sess-chief", "@chief", hash)
    const sender = makeContext(db, stmts, "sess-dev12", "@dev/12")
    const sent = parseToolJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: "@ci", message: "who holds admission", type: "request" },
        {
          ...optsWithLive([liveInfo("sess-chief", "@chief")]),
          resolveDelivery: prefixFallbackDeliveryResolver(tribeHabModule.services.wire.env.TRIBE_DELIVERY_FALLBACKS),
        },
      ),
    )
    expect(stmts.selectPendingForRecipient.all({ $recipient: "@chief" })).toHaveLength(expectedBalls)
    if (expectedBalls === 0) {
      expect(sent.error).toContain('"@chief"')
      expect(sent.error).toContain("mailbox_read_capability.state is unavailable")
      expect(sent.error).toContain('"@ci"')
      expect(sent.error).toContain("self-mailbox-authority-missing")
      expect(sent.error).toContain('Restore mailbox authority for "@chief"')
      expect(
        db.prepare("SELECT id FROM messages WHERE kind = 'direct' AND content = ?").get("who holds admission"),
      ).toBeNull()
    } else {
      expect(sent.error).toBeUndefined()
      expect(sent.sent).toBe(true)
    }
  })
})
