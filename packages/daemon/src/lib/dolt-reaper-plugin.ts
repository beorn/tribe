//
// Tribe plugin: orphan dolt sql-server reaper.
//
// Problem: `bd` spawns `dolt sql-server` daemons that reparent to launchd
// (PID 1) and outlive the session that started them. When a worktree is
// removed by anything other than `bun worktree remove` (raw `git worktree
// remove`, session crash, `rm -rf`, bd-side removal that doesn't kill its
// own daemon), the dolt server lives on forever — cwd pointing at a
// deleted directory, zero clients, contributing to `.git/index.lock`
// contention and health-monitor noise.
//
// Fix: periodically check every `dolt sql-server` process's cwd. If the
// cwd path no longer exists on disk (detected either via lsof's "(deleted)"
// marker or a direct existsSync check), the daemon is a confirmed orphan
// and can be reaped. SIGTERM first, SIGKILL after a short grace for any
// straggler.
//
// Runs once on daemon boot (catches leftover orphans from before the
// daemon started) and then every 30 minutes.
//
// What this does NOT do:
//   - Kill dolt servers whose cwd still exists. A daemon with a live cwd
//     and no current client may just be idle-between-requests; killing it
//     would cause the next `bd` invocation to re-spawn (wasteful but
//     harmless) or, worse, race with an active-but-momentarily-quiet
//     session. Path-exists is the definitive safe signal.
//   - Handle non-dolt daemons (node/bun zombies are a separate concern).
//

import { execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { createLogger } from "loggily"
import { createTimers } from "./timers.ts"
import type { TribePluginApi, TribeClientApi } from "./plugin-api.ts"

const log = createLogger("tribe:dolt-reaper")

const REAP_INTERVAL_MS = 30 * 60 * 1000 // 30 min
const TERM_GRACE_MS = 1500

interface DoltServerInfo {
  pid: number
  cwd: string | null
  cwdExists: boolean
  cwdDeletedMarker: boolean
}

/**
 * List every dolt sql-server process and its resolved cwd + liveness state.
 * Exported for testing.
 */
export function inspectDoltServers(): DoltServerInfo[] {
  let pgrepOut = ""
  try {
    pgrepOut = execSync(`pgrep -f "dolt sql-server"`, { encoding: "utf8" }).toString()
  } catch {
    // silent-fallback-allow: pgrep exits non-zero when nothing matches, which means no dolt servers.
    return []
  }
  const pids = pgrepOut
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => parseInt(p, 10))
    .filter((p) => !Number.isNaN(p))

  const infos: DoltServerInfo[] = []
  for (const pid of pids) {
    let cwdOut = ""
    try {
      cwdOut = execSync(`lsof -p ${pid} -a -d cwd 2>/dev/null`, { encoding: "utf8" }).toString()
    } catch {
      // lsof failed (process disappeared, permission denied). Skip — we
      // cannot confirm orphan status, so we don't reap.
      continue
    }
    const info = parseLsofCwd(pid, cwdOut)
    infos.push(info)
  }
  return infos
}

/**
 * Parse `lsof -p <pid> -a -d cwd` output for the cwd path and deleted marker.
 * Exported for testing.
 *
 * Example lsof output (2nd line is the cwd row):
 *   COMMAND   PID  USER   FD   TYPE DEVICE ... NAME
 *   dolt    12345 beorn  cwd    DIR    1,16 ... /path/to/.beads/dolt
 *
 * When the directory has been deleted but the daemon still holds the cwd,
 * lsof appends " (deleted)" to the NAME column.
 */
