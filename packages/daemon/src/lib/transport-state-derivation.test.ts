/**
 * @failure Read-time projections reported `transport_state: "connected"` from
 * transport-registry presence alone, so a row could assert a live transport
 * and `pid_alive: false` about the same session in the same breath; and a
 * durable-launch row stayed a permanent "wedge" after its seat re-registered
 * under a fresh connection, inflating fleet-outage counts.
 * @level l1
 * @consumer Tribe operators, `tribe.members`, `tribe.health`, fleet recovery
 *
 * Two live specimens, 2026-08-13:
 *
 * 1. `tribe.members` / `tribe.health` returned `transport_state: "connected"`,
 *    `transport_alive: true`, `transport_reason: "registered-transport"` for
 *    six sessions whose registered transport pids were all dead — the same
 *    rows correctly carried `pid_alive: false` from the derived-liveness fix
 *    (c15f7d1, "members liveness derived not stored"). A fleet-wide recovery
 *    was nearly mis-planned off `transport_state` alone.
 *
 * 2. `tribe.health` listed 21 of 23 durable launches as
 *    `durable-launch-no-transport` transport wedges while at least three of
 *    those seats were alive and working: they had re-registered under fresh
 *    member rows (auto-suffixed or renamed) while the old durable-launch row
 *    for the same `launch_id` lingered, inflating
 *    `membership_discrepancy.missing_count` into a rendered outage that was
 *    not happening.
 *
 * The rule both specimens want: transport state is DERIVED from current
 * evidence at every read-time projection, and a registration that a live
 * transport has provably replaced is superseded rather than left standing.
 *
 * The caveat this must NOT break: a missing transport still never establishes
 * agent absence. Supersession is concluded from a transport that is PRESENT
 * (a live authenticated claimant for the same launch_id), never from one that
 * is missing.
 */

import { spawnSync } from "node:child_process"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type ActiveSessionInfo, type HandlerOpts } from "./handlers.ts"
import { reapStaleTransportRows, registerSession } from "./session.ts"

const PROJECT_ID = "transport-state-derivation"

/** A pid guaranteed to be dead: spawn a real child that exits immediately and
 *  reuse the now-freed pid number, so the probe exercises the real ESRCH path
 *  rather than a fabricated integer. Same accepted PID-reuse risk as the
 *  neighbouring members-liveness-derivation.test.ts / stale-transport-repair.test.ts. */
function mintDeadPid(): number {
  const result = spawnSync("true", [])
  if (typeof result.pid !== "number" || result.pid <= 0) {
    throw new Error(`expected a real pid from the spawned probe process, got ${JSON.stringify(result.pid)}`)
  }
  return result.pid
}

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
  pid: number,
  launch?: { id: string; parentPid: number },
  isActive: (sessionId: string) => boolean = () => false,
): TribeContext {
  const ctx = makeContext(db, stmts, sessionId, name)
  registerSession(
    ctx,
    PROJECT_ID,
    isActive,
    null,
    pid,
    "pull",
    "/repo",
    null,
    "codex",
    launch?.id ?? null,
    launch?.parentPid ?? null,
  )
  return ctx
}

function activeInfoFor(
  id: string,
  name: string,
  pid: number,
  launch?: { id: string; parentPid: number },
): ActiveSessionInfo {
  return {
    id,
    name,
    pid,
    cwd: "/repo",
    role: "member",
    claudeSessionId: null,
    registeredAt: Date.now(),
    launchId: launch?.id ?? null,
    launchParentPid: launch?.parentPid ?? null,
    transportPids: [pid],
  }
}

function optsFor(active: ActiveSessionInfo[]): HandlerOpts {
  const activeIds = new Set(active.map((session) => session.id))
  return {
    cleanup: () => {},
    userRenamed: false,
    setUserRenamed: () => {},
    getActiveSessionIds: () => activeIds,
    hasActiveTransport: (sessionId: string) => activeIds.has(sessionId),
    getActiveSessionInfo: () => active,
  } as HandlerOpts
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Record<string, unknown>
}

