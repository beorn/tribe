/**
 * @failure tribe.join called with no name throws a TypeError ("undefined is not an object (evaluating
 *          'name.length')") instead of joining, and a raw socket's `pending-<connId>` transport name
 *          could become a session name that the send gates then read as pre-registration.
 * @level l2
 * @consumer Every agent's first call: the stdio adapter's `tribe.join` (and `/up`), through handlers.ts.
 * @testonly none
 * 38020: seen live on the fleet as `unknown-2qe10` — join answered a TypeError while the socket still
 * registered. A named join keeps its explicit name; a nameless one keeps the registered `unknown-<rand>`
 * placeholder, or draws one when the connection is still `pending-<connId>`.
 */
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"
import { registerSession } from "./session.ts"

const SESSION_ID = "sess-join-no-name"
const PROJECT_ID = "join-no-name-proj"

type ToolJson = Record<string, unknown>

function makeContext(db: Database, stmts: TribeStatements, initialName: string): TribeContext {
  return createTribeContext({
    db,
    stmts,
    sessionId: SESSION_ID,
    sessionRole: "member",
    initialName,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
}

function makeOpts(): HandlerOpts {
  return {
    cleanup: () => {},
    userRenamed: false,
    setUserRenamed: () => {},
    getActiveSessionIds: () => new Set([SESSION_ID]),
    hasActiveTransport: (sessionId) => sessionId === SESSION_ID,
    isReconnectGraceProtected: () => false,
    getActiveSessionInfo: () => [],
  }
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): ToolJson {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as ToolJson
}

function sessionName(db: Database): string | undefined {
  return (db.prepare("SELECT name FROM sessions WHERE id = ?").get(SESSION_ID) as { name: string } | null)?.name
}

describe("#38020: tribe.join with no name", () => {
  let db: Database
  let stmts: TribeStatements
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tribe-join-no-name-"))
    db = openDatabase(join(dir, "tribe.sqlite"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("joins a registered unnamed session under the unknown-<rand> placeholder it already holds", () => {
    const ctx = makeContext(db, stmts, "unknown-x7k2q")
    registerSession(ctx, PROJECT_ID, () => true, null, process.pid, "pull", "/tmp/km")

    const joined = parseToolJson(handleToolCall(ctx, "tribe.join", {}, makeOpts()))

    expect(joined.error).toBeUndefined()
    expect(joined.joined).toBe(true)
    expect(joined.name).toBe("unknown-x7k2q")
    expect(sessionName(db)).toBe("unknown-x7k2q")
  })

  it("never adopts the pending-<connId> transport name; a socket that has not registered joins as unknown-<rand>", () => {
    const ctx = makeContext(db, stmts, "pending-2c4f")

    const joined = parseToolJson(handleToolCall(ctx, "tribe.join", {}, makeOpts()))

    expect(joined.error).toBeUndefined()
    expect(joined.joined).toBe(true)
    expect(joined.name).toMatch(/^unknown-[a-z0-9]{5}$/u)
    expect(sessionName(db)).not.toMatch(/^pending-/u)
  })

  it("an explicit name still wins over both defaults", () => {
    const ctx = makeContext(db, stmts, "pending-2c4f")

    const joined = parseToolJson(handleToolCall(ctx, "tribe.join", { name: "@agent/4" }, makeOpts()))

    expect(joined.error).toBeUndefined()
    expect(joined.name).toBe("@agent/4")
    expect(sessionName(db)).toBe("@agent/4")
  })
})
