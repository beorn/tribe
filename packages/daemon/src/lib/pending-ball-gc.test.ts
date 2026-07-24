/**
 * @km/tribe/20008 — pending-ball GC + explicit repair.
 *
 * A `pending_request` ball that never gets a reply (dead recipient, out-of-band
 * close, bead-closed handoff) used to stay "open" forever and pollute
 * `tribe.pending` (@km/tribe/19996 — chief saw ~124 stale balls). Two paths:
 *  - periodic auto-GC in `cleanupOldData` (ball never outlives its message's 7d
 *    retention);
 *  - the scoped `gcStalePendingForRecipient` engine behind the explicit
 *    `tribe.pending` prune/close (safe chief-recovery repair — scoped).
 * Neither deletes message history; only ball-tracker rows are removed.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, readAttentionProjection, type HandlerOpts } from "./handlers.ts"
import { sendMessage } from "./messaging.ts"
import { cleanupOldData } from "./session.ts"

const DAY = 24 * 60 * 60 * 1000
type ToolJson = Record<string, unknown>

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

describe("pending-ball GC (@km/tribe/20008)", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pending-gc-"))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function setup() {
    const db = openDatabase(join(tmpDir, "tribe.db"))
    const stmts = createStatements(db)
    return { db, stmts }
  }

  function openBall(
    stmts: TribeStatements,
    o: { id: string; recipient: string; openedAt: number; expiresAt?: number | null; sender?: string },
  ): void {
    stmts.openPendingRequest.run({
      $request_id: o.id,
      $recipient: o.recipient,
      $sender: o.sender ?? "@chief",
      $opened_at: o.openedAt,
      $expires_at: o.expiresAt ?? null,
      $message_id: `${o.id}-msg`,
      $fanout: "first",
    })
  }

  function openIds(stmts: TribeStatements, recipient: string): string[] {
    return (stmts.selectPendingForRecipient.all({ $recipient: recipient }) as Array<{ request_id: string }>).map(
      (r) => r.request_id,
    )
  }

  it("cleanupOldData GCs balls older than the 7d retention, keeps fresh ones", () => {
    const { db, stmts } = setup()
    try {
      const now = Date.now()
      openBall(stmts, { id: "stale", recipient: "@chief", openedAt: now - 8 * DAY }) // > 7d → GC
      openBall(stmts, { id: "fresh", recipient: "@chief", openedAt: now - 1 * DAY }) // < 7d → keep

      cleanupOldData({ stmts } as unknown as Parameters<typeof cleanupOldData>[0])

      expect(openIds(stmts, "@chief")).toEqual(["fresh"])
    } finally {
      db.close()
    }
  })

  it("scoped prune deletes only the owner's balls older than the cutoff", () => {
    const { db, stmts } = setup()
    try {
      const now = Date.now()
      openBall(stmts, { id: "chief-stale", recipient: "@chief", openedAt: now - 3 * DAY })
      openBall(stmts, { id: "chief-fresh", recipient: "@chief", openedAt: now - 30 * 60 * 1000 }) // 30m
      openBall(stmts, { id: "other-stale", recipient: "@agent/2", openedAt: now - 3 * DAY })

      const res = stmts.gcStalePendingForRecipient.run({ $recipient: "@chief", $cutoff: now - 1 * DAY })

      expect(res.changes).toBe(1) // only chief-stale
      expect(openIds(stmts, "@chief")).toEqual(["chief-fresh"]) // fresh preserved
      expect(openIds(stmts, "@agent/2")).toEqual(["other-stale"]) // other recipient untouched (scoped)
    } finally {
      db.close()
    }
  })

  it("a fresh request/reply ball is never GC'd and still closes on reply", () => {
    const { db, stmts } = setup()
    try {
      const now = Date.now()
      openBall(stmts, { id: "live", recipient: "@chief", openedAt: now - 5 * 60 * 1000 }) // 5m old

      // Auto-GC + a scoped prune with a 1d threshold both leave it open.
      cleanupOldData({ stmts } as unknown as Parameters<typeof cleanupOldData>[0])
      stmts.gcStalePendingForRecipient.run({ $recipient: "@chief", $cutoff: now - 1 * DAY })
      expect(openIds(stmts, "@chief")).toEqual(["live"])

      // The normal reply path still closes it.
      stmts.closePendingRequest.run({ $request_id: "live", $recipient: "@chief" })
      expect(openIds(stmts, "@chief")).toEqual([])
    } finally {
      db.close()
    }
  })

  it("explicit close deletes exactly one owner's pending ball", () => {
    const { db, stmts } = setup()
    try {
      const now = Date.now()
      openBall(stmts, { id: "done", recipient: "@chief", openedAt: now })
      openBall(stmts, { id: "keep", recipient: "@chief", openedAt: now })
      openBall(stmts, { id: "done", recipient: "@agent/2", openedAt: now })
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

      const res = parseToolJson(handleToolCall(ctx, "tribe.pending", { close: "done-msg" }, makeOpts()))

      expect(res).toMatchObject({ owner: "@chief", request_id: "done", closed: 1 })
      expect(openIds(stmts, "@chief")).toEqual(["keep"])
      expect(openIds(stmts, "@agent/2")).toEqual(["done"])
    } finally {
      db.close()
    }
  })

  it("explicit close miss warns with every open ball owned by the target", () => {
    const { db, stmts } = setup()
    try {
      const now = Date.now()
      openBall(stmts, { id: "still-open", recipient: "@chief", openedAt: now, sender: "@agent/2" })
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

      const res = parseToolJson(handleToolCall(ctx, "tribe.pending", { close: "missing" }, makeOpts()))

      expect(res).toMatchObject({ owner: "@chief", request_id: "missing", closed: 0 })
      expect(res.warning).toContain("closed 0")
      expect(res.warning).toContain("still-open")
      expect(res.warning).toContain("still-open-msg")
      expect(openIds(stmts, "@chief")).toEqual(["still-open"])
    } finally {
      db.close()
    }
  })

  it("a deadline-passed ball appears once in a close-miss warning", () => {
    const { db, stmts } = setup()
    try {
      const now = Date.now()
      openBall(stmts, {
        id: "deadline-passed",
        recipient: "@chief",
        openedAt: now - 60_000,
        expiresAt: now - 1,
        sender: "@agent/2",
      })
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

      const res = parseToolJson(handleToolCall(ctx, "tribe.pending", { close: "missing" }, makeOpts()))
      const warning = String(res.warning)

      expect(warning.match(/\(message/gu)).toHaveLength(1)
      expect(warning).toContain("declared deadline passed, still open")
    } finally {
      db.close()
    }
  })

  it("legacy deadline-stage dedup claims age out even while their source ball is open", () => {
    const { db, stmts } = setup()
    try {
      const now = Date.now()
      openBall(stmts, { id: "still-open", recipient: "@chief", openedAt: now })
      stmts.claimDedup.run({
        $key: "ball-deadline:still-open:expired",
        $session_id: "still-open-msg",
        $ts: now - 2 * DAY,
      })

      cleanupOldData({ stmts } as unknown as Parameters<typeof cleanupOldData>[0])

      const row = db.prepare("SELECT COUNT(*) AS count FROM dedup WHERE key LIKE 'ball-deadline:%'").get() as {
        count: number
      }
      expect(row.count).toBe(0)
      expect(openIds(stmts, "@chief")).toEqual(["still-open"])
    } finally {
      db.close()
    }
  })

  it("all-owner projection catches obligations that an empty caller sample misses", () => {
    const { db, stmts } = setup()
    try {
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
      const first = sendMessage(
        ctx,
        "@agent/2",
        "Review the immutable carrier before execute resumes",
        "notify",
        undefined,
        undefined,
        "direct",
        { summary: "review immutable carrier" },
        { request: "req-agent-2" },
      )
      const second = sendMessage(
        ctx,
        "@ci",
        "Run the focused acceptance gate",
        "notify",
        undefined,
        undefined,
        "direct",
        { summary: "focused acceptance gate" },
        { request: "req-ci" },
      )
      db.prepare("UPDATE pending_request SET opened_at = $opened_at WHERE request_id = $request_id").run({
        $opened_at: Date.now() - 3 * 60 * 60 * 1000,
        $request_id: "req-ci",
      })

      const caller = parseToolJson(handleToolCall(ctx, "tribe.pending", {}, makeOpts()))
      const all = parseToolJson(handleToolCall(ctx, "tribe.pending", { all: true }, makeOpts())) as {
        all?: boolean
        count?: number
        owner_count?: number
        oldest_age_ms?: number
        owners?: Array<{
          owner: string
          count: number
          oldest_age_ms: number
          pending: Array<{
            request_id: string
            recipient: string
            sender: string
            message_id: string
            summary: string | null
          }>
        }>
      }

      expect(caller).toMatchObject({ owner: "@chief", pending: [], count: 0 })
      expect(all.all).toBe(true)
      expect(all.count).toBe(2)
      expect(all.owner_count).toBe(2)
      expect(all.oldest_age_ms).toBeGreaterThanOrEqual(3 * 60 * 60 * 1000)
      expect(all.owners).toEqual([
        {
          owner: "@agent/2",
          count: 1,
          oldest_age_ms: expect.any(Number),
          pending: [
            expect.objectContaining({
              request_id: "req-agent-2",
              recipient: "@agent/2",
              sender: "@chief",
              message_id: first.id,
              summary: "review immutable carrier",
            }),
          ],
        },
        {
          owner: "@ci",
          count: 1,
          oldest_age_ms: expect.any(Number),
          pending: [
            expect.objectContaining({
              request_id: "req-ci",
              recipient: "@ci",
              sender: "@chief",
              message_id: second.id,
              summary: "focused acceptance gate",
            }),
          ],
        },
      ])
    } finally {
      db.close()
    }
  })

  it("keeps deadline-passed balls open across pending, attention, and health while exposing the filtered view", () => {
    const { db, stmts } = setup()
    // The actionable-response SLA projection is opt-in via TRIBE_SLA_ROLE; name
    // @chief so tribe.health() surfaces the @chief open-ball count below.
    const savedSlaRole = process.env.TRIBE_SLA_ROLE
    process.env.TRIBE_SLA_ROLE = "@chief"
    try {
      const now = Date.now()
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
      openBall(stmts, {
        id: "expired-review",
        recipient: "@chief",
        openedAt: now - 11 * 60_000,
        expiresAt: now - 1,
      })
      openBall(stmts, {
        id: "active-review",
        recipient: "@chief",
        openedAt: now - 60_000,
        expiresAt: now + 9 * 60_000,
      })

      const pending = parseToolJson(handleToolCall(ctx, "tribe.pending", {}, makeOpts())) as {
        pending: Array<{ request_id: string }>
      }
      const expired = parseToolJson(handleToolCall(ctx, "tribe.pending", { expired: true }, makeOpts())) as {
        expired: boolean
        pending: Array<{ request_id: string }>
      }
      const attention = readAttentionProjection(ctx, "@chief", now).attention
      const health = parseToolJson(handleToolCall(ctx, "tribe.health", {}, makeOpts())) as {
        pending_balls?: { count: number }
        cadence?: {
          open_balls: { count: number }
          role_actionable_response: { open: { count: number } }
        }
      }

      expect(pending.pending.map((ball) => ball.request_id)).toEqual(["expired-review", "active-review"])
      expect(expired.expired).toBe(true)
      expect(expired.pending.map((ball) => ball.request_id)).toEqual(["expired-review"])
      expect(attention.pending_balls.map((ball) => ball.request_id)).toEqual(["expired-review", "active-review"])
      expect(health.pending_balls?.count).toBe(2)
      expect(health.cadence?.open_balls.count).toBe(2)
      expect(health.cadence?.role_actionable_response.open.count).toBe(2)
    } finally {
      db.close()
      if (savedSlaRole === undefined) delete process.env.TRIBE_SLA_ROLE
      else process.env.TRIBE_SLA_ROLE = savedSlaRole
    }
  })

  it("tribe.health reports bounded owner and stale aggregates instead of the full ball pile", () => {
    const { db, stmts } = setup()
    try {
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
      openBall(stmts, {
        id: "stale-agent-8",
        recipient: "@agent/8",
        openedAt: Date.now() - 2 * 60 * 60 * 1000 - 1,
      })
      openBall(stmts, { id: "fresh-ci", recipient: "@ci", openedAt: Date.now() - 60_000 })
      for (let index = 0; index < 200; index += 1) {
        openBall(stmts, {
          id: `bulk-${String(index).padStart(3, "0")}`,
          recipient: "@agent/8",
          openedAt: Date.now() - 60_000,
        })
      }

      const health = parseToolJson(handleToolCall(ctx, "tribe.health", {}, makeOpts())) as {
        issues?: string[]
        pending_balls?: {
          count: number
          owner_count: number
          owners: Array<{ owner: string; count: number; oldest_age_ms: number; pending?: unknown }>
          stale: { count: number; owner_count: number; oldest_age_ms: number }
        }
      }

      expect(health.pending_balls).toMatchObject({
        count: 202,
        owner_count: 2,
        stale: { count: 1, owner_count: 1, oldest_age_ms: expect.any(Number) },
      })
      expect(health.pending_balls?.owners).toEqual([
        { owner: "@agent/8", count: 201, oldest_age_ms: expect.any(Number) },
        { owner: "@ci", count: 1, oldest_age_ms: expect.any(Number) },
      ])
      expect(health.pending_balls?.owners.every((owner) => owner.pending === undefined)).toBe(true)
      expect(health.issues).toEqual([expect.stringMatching(/1 stale pending ball.*1 owner/i)])
      expect(JSON.stringify(health.pending_balls).length).toBeLessThan(2_048)
    } finally {
      db.close()
    }
  })
})
