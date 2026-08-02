/**
 * @failure a retry of one client send creates a second durable message row.
 * @level l1
 * @consumer @tribe/protocol-halves-versioned-from-two-sources
 *
 * Restart makes an in-flight send retry routine. The client-owned message UUID
 * must therefore be the durable identity, and the daemon must ignore a replay
 * rather than minting a second row or reopening its response obligation.
 */

import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"

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

describe("tribe.send idempotency", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-send-idempotency-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("stores one row when the same client UUID is retried across a cut", () => {
    const ctx = makeContext(db, stmts)
    const messageId = "2d4f1d92-50c5-4e38-9f6b-4f24d9ec9c72"
    const first = parseToolJson(
      handleToolCall(
        ctx,
        "tribe.send",
        { to: "@agent/7", message: "retry-safe", type: "notify", message_id: messageId },
        makeOpts(),
      ),
    )
    const second = parseToolJson(
      handleToolCall(
        ctx,
        "tribe.send",
        { to: "@agent/7", message: "retry-safe", type: "notify", message_id: messageId },
        makeOpts(),
      ),
    )

    expect(first).toMatchObject({ sent: true, id: messageId })
    expect(second).toMatchObject({ sent: true, id: messageId, deduplicated: true })
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE id = ?").get(messageId)).toEqual({ count: 1 })
  })
})
