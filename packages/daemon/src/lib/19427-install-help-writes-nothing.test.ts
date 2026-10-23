/**
 * `daemon.ts install --help` — and its `-h` spelling — must print usage and
 * write nothing. Today the verb parses its arguments with `strict: false` and
 * no `help` option, so `--help` is silently discarded, `dryRun` stays false,
 * and the install is applied: the caller asks what the command does and their
 * machine is changed instead.
 *
 * @failure  A help request applies the install. `tribe install --help` exits 0
 *           having written ~/.claude/settings.json and the autostart config,
 *           so the answer to "what does this do" is a mutated home directory.
 * @level    l4 — a real daemon.ts child process writing to a temporary HOME.
 * @consumer The install verb's parseArgs options in daemon-run.ts.
 * @reach fs-walk <fixture-only: temporary home under tmpdir>
 */

import { describe, expect, test } from "vitest"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const DAEMON = resolve(import.meta.dirname, "../daemon.ts")

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) found.push(...filesUnder(full))
    else found.push(full)
  }
  return found
}

/** A scratch home and config root; the socket points nowhere so nothing dials out. */
function hermeticEnv(base: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: join(base, "home"),
    XDG_CONFIG_HOME: join(base, "config"),
    XDG_DATA_HOME: join(base, "data"),
    XDG_STATE_HOME: join(base, "state"),
    XDG_RUNTIME_DIR: join(base, "run"),
    TRIBE_SOCKET: join(base, "absent.sock"),
  } as NodeJS.ProcessEnv
}

describe("daemon.ts install help", () => {
  test.each([["--help"], ["-h"]])(
    "tribe install %s prints usage, exits 0 and writes nothing",
    (flag) => {
      const base = mkdtempSync(join(tmpdir(), "tribe-install-help-"))
      mkdirSync(join(base, "home"), { recursive: true })

      const result = spawnSync(process.execPath, [DAEMON, "install", flag], {
        cwd: base,
        env: hermeticEnv(base),
        encoding: "utf8",
        timeout: 60_000,
      })
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`

      expect(filesUnder(base), "a help request must create no file").toEqual([])
      expect(result.status, `tribe install ${flag} must exit 0; got:\n${output}`).toBe(0)
      expect(output, "a help request must print usage; the install plan is not usage").toMatch(/\busage\b/i)
    },
  )
})
