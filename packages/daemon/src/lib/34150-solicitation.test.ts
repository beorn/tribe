/**
 * #34150 — solicitation/claim contract for unknown-owner broadcasts.
 *
 * A tracked broadcast solicitation is actionable-unread until read and is
 * owed by nobody. The first atomic claim converts it to one ordinary
 * directed owed ball; decline never settles; unclaimed expiry lands on the
 * sender. Replays the Nov 13 cca70c96 case at 17 recipients.
 *
 * @testonly none: the lifecycle is exercised through the public tribe.send
 * and tribe.pending handlers; no test-only exports are added.
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

const PROJECT_ID = "ball-tracker-34150"
const RECIPIENTS = Array.from({ length: 17 }, (_, i) => `@seat/${i + 1}`)

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

function parseToolJson(result: ReturnType<typeof handleToolCall>): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Record<string, unknown>
}

describe("34150 solicitation/claim", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements
  let sender: TribeContext
  let seats: TribeContext[]
  let sessionIds: string[]
  let names: Map<string, string>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ball-tracker-34150-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
    names = new Map()
    sessionIds = []
    const mk = (name: string, sid: string, pid: number) => {
      const ctx = makeContext(db, stmts, name, sid)
      registerSession(ctx, PROJECT_ID, () => true, null, pid, "push", "/repo", null, "claude", null, null)
      db.prepare("UPDATE sessions SET identity_sid = ?, identity_gen = 1 WHERE id = ?").run(`sid-${sid}`, sid)
      names.set(sid, name)
      sessionIds.push(sid)
      return ctx
    }
    sender = mk("@chief", "sess-sender", 2001)
    seats = RECIPIENTS.map((name, i) => mk(name, `sess-${i + 1}`, 2100 + i))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function opts(): HandlerOpts {
    return {
      cleanup: () => undefined,
      userRenamed: false,
      setUserRenamed: () => undefined,
      getActiveSessionIds: () => new Set(sessionIds),
      hasActiveTransport: (id) => sessionIds.includes(id),
      isReconnectGraceProtected: () => false,
      getActiveSessionInfo: () =>
        sessionIds.map((id) => ({
          id,
          name: names.get(id) ?? id,
          pid: process.pid,
          cwd: "/repo",
          role: "member",
          claudeSessionId: null,
          registeredAt: Date.now(),
          launchId: null,
          launchParentPid: null,
          transportPids: [process.pid],
          pushTransportPids: [],
        })),
    }
  }

  function seat(i: number): TribeContext {
    return seats[i]!
  }

  function sendSolicitation(expiresInMs = 3_600_000): string {
    const opened = parseToolJson(
      handleToolCall(
        sender,
        "tribe.send",
        {
          to: RECIPIENTS,
          message: "Author only: who wrote the three scratch files? Reply only if it was you.",
          summary: "author discovery",
          type: "request",
          request: "author-discovery-34150",
          solicitation: true,
          expires_in_ms: expiresInMs,
        },
        opts(),
      ),
    )
    expect(opened.sent).toBe(true)
    const rows = db
      .prepare("SELECT COUNT(*) AS count FROM pending_request WHERE request_id = ?")
      .get("author-discovery-34150") as { count: number }
    expect(rows.count).toBe(17)
    return "author-discovery-34150"
  }

  function owedIds(ctx: TribeContext): string[] {
    const result = parseToolJson(handleToolCall(ctx, "tribe.pending", {}, opts()))
    const pending = (result.pending ?? result.balls ?? []) as Array<{ request_id: string }>
    return pending.map((row) => row.request_id)
  }

  /**
   * @failure A solicitation owed by every recipient blocks all non-owners at turn end (cca70c96).
   * @level l2
   * @consumer Tribe senders whose question only one unknown seat can answer.
   * @seam tribe.pending claim lifecycle over pending_request + solicitation_meta.
   */
  it("17-recipient solicitation owes nobody before a claim (cca70c96 replay)", () => {
    const id = sendSolicitation()
    for (const seat of seats) expect(owedIds(seat)).not.toContain(id)
    expect(owedIds(sender)).not.toContain(id)
  })

  /**
   * @failure Two claimants or none converts leaves ownership ambiguous.
   * @level l2
   * @consumer The claiming seat and the sender.
   * @seam tribe.pending claim lifecycle over pending_request + solicitation_meta.
   */
  it("first claim converts to exactly one directed owed ball; second claim refused", () => {
    const id = sendSolicitation()
    const claimed = parseToolJson(handleToolCall(seat(3), "tribe.pending", { claim: id }, opts()))
    expect(claimed.claimed).toBe(true)
    expect(owedIds(seat(3))).toContain(id)
    for (const [i, seat] of seats.entries()) if (i !== 3) expect(owedIds(seat)).not.toContain(id)

    const second = parseToolJson(handleToolCall(seat(4), "tribe.pending", { claim: id }, opts()))
    expect(second.claimed).toBe(false)
    expect(second.claimed_by).toBe(RECIPIENTS[3])
    expect(owedIds(seat(4))).not.toContain(id)
  })

  /**
   * @failure A retried claim opens a second ball for the same claimant.
   * @level l1
   * @consumer Claimants on a flaky transport.
   * @seam tribe.pending claim lifecycle over pending_request + solicitation_meta.
   */
  it("duplicate claim by the same claimant returns the previous result", () => {
    const id = sendSolicitation()
    parseToolJson(handleToolCall(seat(0), "tribe.pending", { claim: id }, opts()))
    const again = parseToolJson(handleToolCall(seat(0), "tribe.pending", { claim: id }, opts()))
    expect(again.claimed).toBe(true)
    expect(owedIds(seat(0)).filter((row) => row === id)).toHaveLength(1)
  })

  /**
   * @failure A not-mine reply settles the question for the real owner.
   * @level l1
   * @consumer Non-owner recipients.
   * @seam tribe.pending claim lifecycle over pending_request + solicitation_meta.
   */
  it("decline (status + ref) never settles and blocks no claim", () => {
    const id = sendSolicitation()
    const declined = parseToolJson(
      handleToolCall(
        seat(1),
        "tribe.send",
        { to: "@chief", message: "not mine", summary: "not mine", type: "status", ref: id },
        opts(),
      ),
    )
    expect(declined.sent).toBe(true)
    const claimed = parseToolJson(handleToolCall(seat(2), "tribe.pending", { claim: id }, opts()))
    expect(claimed.claimed).toBe(true)
    expect(owedIds(seat(2))).toContain(id)
  })

  /**
   * @failure A claimed solicitation needs a second, new settlement path.
   * @level l1
   * @consumer The claimant answering.
   * @seam tribe.pending claim lifecycle over pending_request + solicitation_meta.
   */
  it("claimant settles through the ordinary response rail", () => {
    const id = sendSolicitation()
    parseToolJson(handleToolCall(seat(5), "tribe.pending", { claim: id }, opts()))
    const settled = parseToolJson(
      handleToolCall(
        seat(5),
        "tribe.send",
        { to: "@chief", message: "mine — files written in my scratch", summary: "mine", type: "response", reply: id },
        opts(),
      ),
    )
    expect(settled.sent).toBe(true)
    expect(owedIds(seat(5))).not.toContain(id)
  })

  /**
   * @failure A dropped or rejected claim silently dies or re-wakes the rejected seat.
   * @level l2
   * @consumer Claimant, sender, and remaining recipients.
   * @seam tribe.pending claim lifecycle over pending_request + solicitation_meta.
   */
  it("claimant drop returns it open; sender reject excludes the rejected claimant", () => {
    const id = sendSolicitation()
    parseToolJson(handleToolCall(seat(0), "tribe.pending", { claim: id }, opts()))
    const dropped = parseToolJson(handleToolCall(seat(0), "tribe.pending", { unclaim: id }, opts()))
    expect(dropped).toMatchObject({ unclaimed: true, returned_to: "open" })
    expect(owedIds(seat(0))).not.toContain(id)

    parseToolJson(handleToolCall(seat(1), "tribe.pending", { claim: id }, opts()))
    const rejected = parseToolJson(handleToolCall(sender, "tribe.pending", { unclaim: id }, opts()))
    expect(rejected).toMatchObject({ unclaimed: true, returned_to: "open" })
    const reclaim = parseToolJson(handleToolCall(seat(1), "tribe.pending", { claim: id }, opts()))
    expect(reclaim.claimed).toBe(false)
    const other = parseToolJson(handleToolCall(seat(2), "tribe.pending", { claim: id }, opts()))
    expect(other.claimed).toBe(true)
  })

  /**
   * @failure Return-to-open after the deadline re-wakes seventeen seats for an expired question.
   * @level l2
   * @consumer The sender.
   * @seam tribe.pending claim lifecycle over pending_request + solicitation_meta.
   */
  it("unclaim after the deadline goes straight to one sender obligation", () => {
    const id = sendSolicitation(1)
    parseToolJson(handleToolCall(seat(6), "tribe.pending", { claim: id }, opts()))
    const released = parseToolJson(handleToolCall(seat(6), "tribe.pending", { unclaim: id }, opts()))
    expect(released).toMatchObject({ unclaimed: true, returned_to: "sender" })
    expect(owedIds(sender)).toContain(id)
    for (const seat of seats) expect(owedIds(seat)).not.toContain(id)
  })

  /**
   * @failure A withdrawn solicitation still claims or blocks recipients.
   * @level l1
   * @consumer The sender withdrawing.
   * @seam tribe.pending claim lifecycle over pending_request + solicitation_meta.
   */
  it("sender withdraw before a claim removes every recipient row", () => {
    const id = sendSolicitation()
    const withdrawn = parseToolJson(handleToolCall(sender, "tribe.pending", { close: id }, opts()))
    expect(withdrawn.closed).toBe(17)
    const rows = db.prepare("SELECT COUNT(*) AS count FROM pending_request WHERE request_id = ?").get(id) as {
      count: number
    }
    expect(rows.count).toBe(0)
    const claim = parseToolJson(handleToolCall(seat(0), "tribe.pending", { claim: id }, opts()))
    expect(claim.claimed).toBe(false)
  })

  /**
   * @failure An unanswered solicitation expires onto nobody, or onto every recipient.
   * @level l2
   * @consumer The sender.
   * @seam tribe.pending claim lifecycle over pending_request + solicitation_meta.
   */
  it("unclaimed expiry lands on the sender as one owed ball, never on recipients", () => {
    const id = sendSolicitation(1)
    // Any later write path runs the expiry conversion; the sender sending an
    // unrelated tracked message is the public trigger used here.
    parseToolJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: RECIPIENTS[0], message: "unrelated", summary: "unrelated", type: "request", request: true },
        opts(),
      ),
    )
    expect(owedIds(sender)).toContain(id)
    for (const seat of seats) expect(owedIds(seat)).not.toContain(id)
  })
})
