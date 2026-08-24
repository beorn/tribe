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
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createConnection, createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { TRIBE_PROTOCOL_VERSION } from "../src/lib/socket.ts"

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../src/cli.ts")
const DAEMON = resolve(dirname(fileURLToPath(import.meta.url)), "../../daemon/src/daemon.ts")
const TRIBE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const TRIBE_SHA = execFileSync("git", ["-C", TRIBE_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
const SUPERPROJECT_ROOT = execFileSync("git", ["-C", TRIBE_ROOT, "rev-parse", "--show-superproject-working-tree"], {
  encoding: "utf8",
}).trim()
const EXPECTED_HOST_PIN = SUPERPROJECT_ROOT === "" ? "none (standalone checkout, no superproject)" : TRIBE_SHA
const BUN_BIN = process.env.BUN_EXECUTABLE ?? "bun"

// Strip ANSI SGR sequences (Commander colorizes its help output, which
// breaks word-boundary regex like /\bsend\b/ because the byte before "s"
// is the "m" terminator of a color escape — a word character.
function stripAnsi(s: string): string {
  // oxlint-disable-next-line no-control-regex -- ANSI SGR is framed by an ESC byte.
  return s.replace(/\u001B\[[0-9;]*m/g, "")
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
  opts: { operatorCapability?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveRun) => {
    const stdio: Array<"ignore" | "pipe" | number> = ["ignore", "pipe", "pipe"]
    let capabilityFd: number | undefined
    let capabilityDir: string | undefined
    const childEnv = { ...env }
    if (opts.operatorCapability !== undefined) {
      capabilityDir = mkdtempSync(join(tmpdir(), "tribe-operator-capability-"))
      const capabilityPath = join(capabilityDir, "capability")
      writeFileSync(capabilityPath, opts.operatorCapability, { mode: 0o600 })
      capabilityFd = openSync(capabilityPath, "r")
      stdio.push(capabilityFd)
      childEnv.TRIBE_OPERATOR_CAPABILITY_FD = String(stdio.length - 1)
    }
    const child = spawn(BUN_BIN, [CLI, ...args], { env: childEnv, stdio, timeout: opts.timeoutMs })
    if (capabilityFd !== undefined) closeSync(capabilityFd)
    let stdout = ""
    let stderr = ""
    child.stdout!.on("data", (chunk) => (stdout += chunk.toString("utf8")))
    child.stderr!.on("data", (chunk) => (stderr += chunk.toString("utf8")))
    let settled = false
    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error): void => {
      if (settled) return
      settled = true
      if (capabilityDir !== undefined) rmSync(capabilityDir, { recursive: true, force: true })
      resolveRun({
        stdout: stripAnsi(stdout),
        stderr: stripAnsi(spawnError ? `${stderr}${spawnError.message}` : stderr),
        code,
        signal,
      })
    }
    child.on("error", (error) => finish(null, null, error))
    child.on("close", (code, signal) => finish(code, signal))
  })
}

async function waitForSocket(socketPath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolveConnect) => {
      const socket = createConnection(socketPath)
      socket.once("connect", () => {
        socket.end()
        resolveConnect(true)
      })
      socket.once("error", () => resolveConnect(false))
    })
    if (connected) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error(`timed out waiting for daemon socket ${socketPath}`)
}

function createDoctorCanaryResponder(mode: "pass" | "timeout" = "pass") {
  return (method: string): unknown | null => {
    if (method === "register") return { name: "tribe-doctor-canary" }
    if (method === "cli_inbox_wait") {
      return mode === "pass"
        ? { status: "woken", timed_out: false, waited_ms: 3 }
        : { status: "timeout", timed_out: true, waited_ms: 2_000 }
    }
    if (method === "tribe.send") return { sent: true, id: "00000000-0000-4000-8000-000000000001" }
    if (method === "tribe.fetch") return { messages: [] }
    return null
  }
}

