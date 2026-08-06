/**
 * @km/tribe/message-ball-tracker — Phase 2a wire-up test.
 *
 * Verifies the end-to-end ball-tracker semantics for the 1:1 (single-recipient)
 * case:
 *
 *  (1) `sendMessage(..., { request: "<id>" })` writes both the messages row
 *      (with `request` column populated) AND a pending_request row for the
 *      recipient.
 *  (2) `sendMessage(..., { reply: "<id>" })` writes the messages row AND
 *      deletes the matching pending_request row (sender=>recipient swapped
 *      since the reply flows back).
 *  (3) Event rows (kind='event' via logEvent) never participate — no
 *      pending_request row is created even if request were set.
 *  (4) `selectPendingForRecipient` returns open requests sorted oldest-first.
 *
 * Broadcast and explicit multi-target fanout are covered at the `handleSend`
 * layer; this file keeps the lower-level `sendMessage` substrate pinned to one
 * durable recipient string.
 */

import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { createTribeContext, type TribeContext } from "./context.ts"
import { TRIBE_JOIN_PRIMER } from "./handlers.ts"
import { DEFAULT_BALL_TTL_MS_BY_CLASS, sendMessage } from "./messaging.ts"

function makeContext(
  db: Database,
  stmts: TribeStatements,
  name: string,
  onMessageInserted?: TribeContext["onMessageInserted"],
): TribeContext {
  return createTribeContext({
    db,
    stmts,
    sessionId: `sess-${name}`,
    sessionRole: "member",
    initialName: name,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
    onMessageInserted,
  })
}