export function parseLsofCwd(pid: number, lsofOutput: string): DoltServerInfo {
  const line = lsofOutput
    .split("\n")
    .slice(1) // skip header
    .find((l) => /\bcwd\b/.test(l))
  if (!line) return { pid, cwd: null, cwdExists: false, cwdDeletedMarker: false }

  // lsof's NAME column is everything after the device column. Paths can
  // contain spaces; " (deleted)" is the marker we care about. Conservative
  // extraction: find the first "/" and take the rest up to optional marker.
  const slashIdx = line.indexOf("/")
  if (slashIdx < 0) return { pid, cwd: null, cwdExists: false, cwdDeletedMarker: false }
  let rawPath = line.slice(slashIdx).trim()
  let cwdDeletedMarker = false
  if (rawPath.endsWith("(deleted)")) {
    cwdDeletedMarker = true
    rawPath = rawPath.replace(/\s*\(deleted\)\s*$/, "").trim()
  }
  const cwdExists = existsSync(rawPath)
  return { pid, cwd: rawPath, cwdExists, cwdDeletedMarker }
}

/**
 * Given a DoltServerInfo, should we reap it?
 * Exported for testing.
 */
export function isOrphan(info: DoltServerInfo): boolean {
  // Orphan if lsof explicitly marks the cwd as deleted, or the path no
  // longer exists. Either signal is sufficient — path-exists is the
  // definitive check; the marker is a fast fallback.
  if (info.cwdDeletedMarker) return true
  if (info.cwd && !info.cwdExists) return true
  return false
}

/** Single-pid identity probes used to re-verify a process immediately before
 *  signaling it. Injectable for tests; the default shells out like the scan. */
export interface DoltIncarnationProbe {
  /** Full argv of the process (`ps -p <pid> -o command=`); null when gone. */
  command(pid: number): string | null
  /** Fresh single-pid rescan of the lsof cwd row; null when uninspectable. */
  cwd(pid: number): DoltServerInfo | null
}

const liveProbe: DoltIncarnationProbe = {
  command(pid) {
    try {
      const out = execSync(`ps -p ${pid} -o command=`, { encoding: "utf8" }).toString().trim()
      return out.length > 0 ? out : null
    } catch {
      // silent-fallback-allow: ps exits non-zero when the pid is gone — that is the fact being probed.
      return null
    }
  },
  cwd(pid) {
    try {
      const out = execSync(`lsof -p ${pid} -a -d cwd 2>/dev/null`, { encoding: "utf8" }).toString()
      return parseLsofCwd(pid, out)
    } catch {
      // silent-fallback-allow: lsof exits non-zero when the pid is gone/uninspectable — the caller treats null as "refuse to signal".
      return null
    }
  },
}

export type IncarnationVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly gone: boolean; readonly reason: string }

/**
 * Incarnation re-verification before each signal (21441). Between the
 * pgrep/lsof scan and the SIGTERM — and again across the 1.5s SIGKILL grace —
 * the OS can recycle a reaped pid onto an unrelated process. Re-check that the
 * pid still runs a `dolt sql-server` with the same, still-orphaned cwd
 * immediately before signaling; refuse on any mismatch. Exported for testing.
 */
export function verifyOrphanIncarnation(
  expected: DoltServerInfo,
  probe: DoltIncarnationProbe = liveProbe,
): IncarnationVerdict {
  const command = probe.command(expected.pid)
  if (command === null) return { ok: false, gone: true, reason: `pid ${expected.pid} is gone` }
  if (!command.includes("dolt sql-server")) {
    return { ok: false, gone: false, reason: `pid ${expected.pid} was recycled to '${command}' — refusing to signal` }
  }
  const fresh = probe.cwd(expected.pid)
  if (fresh === null || fresh.cwd === null) {
    return { ok: false, gone: false, reason: `pid ${expected.pid} cwd is no longer inspectable — refusing to signal` }
  }
  if (fresh.cwd !== expected.cwd) {
    return {
      ok: false,
      gone: false,
      reason: `pid ${expected.pid} cwd moved ${expected.cwd} -> ${fresh.cwd} — refusing to signal`,
    }
  }
  if (!isOrphan(fresh)) {
    return { ok: false, gone: false, reason: `pid ${expected.pid} cwd ${fresh.cwd} exists again — no longer an orphan` }
  }
  return { ok: true }
}

