/**
 * `tribe-wire` CLI smoke tests — covers the Commander dispatcher post Phase A.2
 * round 1 wiring. Verifies help surface, exit codes, the addHelpText MCP-adapter
 * hint, and unknown-command rejection. End-to-end daemon behavior is exercised
 * by daemon/package integration tests; per-family verb registration is
 * covered by tests/cli-{read,send}.test.ts.
 *
 * Bead: @km/bearly/19231-tribe-cli-unify-phase-a2-verbs (round 1).
 */

import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../src/cli.ts")
const BUN_BIN = process.env.BUN_EXECUTABLE ?? "bun"

// Strip ANSI SGR sequences (Commander colorizes its help output, which
// breaks word-boundary regex like /\bsend\b/ because the byte before "s"
// is the "m" terminator of a color escape — a word character.
function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

function runCli(args: string[], opts: { timeoutMs?: number } = {}): { stdout: string; stderr: string; code: number } {
  const res = spawnSync(BUN_BIN, [CLI, ...args], {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 5000,
    env: { ...process.env, TRIBE_NO_AUTOSTART: "1" },
  })
  return {
    stdout: stripAnsi(res.stdout ?? ""),
    stderr: stripAnsi(res.stderr ?? ""),
    code: res.status ?? -1,
  }
}

describe("tribe-wire CLI — Commander dispatcher", () => {
  it("--help prints the Commands list + MCP-adapter hint and exits 0", () => {
    const { stdout, code } = runCli(["--help"])
    expect(code).toBe(0)
    expect(stdout).toMatch(/tribe-wire CLI/)
    expect(stdout).toMatch(/Commands:/)
    // A few canonical verbs from each registered family are visible.
    expect(stdout).toMatch(/\bstatus\b/)
    expect(stdout).toMatch(/\bsend\b/)
    expect(stdout).toMatch(/\bretro\b/)
    // addHelpText footer documents the argv-forwarded mcp subcommand.
    expect(stdout).toMatch(/MCP adapter \(argv-forwarded/)
    expect(stdout).toMatch(/tribe-wire mcp \[--name X/)
  })

  it("-h is equivalent to --help", () => {
    const { stdout, code } = runCli(["-h"])
    expect(code).toBe(0)
    expect(stdout).toMatch(/tribe-wire CLI/)
    expect(stdout).toMatch(/Commands:/)
  })

  it("bare `help` prints help and exits 0", () => {
    const { stdout, code } = runCli(["help"])
    expect(code).toBe(0)
    expect(stdout).toMatch(/Commands:/)
  })

  it("no args prints help and exits with Commander's usage code", () => {
    // Commander exits 1 on missing-required-command (vs 0 on explicit --help),
    // and routes the help text to STDERR (not stdout) in this code path.
    const { stderr, code } = runCli([])
    expect(code).toBe(1)
    expect(stderr).toMatch(/Usage:/)
  })

  it("unknown subcommand surfaces an error and exits non-zero", () => {
    const { stderr, code } = runCli(["bogus-not-a-real-subcommand"])
    expect(code).not.toBe(0)
    // Commander's exact phrasing: "error: unknown command 'X'"
    expect(stderr).toMatch(/unknown command 'bogus-not-a-real-subcommand'/)
  })

  it("mcp subcommand is argv-forwarded (NOT dispatched as unknown command)", () => {
    // mcp tries to connect to a daemon. With TRIBE_NO_AUTOSTART=1 and no
    // running daemon, it will fail to connect — but the failure must NOT be
    // Commander's "unknown command 'mcp'" path. We give it a short timeout
    // to avoid hanging on the stdio MCP loop.
    const res = runCli(["mcp", "--name", "@test/cli-smoke", "--socket", "/tmp/tribe-non-existent-socket.sock"], {
      timeoutMs: 2000,
    })
    expect(res.stderr).not.toMatch(/unknown command 'mcp'/)
  })

  it("mcp subcommand keeps stdout JSON-only and captures startup diagnostics in DEBUG_LOG", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "tribe-wire-mcp-stdout-"))
    const debugLog = resolve(dir, "debug.log")
    try {
      const res = spawnSync(BUN_BIN, [CLI, "mcp", "--name", "@test/cli-log", "--socket", "/tmp/no-tribe.sock"], {
        encoding: "utf8",
        timeout: 1000,
        env: {
          ...process.env,
          DEBUG_LOG: debugLog,
          LOG_FORMAT: "json",
          LOG_LEVEL: "info",
          TRIBE_NO_AUTOSTART: "1",
        },
      })

      expect(stripAnsi(res.stdout ?? "")).not.toMatch(/tribe:stdio-adapter|Connecting to daemon|INFO/)
      const log = readFileSync(debugLog, "utf8")
      expect(log).toContain('"name":"tribe:stdio-adapter"')
      expect(log).toContain("Connecting to daemon at /tmp/no-tribe.sock")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("mcp subcommand can stream loggily diagnostics to stderr via DEBUG_LOG=/dev/stderr", () => {
    const res = spawnSync(BUN_BIN, [CLI, "mcp", "--name", "@test/cli-stderr", "--socket", "/tmp/no-tribe.sock"], {
      encoding: "utf8",
      timeout: 1000,
      env: {
        ...process.env,
        DEBUG_LOG: "/dev/stderr",
        LOG_FILE: "/dev/stderr",
        LOG_FORMAT: "json",
        LOG_LEVEL: "info",
        TRIBE_NO_AUTOSTART: "1",
      },
    })

    expect(stripAnsi(res.stdout ?? "")).not.toMatch(/tribe:stdio-adapter|Connecting to daemon|INFO/)
    expect(res.stderr ?? "").toContain('"name":"tribe:stdio-adapter"')
    expect(res.stderr ?? "").toContain("Connecting to daemon at /tmp/no-tribe.sock")
  })
})
