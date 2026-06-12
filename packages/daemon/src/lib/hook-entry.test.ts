/**
 * `daemon.ts hook <event>` entry routing — the command `tribe install`
 * plants in ~/.claude/settings.json. A hook invocation must dispatch and
 * exit without booting the daemon pipe (no socket bind, no broker).
 */

import { describe, expect, test } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const DAEMON = resolve(import.meta.dirname, "../daemon.ts")

function hermeticEnv(base: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: join(base, "home"),
    XDG_RUNTIME_DIR: join(base, "run"),
    XDG_DATA_HOME: join(base, "data"),
    XDG_CONFIG_HOME: join(base, "config"),
    XDG_STATE_HOME: join(base, "state"),
    TRIBE_RECALL_ENGINE_DIR: undefined,
    DEBUG: undefined,
    DEBUG_LOG: undefined,
  } as NodeJS.ProcessEnv
}

describe("daemon.ts hook entry", () => {
  test("unknown event exits 2 with a loud message and boots nothing", () => {
    const base = mkdtempSync(join(tmpdir(), "tribe-hook-entry-"))
    const res = spawnSync(process.execPath, [DAEMON, "hook", "nonsense"], {
      env: hermeticEnv(base),
      timeout: 15_000,
      encoding: "utf8",
    })
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('unknown event "nonsense"')
  })

  test("hook prompt with empty stdin exits 0 and does not bind a daemon socket", () => {
    const base = mkdtempSync(join(tmpdir(), "tribe-hook-entry-"))
    const res = spawnSync(process.execPath, [DAEMON, "hook", "prompt"], {
      env: hermeticEnv(base),
      input: "{}\n",
      timeout: 30_000,
      encoding: "utf8",
    })
    expect(res.status).toBe(0)
    // No broker boot: the hermetic runtime dir gained no tribe socket.
    let entries: string[] = []
    try {
      entries = readdirSync(join(base, "run"))
    } catch {
      // Directory never created — equally proves no socket was bound.
    }
    expect(entries.filter((e) => e.endsWith(".sock"))).toEqual([])
  })
})
