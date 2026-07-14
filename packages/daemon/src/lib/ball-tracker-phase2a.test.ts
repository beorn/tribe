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
import { sendMessage } from "./messaging.ts"

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
    expect(TRIBE_JOIN_PRIMER).toMatch(/automatically open(?:s)? a semantic response ball/i)
    expect(TRIBE_JOIN_PRIMER).toContain("reply=<request-id>")
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

  it("every typed direct actionable owns a durable recipient ball even when request is omitted", () => {
    const chief = makeContext(db, stmts, "@chief")

    for (const type of ["request", "query", "assign", "verdict"] as const) {
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

  it("an actionable reply closes the prior ball and opens its own recipient obligation", () => {
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
    expect(pending).toEqual([{ request_id: verdict.id, recipient: "@agent/8", sender: "@ci" }])
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

    expect(() => sendMessage(chief, "@agent/8", "must be atomic", "verdict")).toThrow("tracker unavailable")
    expect((db.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count).toBe(0)
    expect(delivered).toBe(false)
  })

  it("implicit tracking excludes non-actionables, self-send, and broadcasts", () => {
    const chief = makeContext(db, stmts, "@chief")
    for (const type of ["notify", "status", "response"] as const) {
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
