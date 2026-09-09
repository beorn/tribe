/**
 * `daemon.ts hook <event>` entry routing — the command `tribe install`
 * plants in ~/.claude/settings.json. A hook invocation must dispatch and
 * exit without booting the daemon pipe (no socket bind, no broker).
 *
 * @failure  A forced hook exit can discard bytes already queued on stdout or
 *           stderr, causing Claude Code to observe truncated hook output.
 * @level     l4 — real hook process with both output pipes consumed.
 * @consumer  The Bash process substitutions delay each reader before copying
 *            bytes, leaving the child to exercise its exit-time completion.
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
  test.each([
    ["prompt", 0, "{}\n"],
    ["session-start", 0, "{}\n"],
    // cmdHook preserves its invalid-JSON failure status through the drain.
    ["prompt", 1, "not-json\n"],
  ])(
    "terminal hook exit drains both output pipes for %s (status %s)",
    async (event, expectedStatus, input) => {
      const base = mkdtempSync(join(tmpdir(), "tribe-hook-drain-"))
      const size = 1024 * 1024
      const script = `
      process.stdout.write("o".repeat(${size}))
      process.stderr.write("e".repeat(${size}))
      process.argv = [process.execPath, ${JSON.stringify(DAEMON)}, "hook", ${JSON.stringify(event)}]
      await import(${JSON.stringify(DAEMON)})
    `
      // Delayed Bash readers create backpressure while preserving every byte;
      // this tests the observable pipe contract without relying on Bun internals.
      const child = Bun.spawn(
        [
          "bash",
          "-c",
          '"$@" > >(sleep 1; cat) 2> >(sleep 1; cat >&2); child_code=$?; wait; exit "$child_code"',
          "drain-pipe",
          process.execPath,
          "-e",
          script,
        ],
        {
          cwd: base,
          env: hermeticEnv(base),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      child.stdin.write(input)
      child.stdin.end()
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(exitCode).toBe(expectedStatus)
      expect(stdout.length).toBeGreaterThanOrEqual(size)
      expect(stderr.length).toBeGreaterThanOrEqual(size)
      expect(new Bun.CryptoHasher("sha256").update(stdout.slice(0, size)).digest("hex")).toBe(
        new Bun.CryptoHasher("sha256").update("o".repeat(size)).digest("hex"),
      )
      expect(new Bun.CryptoHasher("sha256").update(stderr.slice(0, size)).digest("hex")).toBe(
        new Bun.CryptoHasher("sha256").update("e".repeat(size)).digest("hex"),
      )
    },
    20_000,
  )

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
