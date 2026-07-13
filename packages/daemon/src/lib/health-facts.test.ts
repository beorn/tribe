/**
 * @km/bearly/17018-tribe-daemon-production-hardening — observability slice.
 *
 * The daemon was fast but had ZERO latency/lifecycle/pressure facts, so a
 * 60-70s pane observation could not be attributed (see the 2026-07-13 20703
 * recurrence review). These tests pin the new `tribe.health` facts + the
 * degraded contract added at the single `handleToolCall` chokepoint:
 *
 *   1. Tool-latency rolling window → `tool_latency` per-tool {n,p50,p95,max}.
 *   2. Registry/identity gauges → clients_total, members_total,
 *      pending_placeholder_conns, personas_multi_launch.
 *   3. DB-pressure gauges → db_bytes, wal_bytes, sessions_rows, messages_rows,
 *      archive_rows.
 *   4. `degraded: string[]` naming each breached fact.
 */

import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { createTribeContext, type TribeContext } from "./context.ts"
import {
  handleToolCall,
  resetToolLatencyWindows,
  evaluateDegraded,
  HEALTH_THRESHOLDS,
  type HandlerOpts,
  type RegistryClientSnapshot,
} from "./handlers.ts"

function makeContext(db: Database, stmts: TribeStatements, sessionId: string, name: string): TribeContext {
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

function makeOpts(overrides?: Partial<HandlerOpts>): HandlerOpts {
  return {
    cleanup: () => {},
    userRenamed: false,
    setUserRenamed: () => {},
    getActiveSessionIds: () => new Set<string>(),
    getActiveSessionInfo: () => [],
    ...overrides,
  }
}

function parse(result: unknown): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Record<string, unknown>
}

type ToolStat = { n: number; p50_ms: number; p95_ms: number; max_ms: number }

describe("17018 — tool-latency facts", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements
  let ctx: TribeContext
  let opts: HandlerOpts

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "health-facts-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
    ctx = makeContext(db, stmts, "sess-1", "@agent/1")
    opts = makeOpts()
    resetToolLatencyWindows()
  })
  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("records per-tool latency plus an `all` rollup, keyed without the tribe. prefix", async () => {
    for (let i = 0; i < 5; i++) await handleToolCall(ctx, "tribe.fetch", {}, opts)
    await handleToolCall(ctx, "tribe.members", {}, opts)

    const health = parse(await handleToolCall(ctx, "tribe.health", {}, opts))
    const tl = health.tool_latency as Record<string, ToolStat>

    expect(tl.fetch.n).toBe(5)
    expect(tl.members.n).toBe(1)
    // canonical tools are always present, even with no samples yet
    expect(tl.send).toEqual({ n: 0, p50_ms: 0, p95_ms: 0, max_ms: 0 })
    expect(tl["inbox.wait"]).toEqual({ n: 0, p50_ms: 0, p95_ms: 0, max_ms: 0 })
    // the `all` rollup aggregates every tool's samples (>= fetch + members)
    expect(tl.all.n).toBeGreaterThanOrEqual(6)
    expect(typeof tl.fetch.p50_ms).toBe("number")
    expect(typeof tl.fetch.p95_ms).toBe("number")
    expect(tl.fetch.max_ms).toBeGreaterThanOrEqual(tl.fetch.p95_ms)
    expect(tl.fetch.p95_ms).toBeGreaterThanOrEqual(tl.fetch.p50_ms)
  })

  it("does not accumulate unknown methods into the window", async () => {
    await expect(async () => handleToolCall(ctx, "tribe.bogus", {}, opts)).rejects.toThrow()
    const health = parse(await handleToolCall(ctx, "tribe.health", {}, opts))
    const tl = health.tool_latency as Record<string, ToolStat>
    expect(tl.bogus).toBeUndefined()
  })
})

