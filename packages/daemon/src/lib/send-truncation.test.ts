/**
 * @failure `tribe.send` reports `sent: true` on a message the daemon silently
 *          cut at 4096 chars, so the sender believes the whole message arrived.
 * @level l1
 * @consumer @ag/tribe/22497-daemon-silent-send-truncation
 *
 * The daemon caps message content at 4096 UTF-16 code units. Before this bead
 * `sanitizeMessage` returned a bare string, so the cut was unobservable from
 * the send result: two coordination decisions were parked — one overnight —
 * because the tail of a request was never delivered and nobody could tell.
 * That is a NO SILENT ERRORS violation (docs/principles.md § "Fail Loud, Fail
 * Now"): a surface reporting success for a mutilated payload.
 *
 * These tests pin the send RESULT, not just the helper — the defect was the
 * fact being dropped between `sanitizeMessage` and the response object, so a
 * unit test on the helper alone would not have caught it.
 */

import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"
import { MESSAGE_MAX_LENGTH } from "./validation.ts"

function makeContext(db: Database, stmts: TribeStatements): TribeContext {
  return createTribeContext({
    db,
    stmts,
    sessionId: "sess-sender",
    sessionRole: "member",
    initialName: "@chief",
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
    getActiveSessionIds: () => new Set<string>(),
    hasActiveTransport: () => false,
    getActiveSessionInfo: () => [],
  }
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Record<string, unknown>
}

describe("tribe.send truncation reporting", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-send-truncation-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("reports truncation and the true original length for an over-cap send", () => {
    const overCap = "x".repeat(MESSAGE_MAX_LENGTH + 500)
    const res = parseToolJson(
      handleToolCall(
        makeContext(db, stmts),
        "tribe.send",
        { to: "@agent/7", message: overCap, summary: "over-cap probe" },
        makeOpts(),
      ),
    )

    // The send still succeeds — this is a report, not a rejection.
    expect(res.sent).toBe(true)
    expect(res.truncated).toBe(true)
    expect(res.original_length).toBe(MESSAGE_MAX_LENGTH + 500)
    // The warning carries the same fact for a reader that only scans prose.
    expect(String(res.warning)).toContain("truncated")
    expect(String(res.warning)).toContain(String(MESSAGE_MAX_LENGTH + 500))

    // And the stored row really is the cut prefix the report describes — the
    // report must not be able to drift from what the recipient receives.
    const stored = db.prepare("SELECT content FROM messages WHERE id = ?").get(res.id as string) as { content: string }
    expect(stored.content.length).toBe(MESSAGE_MAX_LENGTH)
    expect(stored.content.endsWith("...")).toBe(true)
  })

  it("does not report truncation for an at-cap send", () => {
    const atCap = "y".repeat(MESSAGE_MAX_LENGTH)
    const res = parseToolJson(
      handleToolCall(
        makeContext(db, stmts),
        "tribe.send",
        { to: "@agent/7", message: atCap, summary: "at-cap probe" },
        makeOpts(),
      ),
    )

    expect(res.sent).toBe(true)
    // Explicit false, never absent: an absent flag would alias "intact" with
    // "this daemon does not report", which is the ambiguity the bead closed.
    expect(res.truncated).toBe(false)
    expect(res.original_length).toBe(MESSAGE_MAX_LENGTH)
    expect(res.warning).toBeUndefined()

    const stored = db.prepare("SELECT content FROM messages WHERE id = ?").get(res.id as string) as { content: string }
    expect(stored.content).toBe(atCap)
  })
})
