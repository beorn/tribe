/**
 * @ag/tribe/24159 — the standalone supervisor sends the daemon's stderr, the
 * daemon's ONLY log copy, to /dev/null when it runs detached.
 *
 * MEASURED 2026-09-04 on the live fleet: the supervisor pipes the daemon
 * child's stderr and streams it onward to the supervisor's OWN stderr as its
 * log (see standalone-supervisor.ts's file header). When `tribe restart`
 * detaches the supervisor (parent pid 1), that stderr is /dev/null, so every
 * daemon log line is discarded on the floor — no file anywhere receives it.
 *
 * @level l2 — spawns the real supervisor binary with its own stdio fully
 *   ignored (the exact detached shape) and proves the daemon's stderr still
 *   reaches disk via the independent tee file.
 * @consumer runStandaloneSupervisor
 */

import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { beforeAll, describe, expect, it } from "vitest"

const HERE = dirname(fileURLToPath(import.meta.url))
const WIRE_CLI = resolve(HERE, "../src/cli.ts")
const BUN_BIN = process.versions.bun ? process.execPath : "bun"

let fixtures: string

/** Writes known lines to stderr (the github-plugin late-events shape), then exits cleanly. */
const LOGGING_CHILD = [
  `process.stderr.write("daemon: github events: 3 late events after freshness horizon, not broadcast\\n")`,
  `process.stderr.write("daemon: second line proving multi-write append\\n")`,
  `process.exit(0)`,
].join("\n")

beforeAll(() => {
  fixtures = mkdtempSync(join(tmpdir(), "supervisor-daemon-stderr-log-"))
  writeFileSync(join(fixtures, "logging-daemon.ts"), LOGGING_CHILD)
})

/**
 * Run the supervisor with its OWN stdio fully ignored — the exact shape
 * `tribe restart` produces once detached from a terminal (parent pid 1): fd1
 * and fd2 both /dev/null. With nothing piped from the child process itself,
 * only the tee file on disk can prove the daemon's stderr survived.
 */
function runSupervisorWithOwnStdioDiscarded(
  childScript: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 20_000,
): Promise<{ code: number | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(BUN_BIN, [WIRE_CLI, "__standalone-supervisor", "--", childScript], {
      stdio: ["ignore", "ignore", "ignore"],
      env,
    })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      rejectPromise(new Error(`supervisor did not exit within ${timeoutMs}ms`))
    }, timeoutMs)
    child.once("error", (error) => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      resolvePromise({ code })
    })
  })
}

describe("the standalone supervisor tees the daemon's stderr to a file", () => {
  it("writes the daemon's stderr lines to TRIBE_DAEMON_STDERR_LOG even when the supervisor's OWN stderr is discarded", async () => {
    const logPath = join(fixtures, "daemon-stderr-pinned.log")
    const run = await runSupervisorWithOwnStdioDiscarded(join(fixtures, "logging-daemon.ts"), {
      ...process.env,
      TRIBE_DAEMON_STDERR_LOG: logPath,
    })
    expect(run.code).toBe(0)

    // Pre-fix: this file is never created — the child's stderr had nowhere
    // to go but the supervisor's own (here: discarded) stderr, so this
    // readFileSync throws ENOENT.
    const contents = readFileSync(logPath, "utf8")
    expect(contents).toContain("github events: 3 late events after freshness horizon, not broadcast")
    expect(contents).toContain("second line proving multi-write append")
  }, 30_000)
})
