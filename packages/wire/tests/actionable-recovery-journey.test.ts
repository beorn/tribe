/**
 * 19442 undead reframe — REAL stdio-adapter journey against the REAL daemon.
 *
 * The prior unit tests stopped at the daemon selector or at a faked drain and
 * asserted the wrong invariant (forward 100 arbitrary recent rows). This
 * journey crosses the actual channel boundary: a real tribe-daemon process on
 * a tmp socket with a real SQLite journal seeded with the transcript fixture
 * (49 join broadcasts + 48 health broadcasts + direct attention rows), and a
 * real stdio adapter speaking MCP over stdio.
 *
 * Claiming the loaded name must surface exactly the actionable and response
 * attention rows as channel notifications — zero ambient replay — and a
 * second fresh adapter claiming the same name must surface NOTHING (the
 * durable mailbox remembers the acknowledgement).
 *
 * 21049 launch identity contract:
 * - The provider launcher mints a UUID-strength launch id once and overwrites
 *   any inherited value at every provider-launch boundary. Adapters only
 *   forward that identity; they never mint or coalesce an empty/absent id.
 * - An absent launch id preserves legacy per-transport registration. A stale
 *   inherited id from a dead provider parent must not adopt that dead member,
 *   even when an unsanitized caller also inherits the explicit TRIBE_NAME.
 * - One live launch owns one persisted member id across transport replacement
 *   and daemon restart. Deliberate whole-launch takeover mints a new member id.
 * - Cross-launch refusal remains the existing typed registration/name-claim
 *   exit-2 path. This journey adds no standalone gate surface.
 */

import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { safeRemoveSync } from "removely"
import { createStatements, openDatabase } from "../../daemon/src/lib/database.ts"
import { connectToDaemon, type DaemonClient } from "../src/client.ts"
import { TRIBE_PROTOCOL_VERSION } from "../src/lib/socket.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const ADAPTER = resolve(HERE, "../src/stdio-adapter.ts")
const PLUGIN_SERVER = resolve(HERE, "../../../plugins/claude/server.ts")
const CLI = resolve(HERE, "../src/cli.ts")
const DAEMON = resolve(HERE, "../../daemon/src/daemon.ts")
const BUN_BIN = process.versions.bun ? process.execPath : "bun"
const TEST_ROOT = realpathSync(tmpdir())
const PROVIDER_PARENT_WRAPPER = `
const command = JSON.parse(process.env.TRIBE_TEST_CHILD_COMMAND)
const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env })
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal))
process.exit(await child.exited)
`
const CLI_PARENT_WRAPPER = `
const { spawn } = await import("node:child_process")
const command = JSON.parse(process.env.TRIBE_TEST_CHILD_COMMAND)
const stdio = process.env.TRIBE_OPERATOR_CAPABILITY_FD === "3"
  ? ["inherit", "inherit", "inherit", 3]
  : ["inherit", "inherit", "inherit"]
const child = spawn(command[0], command.slice(1), { env: process.env, stdio })
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal))
process.exitCode = await new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code ?? 1)))
`

const NAME = "@agent/3"

// Hermetic spawn environment. The daemon classifies a session as an "LLM
// sender" (summary required on `send`) whenever CLAUDE_SESSION_ID /
// CLAUDE_SESSION_NAME / BD_ACTOR resolve to a value (see config.ts
// resolveClaudeSessionId/Name + handlers.ts llmSender gate). Plain GitHub CI
// leaves those unset, so this journey is written for the non-LLM sender path.
// When the suite runs under an agent harness (Claude Code, a tribe seat) those
// vars are present in the parent env and would silently leak into every
// spawned daemon/adapter/CLI via `{ ...process.env }`, flipping the summaryless
// `send` calls below into a "summary required" error and diverging from the
// config that ships. Strip them once so every child sees the same
// classification everywhere the suite runs.
const BASE_ENV: NodeJS.ProcessEnv = (() => {
  const env = { ...process.env }
  delete env.CLAUDE_SESSION_ID
  delete env.CLAUDE_SESSION_NAME
  delete env.BD_ACTOR
  return env
})()

function readLifecycleRows(dbPath: string): Array<{ type: string; sender: string; content: string }> {
  const db = openDatabase(dbPath)
  try {
    return db
      .prepare(
        "SELECT type, sender, content FROM messages " +
          "WHERE type IN ('session', 'event.session.joined', 'event.session.left') ORDER BY rowid ASC",
      )
      .all() as Array<{ type: string; sender: string; content: string }>
  } finally {
    db.close()
  }
}

function seedAttentionFixture(dbPath: string): void {
  const db = openDatabase(dbPath)
  const stmts = createStatements(db)
  const base = Date.now() - 30 * 60_000
  const insert = (spec: {
    id: string
    type: string
    sender: string
    recipient: string
    kind: string
    content: string
    ts: number
  }) => {
    stmts.insertMessage.run({
      $id: spec.id,
      $type: spec.type,
      $sender: spec.sender,
      $recipient: spec.recipient,
      $kind: spec.kind,
      $content: spec.content,
      $bead_id: null,
      $ref: null,
      $ts: spec.ts,
      $delivery: "push",
      $topic: null,
      $room_id: null,
      $request: null,
      $reply: null,
      $summary: null,
    })
  }
  for (let i = 0; i < 49; i++) {
    insert({
      id: `join-${i}`,
      type: "notify",
      sender: "daemon",
      recipient: "*",
      kind: "broadcast",
      content: `unknown-${i} joined (member) pid=${1000 + i}`,
      ts: base + i,
    })
  }
  for (let i = 0; i < 48; i++) {
    insert({
      id: `health-${i}`,
      type: "health:daemon:warn",
      sender: "daemon",
      recipient: "*",
      kind: "broadcast",
      content: "[log-redacted]",
      ts: base + 49 + i,
    })
  }
  insert({
    id: "the-assignment",
    type: "request",
    sender: "@chief",
    recipient: NAME,
    kind: "direct",
    content: "please pick up the wrapper-r4 assembly",
    ts: base + 49 + 48,
  })
  insert({
    id: "the-response",
    type: "response",
    sender: "@chief",
    recipient: NAME,
    kind: "direct",
    content: "use the durable attention seam",
    ts: base + 49 + 49,
  })
  db.close()
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  // Generous CI-safe default: these journeys drive real bun subprocesses (a
  // daemon + several stdio adapters) over unix sockets, whose cold-start,
  // reconnect backoff, and re-exec cycles routinely exceed a few seconds on a
  // loaded runner. The predicate returns the instant it is satisfied, so a high
  // ceiling never slows the happy path — it only prevents a premature false
  // "timed out" under load (the CI flake this file was hitting).
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000)
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolveTick) => setTimeout(resolveTick, opts.intervalMs ?? 25))
  }
  throw new Error(`timed out waiting for ${message}`)
}

