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
const child = spawn(command[0], command.slice(1), { env: process.env })
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
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
  delete env.AG_SESSION_AUTH
  delete env.TRIBE_DELIVERY_FALLBACKS
  return env
})()

function settlementFacts(dbPath: string): Array<Record<string, unknown>> {
  const db = openDatabase(dbPath)
  try {
    return (
      db
        .prepare("SELECT content FROM messages WHERE kind = 'event' AND type = 'event.ball.settled' ORDER BY ts, id")
        .all() as Array<{ content: string }>
    ).map((row) => JSON.parse(row.content) as Record<string, unknown>)
  } finally {
    db.close()
  }
}

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

/** 21757 — the recipient's durable mailbox cursor and its attention-read
 *  receipt, straight from SQLite; null when no read or ack ever happened. */
function mailboxCursor(
  dbPath: string,
  name: string,
): { last_actionable_seq: number; last_attention_read_at: number | null } | null {
  const db = openDatabase(dbPath)
  try {
    return db
      .prepare("SELECT last_actionable_seq, last_attention_read_at FROM mailbox_cursors WHERE recipient = ?")
      .get(name) as { last_actionable_seq: number; last_attention_read_at: number | null } | null
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

  const daemonStderr = new WeakMap<ChildProcessWithoutNullStreams, string[]>()

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
    }) as ChildProcessWithoutNullStreams
    // Boot failures were invisible: stderr is piped but was never read, and
    // DEBUG_LOG only exists once the logger is up — a daemon that dies while
    // bun is still loading its module graph leaves NO evidence anywhere.
    // Collect stderr so waitForDaemonSocket can tell "crashed at boot" from
    // "still booting" instead of reporting an evidence-free timeout.
    const stderrChunks: string[] = []
    proc.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(chunk.toString())
    })
    daemonStderr.set(proc, stderrChunks)
    return proc
  }

  /**
   * CI flake, fourth rotating member (run 31771243082 attempt 1): the
   * parked-name journey died at `timed out waiting for daemon socket` — the
   * bare `existsSync(socketPath)` wait raced the daemon's cold start, before
   * any adapter existed, so this is NOT the transport_pids convergence class
   * the other members shared. The socket file only appears after bun loads
   * the daemon's whole module graph and the config→database→recall pipeline
   * initializes; under full-suite contention on a 4-vCPU runner that cold
   * start can outlive the shared 30s waitForCondition budget (every
   * neighboring test in the same run booted in 1-3s — this is tail latency,
   * not steady state). A daemon that crashed at boot produces byte-identical
   * evidence (no socket, ever), so the treatment is budget + instruments in
   * one: a wider boot-only ceiling (the poll returns the instant the socket
   * exists, so it is free when healthy), fail-fast the moment the daemon
   * process exits instead of burning the remaining budget, and an error
   * carrying exit code + stderr + DEBUG_LOG tail so slow-boot vs crashed-boot
   * is classifiable from the failure itself next time.
   */
  async function waitForDaemonSocket(
    proc: ChildProcessWithoutNullStreams,
    socketPath: string,
    label = "daemon socket",
  ): Promise<void> {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline && proc.exitCode === null) {
      if (existsSync(socketPath)) return
      await new Promise((resolveTick) => setTimeout(resolveTick, 25))
    }
    if (existsSync(socketPath)) return
    const logPath = join(tmpDir, "daemon.log")
    const logTail = existsSync(logPath)
      ? readFileSync(logPath, "utf8").split("\n").slice(-30).join("\n")
      : "(no daemon log)"
    const stderrTail = (daemonStderr.get(proc)?.join("") ?? "").slice(-4_000) || "(empty)"
    throw new Error(
      `${proc.exitCode === null ? `timed out waiting for ${label}` : `daemon exited before creating ${label}`}; ` +
        `exit=${String(proc.exitCode)}\n--- daemon stderr ---\n${stderrTail}\n--- daemon log tail ---\n${logTail}`,
    )
  }

  async function spawnAdapterAndJoin(
    socketPath: string,
    logName: string,
    opts: { delivery?: "push" | "pull" } = {},
  ): Promise<{ child: ChildProcessWithoutNullStreams; stdout: Record<string, unknown>[] }> {
    const child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath], {
      cwd: tmpDir,
      env: {
        ...BASE_ENV,
        TRIBE_LAUNCH_ID: "",
        TRIBE_NAME: "",
        TRIBE_SESSION_NAME: "",
        // 21757: a pull adapter still receives the daemon's wakeup and still
        // runs the full drain, but sendChannel no-ops — the dark pane.
        TRIBE_DELIVERY: opts.delivery ?? "push",
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
      selfMailboxAuthority?: string
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
          ...(opts.selfMailboxAuthority === undefined ? {} : { AG_SESSION_AUTH: opts.selfMailboxAuthority }),
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
    ) as ChildProcessWithoutNullStreams
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

  /**
   * `callLaunchToolWhenRegistered` only proves the ONE adapter it is called
   * against has its own transport registered — it says nothing about whether
   * the daemon's shared member record has also caught up with every OTHER
   * concurrently (re)connecting transport for the same logical member. A
   * multi-adapter convergence check (transport_pids containing every sibling
   * adapter's pid) that fires right after a concurrent spawn, replace, or
   * daemon-restart step races that catch-up window: the queried adapter can
   * legitimately answer before a sibling's registration has committed.
   * Poll the same call until `ready` accepts the parsed result instead of
   * asserting on the first successful round trip (@km/tribe/ci-deflake-wire-daemon).
   */
  async function callLaunchToolUntil<T>(
    adapter: { child: ChildProcessWithoutNullStreams; stdout: Record<string, unknown>[]; logPath: string },
    firstId: number,
    name: string,
    args: Record<string, unknown>,
    ready: (result: T) => boolean,
    label: string,
  ): Promise<T> {
    const deadline = Date.now() + 30_000
    let id = firstId
    for (;;) {
      const result = (await callLaunchToolWhenRegistered(adapter, id, name, args)) as T
      if (ready(result)) return result
      if (Date.now() >= deadline) throw new Error(`${label}: content never converged within deadline`)
      id += 1_000
      await Bun.sleep(250)
    }
  }

  async function runCli(
    args: string[],
    env: NodeJS.ProcessEnv,
    opts: { operatorCapabilityPath?: string; selfMailboxAuthority?: string; throughParent?: boolean } = {},
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
        ...(opts.selfMailboxAuthority === undefined ? {} : { AG_SESSION_AUTH: opts.selfMailboxAuthority }),
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
    const observerName = "@notification-diet"
    daemonProc = spawnDaemon(socketPath, dbPath)
    await waitForDaemonSocket(daemonProc, socketPath)

    const observer = await spawnLaunchAdapter(
      socketPath,
      "notification-diet-observer.log",
      "notification-diet-launch",
      {
        name: observerName,
        delivery: "push",
        filterMode: "focus",
      },
    )
    await callLaunchToolWhenRegistered(observer, 2, "members", {})
    const beforeAmbient = sessionDeliveryOffsets(dbPath, observerName)

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
        const sent = (await sender.call("tribe.send", {
          to: observerName,
          message: ambientCase.content,
          type: ambientCase.type,
          summary: ambientCase.content,
        })) as { structuredContent?: Record<string, unknown> }
        expect(sent.structuredContent).toMatchObject({ sent: true })
      }
      const afterAmbient = sessionDeliveryOffsets(dbPath, observerName)
      expect(afterAmbient).toEqual(beforeAmbient)
      for (const ambientCase of ambientCases) {
        expect(
          channelNotifications(observer.stdout).some((line) => JSON.stringify(line).includes(ambientCase.content)),
        ).toBe(false)
      }

      writeJson(observer.child, callToolPayload(3, "fetch", {}))
      await waitForCondition(() => observer.stdout.some((line) => line.id === 3), "observer fetch response")
      const fetched = toolResult(observer.stdout, 3) as { events?: Array<{ content?: string }> }
      for (const ambientCase of ambientCases) {
        expect(fetched.events?.some((event) => event.content === ambientCase.content)).toBe(true)
      }

      for (const type of ["request", "query", "assign", "verdict"]) {
        const content = `${type} actionable diet row`
        const sent = (await sender.call("tribe.send", {
          to: observerName,
          message: content,
          type,
          summary: content,
        })) as { structuredContent?: Record<string, unknown> }
        expect(sent.structuredContent).toMatchObject({ sent: true })
        await waitForCondition(
          () => channelNotifications(observer.stdout).some((line) => JSON.stringify(line).includes(content)),
          `${type} observer wake`,
        )
      }
      expect(sessionDeliveryOffsets(dbPath, observerName).last_delivered_seq).toBeGreaterThan(
        afterAmbient.last_delivered_seq,
      )
    } finally {
      sender.close()
    }
  }, 90_000)

  it("preserves daemon-owned operator authority through standalone hot reload", async () => {
    const socketPath = join(tmpDir, "operator-lifecycle.sock")
    const dbPath = join(tmpDir, "operator-lifecycle.db")
    const capability = "operator-lifecycle-secret"
    const capabilityPath = join(tmpDir, "operator-capability")
    writeFileSync(capabilityPath, capability, { mode: 0o600 })
    const capabilityFd = openSync(capabilityPath, "r")
    daemonProc = spawnDaemon(socketPath, dbPath, { operatorCapabilityFd: capabilityFd })
    closeSync(capabilityFd)
    await waitForDaemonSocket(daemonProc, socketPath, "operator lifecycle daemon socket")

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
    // A capability IS configured here (read from FD 3, "operator-lifecycle-
    // secret" above) and this call supplies a different, wrong value — that
    // is the "rejected" verdict, not "unconfigured". 0c2acf65 ("fix(tribe):
    // distinguish unavailable inbox authority") deliberately split the old
    // single generic message into these two; this assertion just never got
    // updated to the new one (@km/tribe/ci-green-wire-codepin).
    await expect(
      first.client.call("cli_inbox_drain", {
        session: "@chief",
        limit: 1,
        operator_capability: "must-not-cross-the-spawn-boundary",
      }),
    ).rejects.toThrow(/unauthenticated inbox drain: the operator capability was rejected/i)

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
  }, 120_000)

  it("drains the managed launch mailbox instead of a foreign environment identity when MCP is unavailable", async () => {
    const socketPath = join(tmpDir, "managed-cli-inbox.sock")
    const dbPath = join(tmpDir, "managed-cli-inbox.db")
    const ownAuthority = "managed-cli-own-secret-00000000000000000000"
    const successorAuthority = "managed-cli-successor-secret-00000000000000"
    const foreignAuthority = "managed-cli-foreign-secret-0000000000000000"
    const ownLaunchId = "managed-cli-own-launch"
    const spawnTimeName = "@agent/3-spawn"
    const runtimeName = "@agent/3-runtime"
    const foreignName = "@agent/foreign"

    daemonProc = spawnDaemon(socketPath, dbPath)
    await waitForDaemonSocket(daemonProc, socketPath)

    // This test process stands in for one long-lived provider parent. The MCP
    // adapter is its direct child, while the recovery CLI intentionally runs
    // through an extra package/shim parent. Its ppid therefore cannot be the
    // launch key: the daemon must derive the authoritative parent pid from its
    // persisted launch row. A second launch supplies the hostile environment
    // identity to ignore.
    const own = await spawnLaunchAdapter(socketPath, "managed-cli-own.log", ownLaunchId, {
      name: spawnTimeName,
      throughPluginSupervisor: true,
      selfMailboxAuthority: ownAuthority,
    })
    const foreign = await spawnLaunchAdapter(socketPath, "managed-cli-foreign.log", "managed-cli-foreign-launch", {
      name: foreignName,
      selfMailboxAuthority: foreignAuthority,
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

    const absentAuthority = await runCli(["inbox", "--json"], cliEnv, { throughParent: true })
    expect(absentAuthority.exitCode).toBe(1)
    expect(absentAuthority.stderr).toMatch(/AG_SESSION_AUTH.*missing/i)

    const foreignRead = await runCli(["inbox", "--json"], cliEnv, {
      selfMailboxAuthority: foreignAuthority,
      throughParent: true,
    })
    expect(foreignRead.exitCode, foreignRead.stderr).toBe(0)
    const foreignEvents = (JSON.parse(foreignRead.stdout) as { events: Array<{ content: string }> }).events
    expect(foreignEvents.some((event) => event.content === "foreign launch request")).toBe(true)
    expect(foreignEvents.some((event) => event.content === "own launch request")).toBe(false)
    const postForeignObserver = await connectToDaemon(socketPath)
    await expect(postForeignObserver.call("cli_inbox_status", { session: runtimeName })).resolves.toMatchObject({
      session: runtimeName,
      unread_count: 1,
    })
    postForeignObserver.close()

    const drainRun = await runCli(["inbox", "--json"], cliEnv, {
      selfMailboxAuthority: ownAuthority,
      throughParent: true,
    })
    expect(drainRun.exitCode, drainRun.stderr).toBe(0)

    const drained = JSON.parse(drainRun.stdout) as {
      attention: { actionable_unread: Array<{ content: string }> }
      events: Array<{ content: string }>
    }
    expect(drained.attention.actionable_unread).toEqual([expect.objectContaining({ content: "own launch request" })])
    expect(drained.events.some((event) => event.content === "own launch request")).toBe(true)
    expect(drained.events.some((event) => event.content === "foreign launch request")).toBe(false)

    const secondRead = await runCli(["inbox", "--json"], cliEnv, {
      selfMailboxAuthority: ownAuthority,
      throughParent: true,
    })
    expect(secondRead.exitCode, secondRead.stderr).toBe(0)
    expect(JSON.parse(secondRead.stdout)).toMatchObject({ attention: { actionable_unread: [] }, events: [] })

    const successor = await spawnLaunchAdapter(socketPath, "managed-cli-successor.log", ownLaunchId, {
      name: spawnTimeName,
      throughPluginSupervisor: true,
      selfMailboxAuthority: successorAuthority,
    })
    await callLaunchToolWhenRegistered(successor, 63, "members", {})

    const revokedRead = await runCli(["inbox", "--json"], cliEnv, {
      selfMailboxAuthority: ownAuthority,
      throughParent: true,
    })
    expect(revokedRead.exitCode).toBe(1)
    expect(revokedRead.stderr).toMatch(/authority was rejected or revoked/i)

    const successorRead = await runCli(["inbox", "--json"], cliEnv, {
      selfMailboxAuthority: successorAuthority,
      throughParent: true,
    })
    expect(successorRead.exitCode, successorRead.stderr).toBe(0)
    expect(JSON.parse(successorRead.stdout)).toMatchObject({ attention: { actionable_unread: [] }, events: [] })

    const humanRead = await runCli(["inbox"], cliEnv, {
      selfMailboxAuthority: successorAuthority,
      throughParent: true,
    })
    expect(humanRead.exitCode, humanRead.stderr).toBe(0)
    expect(humanRead.stdout).toContain("inbox: 0 actionable unread; 0 pending ball(s)")

    const observer = await connectToDaemon(socketPath)
    await expect(observer.call("cli_inbox_status", { session: foreignName })).resolves.toMatchObject({
      session: foreignName,
      unread_count: 0,
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
  }, 120_000)

  it("successor takeover closes the base role ball through daemon-derived launch ownership", async () => {
    const socketPath = join(tmpDir, "successor-reply.sock")
    const dbPath = join(tmpDir, "successor-reply.db")
    const launchId = "successor-reply-launch"
    const requestId = "successor-reply-request"

    daemonProc = spawnDaemon(socketPath, dbPath)
    await waitForDaemonSocket(daemonProc, socketPath)

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
  }, 120_000)

  it("authenticates managed CLI pending reads and closes through the session authority bearer", async () => {
    const socketPath = join(tmpDir, "managed-cli-pending-close.sock")
    const dbPath = join(tmpDir, "managed-cli-pending-close.db")
    const owner = "@agent/pending-owner"
    const sender = "@agent/pending-sender"
    const thirdPersona = "@agent/pending-third"
    const ownerAuthority = "o".repeat(43)
    const senderAuthority = "s".repeat(43)
    const thirdPersonaAuthority = "t".repeat(43)
    const ownerRequestId = "11111111-1111-4111-8111-111111111111"
    const senderRequestId = "22222222-2222-4222-8222-222222222222"
    const thirdPersonaRequestId = "33333333-3333-4333-8333-333333333333"
    const missingAuthorityRequestId = "44444444-4444-4444-8444-444444444444"
    const rejectedAuthorityRequestId = "55555555-5555-4555-8555-555555555555"

    daemonProc = spawnDaemon(socketPath, dbPath)
    await waitForDaemonSocket(daemonProc, socketPath)

    const ownerAdapter = await spawnLaunchAdapter(socketPath, "managed-cli-pending-owner.log", "pending-owner-launch", {
      name: owner,
      selfMailboxAuthority: ownerAuthority,
    })
    const senderAdapter = await spawnLaunchAdapter(
      socketPath,
      "managed-cli-pending-sender.log",
      "pending-sender-launch",
      { name: sender, selfMailboxAuthority: senderAuthority },
    )
    const thirdPersonaAdapter = await spawnLaunchAdapter(
      socketPath,
      "managed-cli-pending-third.log",
      "pending-third-launch",
      { name: thirdPersona, selfMailboxAuthority: thirdPersonaAuthority },
    )
    await callLaunchToolWhenRegistered(ownerAdapter, 70, "members", {})
    await callLaunchToolWhenRegistered(senderAdapter, 71, "members", {})
    await callLaunchToolWhenRegistered(thirdPersonaAdapter, 72, "members", {})

    const open = async (id: number, requestId: string) => {
      const result = (await callLaunchToolWhenRegistered(senderAdapter, id, "send", {
        to: owner,
        message: `tracked ${requestId}`,
        type: "request",
        summary: `tracked ${requestId}`,
        request: requestId,
      })) as { sent?: boolean }
      expect(result.sent).toBe(true)
    }
    const cliEnv = {
      ...BASE_ENV,
      TRIBE_SOCKET: socketPath,
      TRIBE_NAME: "@agent/hostile-hint",
      TRIBE_SESSION_NAME: "@agent/hostile-hint",
      TRIBE_LAUNCH_ID: "hostile-launch-hint",
      TRIBE_NO_AUTOSTART: "1",
    }

    await open(73, ownerRequestId)
    const expiryDb = openDatabase(dbPath)
    try {
      expiryDb.prepare("UPDATE pending_request SET expires_at = 0 WHERE request_id = ?").run(ownerRequestId)
    } finally {
      expiryDb.close()
    }

    // Regression-class detector: every implicit seat-scoped one-shot read
    // resolves the authenticated current session or refuses; it never answers
    // for the transport's pending-* placeholder identity.
    // retire-when: one-shot CLI transports cannot acquire a pending-* context
    // before current-session authentication by construction.
    //
    // @ag/tribe/expired-pending-loses-identity: the exact managed-seat
    // reproduction has no --owner. Only daemon-authenticated current-session
    // resolution can return the owner's known expired ball instead of a
    // plausible count:0 for nobody.
    const implicitOwner = await runCli(["pending", "--expired", "--owed", "--json"], cliEnv, {
      selfMailboxAuthority: ownerAuthority,
      throughParent: true,
    })
    expect(implicitOwner.exitCode, implicitOwner.stderr).toBe(0)
    expect(JSON.parse(implicitOwner.stdout)).toMatchObject({
      owner,
      expired: true,
      owed: true,
      count: 1,
      pending: [expect.objectContaining({ request_id: ownerRequestId, recipient: owner, backing: "live" })],
    })

    const beforeOwnerClose = await runCli(["pending", "--owner", owner, "--expired", "--owed", "--json"], cliEnv, {
      throughParent: true,
    })
    expect(beforeOwnerClose.exitCode, beforeOwnerClose.stderr).toBe(0)
    expect(JSON.parse(beforeOwnerClose.stdout)).toMatchObject({
      owner,
      expired: true,
      owed: true,
      count: 1,
      pending: [expect.objectContaining({ request_id: ownerRequestId, sender, recipient: owner, backing: "live" })],
    })

    const missingAuthority = await runCli(["pending", "--expired", "--owed", "--json"], cliEnv, {
      throughParent: true,
    })
    expect(missingAuthority.exitCode).toBe(2)
    expect(missingAuthority.stdout).toBe("")
    expect(missingAuthority.stderr).toBe(
      "tribe pending: current session authority is missing; AG_SESSION_AUTH must be inherited from the managed launch. " +
        "No pending query ran. For an explicit recovery or audit read, run " +
        "'tribe pending --owner <seat> --expired --owed --json'.\n",
    )

    const rejectedAuthority = await runCli(["pending", "--expired", "--owed", "--json"], cliEnv, {
      selfMailboxAuthority: "x".repeat(43),
      throughParent: true,
    })
    expect(rejectedAuthority.exitCode).toBe(2)
    expect(rejectedAuthority.stdout).toBe("")
    expect(rejectedAuthority.stderr).toBe(
      "tribe pending: current session authority was rejected or revoked; AG_SESSION_AUTH did not match a live managed session. " +
        "No pending query ran. For an explicit recovery or audit read, run " +
        "'tribe pending --owner <seat> --expired --owed --json'.\n",
    )

    const malformedAuthority = await runCli(["pending", "--expired", "--owed", "--json"], cliEnv, {
      selfMailboxAuthority: "bad",
      throughParent: true,
    })
    expect(malformedAuthority.exitCode).toBe(2)
    expect(malformedAuthority.stdout).toBe("")
    expect(malformedAuthority.stderr).toBe(
      "tribe pending: AG_SESSION_AUTH must be a 32-byte base64url bearer. No pending query ran. " +
        "For an explicit recovery or audit read, run " +
        "'tribe pending --owner <seat> --expired --owed --json'.\n",
    )

    const ownerClose = await runCli(["pending", "--owner", owner, "--close", ownerRequestId, "--json"], cliEnv, {
      selfMailboxAuthority: ownerAuthority,
      throughParent: true,
    })
    expect(ownerClose.exitCode, ownerClose.stderr).toBe(0)
    expect(JSON.parse(ownerClose.stdout)).toMatchObject({
      owner,
      request_id: ownerRequestId,
      closed: 1,
    })

    await open(74, senderRequestId)
    const senderClose = await runCli(["pending", "--owner", owner, "--close", senderRequestId, "--json"], cliEnv, {
      selfMailboxAuthority: senderAuthority,
      throughParent: true,
    })
    expect(senderClose.exitCode, senderClose.stderr).toBe(0)
    expect(JSON.parse(senderClose.stdout)).toMatchObject({
      owner,
      request_id: senderRequestId,
      closed: 1,
    })

    await open(75, thirdPersonaRequestId)
    const thirdPersonaClose = await runCli(["pending", "--owner", owner, "--close", thirdPersonaRequestId], cliEnv, {
      selfMailboxAuthority: thirdPersonaAuthority,
      throughParent: true,
    })
    expect(thirdPersonaClose.exitCode).toBe(2)
    expect(thirdPersonaClose.stdout).toBe("")
    expect(thirdPersonaClose.stderr).toBe(
      `tribe pending: tribe.pending: refusing --close before mutation: authenticated caller ${JSON.stringify(thirdPersona)} ` +
        `is neither owner ${JSON.stringify(owner)} nor original sender ${JSON.stringify(sender)} for ball ` +
        `${JSON.stringify(thirdPersonaRequestId)}. Allowed closers are the owner (manual-close) or original sender ` +
        `(sender-withdrawn); ball ${JSON.stringify(thirdPersonaRequestId)} remains open, and no pending row was mutated.\n`,
    )

    await open(76, missingAuthorityRequestId)
    const missingClose = await runCli(
      ["pending", "--owner", owner, "--close", missingAuthorityRequestId, "--json"],
      cliEnv,
      { throughParent: true },
    )
    expect(missingClose.exitCode).toBe(2)
    expect(missingClose.stdout).toBe("")
    expect(missingClose.stderr).toBe(
      `tribe pending: current session authority is missing; AG_SESSION_AUTH must be inherited from the managed launch\n`,
    )

    await open(77, rejectedAuthorityRequestId)
    const rejectedClose = await runCli(
      ["pending", "--owner", owner, "--close", rejectedAuthorityRequestId, "--json"],
      cliEnv,
      { selfMailboxAuthority: "x".repeat(43), throughParent: true },
    )
    expect(rejectedClose.exitCode).toBe(2)
    expect(rejectedClose.stdout).toBe("")
    expect(rejectedClose.stderr).toBe(
      `tribe pending: current session authority was rejected or revoked; AG_SESSION_AUTH did not match a live managed session\n`,
    )

    const overrideProbe = await connectToDaemon(socketPath)
    try {
      const placeholderRead = (await overrideProbe.call("tribe.pending", {
        expired: true,
        owed: true,
      })) as { structuredContent?: { owner?: string; error?: string; count?: number } }
      expect(placeholderRead.structuredContent).toMatchObject({
        owner: expect.stringMatching(/^pending-/u),
        error: expect.stringContaining("implicit owner resolved to an unauthenticated one-shot session"),
      })
      expect(placeholderRead.structuredContent).not.toHaveProperty("count")

      const nullOwnerRead = (await overrideProbe.call("tribe.pending", {
        owner: null,
        expired: true,
        owed: true,
      })) as { structuredContent?: { owner?: string; error?: string; count?: number } }
      expect(nullOwnerRead.structuredContent).toMatchObject({
        owner: expect.stringMatching(/^pending-/u),
        error: expect.stringContaining("implicit owner resolved to an unauthenticated one-shot session"),
      })
      expect(nullOwnerRead.structuredContent).not.toHaveProperty("count")

      const invalidFilter = (await overrideProbe.call("cli_session_pending_read_v1", {
        authority: ownerAuthority,
        owed: true,
      })) as { structuredContent?: { owner?: string; error?: string; count?: number } }
      expect(invalidFilter.structuredContent).toMatchObject({
        owner,
        error: "tribe.pending: owed filters the expired view; pass expired: true.",
      })
      expect(invalidFilter.structuredContent).not.toHaveProperty("count")

      for (const [field, value, message] of [
        ["expired", "yes", "Authenticated pending read filter 'expired' must be boolean"],
        ["owed", 1, "Authenticated pending read filter 'owed' must be boolean"],
        ["stale_ms", -1, "Authenticated pending read filter 'stale_ms' must be a finite non-negative number"],
      ] as const) {
        await expect(
          overrideProbe.call("cli_session_pending_read_v1", {
            authority: ownerAuthority,
            [field]: value,
          }),
        ).rejects.toThrow(message)
      }

      await expect(
        overrideProbe.call("cli_session_pending_read_v1", {
          authority: ownerAuthority,
          owner: sender,
          expired: true,
          owed: true,
        }),
      ).rejects.toThrow(/pending read derives owner identity from authority; owner override is forbidden/i)
      await expect(
        overrideProbe.call("cli_session_pending_close_v1", {
          authority: ownerAuthority,
          owner,
          close: rejectedAuthorityRequestId,
          prune: true,
        }),
      ).rejects.toThrow(/identity and non-close operation overrides are forbidden/i)
    } finally {
      overrideProbe.close()
    }

    expect(settlementFacts(dbPath)).toEqual([
      expect.objectContaining({
        request_id: ownerRequestId,
        recipient: owner,
        sender,
        settlement: "manual-close",
        settled_by: owner,
      }),
      expect.objectContaining({
        request_id: senderRequestId,
        recipient: owner,
        sender,
        settlement: "sender-withdrawn",
        settled_by: sender,
      }),
    ])
    const db = openDatabase(dbPath)
    try {
      const remaining = db
        .prepare("SELECT request_id FROM pending_request WHERE recipient = ? ORDER BY request_id")
        .all(owner) as Array<{ request_id: string }>
      expect(remaining).toEqual([
        { request_id: thirdPersonaRequestId },
        { request_id: missingAuthorityRequestId },
        { request_id: rejectedAuthorityRequestId },
      ])
      const refusedEvents = db
        .prepare(
          "SELECT type, sender, ref, content FROM messages " +
            "WHERE type IN ('event.ball.close-refused', 'event.session.capability-refused') ORDER BY rowid",
        )
        .all() as Array<{ type: string; sender: string; ref: string | null; content: string }>
      expect(refusedEvents.map((event) => ({ ...event, content: JSON.parse(event.content) }))).toEqual([
        {
          type: "event.ball.close-refused",
          sender: thirdPersona,
          ref: thirdPersonaRequestId,
          content: expect.objectContaining({
            reason: "caller-not-owner-or-original-sender",
            caller: thirdPersona,
            owner,
            request_id: thirdPersonaRequestId,
            original_sender: sender,
            pending_mutation: "none",
          }),
        },
        {
          type: "event.session.capability-refused",
          sender: "daemon",
          ref: missingAuthorityRequestId,
          content: expect.objectContaining({
            capability: "pending-close",
            reason: "session-authority-missing",
            authority_env: "AG_SESSION_AUTH",
            owner,
            attempted_ids: [missingAuthorityRequestId],
            pending_mutation: "none",
          }),
        },
        {
          type: "event.session.capability-refused",
          sender: "daemon",
          ref: rejectedAuthorityRequestId,
          content: expect.objectContaining({
            capability: "pending-close",
            reason: "session-authority-rejected",
            authority_env: "AG_SESSION_AUTH",
            owner,
            attempted_ids: [rejectedAuthorityRequestId],
            pending_mutation: "none",
          }),
        },
      ])
    } finally {
      db.close()
    }
  }, 120_000)

  it("routes attributed CLI replies from two personas sharing one provider launch", async () => {
    const socketPath = join(tmpDir, "shared-launch-personas.sock")
    const dbPath = join(tmpDir, "shared-launch-personas.db")
    const launchId = "shared-persona-launch"
    const personas = ["@chief", "@cto"] as const

    daemonProc = spawnDaemon(socketPath, dbPath)
    await waitForDaemonSocket(daemonProc, socketPath, "shared-persona daemon socket")

    const seats = await Promise.all(
      personas.map((name) => spawnLaunchAdapter(socketPath, `shared-persona-${name.slice(1)}.log`, launchId, { name })),
    )
    const firstSeat = seats.at(0)
    if (firstSeat === undefined) throw new Error("shared-persona journey started no seats")
    // Same first-round-trip class as the transport_pids races treated in the
    // fans-three journey below: the two persona adapters spawned concurrently,
    // and callLaunchToolWhenRegistered only proves the QUERIED seat's own
    // registration — @cto's can still be in flight when @chief's first members
    // call answers. Poll until the shared member record lists every persona
    // before asserting on its contents.
    const members = await callLaunchToolUntil<{
      sessions?: Array<{ name?: string; launch_id?: string; launch_parent_pid?: number }>
    }>(
      firstSeat,
      80,
      "members",
      {},
      (result) => personas.every((persona) => result.sessions?.some((session) => session.name === persona)),
      "shared-launch persona registration convergence",
    )
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
  }, 120_000)

  it("claiming a parked name forwards actionable and response attention without ambient replay", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const dbPath = join(tmpDir, "tribe.db")
    seedAttentionFixture(dbPath)

    daemonProc = spawnDaemon(socketPath, dbPath)
    await waitForDaemonSocket(daemonProc, socketPath)

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

    // --- Second adapter (fresh process = reconnect/reclaim). 21757: the first
    // adapter's drain forwarded fire-and-forget and was not a model read, so
    // the mailbox is NOT acknowledged — both rows are forwarded again. Before
    // 21757 this asserted toHaveLength(0): the drain had acked rows no model
    // had seen, which is how eight officer rows were lost on 2026-09-02.
    first.child.kill("SIGTERM")
    expect(mailboxCursor(dbPath, NAME)?.last_actionable_seq ?? 0).toBe(0)
    const second = await spawnAdapterAndJoin(socketPath, "adapter-2.log")
    await waitForCondition(
      () => channelNotifications(second.stdout).length >= 2,
      "re-forwarded attention after an un-receipted drain",
    )
    await new Promise((resolveTick) => setTimeout(resolveTick, 500))
    expect(channelNotifications(second.stdout)).toHaveLength(2)

    // --- The model's own read through the second adapter IS the receipt: an
    // MCP fetch (CallTool) delivers the rows into its context and acknowledges.
    writeJson(second.child, callToolPayload(3, "fetch", {}))
    await waitForCondition(() => second.stdout.some((line) => line.id === 3), "model fetch response")
    expect(mailboxCursor(dbPath, NAME)?.last_actionable_seq ?? 0).toBeGreaterThan(0)

    // --- Third adapter: acknowledged by a model read, so NOTHING is forwarded.
    second.child.kill("SIGTERM")
    const third = await spawnAdapterAndJoin(socketPath, "adapter-3.log")
    await new Promise((resolveTick) => setTimeout(resolveTick, 700))
    expect(channelNotifications(third.stdout)).toHaveLength(0)
  }, 120_000)

  it("a dark pane drains without acknowledging: the rows stay owed, visible to the idle gate, until the model's own read (21757)", async () => {
    // The 2026-09-02 class: the adapter receives the daemon's wakeup, drains,
    // and forwards into a pane that never renders. A pull adapter reproduces
    // it with zero daemon changes — it gets the wakeup and runs the full
    // drain while sendChannel no-ops.
    const socketPath = join(tmpDir, "tribe.sock")
    const dbPath = join(tmpDir, "tribe.db")
    seedAttentionFixture(dbPath)
    daemonProc = spawnDaemon(socketPath, dbPath)
    await waitForDaemonSocket(daemonProc, socketPath)

    const dark = await spawnAdapterAndJoin(socketPath, "adapter-dark.log", { delivery: "pull" })
    // Positive control that the drain actually ran: its fetch advances the
    // AMBIENT session cursor past the seeded broadcasts. Without this the
    // assertions below pass trivially on an adapter that ignored the wakeup.
    await waitForCondition(
      () => sessionDeliveryOffsets(dbPath, NAME).last_inbox_pull_seq > 0,
      "dark adapter's drain advanced the ambient cursor",
    )
    await new Promise((resolveTick) => setTimeout(resolveTick, 500))
    expect(channelNotifications(dark.stdout)).toHaveLength(0)
    // Not acknowledged and not a read receipt.
    const afterDrain = mailboxCursor(dbPath, NAME)
    expect(afterDrain?.last_actionable_seq ?? 0).toBe(0)
    expect(afterDrain?.last_attention_read_at ?? null).toBeNull()
    // The idle gate's half of the bug: the Stop hook reads inbox-status
    // unread_count, and it must still see both rows.
    const statusEnv = { ...BASE_ENV, TRIBE_SOCKET: socketPath, TRIBE_NO_AUTOSTART: "1" }
    const statusRun = await runCli(["inbox-status", "--session", NAME, "--json"], statusEnv)
    expect(statusRun.exitCode, statusRun.stderr).toBe(0)
    expect(JSON.parse(statusRun.stdout)).toMatchObject({ session: NAME, unread_count: 2 })

    // A live pane claiming the name is forwarded both rows.
    dark.child.kill("SIGTERM")
    const lit = await spawnAdapterAndJoin(socketPath, "adapter-lit.log", { delivery: "push" })
    await waitForCondition(() => channelNotifications(lit.stdout).length >= 2, "forwarded after the dark drain")
    await new Promise((resolveTick) => setTimeout(resolveTick, 500))
    expect(channelNotifications(lit.stdout)).toHaveLength(2)

    // The model's own read acknowledges; the third adapter and the idle gate see nothing.
    writeJson(lit.child, callToolPayload(3, "fetch", {}))
    await waitForCondition(() => lit.stdout.some((line) => line.id === 3), "model fetch response")
    expect(mailboxCursor(dbPath, NAME)?.last_actionable_seq ?? 0).toBeGreaterThan(0)
    lit.child.kill("SIGTERM")
    const third = await spawnAdapterAndJoin(socketPath, "adapter-third.log")
    await new Promise((resolveTick) => setTimeout(resolveTick, 700))
    expect(channelNotifications(third.stdout)).toHaveLength(0)
    const statusAfter = await runCli(["inbox-status", "--session", NAME, "--json"], statusEnv)
    expect(statusAfter.exitCode, statusAfter.stderr).toBe(0)
    expect(JSON.parse(statusAfter.stdout)).toMatchObject({ session: NAME, unread_count: 0 })
  }, 150_000)

  it("keeps pull obligations readable while a managed persona transport is stopped", async () => {
    const socketPath = join(tmpDir, "stopped-persona.sock")
    const dbPath = join(tmpDir, "stopped-persona.db")
    daemonProc = spawnDaemon(socketPath, dbPath)
    await waitForDaemonSocket(daemonProc, socketPath)

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
      delivery: "pull",
    })) as { id?: string }
    expect(sent).toMatchObject({ id: expect.any(String) })

    const waitRun = await runCli(
      ["inbox-wait", "--timeout", "0s", "--json"],
      {
        ...BASE_ENV,
        TRIBE_SOCKET: socketPath,
        TRIBE_LAUNCH_ID: launchId,
        TRIBE_NAME: NAME,
        TRIBE_NO_AUTOSTART: "1",
      },
      { throughParent: true },
    )
    expect(waitRun.exitCode, waitRun.stderr).toBe(0)
    expect(JSON.parse(waitRun.stdout)).toMatchObject({ session: NAME, unread_count: 1, timed_out: false })

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
  }, 120_000)

  it("keeps a quiet connection-scoped pull mailbox readable after its transport leaves", async () => {
    const socketPath = join(tmpDir, "quiet-pull.sock")
    const dbPath = join(tmpDir, "quiet-pull.db")
    daemonProc = spawnDaemon(socketPath, dbPath)
    await waitForDaemonSocket(daemonProc, socketPath)

    const chief = await spawnLaunchAdapter(socketPath, "quiet-pull-chief.log", "quiet-pull-chief", {
      name: "@chief",
    })
    await callLaunchToolWhenRegistered(chief, 10, "members", {})

    // No launch id means this is the CLI-rail lifetime: the real adapter
    // registers a connection-scoped pull member, sends once, then leaves.
    const quietName = "@quiet-pull"
    const quiet = await spawnLaunchAdapter(socketPath, "quiet-pull-member.log", undefined, {
      name: quietName,
      delivery: "pull",
    })
    await callLaunchToolWhenRegistered(quiet, 20, "members", {})
    await callLaunchTool(quiet, 21, "send", {
      to: "@chief",
      message: "connection-scoped mailbox is ready",
      type: "notify",
    })
    quiet.child.kill("SIGTERM")
    await once(quiet.child, "exit")

    // Reproduce the actual missed case, not the fresh-join grace case: keep
    // the current session registration but age every journal fact authored by
    // the member beyond the recent-activity recognition window.
    const db = openDatabase(dbPath)
    try {
      expect(
        db.prepare("SELECT name, launch_id, launch_parent_pid, delivery FROM sessions WHERE name = ?").get(quietName),
      ).toEqual({ name: quietName, launch_id: null, launch_parent_pid: null, delivery: "pull" })
      db.prepare("UPDATE messages SET ts = ? WHERE sender = ?").run(Date.now() - 5 * 60 * 60_000, quietName)
    } finally {
      db.close()
    }

    const sent = (await callLaunchTool(chief, 30, "send", {
      to: quietName,
      message: "first request in hours to the quiet pull mailbox",
      type: "request",
      request: true,
      delivery: "pull",
    })) as { id?: string; delivery?: { state?: string; recipient?: string } }
    expect(sent).toMatchObject({
      id: expect.any(String),
      delivery: { state: "offline", recipient: quietName },
    })

    const waitRun = await runCli(
      ["inbox-wait", "--session", quietName, "--timeout", "0s", "--json"],
      {
        ...BASE_ENV,
        TRIBE_SOCKET: socketPath,
        TRIBE_NO_AUTOSTART: "1",
      },
      { throughParent: true },
    )
    expect(waitRun.exitCode, waitRun.stderr).toBe(0)
    expect(JSON.parse(waitRun.stdout)).toMatchObject({
      session: quietName,
      unread_count: 1,
      timed_out: false,
    })
  }, 120_000)

  it("fans three native adapters from one provider launch into one live member", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const dbPath = join(tmpDir, "tribe.db")
    daemonProc = spawnDaemon(socketPath, dbPath)
    await waitForDaemonSocket(daemonProc, socketPath)

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
      // The concurrent id=2..4 calls above deliberately fire before any
      // registration is proven (they double as the takeover provocation), so a
      // first response can legitimately be the adapter's "awaiting daemon
      // registration" gate error instead of a members payload — the same
      // first-round-trip class as the transport_pids polls below. Re-ask
      // through the registration-aware helper instead of failing on gate text.
      let result: { sessions?: Array<{ name?: string; alive?: boolean }> }
      try {
        result = toolResult(adapter.stdout, id) as typeof result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const registrationPending =
          message.includes("awaiting daemon registration") || message.includes("daemon connection closed; reconnecting")
        if (!registrationPending) throw error
        result = (await callLaunchToolWhenRegistered(adapter, 200 + index, "members", {})) as typeof result
      }
      expect(result.sessions?.filter((session) => session.name === NAME && session.alive)).toHaveLength(1)
    }

    const members = await callLaunchToolUntil<{
      sessions?: Array<{
        name?: string
        member_id?: string
        launch_id?: string
        launch_parent_pid?: number
        transport_pids?: number[]
      }>
    }>(
      launchAdapters[0]!,
      20,
      "members",
      {},
      (result) =>
        (result.sessions?.find((session) => session.name === NAME)?.transport_pids?.length ?? 0) ===
        launchAdapters.length,
      "same-launch member transport_pids convergence",
    )
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
    const afterReconnect = await callLaunchToolUntil<{
      sessions?: Array<{ name?: string; member_id?: string; launch_id?: string; transport_pids?: number[] }>
    }>(
      replacement,
      24,
      "members",
      {},
      (result) =>
        (result.sessions?.find((session) => session.name === NAME)?.transport_pids?.length ?? 0) ===
        launchAdapters.length,
      "post-replace member transport_pids convergence",
    )
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
    await waitForDaemonSocket(daemonProc, socketPath, "restarted daemon socket")
    // Each adapter reconnects and re-registers with the fresh daemon
    // independently; Promise.all resolves each leg on its OWN transport_pids
    // convergence, not merely on that adapter's own call succeeding, so a
    // slower sibling can never be observed as still-missing.
    const afterDaemonRestart = await Promise.all(
      launchAdapters.map((adapter, index) =>
        callLaunchToolUntil<{
          sessions?: Array<{ name?: string; member_id?: string; launch_id?: string; transport_pids?: number[] }>
        }>(
          adapter,
          30 + index,
          "members",
          {},
          (result) =>
            (result.sessions?.find((session) => session.name === NAME)?.transport_pids?.length ?? 0) ===
            launchAdapters.length,
          `post-restart member transport_pids convergence (adapter ${index + 1})`,
        ),
      ),
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
        launch_id: `provider-launch-b::${encodeURIComponent(NAME)}`,
        transport_pids: [successor.child.pid],
      }),
    ])
    expect(successorMembers.sessions?.find((session) => session.name === NAME)?.member_id).not.toBe(initialMemberId)
    const db = openDatabase(dbPath)
    const rows = db.prepare("SELECT name FROM sessions ORDER BY name").all() as Array<{ name: string }>
    db.close()
    expect(rows).toEqual([{ name: NAME }])

    // Replacing or reconnecting an adapter from the displaced launch must not
    // replay the launch's inherited takeover bit. The launch already consumed
    // that authority before the daemon restart above; each fresh transport
    // now fails closed while the deliberate successor remains authoritative.
    for (let attempt = 0; attempt < 2; attempt++) {
      const replay = await spawnLaunchAdapter(socketPath, `displaced-launch-replay-${attempt + 1}.log`, launchId)
      writeJson(replay.child, callToolPayload(42 + attempt, "members", {}))
      await waitForCondition(() => replay.child.exitCode !== null, `displaced launch replay ${attempt + 1} exit`)
      expect(replay.child.exitCode, readFileSync(replay.logPath, "utf8")).toBe(2)
      expect(successor.child.exitCode).toBeNull()

      const current = (await callLaunchTool(successor, 44 + attempt, "members", {})) as {
        sessions?: Array<{ name?: string; launch_id?: string; transport_pids?: number[] }>
      }
      expect(current.sessions?.filter((session) => session.name === NAME)).toEqual([
        expect.objectContaining({
          launch_id: `provider-launch-b::${encodeURIComponent(NAME)}`,
          transport_pids: [successor.child.pid],
        }),
      ])
    }

    const finalDaemonLog = readFileSync(join(tmpDir, "daemon.log"), "utf8")
    expect(finalDaemonLog.match(/takeover: superseding live holder/g)).toHaveLength(1)
    // Heaviest journey: it drives a daemon restart + three transport re-execs +
    // respawns + a cross-launch takeover, each gated on real subprocess timing.
  }, 180_000)

  it("fans three plugin-supervised MCP transports from one native provider without closing stdio", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const dbPath = join(tmpDir, "tribe.db")
    daemonProc = spawnDaemon(socketPath, dbPath)
    await waitForDaemonSocket(daemonProc, socketPath)

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
    // This is the production topology that direct-adapter coverage misses:
    // three host-spawned plugin wrappers must stay callable as transports of
    // one launch, even though each wrapper has its own ephemeral PID. The old
    // wait here closed over ONE parsed members snapshot, so its transport_pids
    // predicate could never change value — a snapshot short of three pids
    // meant a guaranteed hang into a bare outer timeout with no diagnostics.
    // Poll the live call instead (the transport_pids convergence treatment),
    // keeping the closed-predecessor disjunction so a dying wrapper still
    // exits the wait into the loud exit-code assertion below.
    const members = await callLaunchToolUntil<{
      sessions?: Array<{
        name?: string
        launch_id?: string
        launch_parent_pid?: number
        transport_pids?: number[]
      }>
    }>(
      third,
      4,
      "members",
      {},
      (result) =>
        first.child.exitCode !== null ||
        second.child.exitCode !== null ||
        result.sessions?.find((session) => session.name === NAME)?.transport_pids?.length === 3,
      "three supervised transports or a closed predecessor",
    )
    const member = members.sessions?.find((session) => session.name === NAME)
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
  }, 90_000)

  it("does not adopt a dead launch when a new provider inherits its stale launch id", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const dbPath = join(tmpDir, "tribe.db")
    daemonProc = spawnDaemon(socketPath, dbPath)
    await waitForDaemonSocket(daemonProc, socketPath)

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
  }, 120_000)
})
