/**
 * @failure The standalone supervisor spawned its daemon child with
 *   `stdio: "ignore"`, so the child's stderr — the ONLY copy of why the daemon
 *   refused to start — went to /dev/null. On 2026-08-13 the recovery path sat
 *   for hours on `exit 0` plus a zero-byte log; the real cause only appeared
 *   when the daemon was run bare, outside its supervisor.
 * @level l2 — spawns the real supervisor binary against fixture children.
 * @consumer runStandaloneSupervisor, the lifecycle owner behind connectOrStart.
 *
 * Two independent swallows are pinned here: the discarded stderr, and
 * `finish(code ?? 0)` turning a signal-killed child into a SUCCESS exit.
 */

import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const HERE = dirname(fileURLToPath(import.meta.url))
const WIRE_CLI = resolve(HERE, "../src/cli.ts")
const BUN_BIN = process.versions.bun ? process.execPath : "bun"

let fixtures: string

/** The 2026-08-13 shape: a daemon that throws at module scope, as a plugin load failure does. */
const THROWING_CHILD = `throw new Error(${JSON.stringify(
  "GitHub cursor open failed after inspecting XDG destination /x and legacy source /y: " +
    "adoption changed state while copying the legacy cursor",
)})\n`

/** A child that dies to a signal — the OOM-kill / external-kill shape. */
const SIGNAL_CHILD = [
  `process.stderr.write("daemon: dying to SIGKILL, this text is the cause\\n")`,
  `process.kill(process.pid, "SIGKILL")`,
  `setTimeout(() => {}, 5000)`,
].join("\n")

/** A child that exits cleanly — the no-regression control. */
const CLEAN_CHILD = `process.exit(0)\n`

type SupervisorRun = { code: number | null; signal: NodeJS.Signals | null; stderr: string; stdout: string }

/** Run the supervisor in the FOREGROUND — the swallow lives inside it, not in the detached launcher. */
function runSupervisor(childScript: string, timeoutMs = 20_000): Promise<SupervisorRun> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(BUN_BIN, [WIRE_CLI, "__standalone-supervisor", "--", childScript], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      rejectPromise(new Error(`supervisor did not exit within ${timeoutMs}ms`))
    }, timeoutMs)
    child.once("error", (error) => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.once("exit", (code, signal) => {
      clearTimeout(timer)
      resolvePromise({ code, signal, stderr, stdout })
    })
  })
}

beforeAll(() => {
  fixtures = mkdtempSync(join(tmpdir(), "supervisor-child-failure-"))
  writeFileSync(join(fixtures, "throwing-daemon.ts"), THROWING_CHILD)
  writeFileSync(join(fixtures, "signal-daemon.ts"), SIGNAL_CHILD)
  writeFileSync(join(fixtures, "clean-daemon.ts"), CLEAN_CHILD)
})

afterAll(() => {
  // Fixtures live under the redirected TMPDIR, swept by tests/setup/tmpdir-redirect.ts.
})

describe("standalone supervisor propagates its child's death", () => {
  it("surfaces the child's actual stderr when the daemon throws at startup", async () => {
    const run = await runSupervisor(join(fixtures, "throwing-daemon.ts"))

    // Pre-fix: the supervisor's whole output is empty — the cause went to /dev/null.
    const output = run.stderr + run.stdout
    expect(output).toContain("adoption changed state while copying the legacy cursor")
    // Not a summary — the operator needs the file and line the daemon named.
    expect(output).toContain("XDG destination")
  }, 30_000)

  it("exits nonzero when the child fails to start", async () => {
    const run = await runSupervisor(join(fixtures, "throwing-daemon.ts"))
    expect(run.code).not.toBe(0)
  }, 30_000)

  it("exits NONZERO when the child dies to a signal — the reproduced exit-0 swallow", async () => {
    const run = await runSupervisor(join(fixtures, "signal-daemon.ts"))

    // Pre-fix this is exactly `exit 0` + an empty log: `finish(code ?? 0)` maps a
    // null code (signal death) onto success, so every caller reads the crash as OK.
    expect(run.code).not.toBe(0)
    expect(run.stderr + run.stdout).toContain("SIGKILL")
  }, 30_000)

  it("names the child's exit cause in its own words, not just a code", async () => {
    const run = await runSupervisor(join(fixtures, "signal-daemon.ts"))
    expect(run.stderr + run.stdout).toContain("daemon: dying to SIGKILL, this text is the cause")
  }, 30_000)

  it("still exits 0 when the child shuts down cleanly", async () => {
    const run = await runSupervisor(join(fixtures, "clean-daemon.ts"))
    expect(run.code).toBe(0)
  }, 30_000)
})

/**
 * The supervisor is normally launched DETACHED, and a detached process has no
 * terminal to inherit. `spawnStandaloneDaemonSupervisor` passed
 * `stdio: "ignore"`, so everything the supervisor says about a dying daemon —
 * including the fix above — went to /dev/null on the path that actually runs in
 * production. That is the half of the swallow the operator hit: `tribe status`
 * returned promptly, the daemon was gone, and no file anywhere held the cause.
 */
describe("the detached launcher gives the supervisor somewhere to speak", () => {
  it("routes a detached supervisor's output to LOG_FILE when the operator set one", async () => {
    const { spawnStandaloneDaemonSupervisor } = await import("../src/client.ts")
    const logPath = join(fixtures, "detached-supervisor.log")
    const previous = process.env.LOG_FILE
    process.env.LOG_FILE = logPath
    try {
      const child = spawnStandaloneDaemonSupervisor({
        daemonScript: join(fixtures, "throwing-daemon.ts"),
      })
      await new Promise<void>((resolvePromise) => {
        const deadline = Date.now() + 20_000
        const poll = setInterval(() => {
          let contents = ""
          try {
            contents = readFileSync(logPath, "utf8")
          } catch {
            /* not created yet */
          }
          if (contents.includes("adoption changed state") || Date.now() > deadline) {
            clearInterval(poll)
            resolvePromise()
          }
        }, 100)
      })
      try {
        if (child.pid) process.kill(child.pid, "SIGKILL")
      } catch {
        /* already gone — the child fails fast by construction */
      }

      // Pre-fix this file does not exist at all: stdio "ignore" discarded it.
      const contents = readFileSync(logPath, "utf8")
      expect(contents).toContain("adoption changed state while copying the legacy cursor")
    } finally {
      if (previous === undefined) delete process.env.LOG_FILE
      else process.env.LOG_FILE = previous
    }
  }, 30_000)
})