function collectStdoutJson(child: ChildProcessWithoutNullStreams): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = []
  let carry = ""
  child.stdout.on("data", (chunk: Buffer | string) => {
    const parts = (carry + chunk.toString()).split(/\r?\n/u)
    carry = parts.pop() ?? ""
    for (const raw of parts) {
      if (raw.length === 0) continue
      try {
        lines.push(JSON.parse(raw) as Record<string, unknown>)
      } catch {
        /* ignore non-json noise */
      }
    }
  })
  return lines
}

function writeJson(child: ChildProcessWithoutNullStreams, payload: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(payload)}\n`)
}

function initializePayload(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "tribe-wire-journey-test", version: "0" },
    },
  }
}

function callToolPayload(id: number, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }
}

function channelNotifications(lines: Record<string, unknown>[]): Record<string, unknown>[] {
  return lines.filter((line) => line.method === "notifications/claude/channel")
}

function toolResult(lines: Record<string, unknown>[], id: number): unknown {
  const response = lines.find((line) => line.id === id)
  const result = response?.result as { content?: Array<{ text?: string }> } | undefined
  const text = result?.content?.[0]?.text
  if (typeof text !== "string") return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(text)
  }
}

function sessionDeliveryOffsets(
  dbPath: string,
  name: string,
): { last_delivered_seq: number; last_inbox_pull_seq: number } {
  const db = openDatabase(dbPath)
  try {
    const row = db.prepare("SELECT last_delivered_seq, last_inbox_pull_seq FROM sessions WHERE name = ?").get(name) as {
      last_delivered_seq: number
      last_inbox_pull_seq: number
    } | null
    if (!row) throw new Error(`session ${name} not found in ${dbPath}`)
    return row
  } finally {
    db.close()
  }
}

describe("19442 actionable-recovery journey (real daemon + real adapter)", () => {
  let tmpDir: string
  let daemonProc: ChildProcessWithoutNullStreams | undefined
  const adapters: ChildProcessWithoutNullStreams[] = []
  const detachedDaemonPids: number[] = []

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-recovery-journey-"))
  })

  afterEach(() => {
    for (const adapter of adapters) adapter.kill("SIGTERM")
    adapters.length = 0
    daemonProc?.kill("SIGTERM")
    daemonProc = undefined
    for (const pid of detachedDaemonPids) {
      try {
        process.kill(pid, "SIGTERM")
      } catch {
        /* already exited during hot reload */
      }
    }
    detachedDaemonPids.length = 0
    safeRemoveSync(tmpDir, { within: TEST_ROOT, allowMissing: true })
  })

  async function connectToDaemonPid(
    socketPath: string,
    predicate: (pid: number) => boolean = () => true,
  ): Promise<{ client: DaemonClient; pid: number }> {
    let lastError: unknown
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) {
      let client: DaemonClient | undefined
      try {
        client = await connectToDaemon(socketPath, { callTimeoutMs: 1_000 })
        const status = (await client.call("cli_daemon")) as { pid: number }
        if (predicate(status.pid)) return { client, pid: status.pid }
        client.close()
      } catch (error) {
        lastError = error
        client?.close()
      }
      await new Promise((resolveTick) => setTimeout(resolveTick, 50))
    }
    throw new Error(`timed out connecting to expected daemon pid: ${String(lastError)}`)
  }

  function spawnDaemon(
    socketPath: string,
    dbPath: string,
    opts: { operatorCapabilityFd?: number } = {},
  ): ChildProcessWithoutNullStreams {
    const proc = spawn(BUN_BIN, [DAEMON, "--socket", socketPath, "--db", dbPath, "--foreground", "--no-lore"], {
      cwd: tmpDir,
      env: {
        ...BASE_ENV,
        TRIBE_NO_PLUGINS: "1",
        ...(opts.operatorCapabilityFd === undefined ? {} : { TRIBE_OPERATOR_CAPABILITY_FD: "3" }),
        TRIBE_ACTIVITY_LOG: join(tmpDir, "activity.jsonl"),
        DEBUG: "tribe:*",
        DEBUG_LOG: join(tmpDir, "daemon.log"),
        LOG_FILE: join(tmpDir, "daemon.log"),
      },
      stdio:
        opts.operatorCapabilityFd === undefined
          ? ["pipe", "pipe", "pipe"]
          : ["pipe", "pipe", "pipe", opts.operatorCapabilityFd],
    })
    return proc as ChildProcessWithoutNullStreams
  }

  async function spawnAdapterAndJoin(
    socketPath: string,
    logName: string,
  ): Promise<{ child: ChildProcessWithoutNullStreams; stdout: Record<string, unknown>[] }> {
    const child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath], {
      cwd: tmpDir,
      env: {
        ...BASE_ENV,
        TRIBE_LAUNCH_ID: "",
        TRIBE_NAME: "",
        TRIBE_SESSION_NAME: "",
        TRIBE_DELIVERY: "push",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, logName),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    adapters.push(child)
    const stdout = collectStdoutJson(child)
    writeJson(child, initializePayload(1))
    await waitForCondition(() => stdout.some((line) => line.id === 1), "adapter initialize response")
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    // Claim the loaded name explicitly — register happens under a generated
    // member name, so this join is a genuine name CLAIM (the recovery path).
    writeJson(child, callToolPayload(2, "join", { name: NAME }))
    await waitForCondition(() => stdout.some((line) => line.id === 2), "join response")
    return { child, stdout }
  }

  async function spawnLaunchAdapter(
    socketPath: string,
    logName: string,
    launchId: string | undefined,
    opts: {
      name?: string
      takeover?: boolean
      distinctProviderParent?: boolean
      throughPluginSupervisor?: boolean
      delivery?: "push" | "pull"
      filterMode?: "focus" | "normal" | "ambient"
    } = {},
  ): Promise<{ child: ChildProcessWithoutNullStreams; stdout: Record<string, unknown>[]; logPath: string }> {
    const logPath = join(tmpDir, logName)
    const name = opts.name ?? NAME
    const adapterCommand = [
      BUN_BIN,
      opts.throughPluginSupervisor ? PLUGIN_SERVER : ADAPTER,
      "--socket",
      socketPath,
      "--name",
      name,
    ]
    const child = spawn(
      BUN_BIN,
      opts.distinctProviderParent ? ["-e", PROVIDER_PARENT_WRAPPER] : adapterCommand.slice(1),
      {
        cwd: tmpDir,
        env: {
          ...BASE_ENV,
          TRIBE_LAUNCH_ID: launchId ?? "",
          TRIBE_NAME: "",
          TRIBE_SESSION_NAME: "",
          TRIBE_DELIVERY: opts.delivery ?? "pull",
          ...(opts.filterMode === undefined ? {} : { TRIBE_FILTER_MODE: opts.filterMode }),
          TRIBE_PULL_TRANSPORT: "mcp",
          TRIBE_NO_AUTOSTART: "1",
          TRIBE_REQUIRE_JOIN: "0",
          TRIBE_TAKEOVER: opts.takeover === false ? "0" : "1",
          TRIBE_PLUGIN_ADAPTER_CHILD: "",
          // A managed plugin wrapper preserves its explicit provider parent;
          // direct adapters ignore stale provenance without the child marker.
          TRIBE_PLUGIN_PROVIDER_PARENT_PID: opts.throughPluginSupervisor ? String(process.pid) : "1",
          ...(opts.distinctProviderParent
            ? {
                // Hostile/unsanitized nested launch: both identity inputs are
                // inherited unchanged; only real OS-parent provenance differs.
                TRIBE_NAME: name,
                TRIBE_TEST_CHILD_COMMAND: JSON.stringify(adapterCommand),
              }
            : {}),
          DEBUG: "tribe:*",
          DEBUG_LOG: logPath,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
    adapters.push(child)
    const stdout = collectStdoutJson(child)
    writeJson(child, initializePayload(1))
    await waitForCondition(() => stdout.some((line) => line.id === 1), `${logName} initialize response`)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    return { child, stdout, logPath }
  }

  async function callLaunchTool(
    adapter: { child: ChildProcessWithoutNullStreams; stdout: Record<string, unknown>[]; logPath: string },
    id: number,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    writeJson(adapter.child, callToolPayload(id, name, args))
    try {
      await waitForCondition(() => adapter.stdout.some((line) => line.id === id), `${name} response`)
    } catch (error) {
      const log = existsSync(adapter.logPath) ? readFileSync(adapter.logPath, "utf8") : "(no adapter log)"
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; exit=${String(adapter.child.exitCode)}\n${log}`,
      )
    }
    return toolResult(adapter.stdout, id)
  }

  /** First tool call after a spawn can race the adapter's asynchronous daemon
   * registration on a loaded runner — retry (fresh id each round, so stale
   * response lines can't satisfy the wait) while the required-MCP gate still
   * reports "awaiting daemon registration". Tests that assert the not-ready
   * state itself must keep using callLaunchTool directly. */
  async function callLaunchToolWhenRegistered(
    adapter: { child: ChildProcessWithoutNullStreams; stdout: Record<string, unknown>[]; logPath: string },
    firstId: number,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const deadline = Date.now() + 30_000
    let id = firstId
    for (;;) {
      try {
        return await callLaunchTool(adapter, id, name, args)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const registrationPending =
          message.includes("awaiting daemon registration") || message.includes("daemon connection closed; reconnecting")
        if (!registrationPending || Date.now() >= deadline) throw error
        id += 1_000
        await Bun.sleep(250)
      }
    }
  }

  async function runCli(
    args: string[],
    env: NodeJS.ProcessEnv,
    opts: { operatorCapabilityPath?: string; throughParent?: boolean } = {},
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const capabilityFd =
      opts.operatorCapabilityPath === undefined ? undefined : openSync(opts.operatorCapabilityPath, "r")
    const command = [BUN_BIN, CLI, ...args]
    const child = spawn(BUN_BIN, opts.throughParent ? ["-e", CLI_PARENT_WRAPPER] : command.slice(1), {
      cwd: tmpDir,
      env: {
        ...env,
        ...(opts.throughParent ? { TRIBE_TEST_CHILD_COMMAND: JSON.stringify(command) } : {}),
        ...(capabilityFd === undefined ? {} : { TRIBE_OPERATOR_CAPABILITY_FD: "3" }),
      },
      stdio: capabilityFd === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", capabilityFd],
    })
    if (capabilityFd !== undefined) closeSync(capabilityFd)
    if (!child.stdout || !child.stderr) throw new Error("CLI test child did not expose piped output")
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })
    await once(child, "exit")
    return { exitCode: child.exitCode, stdout, stderr }
  }

  it("keeps ambient supervisor traffic fetchable without waking and still wakes actionables", async () => {
    const socketPath = join(tmpDir, "notification-diet.sock")
    const dbPath = join(tmpDir, "notification-diet.db")
    daemonProc = spawnDaemon(socketPath, dbPath)
    await waitForCondition(() => existsSync(socketPath), "daemon socket")

    const fleet = await spawnLaunchAdapter(socketPath, "notification-diet-fleet.log", "notification-diet-launch", {
      name: "@fleet",
      delivery: "push",
      filterMode: "focus",
    })
    await callLaunchToolWhenRegistered(fleet, 2, "members", {})
    const beforeAmbient = sessionDeliveryOffsets(dbPath, "@fleet")

    const sender = await connectToDaemon(socketPath)
    try {
      await sender.call("register", {
        name: "@chief",
        role: "member",
        domains: ["test"],
        project: tmpDir,
        projectName: "test",
        protocolVersion: TRIBE_PROTOCOL_VERSION,
        pid: process.pid,
        delivery: "pull",
      })

      const ambientCases = [
        { type: "notify", content: "notification-only diet row" },
        { type: "github:push", content: "github ambient diet row" },
      ]
      for (const ambientCase of ambientCases) {
        await sender.call("tribe.send", {
          to: "@fleet",
          message: ambientCase.content,
          type: ambientCase.type,
          summary: ambientCase.content,
        })
      }
      const afterAmbient = sessionDeliveryOffsets(dbPath, "@fleet")
      expect(afterAmbient).toEqual(beforeAmbient)
      for (const ambientCase of ambientCases) {
        expect(
          channelNotifications(fleet.stdout).some((line) => JSON.stringify(line).includes(ambientCase.content)),
        ).toBe(false)
      }

      writeJson(fleet.child, callToolPayload(3, "fetch", {}))
      await waitForCondition(() => fleet.stdout.some((line) => line.id === 3), "fleet fetch response")
      const fetched = toolResult(fleet.stdout, 3) as { events?: Array<{ content?: string }> }
      for (const ambientCase of ambientCases) {
        expect(fetched.events?.some((event) => event.content === ambientCase.content)).toBe(true)
      }

      for (const type of ["request", "query", "assign", "verdict"]) {
        const content = `${type} actionable diet row`
        await sender.call("tribe.send", { to: "@fleet", message: content, type, summary: content })
        await waitForCondition(
          () => channelNotifications(fleet.stdout).some((line) => JSON.stringify(line).includes(content)),
          `${type} fleet wake`,
        )
      }
      expect(sessionDeliveryOffsets(dbPath, "@fleet").last_delivered_seq).toBeGreaterThan(
        afterAmbient.last_delivered_seq,
      )
    } finally {
      sender.close()
    }
  }, 30_000)

  it("preserves daemon-owned operator authority through standalone hot reload", async () => {
    const socketPath = join(tmpDir, "operator-lifecycle.sock")
    const dbPath = join(tmpDir, "operator-lifecycle.db")
    const capability = "operator-lifecycle-secret"
    const capabilityPath = join(tmpDir, "operator-capability")
    writeFileSync(capabilityPath, capability, { mode: 0o600 })
    const capabilityFd = openSync(capabilityPath, "r")
    daemonProc = spawnDaemon(socketPath, dbPath, { operatorCapabilityFd: capabilityFd })
    closeSync(capabilityFd)
    await waitForCondition(() => existsSync(socketPath), "operator lifecycle daemon socket")

    const child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/operator-test"], {
      cwd: tmpDir,
      env: {
        ...BASE_ENV,
        TRIBE_DB: dbPath,
        TRIBE_DELIVERY: "pull",
        TRIBE_PULL_TRANSPORT: "mcp",
        TRIBE_REQUIRE_JOIN: "0",
        TRIBE_NO_PLUGINS: "1",
        TRIBE_NO_AUTORELOAD: "1",
        TRIBE_OPERATOR_CAPABILITY: "must-not-cross-the-spawn-boundary",
        TRIBE_OPERATOR_CAPABILITY_FD: "3",
        DEBUG_LOG: join(tmpDir, "operator-adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams
    adapters.push(child)
    const stdout = collectStdoutJson(child)
    writeJson(child, initializePayload(1))
    await waitForCondition(() => stdout.some((line) => line.id === 1), "operator adapter initialize")
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })

    const first = await connectToDaemonPid(socketPath)
    detachedDaemonPids.push(first.pid)
    await expect(
      first.client.call("cli_inbox_drain", {
        session: "@chief",
        limit: 1,
        operator_capability: capability,
      }),
    ).resolves.toMatchObject({ session: "@chief", drained_count: 0 })
    await expect(
      first.client.call("cli_inbox_drain", {
        session: "@chief",
        limit: 1,
        operator_capability: "must-not-cross-the-spawn-boundary",
      }),
    ).rejects.toThrow(/authenticated current session or the configured operator capability/i)

    await first.client.call("tribe.restart", { reason: "operator capability lifecycle test" })
    first.client.close()
    const successor = await connectToDaemonPid(socketPath, (pid) => pid !== first.pid)
    detachedDaemonPids.push(successor.pid)
    await expect(
      successor.client.call("cli_inbox_drain", {
        session: "@chief",
        limit: 1,
        operator_capability: capability,
      }),
    ).resolves.toMatchObject({ session: "@chief", drained_count: 0 })
    successor.client.close()
  }, 60_000)

  it("drains the managed launch mailbox instead of a foreign environment identity when MCP is unavailable", async () => {
    const socketPath = join(tmpDir, "managed-cli-inbox.sock")
    const dbPath = join(tmpDir, "managed-cli-inbox.db")
    const capability = "managed-cli-inbox-secret"
    const capabilityPath = join(tmpDir, "managed-cli-inbox-capability")
    const ownLaunchId = "managed-cli-own-launch"
    const spawnTimeName = "@agent/3-spawn"
    const runtimeName = "@agent/3-runtime"
    const foreignName = "@agent/foreign"

    writeFileSync(capabilityPath, capability, { mode: 0o600 })
    const daemonCapabilityFd = openSync(capabilityPath, "r")
    daemonProc = spawnDaemon(socketPath, dbPath, { operatorCapabilityFd: daemonCapabilityFd })
    closeSync(daemonCapabilityFd)
    await waitForCondition(() => existsSync(socketPath), "daemon socket")

    // This test process stands in for one long-lived provider parent. The MCP
    // adapter is its direct child, while the recovery CLI intentionally runs
    // through an extra package/shim parent. Its ppid therefore cannot be the
    // launch key: the daemon must derive the authoritative parent pid from its
    // persisted launch row. A second launch supplies the hostile environment
    // identity to ignore.
    const own = await spawnLaunchAdapter(socketPath, "managed-cli-own.log", ownLaunchId, {
      name: spawnTimeName,
    })
    const foreign = await spawnLaunchAdapter(socketPath, "managed-cli-foreign.log", "managed-cli-foreign-launch", {
      name: foreignName,
    })
    await callLaunchToolWhenRegistered(own, 60, "members", {})
    await callLaunchToolWhenRegistered(foreign, 61, "members", {})
    await callLaunchTool(own, 62, "rename", { new_name: runtimeName })

    // Simulate the reported recovery state: the managed launch remains in the
    // daemon's durable authority store, but its MCP transport is unavailable.
    own.child.kill("SIGTERM")
    await once(own.child, "exit")

    const fixtureDb = openDatabase(dbPath)
    const fixtureStatements = createStatements(fixtureDb)
    const now = Date.now()
    for (const [id, recipient, content] of [
      ["managed-cli-own-request", runtimeName, "own launch request"],
      ["managed-cli-foreign-request", foreignName, "foreign launch request"],
    ] as const) {
      fixtureStatements.insertMessage.run({
        $id: id,
        $type: "request",
        $sender: "@chief",
        $recipient: recipient,
        $kind: "direct",
        $content: content,
        $bead_id: null,
        $ref: null,
        $ts: now,
        $delivery: "pull",
        $topic: null,
        $room_id: null,
        $request: id,
        $reply: null,
        $summary: null,
      })
    }
    fixtureDb.close()

    const cliEnv = {
      ...BASE_ENV,
      TRIBE_SOCKET: socketPath,
      TRIBE_LAUNCH_ID: ownLaunchId,
      // Neither mutable identity hint may select the mailbox.
      TRIBE_NAME: foreignName,
      TRIBE_SESSION_NAME: foreignName,
      TRIBE_NO_AUTOSTART: "1",
    }
    const statusRun = await runCli(["inbox-status", "--json"], cliEnv, { throughParent: true })
    expect(statusRun.exitCode, statusRun.stderr).toBe(0)
    expect(JSON.parse(statusRun.stdout)).toMatchObject({ session: runtimeName, unread_count: 1 })

    const waitRun = await runCli(["inbox-wait", "--timeout", "0s", "--json"], cliEnv, { throughParent: true })
    expect(waitRun.exitCode, waitRun.stderr).toBe(0)
    expect(JSON.parse(waitRun.stdout)).toMatchObject({ session: runtimeName, unread_count: 1, timed_out: false })

    const drainRun = await runCli(["inbox-drain", "--json"], cliEnv, {
      operatorCapabilityPath: capabilityPath,
      throughParent: true,
    })
    expect(drainRun.exitCode, drainRun.stderr).toBe(0)

    const drained = JSON.parse(drainRun.stdout) as {
      session: string
      drained_count: number
      unread_count: number
      events: Array<{ content: string }>
    }
    expect(drained).toMatchObject({
      session: runtimeName,
      drained_count: 1,
      unread_count: 0,
      events: [{ content: "own launch request" }],
    })

    const observer = await connectToDaemon(socketPath)
    await expect(observer.call("cli_inbox_status", { session: foreignName })).resolves.toMatchObject({
      session: foreignName,
      unread_count: 1,
    })
    observer.close()

    const membershipDb = openDatabase(dbPath)
    const sessions = membershipDb.prepare("SELECT name, launch_id FROM sessions ORDER BY name").all() as Array<{
      name: string
      launch_id: string | null
    }>
    membershipDb.close()
    expect(sessions).toEqual([
      { name: runtimeName, launch_id: `${ownLaunchId}::${encodeURIComponent(spawnTimeName)}` },
      {
        name: foreignName,
        launch_id: `managed-cli-foreign-launch::${encodeURIComponent(foreignName)}`,
      },
    ])
  }, 60_000)

  it("successor takeover closes the base role ball through daemon-derived launch ownership", async () => {
    const socketPath = join(tmpDir, "successor-reply.sock")
    const dbPath = join(tmpDir, "successor-reply.db")
    const launchId = "successor-reply-launch"
    const requestId = "successor-reply-request"

    daemonProc = spawnDaemon(socketPath, dbPath)
    await waitForCondition(() => existsSync(socketPath), "daemon socket")

    const successor = await spawnLaunchAdapter(socketPath, "successor-reply.log", launchId, {
      name: "@chief/next",
    })
    await callLaunchToolWhenRegistered(successor, 70, "members", {})
    await callLaunchTool(successor, 71, "rename", { new_name: "@chief" })

    const requester = await connectToDaemon(socketPath)
    await requester.call("register", {
      name: "@agent/3",
      role: "member",
      domains: ["test"],
      project: tmpDir,
      projectName: "test",
      protocolVersion: TRIBE_PROTOCOL_VERSION,
      pid: process.pid,
      delivery: "pull",
    })
    await requester.call("tribe.send", {
      to: "@chief",
      message: "please answer after takeover",
      type: "request",
      summary: "successor takeover request",
      request: requestId,
    })
    requester.close()

    const reply = await runCli(
      [
        "send",
        "@agent/3",
        "answered after takeover",
        "--type",
        "response",
        "--summary",
        "successor takeover answer",
        "--reply",
        requestId,
      ],
      {
        ...BASE_ENV,
        TRIBE_SOCKET: socketPath,
        TRIBE_LAUNCH_ID: launchId,
        // Both spawn-time hints are intentionally stale after takeover.
        TRIBE_NAME: "@chief/next",
        TRIBE_SESSION_NAME: "@chief/next",
        TRIBE_NO_AUTOSTART: "1",
      },
      { throughParent: true },
    )

    expect(reply.exitCode, reply.stderr).toBe(0)
    expect(reply.stdout).toContain(`Closed 1 pending request row(s) for @chief: ${requestId}`)

    const notify = await runCli(
      ["send", "@agent/3", "post-takeover checkpoint", "--type", "notify", "--summary", "post-takeover checkpoint"],
      {
        ...BASE_ENV,
        TRIBE_SOCKET: socketPath,
        TRIBE_LAUNCH_ID: launchId,
        TRIBE_NAME: "@chief/next",
        TRIBE_SESSION_NAME: "@chief/next",
        TRIBE_NO_AUTOSTART: "1",
      },
      { throughParent: true },
    )
    expect(notify.exitCode, notify.stderr).toBe(0)

    const db = openDatabase(dbPath)
    const remaining = db
      .prepare("SELECT COUNT(*) AS count FROM pending_request WHERE recipient = ? AND request_id = ?")
      .get("@chief", requestId) as { count: number }
    const attributed = db.prepare("SELECT sender FROM messages WHERE content = ?").get("post-takeover checkpoint") as {
      sender: string
    }
    db.close()
    expect(remaining.count).toBe(0)
    expect(attributed.sender).toBe("@chief")
  }, 60_000)

  it("routes attributed CLI replies from two personas sharing one provider launch", async () => {
    const socketPath = join(tmpDir, "shared-launch-personas.sock")
    const dbPath = join(tmpDir, "shared-launch-personas.db")
    const launchId = "shared-persona-launch"
    const personas = ["@chief", "@cto"] as const

    daemonProc = spawnDaemon(socketPath, dbPath)
    await waitForCondition(() => existsSync(socketPath), "shared-persona daemon socket")

    const seats = await Promise.all(
      personas.map((name) => spawnLaunchAdapter(socketPath, `shared-persona-${name.slice(1)}.log`, launchId, { name })),
    )
    const firstSeat = seats.at(0)
    if (firstSeat === undefined) throw new Error("shared-persona journey started no seats")
    const members = (await callLaunchToolWhenRegistered(firstSeat, 80, "members", {})) as {
      sessions?: Array<{ name?: string; launch_id?: string; launch_parent_pid?: number }>
    }
    for (const persona of personas) {
      expect(members.sessions?.find((session) => session.name === persona)).toMatchObject({
        launch_id: `${launchId}::${encodeURIComponent(persona)}`,
        launch_parent_pid: process.pid,
      })
    }

    const requester = await connectToDaemon(socketPath)
    await requester.call("register", {
      name: "@requester",
      role: "member",
      domains: ["test"],
      project: tmpDir,
      projectName: "test",
      protocolVersion: TRIBE_PROTOCOL_VERSION,
      pid: process.pid,
      delivery: "pull",
    })

    try {
      for (const [index, persona] of personas.entries()) {
        const requestId = `shared-persona-request-${index}`
        const replyText = `reply from ${persona}`
        await requester.call("tribe.send", {
          to: persona,
          message: `request for ${persona}`,
          type: "request",
          summary: `request for ${persona}`,
          request: requestId,
        })

        const reply = await runCli(
          ["send", "@requester", replyText, "--type", "response", "--summary", replyText, "--reply", requestId],
          {
            ...BASE_ENV,
            TRIBE_SOCKET: socketPath,
            TRIBE_LAUNCH_ID: launchId,
            TRIBE_NAME: persona,
            TRIBE_SESSION_NAME: persona,
            TRIBE_NO_AUTOSTART: "1",
          },
          { throughParent: true },
        )
        expect(reply.exitCode, reply.stderr).toBe(0)
        expect(reply.stdout).toContain(`Closed 1 pending request row(s) for ${persona}: ${requestId}`)

        const log = await runCli(["log", "--json", "--reply-prefix", requestId], {
          ...BASE_ENV,
          TRIBE_SOCKET: socketPath,
          TRIBE_NO_AUTOSTART: "1",
        })
        expect(log.exitCode, log.stderr).toBe(0)
        const snapshot = JSON.parse(log.stdout) as {
          messages: Array<{ sender?: string; content?: string; reply?: string }>
        }
        expect(snapshot.messages).toEqual([
          expect.objectContaining({ sender: persona, content: replyText, reply: requestId }),
        ])
      }
    } finally {
      requester.close()
    }
  }, 60_000)

  it("claiming a parked name forwards actionable and response attention without ambient replay", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const dbPath = join(tmpDir, "tribe.db")
    seedAttentionFixture(dbPath)

    daemonProc = spawnDaemon(socketPath, dbPath)
    await waitForCondition(() => existsSync(socketPath), "daemon socket")

    // --- First adapter: the claim must recover both durable attention rows.
    const first = await spawnAdapterAndJoin(socketPath, "adapter-1.log")
    await waitForCondition(
      () => channelNotifications(first.stdout).length >= 2,
      "recovered attention channel notifications",
    )
    // Settle: give any (wrong) ambient replay a chance to arrive, then assert
    // the recovered attention rows are alone.
    await new Promise((resolveTick) => setTimeout(resolveTick, 500))
    const forwarded = channelNotifications(first.stdout)
    const payloads = forwarded.map((line) => JSON.stringify(line))
    expect(payloads.some((p) => p.includes("please pick up the wrapper-r4 assembly"))).toBe(true)
    expect(payloads.some((p) => p.includes("use the durable attention seam"))).toBe(true)
    expect(payloads.some((p) => p.includes("joined (member)"))).toBe(false)
    expect(payloads.some((p) => p.includes("log-redacted"))).toBe(false)
    expect(forwarded).toHaveLength(2)

    // --- Second adapter (fresh process = reconnect/reclaim): mailbox is acked,
    // so NOTHING is forwarded.
    first.child.kill("SIGTERM")
    const second = await spawnAdapterAndJoin(socketPath, "adapter-2.log")
    await new Promise((resolveTick) => setTimeout(resolveTick, 700))
    expect(channelNotifications(second.stdout)).toHaveLength(0)
  }, 60_000)

  it("surfaces an obligation sent while a persona process is stopped to its successor process", async () => {
    const socketPath = join(tmpDir, "stopped-persona.sock")
    const dbPath = join(tmpDir, "stopped-persona.db")
    daemonProc = spawnDaemon(socketPath, dbPath)
    await waitForCondition(() => existsSync(socketPath), "daemon socket")

    const launchId = "stopped-persona-launch"
    const initial = await spawnLaunchAdapter(socketPath, "stopped-persona-initial.log", launchId, { name: NAME })
    await callLaunchToolWhenRegistered(initial, 10, "members", {})
    initial.child.kill("SIGTERM")
    await once(initial.child, "exit")

    const chief = await spawnLaunchAdapter(socketPath, "stopped-persona-chief.log", "stopped-persona-chief", {
      name: "@chief",
    })
    await callLaunchToolWhenRegistered(chief, 20, "members", {})
    const sent = (await callLaunchTool(chief, 21, "send", {
      to: NAME,
      message: "resume the durable stopped-persona review",
      type: "request",
      request: true,
    })) as { id?: string }
    expect(sent.id).toEqual(expect.any(String))

    const successor = await spawnLaunchAdapter(socketPath, "stopped-persona-successor.log", launchId, { name: NAME })
    const fetched = (await callLaunchToolWhenRegistered(successor, 30, "fetch", { limit: 10 })) as {
      attention?: {
        actionable_unread?: Array<{ id?: string; type?: string; from?: string }>
        pending_balls?: Array<{ request_id?: string; message_id?: string; sender?: string }>
      }
    }
    expect(fetched.attention?.actionable_unread).toEqual([
      expect.objectContaining({ id: sent.id, type: "request", from: "@chief" }),
    ])
    expect(fetched.attention?.pending_balls).toEqual([
      expect.objectContaining({ request_id: sent.id, message_id: sent.id, sender: "@chief" }),
    ])
  }, 60_000)

  it("fans three native adapters from one provider launch into one live member", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const dbPath = join(tmpDir, "tribe.db")
    daemonProc = spawnDaemon(socketPath, dbPath)
    await waitForCondition(() => existsSync(socketPath), "daemon socket")

    const launchId = "provider-launch-a"
    const launchAdapters = await Promise.all([
      spawnLaunchAdapter(socketPath, "launch-adapter-1.log", launchId),
      spawnLaunchAdapter(socketPath, "launch-adapter-2.log", launchId),
      spawnLaunchAdapter(socketPath, "launch-adapter-3.log", launchId),
    ])

    // Force every transport through daemon registration, then give displaced
    // transports time to reconnect. A provider launch is one logical member:
    // none of its independently spawned MCP adapters may evict another.
    for (const [index, adapter] of launchAdapters.entries()) {
      writeJson(adapter.child, callToolPayload(index + 2, "members", {}))
    }
    await waitForCondition(
      () =>
        launchAdapters.every((adapter, index) => adapter.stdout.some((line) => line.id === index + 2)) ||
        (existsSync(join(tmpDir, "daemon.log")) &&
          readFileSync(join(tmpDir, "daemon.log"), "utf8").includes(`takeover: superseding live holder of "${NAME}"`)),
      "all same-launch members responses or a takeover violation",
    )

    const exitCodes = launchAdapters.map(({ child }) => child.exitCode)
    const logs = launchAdapters.map(({ logPath }) => (existsSync(logPath) ? readFileSync(logPath, "utf8") : ""))
    expect(exitCodes, logs.join("\n--- adapter ---\n")).toEqual([null, null, null])
    const daemonLog = readFileSync(join(tmpDir, "daemon.log"), "utf8")
    expect(daemonLog).not.toContain(`takeover: superseding live holder of "${NAME}"`)

    for (const [index, adapter] of launchAdapters.entries()) {
      const id = index + 2
      await waitForCondition(
        () => adapter.stdout.some((line) => line.id === id),
        `adapter ${index + 1} members response`,
      )
      const result = toolResult(adapter.stdout, id) as { sessions?: Array<{ name?: string; alive?: boolean }> }
      expect(result.sessions?.filter((session) => session.name === NAME && session.alive)).toHaveLength(1)
    }

    const members = (await callLaunchToolWhenRegistered(launchAdapters[0]!, 20, "members", {})) as {
      sessions?: Array<{
        name?: string
        member_id?: string
        launch_id?: string
        launch_parent_pid?: number
        transport_pids?: number[]
      }>
    }
    const member = members.sessions?.find((session) => session.name === NAME)
    expect(member).toMatchObject({
      launch_id: `${launchId}::${encodeURIComponent(NAME)}`,
      launch_parent_pid: process.pid,
    })
    expect(member?.member_id).toEqual(expect.any(String))
    const initialMemberId = member!.member_id!
    expect(member?.transport_pids?.toSorted((a, b) => a - b)).toEqual(
      launchAdapters.map(({ child }) => child.pid!).toSorted((a, b) => a - b),
    )
    const health = (await callLaunchToolWhenRegistered(launchAdapters[1]!, 19, "health", {})) as {
      members?: Array<{
        name?: string
        member_id?: string
        launch_id?: string
        launch_parent_pid?: number
        transport_pids?: number[]
      }>
    }
    expect(health.members?.find((session) => session.name === NAME)).toMatchObject({
      member_id: initialMemberId,
      launch_id: `${launchId}::${encodeURIComponent(NAME)}`,
      launch_parent_pid: process.pid,
      transport_pids: expect.arrayContaining(launchAdapters.map(({ child }) => child.pid!)),
    })

    const sent = (await callLaunchTool(launchAdapters[0]!, 21, "send", {
      to: NAME,
      message: "same-launch fan-in request",
      type: "request",
      request: true,
    })) as { id?: string }
    expect(sent.id).toEqual(expect.any(String))
    const [pending, fetched] = (await Promise.all([
      callLaunchTool(launchAdapters[1]!, 22, "pending", { owner: NAME }),
      callLaunchToolWhenRegistered(launchAdapters[2]!, 23, "fetch", { ids: [sent.id], limit: 50 }),
    ])) as [{ pending?: Array<{ request_id?: string }> }, { events?: Array<{ id?: string; content?: string }> }]
    expect(pending.pending?.some((request) => request.request_id === sent.id)).toBe(true)
    expect(
      fetched.events?.some((event) => event.id === sent.id && event.content === "same-launch fan-in request"),
    ).toBe(true)

    // A one-shot CLI inherits the managed launch environment in native Codex,
    // but it is not a member transport and cannot claim the persona as its
    // sender. Sending and then exiting must not claim, evict, or announce
    // departure for the logical launch that owns the live MCP adapters.
    const cli = spawn(BUN_BIN, [CLI, "send", NAME, "one-shot same-name query", "--type", "query"], {
      cwd: tmpDir,
      env: {
        ...BASE_ENV,
        TRIBE_SOCKET: socketPath,
        TRIBE_NAME: NAME,
        TRIBE_TAKEOVER: "1",
        TRIBE_LAUNCH_ID: launchId,
        TRIBE_NO_AUTOSTART: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let cliStderr = ""
    cli.stderr.on("data", (chunk: Buffer | string) => {
      cliStderr += chunk.toString()
    })
    await once(cli, "exit")
    expect(cli.exitCode, cliStderr).toBe(0)
    expect(launchAdapters.map(({ child }) => child.exitCode)).toEqual([null, null, null])
    const afterCli = await Promise.all(
      launchAdapters.map((adapter, index) => callLaunchToolWhenRegistered(adapter, 50 + index, "members", {})),
    )
    for (const result of afterCli as Array<{
      sessions?: Array<{ name?: string; member_id?: string; launch_id?: string; transport_pids?: number[] }>
    }>) {
      expect(result.sessions?.find((session) => session.name === NAME)).toMatchObject({
        member_id: initialMemberId,
        launch_id: `${launchId}::${encodeURIComponent(NAME)}`,
        transport_pids: expect.arrayContaining(launchAdapters.map(({ child }) => child.pid!)),
      })
    }
    expect(readFileSync(join(tmpDir, "activity.jsonl"), "utf8")).not.toContain(`${NAME} left`)

    const lifecycleRowsBefore = readLifecycleRows(dbPath)
    const cliJoin = await runCli(["join", NAME, "--domain", "test-lean", "--delivery", "pull", "--json"], {
      ...BASE_ENV,
      TRIBE_SOCKET: socketPath,
      TRIBE_NAME: NAME,
      TRIBE_TAKEOVER: "1",
      TRIBE_LAUNCH_ID: launchId,
      TRIBE_NO_AUTOSTART: "1",
    })
    expect(cliJoin.exitCode, cliJoin.stderr).toBe(0)
    expect(JSON.parse(cliJoin.stdout)).toMatchObject({
      joined: true,
      observed: true,
      name: NAME,
      memberId: initialMemberId,
    })
    expect(launchAdapters.map(({ child }) => child.exitCode)).toEqual([null, null, null])
    expect(readLifecycleRows(dbPath)).toEqual(lifecycleRowsBefore)

    // Replacing one transport inside the same provider launch retains the
    // logical member and restores the three-transport diagnostic set.
    launchAdapters[1]!.child.kill("SIGTERM")
    await once(launchAdapters[1]!.child, "exit")
    const replacement = await spawnLaunchAdapter(socketPath, "launch-adapter-2b.log", launchId)
    launchAdapters[1] = replacement
    const afterReconnect = (await callLaunchToolWhenRegistered(replacement, 24, "members", {})) as {
      sessions?: Array<{ name?: string; member_id?: string; launch_id?: string; transport_pids?: number[] }>
    }
    expect(afterReconnect.sessions?.find((session) => session.name === NAME)).toMatchObject({
      member_id: initialMemberId,
      launch_id: `${launchId}::${encodeURIComponent(NAME)}`,
      transport_pids: expect.arrayContaining(launchAdapters.map(({ child }) => child.pid!)),
    })

    // A direct adapter has no host supervisor that can replace it. After the
    // daemon generation changes, all three transports must re-register in
    // process and preserve the persisted logical member.
    daemonProc.kill("SIGTERM")
    await once(daemonProc, "exit")
    await waitForCondition(() => !existsSync(socketPath), "old daemon socket removal")
    daemonProc = spawnDaemon(socketPath, dbPath)
    await waitForCondition(() => existsSync(socketPath), "restarted daemon socket")
    const afterDaemonRestart = await Promise.all(
      launchAdapters.map((adapter, index) => callLaunchToolWhenRegistered(adapter, 30 + index, "members", {})),
    )
    expect(launchAdapters.map(({ child }) => child.exitCode)).toEqual([null, null, null])
    for (const result of afterDaemonRestart as Array<{
      sessions?: Array<{ name?: string; member_id?: string; launch_id?: string; transport_pids?: number[] }>
    }>) {
      expect(result.sessions?.filter((session) => session.name === NAME)).toHaveLength(1)
      expect(result.sessions?.find((session) => session.name === NAME)).toMatchObject({
        member_id: initialMemberId,
        launch_id: `${launchId}::${encodeURIComponent(NAME)}`,
        transport_pids: expect.arrayContaining(launchAdapters.map(({ child }) => child.pid!)),
      })
    }

    // A different provider launch must fail loud without takeover.
    const refused = await spawnLaunchAdapter(socketPath, "launch-b-refused.log", "provider-launch-b", {
      takeover: false,
    })
    writeJson(refused.child, callToolPayload(40, "members", {}))
    await waitForCondition(() => refused.child.exitCode !== null, "different launch refusal exit")
    expect(refused.child.exitCode).toBe(2)
    expect(readFileSync(refused.logPath, "utf8")).toContain(`Name "${NAME}" is already taken by live pid`)

    // A deliberate new launch with takeover supersedes the whole old launch
    // as one set, leaving no suffixed or -dead- session rows.
    const successor = await spawnLaunchAdapter(socketPath, "launch-b-successor.log", "provider-launch-b")
    const successorMembers = (await callLaunchToolWhenRegistered(successor, 41, "members", {})) as {
      sessions?: Array<{ name?: string; member_id?: string; launch_id?: string; transport_pids?: number[] }>
    }
    await waitForCondition(
      () => launchAdapters.every(({ child }) => child.exitCode !== null),
      "superseded launch adapters to exit",
    )
    expect(successorMembers.sessions?.filter((session) => session.name === NAME)).toEqual([
      expect.objectContaining({
        launch_id: "provider-launch-b",
        transport_pids: [successor.child.pid],
      }),
    ])
    expect(successorMembers.sessions?.find((session) => session.name === NAME)?.member_id).not.toBe(initialMemberId)
    const db = openDatabase(dbPath)
    const rows = db.prepare("SELECT name FROM sessions ORDER BY name").all() as Array<{ name: string }>
    db.close()
    expect(rows).toEqual([{ name: NAME }])
    const finalDaemonLog = readFileSync(join(tmpDir, "daemon.log"), "utf8")
    expect(finalDaemonLog.match(/takeover: superseding live holder/g)).toHaveLength(1)
    // Heaviest journey: it drives a daemon restart + three transport re-execs +
    // respawns + a cross-launch takeover, each gated on real subprocess timing.
  }, 120_000)

  it("fans three plugin-supervised MCP transports from one native provider without closing stdio", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const dbPath = join(tmpDir, "tribe.db")
    daemonProc = spawnDaemon(socketPath, dbPath)
    await waitForCondition(() => existsSync(socketPath), "daemon socket")

    const launchId = "plugin-supervised-provider-launch"
    const first = await spawnLaunchAdapter(socketPath, "plugin-adapter-1.log", launchId, {
      throughPluginSupervisor: true,
    })
    await callLaunchToolWhenRegistered(first, 2, "members", {})
    const second = await spawnLaunchAdapter(socketPath, "plugin-adapter-2.log", launchId, {
      throughPluginSupervisor: true,
    })
    await callLaunchToolWhenRegistered(second, 3, "members", {})
    const third = await spawnLaunchAdapter(socketPath, "plugin-adapter-3.log", launchId, {
      throughPluginSupervisor: true,
    })
    const members = (await callLaunchToolWhenRegistered(third, 4, "members", {})) as {
      sessions?: Array<{
        name?: string
        launch_id?: string
        launch_parent_pid?: number
        transport_pids?: number[]
      }>
    }
    const member = members.sessions?.find((session) => session.name === NAME)

    // This is the production topology that direct-adapter coverage misses:
    // three host-spawned plugin wrappers must stay callable as transports of
    // one launch, even though each wrapper has its own ephemeral PID.
    await waitForCondition(
      () => first.child.exitCode !== null || second.child.exitCode !== null || member?.transport_pids?.length === 3,
      "three supervised transports or a closed predecessor",
    )
    const logs = [first, second, third]
      .map(({ logPath }) => (existsSync(logPath) ? readFileSync(logPath, "utf8") : ""))
      .join("\n--- plugin adapter ---\n")
    expect([first.child.exitCode, second.child.exitCode, third.child.exitCode], logs).toEqual([null, null, null])
    expect(member).toMatchObject({
      launch_id: `${launchId}::${encodeURIComponent(NAME)}`,
      launch_parent_pid: process.pid,
    })
    expect(member?.transport_pids).toHaveLength(3)
    expect(readFileSync(join(tmpDir, "daemon.log"), "utf8")).not.toContain(
      `takeover: superseding live holder of "${NAME}"`,
    )

    await Promise.all([callLaunchTool(first, 5, "members", {}), callLaunchTool(second, 6, "members", {})])
  }, 30_000)

  it("does not adopt a dead launch when a new provider inherits its stale launch id", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const dbPath = join(tmpDir, "tribe.db")
    daemonProc = spawnDaemon(socketPath, dbPath)
    await waitForCondition(() => existsSync(socketPath), "daemon socket")

    const staleLaunchId = "stale-dead-provider-launch"
    const first = await spawnLaunchAdapter(socketPath, "stale-launch-1.log", staleLaunchId)
    const firstMembers = (await callLaunchToolWhenRegistered(first, 50, "members", {})) as {
      sessions?: Array<{ name?: string; member_id?: string }>
    }
    const firstMemberId = firstMembers.sessions?.find((session) => session.name === NAME)?.member_id
    expect(firstMemberId).toEqual(expect.any(String))
    first.child.kill("SIGTERM")
    await once(first.child, "exit")

    const inherited = await spawnLaunchAdapter(socketPath, "stale-launch-2.log", staleLaunchId, {
      distinctProviderParent: true,
    })
    const inheritedMembers = (await callLaunchToolWhenRegistered(inherited, 51, "members", {})) as {
      sessions?: Array<{ name?: string; member_id?: string; launch_id?: string }>
    }
    const inheritedMember = inheritedMembers.sessions?.find((session) => session.name === NAME)
    expect(inheritedMember).toMatchObject({
      launch_id: `${staleLaunchId}::${encodeURIComponent(NAME)}`,
    })
    expect(inheritedMember?.member_id).toEqual(expect.any(String))
    expect(inheritedMember?.member_id).not.toBe(firstMemberId)
  }, 60_000)
})
