import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"
import { logEvent } from "./messaging.ts"
import { prefixFallbackDeliveryResolver } from "./delivery-resolution.ts"
import { registerSession } from "./session.ts"
import { DEFAULT_MAX_SILENCE_SEC } from "./session-transport-state.ts"
import tribeHabModule from "../../../../hab.projects.ts"

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
    expect(resolve?.({ recipient: "@worker/special/1", answerableNames: new Set() })).toMatchObject({
      status: "accepted",
      state: "bounced",
      to: "@special-manager",
    })
    expect(resolve?.({ recipient: "@other/1", answerableNames: new Set() })).toEqual({
      status: "accepted",
      state: "offline",
    })
    expect(resolve?.({ recipient: "@worker/1", answerableNames: new Set(["@worker/1"]) })).toEqual({
      status: "accepted",
      state: "online",
    })
  })

  it("supports an exact-name fallback without matching descendants", () => {
    const resolve = prefixFallbackDeliveryResolver(JSON.stringify([{ name: "@yrd", to: "@chief" }]))
    expect(resolve?.({ recipient: "@yrd", answerableNames: new Set(["@chief"]) })).toMatchObject({
      status: "accepted",
      state: "bounced",
      to: "@chief",
    })
    expect(resolve?.({ recipient: "@yrd/next", answerableNames: new Set(["@chief"]) })).toEqual({
      status: "accepted",
      state: "offline",
    })
  })

  it("routes both intentionally unstaffed coordinator roles to their declared holder", () => {
    const raw = tribeHabModule.services.wire.env.TRIBE_DELIVERY_FALLBACKS
    const resolve = prefixFallbackDeliveryResolver(raw)
    for (const recipient of ["@ci", "@yrd"]) {
      expect(resolve?.({ recipient, answerableNames: new Set(["@chief"]) })).toMatchObject({
        status: "accepted",
        state: "bounced",
        to: "@chief",
      })
    }
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
      /duplicate matchers/,
    ],
    [JSON.stringify([{ name: "@yrd", prefix: "@yrd/", to: "@chief" }]), /exactly one/],
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
          pid: process.pid,
          cwd: "/repo",
          role: "member",
          claudeSessionId: null,
          registeredAt: 1,
          launchId: null,
          launchParentPid: null,
          transportPids: [process.pid],
        },
        {
          id: "sess-manager",
          name: "@dev",
          pid: process.pid,
          cwd: "/repo",
          role: "member",
          claudeSessionId: null,
          registeredAt: 1,
          launchId: null,
          launchParentPid: null,
          transportPids: [process.pid],
        },
      ],
      resolveDelivery: ({ recipient, answerableNames }) =>
        recipient.startsWith("@dev/") && !answerableNames.has(recipient)
          ? {
              status: "accepted",
              state: "bounced",
              to: "@dev",
              reason: "declared child has no live transport",
            }
          : { status: "accepted", state: answerableNames.has(recipient) ? "online" : "offline" },
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

  it("refuses a tracked offline owner, journals the terminal disposition, and preserves untracked offline mail", () => {
    const refused = resultJson(
      handleToolCall(
        sender,
        "tribe.send",
        {
          to: "@ci",
          message: "run the integration gate",
          type: "request",
          request: "req-offline-ci",
          ref: "carrier-17",
        },
        opts(),
      ),
    )

    expect(refused).toMatchObject({
      error: expect.stringContaining('no connected, PID-live transport was observed for "@ci"'),
      delivery_failure_id: expect.any(String),
      observed_at: expect.any(String),
    })
    expect(refused.error).toContain("start or resume @ci, address a declared live holder, or retry later")
    expect(db.prepare("SELECT request_id FROM pending_request WHERE request_id = 'req-offline-ci'").get()).toBeNull()
    expect(
      db.prepare("SELECT id FROM messages WHERE kind = 'direct' AND content = 'run the integration gate'").get(),
    ).toBeNull()
    expect(db.prepare("SELECT id, ref FROM messages WHERE type = 'event.message.delivery-failed'").get()).toEqual({
      id: refused.delivery_failure_id,
      ref: "carrier-17",
    })

    const refusedUnknownPull = resultJson(
      handleToolCall(
        sender,
        "tribe.send",
        {
          to: "@never-seen",
          message: "do not create an unknown mailbox",
          type: "request",
          request: "req-unknown-pull",
          delivery: "pull",
        },
        opts(),
      ),
    )
    expect(refusedUnknownPull).toMatchObject({
      error: expect.stringContaining('"@never-seen" (no-session-record)'),
      delivery_failure_id: expect.any(String),
    })
    expect(db.prepare("SELECT request_id FROM pending_request WHERE request_id = 'req-unknown-pull'").get()).toBeNull()

    const offlineNotice = resultJson(
      handleToolCall(sender, "tribe.send", { to: "@ci", message: "informational", type: "notify" }, opts()),
    )
    expect(offlineNotice).toMatchObject({ sent: true, delivery: { state: "offline", recipient: "@ci" } })
    expect(db.prepare("SELECT id FROM messages WHERE kind = 'direct' AND content = 'informational'").get()).toEqual({
      id: offlineNotice.id,
    })
  })

  it("accepts a tracked mailbox row for a disconnected recipient with recent journal activity", () => {
    const recentRecipient = makeContext(db, stmts, "@fleet", "departed-fleet-session")
    logEvent(recentRecipient, "session.left", undefined, { name: "@fleet", reason: "peer-close" })

    const sent = resultJson(
      handleToolCall(
        sender,
        "tribe.send",
        {
          to: "@fleet",
          message: "inspect the runtime alarm",
          type: "request",
          request: "req-recent-fleet",
        },
        opts(),
      ),
    )

    expect(sent).toMatchObject({
      sent: true,
      request_id: "req-recent-fleet",
      delivery: { state: "offline", recipient: "@fleet" },
    })
    expect(
      db
        .prepare("SELECT request_id, recipient, sender FROM pending_request WHERE request_id = ?")
        .get("req-recent-fleet"),
    ).toEqual({ request_id: "req-recent-fleet", recipient: "@fleet", sender: "@sender" })
  })

  it("accepts a tracked mailbox row for a durable launch without a connected transport", () => {
    const durableRecipient = makeContext(db, stmts, "@durable", "departed-durable-session")
    registerSession(
      durableRecipient,
      PROJECT_ID,
      () => true,
      null,
      1003,
      "pull",
      "/repo",
      null,
      "codex",
      "durable-launch",
      2003,
    )

    const sent = resultJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: "@durable", message: "read this on the next pull", type: "request", request: "req-durable" },
        opts(),
      ),
    )

    expect(sent).toMatchObject({
      sent: true,
      request_id: "req-durable",
      delivery: { state: "offline", recipient: "@durable" },
    })
  })

  it("keeps explicit pull on the named mailbox when its configured fallback is disconnected", () => {
    const yrd = makeContext(db, stmts, "@yrd", "departed-yrd-session")
    registerSession(yrd, PROJECT_ID, () => true, null, 1004, "pull", "/repo", null, "codex", "yrd-launch", 2004)
    const pullOpts = {
      ...opts(),
      resolveDelivery: prefixFallbackDeliveryResolver(JSON.stringify([{ name: "@yrd", to: "@chief" }])),
    }

    const sent = resultJson(
      handleToolCall(
        sender,
        "tribe.send",
        {
          to: "@yrd",
          message: "queue this for the named mailbox",
          type: "request",
          request: "req-pull-yrd",
          delivery: "pull",
        },
        pullOpts,
      ),
    )

    expect(sent).toMatchObject({
      sent: true,
      request_id: "req-pull-yrd",
      delivery: { state: "offline", recipient: "@yrd" },
    })
    expect(db.prepare("SELECT recipient FROM pending_request WHERE request_id = ?").get("req-pull-yrd")).toEqual({
      recipient: "@yrd",
    })
  })

  it("does not treat stale journal activity as a live mailbox identity", () => {
    const staleRecipient = makeContext(db, stmts, "@stale", "departed-stale-session")
    logEvent(
      staleRecipient,
      "session.left",
      undefined,
      { name: "@stale", reason: "peer-close" },
      { ts: Date.now() - (DEFAULT_MAX_SILENCE_SEC + 1) * 1_000 },
    )

    const refused = resultJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: "@stale", message: "do not strand this", type: "request", request: "req-stale" },
        opts(),
      ),
    )

    expect(refused).toMatchObject({
      error: expect.stringContaining('no connected, PID-live transport was observed for "@stale"'),
      delivery_failure_id: expect.any(String),
    })
    expect(db.prepare("SELECT request_id FROM pending_request WHERE request_id = ?").get("req-stale")).toBeNull()
  })

  it("accepts a tracked mailbox row for a registered, connection-scoped pull seat quiet longer than the silence window", () => {
    // CLI-rail seats (delivery=pull, no live push socket) join with a plain
    // registration: no launch_id/launch_parent_pid (connection-scoped, not
    // durable-launch). `registerSession` itself logs a "session.joined" event
    // with sender = the new seat's own name, so a *freshly* joined seat rides
    // the recent-activity union for free. The real gap is a seat that joined
    // long ago and has done nothing tribe-visible since (a long-lived worker
    // quietly running tool calls, never sending) — it ages out of the
    // recent-activity union while still holding a live `sessions` row. It is
    // nonetheless a currently-known session, so a tracked send must enqueue
    // into its mailbox, not refuse.
    const quietPull = makeContext(db, stmts, "@quiet-pull", "sess-quiet-pull")
    registerSession(quietPull, PROJECT_ID, () => true, null, 1005, "pull", "/repo", null, "codex")
    db.prepare("UPDATE messages SET ts = ? WHERE sender = ?").run(
      Date.now() - (DEFAULT_MAX_SILENCE_SEC + 1) * 1_000,
      "@quiet-pull",
    )

    const sent = resultJson(
      handleToolCall(
        sender,
        "tribe.send",
        {
          to: "@quiet-pull",
          message: "first request in hours to this seat",
          type: "request",
          request: "req-quiet-pull",
        },
        opts(),
      ),
    )

    expect(sent).toMatchObject({
      sent: true,
      request_id: "req-quiet-pull",
      delivery: { state: "offline", recipient: "@quiet-pull" },
    })
    expect(
      db.prepare("SELECT request_id, recipient FROM pending_request WHERE request_id = ?").get("req-quiet-pull"),
    ).toEqual({ request_id: "req-quiet-pull", recipient: "@quiet-pull" })
  })

  it("refuses instead of bouncing a tracked request to an unavailable fallback", () => {
    const unavailableFallback = {
      ...opts(),
      getActiveSessionIds: () => new Set(["sess-sender"]),
      hasActiveTransport: (sessionId: string) => sessionId === "sess-sender",
      getActiveSessionInfo: () =>
        opts()
          .getActiveSessionInfo()
          .filter((session) => session.name === "@sender"),
    }
    const refused = resultJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: "@dev/gone", message: "do work", type: "request", request: "req-dead-fallback" },
        unavailableFallback,
      ),
    )

    expect(refused.error).toContain('configured fallback "@dev"')
    expect(refused.error).toContain("no connected, PID-live transport")
    expect(db.prepare("SELECT request_id FROM pending_request WHERE request_id = 'req-dead-fallback'").get()).toBeNull()
    expect(db.prepare("SELECT id FROM messages WHERE kind = 'direct' AND content = 'do work'").get()).toBeNull()
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
