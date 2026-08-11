/**
 * @km/tribe/message-ball-tracker — Phase 2b fanout tests.
 *
 * Covers broadcast + explicit multi-target semantics on top of the Phase 2a
 * single-recipient substrate.
 */

import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"
import { registerSession } from "./session.ts"

const PROJECT_ID = "ball-tracker-phase2b"

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

function makeOpts(activeIds: readonly string[]): HandlerOpts {
  return {
    cleanup: () => undefined,
    userRenamed: false,
    setUserRenamed: () => undefined,
    getActiveSessionIds: () => new Set(activeIds),
    hasActiveTransport: (sessionId) => activeIds.includes(sessionId),
    getActiveSessionInfo: () => [],
  }
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Record<string, unknown>
}

function pendingRecipients(db: Database, requestId: string): string[] {
  const rows = db
    .prepare("SELECT recipient FROM pending_request WHERE request_id = ? ORDER BY recipient ASC")
    .all(requestId) as Array<{ recipient: string }>
  return rows.map((row) => row.recipient)
}

describe("ball-tracker Phase 2b — broadcast and multi-target fanout", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements
  let chief: TribeContext
  let agent1: TribeContext
  let agent2: TribeContext
  let staleAgent: TribeContext

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ball-tracker-phase2b-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)

    chief = makeContext(db, stmts, "@chief", "sess-chief")
    agent1 = makeContext(db, stmts, "@agent/1", "sess-agent-1")
    agent2 = makeContext(db, stmts, "@agent/2", "sess-agent-2")
    staleAgent = makeContext(db, stmts, "@agent/stale", "sess-stale")

    registerSession(chief, PROJECT_ID, () => true, null, 1001, "push", "/repo", null, "claude")
    registerSession(agent1, PROJECT_ID, () => true, null, 1002, "push", "/repo", null, "claude")
    registerSession(agent2, PROJECT_ID, () => true, null, 1003, "push", "/repo", null, "claude")
    registerSession(staleAgent, PROJECT_ID, () => false, null, 1004, "push", "/repo", null, "claude")
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("broadcast request snapshots active room members and excludes sender", () => {
    const res = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        { to: "*", message: "who can take this?", type: "request", request: "req-broadcast", fanout: "first" },
        makeOpts(["sess-chief", "sess-agent-1", "sess-agent-2"]),
      ),
    )

    expect(res.sent).toBe(true)
    expect(pendingRecipients(db, "req-broadcast")).toEqual(["@agent/1", "@agent/2"])

    const row = db.prepare("SELECT recipient, kind, request FROM messages WHERE id = ?").get(res.id as string) as {
      recipient: string
      kind: string
      request: string | null
    }
    expect(row).toMatchObject({ recipient: "*", kind: "broadcast", request: "req-broadcast" })
  })

  it("commits broadcast ownership before the persisted message becomes observable", () => {
    let ownersAtPublish: string[] = []
    const observingChief = createTribeContext({
      db,
      stmts,
      sessionId: "sess-chief",
      sessionRole: "member",
      initialName: "@chief",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
      onMessageInserted: (message) => {
        if (message.kind === "broadcast") ownersAtPublish = pendingRecipients(db, "req-atomic-broadcast")
      },
    })

    const res = parseToolJson(
      handleToolCall(
        observingChief,
        "tribe.send",
        { to: "*", message: "commit the owners with me", type: "request", request: "req-atomic-broadcast" },
        makeOpts(["sess-chief", "sess-agent-1", "sess-agent-2"]),
      ),
    )

    expect(res.sent).toBe(true)
    expect(ownersAtPublish).toEqual(["@agent/1", "@agent/2"])
  })

  it("broadcast request:true uses the message id as the persisted request id", () => {
    const res = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        { to: "*", message: "ack this", type: "request", request: true, fanout: "all" },
        makeOpts(["sess-chief", "sess-agent-1", "sess-agent-2"]),
      ),
    )
    const id = res.id as string

    expect(pendingRecipients(db, id)).toEqual(["@agent/1", "@agent/2"])
    const row = db.prepare("SELECT request FROM messages WHERE id = ?").get(id) as { request: string | null }
    expect(row.request).toBe(id)
  })

  it("applies the request-class default to every broadcast owner", () => {
    const res = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        { to: "*", message: "ack before the next sweep", type: "request", request: "req-default-broadcast" },
        makeOpts(["sess-chief", "sess-agent-1", "sess-agent-2"]),
      ),
    )

    expect(res.sent).toBe(true)
    const rows = db
      .prepare(
        "SELECT recipient, expires_at - opened_at AS ttl_ms FROM pending_request WHERE request_id = ? ORDER BY recipient",
      )
      .all("req-default-broadcast")
    expect(rows).toEqual([
      { recipient: "@agent/1", ttl_ms: 20 * 60_000 },
      { recipient: "@agent/2", ttl_ms: 20 * 60_000 },
    ])
  })

  it("request:true sends from different senders open distinct tracker rows", () => {
    const first = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        { to: "@agent/2", message: "first", type: "notify", request: true },
        makeOpts(["sess-chief", "sess-agent-1", "sess-agent-2"]),
      ),
    )
    const second = parseToolJson(
      handleToolCall(
        agent1,
        "tribe.send",
        { to: "@agent/2", message: "second", type: "notify", request: true },
        makeOpts(["sess-chief", "sess-agent-1", "sess-agent-2"]),
      ),
    )

    expect(first.request_id).toBe(first.id)
    expect(second.request_id).toBe(second.id)
    expect(second.request_id).not.toBe(first.request_id)
    const rows = db
      .prepare("SELECT request_id, sender, message_id FROM pending_request WHERE recipient = ?")
      .all("@agent/2")
    expect(rows).toHaveLength(2)
    expect(rows).toEqual(
      expect.arrayContaining([
        { request_id: first.id, sender: "@chief", message_id: first.id },
        { request_id: second.id, sender: "@agent/1", message_id: second.id },
      ]),
    )
  })

  it('rejects the reserved explicit request id "true"', () => {
    const messagesBefore = db.prepare("SELECT COUNT(*) AS count FROM messages").get()
    const pendingBefore = db.prepare("SELECT COUNT(*) AS count FROM pending_request").get()
    const res = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        { to: "@agent/2", message: "ambiguous", type: "notify", request: "true" },
        makeOpts(["sess-chief", "sess-agent-1", "sess-agent-2"]),
      ),
    )

    expect(res.error).toMatch(/request.*true.*reserved/i)
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual(messagesBefore)
    expect(db.prepare("SELECT COUNT(*) AS count FROM pending_request").get()).toEqual(pendingBefore)
  })

  it("rejects an empty multi-target recipient list", () => {
    const res = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        { to: [], message: "nobody", type: "request", request: "req-empty" },
        makeOpts(["sess-chief", "sess-agent-1", "sess-agent-2"]),
      ),
    )

    expect(typeof res.error).toBe("string")
    expect(pendingRecipients(db, "req-empty")).toEqual([])
  })

  it("explicit multi-target request opens one pending row per named recipient", () => {
    const res = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        {
          to: ["@agent/1", "@agent/2"],
          message: "both of you ack",
          type: "request",
          request: "req-multi",
          fanout: "all",
        },
        makeOpts(["sess-chief", "sess-agent-1", "sess-agent-2"]),
      ),
    )

    expect(res.sent).toBe(true)
    expect(pendingRecipients(db, "req-multi")).toEqual(["@agent/1", "@agent/2"])

    const rows = db
      .prepare("SELECT recipient, kind, request FROM messages WHERE request = ? ORDER BY recipient ASC")
      .all("req-multi") as Array<{ recipient: string; kind: string; request: string }>
    expect(rows).toEqual([
      { recipient: "@agent/1", kind: "direct", request: "req-multi" },
      { recipient: "@agent/2", kind: "direct", request: "req-multi" },
    ])
  })

  it("splits a comma-delimited recipient string before persisting per-recipient balls", () => {
    const res = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        {
          to: "@agent/1, @agent/2",
          message: "both of you ack",
          type: "request",
          request: "req-composite",
          fanout: "all",
        },
        makeOpts(["sess-chief", "sess-agent-1", "sess-agent-2"]),
      ),
    )

    expect(res.sent).toBe(true)
    expect(pendingRecipients(db, "req-composite")).toEqual(["@agent/1", "@agent/2"])
    const recipients = (
      db
        .prepare("SELECT recipient FROM messages WHERE request = ? ORDER BY recipient ASC")
        .all("req-composite") as Array<{
        recipient: string
      }>
    ).map((row) => row.recipient)
    expect(recipients).toEqual(["@agent/1", "@agent/2"])
  })

  it("uses one implicit request id for multi-target fanout:first so the first reply settles every owner", () => {
    const sent = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        {
          to: "@agent/1,@agent/2",
          message: "either of you can accept",
          type: "request",
          fanout: "first",
        },
        makeOpts(["sess-chief", "sess-agent-1", "sess-agent-2"]),
      ),
    )
    const requestId = sent.request_id as string

    expect(requestId).toEqual(expect.any(String))
    expect(pendingRecipients(db, requestId)).toEqual(["@agent/1", "@agent/2"])
    expect(
      (
        db.prepare("SELECT DISTINCT request FROM messages WHERE id IN (?, ?)").all(...(sent.ids as string[])) as Array<{
          request: string
        }>
      ).map((row) => row.request),
    ).toEqual([requestId])

    parseToolJson(
      handleToolCall(
        agent1,
        "tribe.send",
        { to: "@chief", message: "accepted", type: "response", reply: requestId },
        makeOpts(["sess-chief", "sess-agent-1", "sess-agent-2"]),
      ),
    )
    expect(pendingRecipients(db, requestId)).toEqual([])
  })

  it("applies one per-send deadline override to every resolved recipient", () => {
    const res = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        {
          to: "@agent/1,@agent/2",
          message: "deadline shared across both owners",
          type: "request",
          request: "req-expiring-fanout",
          fanout: "all",
          expires_in_ms: 10 * 60_000,
        },
        makeOpts(["sess-chief", "sess-agent-1", "sess-agent-2"]),
      ),
    )

    expect(res.sent).toBe(true)
    const rows = db
      .prepare(
        "SELECT recipient, expires_at - opened_at AS ttl_ms FROM pending_request WHERE request_id = ? ORDER BY recipient",
      )
      .all("req-expiring-fanout") as Array<{ recipient: string; ttl_ms: number }>
    expect(rows).toEqual([
      { recipient: "@agent/1", ttl_ms: 10 * 60_000 },
      { recipient: "@agent/2", ttl_ms: 10 * 60_000 },
    ])
  })

  it("rejects malformed recipients, invalid request ids, and deadlines with no owner", () => {
    const messageCountBefore = (db.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count
    for (const args of [
      { to: "@agent/1, ,@agent/2", request: "req-empty-segment" },
      { to: "*,@agent/1", request: "req-broadcast-mix" },
      { to: "@agent/1", request: "   " },
      { to: "@agent/1", request: "req-zero-ttl", expires_in_ms: 0 },
      { to: "@agent/1", request: "req-string-ttl", expires_in_ms: "60000" },
      { to: "@agent/1", request: "req-too-long-ttl", expires_in_ms: 24 * 60 * 60 * 1_000 + 1 },
      { to: "*", expires_in_ms: 60_000 },
      { to: "@chief", expires_in_ms: 60_000 },
    ]) {
      const res = parseToolJson(
        handleToolCall(
          chief,
          "tribe.send",
          { ...args, message: "must reject", type: "request" },
          makeOpts(["sess-chief", "sess-agent-1", "sess-agent-2"]),
        ),
      )
      expect(res.error).toEqual(expect.any(String))
    }

    expect((db.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count).toBe(
      messageCountBefore,
    )
    expect((db.prepare("SELECT COUNT(*) AS count FROM pending_request").get() as { count: number }).count).toBe(0)
  })

  it("fanout='first' closes every pending recipient row on the first valid reply", () => {
    parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        { to: "*", message: "who can take this?", type: "request", request: "req-first", fanout: "first" },
        makeOpts(["sess-chief", "sess-agent-1", "sess-agent-2"]),
      ),
    )
    expect(pendingRecipients(db, "req-first")).toEqual(["@agent/1", "@agent/2"])

    parseToolJson(
      handleToolCall(
        agent1,
        "tribe.send",
        { to: "@chief", message: "I can", type: "response", reply: "req-first" },
        makeOpts(["sess-chief", "sess-agent-1", "sess-agent-2"]),
      ),
    )

    expect(pendingRecipients(db, "req-first")).toEqual([])
    const settlements = db
      .prepare("SELECT content FROM messages WHERE kind = 'event' AND type = 'event.ball.settled'")
      .all() as Array<{ content: string }>
    expect(settlements.map((row) => JSON.parse(row.content))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ request_id: "req-first", recipient: "@agent/1", settlement: "answered" }),
        expect.objectContaining({ request_id: "req-first", recipient: "@agent/2", settlement: "answered" }),
      ]),
    )
  })

  it("fanout='all' closes only the replying recipient row", () => {
    parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        { to: "*", message: "everyone ack", type: "request", request: "req-all", fanout: "all" },
        makeOpts(["sess-chief", "sess-agent-1", "sess-agent-2"]),
      ),
    )
    expect(pendingRecipients(db, "req-all")).toEqual(["@agent/1", "@agent/2"])

    parseToolJson(
      handleToolCall(
        agent1,
        "tribe.send",
        { to: "@chief", message: "acked", type: "response", reply: "req-all" },
        makeOpts(["sess-chief", "sess-agent-1", "sess-agent-2"]),
      ),
    )

    expect(pendingRecipients(db, "req-all")).toEqual(["@agent/2"])
    const settlements = db
      .prepare("SELECT content FROM messages WHERE kind = 'event' AND type = 'event.ball.settled'")
      .all() as Array<{ content: string }>
    expect(settlements.map((row) => JSON.parse(row.content))).toEqual([
      expect.objectContaining({ request_id: "req-all", recipient: "@agent/1", settlement: "answered" }),
    ])
  })

  it("warns with the peer's open balls when a reply closes zero rows", () => {
    const opened = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        { to: "@agent/1", message: "review this", type: "request", request: "actual-request" },
        makeOpts(["sess-chief", "sess-agent-1"]),
      ),
    )

    db.prepare("UPDATE pending_request SET expires_at = 0 WHERE request_id = 'actual-request'").run()

    const reply = parseToolJson(
      handleToolCall(
        agent1,
        "tribe.send",
        { to: "@chief", message: "reviewed", type: "response", reply: "mistyped-request" },
        makeOpts(["sess-chief", "sess-agent-1"]),
      ),
    )

    expect(reply.tracker).toEqual({ request_id: "mistyped-request", closed: 0 })
    expect(reply.reply_close_failed).toBe(true)
    expect(reply.warning).toContain("closed 0")
    expect(reply.warning).toContain("actual-request")
    expect(reply.warning).toContain(opened.id)
    expect(pendingRecipients(db, "actual-request")).toEqual(["@agent/1"])

    const expired = parseToolJson(
      handleToolCall(agent1, "tribe.pending", { expired: true, owed: true }, makeOpts(["sess-agent-1"])),
    ) as { pending: Array<{ request_id: string }> }
    expect(expired.pending).toEqual([expect.objectContaining({ request_id: "actual-request" })])
  })

  it("reports failure when a reply closes zero rows and the replier owns no balls at all", () => {
    // The worst case, and the one that reads as clean success: a fabricated or
    // truncated id matched nothing AND there was nothing it could have matched,
    // so the "here are your open balls" listing has nothing to print.
    const reply = parseToolJson(
      handleToolCall(
        agent1,
        "tribe.send",
        { to: "@chief", message: "acked", summary: "acked", type: "response", reply: "never-existed" },
        makeOpts(["sess-chief", "sess-agent-1"]),
      ),
    )

    expect(reply.sent).toBe(true)
    expect(reply.tracker).toEqual({ request_id: "never-existed", closed: 0 })
    expect(reply.reply_close_failed).toBe(true)
    expect(reply.warning).toContain("closed 0 rows")
    expect(reply.warning).toContain("@agent/1 owns no open balls")
  })

  it("leaves no failure flag on a reply that actually closed a row", () => {
    parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        { to: "@agent/1", message: "review this", type: "request", request: "real-request" },
        makeOpts(["sess-chief", "sess-agent-1"]),
      ),
    )

    const reply = parseToolJson(
      handleToolCall(
        agent1,
        "tribe.send",
        { to: "@chief", message: "reviewed", summary: "reviewed", type: "response", reply: "real-request" },
        makeOpts(["sess-chief", "sess-agent-1"]),
      ),
    )

    expect(reply.tracker).toEqual({ request_id: "real-request", closed: 1 })
    expect(reply.reply_close_failed).toBeUndefined()
    expect(reply.warning).toBeUndefined()
  })

  it("accepts a late reply because deadline passage never releases ownership", () => {
    parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        { to: "@agent/1", message: "deadline review", type: "request", request: "late-request" },
        makeOpts(["sess-chief", "sess-agent-1"]),
      ),
    )
    db.prepare("UPDATE pending_request SET expires_at = 0 WHERE request_id = ?").run("late-request")

    const reply = parseToolJson(
      handleToolCall(
        agent1,
        "tribe.send",
        { to: "@chief", message: "late defer", summary: "late defer", type: "response", reply: "late-request" },
        makeOpts(["sess-chief", "sess-agent-1"]),
      ),
    )

    expect(reply.tracker).toEqual({ request_id: "late-request", closed: 1 })
    expect(reply.reply_close_failed).toBeUndefined()
    expect(reply.warning).toBeUndefined()
    expect(pendingRecipients(db, "late-request")).toEqual([])
  })

  it("keeps a deadline-passed row owned and visible while recording one durable expiry edge", () => {
    parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        {
          to: "@agent/1",
          message: "deadline escalates ownership at the daemon boundary",
          type: "request",
          request: "deadline-passed-open",
          expires_in_ms: 60_000,
        },
        makeOpts(["sess-chief", "sess-agent-1"]),
      ),
    )
    db.prepare("UPDATE pending_request SET expires_at = 0 WHERE request_id = ?").run("deadline-passed-open")

    const active = parseToolJson(handleToolCall(agent1, "tribe.pending", {}, makeOpts(["sess-chief", "sess-agent-1"])))
    expect(active.pending).toEqual([expect.objectContaining({ request_id: "deadline-passed-open", status: "expired" })])
    expect(pendingRecipients(db, "deadline-passed-open")).toEqual(["@agent/1"])

    const expiryFacts = db
      .prepare("SELECT type, kind, content FROM messages WHERE kind = 'event' AND type = 'event.ball.expired'")
      .all() as Array<{ type: string; kind: string; content: string }>
    expect(expiryFacts).toHaveLength(1)
    expect(JSON.parse(expiryFacts[0]!.content)).toMatchObject({
      schema_version: 2,
      request_id: "deadline-passed-open",
      recipient: "@agent/1",
      sender: "@chief",
      observation: "deadline-passed",
      observed_at: expect.any(Number),
      expires_at: 0,
    })
    expect(JSON.parse(expiryFacts[0]!.content)).not.toHaveProperty("settlement")

    // Lazy expiry can be checked by many subsequent RPCs. The journal fact is
    // an edge and must stay exactly-once while ownership remains active.
    parseToolJson(handleToolCall(agent1, "tribe.pending", {}, makeOpts(["sess-chief", "sess-agent-1"])))
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM messages WHERE kind = 'event' AND type = 'event.ball.expired'").get(),
    ).toEqual({ count: 1 })
  })
})
