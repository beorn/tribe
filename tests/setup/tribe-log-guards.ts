/**
 * Pin tribe's two HOME-fallback log paths for any suite that runs this component's
 * tests (@i/17-test-system/25264).
 *
 * activityLogPath() (packages/daemon/src/lib/activity-log.ts) and
 * daemonStderrLogPath() (packages/wire/src/lib/daemon-stderr-log.ts) fall back to a
 * dated file under the caller's HOME when TRIBE_ACTIVITY_LOG / TRIBE_DAEMON_STDERR_LOG
 * are unset. Tribe's own vitest config loads this module from tmpdir-redirect.ts, after
 * it redirects TMPDIR; the root suite's `vendor` project runs the same test files and
 * loads it through tools/test-tribe-log-setup.ts, because without it every injection
 * emit and every spawn of the standalone supervisor wrote into the HOME that suite
 * pins — `activity-*.jsonl` and `daemon-stderr-*.log` under `.local/share/tribe/`.
 *
 * Not "off": a test that asserts on a log's own content still needs a real file to
 * read back, so the default points at a hermetic one. Explicit always wins — a test
 * that wants its own path (or truly wants logging off) still sets the variable itself.
 */
import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Unique per setup invocation: two workers sharing one file would interleave under each other. */
export function pinTribeLogGuards(): void {
  const guardDir = join(tmpdir(), "tribe-log-guard", randomUUID())
  mkdirSync(guardDir, { recursive: true })
  if (!process.env.TRIBE_DAEMON_STDERR_LOG) {
    process.env.TRIBE_DAEMON_STDERR_LOG = join(guardDir, "daemon-stderr.log")
  }
  if (!process.env.TRIBE_ACTIVITY_LOG) {
    process.env.TRIBE_ACTIVITY_LOG = join(guardDir, "activity.jsonl")
  }
}

/**
 * The two names this module pins. A test that builds a child environment by
 * dropping every TRIBE_* name must carry these back: they name fixture paths, not
 * live state, and a child without them falls back to the HOME it runs in.
 */
export const TRIBE_LOG_GUARD_ENV = ["TRIBE_ACTIVITY_LOG", "TRIBE_DAEMON_STDERR_LOG"] as const

/** Re-apply the pins to a child environment that was filtered of ambient TRIBE_* state. */
export function carryTribeLogPins(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const name of TRIBE_LOG_GUARD_ENV) {
    const pinned = process.env[name]
    if (pinned !== undefined) env[name] = pinned
  }
  return env
}
