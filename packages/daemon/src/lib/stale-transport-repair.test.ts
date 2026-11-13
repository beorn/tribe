/**
 * @failure Disconnected connection-scoped rows survive forever, and recycled
 * numeric PIDs turn that litter into false owner-live transport wedges.
 * @level l1
 * @consumer Tribe operators, daemon health, and reconnecting wire clients
 *
 * @ag/tribe/21669 — stale transport registration lifetime and repair.
 */

import { Database } from "bun:sqlite"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createScope } from "tribe-wire"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"
import {
  countDurableSessionRows,
  reapStaleTransportRows,
  registerSession,
  type StaleTransportReapReport,
} from "./session.ts"
import { judgeLaunchParentSafely } from "./session-transport-state.ts"
import { DEFAULT_RECONNECT_GRACE_MS, withClientRegistry } from "./compose/with-client-registry.ts"
import { withRuntime } from "./compose/with-runtime.ts"

const PROJECT_ID = "stale-transport-repair"

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

function addSession(
  db: Database,
  stmts: TribeStatements,
  sessionId: string,
  name: string,
  launch?: { id: string; parentPid: number },
): TribeContext {
  const ctx = makeContext(db, stmts, sessionId, name)
  registerSession(
    ctx,
    PROJECT_ID,
    () => false,
    null,
    process.pid,
    "pull",
    "/repo",
    null,
    "codex",
    launch?.id ?? null,
    launch?.parentPid ?? null,
  )
  return ctx
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Record<string, unknown>
}

function emptyReasonCounts(): StaleTransportReapReport["reason_counts"] {
  return {
    active_transport: 0,
    reconnect_grace: 0,
    durable_launch: 0,
    malformed_launch_identity: 0,
    reaped_connection_scoped: 0,
    reaped_superseded_launch: 0,
    reaped_owner_gone: 0,
    launch_parent_unjudged: 0,
  }
}

