/**
 * llm-authored-tribe-summary-persistence (km 20316 #3): a message carries an
 * authored one-line `summary` that persists alongside its content and rides
 * back out on fetch, so a channel UI can show the sender's own one-liner by
 * default (and disclose the markdown body on demand). When a sender omits the
 * summary, the daemon derives one from the message (first line, truncated)
 * rather than rejecting the send — and flags the derive back to the caller so
 * the omission is never silent.
 */

import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"
import { deriveSummary } from "./messaging.ts"
import { registerSession } from "./session.ts"

const SENDER = "@chief"
const SENDER_ID = "sess-chief"
const RECIPIENT = "@agent/2"
const RECIPIENT_ID = "sess-agent-2"
const PROJECT_ID = "summary-proj"

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
    getActiveSessionInfo: () => [],
  }
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): ToolJson {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as ToolJson
}

describe("deriveSummary", () => {
  it("returns a short single-line body unchanged", () => {
    expect(deriveSummary("shipping the fix in 30s")).toBe("shipping the fix in 30s")
  })

  it("takes the first non-empty line of a multi-line body", () => {
    expect(deriveSummary("\n\nLanding 20316 now\n\n- rebase\n- push")).toBe("Landing 20316 now")
  })

  it("truncates a long line at a word boundary with an ellipsis", () => {
    const out = deriveSummary("a".repeat(40) + " " + "b".repeat(60))
    expect(out.endsWith("…")).toBe(true)
    expect(out.length).toBeLessThanOrEqual(81)
    expect(out).not.toContain("**")
  })

  it("yields empty string for whitespace-only content (never junk)", () => {
    expect(deriveSummary("   \n  \n")).toBe("")
  })
})

describe("tribe.send summary — persist + derive-not-reject", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "message-summary-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function send(args: ToolJson): ToolJson {
    const ctx = makeContext(db, stmts, SENDER, SENDER_ID)
    registerSession(ctx, PROJECT_ID, () => true, null, 1234, "push", "/repo", null, "claude")
    return parseToolJson(handleToolCall(ctx, "tribe.send", args, makeOpts()))
  }

  it("persists an authored summary verbatim and does not flag a derive", () => {
    const res = send({ to: RECIPIENT, message: "Full plan:\n\n- rebase\n- push", summary: "rebase then push" })
    expect(res.sent).toBe(true)
    expect(res.summary).toBe("rebase then push")
    expect(res.summary_derived).toBeUndefined()
    const row = db.prepare("SELECT summary FROM messages WHERE id = $id").get({ $id: res.id as string }) as {
      summary: string | null
    }
    expect(row.summary).toBe("rebase then push")
  })

  it("derives a one-liner + warns (no-silent) when summary is omitted — never rejects", () => {
    const res = send({ to: RECIPIENT, message: "Landing 20316 now\n\nlong **markdown** body follows here" })
    expect(res.sent).toBe(true) // derive-not-reject: the message still sends
    expect(res.summary).toBe("Landing 20316 now")
    expect(res.summary_derived).toBe(true)
    expect(typeof res.warning).toBe("string")
    const row = db.prepare("SELECT summary FROM messages WHERE id = $id").get({ $id: res.id as string }) as {
      summary: string | null
    }
    expect(row.summary).toBe("Landing 20316 now")
  })

  it("rides the summary back out on fetch so the recipient UI can show it", () => {
    const authored = "rebase then push"
    send({ to: RECIPIENT, message: "Full plan:\n\n- rebase\n- push", summary: authored })

    const recipientCtx = makeContext(db, stmts, RECIPIENT, RECIPIENT_ID)
    registerSession(recipientCtx, PROJECT_ID, () => true, null, 5678, "pull", "/repo", null, "claude")
    const drain = parseToolJson(handleToolCall(recipientCtx, "tribe.fetch", { limit: 50 }, makeOpts())) as ToolJson & {
      events?: Array<{ content: string; summary: string | null }>
    }
    const event = drain.events?.find((e) => e.content.startsWith("Full plan"))
    expect(event).toBeDefined()
    expect(event?.summary).toBe(authored)
  })
})