describe("transport state is derived from current evidence, not registration presence", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "transport-derivation-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("reports a registered transport whose pids are all dead as not connected (specimen 1, members)", () => {
    const deadPid = mintDeadPid()
    addSession(db, stmts, "zombie-transport", "@agent/6", deadPid)
    const ctx = makeContext(db, stmts, "operator", "@operator")
    const opts = optsFor([activeInfoFor("zombie-transport", "@agent/6", deadPid)])

    const members = parseToolJson(handleToolCall(ctx, "tribe.members", {}, opts)) as {
      sessions: Array<Record<string, unknown>>
    }

    expect(members.sessions).toEqual([
      expect.objectContaining({
        name: "@agent/6",
        // The registration table is untouched and still visible as its own
        // fact — but it is no longer allowed to speak for the transport.
        transport_registered: true,
        transport_state: "disconnected",
        transport_alive: false,
        transport_reason: "registered-transport-pids-dead",
        pid_alive: false,
        alive: false,
      }),
    ])
  })

  it("reports the same derived transport state on health as on members (specimen 1, health)", () => {
    const deadPid = mintDeadPid()
    addSession(db, stmts, "zombie-transport", "@agent/6", deadPid)
    const ctx = makeContext(db, stmts, "operator", "@operator")
    const opts = optsFor([activeInfoFor("zombie-transport", "@agent/6", deadPid)])

    const health = parseToolJson(handleToolCall(ctx, "tribe.health", {}, opts)) as {
      members: Array<Record<string, unknown>>
    }

    expect(health.members).toEqual([
      expect.objectContaining({
        name: "@agent/6",
        transport_registered: true,
        transport_state: "disconnected",
        transport_alive: false,
        transport_reason: "registered-transport-pids-dead",
        pid_alive: false,
        alive: false,
      }),
    ])
  })

  it("never emits transport_state connected alongside pid_alive false in one row", () => {
    const deadPid = mintDeadPid()
    addSession(db, stmts, "zombie-transport", "@agent/6", deadPid)
    addSession(db, stmts, "healthy-transport", "@agent/7", process.pid)
    const ctx = makeContext(db, stmts, "operator", "@operator")
    const opts = optsFor([
      activeInfoFor("zombie-transport", "@agent/6", deadPid),
      activeInfoFor("healthy-transport", "@agent/7", process.pid),
    ])

    const members = parseToolJson(handleToolCall(ctx, "tribe.members", {}, opts)) as {
      sessions: Array<Record<string, unknown>>
    }
    const contradictory = members.sessions.filter(
      (session) => session.transport_state === "connected" && session.pid_alive === false,
    )
    expect(contradictory).toEqual([])
  })

  it("still reports a live registered transport as connected", () => {
    addSession(db, stmts, "live-transport", "@agent/7", process.pid)
    const ctx = makeContext(db, stmts, "operator", "@operator")
    const opts = optsFor([activeInfoFor("live-transport", "@agent/7", process.pid)])

    const members = parseToolJson(handleToolCall(ctx, "tribe.members", {}, opts)) as {
      sessions: Array<Record<string, unknown>>
    }

    expect(members.sessions).toEqual([
      expect.objectContaining({
        name: "@agent/7",
        transport_registered: true,
        transport_state: "connected",
        transport_alive: true,
        transport_reason: "registered-transport",
        pid_alive: true,
        alive: true,
      }),
    ])
  })

  it("keeps an unknown-pid transport connected — no pids is not evidence of death", () => {
    addSession(db, stmts, "pidless-transport", "@agent/8", 0)
    const ctx = makeContext(db, stmts, "operator", "@operator")
    const info = { ...activeInfoFor("pidless-transport", "@agent/8", 0), transportPids: [] as number[] }
    const opts = optsFor([info])

    const members = parseToolJson(handleToolCall(ctx, "tribe.members", {}, opts)) as {
      sessions: Array<Record<string, unknown>>
    }

    expect(members.sessions).toEqual([
      expect.objectContaining({
        name: "@agent/8",
        transport_state: "connected",
        transport_alive: true,
        transport_reason: "registered-transport",
      }),
    ])
  })
})