describe("tribe-wire CLI — Commander dispatcher", () => {
  it("doctor proves the rail with a real daemon send and long-poll canary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-wire-doctor-canary-"))
    const socketPath = join(dir, "tribe.sock")
    const dbPath = join(dir, "tribe.db")
    const env = {
      ...process.env,
      TRIBE_SOCKET: socketPath,
      TRIBE_DB: dbPath,
      TRIBE_NO_AUTOSTART: "1",
      TRIBE_SUMMARIZER_MODEL: "off",
    }
    const daemon = spawn(
      BUN_BIN,
      [DAEMON, "--socket", socketPath, "--db", dbPath, "--quit-timeout", "-1", "--no-lore"],
      { env, stdio: "ignore" },
    )

    try {
      await waitForSocket(socketPath)
      const result = await runCliAsync(["doctor"], env, { timeoutMs: 10_000 })

      expect(result, result.stderr).toMatchObject({ code: 0 })
      expect(result.stdout).toMatch(/OK — rail canary message=[0-9a-f-]+ waited_ms=\d+/)
      expect(result.stdout).toContain(
        `OK — code identity running=${TRIBE_SHA} on_disk=${TRIBE_SHA} pin=${EXPECTED_HOST_PIN}`,
      )
    } finally {
      daemon.kill("SIGTERM")
      await new Promise<void>((resolveClose) => daemon.once("close", () => resolveClose()))
      rmSync(dir, { recursive: true, force: true })
    }
    // The canary deliberately gives its real CLI subprocess 10s. Vitest's
    // implicit 5s ceiling can otherwise kill the surrounding test first on a
    // loaded runner, turning a healthy rail into an unclassified bare timeout.
  }, 30_000)

  it("refuses a legacy inbox-wait daemon before parsing its stale result and names the served pins", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-wire-inbox-wait-skew-"))
    const socketPath = join(dir, "tribe.sock")
    const calls: string[] = []
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
          calls.push(request.method)
          if (request.method === "cli_protocol") {
            socket.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                error: { code: -32601, message: "Method not found: cli_protocol" },
              })}\n`,
            )
            continue
          }
          if (request.method === "tribe.health") {
            socket.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        code_pin: {
                          stale: true,
                          reason: "running 665a2052c != on_disk 2056c81e2",
                          running: "665a2052c",
                          on_disk: "2056c81e2",
                          superproject_pin: "2056c81e2",
                        },
                      }),
                    },
                  ],
                },
              })}\n`,
            )
            continue
          }
          socket.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                session: "@chief",
                unread_count: 0,
                oldest_unread_age_min: 0,
                oldest_unread_ts: 0,
                waited_ms: 0,
                timed_out: true,
                aborted: false,
              },
            })}\n`,
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
      const result = await runCliAsync(
        ["inbox-wait", "--session", "@chief", "--timeout", "0s", "--json"],
        {
          ...process.env,
          TRIBE_SOCKET: socketPath,
          TRIBE_NO_AUTOSTART: "1",
        },
        { timeoutMs: 10_000 },
      )

      expect(result.code).not.toBe(0)
      expect(result.stderr).toMatch(/inbox-wait protocol version mismatch/i)
      expect(result.stderr).toContain(`client=${TRIBE_PROTOCOL_VERSION}`)
      expect(result.stderr).toContain("daemon=unsupported")
      expect(result.stderr).toContain("running=665a2052c")
      expect(result.stderr).toContain("on_disk=2056c81e2")
      expect(result.stderr).toContain("pin=2056c81e2")
      expect(result.stderr).not.toMatch(/at assertInboxWaitProtocol/)
      expect(calls).toEqual(["cli_protocol", "tribe.health"])
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("fails loudly by the client deadline when the inbox-wait daemon stays silent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-wire-inbox-wait-silent-"))
    const socketPath = join(dir, "tribe.sock")
    const sockets = new Set<Socket>()
    let resolveConnected!: (timestamp: number) => void
    const connected = new Promise<number>((resolve) => {
      resolveConnected = resolve
    })
    const server = createServer((socket) => {
      sockets.add(socket)
      resolveConnected(Date.now())
      socket.on("close", () => sockets.delete(socket))
      socket.on("data", () => undefined)
    })

    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen)
        server.listen(socketPath, () => {
          server.off("error", rejectListen)
          resolveListen()
        })
      })
      const childRun = runCliAsync(
        ["inbox-wait", "--session", "@chief", "--timeout", "0s", "--json"],
        {
          ...process.env,
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(dir, "bun-transpiler-cache"),
          TRIBE_SOCKET: socketPath,
          TRIBE_NO_AUTOSTART: "1",
        },
        { timeoutMs: 30_000 },
      )
      const readiness = await Promise.race([
        connected.then((connectedAt) => ({ kind: "connected" as const, connectedAt })),
        childRun.then((result) => ({ kind: "exited" as const, result })),
      ])
      if (readiness.kind === "exited") {
        throw new Error(`inbox-wait child exited before connecting: ${readiness.result.stderr}`)
      }
      const { connectedAt } = readiness
      const result = await childRun
      const deadlineElapsedMs = Date.now() - connectedAt

      expect(result.signal).toBeNull()
      expect(result.code).not.toBe(0)
      expect(result.stderr).toMatch(/Request cli_protocol timed out/)
      expect(deadlineElapsedMs).toBeGreaterThanOrEqual(9_000)
      expect(deadlineElapsedMs).toBeLessThan(15_000)
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      rmSync(dir, { recursive: true, force: true })
    }
  }, 40_000)

  it("--help prints the Commands list + MCP-adapter hint and exits 0", () => {
    const { stdout, code } = runCli(["--help"])
    expect(code).toBe(0)
    expect(stdout).toMatch(/tribe-wire CLI/)
    expect(stdout).toMatch(/Commands:/)
    // A few canonical verbs from each registered family are visible.
    expect(stdout).toMatch(/\bstatus\b/)
    expect(stdout).toMatch(/\brestart\b/)
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
    expect(stdout).toMatch(/--delivery <mode>/)
  })

  it("send rejects invalid fanout before daemon connection", () => {
    const { stderr, code } = runCli(["send", "@chief", "hello", "--fanout", "many"])
    expect(code).toBe(2)
    expect(stderr).toMatch(/invalid --fanout 'many'/)
  })

  it("send rejects invalid delivery before daemon connection", () => {
    const { stderr, code } = runCli(["send", "@chief", "hello", "--delivery", "later"])
    expect(code).toBe(2)
    expect(stderr).toMatch(/invalid --delivery 'later'/)
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
    expect(stdout).toMatch(/--expired/)
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
              owner_transport_registered: false,
              owner_transport_state: "disconnected",
              owner_state: "unknown",
              owner_answer_capability: "not-observed",
              owner_transport_reason: "owner-unknown-no-transport",
              owner_transport_observed_at: "2026-07-14T11:00:00.000Z",
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
              owner_transport_registered: true,
              owner_transport_state: "connected",
              owner_state: "live",
              owner_answer_capability: "observed",
              owner_transport_reason: "connected-pid-live-transport",
              owner_transport_observed_at: "2026-07-14T11:00:00.000Z",
            },
          ],
        },
      ],
    }
    const expiredSnapshot = {
      all: true,
      expired: true,
      count: 2,
      owner_count: 1,
      oldest_age_ms: 10_800_000,
      pending: [],
      owners: [
        {
          owner: "@agent/2",
          count: 2,
          oldest_age_ms: 10_800_000,
          pending: [
            {
              request_id: "req-manual",
              recipient: "@agent/2",
              sender: "@chief",
              summary: "closed after an out-of-band decision",
              opened_at: "2026-07-14T08:00:00.000Z",
              age_ms: 10_800_000,
              message_id: "msg-manual",
              fanout: "first",
              status: "unanswered",
              settlement: "manual-close",
              settled_at: "2026-07-14T10:00:00.000Z",
            },
            {
              request_id: "req-gc",
              recipient: "@agent/2",
              sender: "@chief",
              summary: "never answered before retention",
              opened_at: "2026-07-14T09:00:00.000Z",
              age_ms: 7_200_000,
              message_id: "msg-gc",
              fanout: "first",
              status: "unanswered",
              settlement: "gc-expired",
              settled_at: "2026-07-14T10:30:00.000Z",
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
          const response = request.params?.expired === true ? expiredSnapshot : snapshot
          socket.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { structuredContent: response } })}\n`,
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
      const expiredHuman = await runCliAsync(["pending", "--all", "--expired"], env)
      const expiredJson = await runCliAsync(["pending", "--all", "--expired", "--json"], env)

      expect(human).toMatchObject({ code: 0, stderr: "" })
      expect(human.stdout).toContain("2 pending request(s) across 2 owner(s)")
      expect(human.stdout).toContain("@agent/2: 1 (oldest 180m ago)")
      expect(human.stdout).toContain("DEGRADED — current owner has no connected, PID-live transport")
      expect(human.stdout).toContain("obligation remains open; no automatic close/reroute")
      expect(human.stdout).not.toMatch(/@ci:.*DEGRADED/)
      expect(human.stdout).toContain("req-agent-2  from @chief  to @agent/2  review immutable carrier")
      expect(expiredHuman.stdout).toContain("req-manual")
      expect(expiredHuman.stdout).toContain("settlement=manual-close")
      expect(expiredHuman.stdout).toContain("req-gc")
      expect(expiredHuman.stdout).toContain("settlement=gc-expired")
      expect(JSON.parse(json.stdout)).toEqual(snapshot)
      expect(JSON.parse(expiredJson.stdout)).toEqual(expiredSnapshot)
      expect(calls).toEqual([
        { method: "tribe.pending", params: { all: true } },
        { method: "tribe.pending", params: { all: true } },
        { method: "tribe.pending", params: { all: true, expired: true } },
        { method: "tribe.pending", params: { all: true, expired: true } },
      ])
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("pending --all --json flushes snapshots larger than the stdout pipe buffer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-wire-pending-all-large-"))
    const socketPath = join(dir, "tribe.sock")
    const pending = {
      request_id: "req-large",
      recipient: "@chief",
      sender: "@fleet",
      summary: "large fleet snapshot",
      content: "x".repeat(200_000),
      opened_at: "2026-08-13T00:00:00.000Z",
      age_ms: 60_000,
      message_id: "msg-large",
      fanout: "first",
    }
    const snapshot = {
      all: true,
      expired: false,
      scope: "all",
      pending: [pending],
      owners: [{ owner: "@chief", count: 1, oldest_age_ms: 60_000, pending: [pending] }],
      owner_count: 1,
      oldest_age_ms: 60_000,
      count: 1,
    }
    const server = createServer((socket) => {
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8")
        const newline = buffer.indexOf("\n")
        if (newline < 0) return
        const request = JSON.parse(buffer.slice(0, newline)) as { id: number }
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { structuredContent: snapshot } })}\n`)
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
      const result = await runCliAsync(["pending", "--all", "--json"], {
        ...process.env,
        TRIBE_SOCKET: socketPath,
        TRIBE_NO_AUTOSTART: "1",
      })

      expect(result).toMatchObject({ code: 0, stderr: "" })
      expect(result.stdout.length).toBeGreaterThan(400_000)
      expect(JSON.parse(result.stdout)).toEqual(snapshot)
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("log --all --json flushes snapshots larger than the stdout pipe buffer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-wire-log-all-large-"))
    const socketPath = join(dir, "tribe.sock")
    const snapshot = {
      messages: [
        {
          id: "msg-large",
          type: "notify",
          sender: "@fleet",
          recipient: "@chief",
          content: "x".repeat(400_000),
          bead_id: null,
          ref: null,
          request: null,
          reply: null,
          ts: Date.parse("2026-08-13T00:00:00.000Z"),
        },
      ],
      query: { all: true, ref_prefix: null, reply_prefix: null },
    }
    const expectedOutput = `${JSON.stringify(snapshot)}\n`
    const server = createServer((socket) => {
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8")
        const newline = buffer.indexOf("\n")
        if (newline < 0) return
        const request = JSON.parse(buffer.slice(0, newline)) as { id: number }
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: snapshot })}\n`)
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
      const result = await runCliAsync(["log", "--all", "--json"], {
        ...process.env,
        TRIBE_SOCKET: socketPath,
        TRIBE_NO_AUTOSTART: "1",
      })

      expect(result).toMatchObject({ code: 0, stderr: "" })
      expect(result.stdout).toHaveLength(expectedOutput.length)
      expect(result.stdout).toBe(expectedOutput)
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("21049: read-only diagnostics never register an inherited managed persona", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-wire-diagnostics-"))
    const socketPath = join(dir, "tribe.sock")
    const methods: string[] = []
    const doctorCanaryResponse = createDoctorCanaryResponder()
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
      protocol_versions: [TRIBE_PROTOCOL_VERSION],
      version_state: "current",
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
          const daemon = {
            pid: 99,
            uptime: 10,
            clients: 1,
            dbPath: join(dir, "tribe.db"),
            socketPath,
            code_identity: { cert: TRIBE_SHA, root: TRIBE_ROOT },
            protocol_version: TRIBE_PROTOCOL_VERSION,
          }
          const canaryResult = doctorCanaryResponse(request.method)
          const result =
            canaryResult ??
            (request.method === "tribe.members"
              ? { content: [{ type: "text", text: JSON.stringify({ sessions: [] }) }] }
              : request.method === "cli_status"
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
                      : { error: `unexpected method ${request.method}` })
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

      expect(methods).toEqual([
        "cli_status",
        "tribe.members",
        "register",
        "cli_inbox_wait",
        "tribe.send",
        "tribe.fetch",
        "cli_health",
        "cli_status",
        "cli_log",
      ])
      expect(methods.filter((method) => method === "register")).toHaveLength(1)
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("doctor exits UNKNOWN instead of certifying unresolved code identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-wire-doctor-unknown-"))
    const socketPath = join(dir, "tribe.sock")
    const methods: string[] = []
    const doctorCanaryResponse = createDoctorCanaryResponder()
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
          const canaryResult = doctorCanaryResponse(request.method)
          const result =
            request.method === "cli_status"
              ? {
                  sessions: [],
                  daemon: {
                    protocol_version: TRIBE_PROTOCOL_VERSION,
                    code_identity: { cert: null, root: "/missing/tribe" },
                  },
                }
              : request.method === "tribe.members"
                ? { content: [{ type: "text", text: JSON.stringify({ sessions: [] }) }] }
                : canaryResult
          socket.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result,
            })}\n`,
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
      const result = await runCliAsync(["doctor"], {
        ...process.env,
        TRIBE_SOCKET: socketPath,
        TRIBE_NO_AUTOSTART: "1",
      })

      expect(result.code).toBe(2)
      expect(result.stderr).toContain(
        "UNKNOWN — code identity: daemon code identity is unresolved path=/missing/tribe errno=UNREPORTED_CERT",
      )
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("OK — code identity")
      expect(methods).toEqual([
        "cli_status",
        "tribe.members",
        "register",
        "cli_inbox_wait",
        "tribe.send",
        "tribe.fetch",
      ])
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("doctor reports an exact CRITICAL diagnosis and executable remedy when the long-poll canary times out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-wire-doctor-critical-"))
    const socketPath = join(dir, "tribe.sock")
    const methods: string[] = []
    const doctorCanaryResponse = createDoctorCanaryResponder("timeout")
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
          const canaryResult = doctorCanaryResponse(request.method)
          const result =
            request.method === "cli_status"
              ? {
                  sessions: [],
                  daemon: {
                    protocol_version: TRIBE_PROTOCOL_VERSION,
                    code_identity: { cert: TRIBE_SHA, root: TRIBE_ROOT },
                  },
                }
              : request.method === "tribe.members"
                ? { content: [{ type: "text", text: JSON.stringify({ sessions: [] }) }] }
                : canaryResult
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
      const result = await runCliAsync(["doctor"], {
        ...process.env,
        TRIBE_SOCKET: socketPath,
        TRIBE_NO_AUTOSTART: "1",
      })

      expect(result.code).toBe(1)
      expect(result.stdout).toContain(
        `OK — code identity running=${TRIBE_SHA} on_disk=${TRIBE_SHA} pin=${EXPECTED_HOST_PIN}`,
      )
      expect(result.stderr).toContain("CRITICAL — rail canary failed: long-poll returned status=timeout timed_out=true")
      expect(result.stderr).toContain(
        'REMEDY — run `tribe restart --reason "doctor rail canary failed"`, then re-run `tribe doctor`',
      )
      expect(result.stderr).toContain("FINAL FAIL — derived from the worst doctor check")
      expect(methods).toEqual(["cli_status", "tribe.members", "register", "cli_inbox_wait", "tribe.send"])
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("doctor against a mismatched daemon prints the exact CRITICAL identity line and remedy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-wire-doctor-mismatch-"))
    const socketPath = join(dir, "tribe.sock")
    const doctorCanaryResponse = createDoctorCanaryResponder()
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
          const canaryResult = doctorCanaryResponse(request.method)
          const result =
            request.method === "cli_status"
              ? {
                  sessions: [],
                  daemon: {
                    protocol_version: TRIBE_PROTOCOL_VERSION,
                    code_identity: { cert: "deadbeef", root: TRIBE_ROOT },
                  },
                }
              : request.method === "tribe.members"
                ? { content: [{ type: "text", text: JSON.stringify({ sessions: [] }) }] }
                : canaryResult
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
      const result = await runCliAsync(["doctor"], {
        ...process.env,
        TRIBE_SOCKET: socketPath,
        TRIBE_NO_AUTOSTART: "1",
      })

      expect(result.code).toBe(1)
      expect(result.stderr).toContain(
        `CRITICAL — code identity: daemon code integrity mismatch running=deadbeef on_disk=${TRIBE_SHA} ` +
          `pin=${EXPECTED_HOST_PIN}`,
      )
      expect(result.stderr).toContain(
        "REMEDY — the daemon is running a different module root; restarting will not help. Advance the daemon module root, then re-run `tribe doctor`",
      )
      expect(result.stdout).toContain("OK — rail canary message=00000000-0000-4000-8000-000000000001")
      expect(result.stderr).toContain("FINAL FAIL — derived from the worst doctor check")
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("projects durable message refs as filtered JSON for level-triggered controllers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-wire-log-ref-"))
    const socketPath = join(dir, "tribe.sock")
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
    const message = {
      id: "page-message",
      type: "request",
      sender: "@agent/8",
      recipient: "@fleet",
      content: "inspect vanished owner",
      bead_id: null,
      ref: "ball-controller:v1:owner-epoch:@agent/6:launch-1",
      request: "ball-rescue:v1:%40agent%2F6:launch-1",
      reply: null,
      ts: 123,
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
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                messages: [message],
                query: {
                  all: true,
                  ref_prefix: "ball-controller:v1:",
                  reply_prefix: "ball-rescue:v1:",
                },
              },
            })}\n`,
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
      const result = await runCliAsync(
        ["log", "--json", "--ref-prefix", "ball-controller:v1:", "--reply-prefix", "ball-rescue:v1:", "--all"],
        {
          ...process.env,
          TRIBE_SOCKET: socketPath,
          TRIBE_NO_AUTOSTART: "1",
        },
      )

      expect(result, result.stderr).toMatchObject({ code: 0, stderr: "" })
      expect(JSON.parse(result.stdout)).toEqual({
        messages: [message],
        query: { all: true, ref_prefix: "ball-controller:v1:", reply_prefix: "ball-rescue:v1:" },
      })
      expect(calls).toEqual([
        {
          method: "cli_log",
          params: { all: true, ref_prefix: "ball-controller:v1:", reply_prefix: "ball-rescue:v1:" },
        },
      ])
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keeps explicit inbox targeting compatible and makes managed targeting reject stale daemons", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-wire-inbox-drain-"))
    const socketPath = join(dir, "tribe.sock")
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = []
    const waitResult = {
      status: "woken",
      session: "@chief",
      unread_count: 0,
      oldest_unread_age_min: 0,
      oldest_unread_ts: 0,
      waited_ms: 0,
      effective_timeout_ms: 0,
      timed_out: false,
      aborted: false,
      attention: {
        actionable_unread: [],
        pending_balls: [],
        pending_balls_summary: { total: 0, oldest_age_ms: 0 },
      },
    }
    const result = {
      ...waitResult,
      drained_count: 1,
      events: [{ from: "@agent/7", type: "request", content: "review carrier" }],
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
            request.method === "cli_protocol"
              ? { jsonrpc: "2.0", id: request.id, result: { protocol_version: TRIBE_PROTOCOL_VERSION } }
              : request.method.endsWith("_by_launch_v1")
                ? {
                    jsonrpc: "2.0",
                    id: request.id,
                    error: { code: -32601, message: `Method not found: ${request.method}` },
                  }
                : {
                    jsonrpc: "2.0",
                    id: request.id,
                    result: request.method === "cli_inbox_wait" ? { ...waitResult, baseline_seq: 0 } : result,
                  }
          socket.write(`${JSON.stringify(response)}\n`)
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
      const explicitEnv = {
        ...process.env,
        TRIBE_SOCKET: socketPath,
        TRIBE_NO_AUTOSTART: "1",
        TRIBE_OPERATOR_CAPABILITY: "must-not-cross-the-wire",
      }
      const status = await runCliAsync(["inbox-status", "--session", "@chief", "--json"], explicitEnv)
      const wait = await runCliAsync(["inbox-wait", "--session", "@chief", "--timeout", "0s", "--json"], explicitEnv)
      const drain = await runCliAsync(["inbox-drain", "--session", "@chief", "--limit", "1", "--json"], explicitEnv, {
        operatorCapability: "fd-only-operator-secret",
      })

      expect(status).toMatchObject({ code: 0, stderr: "" })
      expect(drain).toMatchObject({
        code: 0,
        stderr:
          "tribe inbox-drain: read was destructive; messages consumed and cursor advanced. Use --peek to read without consuming.\n",
      })
      for (const cli of [status, drain]) {
        expect(JSON.parse(cli.stdout)).toMatchObject({ ...result, waited_ms: expect.any(Number) })
      }
      expect(wait).toMatchObject({ code: 0, stderr: "" })
      expect(JSON.parse(wait.stdout)).toEqual({ ...waitResult, waited_ms: expect.any(Number) })

      const managedEnv = {
        ...process.env,
        TRIBE_SOCKET: socketPath,
        TRIBE_LAUNCH_ID: "managed-stale-daemon-launch",
        TRIBE_NAME: "@dev/2",
        TRIBE_SESSION_NAME: "@dev/2",
        TRIBE_NO_AUTOSTART: "1",
      }
      const managedStatus = await runCliAsync(["inbox-status", "--json"], managedEnv)
      const managedWait = await runCliAsync(["inbox-wait", "--timeout", "0s", "--json"], managedEnv)
      const managedDrain = await runCliAsync(["inbox-drain", "--json"], managedEnv, {
        operatorCapability: "fd-only-operator-secret",
      })
      for (const cli of [managedStatus, managedWait, managedDrain]) {
        expect(cli.code).not.toBe(0)
        expect(cli.stderr).toMatch(/stale.*restart/i)
      }

      expect(calls).toEqual([
        { method: "cli_inbox_status", params: { session: "@chief" } },
        { method: "cli_protocol", params: undefined },
        { method: "cli_inbox_wait", params: { session: "@chief", timeout_ms: 0 } },
        {
          method: "cli_inbox_drain",
          params: { session: "@chief", limit: 1, operator_capability: "fd-only-operator-secret" },
        },
        {
          method: "cli_inbox_status_by_launch_v1",
          params: { launch_id: "managed-stale-daemon-launch", persona: "@dev/2" },
        },
        { method: "cli_protocol", params: undefined },
        {
          method: "cli_inbox_wait_by_launch_v1",
          params: { launch_id: "managed-stale-daemon-launch", persona: "@dev/2", timeout_ms: 0 },
        },
        {
          method: "cli_inbox_drain_by_launch_v1",
          params: {
            launch_id: "managed-stale-daemon-launch",
            persona: "@dev/2",
            limit: 10,
            operator_capability: "fd-only-operator-secret",
          },
        },
      ])
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("renders an unclassified inbox-drain authority failure as could-not-evaluate JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-wire-inbox-drain-authority-"))
    const socketPath = join(dir, "tribe.sock")
    const server = createServer((socket) => {
      socket.once("data", (chunk) => {
        const request = JSON.parse(chunk.toString("utf8").trim()) as { id: number }
        socket.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32004,
              message: "could-not-evaluate inbox drain authority: an operator capability is not configured",
              data: { kind: "could-not-evaluate", reason: "operator-capability-unconfigured" },
            },
          })}\n`,
        )
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
      const result = await runCliAsync(["inbox-drain", "--session", "@dev/1", "--json"], {
        ...process.env,
        TRIBE_SOCKET: socketPath,
        TRIBE_NO_AUTOSTART: "1",
      })

      expect(result).toMatchObject({ code: 1, stdout: "" })
      expect(JSON.parse(result.stderr)).toEqual({
        error: {
          code: -32004,
          kind: "could-not-evaluate",
          message: "could-not-evaluate inbox drain authority: an operator capability is not configured",
          reason: "operator-capability-unconfigured",
        },
      })
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keeps a pre-existing deadline response visible without publishing a new JSON wake", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-wire-inbox-wait-attention-"))
    const socketPath = join(dir, "tribe.sock")
    const attention = {
      actionable_unread: [{ id: "response-at-deadline", type: "response" }],
      pending_balls: [],
      pending_balls_summary: { total: 0, oldest_age_ms: 0 },
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
          const result =
            request.method === "cli_protocol"
              ? { protocol_version: TRIBE_PROTOCOL_VERSION }
              : {
                  status: "timeout",
                  session: "@chief",
                  unread_count: 0,
                  oldest_unread_age_min: 0,
                  oldest_unread_ts: 0,
                  waited_ms: 0,
                  effective_timeout_ms: 0,
                  timed_out: true,
                  aborted: false,
                  attention,
                  baseline_seq: 0,
                }
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
      const result = await runCliAsync(["inbox-wait", "--session", "@chief", "--timeout", "0s", "--json"], {
        ...process.env,
        TRIBE_SOCKET: socketPath,
        TRIBE_NO_AUTOSTART: "1",
      })

      expect(result, result.stderr).toMatchObject({ code: 0, stderr: "" })
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "timeout",
        timed_out: true,
        unread_count: 0,
        attention,
      })
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("stop refuses without --force outside the hab supervisor context — before touching any socket", async () => {
    // TRIBE_SOCKET points at a guaranteed-absent path anyway: this test must
    // never be able to reach a real daemon even if the guard regressed.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TRIBE_NO_AUTOSTART: "1",
      TRIBE_SOCKET: "/tmp/tribe-stop-guard-absent.sock",
    }
    delete env.HAB_SERVICE_NAME
    const result = await runCliAsync(["stop"], env)
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/refusing to stop the shared coordination daemon/)
    expect(result.stderr).toMatch(/--force/)
    // The local guard fired before any connection attempt.
    expect(result.stderr).not.toMatch(/No daemon running/)
  })

  it("stop passes the guard without --force when HAB_SERVICE_NAME marks the hab supervisor context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-wire-stop-hab-"))
    try {
      const env = {
        ...process.env,
        TRIBE_NO_AUTOSTART: "1",
        TRIBE_SOCKET: join(dir, "absent.sock"),
        HAB_SERVICE_NAME: "wire",
      }
      const result = await runCliAsync(["stop"], env)
      // Guard passed; the failure is the absent daemon, not a refusal.
      expect(result.stderr).not.toMatch(/refusing to stop/)
      expect(result.stderr).toMatch(/No daemon running/)
      expect(result.code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("stop --force cleanly stops a real daemon: RPC acknowledged, then daemon exit 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-wire-stop-e2e-"))
    const socketPath = join(dir, "tribe.sock")
    const dbPath = join(dir, "tribe.db")
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TRIBE_SOCKET: socketPath,
      TRIBE_DB: dbPath,
      TRIBE_NO_AUTOSTART: "1",
      TRIBE_SUMMARIZER_MODEL: "off",
    }
    delete env.HAB_SERVICE_NAME // prove --force alone authorizes
    const daemon = spawn(
      BUN_BIN,
      [DAEMON, "--socket", socketPath, "--db", dbPath, "--idle-quit-after", "never", "--no-lore"],
      {
        env,
        stdio: "ignore",
      },
    )
    const daemonExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) =>
      daemon.once("close", (code, signal) => resolveExit({ code, signal })),
    )
    let stopped = false
    try {
      await waitForSocket(socketPath)
      const result = await runCliAsync(["stop", "--force", "--reason", "cli e2e"], env, { timeoutMs: 10_000 })
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toContain("Stopping tribe daemon")
      expect(result.stdout).toContain("cli e2e")
      const exit = await Promise.race([
        daemonExit,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("daemon did not exit within 10s of tribe stop")), 10_000),
        ),
      ])
      stopped = true
      // The whole point: a CLEAN exit — code 0, no signal, no kill involved.
      expect(exit).toEqual({ code: 0, signal: null })
    } finally {
      if (!stopped) daemon.kill("SIGTERM")
      rmSync(dir, { recursive: true, force: true })
    }
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
