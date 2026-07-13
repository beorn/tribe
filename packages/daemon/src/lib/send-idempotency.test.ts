/**
 * @failure @km/tribe/19864-codex-tribe-name/20703-native-codex-mcp-startup-regression
 * @level unit
 * @consumer tribe wire client send-retry-on-reconnect (idempotency-keyed sends)
 *
 * Safe-reload doctrine: a daemon restart must never cause a DUPLICATED send.
 * The wire client re-issues an idempotency-keyed `tribe.send` after a
 * connection loss; the daemon must honor a client-minted key so the retry
 * collapses to the ORIGINAL row instead of appending a second one. The key IS
 * the message id (messages.id PRIMARY KEY is the idempotency ledger — longer
 * retention than the 1-day `dedup` table TTL, no schema change). A replay
 * returns the original {id, ts, rowid}, fires NO fan-out, and opens NO second
 * ball/pending row.
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

function countMessages(db: Database, recipient: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE recipient = ?").get(recipient) as { n: number }
  return row.n
}

describe("sendMessage idempotency key (20703 safe-reload)", () => {
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

  it("a retried send with the same idempotency key lands EXACTLY ONE row and returns the original id", () => {
    const inserted: MessageInsertedInfo[] = []
    const ctx = makeContext(db, stmts, "@sender", "sess-1", "member", (info) => inserted.push(info))

    const first = sendMessage(
      ctx,
      "@recipient",
      "hello",
      "notify",
      undefined,
      undefined,
      "direct",
      {},
      {},
      {},
      "key-abc",
    )
    const replay = sendMessage(
      ctx,
      "@recipient",
      "hello",
      "notify",
      undefined,
      undefined,
      "direct",
      {},
      {},
      {},
      "key-abc",
    )

    // Exactly one committed row; the replay returns the ORIGINAL identity.
    expect(countMessages(db, "@recipient")).toBe(1)
    expect(replay.id).toBe(first.id)
    expect(replay.ts).toBe(first.ts)
    expect(replay.rowid).toBe(first.rowid)
    // The message id IS the idempotency key (recoverable ledger).
    expect(first.id).toBe("key-abc")
    // Fan-out fired exactly once — the replay must not re-deliver.
    expect(inserted.length).toBe(1)
  })

  it("distinct idempotency keys land distinct rows", () => {
    const ctx = makeContext(db, stmts, "@sender", "sess-1", "member")
    const a = sendMessage(ctx, "@r", "one", "notify", undefined, undefined, "direct", {}, {}, {}, "k1")
    const b = sendMessage(ctx, "@r", "two", "notify", undefined, undefined, "direct", {}, {}, {}, "k2")
    expect(countMessages(db, "@r")).toBe(2)
    expect(a.id).not.toBe(b.id)
  })

  it("omitting the idempotency key preserves the legacy random-id behavior (no dedup)", () => {
    const ctx = makeContext(db, stmts, "@sender", "sess-1", "member")
    const a = sendMessage(ctx, "@r", "dup", "notify")
    const b = sendMessage(ctx, "@r", "dup", "notify")
    // Identical content with no key → two independent rows, random ids.
    expect(countMessages(db, "@r")).toBe(2)
    expect(a.id).not.toBe(b.id)
  })

  it("a replayed request-opening send does not open a second pending_request row", () => {
    const ctx = makeContext(db, stmts, "@sender", "sess-1", "member")
    const first = sendMessage(
      ctx,
      "@recipient",
      "please handle",
      "request",
      undefined,
      undefined,
      "direct",
      {},
      { request: "req-1" },
      {},
      "key-req",
    )
    const replay = sendMessage(
      ctx,
      "@recipient",
      "please handle",
      "request",
      undefined,
      undefined,
      "direct",
      {},
      { request: "req-1" },
      {},
      "key-req",
    )
    expect(replay.id).toBe(first.id)
    const pendingCount = (
      db.prepare("SELECT COUNT(*) AS n FROM pending_request WHERE request_id = ?").get("req-1") as { n: number }
    ).n
    expect(pendingCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Handler-level wiring: tribe.send → handleSend → sendMessage. The messaging
// tests above prove the ledger; these prove the tool surface honors the key,
// that a replay skips handleSend's OWN post-insert side-effects (the
// request:true pending-row fixup runs at the handler layer, outside
// sendMessage), and that the unsupported array-`to` shape fails loud.
// ---------------------------------------------------------------------------

function makeOpts(activeIds: readonly string[]): HandlerOpts {
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

function pendingCountFor(db: Database, requestId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM pending_request WHERE request_id = ?").get(requestId) as { n: number })
    .n
}

describe("handleSend idempotency key wiring (20703 safe-reload)", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements
  let sender: TribeContext
  let worker: TribeContext

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-send-idempotency-handler-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
    sender = makeContext(db, stmts, "@sender", "sess-h1", "member")
    worker = makeContext(db, stmts, "@worker", "sess-h2", "member")
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("a replayed keyed request send returns the original id and opens no second ball", () => {
    const args = { to: "@worker", message: "do it", type: "request", request: true, idempotencyKey: "key-h1" }
    const first = parseToolJson(handleToolCall(sender, "tribe.send", args, makeOpts(["sess-h1", "sess-h2"])))
    expect(first.sent).toBe(true)
    expect(first.id).toBe("key-h1")
    expect(first.replayed).toBeUndefined()
    expect(pendingCountFor(db, "key-h1")).toBe(1)

    const replay = parseToolJson(handleToolCall(sender, "tribe.send", args, makeOpts(["sess-h1", "sess-h2"])))
    expect(replay.sent).toBe(true)
    expect(replay.id).toBe("key-h1")
    expect(replay.replayed).toBe(true)
    expect(countMessages(db, "@worker")).toBe(1)
    expect(pendingCountFor(db, "key-h1")).toBe(1)
  })

  it("a replay arriving after the ball was answered does not re-open the pending row", () => {
    const args = { to: "@worker", message: "handle this", type: "request", request: true, idempotencyKey: "key-h2" }
    const first = parseToolJson(handleToolCall(sender, "tribe.send", args, makeOpts(["sess-h1", "sess-h2"])))
    expect(pendingCountFor(db, first.id as string)).toBe(1)

    const answered = parseToolJson(
      handleToolCall(
        worker,
        "tribe.send",
        { to: "@sender", message: "done", type: "response", reply: first.id },
        makeOpts(["sess-h1", "sess-h2"]),
      ),
    )
    expect(answered.sent).toBe(true)
    expect(pendingCountFor(db, first.id as string)).toBe(0)

    // The retry lands AFTER the reply (reconnect race): it must not resurrect
    // the already-released ball.
    const replay = parseToolJson(handleToolCall(sender, "tribe.send", args, makeOpts(["sess-h1", "sess-h2"])))
    expect(replay.replayed).toBe(true)
    expect(pendingCountFor(db, first.id as string)).toBe(0)
    expect(countMessages(db, "@worker")).toBe(1)
  })

  it("array `to` with an idempotency key is rejected loudly, inserting nothing", () => {
    const res = parseToolJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: ["@worker", "@other"], message: "fan", idempotencyKey: "key-h3" },
        makeOpts(["sess-h1"]),
      ),
    )
    expect(res.error).toMatch(/single recipient/)
    expect(countMessages(db, "@worker")).toBe(0)
    expect(countMessages(db, "@other")).toBe(0)
  })
})
