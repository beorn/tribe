/**
 * @failure A tribe.fetch `--ids` value that is an abbreviated message id is
 *          refused outright, so a caller holding a unique 8-character prefix
 *          cannot use it; and an ambiguous prefix names nothing, so the caller
 *          is not told which ids it collided with (@ag/tribe/28909).
 * @level l2
 * @consumer tribe.fetch ids (MCP) and the `tribe-wire fetch --ids` reads
 * @testonly none
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

const SENDER = "@chief"
const SENDER_ID = "sess-28909-chief"
const RECIPIENT = "@agent/28909"
const RECIPIENT_ID = "sess-28909-agent"
const PROJECT_ID = "28909-proj"

type ToolJson = Record<string, unknown>

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
  return {
    cleanup: () => undefined,
    userRenamed: false,
    setUserRenamed: () => undefined,
    getActiveSessionIds: () => new Set([SENDER_ID, RECIPIENT_ID]),
    hasActiveTransport: (sessionId) => sessionId === SENDER_ID || sessionId === RECIPIENT_ID,
    getActiveSessionInfo: () => [],
  }
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): ToolJson {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as ToolJson
}

describe("tribe.fetch ids — a unique prefix resolves, an ambiguous one is refused by name", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fetch-ids-28909-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function send(): string {
    const ctx = makeContext(db, stmts, SENDER, SENDER_ID)
    registerSession(ctx, PROJECT_ID, () => true, null, 1234, "push", "/repo", null, "claude")
    const res = parseToolJson(
      handleToolCall(ctx, "tribe.send", { to: RECIPIENT, message: "specimen for 28909" }, makeOpts()),
    )
    return res.id as string
  }

  function sendWithId(messageId: string): string {
    const ctx = makeContext(db, stmts, SENDER, SENDER_ID)
    registerSession(ctx, PROJECT_ID, () => true, null, 1234, "push", "/repo", null, "claude")
    const res = parseToolJson(
      handleToolCall(ctx, "tribe.send", { to: RECIPIENT, message: "custom id", message_id: messageId }, makeOpts()),
    )
    return res.id as string
  }

  function fetchIds(ids: string[]): ToolJson {
    const ctx = makeContext(db, stmts, RECIPIENT, RECIPIENT_ID)
    return parseToolJson(handleToolCall(ctx, "tribe.fetch", { ids }, makeOpts()))
  }

  it("resolves a unique 8-character prefix to its message (the point of 28909)", () => {
    const fullId = send()
    const prefix = fullId.slice(0, 8)

    const res = fetchIds([prefix])

    expect(res.error, JSON.stringify(res)).toBeUndefined()
    expect((res.events as Array<{ id: string }>).map((event) => event.id)).toEqual([fullId])
  })

  it("refuses a prefix shorter than 8 characters, naming the requirement", () => {
    const fullId = send()

    const res = fetchIds([fullId.slice(0, 7)])

    expect(res.error, JSON.stringify(res)).toBeDefined()
    expect(String(res.error)).toContain(fullId.slice(0, 7))
    expect(String(res.error)).toMatch(/at least 8 characters/i)
    expect(res.events).toBeUndefined()
  })

  it("refuses an unknown 8+ character prefix instead of answering an empty list", () => {
    const res = fetchIds(["deadbeef"])

    expect(res.error, JSON.stringify(res)).toBeDefined()
    expect(String(res.error)).toContain("deadbeef")
    expect(res.events).toBeUndefined()
  })

  it("refuses an ambiguous prefix by name AND lists the candidate ids it collided with", () => {
    const first = sendWithId("custom-note-alpha")
    const second = sendWithId("custom-note-beta")

    const res = fetchIds(["custom-n"])

    expect(res.error, JSON.stringify(res)).toBeDefined()
    expect(String(res.error)).toContain("custom-n")
    expect(String(res.error)).toContain(first)
    expect(String(res.error)).toContain(second)
    expect(res.events).toBeUndefined()
  })

  it("still resolves a persisted client id that is not a uuid (a non-uuid exact hit is never a prefix)", () => {
    const customId = sendWithId("custom-note-exact")

    const res = fetchIds([customId])

    expect(res.error).toBeUndefined()
    expect((res.events as Array<{ id: string }>).map((event) => event.id)).toEqual([customId])
  })

  it("keeps a full uuid that matched nothing on the silent empty path (unchanged)", () => {
    const missing = "44ea2480-2763-46a9-a08c-82566a1b5637"

    const res = fetchIds([missing])

    expect(res.error).toBeUndefined()
    expect(res.events).toEqual([])
  })

  it("refuses an out-of-range fetch limit by name instead of clamping it to 50 (28909)", () => {
    for (const bad of [1000, 501, 0, -5]) {
      const ctx = makeContext(db, stmts, RECIPIENT, RECIPIENT_ID)
      const res = parseToolJson(handleToolCall(ctx, "tribe.fetch", { since: 0, limit: bad }, makeOpts()))
      expect(res.error, `limit ${bad}: ${JSON.stringify(res)}`).toBeDefined()
      expect(String(res.error)).toMatch(/out of range/)
      expect(String(res.error)).toMatch(/between 1 and 500/)
      expect(res.events).toBeUndefined()
    }
  })

  it("accepts an in-range fetch limit (the bound stays 1..500) (28909)", () => {
    const fullId = send()
    const ctx = makeContext(db, stmts, RECIPIENT, RECIPIENT_ID)

    const res = parseToolJson(handleToolCall(ctx, "tribe.fetch", { ids: [fullId], limit: 500 }, makeOpts()))

    expect(res.error).toBeUndefined()
    expect((res.events as Array<{ id: string }>).map((event) => event.id)).toEqual([fullId])
  })
})
