import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"
import { prefixFallbackDeliveryResolver } from "./delivery-resolution.ts"
import { registerSession } from "./session.ts"

const PROJECT_ID = "delivery-resolution"

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

function resultJson(result: ReturnType<typeof handleToolCall>): Record<string, unknown> {
  if (result instanceof Promise) throw new Error("delivery-resolution test expected a synchronous tool result")
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>
}

describe("generic direct-message delivery resolution", () => {
  it("validates one declared-order prefix fallback table and never infers hierarchy", () => {
    const resolve = prefixFallbackDeliveryResolver(
      JSON.stringify([
        { prefix: "@worker/special/", to: "@special-manager" },
        { prefix: "@worker/", to: "@manager" },
      ]),
    )
    expect(resolve?.({ recipient: "@worker/special/1", activeNames: new Set() })).toMatchObject({
      status: "accepted",
      state: "bounced",
      to: "@special-manager",
    })
    expect(resolve?.({ recipient: "@other/1", activeNames: new Set() })).toEqual({
      status: "accepted",
      state: "offline",
    })
    expect(resolve?.({ recipient: "@worker/1", activeNames: new Set(["@worker/1"]) })).toEqual({
      status: "accepted",
      state: "online",
    })
  })

  it.each([
    ["not-json", /must be JSON/],
    [JSON.stringify({ prefix: "@worker/", to: "@manager" }), /JSON array/],
    [JSON.stringify([{ prefix: "@worker/", to: "@manager", parent: true }]), /unknown keys/],
    [
      JSON.stringify([
        { prefix: "@worker/", to: "@manager" },
        { prefix: "@worker/", to: "@other" },
      ]),
      /duplicate prefixes/,
    ],
  ])("fails loud on an invalid prefix fallback table", (raw, expected) => {
    expect(() => prefixFallbackDeliveryResolver(raw)).toThrow(expected)
  })

  let dir: string
  let db: Database
  let stmts: TribeStatements
  let sender: TribeContext
  let manager: TribeContext

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tribe-delivery-resolution-"))
    db = openDatabase(join(dir, "tribe.db"))
    stmts = createStatements(db)
    sender = makeContext(db, stmts, "@sender", "sess-sender")
    manager = makeContext(db, stmts, "@dev", "sess-manager")
    registerSession(sender, PROJECT_ID, () => true, null, 1001, "pull", "/repo", null, "codex")
    registerSession(manager, PROJECT_ID, () => true, null, 1002, "pull", "/repo", null, "codex")
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function opts(): HandlerOpts {
    return {
      cleanup: () => undefined,
      userRenamed: false,
      setUserRenamed: () => undefined,
      getActiveSessionIds: () => new Set(["sess-sender", "sess-manager"]),
      hasActiveTransport: (sessionId) => sessionId === "sess-sender" || sessionId === "sess-manager",
      getActiveSessionInfo: () => [
        {
          id: "sess-sender",
          name: "@sender",
          pid: 1001,
          cwd: "/repo",
          role: "member",
          claudeSessionId: null,
          registeredAt: 1,
          launchId: null,
          launchParentPid: null,
          transportPids: [1001],
        },
        {
          id: "sess-manager",
          name: "@dev",
          pid: 1002,
          cwd: "/repo",
          role: "member",
          claudeSessionId: null,
          registeredAt: 1,
          launchId: null,
          launchParentPid: null,
          transportPids: [1002],
        },
      ],
      resolveDelivery: ({ recipient, activeNames }) =>
        recipient.startsWith("@dev/") && !activeNames.has(recipient)
          ? {
              status: "accepted",
              state: "bounced",
              to: "@dev",
              reason: "declared child has no live transport",
            }
          : { status: "accepted", state: activeNames.has(recipient) ? "online" : "offline" },
    }
  }

  it("persists the original mail, makes the parent own its original ball, and preserves correlation on the bounce", () => {
    const sent = resultJson(
      handleToolCall(
        sender,
        "tribe.send",
        {
          to: "@dev/s2-gone",
          message: "hello",
          type: "request",
          request: "req-dead-child",
          ref: "correlation-7",
        },
        opts(),
      ),
    )

    expect(sent).toMatchObject({
      sent: true,
      request_id: "req-dead-child",
      delivery: {
        state: "bounced",
        original_target: "@dev/s2-gone",
        recipient: "@dev",
        reason: "declared child has no live transport",
      },
    })

    const rows = db
      .prepare(
        "SELECT id, type, sender, recipient, content, ref, request, attention_required FROM messages WHERE kind = 'direct' ORDER BY rowid",
      )
      .all() as Array<{
      id: string
      type: string
      sender: string
      recipient: string
      content: string
      ref: string | null
      request: string | null
      attention_required: number
    }>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      id: sent.id,
      type: "request",
      sender: "@sender",
      recipient: "@dev/s2-gone",
      content: "hello",
      ref: "correlation-7",
      request: "req-dead-child",
    })
    expect(rows[1]).toMatchObject({
      type: "dead-letter",
      sender: "@sender",
      recipient: "@dev",
      content: "hello",
      ref: "correlation-7",
      request: "req-dead-child",
      attention_required: 1,
    })

    expect(db.prepare("SELECT request_id, recipient, sender, message_id FROM pending_request").get()).toEqual({
      request_id: "req-dead-child",
      recipient: "@dev",
      sender: "@sender",
      message_id: sent.id,
    })

    const fetched = resultJson(handleToolCall(manager, "tribe.fetch", { limit: 10 }, opts())) as {
      attention?: { actionable_unread?: Array<Record<string, unknown>> }
    }
    expect(fetched.attention?.actionable_unread).toContainEqual(
      expect.objectContaining({
        type: "dead-letter",
        from: "@sender",
        to: "@dev",
        content: "hello",
        ref: "correlation-7",
      }),
    )

    const replied = resultJson(
      handleToolCall(
        manager,
        "tribe.send",
        { to: "@sender", message: "child unavailable; request parked", type: "response", reply: "req-dead-child" },
        opts(),
      ),
    )
    expect(replied.tracker).toEqual({ request_id: "req-dead-child", closed: 1 })
    expect(db.prepare("SELECT request_id FROM pending_request").get()).toBeNull()
  })

  it.each(["invalid", "unresolved"] as const)("refuses a %s target without persisting mail", (status) => {
    const refused = resultJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: "@bad", message: "nope", type: "request" },
        {
          ...opts(),
          resolveDelivery: () => ({ status, reason: `${status} test target` }),
        },
      ),
    )

    expect(refused.error).toContain(`${status} test target`)
    expect(db.prepare("SELECT id FROM messages WHERE kind = 'direct' AND content = 'nope'").get()).toBeNull()
    expect(db.prepare("SELECT request_id FROM pending_request").get()).toBeNull()
  })

  it("preflights every multi-recipient target before persistence and reports each accepted disposition", () => {
    const refused = resultJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: ["@dev/good", "@bad"], message: "multi-refusal", type: "request" },
        {
          ...opts(),
          resolveDelivery: ({ recipient }) =>
            recipient === "@bad"
              ? { status: "invalid", reason: "invalid multi target" }
              : { status: "accepted", state: "bounced", to: "@dev", reason: "child unavailable" },
        },
      ),
    )
    expect(refused.error).toContain("invalid multi target")
    expect(db.prepare("SELECT id FROM messages WHERE content = 'multi-refusal'").get()).toBeNull()

    const sent = resultJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: ["@dev/one", "@sender"], message: "multi-ok", type: "request", request: "req-multi" },
        opts(),
      ),
    )
    expect(sent.deliveries).toEqual([
      {
        state: "bounced",
        original_target: "@dev/one",
        recipient: "@dev",
        reason: "declared child has no live transport",
      },
      { state: "online", recipient: "@sender" },
    ])
  })
})
