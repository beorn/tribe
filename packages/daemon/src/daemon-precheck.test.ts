/**
 * `daemon.ts --precheck` — the safe-reload admission contract (@ag/tribe/20703).
 *
 * The invariant under test: the precheck flag exits 0 AFTER the full daemon
 * module graph loads and BEFORE any production state is touched — no DB open
 * (withDatabase), no socket bind (withSocketServer), no migrations, no
 * plugins. withHotReload runs exactly this against the on-disk source before
 * every re-exec; if these tests break, a broken candidate could replace a
 * working daemon (or the precheck could corrupt production state).
 *
 * Everything runs against a temp dir via TRIBE_DB / TRIBE_SOCKET — never the
 * production ~/.local/share/tribe paths.
 */

import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { runAdmissionPrecheck } from "tribe-wire/lib/hot-reload"

const DAEMON_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "daemon.ts")

describe("daemon.ts --precheck", () => {
  let dir: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tribe-daemon-precheck-"))
    env = {
      ...process.env,
      TRIBE_DB: join(dir, "tribe.db"),
      TRIBE_SOCKET: join(dir, "tribe.sock"),
      TRIBE_NO_PLUGINS: "1",
      TRIBE_NO_AUTORELOAD: "1",
    }
    delete env.__TRIBE_RELOAD_VERIFY
    delete env.__TRIBE_RELOAD_FROM_SHA
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("exits 0 via the precheck branch and creates NO state files (no DB, no WAL, no socket)", async () => {
    // Manual spawn so stdout is observable: the marker proves the PRECHECK
    // branch exited (a fully-booted daemon would run forever and time out;
    // some other early exit-0 path would not print the marker).
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [DAEMON_ENTRY, "--precheck"], {
        stdio: ["ignore", "pipe", "pipe"],
        env,
      })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()))
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()))
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000)
      child.on("close", (code) => {
        clearTimeout(timer)
        resolve({ code, stdout, stderr })
      })
    })

    expect(result.stdout).toContain("tribe-daemon precheck ok")
    expect(result.code).toBe(0)
    // THE INVARIANT: precheck touches zero production state.
    expect(existsSync(join(dir, "tribe.db"))).toBe(false)
    expect(existsSync(join(dir, "tribe.db-wal"))).toBe(false)
    expect(existsSync(join(dir, "tribe.sock"))).toBe(false)
    expect(readdirSync(dir)).toEqual([]) // nothing else either
  }, 40_000)

  it("runAdmissionPrecheck (the production gate path) admits the real daemon entry", async () => {
    const res = await runAdmissionPrecheck({ entry: DAEMON_ENTRY, timeoutMs: 30_000, env })
    expect(res.ok).toBe(true)
    expect(res.code).toBe(0)
    expect(res.timedOut).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  }, 40_000)
})
