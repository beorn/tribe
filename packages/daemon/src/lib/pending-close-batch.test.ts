/**
 * Draining a ball backlog cost one round trip per ball. With a standing rule
 * of at most five open balls and 200 parked, that is 200 spawn+connect+RPC
 * cycles against a rail where one send per 1.5s already saturates it — the
 * reason the rule is currently unsatisfiable.
 *
 * Measured first, because the brief's hypothesis was that each close pays a
 * full pending snapshot, making an n-ball drain O(n^2). It does not: a close
 * that HITS is flat at ~0.047ms whether 20 or 400 balls are open (both lookups
 * are keyed on the primary key), and a full drain is linear. What IS linear
 * per call is the MISS path, which reads the whole pile to build a warning
 * naming every open ball — 877 chars at 20 balls, 16,757 at 400. So the batch
 * close is worth having for round-trip collapse, not for handler complexity,
 * and the miss warning needs a bound of its own.
 *
 * Semantics under test: many ids in ONE call and ONE transaction, a result row
 * per id so nothing is silently skipped, and no all-or-nothing failure.
 */
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"

const OWNER = "@chief"

const opts = {
  getActiveSessionIds: () => new Set<string>(),
  getActiveSessionInfo: () => [],
  hasActiveTransport: () => false,
  isReconnectGraceProtected: () => false,
  userRenamed: false,
  setUserRenamed: () => {},
} as unknown as HandlerOpts

describe("closing a ball backlog in one call", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements
  let ctx: TribeContext

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pending-close-batch-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
    ctx = createTribeContext({
      db,
      stmts,
      sessionId: "closer",
      sessionRole: "member",
      initialName: OWNER,
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function openBall(requestId: string, recipient = OWNER): void {
    db.prepare(
      "INSERT INTO messages (id, type, sender, recipient, kind, content, ts, delivery, summary, request) " +
        "VALUES ($mid, 'request', '@fleet', $recipient, 'direct', 'q', 1000, 'push', 'sum', $rid)",
    ).run({ $mid: `msg-${requestId}`, $recipient: recipient, $rid: requestId })
    db.prepare(
      "INSERT INTO pending_request (request_id, recipient, sender, opened_at, expires_at, message_id, fanout) " +
        "VALUES ($rid, $recipient, '@fleet', 1000, NULL, $mid, 'first')",
    ).run({ $rid: requestId, $recipient: recipient, $mid: `msg-${requestId}` })
  }

  function callClose(close: unknown): Record<string, unknown> {
    const result = handleToolCall(ctx, "tribe.pending", { owner: OWNER, close }, opts)
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
    return JSON.parse(text) as Record<string, unknown>
  }

  const openCount = (): number => (db.prepare("SELECT count(*) AS c FROM pending_request").get() as { c: number }).c

  it("closes many balls in one call", () => {
    for (let i = 0; i < 25; i++) openBall(`req-${i}`)
    const ids = Array.from({ length: 25 }, (_, i) => `req-${i}`)

    const payload = callClose(ids)

    expect(payload.closed).toBe(25)
    expect(openCount()).toBe(0)
  })

  it("returns a result row per id so nothing is silently skipped", () => {
    openBall("req-a")
    openBall("req-b")

    const payload = callClose(["req-a", "req-missing", "req-b"])
    const results = payload.results as Array<{ request_id: string; closed: number }>

    // Three ids in, three rows out — a caller can always tell which of its ids
    // did what, which a bare total can never express.
    expect(results.map((row) => row.request_id)).toEqual(["req-a", "req-missing", "req-b"])
    expect(results.map((row) => row.closed)).toEqual([1, 0, 1])
    expect(payload.closed).toBe(2)
  })

  it("is not all-or-nothing: a bad id never rolls back the good ones", () => {
    openBall("req-a")
    openBall("req-b")

    callClose(["req-a", "req-missing", "req-b"])

    expect(openCount()).toBe(0)
  })

  it("names the misses rather than reporting a quiet partial success", () => {
    openBall("req-a")

    const payload = callClose(["req-a", "req-ghost"])
    const results = payload.results as Array<{ request_id: string; closed: number; reason?: string }>
    const miss = results.find((row) => row.request_id === "req-ghost")

    expect(miss?.closed).toBe(0)
    expect(typeof miss?.reason).toBe("string")
    expect(miss?.reason).toMatch(/no open ball|not found|closed 0/i)
  })

  it("refuses a batch that is empty or not a list of non-empty strings", () => {
    // A silently-ignored malformed batch would report "closed 0" and read as
    // "there was nothing to close".
    expect(String(callClose([]).error ?? "")).toMatch(/close/i)
    expect(String(callClose(["ok", ""]).error ?? "")).toMatch(/close/i)
    expect(String(callClose([1, 2]).error ?? "")).toMatch(/close/i)
  })

  it("does not close another owner's ball through a batch", () => {
    openBall("req-mine", OWNER)
    openBall("req-theirs", "@dev/1")

    const payload = callClose(["req-mine", "req-theirs"])
    const results = payload.results as Array<{ request_id: string; closed: number }>

    expect(results.find((row) => row.request_id === "req-theirs")?.closed).toBe(0)
    expect(
      (db.prepare("SELECT count(*) AS c FROM pending_request WHERE recipient = '@dev/1'").get() as { c: number }).c,
    ).toBe(1)
  })

  it("keeps the single-id response shape unchanged", () => {
    openBall("req-solo")
    const payload = callClose("req-solo")

    // Existing callers read `request_id` + `closed` off a string close; the
    // batch form is additive and must not have moved them.
    expect(payload.request_id).toBe("req-solo")
    expect(payload.closed).toBe(1)
    expect(payload.results).toBeUndefined()
  })

  it("bounds the miss warning instead of listing every open ball", () => {
    // Measured on main: the warning names every open ball, so it grew from 877
    // chars at 20 balls to 16,757 at 400 — an unbounded response body on the
    // path an operator hits most while draining a stale backlog.
    for (let i = 0; i < 400; i++) openBall(`req-${i}`)

    const payload = callClose("req-nope")
    const warning = String(payload.warning ?? "")

    expect(warning).not.toBe("")
    expect(warning.length).toBeLessThan(2_000)
    // Still says how many there were — bounding must not cost the count.
    expect(warning).toContain("400")
  })
})
