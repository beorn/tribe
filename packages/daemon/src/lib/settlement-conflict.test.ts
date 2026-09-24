/**
 * One ball with two settlement facts blinded the expired view for every seat
 * (@i/21-wire/25654) — pre-fix RED.
 *
 * The live record: yrd sent 6e93a03c to @dev/6 on 2026-09-10, the seat closed
 * it by hand (manual-close), and fourteen days later yrd's records replay
 * re-sent the SAME request and message id, which opened a fresh row the seat
 * answered (answered). Two facts, one [request_id, recipient, message_id]
 * key, and the fold threw — so `tribe pending --expired` exited 2 for
 * @dev/12, @dev/2 and every other owner who never held that ball.
 *
 * Contract pinned here: the conflicted ball is reported once, by id, with
 * every fact it carries in `settlement_conflict` (its `settlement` is the
 * latest); the answer names it in `warning`; every other ball still answers;
 * and only a close aimed at that ball carries the conflict in its own result.
 *
 * @failure  One ball whose journal contradicts itself makes `tribe pending
 *           --expired` exit 2 for EVERY owner, so each seat's expired-owed
 *           rail reads UNAVAILABLE instead of a list.
 * @level    l1 (handler over a scratch SQLite tracker, no daemon process)
 * @consumer /inbox's expired-owed rail, `tribe pending --close`, /retro
 * @testonly none
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext } from "./context.ts"
import { createStatements, openDatabase } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"
import { logEvent } from "./messaging.ts"

type ConflictEntry = { settlement: string; settled_at: string; settled_by: string }
type Row = {
  request_id: string
  recipient: string
  settlement?: string | null
  backing?: string
  settlement_conflict?: ConflictEntry[]
}
type ToolJson = {
  pending?: Row[]
  owners?: Array<{ owner: string; count: number }>
  count?: number
  warning?: string
  closed?: number
  request_id?: string
  settlement_conflict?: ConflictEntry[]
  error?: string
}

function makeOpts(): HandlerOpts {
  return {
    cleanup: () => undefined,
    userRenamed: false,
    setUserRenamed: () => undefined,
    getActiveSessionIds: () => new Set(["sess-chief"]),
    hasActiveTransport: (sessionId) => sessionId === "sess-chief",
    getActiveSessionInfo: () => [],
  }
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): ToolJson {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as ToolJson
}

describe("25654 one ball with two settlement facts", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "settlement-conflict-"))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function setup() {
    const db = openDatabase(join(tmpDir, "tribe.db"))
    const stmts = createStatements(db)
    const ctx = createTribeContext({
      db,
      stmts,
      sessionId: "sess-chief",
      sessionRole: "member",
      initialName: "@chief",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    return { db, stmts, ctx }
  }

  type Ctx = ReturnType<typeof createTribeContext>

  function openExpired(stmts: ReturnType<typeof createStatements>, req: string, recipient: string, now: number) {
    stmts.openPendingRequest.run({
      $request_id: req,
      $recipient: recipient,
      $sender: "@yrd",
      $opened_at: now - 3_600_000,
      $expires_at: now - 60_000,
      $message_id: `${req}-m1`,
      $fanout: "first",
    })
  }

  /** The exact fact shape settlePendingRows journals — written directly for
   * the generation the tracker no longer holds a row for. */
  function journalSettlement(
    ctx: Ctx,
    req: string,
    recipient: string,
    settlement: "answered" | "manual-close",
    settledAt: number,
    openedAt: number,
  ) {
    logEvent(
      ctx,
      "ball.settled",
      undefined,
      {
        schema_version: 1,
        request_id: req,
        recipient,
        sender: "@yrd",
        opened_at: openedAt,
        expires_at: openedAt + 1_200_000,
        message_id: `${req}-m1`,
        fanout: "first",
        summary: `yrd merged ${req}`,
        settlement,
        settled_at: settledAt,
        settled_by: recipient,
      },
      { sender: "daemon", ref: req, ts: settledAt },
    )
  }

  /** The live shape: closed by hand, then the same id replayed and answered. */
  function closedThenAnswered(ctx: Ctx, stmts: ReturnType<typeof createStatements>, now: number) {
    openExpired(stmts, "twice-req", "@chief", now)
    handleToolCall(ctx, "tribe.pending", { close: "twice-req" }, makeOpts())
    journalSettlement(ctx, "twice-req", "@chief", "answered", now + 1_000, now - 3_600_000)
  }

  it("reports the conflicted ball once with both facts and still answers for every other ball", () => {
    const { ctx, stmts } = setup()
    const now = Date.now()
    openExpired(stmts, "live-req", "@chief", now)
    openExpired(stmts, "other-owner-req", "@dev/2", now)
    closedThenAnswered(ctx, stmts, now)

    const view = parseToolJson(handleToolCall(ctx, "tribe.pending", { owner: "@chief", expired: true }, makeOpts()))
    expect(view.error).toBeUndefined()
    const byId = new Map((view.pending ?? []).map((row) => [row.request_id, row]))
    expect([...byId.keys()].toSorted()).toEqual(["live-req", "twice-req"])
    expect(byId.get("live-req")!.backing).toBe("live")
    expect(byId.get("live-req")!.settlement_conflict).toBeUndefined()
    const twice = byId.get("twice-req")!
    expect(twice.backing).toBe("journal")
    expect(twice.settlement).toBe("answered")
    expect(twice.settlement_conflict?.map((entry) => entry.settlement)).toEqual(["manual-close", "answered"])
    expect(twice.settlement_conflict?.map((entry) => entry.settled_by)).toEqual(["@chief", "@chief"])
    expect(view.warning).toMatch(/twice-req/)
    expect(view.warning).toMatch(/manual-close/)
    expect(view.warning).toMatch(/answered/)

    // The owner who never held the ball reads a clean answer, no warning.
    const other = parseToolJson(handleToolCall(ctx, "tribe.pending", { owner: "@dev/2", expired: true }, makeOpts()))
    expect(other.error).toBeUndefined()
    expect((other.pending ?? []).map((row) => row.request_id)).toEqual(["other-owner-req"])
    expect(other.warning).toBeUndefined()

    // The fleet-wide view answers with every owner and names the conflict.
    const all = parseToolJson(handleToolCall(ctx, "tribe.pending", { all: true, expired: true }, makeOpts()))
    expect(all.error).toBeUndefined()
    expect(all.count).toBe(3)
    expect((all.owners ?? []).map((group) => group.owner)).toEqual(["@chief", "@dev/2"])
    expect(all.warning).toMatch(/twice-req/)

    // owed keeps only live-backed rows; a settled ball, conflicted or not, is history.
    const owed = parseToolJson(
      handleToolCall(ctx, "tribe.pending", { owner: "@chief", expired: true, owed: true }, makeOpts()),
    )
    expect(owed.error).toBeUndefined()
    expect((owed.pending ?? []).map((row) => row.request_id)).toEqual(["live-req"])
    expect(owed.warning).toBeUndefined()
  })

  it("folds the bead's order too: answered, then closed by hand", () => {
    const { ctx } = setup()
    const now = Date.now()
    journalSettlement(ctx, "late-close-req", "@chief", "answered", now - 2_000, now - 3_600_000)
    journalSettlement(ctx, "late-close-req", "@chief", "manual-close", now - 1_000, now - 3_600_000)

    const view = parseToolJson(handleToolCall(ctx, "tribe.pending", { owner: "@chief", expired: true }, makeOpts()))
    expect(view.error).toBeUndefined()
    expect(view.pending).toHaveLength(1)
    const row = view.pending![0]!
    expect(row.request_id).toBe("late-close-req")
    expect(row.settlement).toBe("manual-close")
    expect(row.settlement_conflict?.map((entry) => entry.settlement)).toEqual(["answered", "manual-close"])
    expect(row.settlement_conflict?.map((entry) => entry.settled_at)).toEqual([
      new Date(now - 2_000).toISOString(),
      new Date(now - 1_000).toISOString(),
    ])
  })

  it("a close aimed at the conflicted ball closes nothing and carries both facts", () => {
    const { ctx, stmts } = setup()
    const now = Date.now()
    openExpired(stmts, "live-req", "@chief", now)
    closedThenAnswered(ctx, stmts, now)

    const close = parseToolJson(handleToolCall(ctx, "tribe.pending", { close: "twice-req" }, makeOpts()))
    expect(close.error).toBeUndefined()
    expect(close.closed).toBe(0)
    expect(close.settlement_conflict?.map((entry) => entry.settlement)).toEqual(["manual-close", "answered"])
    expect(close.warning).toMatch(/2 settlement facts that disagree/)
    expect(close.warning).toMatch(/manual-close/)
    expect(close.warning).toMatch(/answered/)

    // A close aimed at any other ball carries no conflict.
    const clean = parseToolJson(handleToolCall(ctx, "tribe.pending", { close: "live-req" }, makeOpts()))
    expect(clean.closed).toBe(1)
    expect(clean.settlement_conflict).toBeUndefined()
  })
})