describe("ball-tracker Phase 2a — 1:1 wire-up", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ball-tracker-phase2a-"))
    const dbPath = join(tmpDir, "tribe.db")
    db = openDatabase(dbPath)
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("startup primer teaches semantic ownership and reply, never an exact-id delivery ack", () => {
    expect(TRIBE_JOIN_PRIMER).toMatch(/assign.*query.*request.*automatically open(?:s)? a semantic response ball/i)
    expect(TRIBE_JOIN_PRIMER).toMatch(/verdict.*actionable.*does not automatically open/i)
    expect(TRIBE_JOIN_PRIMER).toContain('MCP `reply: "<request-id>"` field')
    expect(TRIBE_JOIN_PRIMER).toContain("CLI: `--reply <request-id>`")
    expect(TRIBE_JOIN_PRIMER).toContain("never a prose `reply=...` marker")
    expect(TRIBE_JOIN_PRIMER).not.toMatch(/<ack(?:\s+id=)?/i)
  })

  it("request: opens a pending_request row for the recipient", () => {
    const chief = makeContext(db, stmts, "@chief")
    const result = sendMessage(
      chief,
      "@agent/8",
      "verdict needed",
      "query",
      undefined,
      undefined,
      "direct",
      {},
      { request: "req-abc-123" },
    )

    // Message row carries the request column.
    const msgRow = db.prepare("SELECT request, reply FROM messages WHERE id = ?").get(result.id) as {
      request: string | null
      reply: string | null
    }
    expect(msgRow.request).toBe("req-abc-123")
    expect(msgRow.reply).toBeNull()

    // Pending row exists for the recipient.
    const pendingRows = db
      .prepare("SELECT request_id, recipient, sender, message_id, fanout FROM pending_request WHERE request_id = ?")
      .all("req-abc-123") as Array<{
      request_id: string
      recipient: string
      sender: string
      message_id: string
      fanout: string
    }>
    expect(pendingRows).toHaveLength(1)
    expect(pendingRows[0]).toMatchObject({
      request_id: "req-abc-123",
      recipient: "@agent/8",
      sender: "@chief",
      message_id: result.id,
      fanout: "first",
    })
  })

  it("applies the 20-minute class default and preserves an explicit sender override", () => {
    const chief = makeContext(db, stmts, "@chief")
    const defaults = (["request", "query", "assign"] as const).map((type) =>
      sendMessage(chief, "@agent/8", `${type} default deadline`, type),
    )
    const explicitTtl = sendMessage(
      chief,
      "@agent/8",
      "short deadline",
      "notify",
      undefined,
      undefined,
      "direct",
      {},
      { request: "short-deadline", expiresInMs: 5 * 60_000 },
    )

    const rows = db
      .prepare("SELECT message_id, opened_at, expires_at FROM pending_request ORDER BY opened_at, request_id")
      .all() as Array<{ message_id: string; opened_at: number; expires_at: number | null }>
    for (const result of defaults) {
      const row = rows.find((candidate) => candidate.message_id === result.id)!
      expect(row.expires_at).not.toBeNull()
      expect(row.expires_at! - row.opened_at).toBe(20 * 60_000)
    }
    for (const ttl of Object.values(DEFAULT_BALL_TTL_MS_BY_CLASS)) expect(ttl).toBeLessThan(30 * 60_000)
    expect(rows.find((row) => row.message_id === explicitTtl.id)?.expires_at).toBe(
      rows.find((row) => row.message_id === explicitTtl.id)!.opened_at + 5 * 60_000,
    )
  })

  it("reply: closes the matching pending_request row", () => {
    const chief = makeContext(db, stmts, "@chief")
    const agent = makeContext(db, stmts, "@agent/8")

    // Open: chief → agent/8
    sendMessage(
      chief,
      "@agent/8",
      "verdict needed",
      "query",
      undefined,
      undefined,
      "direct",
      {},
      {
        request: "req-xyz-789",
      },
    )
    expect(
      (db.prepare("SELECT COUNT(*) as c FROM pending_request WHERE request_id = ?").get("req-xyz-789") as { c: number })
        .c,
    ).toBe(1)

    // Close: agent/8 → chief with reply
    const replyResult = sendMessage(
      agent,
      "@chief",
      "yes, ship it",
      "response",
      undefined,
      undefined,
      "direct",
      {},
      {
        reply: "req-xyz-789",
      },
    )
    expect(replyResult.tracker).toEqual({ request_id: "req-xyz-789", closed: 1 })

    // Pending row gone.
    expect(
      (db.prepare("SELECT COUNT(*) as c FROM pending_request WHERE request_id = ?").get("req-xyz-789") as { c: number })
        .c,
    ).toBe(0)

    // But the messages rows are both still there.
    const msgs = db
      .prepare("SELECT type, sender, request, reply FROM messages WHERE request = ? OR reply = ?")
      .all("req-xyz-789", "req-xyz-789") as Array<{
      type: string
      sender: string
      request: string | null
      reply: string | null
    }>
    expect(msgs).toHaveLength(2)
    const open = msgs.find((m) => m.request === "req-xyz-789")
    const close = msgs.find((m) => m.reply === "req-xyz-789")
    expect(open?.sender).toBe("@chief")
    expect(open?.type).toBe("query")
    expect(close?.sender).toBe("@agent/8")
    expect(close?.type).toBe("response")
  })

  it("a reply closes its open ball even after an override deadline has passed", () => {
    const chief = makeContext(db, stmts, "@chief")
    const agent = makeContext(db, stmts, "@agent/8")
    sendMessage(
      chief,
      "@agent/8",
      "deadline-bound review",
      "query",
      undefined,
      undefined,
      "direct",
      {},
      { request: "expired-before-reply" },
    )
    db.prepare("UPDATE pending_request SET expires_at = 0 WHERE request_id = ?").run("expired-before-reply")

    const reply = sendMessage(
      agent,
      "@chief",
      "late defer: I still need more time",
      "response",
      undefined,
      undefined,
      "direct",
      {},
      { reply: "expired-before-reply" },
    )

    expect(reply.tracker).toEqual({ request_id: "expired-before-reply", closed: 1 })
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM pending_request WHERE request_id = ?")
          .get("expired-before-reply") as {
          count: number
        }
      ).count,
    ).toBe(0)
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM messages WHERE reply = ?").get("expired-before-reply") as {
          count: number
        }
      ).count,
    ).toBe(1)
  })

  it("reply: accepts the opening message id and records the canonical request id", () => {
    const chief = makeContext(db, stmts, "@chief")
    const agent = makeContext(db, stmts, "@agent/8")
    const request = sendMessage(
      chief,
      "@agent/8",
      "verdict needed",
      "query",
      undefined,
      undefined,
      "direct",
      {},
      { request: "semantic-request-id" },
    )

    const reply = sendMessage(
      agent,
      "@chief",
      "approved",
      "response",
      undefined,
      undefined,
      "direct",
      {},
      { reply: request.id },
    )

    expect(reply.tracker).toEqual({ request_id: "semantic-request-id", closed: 1 })
    expect(db.prepare("SELECT reply FROM messages WHERE id = ?").get(reply.id)).toEqual({
      reply: "semantic-request-id",
    })
    expect(
      db.prepare("SELECT request_id FROM pending_request WHERE request_id = ?").get("semantic-request-id"),
    ).toBeNull()
  })

  it("fanout='all' is recorded but Phase 2a still uses per-recipient close semantics", () => {
    const chief = makeContext(db, stmts, "@chief")
    sendMessage(
      chief,
      "@agent/8",
      "individual ack please",
      "request",
      undefined,
      undefined,
      "direct",
      {},
      {
        request: "req-fanout-all",
        fanout: "all",
      },
    )
    const row = db.prepare("SELECT fanout FROM pending_request WHERE request_id = ?").get("req-fanout-all") as {
      fanout: string
    } | null
    expect(row?.fanout).toBe("all")
  })

  it("event-kind rows never write pending_request even with request set", () => {
    const chief = makeContext(db, stmts, "@chief")
    sendMessage(
      chief,
      "@agent/8",
      "shouldn't track",
      "notify",
      undefined,
      undefined,
      "event",
      {},
      {
        request: "req-event-should-be-skipped",
      },
    )
    const rows = db
      .prepare("SELECT COUNT(*) as c FROM pending_request WHERE request_id = ?")
      .get("req-event-should-be-skipped") as { c: number }
    expect(rows.c).toBe(0)
  })

  it("broadcast (`*`) is journaled by sendMessage; handleSend owns pending snapshots", () => {
    const chief = makeContext(db, stmts, "@chief")
    sendMessage(
      chief,
      "*",
      "all-hands",
      "notify",
      undefined,
      undefined,
      "direct",
      {},
      {
        request: "req-broadcast-deferred",
      },
    )
    // sendMessage records the broadcast row only; handleSend resolves the live
    // room_members snapshot and opens per-recipient pending rows.
    const rows = db
      .prepare("SELECT COUNT(*) as c FROM pending_request WHERE request_id = ?")
      .get("req-broadcast-deferred") as { c: number }
    expect(rows.c).toBe(0)
    // The message row itself records the request id for the higher-level
    // handler path to use as the snapshot's tracker id.
    const msg = db.prepare("SELECT request, kind FROM messages WHERE request = ?").get("req-broadcast-deferred") as {
      request: string
      kind: string
    } | null
    expect(msg?.request).toBe("req-broadcast-deferred")
    expect(msg?.kind).toBe("broadcast")
  })

  it("messages without request/reply leave pending_request untouched", () => {
    const chief = makeContext(db, stmts, "@chief")
    sendMessage(chief, "@agent/8", "plain notify", "notify")
    const count = (db.prepare("SELECT COUNT(*) as c FROM pending_request").get() as { c: number }).c
    expect(count).toBe(0)
  })

  it("request, query, and assign own a durable recipient ball when request is omitted", () => {
    const chief = makeContext(db, stmts, "@chief")

    for (const type of ["request", "query", "assign"] as const) {
      const result = sendMessage(chief, "@agent/8", `${type} payload`, type)
      const message = db.prepare("SELECT request FROM messages WHERE id = ?").get(result.id) as {
        request: string | null
      }
      const pending = db
        .prepare("SELECT request_id, recipient, sender, message_id FROM pending_request WHERE request_id = ?")
        .get(result.id) as {
        request_id: string
        recipient: string
        sender: string
        message_id: string
      } | null

      expect(message.request, type).toBe(result.id)
      expect(pending, type).toEqual({
        request_id: result.id,
        recipient: "@agent/8",
        sender: "@chief",
        message_id: result.id,
      })
    }
  })

  it("verdict stays actionable without auto-minting, while explicit tracking works for any direct type", () => {
    const chief = makeContext(db, stmts, "@chief")
    const implicitVerdict = sendMessage(chief, "@agent/8", "REVISE", "verdict")
    const explicitVerdict = sendMessage(
      chief,
      "@agent/8",
      "REVISE and acknowledge",
      "verdict",
      undefined,
      undefined,
      "direct",
      {},
      { request: true },
    )
    const explicitNotify = sendMessage(
      chief,
      "@agent/8",
      "informational but tracked",
      "notify",
      undefined,
      undefined,
      "direct",
      {},
      { request: "tracked-notify" },
    )

    const verdictMessage = db.prepare("SELECT request FROM messages WHERE id = ?").get(implicitVerdict.id) as {
      request: string | null
    }
    expect(verdictMessage.request).toBeNull()
    expect(db.prepare("SELECT request_id FROM pending_request WHERE message_id = ?").get(implicitVerdict.id)).toBeNull()
    expect(db.prepare("SELECT request_id FROM pending_request WHERE message_id = ?").get(explicitVerdict.id)).toEqual({
      request_id: explicitVerdict.id,
    })
    expect(db.prepare("SELECT request_id FROM pending_request WHERE message_id = ?").get(explicitNotify.id)).toEqual({
      request_id: "tracked-notify",
    })
  })

  it("a verdict reply closes the prior ball without opening a new recipient obligation", () => {
    const author = makeContext(db, stmts, "@agent/8")
    const reviewer = makeContext(db, stmts, "@ci")
    const review = sendMessage(author, "@ci", "review this candidate", "request")

    const verdict = sendMessage(
      reviewer,
      "@agent/8",
      "REVISE before continuing",
      "verdict",
      undefined,
      undefined,
      "direct",
      {},
      { reply: review.id },
    )

    const pending = db
      .prepare("SELECT request_id, recipient, sender FROM pending_request ORDER BY opened_at ASC")
      .all() as Array<{ request_id: string; recipient: string; sender: string }>
    expect(verdict.tracker).toEqual({ request_id: review.id, closed: 1 })
    expect(pending).toEqual([])
  })

  it("rolls the message back when opening its mandatory actionable ball fails", () => {
    let delivered = false
    const broken = {
      ...stmts,
      openPendingRequest: {
        run: () => {
          throw new Error("tracker unavailable")
        },
      },
    } as unknown as TribeStatements
    const chief = makeContext(db, broken, "@chief", () => {
      delivered = true
    })

    expect(() => sendMessage(chief, "@agent/8", "must be atomic", "assign")).toThrow("tracker unavailable")
    expect((db.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count).toBe(0)
    expect(delivered).toBe(false)
  })

  it("implicit tracking excludes informational and wake-only types, self-send, and broadcasts", () => {
    const chief = makeContext(db, stmts, "@chief")
    for (const type of ["notify", "status", "response", "verdict"] as const) {
      sendMessage(chief, "@agent/8", `${type} payload`, type)
    }
    sendMessage(chief, "@chief", "self query", "query")
    sendMessage(chief, "*", "broadcast assignment", "assign")

    expect((db.prepare("SELECT COUNT(*) AS count FROM pending_request").get() as { count: number }).count).toBe(0)
  })

  it("ref threads context but never releases a ball; only reply does", () => {
    const chief = makeContext(db, stmts, "@chief")
    const agent = makeContext(db, stmts, "@agent/8")
    const request = sendMessage(
      chief,
      "@agent/8",
      "need ack",
      "notify",
      undefined,
      undefined,
      "direct",
      {},
      {
        request: "req-ref-proof",
      },
    )

    sendMessage(agent, "@chief", "threaded but not closed", "response", undefined, "req-ref-proof")
    expect(db.prepare("SELECT request_id FROM pending_request WHERE message_id = ?").get(request.id)).toEqual({
      request_id: "req-ref-proof",
    })

    sendMessage(
      agent,
      "@chief",
      "closed semantically",
      "response",
      undefined,
      undefined,
      "direct",
      {},
      {
        reply: "req-ref-proof",
      },
    )
    expect(db.prepare("SELECT request_id FROM pending_request WHERE message_id = ?").get(request.id)).toBeNull()
  })

  it("selectPendingForRecipient returns rows oldest-first", () => {
    const chief = makeContext(db, stmts, "@chief")
    sendMessage(chief, "@agent/8", "first", "request", undefined, undefined, "direct", {}, { request: "req-1" })
    // Force a 2ms gap so opened_at differs deterministically.
    const start = Date.now()
    while (Date.now() - start < 2) {
      // spin
    }
    sendMessage(chief, "@agent/8", "second", "request", undefined, undefined, "direct", {}, { request: "req-2" })

    const pending = stmts.selectPendingForRecipient.all({ $recipient: "@agent/8" }) as Array<{
      request_id: string
    }>
    expect(pending.map((p) => p.request_id)).toEqual(["req-1", "req-2"])
  })

  it("idempotent: re-opening same (request_id, recipient) is a no-op (ON CONFLICT DO NOTHING)", () => {
    const chief = makeContext(db, stmts, "@chief")
    sendMessage(
      chief,
      "@agent/8",
      "first send",
      "request",
      undefined,
      undefined,
      "direct",
      {},
      {
        request: "req-dedup",
      },
    )
    sendMessage(
      chief,
      "@agent/8",
      "second send",
      "request",
      undefined,
      undefined,
      "direct",
      {},
      {
        request: "req-dedup",
      },
    )
    const rows = (
      db.prepare("SELECT COUNT(*) as c FROM pending_request WHERE request_id = ?").get("req-dedup") as {
        c: number
      }
    ).c
    expect(rows).toBe(1)
  })
})