describe("a replaced registration is retired by projection and repair, never by the write path", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "transport-supersede-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  /** The live shape: `@agent/6` registers, its transport dies without the
   *  socket-close handler pruning the row, then the seat comes back. Because
   *  the old row still holds the name and the daemon still believes it is
   *  connected, registration auto-suffixes to `@agent/6-2` — a FRESH member
   *  row under the SAME launch_id, leaving the old row behind as a "wedge".
   *  `launch_id` is `providerLaunchId::persona` (persona-launch-identity.ts),
   *  so a shared launch_id is the same seat from the same provider launch,
   *  never two different seats. */
  const LAUNCH = { id: "provider-launch-1::%40agent%2F6", parentPid: 4242 }

  it("stores both rows — registration retires nothing on a shared launch_id", () => {
    // Registration must not delete rows keyed on launch_id. Deleting here
    // destroys live sibling transports: the dispatcher's same-launch fan-in
    // normally collapses siblings onto one session id, but it matches on
    // NAME, and concurrent adapters from one provider launch can reach
    // registration before any name-holder exists to fan in to. A write-time
    // pass cost the three-adapter fan-in journey two of its three
    // transport_pids, and no fence closes it — a sibling mid-registration is
    // not yet active and its pid is alive. This is the regression guard.
    addSession(db, stmts, "old-connection", "@agent/6", mintDeadPid(), LAUNCH)
    addSession(db, stmts, "new-connection", "@agent/6-2", process.pid, LAUNCH)

    const rows = db.prepare("SELECT id, name, launch_id FROM sessions ORDER BY id").all() as Array<{
      id: string
      name: string
      launch_id: string | null
    }>

    expect(rows).toEqual([
      { id: "new-connection", name: "@agent/6-2", launch_id: LAUNCH.id },
      { id: "old-connection", name: "@agent/6", launch_id: LAUNCH.id },
    ])
  })

  it("projects only the live seat while both rows are stored", () => {
    addSession(db, stmts, "old-connection", "@agent/6", mintDeadPid(), LAUNCH)
    addSession(db, stmts, "new-connection", "@agent/6-2", process.pid, LAUNCH)
    const ctx = makeContext(db, stmts, "operator", "@operator")
    const opts = optsFor([activeInfoFor("new-connection", "@agent/6-2", process.pid, LAUNCH)])

    const members = parseToolJson(handleToolCall(ctx, "tribe.members", {}, opts)) as {
      sessions: Array<Record<string, unknown>>
      membership_discrepancy?: Record<string, unknown>
    }
    const diagnostic = parseToolJson(handleToolCall(ctx, "tribe.members", { all: true }, opts)) as {
      sessions: Array<Record<string, unknown>>
    }

    // The default view is what consumers act on: only the live seat, and the
    // replaced row raises no discrepancy.
    expect(members.sessions.map((session) => session.name)).toEqual(["@agent/6-2"])
    expect(members.membership_discrepancy).toBeUndefined()
    // `all: true` is the deliberate full-DB diagnostic view, so the stored
    // replaced row stays visible there — retired from the projection, not
    // erased from the record.
    expect(diagnostic.sessions.map((session) => session.name).toSorted()).toEqual(["@agent/6", "@agent/6-2"])
  })

  it("does not report a superseded durable row as a transport wedge (specimen 2)", () => {
    addSession(db, stmts, "old-connection", "@agent/6", mintDeadPid(), LAUNCH)
    addSession(db, stmts, "new-connection", "@agent/6-2", process.pid, LAUNCH)
    const ctx = makeContext(db, stmts, "operator", "@operator")
    const opts = optsFor([activeInfoFor("new-connection", "@agent/6-2", process.pid, LAUNCH)])

    const health = parseToolJson(handleToolCall(ctx, "tribe.health", {}, opts)) as {
      transport_wedges: Array<Record<string, unknown>>
      membership_discrepancy?: { missing_count: number }
    }

    expect(health.transport_wedges).toEqual([])
    expect(health.membership_discrepancy).toBeUndefined()
  })

  it("still reports a durable row with no live claimant as a wedge — absence is not supersession", () => {
    addSession(db, stmts, "orphan-connection", "@agent/9", process.pid, {
      id: "provider-launch-2::%40agent%2F9",
      parentPid: 9009,
    })
    const ctx = makeContext(db, stmts, "operator", "@operator")
    const opts = optsFor([])

    const health = parseToolJson(handleToolCall(ctx, "tribe.health", {}, opts)) as {
      transport_wedges: Array<Record<string, unknown>>
      membership_discrepancy?: { missing_count: number; meaning: string }
    }

    expect(health.transport_wedges).toEqual([
      expect.objectContaining({ name: "@agent/9", wedge_reason: "durable-launch-no-transport" }),
    ])
    expect(health.membership_discrepancy).toEqual(
      expect.objectContaining({
        missing_count: 1,
        meaning: "missing transport does not establish agent absence",
      }),
    )
  })
})

