/**
 * Tribe autostart — probe-and-spawn helpers for zero-ceremony daemon lifecycle.
 *
 * Pairs with the daemon's own `--idle-quit-after` exit: the daemon quits
 * itself when unused, this module spawns it back on first demand. Net effect
 * for the user: no lifecycle ceremony at all.
 *
 * The exported helpers are written so the orchestration function
 * (`ensureTribeDaemonIfConfigured`) is pure side-effect-free given its deps —
 * tests inject `spawn`/`probe` implementations rather than stubbing globals.
 *
 * Hard rule: none of this may ever block a Claude Code hook. The whole
 * end-to-end budget is ~300ms; probe failures and spawn failures are
 * swallowed with a single stderr line, and the hook proceeds to its library
 * fallback.
 *
 * The tribe daemon hosts both coordination and memory RPC surfaces.
 */

import { createConnection } from "node:net"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { createLogger } from "loggily"
import { spawnStandaloneDaemonSupervisor } from "tribe-wire"
import { resolveAutostart, type TribeAutostart } from "./autostart-config.ts"
import { resolveSocketPath as resolveTribeSocketPath } from "tribe-wire/lib/socket"

// Diagnostic output goes through loggily — never `process.stderr.write`.
// Hook entry points (`tools/lib/tribe/hook-dispatch.ts`) call
// `setSuppressConsole(true)` to keep this off Claude Code's hook-stderr
// capture path; see that file's docstring for the upstream bug context.
const autostartLog = createLogger("tribe:autostart")

// ---------------------------------------------------------------------------
// Daemon liveness probe
// ---------------------------------------------------------------------------

export type DaemonProbeResult = "alive" | "dead" | "stale-socket"

/**
 * Attempt to connect to the daemon's Unix socket with a short timeout. Returns
 * `"alive"` on successful connect, `"dead"` when the socket file is absent or
 * refuses connections, `"stale-socket"` when the file exists but connect
 * fails. This probe is deliberately non-destructive: several host processes
 * can autostart concurrently, so an observer must never unlink a socket that
 * another daemon candidate is establishing. The daemon's retrying pre-bind
 * probe owns stale-socket reclamation and the bind itself elects the winner.
 */
