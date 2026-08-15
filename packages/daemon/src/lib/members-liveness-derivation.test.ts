/**
 * `tribe.members` (`handleSessions`) asserted `alive` from daemon in-memory
 * transport-registry presence alone (`activeIds.has(sessionId)`) and never
 * probed the owning pid — unlike `tribe.health` (`handleHealth`), which
 * already derives liveness via `pidStillAlive` + `projectSessionLiveness`.
 * A registry entry can outlive the process it names (a dead transport
 * adapter, a session mid-restart whose old socket hasn't been pruned yet),
 * so stored transport-registry belief is not the same fact as "the process
 * is alive" — two live incidents surfaced `tribe.members` reporting
 * `alive: true` for pids that no longer existed.
 *
 * `alive` must be derived by probing the pid at projection-read time, the
 * same way `handleHealth` already does, so the two endpoints cannot
 * disagree about the same session's liveness.
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
import { registerSession } from "./session.ts"

const PROJECT_ID = "members-liveness-derivation"

/** A pid guaranteed to be dead: spawn a real child that exits immediately,
 *  block until it exits and is reaped, then reuse the now-freed pid number.
 *  A locally-fabricated integer wouldn't exercise the real ESRCH path that
 *  `process.kill(pid, 0)` has to catch. PID reuse by the OS in the brief
 *  window before this test probes it again is possible in principle but
 *  negligible in practice (same accepted risk as every other pid-probe test
 *  in this file's neighborhood, e.g. stale-transport-repair.test.ts). */
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

function addSession(db: Database, stmts: TribeStatements, sessionId: string, name: string, pid: number): void {
  const ctx = makeContext(db, stmts, sessionId, name)
  registerSession(ctx, PROJECT_ID, () => false, null, pid, "pull", "/repo", null, "codex", null, null)
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Record<string, unknown>
}

function activeInfoFor(id: string, name: string, pid: number): ActiveSessionInfo {
  return {
    id,
    name,
    pid,
    cwd: "/repo",
    role: "member",
    claudeSessionId: null,
    registeredAt: Date.now(),
    launchId: null,
    launchParentPid: null,
    transportPids: [pid],
  }
}

describe("tribe.members derives alive from the pid, not stored transport-registry presence", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "members-liveness-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("reports alive=false when the registry still claims a transport for a pid that no longer exists", () => {
    const deadPid = mintDeadPid()
    addSession(db, stmts, "zombie-transport", "zombie-agent", deadPid)
    const ctx = makeContext(db, stmts, "operator", "@operator")
    const opts = {
      cleanup: () => {},
      userRenamed: false,
      setUserRenamed: () => {},
      // The daemon's in-memory registry still has a live ClientSession for
      // this connection — the socket close hasn't been observed/pruned even
      // though the owning OS process is already gone. This is the exact
      // "dead transport adapter" / "session mid-restart" shape from the live
      // incidents: registry presence says connected, the pid says otherwise.
      getActiveSessionIds: () => new Set(["zombie-transport"]),
      hasActiveTransport: (sessionId: string) => sessionId === "zombie-transport",
      getActiveSessionInfo: () => [activeInfoFor("zombie-transport", "zombie-agent", deadPid)],
    } as HandlerOpts

    const members = parseToolJson(handleToolCall(ctx, "tribe.members", {}, opts)) as {
      sessions: Array<Record<string, unknown>>
    }
    expect(members.sessions).toEqual([
      expect.objectContaining({
        name: "zombie-agent",
        // The registry really does still have this connection open, and that
        // fact keeps its own field. It no longer speaks for the transport:
        // this row used to read `transport_state: "connected"` next to
        // `pid_alive: false`, and on 2026-08-13 six such rows nearly sent a
        // fleet-wide recovery after the wrong sessions.
        transport_registered: true,
        transport_state: "disconnected",
        transport_alive: false,
        transport_reason: "registered-transport-pids-dead",
        // The pid is provably dead, so alive is false too.
        pid_alive: false,
        alive: false,
      }),
    ])
  })

  it("keeps alive=true for a genuinely live, currently-connected pid", () => {
    addSession(db, stmts, "live-transport", "live-agent", process.pid)
    const ctx = makeContext(db, stmts, "operator", "@operator")
    const opts = {
      cleanup: () => {},
      userRenamed: false,
      setUserRenamed: () => {},
      getActiveSessionIds: () => new Set(["live-transport"]),
      hasActiveTransport: (sessionId: string) => sessionId === "live-transport",
      getActiveSessionInfo: () => [activeInfoFor("live-transport", "live-agent", process.pid)],
    } as HandlerOpts

    const members = parseToolJson(handleToolCall(ctx, "tribe.members", {}, opts)) as {
      sessions: Array<Record<string, unknown>>
    }
    expect(members.sessions).toEqual([
      expect.objectContaining({
        name: "live-agent",
        transport_state: "connected",
        transport_alive: true,
        pid_alive: true,
        alive: true,
      }),
    ])
  })

  it("never probes a disconnected row's stale DB-stored pid — transport absence alone is enough", () => {
    // A disconnected session's last-known pid is reusable and proves nothing
    // (session.ts `isPidAlive` docstring); it must not be pid-probed into a
    // false "alive". Register with the CURRENT test process's pid (always
    // alive) and confirm a disconnected row still reads alive=false.
    addSession(db, stmts, "long-gone", "long-gone-agent", process.pid)
    const ctx = makeContext(db, stmts, "operator", "@operator")
    const opts = {
      cleanup: () => {},
      userRenamed: false,
      setUserRenamed: () => {},
      getActiveSessionIds: () => new Set<string>(),
      hasActiveTransport: () => false,
      getActiveSessionInfo: () => [],
    } as HandlerOpts

    const members = parseToolJson(handleToolCall(ctx, "tribe.members", { all: true }, opts)) as {
      sessions: Array<Record<string, unknown>>
    }
    expect(members.sessions).toEqual([
      expect.objectContaining({
        name: "long-gone-agent",
        transport_state: "disconnected",
        transport_alive: false,
        alive: false,
      }),
    ])
  })
})
