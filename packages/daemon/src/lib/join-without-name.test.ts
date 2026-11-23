/**
 * @failure tribe.join called with no name returns a raw TypeError (or, worse, silently joins/renames the
 *          session) instead of a named isError, and tribe.send with no message throws instead of naming it.
 * @level l2
 * @consumer Every agent's start: the MCP `join` tool and the shared handler boundary every tool call crosses.
 * @testonly none
 * 37247 (@cto ruling 2026-11-23): the published descriptor's `required` list is the contract —
 * command-descriptors.ts declares name required for join (and to+message for send), so the boundary
 * refuses a missing argument by name, changes no identity, and a valid explicit call still works.
 * The retired #38020 reading ("join as unknown-<rand>") is proven dead here.
 */
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { setSuppressConsole } from "loggily"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"
import { registerSession } from "./session.ts"

const SESSION_ID = "sess-join-no-name"
const PROJECT_ID = "join-no-name-proj"

type ToolResultShape = {
  isError?: boolean
  content: Array<{ type: string; text: string }>
  structuredContent?: Record<string, unknown>
}

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

function textOf(result: unknown): string {
  return ((result as ToolResultShape).content[0]?.text ?? "").trim()
}

describe("#37247: a required argument is refused by name at the shared boundary", () => {
  let db: Database
  let stmts: TribeStatements
  let dir: string

  beforeEach(() => {
    setSuppressConsole(true)
    dir = mkdtempSync(join(tmpdir(), "tribe-join-no-name-"))
    db = openDatabase(join(dir, "tribe.sqlite"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    setSuppressConsole(false)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("a nameless join is an isError naming 'name' and touches no identity", async () => {
    const ctx = makeContext(db, stmts, "pending-2c4f")
    const result = (await handleToolCall(ctx, "tribe.join", {}, makeOpts())) as ToolResultShape

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("missing required argument 'name'")
    expect(ctx.getName()).toBe("pending-2c4f")
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 })
  })

  it("a registered session's name survives a nameless join unchanged", async () => {
    const ctx = makeContext(db, stmts, "unknown-x7k2q")
    registerSession(ctx, PROJECT_ID, () => true, null, process.pid, "pull", "/tmp/km")

    const result = (await handleToolCall(ctx, "tribe.join", {}, makeOpts())) as ToolResultShape

    expect(result.isError).toBe(true)
    expect(ctx.getName()).toBe("unknown-x7k2q")
    expect(db.prepare("SELECT name FROM sessions WHERE id = ?").get(SESSION_ID)).toEqual({ name: "unknown-x7k2q" })
  })

  it("the adapter shape — token but no prior row — is still a named refusal, never validateName(undefined)", async () => {
    const ctx = makeContext(db, stmts, "pending-2c4f")
    const result = (await handleToolCall(
      ctx,
      "tribe.join",
      { identity_token: "0123456789abcdef", delivery: "pull", role: "member" },
      makeOpts(),
    )) as ToolResultShape

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("missing required argument 'name'")
    expect(textOf(result)).not.toContain("undefined is not an object")
    expect(ctx.getName()).toBe("pending-2c4f")
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 })
  })

  it("the adoption policy is unchanged: a token matching an inactive prior row still supplies the name", async () => {
    const priorCtx = createTribeContext({
      db,
      stmts,
      sessionId: "sess-prior",
      sessionRole: "member",
      initialName: "@agent/prior",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    registerSession(priorCtx, PROJECT_ID, () => false, "tok-adopt", 0, "pull", "/tmp/km")
    const ctx = makeContext(db, stmts, "pending-2c4f")

    const result = (await handleToolCall(
      ctx,
      "tribe.join",
      { identity_token: "tok-adopt" },
      makeOpts(),
    )) as ToolResultShape

    expect(result.isError).toBeUndefined()
    expect(JSON.parse(textOf(result))).toMatchObject({ joined: true, name: "@agent/prior" })
  })

  it("the control: an explicit name still joins", async () => {
    const ctx = makeContext(db, stmts, "pending-2c4f")
    const result = (await handleToolCall(ctx, "tribe.join", { name: "@agent/4" }, makeOpts())) as ToolResultShape

    expect(result.isError).toBeUndefined()
    expect(JSON.parse(textOf(result))).toMatchObject({ joined: true, name: "@agent/4" })
    expect(db.prepare("SELECT name FROM sessions WHERE id = ?").get(SESSION_ID)).toEqual({ name: "@agent/4" })
  })

  it("the related send case keeps its own canonical refusal: absent message is named, nothing is written", async () => {
    const ctx = makeContext(db, stmts, "@agent/4")
    registerSession(ctx, PROJECT_ID, () => true, null, process.pid, "pull", "/tmp/km")
    const before = db.prepare("SELECT COUNT(*) AS n FROM messages").get()

    const result = (await handleToolCall(ctx, "tribe.send", { to: "@chief" }, makeOpts())) as ToolResultShape

    expect(textOf(result)).toContain("tribe.send: invalid message - must be a string")
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual(before)
  })

  it("the control: a send with to and message still lands", async () => {
    const ctx = makeContext(db, stmts, "@agent/4")
    registerSession(ctx, PROJECT_ID, () => true, null, process.pid, "pull", "/tmp/km")

    const result = (await handleToolCall(
      ctx,
      "tribe.send",
      { to: "@chief", message: "hello", type: "notify", summary: "hi" },
      makeOpts(),
    )) as ToolResultShape

    expect(result.isError).toBeUndefined()
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE content = 'hello'").get()).toEqual({ n: 1 })
  })
})