export function isDaemonAlive(socketPath: string, timeoutMs = 200): Promise<boolean> {
  return new Promise((resolve) => {
    // If the file doesn't exist, the daemon is definitely dead — no probe needed.
    if (!existsSync(socketPath)) {
      resolve(false)
      return
    }

    const socket = createConnection(socketPath)
    let done = false

    const finish = (alive: boolean) => {
      if (done) return
      done = true
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
      clearTimeout(timer)
      resolve(alive)
    }

    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}

// ---------------------------------------------------------------------------
// Standalone lifecycle-owner spawn
// ---------------------------------------------------------------------------

/** Location of the tribe coordination daemon script (relative to this file). */
export function resolveTribeDaemonScriptPath(): string {
  // packages/daemon/src/lib/autostart.ts → packages/daemon/src/daemon.ts
  const thisDir = dirname(new URL(import.meta.url).pathname)
  return resolve(thisDir, "..", "daemon.ts")
}

export type SpawnResult = { ok: true; pid: number } | { ok: false; error: string }

/**
 * Spawn the tribe daemon through the stable standalone lifecycle owner.
 * Stdout/stderr are discarded. Returns the owner PID on success, an error on
 * failure. Never throws.
 *
 * The spawn is fire-and-forget: we don't wait for the socket to be ready.
 * Hook dispatch proceeds to the library fallback for this one turn, and
 * later hooks find a live daemon. This is the whole point of "zero ceremony".
 */
export function spawnTribeDaemonDetached(
  opts: {
    socketPath?: string
    bunPath?: string
    scriptPath?: string
    label?: string
    log?: (msg: string) => void
  } = {},
): SpawnResult {
  const scriptPath = opts.scriptPath ?? resolveTribeDaemonScriptPath()
  const bunPath = opts.bunPath ?? process.execPath
  const label = opts.label ?? "tribe"
  const args = [scriptPath]
  if (opts.socketPath) args.push("--socket", opts.socketPath)

  try {
    const child = spawnStandaloneDaemonSupervisor({
      daemonScript: args[0]!,
      daemonArgs: args.slice(1),
      runtimePath: bunPath,
    })
    const pid = child.pid
    if (typeof pid !== "number") {
      return { ok: false, error: "spawn returned no pid" }
    }
    const logFn = opts.log ?? defaultLog
    logFn(`spawned ${label} daemon lifecycle owner (pid=${pid})`)
    return { ok: true, pid }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const logFn = opts.log ?? defaultLog
    logFn(`${label} daemon spawn failed: ${msg}`)
    return { ok: false, error: msg }
  }
}

function defaultLog(msg: string): void {
  // Routed through loggily so hook contexts can suppress + redirect via
  // `setSuppressConsole(true)` + `addWriter({ ns: "tribe:*" }, …)`.
  // Never write to stderr/stdout directly — see file-top docstring.
  autostartLog.info?.(msg)
}

// ---------------------------------------------------------------------------
// Orchestration — "if configured and daemon dead, spawn"
// ---------------------------------------------------------------------------

export type EnsureDaemonDeps = {
  /** Override the config lookup (test hook). */
  resolveMode?: () => TribeAutostart
  /** Override the socket-path resolver (test hook). */
  resolveSocketPath?: () => string
  /** Override the liveness probe (test hook). */
  probe?: (socketPath: string) => Promise<boolean>
  /** Override the spawner (test hook). */
  spawn?: (opts: { socketPath: string }) => SpawnResult
  /** Override the logger (test hook). */
  log?: (msg: string) => void
  /** Hard overall budget in ms (default 300ms). */
  budgetMs?: number
}

export type EnsureDaemonOutcome =
  | { action: "noop"; reason: "library-mode" | "never-mode" | "env-override" | "already-alive" }
  | { action: "spawned"; pid: number }
  | { action: "spawn-failed"; error: string }
  | { action: "timed-out" }

/**
 * Ensure the unified tribe daemon is alive. Probes the socket; if dead and
 * mode=daemon, detaches a stable standalone owner which starts the daemon as
 * its child. Returns quickly — the whole operation is bounded by `budgetMs`
 * (default 300ms) so it can never delay a hook. Never throws.
 */
export async function ensureTribeDaemonIfConfigured(deps: EnsureDaemonDeps = {}): Promise<EnsureDaemonOutcome> {
  const budgetMs = deps.budgetMs ?? 300
  const deadline = Date.now() + budgetMs

  const mode = (deps.resolveMode ?? resolveAutostart)()
  if (mode === "library") {
    // TRIBE_NO_DAEMON=1 collapses to this too via resolveAutostart's env check.
    return {
      action: "noop",
      reason: process.env.TRIBE_NO_DAEMON === "1" ? "env-override" : "library-mode",
    }
  }
  if (mode === "never") return { action: "noop", reason: "never-mode" }

  // mode === "daemon"
  const socketPath = (deps.resolveSocketPath ?? resolveTribeSocketPath)()

  const probe = deps.probe ?? ((p: string) => isDaemonAlive(p, Math.max(50, Math.min(200, deadline - Date.now()))))
  let alive = false
  try {
    alive = await probe(socketPath)
  } catch {
    alive = false
  }

  if (alive) return { action: "noop", reason: "already-alive" }

  if (Date.now() >= deadline) return { action: "timed-out" }

  const spawnFn = deps.spawn ?? ((o: { socketPath: string }) => spawnTribeDaemonDetached({ ...o, log: deps.log }))
  const result = spawnFn({ socketPath })
  if (result.ok) return { action: "spawned", pid: result.pid }
  return { action: "spawn-failed", error: result.error }
}
