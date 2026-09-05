/**
 * Daemon-stderr tee path for the standalone supervisor.
 *
 * The standalone supervisor (standalone-supervisor.ts) forwards the daemon
 * child's stderr onward to its OWN stderr — the supervisor's file header
 * explains why: it is the only witness to why a daemon generation died. But
 * when `tribe restart` detaches the supervisor from a terminal (parent pid 1),
 * that forwarded stderr lands on /dev/null, so the daemon's only log —
 * including plugin warnings like the github plugin's late-events line,
 * @ag/tribe/24154 — is discarded on the floor. @ag/tribe/24159.
 *
 * This module names where the supervisor ALSO tees that stream: a dated file
 * beside the tribe activity log, so the log survives regardless of what the
 * supervisor's own forwarded stderr reached, and `tribe doctor` can name the
 * file on disk for an operator to read after a restart.
 *
 * Path: $TRIBE_DAEMON_STDERR_LOG (literal, verbatim, no rotation) if set,
 * mirroring $TRIBE_ACTIVITY_LOG's override contract in
 * ../../../daemon/src/lib/activity-log.ts — else a dated file
 * (`daemon-stderr-YYYY-MM-DD.log`) under activityLogDir().
 */

import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { activityLogDir } from "../activity-log-contract.ts"

/** Date-stamped filename for the daemon-stderr tee, mirroring activity-*.jsonl naming. */
export function daemonStderrLogFilename(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `daemon-stderr-${year}-${month}-${day}.log`
}

/**
 * Return today's daemon-stderr tee path. `TRIBE_DAEMON_STDERR_LOG=<path>`
 * override returns the literal path verbatim (no rotation) — tests pin to
 * one tmp file this way instead of touching the real activity-log dir.
 */
export function daemonStderrLogPath(now: Date = new Date()): string {
  const override = process.env.TRIBE_DAEMON_STDERR_LOG
  if (override) return override
  return join(activityLogDir(), daemonStderrLogFilename(now))
}

export interface DaemonStderrLogDescription {
  path: string
  exists: boolean
  sizeBytes: number | null
}

/**
 * Stat the current daemon-stderr tee file for `tribe doctor` reporting.
 * Never throws — a stat failure (permission, race with rotation) reads as
 * "not yet created" rather than crashing the doctor command.
 */
export function describeDaemonStderrLog(now: Date = new Date()): DaemonStderrLogDescription {
  const path = daemonStderrLogPath(now)
  try {
    if (!existsSync(path)) return { path, exists: false, sizeBytes: null }
    return { path, exists: true, sizeBytes: statSync(path).size }
  } catch {
    return { path, exists: false, sizeBytes: null }
  }
}
