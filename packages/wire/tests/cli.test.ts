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
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { resolve, dirname, join } from "node:path"
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

function runCliAsync(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolveRun) => {
    const child = spawn(BUN_BIN, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")))
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")))
    child.on("close", (code) => resolveRun({ stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), code }))
  })
}

describe("tribe-wire CLI — Commander dispatcher", () => {
  it("--help prints the Commands list + MCP-adapter hint and exits 0", () => {
    const { stdout, code } = runCli(["--help"])
    expect(code).toBe(0)
    expect(stdout).toMatch(/tribe-wire CLI/)
    expect(stdout).toMatch(/Commands:/)
    // A few canonical verbs from each registered family are visible.
    expect(stdout).toMatch(/\bstatus\b/)
    expect(stdout).toMatch(/\breload\b/)
    expect(stdout).toMatch(/\bsend\b/)
    expect(stdout).toMatch(/\bretro\b/)
    // addHelpText footer documents the argv-forwarded mcp subcommand.
    expect(stdout).toMatch(/MCP adapter \(argv-forwarded/)
    expect(stdout).toMatch(/tribe-wire mcp \[--name X/)
  })

  it("--version prints `tribe-wire <semver>+<sha>` and exits 0 (20359 identity)", () => {
    const { stdout, code } = runCli(["--version"])
    expect(code).toBe(0)
    expect(stdout.trim()).toMatch(/^tribe-wire \d+\.\d+\.\d+.*\+(?:[0-9a-f]+|unknown)$/)
  })

  it("-h is equivalent to --help", () => {
    const { stdout, code } = runCli(["-h"])
    expect(code).toBe(0)
    expect(stdout).toMatch(/tribe-wire CLI/)
    expect(stdout).toMatch(/Commands:/)
  })

  it("send --help exposes ball-tracker fields", () => {
    const { stdout, code } = runCli(["send", "--help"])
    expect(code).toBe(0)
    expect(stdout).toMatch(/--reply <request_id>/)
    expect(stdout).toMatch(/--request \[request_id\]/)
    expect(stdout).toMatch(/--fanout <mode>/)
  })

  it("send rejects invalid fanout before daemon connection", () => {
    const { stderr, code } = runCli(["send", "@chief", "hello", "--fanout", "many"])
    expect(code).toBe(2)
    expect(stderr).toMatch(/invalid --fanout 'many'/)
  })

  it("pending --close requires an explicit owner for one-shot CLI identity", () => {
    const { stderr, code } = runCli(["pending", "--close", "req-123"])
    expect(code).toBe(2)
    expect(stderr).toMatch(/--close requires --owner/)
  })

  it("pending --help exposes the fleet-wide all-owner attention projection", () => {
    const { stdout, code } = runCli(["pending", "--help"])
    expect(code).toBe(0)
    expect(stdout).toMatch(/--all/)
    expect(stdout).toMatch(/--json/)
    expect(stdout).toMatch(/all owners/i)
  })

  it("pending --all renders every owner and --json preserves the typed snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-wire-pending-all-"))
    const socketPath = join(dir, "tribe.sock")
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
    const snapshot = {
      all: true,
      count: 2,
      owner_count: 2,
      oldest_age_ms: 10_800_000,
      pending: [],
      owners: [
        {
          owner: "@agent/2",
          count: 1,
          oldest_age_ms: 10_800_000,
          pending: [
            {
              request_id: "req-agent-2",
              recipient: "@agent/2",
              sender: "@chief",
              summary: "review immutable carrier",
              opened_at: "2026-07-14T08:00:00.000Z",
              age_ms: 10_800_000,
              message_id: "msg-agent-2",
              fanout: "first",
            },
          ],
        },
        {
          owner: "@ci",
          count: 1,
          oldest_age_ms: 60_000,
          pending: [
            {
              request_id: "req-ci",
              recipient: "@ci",
              sender: "@chief",
              summary: "run focused gate",
              opened_at: "2026-07-14T10:59:00.000Z",
              age_ms: 60_000,
              message_id: "msg-ci",
              fanout: "first",
            },
          ],
        },
      ],
    }
    const server = createServer((socket) => {
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8")
        let newline = buffer.indexOf("\n")
        while (newline >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf("\n")
          if (!line.trim()) continue
          const request = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> }
          calls.push({ method: request.method, params: request.params })
          socket.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { structuredContent: snapshot } })}\n`,
          )
        }
      })
    })

    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen)
        server.listen(socketPath, () => {
          server.off("error", rejectListen)
          resolveListen()
        })
      })
      const env = { ...process.env, TRIBE_SOCKET: socketPath, TRIBE_NO_AUTOSTART: "1" }
      const human = await runCliAsync(["pending", "--all"], env)
      const json = await runCliAsync(["pending", "--all", "--json"], env)

      expect(human).toMatchObject({ code: 0, stderr: "" })
      expect(human.stdout).toContain("2 pending request(s) across 2 owner(s)")
      expect(human.stdout).toContain("@agent/2: 1 (oldest 180m ago)")
      expect(human.stdout).toContain("req-agent-2  from @chief  to @agent/2  review immutable carrier")
      expect(JSON.parse(json.stdout)).toEqual(snapshot)
      expect(calls).toEqual([
        { method: "tribe.pending", params: { all: true } },
        { method: "tribe.pending", params: { all: true } },
      ])
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("21049: read-only diagnostics never register an inherited managed persona", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-wire-diagnostics-"))
    const socketPath = join(dir, "tribe.sock")
    const methods: string[] = []
    const holder = {
      id: "holder-session",
      name: "@chief",
      role: "member",
      domains: ["coordination"],
      pid: 4242,
      claudeSessionId: null,
      connectedAt: Date.now(),
      uptimeMs: 1_000,
      idleMs: 0,
      cwd: "/repo",
      source: "daemon",
    }
    const server = createServer((socket) => {
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8")
        let newline = buffer.indexOf("\n")
        while (newline >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf("\n")
          if (!line.trim()) continue
          const request = JSON.parse(line) as { id: number; method: string }
          methods.push(request.method)
          const daemon = { pid: 99, uptime: 10, clients: 1, dbPath: join(dir, "tribe.db"), socketPath }
          const result =
            request.method === "cli_status"
              ? { sessions: [holder], daemon }
              : request.method === "cli_health"
                ? { content: [{ type: "text", text: JSON.stringify({ issues: [] }) }], sessions: [holder], daemon }
                : request.method === "cli_log"
                  ? { messages: [] }
                  : request.method === "tribe.health"
                    ? {
                        content: [
                          {
                            type: "text",
                            text: JSON.stringify({
                              code_pin: {
                                stale: false,
                                reason: null,
                                running: "abc",
                                on_disk: "abc",
                                superproject_pin: "abc",
                              },
                            }),
                          },
                        ],
                      }
                    : { error: `unexpected method ${request.method}` }
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`)
        }
      })
    })

    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen)
        server.listen(socketPath, () => {
          server.off("error", rejectListen)
          resolveListen()
        })
      })
      const env = {
        ...process.env,
        TRIBE_SOCKET: socketPath,
        TRIBE_NAME: "@chief",
        TRIBE_TAKEOVER: "1",
        TRIBE_NO_AUTOSTART: "1",
      }

      for (const args of [["doctor"], ["health"], ["status"], ["log", "--limit", "1"]]) {
        const result = await runCliAsync(args, env)
        expect(result, `${args[0]} failed: ${result.stderr}`).toMatchObject({ code: 0 })
      }

      expect(methods).toEqual(["tribe.health", "cli_health", "cli_status", "cli_log"])
      expect(methods).not.toContain("register")
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("inbox-drain fans into the authenticated current launch before mutating its mailbox", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-wire-inbox-drain-"))
    const socketPath = join(dir, "tribe.sock")
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
    const result = {
      session: "@agent/3",
      unread_count: 0,
      oldest_unread_age_min: 0,
      oldest_unread_ts: 0,
      drained_count: 1,
      events: [{ from: "@chief", type: "request", content: "review carrier r2" }],
    }
    const server = createServer((socket) => {
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8")
        let newline = buffer.indexOf("\n")
        while (newline >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf("\n")
          if (!line.trim()) continue
          const request = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> }
          calls.push({ method: request.method, params: request.params })
          const response =
            request.method === "register"
              ? { sessionId: "session-agent-3", name: "@agent/3", role: "member" }
              : request.method === "cli_inbox_drain"
                ? result
                : { error: `unexpected method ${request.method}` }
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: response })}\n`)
        }
      })
    })

    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen)
        server.listen(socketPath, () => {
          server.off("error", rejectListen)
          resolveListen()
        })
      })
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        TRIBE_SOCKET: socketPath,
        TRIBE_NAME: "@agent/3",
        TRIBE_ROLE: "member",
        TRIBE_LAUNCH_ID: "launch-agent-3",
        TRIBE_NO_AUTOSTART: "1",
      }
      delete env.TRIBE_SESSION_NAME
      const cli = await runCliAsync(["inbox-drain", "--limit", "1", "--json"], env)

      expect(cli).toMatchObject({ code: 0, stderr: "" })
      expect(JSON.parse(cli.stdout)).toEqual(result)
      expect(calls).toHaveLength(2)
      expect(calls[0]).toMatchObject({
        method: "register",
        params: {
          name: "@agent/3",
          role: "member",
          delivery: "pull",
          launchId: "launch-agent-3",
          launchParentPid: process.pid,
          inboxDrain: true,
          pid: expect.any(Number),
        },
      })
      expect(calls[1]).toEqual({ method: "cli_inbox_drain", params: { limit: 1 } })
      expect(calls[1]?.params).not.toHaveProperty("session")
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("inbox-drain fails closed without managed identity or with a target override", async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TRIBE_SOCKET: join(tmpdir(), `tribe-wire-no-drain-${process.pid}.sock`),
      TRIBE_NAME: "@agent/3",
      TRIBE_LAUNCH_ID: "launch-agent-3",
      TRIBE_NO_AUTOSTART: "1",
    }
    delete env.TRIBE_SESSION_NAME

    const crossRole = await runCliAsync(["inbox-drain", "--session", "@chief"], env)
    expect(crossRole.code).not.toBe(0)
    expect(crossRole.stderr).toMatch(/unknown option.*--session/i)

    const invalid = await runCliAsync(["inbox-drain", "--limit", "0"], env)
    expect(invalid.code).toBe(2)
    expect(invalid.stderr).toMatch(/--limit must be an integer from 1 through 100/)

    delete env.TRIBE_LAUNCH_ID
    const unauthenticated = await runCliAsync(["inbox-drain"], env)
    expect(unauthenticated.code).toBe(2)
    expect(unauthenticated.stderr).toMatch(/authenticated managed session required/)
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