describe("stale transport registration repair (@ag/tribe/21669)", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "stale-transport-repair-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    vi.useRealTimers()
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("tracks startup and last-disconnect grace while treating watch sockets as active transports", async () => {
    const scope = createScope("stale-transport-registry-test")
    const startedAt = 1_000
    const { registry } = withClientRegistry()({
      scope,
      daemonSessionId: "daemon",
      startedAt,
      daemonVersion: "test",
      daemonPid: process.pid,
    })

    expect(registry.startupReconnectGraceRemainingMs(startedAt)).toBe(DEFAULT_RECONNECT_GRACE_MS)
    expect(registry.isReconnectGraceProtected("legacy", startedAt + DEFAULT_RECONNECT_GRACE_MS - 1)).toBe(true)
    expect(registry.isReconnectGraceProtected("legacy", startedAt + DEFAULT_RECONNECT_GRACE_MS)).toBe(false)

    const disconnectedAt = startedAt + DEFAULT_RECONNECT_GRACE_MS + 10
    registry.markTransportDisconnected("legacy", disconnectedAt)
    expect(registry.isReconnectGraceProtected("legacy", disconnectedAt + DEFAULT_RECONNECT_GRACE_MS - 1)).toBe(true)
    registry.markTransportConnected("legacy")
    expect(registry.isReconnectGraceProtected("legacy", disconnectedAt + DEFAULT_RECONNECT_GRACE_MS - 1)).toBe(false)

    registry.attachTransport("watch-conn", {
      role: "watch",
      ctx: { sessionId: "watch-session" },
    } as never)
    expect(registry.hasActiveTransport("watch-session")).toBe(true)
    await scope[Symbol.asyncDispose]()
  })

  it("projects the bounded repair mode through the existing tribe.repair seam", () => {
    const ctx = makeContext(db, stmts, "operator", "@operator")
    const report: StaleTransportReapReport = {
      examined: 2,
      reaped: 1,
      reason_counts: { ...emptyReasonCounts(), durable_launch: 1, reaped_connection_scoped: 1 },
      reaped_sessions: [{ member_id: "legacy", name: "scratch" }],
    }
    const reapStaleTransports = vi.fn(() => report)
    const opts = {
      cleanup: () => {},
      userRenamed: false,
      setUserRenamed: () => {},
      getActiveSessionIds: () => new Set<string>(),
      hasActiveTransport: () => false,
      getActiveSessionInfo: () => [],
      reapStaleTransports,
    } as HandlerOpts

    expect(parseToolJson(handleToolCall(ctx, "tribe.repair", { reap_stale_transports: true }, opts))).toEqual({
      repaired: true,
      repair: "reap_stale_transports",
      ...report,
    })
    expect(reapStaleTransports).toHaveBeenCalledOnce()
  })

  it("rejects ambiguous repair modes without running either mutation", () => {
    const ctx = makeContext(db, stmts, "operator", "@operator")
    const reapStaleTransports = vi.fn()
    const opts = {
      cleanup: () => {},
      userRenamed: false,
      setUserRenamed: () => {},
      getActiveSessionIds: () => new Set<string>(),
      hasActiveTransport: () => false,
      getActiveSessionInfo: () => [],
      reapStaleTransports,
    } as HandlerOpts

    expect(
      parseToolJson(handleToolCall(ctx, "tribe.repair", { inbox_cursor: "tail", reap_stale_transports: true }, opts)),
    ).toEqual({ error: "repair modes are mutually exclusive; choose inbox_cursor or reap_stale_transports" })
    expect(reapStaleTransports).not.toHaveBeenCalled()
  })

  it("passes a dry run through the repair verb and never reports a repair", () => {
    const ctx = makeContext(db, stmts, "operator", "@operator")
    const report: StaleTransportReapReport = {
      examined: 3,
      reaped: 0,
      reaped_sessions: [],
      dry_run: true,
      would_reap_sessions: [{ member_id: "legacy", name: "scratch" }],
      reason_counts: { ...emptyReasonCounts(), reaped_connection_scoped: 1, durable_launch: 2 },
    }
    const reapStaleTransports = vi.fn(() => report)
    const opts = {
      cleanup: () => {},
      userRenamed: false,
      setUserRenamed: () => {},
      getActiveSessionIds: () => new Set<string>(),
      hasActiveTransport: () => false,
      getActiveSessionInfo: () => [],
      reapStaleTransports,
    } as HandlerOpts

    const dry = parseToolJson(handleToolCall(ctx, "tribe.repair", { reap_stale_transports: true, dry_run: true }, opts))
    expect(reapStaleTransports).toHaveBeenCalledWith(true)
    expect(dry).toEqual({ repair: "reap_stale_transports", ...report })
    expect(dry.repaired).toBeUndefined()

    parseToolJson(handleToolCall(ctx, "tribe.repair", { reap_stale_transports: true }, opts))
    expect(reapStaleTransports).toHaveBeenLastCalledWith(false)
  })

  it("refuses a non-boolean dry_run instead of coercing it", () => {
    const ctx = makeContext(db, stmts, "operator", "@operator")
    const reapStaleTransports = vi.fn()
    const opts = {
      cleanup: () => {},
      userRenamed: false,
      setUserRenamed: () => {},
      getActiveSessionIds: () => new Set<string>(),
      hasActiveTransport: () => false,
      getActiveSessionInfo: () => [],
      reapStaleTransports,
    } as HandlerOpts

    expect(
      parseToolJson(handleToolCall(ctx, "tribe.repair", { reap_stale_transports: true, dry_run: "yes" }, opts)),
    ).toEqual({ error: "dry_run must be a boolean when given" })
    expect(reapStaleTransports).not.toHaveBeenCalled()
  })

  it("keeps durable and malformed launch disconnects loud without paging on legacy PID reuse", () => {
    addSession(db, stmts, "legacy-health", "legacy-health")
    // The launch parent is THIS process, so the row is a live-owner wedge — the
    // condition that must stay loud -- not litter awaiting the reap sweep.
    addSession(db, stmts, "durable-health", "@agent/6", { id: "launch-health", parentPid: process.pid })
    addSession(db, stmts, "malformed-health", "malformed-health")
    db.prepare("UPDATE sessions SET launch_id = 'partial-only' WHERE id = 'malformed-health'").run()
    const ctx = makeContext(db, stmts, "operator", "@operator")
    const opts = {
      cleanup: () => {},
      userRenamed: false,
      setUserRenamed: () => {},
      getActiveSessionIds: () => new Set(["legacy-health"]),
      hasActiveTransport: (sessionId: string) => sessionId === "legacy-health",
      getActiveSessionInfo: () => [
        {
          id: "legacy-health",
          name: "legacy-health",
          pid: process.pid,
          cwd: "/repo",
          role: "member",
          claudeSessionId: null,
          registeredAt: Date.now(),
          launchId: null,
          launchParentPid: null,
          transportPids: [process.pid],
          pushTransportPids: [],
        },
      ],
    } as HandlerOpts

    const health = parseToolJson(handleToolCall(ctx, "tribe.health", {}, opts)) as {
      members: Array<Record<string, unknown>>
      membership_discrepancy: Record<string, unknown>
      transport_wedges: Array<Record<string, unknown>>
      issues: string[]
    }
    expect(health.members).toEqual([
      expect.objectContaining({
        name: "legacy-health",
        agent_pid: process.pid,
        transport_alive: true,
        agent_alive: true,
        pid_alive: true,
        is_silent: false,
        alive: true,
      }),
    ])
    expect(health.membership_discrepancy).toEqual({
      status: "degraded",
      connected_durable_launches: 0,
      known_durable_launches: 1,
      missing_count: 1,
      missing: [
        {
          member_id: "durable-health",
          name: "@agent/6",
          launch_id: "launch-health",
          launch_parent_pid: process.pid,
          last_refusal: null,
          state: "missing-transport",
        },
      ],
      meaning: "missing transport does not establish agent absence",
    })
    expect(health.transport_wedges).toHaveLength(2)
    expect(health.transport_wedges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          member_id: "durable-health",
          name: "@agent/6",
          owner_state: "unknown",
          owner_process: "alive",
          transport_state: "disconnected",
          wedge_reason: "durable-launch-no-transport",
        }),
        expect.objectContaining({
          member_id: "malformed-health",
          owner_state: "unknown",
          transport_state: "disconnected",
          wedge_reason: "malformed-launch-identity",
        }),
      ]),
    )
    expect(health.issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/@agent\/6.*durable-launch-no-transport/),
        expect.stringMatching(/malformed-health.*malformed-launch-identity/),
      ]),
    )
    expect(health.issues.some((issue) => issue.includes("legacy-health"))).toBe(false)

    const members = parseToolJson(handleToolCall(ctx, "tribe.members", {}, opts)) as {
      sessions: Array<Record<string, unknown>>
      membership_discrepancy: Record<string, unknown>
    }
    expect(members.sessions.map((row) => row.name).toSorted()).toEqual(["@agent/6", "legacy-health"])
    expect(members.sessions).toContainEqual(
      expect.objectContaining({
        member_id: "durable-health",
        name: "@agent/6",
        registration: expect.objectContaining({ source: "durable-launch", state: "registered" }),
        transport_state: "disconnected",
      }),
    )
    expect(members.membership_discrepancy).toMatchObject({
      status: "degraded",
      missing: [
        expect.objectContaining({
          member_id: "durable-health",
          name: "@agent/6",
          launch_id: "launch-health",
          state: "missing-transport",
        }),
      ],
    })
    expect(health.membership_discrepancy).toMatchObject({
      status: "degraded",
      missing: [
        expect.objectContaining({
          member_id: "durable-health",
          name: "@agent/6",
          launch_id: "launch-health",
          launch_parent_pid: process.pid,
          state: "missing-transport",
        }),
      ],
    })
  })

  it("keeps disconnected retired registrations as history without reporting a live-seat outage", () => {
    addSession(db, stmts, "retired-fleet", "@fleet", { id: "launch-fleet", parentPid: 7001 })
    addSession(db, stmts, "durable-health", "@agent/6", { id: "launch-health", parentPid: process.pid })
    addSession(db, stmts, "malformed-health", "malformed-health")
    db.prepare("UPDATE sessions SET launch_id = 'partial-only' WHERE id = 'malformed-health'").run()
    const ctx = makeContext(db, stmts, "operator", "@operator")
    const retiredNames = new Set(["@fleet"])
    const opts = {
      cleanup: () => {},
      userRenamed: false,
      setUserRenamed: () => {},
      getActiveSessionIds: () => new Set<string>(),
      hasActiveTransport: () => false,
      getActiveSessionInfo: () => [],
      retiredNames,
    } as HandlerOpts

    const health = parseToolJson(handleToolCall(ctx, "tribe.health", {}, opts)) as {
      membership_discrepancy: { missing: Array<Record<string, unknown>> }
      transport_wedges: Array<Record<string, unknown>>
      issues: string[]
    }
    expect(health.membership_discrepancy.missing).toEqual([
      expect.objectContaining({ member_id: "durable-health", name: "@agent/6" }),
    ])
    expect(health.transport_wedges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ member_id: "durable-health", wedge_reason: "durable-launch-no-transport" }),
        expect.objectContaining({ member_id: "malformed-health", wedge_reason: "malformed-launch-identity" }),
      ]),
    )
    expect(health.transport_wedges).toHaveLength(2)
    expect(health.issues.some((issue) => issue.includes("@fleet"))).toBe(false)

    const members = parseToolJson(handleToolCall(ctx, "tribe.members", { all: true }, opts)) as {
      sessions: Array<Record<string, unknown>>
      membership_discrepancy: { missing: Array<Record<string, unknown>> }
    }
    expect(members.sessions).toContainEqual(
      expect.objectContaining({
        member_id: "retired-fleet",
        name: "@fleet",
        transport_state: "disconnected",
      }),
    )
    expect(members.membership_discrepancy).toMatchObject({
      status: "degraded",
      missing: [
        expect.objectContaining({
          member_id: "durable-health",
          name: "@agent/6",
          launch_id: "launch-health",
          state: "missing-transport",
        }),
      ],
    })
    expect(health.membership_discrepancy).toMatchObject({
      status: "degraded",
      missing: [
        expect.objectContaining({
          member_id: "durable-health",
          name: "@agent/6",
          launch_id: "launch-health",
          launch_parent_pid: process.pid,
          state: "missing-transport",
        }),
      ],
    })
    expect(countDurableSessionRows(db)).toBe(3)
    expect(countDurableSessionRows(db, retiredNames)).toBe(2)
  })

  it("keeps a connected retired identity loud", () => {
    addSession(db, stmts, "retired-fleet", "@fleet", { id: "launch-fleet", parentPid: process.pid })
    const ctx = makeContext(db, stmts, "operator", "@operator")
    const opts = {
      cleanup: () => {},
      userRenamed: false,
      setUserRenamed: () => {},
      getActiveSessionIds: () => new Set(["retired-fleet"]),
      hasActiveTransport: (sessionId: string) => sessionId === "retired-fleet",
      getActiveSessionInfo: () => [
        {
          id: "retired-fleet",
          name: "@fleet",
          pid: process.pid,
          cwd: "/repo",
          role: "member",
          claudeSessionId: null,
          registeredAt: Date.now(),
          launchId: "launch-fleet",
          launchParentPid: process.pid,
          transportPids: [process.pid],
          pushTransportPids: [],
        },
      ],
      retiredNames: new Set(["@fleet"]),
    } as HandlerOpts

    const health = parseToolJson(handleToolCall(ctx, "tribe.health", {}, opts)) as {
      members: Array<{ name: string; warnings: string[] }>
      membership_discrepancy?: Record<string, unknown>
      transport_wedges: Array<Record<string, unknown>>
      issues: string[]
    }
    expect(health.members).toEqual([
      expect.objectContaining({
        name: "@fleet",
        warnings: expect.arrayContaining(["retired identity is connected"]),
      }),
    ])
    expect(health.transport_wedges).toEqual([])
    expect(health.membership_discrepancy).toBeUndefined()
    expect(health.issues).toContain("retired member connected @fleet")
  })

  it("reports disconnected unidentified launches without polluting named health", () => {
    addSession(db, stmts, "named-health", "@agent/6", { id: "launch-a6", parentPid: 6006 })
    const ctx = makeContext(db, stmts, "operator", "@operator")
    const opts = {
      cleanup: () => {},
      userRenamed: false,
      setUserRenamed: () => {},
      getActiveSessionIds: () => new Set<string>(),
      hasActiveTransport: () => false,
      getActiveSessionInfo: () => [],
    } as HandlerOpts

    const before = parseToolJson(handleToolCall(ctx, "tribe.health", {}, opts)) as {
      anonymous_disconnected?: number
      membership_discrepancy: { missing: Array<Record<string, unknown>> }
      transport_wedges: Array<Record<string, unknown>>
    }

    // Models an unnamed adapter registering with launch provenance and then
    // disconnecting. Keep the count visible: @ag/tribe/no-tribe-flag-does-not-gate-the-join
    // is one known producer of these rows.
    addSession(db, stmts, "anonymous-health", "unknown-a1b2c", {
      id: "launch-smoke",
      parentPid: 7007,
    })
    const after = parseToolJson(handleToolCall(ctx, "tribe.health", {}, opts)) as typeof before

    expect(before.anonymous_disconnected).toBe(0)
    expect(after.transport_wedges).toEqual(before.transport_wedges)
    expect(after.membership_discrepancy).toEqual(before.membership_discrepancy)
    expect(after.anonymous_disconnected).toBe((before.anonymous_disconnected ?? 0) + 1)
  })

  it("omits membership degradation when every known addressable durable launch has a connected transport", () => {
    addSession(db, stmts, "durable", "@agent/6", { id: "launch-a6", parentPid: 6006 })
    const ctx = makeContext(db, stmts, "operator", "@operator")
    const opts = {
      cleanup: () => {},
      userRenamed: false,
      setUserRenamed: () => {},
      getActiveSessionIds: () => new Set(["durable"]),
      hasActiveTransport: (sessionId: string) => sessionId === "durable",
      getActiveSessionInfo: () => [
        {
          id: "durable",
          name: "@agent/6",
          pid: 6006,
          cwd: "/repo",
          role: "member",
          claudeSessionId: null,
          registeredAt: Date.now(),
          launchId: "launch-a6",
          launchParentPid: 6006,
          transportPids: [6007],
          pushTransportPids: [],
        },
      ],
    } as HandlerOpts

    const members = parseToolJson(handleToolCall(ctx, "tribe.members", {}, opts))
    const health = parseToolJson(handleToolCall(ctx, "tribe.health", {}, opts))
    expect(members.membership_discrepancy).toBeUndefined()
    expect(health.membership_discrepancy).toBeUndefined()
  })

  it("reaps only disconnected no-launch rows and leaves durable facts untouched", () => {
    addSession(db, stmts, "stale", "legacy-stale")
    addSession(db, stmts, "active", "legacy-active")
    addSession(db, stmts, "grace", "legacy-reconnecting")
    addSession(db, stmts, "durable", "@agent/6", { id: "launch-a6", parentPid: 6006 })
    addSession(db, stmts, "malformed", "legacy-malformed")
    db.prepare("UPDATE sessions SET launch_id = 'partial-only' WHERE id = 'malformed'").run()

    stmts.insertMessage.run({
      $id: "stale-history",
      $type: "request",
      $sender: "legacy-stale",
      $recipient: "@chief",
      $kind: "direct",
      $content: "history must survive row repair",
      $bead_id: null,
      $ref: null,
      $ts: Date.now(),
      $delivery: "pull",
      $topic: null,
      $room_id: null,
      $request: "stale-ball",
      $reply: null,
      $summary: null,
    })
    stmts.openPendingRequest.run({
      $request_id: "stale-ball",
      $recipient: "legacy-stale",
      $sender: "@chief",
      $opened_at: Date.now(),
      $expires_at: null,
      $message_id: "stale-history",
      $fanout: "first",
    })

    const report = reapStaleTransportRows(db, {
      nowMs: 50_000,
      hasActiveTransport: (sessionId) => sessionId === "active",
      isReconnectGraceProtected: (sessionId) => sessionId === "grace",
    })

    expect(report).toEqual({
      examined: 5,
      reaped: 1,
      reason_counts: {
        reaped_superseded_launch: 0,
        active_transport: 1,
        reconnect_grace: 1,
        durable_launch: 1,
        malformed_launch_identity: 1,
        reaped_connection_scoped: 1,
        reaped_owner_gone: 0,
        launch_parent_unjudged: 0,
      },
      reaped_sessions: [{ member_id: "stale", name: "legacy-stale" }],
    })
    expect(
      (db.prepare("SELECT id FROM sessions ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id),
    ).toEqual(["active", "durable", "grace", "malformed"])
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM room_members WHERE session_id = 'stale'").get() as { count: number })
        .count,
    ).toBe(0)
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM messages WHERE id = 'stale-history'").get() as { count: number })
        .count,
    ).toBe(1)
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM pending_request WHERE request_id = 'stale-ball'").get() as {
          count: number
        }
      ).count,
    ).toBe(1)
  })

  it("reaps a durable row whose launch parent is provably gone, and only that row", () => {
    // A real dead pid: spawn a child that exits immediately and reuse its number.
    const deadPid = spawnSync("true").pid
    if (typeof deadPid !== "number" || deadPid <= 0) throw new Error("expected a real dead pid")
    addSession(db, stmts, "litter", "@dev/0", { id: "launch-dev0", parentPid: deadPid })
    addSession(db, stmts, "grace-gone", "@dev/1", { id: "launch-dev1", parentPid: deadPid })
    addSession(db, stmts, "live-owner", "@dev/9", { id: "launch-dev9", parentPid: process.pid })

    const report = reapStaleTransportRows(db, {
      nowMs: 50_000,
      hasActiveTransport: () => false,
      // The owner-gone rule runs INSIDE the reconnect grace, so a seat that is
      // mid-restart is still preserved by its own grace window.
      isReconnectGraceProtected: (sessionId) => sessionId === "grace-gone",
      judgeLaunchParent: judgeLaunchParentSafely,
    })

    expect(report.reason_counts.reaped_owner_gone).toBe(1)
    expect(report.reason_counts.durable_launch).toBe(1)
    expect(report.reason_counts.reconnect_grace).toBe(1)
    expect(report.reaped_sessions).toEqual([{ member_id: "litter", name: "@dev/0" }])
    const survivors = (db.prepare("SELECT id FROM sessions ORDER BY id").all() as Array<{ id: string }>).map(
      (row) => row.id,
    )
    expect(survivors).toEqual(["grace-gone", "live-owner"])
  })

  it("performs a final synchronous sibling-transport fence before deletion", () => {
    addSession(db, stmts, "racing", "legacy-racing")
    let probes = 0
    const report = reapStaleTransportRows(db, {
      nowMs: 50_000,
      hasActiveTransport: () => ++probes >= 2,
      isReconnectGraceProtected: () => false,
    })

    expect(report).toMatchObject({ reaped: 0, reason_counts: { active_transport: 1 } })
    expect(db.prepare("SELECT id FROM sessions WHERE id = 'racing'").get()).toEqual({ id: "racing" })
  })

  it("skips a durable row whose launch parent cannot be read, and says so in the report", () => {
    addSession(db, stmts, "unreadable", "@dev/unknown-parent", { id: "launch-unreadable", parentPid: 4242 })

    const report = reapStaleTransportRows(db, {
      nowMs: 50_000,
      hasActiveTransport: () => false,
      isReconnectGraceProtected: () => false,
      // An unreadable /proc entry is not evidence of death: the row is skipped,
      // counted, and the sweep carries on.
      judgeLaunchParent: () => ({ state: "unjudged", reason: "/proc/4242/stat is unreadable (EPERM)" }),
    })

    expect(report.reaped).toBe(0)
    expect(report.reason_counts.launch_parent_unjudged).toBe(1)
    expect(db.prepare("SELECT id FROM sessions WHERE id = 'unreadable'").get()).toEqual({ id: "unreadable" })
  })

  it("tells the sender a reaped name has no live transport, so a stored ball never reads as delivered", () => {
    const deadPid = spawnSync("true").pid
    if (typeof deadPid !== "number" || deadPid <= 0) throw new Error("expected a real dead pid")
    addSession(db, stmts, "ghost", "@dev/ghost", { id: "launch-ghost", parentPid: deadPid })
    const sender = makeContext(db, stmts, "operator", "@operator")
    const opts = {
      cleanup: () => {},
      userRenamed: false,
      setUserRenamed: () => {},
      getActiveSessionIds: () => new Set<string>(),
      hasActiveTransport: () => false,
      getActiveSessionInfo: () => [],
    } as HandlerOpts
    reapStaleTransportRows(db, {
      hasActiveTransport: () => false,
      isReconnectGraceProtected: () => false,
      judgeLaunchParent: judgeLaunchParentSafely,
    })
    expect(db.prepare("SELECT id FROM sessions WHERE id = 'ghost'").get()).toBeNull()

    // Distinguish this from the parked seat above: that name is reachable again
    // because its own recent send widened the recipient directory. A name with
    // no row and no recent traffic is stored all the same (@cto: storing for a
    // name with no row is what a never-registered name already gets) — and what
    // the sender gets back says so in two independent facts, so it can never
    // read the ball as delivered.
    const sent = parseToolJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: "@dev/ghost", message: "anyone there?", type: "request", request: true, summary: "anyone there?" },
        opts,
      ),
    )
    expect(sent.error).toBeUndefined()
    expect(sent.delivery).toMatchObject({ state: "offline", recipient: "@dev/ghost", reason: "no-session-record" })
    expect(String(sent.warning)).toContain("unreachable (no session)")
    const sentAttention = parseToolJson(handleToolCall(sender, "tribe.fetch", {}, opts)) as {
      attention?: { sent_offline_balls?: Array<{ request_id: string }> }
    }
    expect((sentAttention.attention?.sent_offline_balls ?? []).map((ball) => ball.request_id)).toContain(
      sent.request_id as string,
    )
  })

  it("keeps a watcher's incident alarm working after the watcher's row is reaped (@chief condition 4)", () => {
    const deadPid = spawnSync("true").pid
    if (typeof deadPid !== "number" || deadPid <= 0) throw new Error("expected a real dead pid")
    const watcher = addSession(db, stmts, "watcher", "attention-watch", { id: "launch-watcher", parentPid: deadPid })
    const chief = makeContext(db, stmts, "chief", "@chief")
    const opts = {
      cleanup: () => {},
      userRenamed: false,
      setUserRenamed: () => {},
      getActiveSessionIds: () => new Set<string>(),
      hasActiveTransport: () => false,
      getActiveSessionInfo: () => [],
    } as HandlerOpts
    const raise = () =>
      parseToolJson(
        handleToolCall(
          watcher,
          "tribe.send",
          {
            to: "@chief",
            type: "notify",
            message: "attention-watch: @dev/9 silent",
            incident: { emitter: "attention-watch", subject: "@dev/9", condition: "silent" },
          },
          opts,
        ),
      ) as { request_id?: string; incident?: { transition: string } }
    const incidentId = raise().request_id as string
    const quietUntil = () =>
      (
        db
          .prepare("SELECT expires_at FROM pending_request WHERE request_id = ? AND recipient = '@chief'")
          .get(incidentId) as { expires_at: number | null } | null
      )?.expires_at ?? null

    reapStaleTransportRows(db, {
      hasActiveTransport: () => false,
      isReconnectGraceProtected: () => false,
      judgeLaunchParent: judgeLaunchParentSafely,
    })
    expect(db.prepare("SELECT id FROM sessions WHERE id = 'watcher'").get()).toBeNull()

    // The owner's taking receipt still lands on the incident ball and still sets
    // the quiet-until, even though the emitter name has no sessions row left —
    // and the watcher's next assertion is the SAME ball, so a reap can neither
    // orphan an alarm nor re-page the owner on every tick.
    const before = Date.now()
    const taking = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        {
          to: "attention-watch",
          type: "status",
          ref: incidentId,
          message: `TAKING ${incidentId}`,
          expires_in_ms: 600_000,
        },
        opts,
      ),
    )
    expect(taking.error).toBeUndefined()
    const until = quietUntil()
    expect(until).toBeGreaterThanOrEqual(before + 600_000)
    expect(raise().incident?.transition).toBe("repeated")
    expect(quietUntil()).toBe(until)
  })

  it("previews a bulk reap without deleting anything (@cto item 3)", () => {
    const deadPid = spawnSync("true").pid
    if (typeof deadPid !== "number" || deadPid <= 0) throw new Error("expected a real dead pid")
    addSession(db, stmts, "litter", "@dev/0", { id: "launch-dev0", parentPid: deadPid })
    addSession(db, stmts, "live-owner", "@dev/9", { id: "launch-dev9", parentPid: process.pid })
    addSession(db, stmts, "legacy", "legacy-scratch")

    const report = reapStaleTransportRows(db, {
      nowMs: 50_000,
      hasActiveTransport: () => false,
      isReconnectGraceProtected: () => false,
      judgeLaunchParent: judgeLaunchParentSafely,
      dryRun: true,
    })

    expect(report).toMatchObject({
      examined: 3,
      reaped: 0,
      dry_run: true,
      // The live-owner row is NOT listed, and nothing is deleted.
      would_reap_sessions: [
        { member_id: "legacy", name: "legacy-scratch" },
        { member_id: "litter", name: "@dev/0" },
      ],
    })
    expect(report.reason_counts.reaped_owner_gone).toBe(1)
    expect(report.reason_counts.durable_launch).toBe(1)
    expect((db.prepare("SELECT id FROM sessions ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id)).toEqual(
      ["legacy", "litter", "live-owner"],
    )
  })

  it("keeps a parked seat addressable, and its balls live, across an owner-gone reap (@cto item 2)", () => {
    const deadPid = spawnSync("true").pid
    if (typeof deadPid !== "number" || deadPid <= 0) throw new Error("expected a real dead pid")
    const parked = addSession(db, stmts, "parked", "@dev/parked", { id: "launch-parked", parentPid: deadPid })
    const sender = makeContext(db, stmts, "operator", "@operator")
    const opts = {
      cleanup: () => {},
      userRenamed: false,
      setUserRenamed: () => {},
      getActiveSessionIds: () => new Set<string>(),
      hasActiveTransport: () => false,
      getActiveSessionInfo: () => [],
    } as HandlerOpts
    const sendBall = (from: TribeContext, to: string, label: string) =>
      parseToolJson(
        handleToolCall(
          from,
          "tribe.send",
          { to, message: label, type: "request", request: true, summary: label },
          opts,
        ),
      )
    const ballIds = (owner: string) =>
      (
        parseToolJson(handleToolCall(sender, "tribe.pending", { owner }, opts)).pending as Array<{
          request_id: string
        }>
      ).map((ball) => ball.request_id)

    // MEASURED, and the reason this test names both sides: while the
    // disconnected durable row still exists its mailbox reads as deaf, so the
    // 24581 gate REFUSES a tracked ball ("not online"). After the reap the name
    // has no row, falls out of that gate, and the ball is STORED for pickup.
    // The reap therefore loosens delivery for every parked seat — reported to
    // @cto before submit rather than left to be discovered.
    const beforeReap = sendBall(sender, "@dev/parked", "sent while the car was parked")
    expect(beforeReap.error).toMatch(/not online/)
    expect(ballIds("@dev/parked")).toEqual([])
    // A ball the parked seat itself OWES is the other direction that must survive.
    const owed = sendBall(parked, "@operator", "parked work still owed")
    expect(owed.error).toBeUndefined()
    const owedId = (owed.request_id ?? owed.id) as string

    const report = reapStaleTransportRows(db, {
      hasActiveTransport: () => false,
      isReconnectGraceProtected: () => false,
      judgeLaunchParent: judgeLaunchParentSafely,
    })
    expect(report.reason_counts.reaped_owner_gone).toBe(1)
    expect(db.prepare("SELECT id FROM sessions WHERE id = 'parked'").get()).toBeNull()

    // Delivery after the row is gone is the SAME outcome: accepted and stored,
    // never refused as an unknown recipient.
    const afterReap = sendBall(sender, "@dev/parked", "sent after the row was reaped")
    expect(afterReap.error).toBeUndefined()
    const afterId = (afterReap.request_id ?? afterReap.id) as string
    expect(typeof afterId).toBe("string")
    expect(ballIds("@dev/parked")).toContain(afterId)
    expect(ballIds("@operator")).toContain(owedId)
    // @cto's condition on option (a): a ball stored for a name with no live
    // transport must never read as delivered. The send result says offline —
    // never the online form that means "a live transport took this"...
    expect(afterReap.delivery).toMatchObject({ state: "offline", recipient: "@dev/parked" })
    // ...and the sender's own next default fetch surfaces the ball it sent into
    // the void as still offline, so it is visible as outstanding rather than
    // assumed landed.
    const senderAttention = parseToolJson(handleToolCall(sender, "tribe.fetch", {}, opts)) as {
      attention?: { sent_offline_balls?: Array<{ request_id: string }> }
    }
    expect((senderAttention.attention?.sent_offline_balls ?? []).map((ball) => ball.request_id)).toContain(afterId)

    // The seat comes back and reads what was sent to it.
    const back = addSession(db, stmts, "parked-back", "@dev/parked", {
      id: "launch-parked-back",
      parentPid: process.pid,
    })
    const fetched = parseToolJson(handleToolCall(back, "tribe.fetch", {}, opts)) as {
      attention?: { actionable_unread?: Array<{ id: string }> }
    }
    expect((fetched.attention?.actionable_unread ?? []).map((row) => row.id)).toEqual(expect.arrayContaining([afterId]))
    const reply = parseToolJson(
      handleToolCall(
        back,
        "tribe.send",
        {
          to: "@operator",
          message: "read and answered",
          type: "response",
          reply: afterId,
          summary: "read and answered",
        },
        opts,
      ),
    )
    expect(reply.tracker).toMatchObject({ closed: 1 })
  })

  it("rolls the whole transaction back when session deletion aborts", () => {
    addSession(db, stmts, "rollback", "legacy-rollback")
    db.run(`CREATE TRIGGER fail_stale_transport_delete
      BEFORE DELETE ON sessions WHEN OLD.id = 'rollback'
      BEGIN SELECT RAISE(ABORT, 'blocked session delete'); END`)
    expect(() =>
      reapStaleTransportRows(db, {
        nowMs: 50_000,
        hasActiveTransport: () => false,
        isReconnectGraceProtected: () => false,
      }),
    ).toThrow(/blocked session delete/)
    // The session row surviving IS the rollback proof. This used to assert a
    // room_members row survived alongside it; rooms were deleted (@cto ruling
    // 2026-08-13) and the membership row was only ever the observable, never
    // the subject. The atomicity coverage is unchanged.
    expect(db.prepare("SELECT id FROM sessions WHERE id = 'rollback'").get()).toEqual({ id: "rollback" })
  })

  it("automatically reaps the incident junk rows after startup reconnect grace and on the existing cadence", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    addSession(db, stmts, "incident-silvercode-30852", "silvercode-30852")
    // A durable row whose launch parent is gone: reaped by the same startup
    // sweep, and journaled rather than vanishing into a count.
    const deadPid = spawnSync("true").pid
    if (typeof deadPid !== "number" || deadPid <= 0) throw new Error("expected a real dead pid")
    addSession(db, stmts, "parked-seat", "@dev/parked", { id: "launch-parked", parentPid: deadPid })
    const scope = createScope("stale-transport-runtime-test")
    const registry = {
      clients: new Map(),
      socketToClient: new Map(),
      getActiveSessionIds: () => new Set<string>(),
      getActiveSessionInfo: () => [],
      hasActiveTransport: () => false,
      isReconnectGraceProtected: () => false,
      startupReconnectGraceRemainingMs: () => 100,
      forgetTransportSessions: vi.fn(),
      onTransportDisconnected: vi.fn(),
    }
    const shape = {
      scope,
      daemonSessionId: "daemon",
      startedAt: 10_000,
      daemonVersion: "test",
      daemonPid: process.pid,
      config: {},
      db,
      stmts,
      daemonCtx: makeContext(db, stmts, "daemon", "daemon"),
      recall: null,
      registry,
      broadcast: {},
      socket: {},
    }
    withRuntime({
      plugins: [],
      buildPluginApi: () => ({}) as never,
      cleanupIntervalMs: 1_000,
      publishActivePluginNames: () => {},
      publishStopPlugins: () => {},
      publishShutdown: () => {},
    })(shape as never)

    await vi.advanceTimersByTimeAsync(99)
    expect(db.prepare("SELECT id FROM sessions WHERE id = 'incident-silvercode-30852'").get()).toEqual({
      id: "incident-silvercode-30852",
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(db.prepare("SELECT id FROM sessions WHERE id = 'incident-silvercode-30852'").get()).toBeNull()
    expect(db.prepare("SELECT id FROM sessions WHERE id = 'parked-seat'").get()).toBeNull()
    expect(registry.forgetTransportSessions).toHaveBeenCalledWith(["incident-silvercode-30852", "parked-seat"])
    const leftFact = db
      .prepare("SELECT content FROM messages WHERE type = 'event.session.left' AND ref = 'parked-seat'")
      .get() as { content: string } | null
    expect(leftFact).not.toBeNull()
    expect(JSON.parse(leftFact?.content ?? "{}")).toMatchObject({
      member_id: "parked-seat",
      name: "@dev/parked",
      launch_id: "launch-parked",
      launch_parent_pid: deadPid,
      reason: "reaped-parent-gone",
      launch_parent_comparison: "pid-only-row",
    })
    // Connection-scoped litter is reaped without a departure fact: nothing says
    // that launch was a seat, and a synthetic fact would read as a fresh exit.
    expect(
      db
        .prepare("SELECT id FROM messages WHERE type = 'event.session.left' AND ref = 'incident-silvercode-30852'")
        .get(),
    ).toBeNull()

    addSession(db, stmts, "incident-session-1", "session 1")
    await vi.advanceTimersByTimeAsync(899)
    expect(db.prepare("SELECT id FROM sessions WHERE id = 'incident-session-1'").get()).toEqual({
      id: "incident-session-1",
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(db.prepare("SELECT id FROM sessions WHERE id = 'incident-session-1'").get()).toBeNull()
    expect(registry.forgetTransportSessions).toHaveBeenLastCalledWith(["incident-session-1"])
    await scope[Symbol.asyncDispose]()
  })
})
