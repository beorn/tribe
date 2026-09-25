/**
 * `daemon.ts hook <event>` entry routing — the command `tribe install`
 * plants in ~/.claude/settings.json. A hook invocation must dispatch and
 * exit without booting the daemon pipe (no socket bind, no broker).
 *
 * @failure  A forced hook exit can discard bytes already queued on stdout or
 *           stderr, causing Claude Code to observe truncated hook output.
 * @level     l4 — real hook process with both output pipes consumed.
 * @consumer  The Bash pipe readers delay consumption before collecting
 *            bytes, leaving the child to exercise its exit-time completion.
 */

import { describe, expect, test } from "vitest"
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { tryAcquireFlock } from "@bearly/flock"
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
    INJECTION_DEBUG_LOG: join(base, "injection-debug.jsonl"),
    TRIBE_SOCKET: join(base, "absent.sock"),
    TRIBE_NO_AUTOSTART: "1",
    TRIBE_NO_DAEMON: "1",
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
      // The shell owns delayed OS-pipe readers. Bun 1.3.x can prebuffer
      // Node child streams even while paused, which hides the undrained control.
      const child = spawn(
        "bash",
        [
          "-c",
          `
        exec 3> >(sleep 1; exec cat)
        out_reader=$!
        exec 4> >(sleep 1; exec cat >&2)
        err_reader=$!
        "$@" <&0 >&3 2>&4 &
        cli=$!
        exec 3>&- 4>&-
        trap 'trap "" TERM; kill -TERM -- -$$; wait "$cli" "$out_reader" "$err_reader"; exit 124' TERM
        wait "$cli"
        code=$?
        wait "$out_reader" "$err_reader"
        exit "$code"
      `,
          "hook-pipe",
          process.execPath,
          "-e",
          script,
        ],
        {
          cwd: base,
          env: hermeticEnv(base),
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        },
      )
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", resolve)
      })
      let timedOut = false
      const deadline = setTimeout(() => {
        timedOut = true
        child.kill("SIGTERM")
      }, 15_000)
      const hardDeadline = setTimeout(() => {
        if (child.pid) process.kill(-child.pid, "SIGKILL")
      }, 16_000)
      let stdout = ""
      let stderr = ""
      let exitCode: number | null
      try {
        child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk))
        child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk))
        child.stdin.end(input)
        exitCode = await exited
      } finally {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
          await exited
        } finally {
          clearTimeout(deadline)
          clearTimeout(hardDeadline)
        }
      }
      expect(timedOut, "hook child exceeded its 15-second parent deadline").toBe(false)
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

  // A burst of prompts puts every loser of the index-writer lock here: the
  // flush of ~15 queued tribe channel messages on 2026-09-16 ~14:10 PDT made
  // Claude Code print `UserPromptSubmit hook error — Failed with non-blocking
  // status code: No stderr output` once per message. Enrichment is optional,
  // so contention must succeed without context rather than fail mutely.
  test("hook prompt survives a held index-writer lock and never exits mute", () => {
    const base = mkdtempSync(join(tmpdir(), "tribe-hook-busy-"))
    const dbPath = join(base, "session-index.db")
    writeFileSync(dbPath, "")
    mkdirSync(join(base, "project"), { recursive: true })
    writeFileSync(join(base, "project", "CLAUDE.md"), "# hermetic project\n")

    // Hold the writer the hook wants, exactly as a competing process would.
    using held = tryAcquireFlock(`${realpathSync(dbPath)}.rebuild.lock`, {
      body: JSON.stringify({ startedAt: Date.now() }),
    })
    expect(held, "test must own the rebuild lock before the hook runs").not.toBeNull()

    const prompt = [
      '<channel source="plugin:tribe:tribe" from="@chief" type="response" message_id="0204b343-1111-2222-3333-444455556666">',
      "DONE: 24141 and 24050 are closed as STATE 8bd94f2337 — the fixture beads are green on main",
      "and the run journal header landed with them. No further action needed from your side.",
      "</channel>",
    ].join("\n")

    const res = spawnSync(process.execPath, [DAEMON, "hook", "prompt"], {
      env: {
        ...hermeticEnv(base),
        RECALL_DB_PATH: dbPath,
        CLAUDE_PROJECT_DIR: join(base, "project"),
      },
      input: `${JSON.stringify({ session_id: "busy-lock-probe", cwd: base, prompt })}\n`,
      timeout: 30_000,
      encoding: "utf8",
    })

    expect(res.status, `hook stderr: ${res.stderr}`).toBe(0)
    // Whatever a future failure is, it must name itself: a nonzero exit with
    // an empty stderr is the defect this test exists to keep out.
    if (res.status !== 0) expect(res.stderr.trim()).not.toBe("")
  })

  // NO SILENT ERRORS. The hook process muzzles loggily's console sink, so a
  // nonzero exit that only logs reaches the operator as
  // `Failed with non-blocking status code: No stderr output` and the reason
  // dies with the process. Every failing exit names the hook and the reason.
  test("hook prompt that genuinely fails says why on stderr", () => {
    const base = mkdtempSync(join(tmpdir(), "tribe-hook-loud-"))
    const res = spawnSync(process.execPath, [DAEMON, "hook", "prompt"], {
      env: hermeticEnv(base),
      input: "not-json\n",
      timeout: 30_000,
      encoding: "utf8",
    })
    expect(res.status).toBe(1)
    expect(res.stderr).toContain("tribe hook prompt:")
    expect(res.stderr).toContain("invalid JSON on stdin")
  })

  // 25392: The prompt hook writes [recall] debug lines to its stderr on every prompt that reaches recall.
  // The prompt hook's stderr must be empty on a prompt that reaches recall, in the recall Worker and hook thread alike.
  test("hook prompt stderr is empty on a prompt that reaches recall, in the worker and hook thread alike (25392)", () => {
    const base = mkdtempSync(join(tmpdir(), "tribe-hook-recall-stderr-"))
    const dbPath = join(base, "recall.db")
    mkdirSync(join(base, "project"), { recursive: true })
    writeFileSync(join(base, "project", "CLAUDE.md"), "# test project\n")

    const prompt = "why does src/lib/inject-core.ts stall the prompt hook past thirty seconds tonight?"

    // Worker path: real hook invocation spawning the recall Worker via createDeadlineRecall
    const res = spawnSync(process.execPath, [DAEMON, "hook", "prompt"], {
      env: {
        ...hermeticEnv(base),
        RECALL_DB_PATH: dbPath,
        CLAUDE_PROJECT_DIR: join(base, "project"),
      },
      input: `${JSON.stringify({ session_id: "recall-stderr-probe", cwd: base, prompt })}\n`,
      timeout: 30_000,
      encoding: "utf8",
    })

    expect(res.status, `hook stderr: ${res.stderr}`).toBe(0)
    expect(res.stderr).toBe("")

    // Hook-thread path: hookRecall invoked directly with muzzled console sink
    const inThreadScript = `
      import { muzzleHookProcess } from ${JSON.stringify(resolve(import.meta.dirname, "hook-dispatch.ts"))};
      import { hookRecall } from ${JSON.stringify(resolve(import.meta.dirname, "../../../recall/src/history/recall.ts"))};
      await muzzleHookProcess();
      await hookRecall(${JSON.stringify(prompt)});
    `
    const inThreadRes = spawnSync(process.execPath, ["-e", inThreadScript], {
      env: {
        ...hermeticEnv(base),
        RECALL_DB_PATH: dbPath,
        CLAUDE_PROJECT_DIR: join(base, "project"),
      },
      timeout: 30_000,
      encoding: "utf8",
    })

    expect(inThreadRes.status, `in-thread stderr: ${inThreadRes.stderr}`).toBe(0)
    expect(inThreadRes.stderr).toBe("")
  })
})