export interface ReapResult {
  scanned: number
  orphans: number
  killed: number
  /** Orphans NOT signaled because the pre-signal re-verification refused. */
  skipped: number
}

/** Injectable process effects; production callers pass nothing. */
export interface ReaperDeps {
  readonly probe?: DoltIncarnationProbe
  readonly inspect?: () => DoltServerInfo[]
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void
  readonly scheduleEscalation?: (fn: () => void, delayMs: number) => void
}

export function reapOrphanDoltServers(deps: ReaperDeps = {}): ReapResult {
  const probe = deps.probe ?? liveProbe
  const inspect = deps.inspect ?? inspectDoltServers
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal))
  const scheduleEscalation =
    deps.scheduleEscalation ??
    ((fn: () => void, delayMs: number) => {
      globalThis.setTimeout(fn, delayMs)
    })

  const servers = inspect()
  const orphans = servers.filter(isOrphan)

  const termed: DoltServerInfo[] = []
  let skipped = 0
  for (const o of orphans) {
    const verdict = verifyOrphanIncarnation(o, probe)
    if (!verdict.ok) {
      skipped++
      if (verdict.gone) log.info?.(`orphan dolt pid=${o.pid} exited before SIGTERM`)
      else log.warn?.(`skip reap: ${verdict.reason}`)
      continue
    }
    try {
      kill(o.pid, "SIGTERM")
      termed.push(o)
      log.info?.(`reaped orphan dolt pid=${o.pid} cwd=${o.cwd} deleted=${o.cwdDeletedMarker}`)
    } catch {
      // already gone / permission — ignore
    }
  }

  if (termed.length > 0) {
    // Schedule the SIGKILL escalation for 1.5s later — we don't need it
    // in the same tick and a synchronous sleep would block the daemon.
    scheduleEscalation(() => {
      for (const o of termed) {
        const verdict = verifyOrphanIncarnation(o, probe)
        if (!verdict.ok) {
          // gone = SIGTERM did its job; anything else is a recycled/changed
          // pid — either way SIGKILL must not fire.
          if (!verdict.gone) log.warn?.(`skip SIGKILL: ${verdict.reason}`)
          continue
        }
        try {
          kill(o.pid, "SIGKILL")
          log.warn?.(`SIGKILL dolt that survived SIGTERM pid=${o.pid}`)
        } catch {
          // already dead — good
        }
      }
    }, TERM_GRACE_MS)
  }

  return { scanned: servers.length, orphans: orphans.length, killed: termed.length, skipped }
}

export const doltReaperPlugin: TribePluginApi = {
  name: "dolt-reaper",

  available() {
    // Only active if `dolt` binary is installed. If not, no servers will
    // ever exist and the reaper is a no-op — disable entirely to keep
    // daemon startup clean.
    try {
      execSync("command -v dolt", { encoding: "utf8" })
      return true
    } catch {
      return false
    }
  },

  start(_api: TribeClientApi) {
    const ac = new AbortController()
    const timers = createTimers(ac.signal)

    // Boot sweep — catches leftover orphans from before the daemon started.
    try {
      const result = reapOrphanDoltServers()
      if (result.orphans > 0) {
        log.info?.(`boot sweep reaped scanned=${result.scanned} orphans=${result.orphans} killed=${result.killed}`)
      }
    } catch (err) {
      log.warn?.(`boot sweep failed: ${err instanceof Error ? err.message : err}`)
    }

    // Periodic sweep every 30 min.
    timers.setInterval(() => {
      try {
        const result = reapOrphanDoltServers()
        if (result.orphans > 0) {
          log.info?.(
            `periodic sweep reaped scanned=${result.scanned} orphans=${result.orphans} killed=${result.killed}`,
          )
        }
      } catch (err) {
        log.warn?.(`periodic sweep failed: ${err instanceof Error ? err.message : err}`)
      }
    }, REAP_INTERVAL_MS)

    return () => ac.abort()
  },
}
