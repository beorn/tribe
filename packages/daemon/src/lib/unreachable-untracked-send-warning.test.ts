/**
 * @failure a targeted notify/status to a seat with no answer-capable transport
 *          still returns sent:true with no warning, so the sender believes an
 *          obligation exists (24526 specimen 3: @dev/10 waited on @ci).
 * @level l1
 * @consumer @i/2-agent-launch/24526
 *
 * CTO ruling: warn, never refuse. Broadcasts excluded. Discriminator is both
 * arms — a dark recipient warns, an answer-capable one does not — or the
 * warning could be firing on everything.
 */

import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type ActiveSessionInfo, type HandlerOpts } from "./handlers.ts"

const SENDER = "@dev/12"
const LIVE = "@chief"
const DARK = "@ci"

function makeContext(db: Database, stmts: TribeStatements): TribeContext {
  return createTribeContext({
    db,
    stmts,
    sessionId: "sess-sender",
    sessionRole: "member",
    initialName: SENDER,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
}

function liveInfo(name: string, id: string): ActiveSessionInfo {
  return {
    id,
    name,
    pid: process.pid,
    cwd: "/repo",
    role: "member",
    claudeSessionId: null,
    registeredAt: Date.now(),
    launchId: null,
    launchParentPid: process.pid,
    transportPids: [process.pid],
  }
}

function makeOpts(active: ActiveSessionInfo[] = []): HandlerOpts {
  return {
    cleanup: () => undefined,
    userRenamed: false,
    setUserRenamed: () => undefined,
    getActiveSessionIds: () => new Set(active.map((row) => row.id)),
    hasActiveTransport: (sessionId) => active.some((row) => row.id === sessionId),
    getActiveSessionInfo: () => active,
  }
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Record<string, unknown>
}

describe("tribe.send unreachable untracked warning", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-send-unreachable-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("warns on notify to a dark recipient and stays silent for an answer-capable one", () => {
    const ctx = makeContext(db, stmts)
    const live = [liveInfo(LIVE, "sess-chief")]

    const dark = parseToolJson(
      handleToolCall(
        ctx,
        "tribe.send",
        { to: DARK, message: "please admit this head", type: "notify", summary: "admission wait" },
        makeOpts(),
      ),
    )
    expect(dark.sent).toBe(true)
    expect(dark.error).toBeUndefined()
    expect(String(dark.warning)).toContain("not answer-capable")
    expect(String(dark.warning)).toContain("opens no obligation")
    expect(String(dark.warning)).toContain("pages nobody")
    expect(String(dark.warning)).toMatch(/type=request|request/)

    const liveSend = parseToolJson(
      handleToolCall(
        ctx,
        "tribe.send",
        { to: LIVE, message: "please admit this head", type: "notify", summary: "admission wait" },
        makeOpts(live),
      ),
    )
    expect(liveSend.sent).toBe(true)
    expect(liveSend.error).toBeUndefined()
    expect(liveSend.warning).toBeUndefined()
  })

  it("warns on status the same way, excludes broadcasts, and still delivers", () => {
    const ctx = makeContext(db, stmts)
    const status = parseToolJson(
      handleToolCall(
        ctx,
        "tribe.send",
        { to: DARK, message: "holding a ball", type: "status", summary: "blocked on ci" },
        makeOpts(),
      ),
    )
    expect(status.sent).toBe(true)
    expect(String(status.warning)).toContain("not answer-capable")
    expect(String(status.warning)).toContain("status")

    const broadcast = parseToolJson(
      handleToolCall(
        ctx,
        "tribe.send",
        { to: "*", message: "fleet note", type: "notify", summary: "ambient" },
        makeOpts(),
      ),
    )
    expect(broadcast.sent).toBe(true)
    expect(broadcast.warning).toBeUndefined()

    const stored = db.prepare("SELECT recipient, type FROM messages WHERE id = ?").get(status.id as string) as {
      recipient: string
      type: string
    }
    expect(stored).toMatchObject({ recipient: DARK, type: "status" })
  })
})
