/**
 * @failure @ag/tribe/21717-identity-by-directory-not-claimed-field, @pm/infra/20925-ci-pending-ball-triage
 * @level unit
 * @consumer Tribe daemon socket senders
 *
 * Sender identity comes from the connection context; a caller-provided field
 * is never authoritative. Daemon-origin journal rows remain ambient.
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
import { sendMessage } from "./messaging.ts"

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

function makeOpts(activeNames: readonly string[] = []): HandlerOpts {
  return {
    cleanup: () => undefined,
    userRenamed: false,
    setUserRenamed: () => undefined,
    getActiveSessionIds: () => new Set(activeNames.map((name) => `sess-${name}`)),
    hasActiveTransport: (sessionId) => activeNames.some((name) => sessionId === `sess-${name}`),
    getActiveSessionInfo: () =>
      activeNames.map((name) => ({
        id: `sess-${name}`,
        name,
        pid: process.pid,
        cwd: "/repo",
        role: "member",
        claudeSessionId: null,
        registeredAt: Date.now(),
        launchId: null,
        launchParentPid: null,
        transportPids: [process.pid],
      })),
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

  it("ignores a claimed sender for daemon-context sends and keeps daemon journal events ambient", () => {
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
        makeOpts(["@agent/7"]),
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
      sender: "daemon",
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
      sender: "daemon",
      recipient: "@agent/7",
      request_id: messageId,
      message_id: messageId,
    })
    expect(inserted[0]).toMatchObject({
      sender: "daemon",
      senderRole: "daemon",
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

  it("demotes only daemon session and GitHub push broadcasts while retaining their journal facts", () => {
    const inserted: MessageInsertedInfo[] = []
    const daemon = makeContext(db, stmts, "daemon", "sess-daemon", "daemon", (info) => inserted.push(info))
    const peer = makeContext(db, stmts, "@dev/8", "sess-dev-8", "member", (info) => inserted.push(info))
    const cases = [
      [daemon, "*", "github pushed", "github:push", "github:push", "broadcast", "event"],
      [daemon, "*", "member joined", "session", "daemon:session", "broadcast", "event"],
      [daemon, "@ci", "private session detail", "session", "daemon:session", "direct", "direct"],
      [peer, "*", "peer GitHub push", "github:push", "github:push", "broadcast", "broadcast"],
      [
        daemon,
        "*",
        "workflow needs attention",
        "github:workflow:failure",
        "github:workflow:failure",
        "broadcast",
        "broadcast",
      ],
      [daemon, "*", "explicit journal row", "session", "daemon:session", "event", "event"],
    ] as const

    const sent = cases.map(([ctx, recipient, content, type, topic, kind]) =>
      sendMessage(ctx, recipient, content, type, undefined, undefined, kind, {
        topic,
      }),
    )
    const rows = sent.map((message) =>
      db.prepare("SELECT type, content, topic, kind FROM messages WHERE id = ?").get(message.id),
    )
    expect(rows).toEqual(
      cases.map(([, , content, type, topic, , expected]) => ({ content, kind: expected, topic, type })),
    )
    expect(inserted.map(({ content, kind, topic, type }) => ({ content, kind, topic, type }))).toEqual(
      cases.map(([, , content, type, topic, , expected]) => ({ content, kind: expected, topic, type })),
    )

    const inbox = stmts.getInboxRows.all({
      $since: 0,
      $name: "@ci",
      $limit: 20,
      $filter_mode: "ambient",
      $filter_mute: null,
      $filter_until: null,
      $now: Date.now(),
    }) as Array<{ id: string }>
    expect(inbox.map(({ id }) => id)).toEqual([sent[2]?.id, sent[3]?.id, sent[4]?.id])
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
