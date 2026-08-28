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

  function openBall(requestId: string, recipient = OWNER, sender = "@fleet"): void {
    db.prepare(
      "INSERT INTO messages (id, type, sender, recipient, kind, content, ts, delivery, summary, request) " +
        "VALUES ($mid, 'request', $sender, $recipient, 'direct', 'q', 1000, 'push', 'sum', $rid)",
    ).run({ $mid: `msg-${requestId}`, $sender: sender, $recipient: recipient, $rid: requestId })
    db.prepare(
      "INSERT INTO pending_request (request_id, recipient, sender, opened_at, expires_at, message_id, fanout) " +
        "VALUES ($rid, $recipient, $sender, 1000, NULL, $mid, 'first')",
    ).run({ $rid: requestId, $recipient: recipient, $sender: sender, $mid: `msg-${requestId}` })
  }

  function caller(name: string): TribeContext {
    return createTribeContext({
      db,
      stmts,
      sessionId: `caller-${name}`,
      sessionRole: "member",
      initialName: name,
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
  }

  function callCloseAs(context: TribeContext, close: unknown): Record<string, unknown> {
    const result = handleToolCall(context, "tribe.pending", { owner: OWNER, close }, opts)
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
    return JSON.parse(text) as Record<string, unknown>
  }

  function callClose(close: unknown): Record<string, unknown> {
    return callCloseAs(ctx, close)
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

  it("refuses the whole batch before mutation when one existing row is outside sender authority", () => {
    openBall("req-sender-can-withdraw", OWNER, "@fleet")
    openBall("req-third-persona-cannot-close", OWNER, "@agent/7")

    const payload = callCloseAs(caller("@fleet"), ["req-sender-can-withdraw", "req-third-persona-cannot-close"])

    expect(payload).toMatchObject({
      refusal: {
        kind: "pending-close-caller-unauthorized",
        caller: "@fleet",
        owner: OWNER,
        request_id: "req-third-persona-cannot-close",
        original_sender: "@agent/7",
        batch_size: 2,
      },
      refusal_event_id: expect.any(String),
    })
    expect(String(payload.error)).toContain("the entire 2-id close batch remains open")
    expect(openCount()).toBe(2)
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM messages WHERE type = 'event.ball.settled'").get() as { c: number }).c,
    ).toBe(0)
    const event = db
      .prepare("SELECT id, kind, content FROM messages WHERE type = 'event.ball.close-refused'")
      .get() as { id: string; kind: string; content: string }
    expect(event.id).toBe(payload.refusal_event_id)
    expect(event.kind).toBe("event")
    expect(JSON.parse(event.content)).toMatchObject({
      reason: "caller-not-owner-or-original-sender",
      caller: "@fleet",
      owner: OWNER,
      request_id: "req-third-persona-cannot-close",
      pending_mutation: "none",
    })
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

  /**
   * The batch reused the SINGLE-id miss template, whose text hardcodes
   * "closed 0 rows", and passed a count string ("1 of 4") where the template
   * expects a request id. A drain that WORKED therefore announced its own
   * failure: closing 4 ids against a pile of 3 emptied the pile and emitted
   * "reply/close 1 of 4 closed 0 rows; @chief owns no open balls". Loud, on
   * the primary path, and triggered precisely BECAUSE the close succeeded —
   * the inverse of a silent error and just as damaging to trust.
   */
  describe("batch warning tells the truth about a partial drain", () => {
    it("reports what actually closed instead of 'closed 0 rows'", () => {
      openBall("req-a")
      openBall("req-b")
      openBall("req-c")

      const payload = callClose(["req-a", "req-b", "req-c", "req-stale"])
      const warning = String(payload.warning ?? "")

      expect(payload.closed).toBe(3)
      expect(openCount()).toBe(0)
      // The drain worked. The warning must say so.
      expect(warning).not.toMatch(/closed 0 rows/)
      expect(warning).toMatch(/3/)
      expect(warning).toMatch(/4/)
    })

    it("does not claim the owner holds no balls when it just emptied the pile", () => {
      openBall("req-a")

      const payload = callClose(["req-a", "req-stale"])
      const warning = String(payload.warning ?? "")

      // "owns no open balls" was literally true after the drain and utterly
      // misleading as an explanation for why an id missed.
      expect(payload.closed).toBe(1)
      expect(warning).not.toMatch(/owns no open balls/)
      expect(warning).toMatch(/req-stale/)
    })

    it("handles a duplicate id honestly rather than as a failed drain", () => {
      openBall("req-x")

      const payload = callClose(["req-x", "req-x"])
      const results = payload.results as Array<{ request_id: string; closed: number }>

      expect(payload.closed).toBe(1)
      expect(results.map((row) => row.closed)).toEqual([1, 0])
      expect(String(payload.warning ?? "")).not.toMatch(/closed 0 rows/)
      expect(openCount()).toBe(0)
    })

    it("stays silent when every id in the batch closed", () => {
      openBall("req-a")
      openBall("req-b")

      const payload = callClose(["req-a", "req-b"])

      expect(payload.closed).toBe(2)
      expect(payload.warning).toBeUndefined()
    })
  })

  describe("batch size is capped", () => {
    it("refuses an oversized batch loudly, naming the cap and the submitted count", () => {
      // One call holds ONE write transaction across every id, on a branch whose
      // whole subject is event-loop starvation. An unbounded list is a wedge
      // waiting to be submitted.
      const ids = Array.from({ length: 101 }, (_, i) => `req-${i}`)
      const payload = callClose(ids)
      const error = String(payload.error ?? "")

      expect(error).toMatch(/100/)
      expect(error).toMatch(/101/)
      expect(openCount()).toBe(0)
    })

    it("accepts a batch exactly at the cap", () => {
      for (let i = 0; i < 100; i++) openBall(`req-${i}`)
      const ids = Array.from({ length: 100 }, (_, i) => `req-${i}`)

      expect(callClose(ids).closed).toBe(100)
      expect(openCount()).toBe(0)
    })
  })

  it("refuses an empty single-form close instead of printing a listing", () => {
    // "" fell through the batch branch (not an array) AND the single branch
    // (length 0), landing on the plain pending listing — a close that closed
    // nothing and never said so.
    openBall("req-a")
    const payload = callClose("")

    expect(String(payload.error ?? "")).toMatch(/close/i)
    expect(openCount()).toBe(1)
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
