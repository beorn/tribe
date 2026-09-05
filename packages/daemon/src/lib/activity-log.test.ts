/**
 * @ag/tribe/24159 — pruneOldActivityLogs also sweeps daemon-stderr-*.log.
 *
 * The standalone supervisor's daemon-stderr tee
 * (packages/wire/src/lib/daemon-stderr-log.ts) shares activityLogDir() with
 * the activity-*.jsonl files but was never covered by the daemon's own
 * 30-day retention sweep (daemon.ts calls pruneOldActivityLogs(30) once at
 * startup) — it would have grown one file per day forever. Both dated log
 * families now share one predicate-driven prune pass
 * (isActivityLogFilename / isDaemonStderrLogFilename, each exported next to
 * its filename builder); this proves stale/fresh/unrelated all resolve
 * correctly for both.
 */

import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { pruneOldActivityLogs } from "./activity-log.ts"

let home: string
let dir: string
const previousHome = process.env.HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "activity-log-prune-"))
  dir = join(home, ".local/share/tribe")
  mkdirSync(dir, { recursive: true })
  process.env.HOME = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  safeRemoveSync(home, { within: tmpdir(), allowMissing: true })
})

/** Write a file under the hermetic activity-log dir, backdated by `ageDays` days. */
function writeAged(name: string, ageDays: number, nowMs: number): string {
  const path = join(dir, name)
  writeFileSync(path, "x")
  const seconds = (nowMs - ageDays * 86_400_000) / 1000
  utimesSync(path, seconds, seconds)
  return path
}

describe("pruneOldActivityLogs (both dated log families share one cutoff)", () => {
  test("removes a stale file from EACH family, keeps a fresh one from each, leaves an unrelated name untouched", () => {
    const now = new Date("2026-09-04T12:00:00Z").getTime()
    const staleActivity = writeAged("activity-2026-08-01.jsonl", 34, now)
    const freshActivity = writeAged("activity-2026-09-03.jsonl", 1, now)
    const staleStderr = writeAged("daemon-stderr-2026-08-01.log", 34, now)
    const freshStderr = writeAged("daemon-stderr-2026-09-03.log", 1, now)
    const unrelated = writeAged("tribe.db", 999, now)

    const removed = pruneOldActivityLogs(30, new Date(now))

    expect(removed).toBe(2)
    expect(existsSync(staleActivity)).toBe(false)
    expect(existsSync(staleStderr)).toBe(false)
    expect(existsSync(freshActivity)).toBe(true)
    expect(existsSync(freshStderr)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
  })

  test("missing activity-log dir → 0 removed, no throw", () => {
    safeRemoveSync(dir, { within: home, allowMissing: true })
    expect(pruneOldActivityLogs(30, new Date())).toBe(0)
  })
})
