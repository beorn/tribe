/**
 * @km/tribe/20008 — pending-ball GC + explicit repair.
 *
 * A `pending_request` ball that never gets a reply (dead recipient, out-of-band
 * close, bead-closed handoff) used to stay "open" forever and pollute
 * `tribe.pending` (@km/tribe/19996 — chief saw ~124 stale balls). Two paths:
 *  - periodic auto-GC in `cleanupOldData` (ball never outlives its message's 7d
 *    retention);
 *  - the scoped `gcStalePendingForRecipient` engine behind the explicit
 *    scoped `tribe.pending` prune/close operations.
 * Neither deletes message history; each production path records a typed
 * non-reply settlement before removing the ball-tracker row.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { incidentKey } from "tribe-wire"

import { createTribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, readAttentionProjection, type ActiveSessionInfo, type HandlerOpts } from "./handlers.ts"
import { logEvent, sendMessage } from "./messaging.ts"
import { cleanupOldData, registerSession } from "./session.ts"

const DAY = 24 * 60 * 60 * 1000
const PROJECT_ID = "pending-ball-gc"
type ToolJson = Record<string, unknown>

function makeOpts(active: ActiveSessionInfo[] = []): HandlerOpts {
  return {
    cleanup: () => undefined,
    userRenamed: false,
    setUserRenamed: () => undefined,
    getActiveSessionIds: () => new Set(active.map((session) => session.id)),
    hasActiveTransport: (sessionId) => active.some((session) => session.id === sessionId),
    getActiveSessionInfo: () => active,
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

  function makeContext(db: ReturnType<typeof openDatabase>, stmts: TribeStatements, initialName = "@chief") {
    return createTribeContext({
      db,
      stmts,
      sessionId: `sess-${initialName.slice(1).replaceAll("/", "-")}`,
      sessionRole: "member",
      initialName,
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
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

  function settlementFacts(db: ReturnType<typeof openDatabase>): Array<Record<string, unknown>> {
    return (
      db
        .prepare("SELECT content FROM messages WHERE kind = 'event' AND type = 'event.ball.settled' ORDER BY ts, id")
        .all() as Array<{ content: string }>
    ).map((row) => JSON.parse(row.content) as Record<string, unknown>)
  }

  it("cleanupOldData records gc-expired evidence before removing a stale ball", () => {
    const { db, stmts } = setup()
    try {
      const now = Date.now()
      const ctx = createTribeContext({
        db,
        stmts,
        sessionId: "sess-agent-2",
        sessionRole: "member",
        initialName: "@agent/2",
        domains: [],
        claudeSessionId: null,
        claudeSessionName: null,
      })
      sendMessage(
        ctx,
        "@chief",
        "stale review body",
        "request",
        undefined,
        undefined,
        "direct",
        {
          summary: "stale review summary",
        },
        { request: "stale" },
      )
      sendMessage(
        ctx,
        "@chief",
        "fresh review body",
        "request",
        undefined,
        undefined,
        "direct",
        {
          summary: "fresh review summary",
        },
        { request: "fresh" },
      )
      db.prepare("UPDATE pending_request SET opened_at = ? WHERE request_id = 'stale'").run(now - 8 * DAY)
      db.prepare("UPDATE pending_request SET opened_at = ? WHERE request_id = 'fresh'").run(now - 1 * DAY)

      cleanupOldData(ctx)

      expect(openIds(stmts, "@chief")).toEqual(["fresh"])
      expect(settlementFacts(db)).toEqual([
        expect.objectContaining({
          request_id: "stale",
          recipient: "@chief",
          sender: "@agent/2",
          summary: "stale review summary",
          settlement: "gc-expired",
        }),
      ])
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
      cleanupOldData(makeContext(db, stmts))
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
      expect(settlementFacts(db)).toEqual([
        expect.objectContaining({
          request_id: "done",
          recipient: "@chief",
          settlement: "manual-close",
          settled_by: "@chief",
        }),
      ])
    } finally {
      db.close()
    }
  })

  it("refuses incident close before any batch row settles and names the emitter remedy", () => {
    const { db, stmts } = setup()
    try {
      const emitter = makeContext(db, stmts, "@fleet")
      const owner = makeContext(db, stmts)
      const incident = { emitter: "health-monitor", subject: "@dev/5", condition: "transport-wedged" }
      const incidentId = incidentKey(incident)
      sendMessage(
        emitter,
        "@chief",
        "transport remains wedged",
        "notify",
        undefined,
        undefined,
        "direct",
        {},
        {
          incident,
        },
      )
      const listed = parseToolJson(handleToolCall(owner, "tribe.pending", {}, makeOpts())) as {
        pending: Array<Record<string, unknown>>
      }
      expect(listed.pending).toEqual([
        expect.objectContaining({
          request_id: incidentId,
          request_kind: "incident",
          expires_at: null,
          status: "active",
        }),
      ])
      const listedAll = parseToolJson(handleToolCall(owner, "tribe.pending", { all: true }, makeOpts())) as {
        pending: Array<Record<string, unknown>>
      }
      expect(listedAll.pending).toEqual([
        expect.objectContaining({
          request_id: incidentId,
          request_kind: "incident",
          expires_at: null,
          status: "active",
        }),
      ])
      openBall(stmts, { id: "ordinary", recipient: "@chief", openedAt: Date.now(), sender: "@agent/2" })

      const batch = parseToolJson(
        handleToolCall(owner, "tribe.pending", { close: ["ordinary", incidentId] }, makeOpts()),
      )
      expect(String(batch.error)).toContain("only the incident emitter can clear it")
      expect(String(batch.error)).toContain("--incident-cleared")
      expect(String(batch.error)).toContain(incidentId)
      expect(openIds(stmts, "@chief")).toEqual([incidentId, "ordinary"])
      expect(settlementFacts(db)).toEqual([])

      const single = parseToolJson(handleToolCall(owner, "tribe.pending", { close: incidentId }, makeOpts()))
      expect(String(single.error)).toContain("only the incident emitter can clear it")
      expect(String(single.error)).toContain("--incident-cleared")
      expect(openIds(stmts, "@chief")).toEqual([incidentId, "ordinary"])
      expect(settlementFacts(db)).toEqual([])
    } finally {
      db.close()
    }
  })

  it("closes an ordinary request whose explicit id has the same three-part spelling as an incident key", () => {
    const { db, stmts } = setup()
    try {
      const owner = makeContext(db, stmts)
      const requestId = "bay-handoff-ready:v1:0123456789abcdef0123"
      openBall(stmts, { id: requestId, recipient: "@chief", openedAt: Date.now(), sender: "@yrd" })

      const closed = parseToolJson(handleToolCall(owner, "tribe.pending", { close: requestId }, makeOpts()))

      expect(closed).toMatchObject({ owner: "@chief", request_id: requestId, closed: 1 })
      expect(openIds(stmts, "@chief")).toEqual([])
    } finally {
      db.close()
    }
  })

  it("records sender-withdrawn when the sender closes another persona's ball", () => {
    const { db, stmts } = setup()
    try {
      const now = Date.now()
      openBall(stmts, { id: "withdraw", recipient: "@chief", openedAt: now, sender: "@agent/2" })
      const sender = createTribeContext({
        db,
        stmts,
        sessionId: "sess-agent-2",
        sessionRole: "member",
        initialName: "@agent/2",
        domains: [],
        claudeSessionId: null,
        claudeSessionName: null,
      })

      const result = parseToolJson(
        handleToolCall(sender, "tribe.pending", { owner: "@chief", close: "withdraw-msg" }, makeOpts()),
      )

      expect(result).toMatchObject({ owner: "@chief", request_id: "withdraw", closed: 1 })
      expect(settlementFacts(db)).toEqual([
        expect.objectContaining({
          request_id: "withdraw",
          recipient: "@chief",
          sender: "@agent/2",
          settlement: "sender-withdrawn",
          settled_by: "@agent/2",
        }),
      ])
    } finally {
      db.close()
    }
  })

  it("records gc-expired evidence for every scoped prune without touching another owner", () => {
    const { db, stmts } = setup()
    try {
      const now = Date.now()
      openBall(stmts, { id: "chief-stale", recipient: "@chief", openedAt: now - 3 * DAY, sender: "@agent/2" })
      openBall(stmts, { id: "chief-fresh", recipient: "@chief", openedAt: now, sender: "@agent/2" })
      openBall(stmts, { id: "other-stale", recipient: "@agent/3", openedAt: now - 3 * DAY, sender: "@agent/2" })
      const chief = createTribeContext({
        db,
        stmts,
        sessionId: "sess-chief",
        sessionRole: "member",
        initialName: "@chief",
        domains: [],
        claudeSessionId: null,
        claudeSessionName: null,
      })

      const result = parseToolJson(handleToolCall(chief, "tribe.pending", { prune: true, stale_ms: DAY }, makeOpts()))

      expect(result).toMatchObject({ owner: "@chief", pruned: 1 })
      expect(openIds(stmts, "@chief")).toEqual(["chief-fresh"])
      expect(openIds(stmts, "@agent/3")).toEqual(["other-stale"])
      expect(settlementFacts(db)).toEqual([
        expect.objectContaining({
          request_id: "chief-stale",
          recipient: "@chief",
          sender: "@agent/2",
          settlement: "gc-expired",
          settled_by: "@chief",
        }),
      ])
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

  it("keeps deadline-passed balls loud in close-miss warnings", () => {
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
      openBall(stmts, {
        id: "still-owned",
        recipient: "@chief",
        openedAt: now - 60_000,
        expiresAt: now + 60_000,
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

      expect(warning.match(/\(message/gu)).toHaveLength(2)
      expect(warning).toContain("still-owned")
      expect(warning).toContain("deadline-passed")
      expect(warning).toContain("declared deadline passed, still open")
    } finally {
      db.close()
    }
  })

  it("records expiry at the daemon boundary without releasing ownership", () => {
    const { db, stmts } = setup()
    try {
      const now = Date.now()
      openBall(stmts, {
        id: "expired-at-boundary",
        recipient: "@chief",
        openedAt: now - 60_000,
        expiresAt: now - 1,
        sender: "@agent/2",
      })
      openBall(stmts, {
        id: "still-owned-at-boundary",
        recipient: "@chief",
        openedAt: now - 60_000,
        expiresAt: now + 60_000,
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

      const result = parseToolJson(handleToolCall(ctx, "tribe.pending", {}, makeOpts()))

      expect(result.pending).toEqual([
        expect.objectContaining({ request_id: "expired-at-boundary", status: "expired" }),
        expect.objectContaining({ request_id: "still-owned-at-boundary", status: "active" }),
      ])
      expect(openIds(stmts, "@chief")).toEqual(["expired-at-boundary", "still-owned-at-boundary"])
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

      cleanupOldData(makeContext(db, stmts))

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

  it("projects PID-aware answer capability onto flat and grouped pending rows", () => {
    const { db, stmts } = setup()
    try {
      const ctx = makeContext(db, stmts)
      const live = makeContext(db, stmts, "@agent/live")
      const disconnected = makeContext(db, stmts, "@agent/disconnected")
      registerSession(live, PROJECT_ID, () => false, null, process.pid, "pull", "/repo", null, "codex")
      registerSession(disconnected, PROJECT_ID, () => false, null, 999_999_999, "pull", "/repo", null, "codex")
      // One shared timestamp for all three balls: the assertion below (line
      // ~599) requires the flat `all.pending` list — sorted by status, then
      // opened_at, then request_id — to equal the owner-grouped
      // `all.owners.flatMap(...)` list — sorted by owner name, then within
      // each owner by the same tiebreak. With one ball per owner and matching
      // status, that equality only holds when opened_at ties across all
      // three, which only the request_id tiebreak then resolves identically
      // in both orderings (both alphabetize to disconnected, live, unknown).
      // A fresh `Date.now()` per loop iteration made that tie a race: under
      // scheduler contention (e.g. other test files' real-daemon spawns
      // competing for CPU in a full-suite run) the three calls could land on
      // different milliseconds, breaking the tie and reordering the flat list
      // by real open time while the grouped list stayed alphabetical —
      // reproduced both by forcing a millisecond gap and, unforced, in an
      // isolated daemon-package run (@km/tribe/ci-red-pending-ball-gc).
      const openedAt = Date.now() - 1_000
      for (const [id, recipient] of [
        ["req-live", "@agent/live"],
        ["req-disconnected", "@agent/disconnected"],
        ["req-unknown", "@agent/unknown"],
      ] as const) {
        openBall(stmts, { id, recipient, openedAt })
      }
      const active: ActiveSessionInfo[] = [
        {
          id: live.sessionId,
          name: "@agent/live",
          pid: process.pid,
          cwd: "/repo",
          role: "member",
          claudeSessionId: null,
          registeredAt: Date.now(),
          launchId: null,
          launchParentPid: null,
          transportPids: [process.pid],
        },
      ]

      const all = parseToolJson(handleToolCall(ctx, "tribe.pending", { all: true }, makeOpts(active))) as {
        pending: Array<Record<string, unknown>>
        owners: Array<{ owner: string; pending: Array<Record<string, unknown>> }>
      }
      const byOwner = new Map(all.pending.map((row) => [row.recipient, row]))
      expect(byOwner.get("@agent/live")).toMatchObject({
        owner_transport_registered: true,
        owner_transport_state: "connected",
        owner_state: "live",
        owner_answer_capability: "observed",
        owner_transport_reason: "connected-pid-live-transport",
        owner_transport_observed_at: expect.any(String),
      })
      expect(byOwner.get("@agent/disconnected")).toMatchObject({
        owner_transport_registered: false,
        owner_transport_state: "disconnected",
        owner_state: "unknown",
        owner_answer_capability: "not-observed",
        owner_transport_reason: "owner-unknown-no-transport",
      })
      expect(byOwner.get("@agent/unknown")).toMatchObject({
        owner_transport_registered: false,
        owner_transport_state: "disconnected",
        owner_state: "unknown",
        owner_answer_capability: "not-observed",
        owner_transport_reason: "no-session-record",
      })
      expect(all.owners.flatMap((owner) => owner.pending)).toEqual(all.pending)
    } finally {
      db.close()
    }
  })

  it("keeps expired balls loud in live projections and retains an explicit durable outcome", () => {
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
        openedAt: now - 60 * 60_000,
        expiresAt: now + 9 * 60_000,
      })

      const pending = parseToolJson(handleToolCall(ctx, "tribe.pending", {}, makeOpts())) as {
        pending: Array<{ request_id: string; status: string }>
      }
      const expired = parseToolJson(handleToolCall(ctx, "tribe.pending", { expired: true }, makeOpts())) as {
        expired: boolean
        pending: Array<{ request_id: string; settlement: string; settled_at: string }>
      }
      const attention = readAttentionProjection(ctx, "@chief", now).attention
      const health = parseToolJson(handleToolCall(ctx, "tribe.health", {}, makeOpts())) as {
        pending_balls?: { count: number }
        cadence?: {
          open_balls: { count: number }
          role_actionable_response: { open: { count: number } }
        }
      }

      expect(pending.pending).toEqual([
        expect.objectContaining({ request_id: "expired-review", status: "expired" }),
        expect.objectContaining({ request_id: "active-review", status: "active" }),
      ])
      expect(expired.expired).toBe(true)
      expect(expired.pending).toEqual([
        expect.objectContaining({
          request_id: "expired-review",
          status: "expired",
          settlement: null,
          settled_at: null,
        }),
      ])

      const archiveCutoff = Date.now() + 1_000
      stmts.archiveExpiredMessages.run({ $cutoff: archiveCutoff, $archived_at: archiveCutoff })
      stmts.deleteExpiredMessages.run({ $cutoff: archiveCutoff })
      const archived = parseToolJson(
        handleToolCall(ctx, "tribe.pending", { all: true, expired: true }, makeOpts()),
      ) as {
        pending: Array<{ request_id: string; settlement: string }>
        owners: Array<{ owner: string; pending: Array<{ request_id: string; settlement: string }> }>
      }
      expect(archived.pending).toEqual([
        expect.objectContaining({ request_id: "expired-review", status: "expired", settlement: null }),
      ])
      expect(archived.owners).toEqual([
        expect.objectContaining({
          owner: "@chief",
          pending: [expect.objectContaining({ request_id: "expired-review", status: "expired", settlement: null })],
        }),
      ])
      expect(attention.pending_balls).toEqual([
        expect.objectContaining({ request_id: "expired-review", status: "expired" }),
        expect.objectContaining({ request_id: "active-review", status: "active" }),
      ])
      expect(health.pending_balls?.count).toBe(2)
      expect(health.cadence?.open_balls.count).toBe(2)
      expect(health.cadence?.role_actionable_response.open.count).toBe(2)
    } finally {
      db.close()
      if (savedSlaRole === undefined) delete process.env.TRIBE_SLA_ROLE
      else process.env.TRIBE_SLA_ROLE = savedSlaRole
    }
  })

  it("derives every non-reply settlement reason and excludes a later answer", () => {
    const { db, stmts } = setup()
    try {
      const sender = makeContext(db, stmts, "@agent/2")
      const chief = makeContext(db, stmts)
      const track = (requestId: string, summary: string) =>
        sendMessage(
          sender,
          "@chief",
          summary,
          "request",
          undefined,
          undefined,
          "direct",
          { summary },
          {
            request: requestId,
          },
        )

      track("manual", "manually closed review")
      handleToolCall(chief, "tribe.pending", { close: "manual" }, makeOpts())

      track("withdrawn", "withdrawn by sender")
      handleToolCall(sender, "tribe.pending", { owner: "@chief", close: "withdrawn" }, makeOpts())

      track("gc", "never answered before retention")
      db.prepare("UPDATE pending_request SET opened_at = ? WHERE request_id = 'gc'").run(Date.now() - 8 * DAY)
      cleanupOldData(sender)

      const incident = { emitter: "test-monitor", subject: "yrd-runner", condition: "absent" }
      sendMessage(sender, "@chief", "runner absent", "notify", undefined, undefined, "direct", {}, { incident })
      sendMessage(
        sender,
        "@chief",
        "runner recovered",
        "notify",
        undefined,
        undefined,
        "direct",
        {},
        {
          incident: { ...incident, active: false },
        },
      )

      track("late-answer", "answered after deadline")
      db.prepare("UPDATE pending_request SET expires_at = ? WHERE request_id = 'late-answer'").run(Date.now() - 1)
      handleToolCall(chief, "tribe.pending", { expired: true }, makeOpts())
      sendMessage(
        chief,
        "@agent/2",
        "late but valid",
        "response",
        undefined,
        undefined,
        "direct",
        {},
        {
          reply: "late-answer",
        },
      )

      const archiveCutoff = Date.now() + 1_000
      stmts.archiveExpiredMessages.run({ $cutoff: archiveCutoff, $archived_at: archiveCutoff })
      stmts.deleteExpiredMessages.run({ $cutoff: archiveCutoff })

      const outcomes = parseToolJson(
        handleToolCall(chief, "tribe.pending", { all: true, expired: true }, makeOpts()),
      ) as {
        pending: Array<{ request_id: string; settlement: string | null; status: string }>
      }

      expect(outcomes.pending).toHaveLength(4)
      expect(outcomes.pending).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ request_id: "manual", status: "unanswered", settlement: "manual-close" }),
          expect.objectContaining({
            request_id: "withdrawn",
            status: "unanswered",
            settlement: "sender-withdrawn",
          }),
          expect.objectContaining({ request_id: "gc", status: "unanswered", settlement: "gc-expired" }),
          expect.objectContaining({
            request_id: "test-monitor:yrd-runner:absent",
            status: "unanswered",
            settlement: "incident-cleared",
          }),
        ]),
      )
      expect(outcomes.pending).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ request_id: "late-answer" })]),
      )
    } finally {
      db.close()
    }
  })

  it("archives request and reply correlation so answered remains distinct from expired", () => {
    const { db, stmts } = setup()
    try {
      const chief = createTribeContext({
        db,
        stmts,
        sessionId: "sess-chief",
        sessionRole: "member",
        initialName: "@chief",
        domains: [],
        claudeSessionId: null,
        claudeSessionName: null,
      })
      const agent = createTribeContext({
        db,
        stmts,
        sessionId: "sess-agent",
        sessionRole: "member",
        initialName: "@agent/8",
        domains: [],
        claudeSessionId: null,
        claudeSessionName: null,
      })
      sendMessage(
        chief,
        "@agent/8",
        "answer before archival",
        "query",
        undefined,
        undefined,
        "direct",
        {},
        {
          request: "answered-before-archive",
        },
      )
      sendMessage(
        agent,
        "@chief",
        "answered",
        "response",
        undefined,
        undefined,
        "direct",
        {},
        {
          reply: "answered-before-archive",
        },
      )

      const archiveCutoff = Date.now() + 1_000
      stmts.archiveExpiredMessages.run({ $cutoff: archiveCutoff, $archived_at: archiveCutoff })
      stmts.deleteExpiredMessages.run({ $cutoff: archiveCutoff })

      expect(
        db.prepare("SELECT type, request, reply FROM messages_archive ORDER BY seq").all() as Array<{
          type: string
          request: string | null
          reply: string | null
        }>,
      ).toEqual([
        { type: "query", request: "answered-before-archive", reply: null },
        { type: "response", request: null, reply: "answered-before-archive" },
        { type: "event.ball.settled", request: null, reply: null },
      ])
    } finally {
      db.close()
    }
  })

  it("keeps journal identity and computes historical oldest age from openings, not settlement order", () => {
    const { db, stmts } = setup()
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
      const fact = {
        schema_version: 1,
        request_id: "same-payload-distinct-events",
        recipient: "@chief",
        sender: "@sender",
        opened_at: now - 60 * 60_000,
        expires_at: now - 30 * 60_000,
        message_id: "same-payload-message",
        fanout: "first",
        summary: null,
        settlement: "expired",
        settled_at: now - 1_000,
      }
      logEvent(ctx, "ball.expired", undefined, fact, { sender: "daemon", ref: fact.request_id, ts: now - 1_000 })
      logEvent(ctx, "ball.expired", undefined, fact, { sender: "daemon", ref: fact.request_id, ts: now - 1_000 })
      logEvent(
        ctx,
        "ball.expired",
        undefined,
        {
          ...fact,
          request_id: "older-opening-later-settlement",
          opened_at: now - 2 * 60 * 60_000,
          message_id: "older-opening-message",
          settled_at: now,
        },
        { sender: "daemon", ref: "older-opening-later-settlement", ts: now },
      )

      const expired = parseToolJson(handleToolCall(ctx, "tribe.pending", { all: true, expired: true }, makeOpts())) as {
        count: number
        pending: Array<{ request_id: string; status: string; settlement: string | null }>
        owners: Array<{ owner: string; oldest_age_ms: number }>
      }
      // Journal identity stays in the journal; the VIEW shows one obligation
      // per (request_id, recipient) with duplicate generations disclosed via
      // superseded_count (the expired-view-collapse contract) — while the
      // owner's oldest age still derives from the earliest OPENING.
      expect(expired.count).toBe(2)
      expect(expired.pending).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            request_id: "same-payload-distinct-events",
            status: "unanswered",
            settlement: null,
            superseded_count: 1,
          }),
        ]),
      )
      expect(expired.owners).toEqual([
        expect.objectContaining({ owner: "@chief", oldest_age_ms: expect.closeTo(2 * 60 * 60_000, -3) }),
      ])
    } finally {
      db.close()
    }
  })

  it("fails loud when an expiry journal fact cannot be replayed", () => {
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
      logEvent(ctx, "ball.expired", undefined, { request_id: "missing-evidence" }, { sender: "daemon" })

      expect(() => handleToolCall(ctx, "tribe.pending", { expired: true }, makeOpts())).toThrow(
        /invalid ball expiry fact.*missing-evidence/i,
      )
    } finally {
      db.close()
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
