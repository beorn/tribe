/**
 * @failure @km/tribe/20988-send-identity, @pm/infra/20925-ci-pending-ball-triage
 * @level unit
 * @consumer tribe CLI one-shot peer sends
 *
 * One-shot `tribe send` calls connect through the daemon context, but their
 * authored message must retain both the caller identity and the explicit
 * per-message delivery class. Daemon-origin journal rows remain ambient.
 */

import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { TribeRole } from "tribe-wire/lib/config"

import { createTribeContext, type MessageInsertedInfo, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"

function makeContext(
  db: Database,
  stmts: TribeStatements,
  name: string,
  sessionId: string,
  role: TribeRole,
  onMessageInserted?: (info: MessageInsertedInfo) => void,
): TribeContext {
  return createTribeContext({
    db,
    stmts,
    sessionId,
    sessionRole: role,
    initialName: name,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
    onMessageInserted,
  })
}

function makeOpts(activeIds: readonly string[] = []): HandlerOpts {
  return {
    cleanup: () => undefined,
    userRenamed: false,
    setUserRenamed: () => undefined,
    getActiveSessionIds: () => new Set(activeIds),
    getActiveSessionInfo: () => [],
  }
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Record<string, unknown>
}

describe("tribe.send attribution and delivery", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-send-attribution-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("uses the CLI caller identity for peer sends but keeps daemon journal events ambient", () => {
    const inserted: MessageInsertedInfo[] = []
    const daemon = makeContext(db, stmts, "daemon", "sess-daemon", "daemon", (info) => inserted.push(info))

    const res = parseToolJson(
      handleToolCall(
        daemon,
        "tribe.send",
        {
          to: "@agent/7",
          message: "please handle this",
          type: "request",
          request: true,
          sender: "@chief",
        },
        makeOpts(),
      ),
    )

    expect(res.sent).toBe(true)
    const messageId = res.id as string
    const message = db.prepare("SELECT sender, recipient, kind, request FROM messages WHERE id = ?").get(messageId) as {
      sender: string
      recipient: string
      kind: string
      request: string | null
    }
    expect(message).toEqual({
      sender: "@chief",
      recipient: "@agent/7",
      kind: "direct",
      request: messageId,
    })

    const pending = db
      .prepare("SELECT sender, recipient, request_id, message_id FROM pending_request WHERE request_id = ?")
      .get(messageId) as {
      sender: string
      recipient: string
      request_id: string
      message_id: string
    }
    expect(pending).toEqual({
      sender: "@chief",
      recipient: "@agent/7",
      request_id: messageId,
      message_id: messageId,
    })
    expect(inserted[0]).toMatchObject({
      sender: "@chief",
      senderRole: "member",
      recipient: "@agent/7",
      kind: "direct",
    })

    const event = db
      .prepare("SELECT sender, recipient, kind, type FROM messages WHERE type = ?")
      .get("event.message.sent.request") as {
      sender: string
      recipient: string
      kind: string
      type: string
    }
    expect(event).toEqual({
      sender: "daemon",
      recipient: "*",
      kind: "event",
      type: "event.message.sent.request",
    })
  })

  it("ignores caller identity overrides from already-registered peer contexts", () => {
    const agent = makeContext(db, stmts, "@agent/8", "sess-agent-8", "member")

    const res = parseToolJson(
      handleToolCall(
        agent,
        "tribe.send",
        { to: "@agent/7", message: "hello", type: "notify", sender: "@chief" },
        makeOpts(),
      ),
    )

    expect(res.sent).toBe(true)
    const row = db.prepare("SELECT sender FROM messages WHERE id = ?").get(res.id as string) as { sender: string }
    expect(row.sender).toBe("@agent/8")
  })

  it.each([
    { route: "single", to: "@ci", recipients: ["@ci"] },
    { route: "multi", to: ["@ci", "@cto"], recipients: ["@ci", "@cto"] },
  ])("persists an explicit pull classification for $route recipients without opening a ball", ({ to, recipients }) => {
    const inserted: MessageInsertedInfo[] = []
    const daemon = makeContext(db, stmts, "daemon", "sess-daemon", "daemon", (info) => inserted.push(info))

    const res = parseToolJson(
      handleToolCall(
        daemon,
        "tribe.send",
        {
          to,
          message: "R656 failed; evidence is in the journal",
          type: "notify",
          delivery: "pull",
          sender: "yrd",
        },
        makeOpts(),
      ),
    )

    expect(res.sent).toBe(true)
    const rows = db
      .prepare("SELECT recipient, delivery, request FROM messages WHERE kind = 'direct' ORDER BY recipient")
      .all()
    expect(rows).toEqual(recipients.map((recipient) => ({ recipient, delivery: "pull", request: null })))
    expect(inserted.filter((info) => info.kind === "direct")).toEqual(
      recipients.map((recipient) => expect.objectContaining({ recipient, delivery: "pull" })),
    )
    expect(db.prepare("SELECT COUNT(*) AS count FROM pending_request").get()).toEqual({ count: 0 })
  })

  it("rejects an invalid per-message delivery classification instead of silently pushing", () => {
    const daemon = makeContext(db, stmts, "daemon", "sess-daemon", "daemon")

    const res = parseToolJson(
      handleToolCall(
        daemon,
        "tribe.send",
        { to: "@ci", message: "evidence", type: "notify", delivery: "later", sender: "yrd" },
        makeOpts(),
      ),
    )

    expect(res.error).toMatch(/delivery.*push.*pull/i)
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 0 })
  })
})
