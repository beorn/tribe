/**
 * @failure Disconnected connection-scoped rows survive forever, and recycled
 * numeric PIDs turn that litter into false owner-live transport wedges.
 * @level l1
 * @consumer Tribe operators, daemon health, and reconnecting wire clients
 *
 * @ag/tribe/21669 — stale transport registration lifetime and repair.
 */

import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createScope } from "tribe-wire"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"
import { reapStaleTransportRows, registerSession, type StaleTransportReapReport } from "./session.ts"
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

    registry.clients.set("watch-conn", {
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

  it("keeps durable and malformed launch disconnects loud without paging on legacy PID reuse", () => {
    addSession(db, stmts, "legacy-health", "legacy-health")
    addSession(db, stmts, "durable-health", "@agent/6", { id: "launch-health", parentPid: 6006 })
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
          launch_parent_pid: 6006,
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
    expect(members.sessions).toEqual([expect.objectContaining({ name: "legacy-health" })])
    expect(members.membership_discrepancy).toEqual(health.membership_discrepancy)
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

  it("rolls room membership back when session deletion aborts", () => {
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
    expect(db.prepare("SELECT id FROM sessions WHERE id = 'rollback'").get()).toEqual({ id: "rollback" })
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM room_members WHERE session_id = 'rollback'").get() as {
          count: number
        }
      ).count,
    ).toBe(1)
  })

  it("automatically reaps the incident junk rows after startup reconnect grace and on the existing cadence", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    addSession(db, stmts, "incident-silvercode-30852", "silvercode-30852")
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
    expect(registry.forgetTransportSessions).toHaveBeenCalledWith(["incident-silvercode-30852"])

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