describe("17018 — registry + identity gauges", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements
  let ctx: TribeContext

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "health-facts-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
    ctx = makeContext(db, stmts, "sess-1", "@agent/1")
    resetToolLatencyWindows()
  })
  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("counts clients, distinct member sessions, stale placeholders and multi-launch personas", async () => {
    const now = Date.now()
    const clients: RegistryClientSnapshot[] = [
      // 6 stale pending placeholders (older than 60s) — count
      ...Array.from({ length: 6 }, (_, i) => ({
        sessionId: `p${i}`,
        name: `pending-${i}`,
        role: "pending",
        launchId: null,
        registeredAt: now - 120_000,
      })),
      // a fresh pending placeholder (younger than 60s) — must NOT count
      { sessionId: "pf", name: "pending-fresh", role: "pending", launchId: null, registeredAt: now },
      // musical chairs: @agent/4 held by two distinct launch generations
      { sessionId: "a", name: "@agent/4", role: "member", launchId: "L1", registeredAt: now },
      { sessionId: "b", name: "@agent/4", role: "member", launchId: "L2", registeredAt: now },
      // by-design fan-in: @agent/5 two transports, SAME launch id → not multi-launch
      { sessionId: "c", name: "@agent/5", role: "member", launchId: "L3", registeredAt: now },
      { sessionId: "c", name: "@agent/5", role: "member", launchId: "L3", registeredAt: now },
    ]
    const opts = makeOpts({ getRegistryClients: () => clients })
    const health = parse(await handleToolCall(ctx, "tribe.health", {}, opts))

    expect(health.clients_total).toBe(11)
    expect(health.members_total).toBe(3) // distinct member sessionIds a,b,c
    expect(health.pending_placeholder_conns).toBe(6)
    expect(health.personas_multi_launch).toBe(1) // only @agent/4

    const degraded = health.degraded as string[]
    expect(degraded).toContain("pending_placeholder_conns")
    expect(degraded).toContain("personas_multi_launch")
  })

  it("omits registry gauges when the accessor is unavailable (direct-handler context)", async () => {
    const health = parse(await handleToolCall(ctx, "tribe.health", {}, makeOpts()))
    expect(health.clients_total).toBeUndefined()
    expect(health.personas_multi_launch).toBeUndefined()
    // db-pressure facts + degraded array are always present
    expect(typeof health.sessions_rows).toBe("number")
    expect(Array.isArray(health.degraded)).toBe(true)
  })
})

describe("17018 — DB-pressure gauges", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements
  let ctx: TribeContext

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "health-facts-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
    ctx = makeContext(db, stmts, "sess-1", "@agent/1")
    resetToolLatencyWindows()
  })
  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("exposes db/wal bytes and row counts", async () => {
    const health = parse(await handleToolCall(ctx, "tribe.health", {}, makeOpts()))
    expect(typeof health.db_bytes).toBe("number")
    expect(health.db_bytes as number).toBeGreaterThan(0)
    expect(typeof health.wal_bytes).toBe("number")
    expect(health.wal_bytes as number).toBeGreaterThanOrEqual(0)
    expect(health.sessions_rows).toBe(0)
    expect(typeof health.messages_rows).toBe("number")
    expect(health.archive_rows).toBe(0)
  })

  it("flags sessions_rows over the documented threshold", async () => {
    const insert = db.prepare(
      "INSERT INTO sessions (id, name, role, pid, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    const over = HEALTH_THRESHOLDS.sessions_rows + 1
    const now = Date.now()
    const tx = db.transaction(() => {
      for (let i = 0; i < over; i++) insert.run(`s${i}`, `n${i}`, "member", 0, now, now)
    })
    tx()
    const health = parse(await handleToolCall(ctx, "tribe.health", {}, makeOpts()))
    expect(health.sessions_rows).toBe(over)
    expect(health.degraded as string[]).toContain("sessions_rows")
  })
})

describe("17018 — degraded contract (pure evaluator)", () => {
  const healthy = {
    wal_bytes: 0,
    sessions_rows: 0,
    archive_rows: 0,
    pending_placeholder_conns: 0,
    personas_multi_launch: 0,
    tool_latency: { fetch: { p95_ms: 10 }, all: { p95_ms: 10 } },
  }

  it("returns empty when nothing is breached", () => {
    expect(evaluateDegraded(healthy)).toEqual([])
  })

  it("flags each DB-pressure fact past its threshold", () => {
    expect(evaluateDegraded({ ...healthy, wal_bytes: HEALTH_THRESHOLDS.wal_bytes + 1 })).toContain("wal_bytes")
    expect(evaluateDegraded({ ...healthy, sessions_rows: HEALTH_THRESHOLDS.sessions_rows + 1 })).toContain(
      "sessions_rows",
    )
    expect(evaluateDegraded({ ...healthy, archive_rows: HEALTH_THRESHOLDS.archive_rows + 1 })).toContain("archive_rows")
  })

  it("flags identity gauges past their thresholds", () => {
    expect(
      evaluateDegraded({ ...healthy, pending_placeholder_conns: HEALTH_THRESHOLDS.pending_placeholder_conns + 1 }),
    ).toContain("pending_placeholder_conns")
    expect(evaluateDegraded({ ...healthy, personas_multi_launch: 1 })).toContain("personas_multi_launch")
  })

  it("flags any real tool whose p95 exceeds the latency ceiling, not the `all` rollup", () => {
    const degraded = evaluateDegraded({
      ...healthy,
      tool_latency: {
        fetch: { p95_ms: HEALTH_THRESHOLDS.tool_p95_ms + 1 },
        all: { p95_ms: HEALTH_THRESHOLDS.tool_p95_ms + 1 },
      },
    })
    expect(degraded).toContain("tool_latency.fetch.p95_ms")
    expect(degraded).not.toContain("tool_latency.all.p95_ms")
  })

  it("skips identity checks when the registry is unavailable (null gauges)", () => {
    const degraded = evaluateDegraded({
      wal_bytes: 0,
      sessions_rows: 0,
      archive_rows: 0,
      pending_placeholder_conns: null,
      personas_multi_launch: null,
      tool_latency: {},
    })
    expect(degraded).toEqual([])
  })
})
