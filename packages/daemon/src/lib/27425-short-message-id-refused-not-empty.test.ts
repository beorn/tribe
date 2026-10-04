/**
 * @failure A tribe.fetch by an abbreviated (short) message id answers an empty
 *          list instead of being refused by name, so a caller reads "not found"
 *          where the id was merely abbreviated (@ag/tribe/27425).
 * @level l2
 * @consumer tribe.fetch ids (MCP) and the `tribe-wire` reads
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
const SENDER_ID = "sess-27425-chief"
const RECIPIENT = "@agent/27425"
const RECIPIENT_ID = "sess-27425-agent"
const PROJECT_ID = "27425-proj"

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

describe("tribe.fetch ids — an abbreviated id is refused by name", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fetch-ids-27425-"))
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
      handleToolCall(ctx, "tribe.send", { to: RECIPIENT, message: "specimen for 27425" }, makeOpts()),
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

  function fetchRaw(ids: string[]): { isError?: boolean; content: Array<{ text: string }> } {
    const ctx = makeContext(db, stmts, RECIPIENT, RECIPIENT_ID)
    return handleToolCall(ctx, "tribe.fetch", { ids }, makeOpts()) as {
      isError?: boolean
      content: Array<{ text: string }>
    }
  }

  it("refuses an abbreviated message id instead of answering an empty list", () => {
    const fullId = send()
    const shortId = fullId.slice(0, 8)

    const res = fetchIds([shortId])

    expect(res.error, JSON.stringify(res)).toBeDefined()
    expect(String(res.error)).toContain(shortId)
    expect(res.events).toBeUndefined()
  })

  it("still resolves a full message id (the refusal must not break the working path)", () => {
    const fullId = send()

    const res = fetchIds([fullId])

    expect(res.error).toBeUndefined()
    const events = res.events as Array<{ id: string }>
    expect(events.map((event) => event.id)).toEqual([fullId])
  })

  it("names every abbreviated entry, not only the first", () => {
    const res = fetchIds(["276e95ac", "37120b23"])

    expect(String(res.error)).toContain("276e95ac")
    expect(String(res.error)).toContain("37120b23")
  })

  it("marks the abbreviated-id refusal as a tool error, not a normal empty read", () => {
    const fullId = send()
    const shortId = fullId.slice(0, 8)

    const refusal = fetchRaw([shortId])
    expect(refusal.isError).toBe(true)
    expect(refusal.content[0]?.text ?? "").toContain(shortId)

    const ok = fetchRaw([fullId])
    expect(ok.isError).toBeUndefined()
  })

  it("keeps resolving a persisted client id that is not a uuid (tribe.send accepts any non-empty id)", () => {
    // The refusal keys on "matched nothing AND not a uuid", so the exact-match
    // lookup runs first and an id that IS persisted still resolves — only an
    // abbreviation that could never match is refused.
    const customId = sendWithId("custom-note-27425")
    expect(customId).toBe("custom-note-27425")

    const res = fetchIds([customId])

    expect(res.error).toBeUndefined()
    expect((res.events as Array<{ id: string }>).map((event) => event.id)).toEqual([customId])
  })
})