describe("the repair verb can reach a superseded durable registration", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "transport-reap-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const LAUNCH = { id: "provider-launch-3::%40agent%2F4", parentPid: 4004 }

  it("reaps a durable row whose launch_id a live transport has claimed", () => {
    addSession(db, stmts, "old-connection", "@agent/4", mintDeadPid(), LAUNCH)
    addSession(db, stmts, "new-connection", "@agent/4-2", process.pid, LAUNCH)

    const report = reapStaleTransportRows(db, {
      hasActiveTransport: (sessionId) => sessionId === "new-connection",
      isReconnectGraceProtected: () => false,
      getActiveLaunchIds: () => new Set([LAUNCH.id]),
    })

    expect(report.reaped_sessions).toEqual([{ member_id: "old-connection", name: "@agent/4" }])
    expect(report.reason_counts.reaped_superseded_launch).toBe(1)
    const survivors = db.prepare("SELECT id FROM sessions ORDER BY id").all() as Array<{ id: string }>
    expect(survivors).toEqual([{ id: "new-connection" }])
  })

  it("never reaps a durable row that no live transport has claimed", () => {
    addSession(db, stmts, "orphan-connection", "@agent/9", process.pid, {
      id: "provider-launch-4::%40agent%2F9",
      parentPid: 9009,
    })

    const report = reapStaleTransportRows(db, {
      hasActiveTransport: () => false,
      isReconnectGraceProtected: () => false,
      getActiveLaunchIds: () => new Set<string>(),
    })

    expect(report.reaped).toBe(0)
    expect(report.reason_counts.durable_launch).toBe(1)
    const survivors = db.prepare("SELECT id FROM sessions ORDER BY id").all() as Array<{ id: string }>
    expect(survivors).toEqual([{ id: "orphan-connection" }])
  })

  it("does not require the dead transport it is repairing", () => {
    addSession(db, stmts, "old-connection", "@agent/4", mintDeadPid(), LAUNCH)
    addSession(db, stmts, "new-connection", "@agent/4-2", process.pid, LAUNCH)

    // The dead connection is absent from the registry entirely — the repair
    // must still reach its row through the live claimant's launch_id.
    const report = reapStaleTransportRows(db, {
      hasActiveTransport: (sessionId) => sessionId === "new-connection",
      isReconnectGraceProtected: () => false,
      getActiveLaunchIds: () => new Set([LAUNCH.id]),
    })

    expect(report.reaped).toBe(1)
  })
})
