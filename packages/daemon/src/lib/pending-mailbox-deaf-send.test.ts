/**
 * 24581 — refuse a TRACKED ball on a recipient whose
 * mailbox_read_capability.state is unavailable. Untracked notify to a
 * relay still delivers. Names with no sessions row keep the existing
 * unresolved/offline path (not this rule).
 */
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import tribeHabModule from "../../../../hab.projects.ts"
import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { prefixFallbackDeliveryResolver } from "./delivery-resolution.ts"
import { handleToolCall, type ActiveSessionInfo, type HandlerOpts } from "./handlers.ts"
import { registerSession } from "./session.ts"

const PROJECT_ID = "pending-mailbox-deaf-send"
/** The sid a verified identity token recorded on its session row: that seat reads its own mailbox (25074 3d-3). */
const VERIFIED_SID = "sid-verified"

function makeContext(db: Database, stmts: TribeStatements, sessionId: string, name: string): TribeContext {
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

function addSession(
  db: Database,
  stmts: TribeStatements,
  sessionId: string,
  name: string,
  identitySid: string | null,
): void {
  const ctx = makeContext(db, stmts, sessionId, name)
  registerSession(ctx, PROJECT_ID, () => false, null, process.pid, "pull", "/repo", null, "codex", null, null)
  // The dispatcher records a verified token's sid on the row after the register (with-dispatcher.ts, 25074 3b).
  if (identitySid !== null) {
    db.prepare("UPDATE sessions SET identity_sid = ?, identity_gen = 1 WHERE id = ?").run(identitySid, sessionId)
  }
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Record<string, unknown>
}

function liveInfo(id: string, name: string): ActiveSessionInfo {
  return {
    id,
    name,
    pid: process.pid,
    cwd: "/repo",
    role: "member",
    claudeSessionId: null,
    registeredAt: Date.now(),
    launchId: null,
    launchParentPid: null,
    transportPids: [process.pid],
    pushTransportPids: [],
  }
}

function optsWithLive(info: ActiveSessionInfo[]): HandlerOpts {
  const ids = new Set(info.map((row) => row.id))
  return {
    cleanup: () => undefined,
    userRenamed: false,
    setUserRenamed: () => undefined,
    getActiveSessionIds: () => ids,
    hasActiveTransport: (id) => ids.has(id),
    getActiveSessionInfo: () => info,
  }
}

describe("24581: tracked send to mailbox-deaf recipient is refused", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), `${PROJECT_ID}-`))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // 27966: existing projection coverage supplies request and misses implicit admission.
  it.each(["request", "query", "assign"])("tracks implicit broadcast %s for each admitted owner", (type) => {
    const names = ["@dev/sender", "@dev/a", "@dev/b"] as const
    for (const [i, name] of names.entries()) addSession(db, stmts, `sess-${i}`, name, `sid-${i}`)
    const opts = optsWithLive(names.map((name, i) => liveInfo(`sess-${i}`, name)))
    const contexts = names.map((name, i) => makeContext(db, stmts, `sess-${i}`, name))
    const call = (i: number, method: string, args: Record<string, unknown>) =>
      parseToolJson(handleToolCall(contexts[i]!, method, args, opts))
    const sent = call(0, "tribe.send", { to: "*", type, message: "every owner answers", fanout: "all" })
    expect(sent.sent).toBe(true)
    expect(sent.request_id).toBe(sent.id)
    for (const i of [1, 2] as const) {
      expect(stmts.selectPendingForRecipient.all({ $recipient: names[i] })).toHaveLength(1)
      for (let read = 0; read < 2; read++) {
        expect(call(i, "tribe.fetch", {})).toMatchObject({
          attention: {
            actionable_unread: [expect.objectContaining({ id: sent.id })],
            pending_balls: [expect.objectContaining({ request_id: sent.id })],
          },
        })
      }
      expect(call(i, "tribe.fetch", { ids: [sent.id] })).toMatchObject({
        events: [expect.objectContaining({ id: sent.id, content: "every owner answers" })],
      })
    }
    call(1, "tribe.send", { to: names[0], type: "status", message: "TAKING", ref: sent.id })
    expect(call(1, "tribe.fetch", {})).toMatchObject({
      attention: { actionable_unread: [], pending_balls: [expect.objectContaining({ request_id: sent.id })] },
    })
    expect(call(2, "tribe.fetch", {})).toMatchObject({
      attention: { actionable_unread: [expect.objectContaining({ id: sent.id })] },
    })
    expect(call(1, "tribe.send", { to: names[0], type: "response", message: "A done", reply: sent.id })).toMatchObject({
      tracker: { closed: 1 },
    })
    expect(stmts.selectPendingForRecipient.all({ $recipient: names[1] })).toHaveLength(0)
    expect(stmts.selectPendingForRecipient.all({ $recipient: names[2] })).toHaveLength(1)
    expect(call(2, "tribe.send", { to: names[0], type: "response", message: "B done", reply: sent.id })).toMatchObject({
      tracker: { closed: 1 },
    })
  })

  it.each([undefined, "first"])("preserves first-answer settlement with fanout %s", (fanout) => {
    const names = ["@dev/sender", "@dev/a", "@dev/b"] as const
    for (const [i, name] of names.entries()) addSession(db, stmts, `sess-${i}`, name, `sid-${i}`)
    const opts = optsWithLive(names.map((name, i) => liveInfo(`sess-${i}`, name)))
    const contexts = names.map((name, i) => makeContext(db, stmts, `sess-${i}`, name))
    const call = (i: number, args: Record<string, unknown>) =>
      parseToolJson(handleToolCall(contexts[i]!, "tribe.send", args, opts))
    const sent = call(0, { to: "*", type: "request", message: "someone take this", ...(fanout ? { fanout } : {}) })
    expect(sent.sent).toBe(true)
    call(1, { to: names[0], type: "status", message: "TAKING", ref: sent.id })
    // A receipt leaves the sibling eligible; this change does not introduce exclusive claims.
    expect(parseToolJson(handleToolCall(contexts[2]!, "tribe.fetch", {}, opts))).toMatchObject({
      attention: { actionable_unread: [expect.objectContaining({ id: sent.id })] },
    })
    expect(call(1, { to: names[0], type: "response", message: "done", reply: sent.id })).toMatchObject({
      tracker: { closed: 2 },
    })
    for (const name of names.slice(1)) expect(stmts.selectPendingForRecipient.all({ $recipient: name })).toHaveLength(0)
  })

  it("does not advertise ownership for anonymous broadcasts or ordinary notifications", () => {
    addSession(db, stmts, "recipient", "@dev/a", VERIFIED_SID)
    addSession(db, stmts, "sender", "@dev/sender", "sender-sid")
    const opts = optsWithLive([liveInfo("recipient", "@dev/a"), liveInfo("sender", "@dev/sender")])
    const anonymous = createTribeContext({
      db,
      stmts,
      sessionId: "anonymous",
      sessionRole: "pending",
      initialName: "pending-anonymous",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    const sender = makeContext(db, stmts, "sender", "@dev/sender")
    for (const [ctx, type] of [
      [anonymous, "request"],
      [sender, "notify"],
    ] as const) {
      const sent = parseToolJson(handleToolCall(ctx, "tribe.send", { to: "*", type, message: "ambient" }, opts))
      expect(sent.sent).toBe(true)
      expect(sent).not.toHaveProperty("request_id")
      expect(stmts.selectPendingForRecipient.all({ $recipient: "@dev/a" })).toHaveLength(0)
    }
  })

  it("uses existing empty-owner refusal for an implicit broadcast request", () => {
    addSession(db, stmts, "sender", "@dev/sender", VERIFIED_SID)
    const sender = makeContext(db, stmts, "sender", "@dev/sender")
    const opts = optsWithLive([liveInfo("sender", "@dev/sender")])
    const sent = parseToolJson(
      handleToolCall(
        sender,
        "tribe.send",
        {
          to: "*",
          type: "request",
          message: "nobody admitted",
        },
        opts,
      ),
    )
    expect(sent.error).toContain("no online recipients")
    expect(db.query("SELECT * FROM messages WHERE content = ?").all("nobody admitted")).toHaveLength(0)
    expect(
      parseToolJson(
        handleToolCall(
          sender,
          "tribe.send",
          {
            to: "*",
            type: "request",
            message: "no new opt-out",
            request: false,
          },
          opts,
        ),
      ).error,
    ).toContain("invalid request")
  })

  it("refuses a tracked request to telegram (connected, mailbox authority missing)", () => {
    addSession(db, stmts, "sess-telegram", "telegram", null)
    const sender = makeContext(db, stmts, "sess-dev12", "@dev/12")
    const sent = parseToolJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: "telegram", message: "who holds admission", type: "request" },
        optsWithLive([liveInfo("sess-telegram", "telegram")]),
      ),
    )
    expect(String(sent.error ?? "")).toContain("tribe.send: failed to deliver to telegram - not online")
    expect(String(sent.detail ?? "")).toContain("mailbox_read_capability.state is unavailable")
    expect(String(sent.detail ?? "")).toContain("self-mailbox-authority-missing")
    const remaining = stmts.selectPendingForRecipient.all({ $recipient: "telegram" }) as unknown[]
    expect(remaining).toHaveLength(0)
  })

  it("delivers an untracked notify to telegram and opens no ball", () => {
    addSession(db, stmts, "sess-telegram", "telegram", null)
    const sender = makeContext(db, stmts, "sess-dev12", "@dev/12")
    const sent = parseToolJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: "telegram", message: "status only", type: "notify" },
        optsWithLive([liveInfo("sess-telegram", "telegram")]),
      ),
    )
    expect(sent.error).toBeUndefined()
    expect(sent.sent).toBe(true)
    const remaining = stmts.selectPendingForRecipient.all({ $recipient: "telegram" }) as unknown[]
    expect(remaining).toHaveLength(0)
  })

  /**
   * @failure A watcher's incident cannot be raised because its owner's mailbox is unreadable.
   * @level l2
   * @consumer The incident rail (tools/lib/tribe-incident.ts sends --type request --incident).
   */
  it("admits an incident edge to a mailbox-deaf owner: a condition promises no answer (24644)", () => {
    addSession(db, stmts, "sess-chief", "@chief", null)
    const sender = makeContext(db, stmts, "sess-watch", "@watch")
    const sent = parseToolJson(
      handleToolCall(
        sender,
        "tribe.send",
        {
          to: "@chief",
          message: "this tick observed nothing",
          type: "request",
          incident: { emitter: "@watch", subject: "claude-seats", condition: "blind-sweep" },
        },
        optsWithLive([liveInfo("sess-chief", "@chief")]),
      ),
    )
    expect(sent.error).toBeUndefined()
    expect(sent.sent).toBe(true)
    // Still a tracked ball: the ball is what puts the live condition in the fleet's attention.
    expect(stmts.selectPendingForRecipient.all({ $recipient: "@chief" })).toHaveLength(1)
  })

  it("NEGATIVE: tracked request to a seat registered with a verified identity token still opens", () => {
    addSession(db, stmts, "sess-dev6", "@dev/6", VERIFIED_SID)
    const sender = makeContext(db, stmts, "sess-dev12", "@dev/12")
    const sent = parseToolJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: "@dev/6", message: "work", type: "request" },
        optsWithLive([liveInfo("sess-dev6", "@dev/6")]),
      ),
    )
    expect(sent.error).toBeUndefined()
    const remaining = stmts.selectPendingForRecipient.all({ $recipient: "@dev/6" }) as unknown[]
    expect(remaining).toHaveLength(1)
  })

  /**
   * @failure A tracked request falls back to a connected owner who cannot read it.
   * @level l2
   * @consumer Requests using the deployed @ci -> @chief fallback policy.
   */
  it.each([
    ["unreadable", null, 0],
    ["readable", VERIFIED_SID, 1],
  ] as const)("checks the %s final owner before opening a fallback ball", (_state, sid, expectedBalls) => {
    addSession(db, stmts, "sess-chief", "@chief", sid)
    const sender = makeContext(db, stmts, "sess-dev12", "@dev/12")
    const sent = parseToolJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: "@ci", message: "who holds admission", type: "request" },
        {
          ...optsWithLive([liveInfo("sess-chief", "@chief")]),
          resolveDelivery: prefixFallbackDeliveryResolver(tribeHabModule.habitants.wire.env.TRIBE_DELIVERY_FALLBACKS),
        },
      ),
    )
    expect(stmts.selectPendingForRecipient.all({ $recipient: "@chief" })).toHaveLength(expectedBalls)
    if (expectedBalls === 0) {
      expect(sent.error).toContain("tribe.send: failed to deliver to @ci - not online")
      expect(sent.detail).toContain('"@chief"')
      expect(sent.detail).toContain("mailbox_read_capability.state is unavailable")
      expect(sent.detail).toContain('"@ci"')
      expect(sent.detail).toContain("self-mailbox-authority-missing")
      expect(sent.detail).toContain('Restore mailbox authority for "@chief"')
      expect(
        db.prepare("SELECT id FROM messages WHERE kind = 'direct' AND content = ?").get("who holds admission"),
      ).toBeNull()
    } else {
      expect(sent.error).toBeUndefined()
      expect(sent.sent).toBe(true)
    }
  })
})
