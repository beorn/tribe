/**
 * 19442 undead reframe — REAL stdio-adapter journey against the REAL daemon.
 *
 * The prior unit tests stopped at the daemon selector or at a faked drain and
 * asserted the wrong invariant (forward 100 arbitrary recent rows). This
 * journey crosses the actual channel boundary: a real tribe-daemon process on
 * a tmp socket with a real SQLite journal seeded with the transcript fixture
 * (49 join broadcasts + 48 health broadcasts + 1 direct actionable), and a
 * real stdio adapter speaking MCP over stdio.
 *
 * Claiming the loaded name must surface EXACTLY the one actionable as a
 * channel notification — zero ambient replay — and a second fresh adapter
 * claiming the same name must surface NOTHING (the durable mailbox remembers
 * the acknowledgement).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createStatements, openDatabase } from "../../daemon/src/lib/database.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const ADAPTER = resolve(HERE, "../src/stdio-adapter.ts")
const DAEMON = resolve(HERE, "../../daemon/src/daemon.ts")
const BUN_BIN = process.versions.bun ? process.execPath : "bun"

const NAME = "@agent/3"

function seedVerdictFixture(dbPath: string): void {
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
  db.close()
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 8_000)
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
  return typeof text === "string" ? JSON.parse(text) : undefined
}

describe("19442 actionable-recovery journey (real daemon + real adapter)", () => {
  let tmpDir: string
  let daemonProc: ChildProcessWithoutNullStreams | undefined
  const adapters: ChildProcessWithoutNullStreams[] = []

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-recovery-journey-"))
  })

  afterEach(() => {
    for (const adapter of adapters) adapter.kill("SIGTERM")
    adapters.length = 0
    daemonProc?.kill("SIGTERM")
    daemonProc = undefined
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function spawnDaemon(socketPath: string, dbPath: string): ChildProcessWithoutNullStreams {
    const proc = spawn(BUN_BIN, [DAEMON, "--socket", socketPath, "--db", dbPath, "--foreground", "--no-lore"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_NO_PLUGINS: "1",
        TRIBE_ACTIVITY_LOG: join(tmpDir, "activity.jsonl"),
        DEBUG: "tribe:*",
        DEBUG_LOG: join(tmpDir, "daemon.log"),
        LOG_FILE: join(tmpDir, "daemon.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    return proc
  }

  async function spawnAdapterAndJoin(
    socketPath: string,
    logName: string,
  ): Promise<{ child: ChildProcessWithoutNullStreams; stdout: Record<string, unknown>[] }> {
    const child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath], {
      cwd: tmpDir,
      env: {
        ...process.env,
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
    launchId: string,
  ): Promise<{ child: ChildProcessWithoutNullStreams; stdout: Record<string, unknown>[]; logPath: string }> {
    const logPath = join(tmpDir, logName)
    const child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", NAME], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "pull",
        TRIBE_PULL_TRANSPORT: "mcp",
        TRIBE_NO_AUTOSTART: "1",
        TRIBE_REQUIRE_JOIN: "0",
        TRIBE_TAKEOVER: "1",
        TRIBE_LAUNCH_ID: launchId,
        DEBUG: "tribe:*",
        DEBUG_LOG: logPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    adapters.push(child)
    const stdout = collectStdoutJson(child)
    writeJson(child, initializePayload(1))
    await waitForCondition(() => stdout.some((line) => line.id === 1), `${logName} initialize response`)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    return { child, stdout, logPath }
  }

  it("claiming the loaded name forwards EXACTLY the one actionable; a reconnect forwards none", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const dbPath = join(tmpDir, "tribe.db")
    seedVerdictFixture(dbPath)

    daemonProc = spawnDaemon(socketPath, dbPath)
    await waitForCondition(() => existsSync(socketPath), "daemon socket")

    // --- First adapter: the claim that must recover exactly one actionable.
    const first = await spawnAdapterAndJoin(socketPath, "adapter-1.log")
    await waitForCondition(
      () => channelNotifications(first.stdout).length >= 1,
      "recovered actionable channel notification",
    )
    // Settle: give any (wrong) ambient replay a chance to arrive, then assert
    // the recovered actionable is ALONE.
    await new Promise((resolveTick) => setTimeout(resolveTick, 500))
    const forwarded = channelNotifications(first.stdout)
    const payloads = forwarded.map((line) => JSON.stringify(line))
    expect(payloads.some((p) => p.includes("please pick up the wrapper-r4 assembly"))).toBe(true)
    expect(payloads.some((p) => p.includes("joined (member)"))).toBe(false)
    expect(payloads.some((p) => p.includes("log-redacted"))).toBe(false)
    expect(forwarded).toHaveLength(1)

    // --- Second adapter (fresh process = reconnect/reclaim): mailbox is acked,
    // so NOTHING is forwarded.
    first.child.kill("SIGTERM")
    const second = await spawnAdapterAndJoin(socketPath, "adapter-2.log")
    await new Promise((resolveTick) => setTimeout(resolveTick, 700))
    expect(channelNotifications(second.stdout)).toHaveLength(0)
  }, 30_000)

  it.fails("fans three native adapters from one provider launch into one live member", async () => {
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
    await new Promise((resolveTick) => setTimeout(resolveTick, 1_000))

    const exitCodes = launchAdapters.map(({ child }) => child.exitCode)
    const logs = launchAdapters.map(({ logPath }) => (existsSync(logPath) ? readFileSync(logPath, "utf8") : ""))
    expect(exitCodes, logs.join("\n--- adapter ---\n")).toEqual([null, null, null])
    const daemonLog = readFileSync(join(tmpDir, "daemon.log"), "utf8")
    expect(daemonLog).not.toContain(`takeover: superseding live holder of "${NAME}"`)

    for (const [index, adapter] of launchAdapters.entries()) {
      const id = index + 2
      try {
        await waitForCondition(
          () => adapter.stdout.some((line) => line.id === id),
          `adapter ${index + 1} members response`,
        )
      } catch (error) {
        const log = existsSync(adapter.logPath) ? readFileSync(adapter.logPath, "utf8") : "(no adapter log)"
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; exit=${String(adapter.child.exitCode)}\n${log}`,
        )
      }
      const result = toolResult(adapter.stdout, id) as { sessions?: Array<{ name?: string; alive?: boolean }> }
      expect(result.sessions?.filter((session) => session.name === NAME && session.alive)).toHaveLength(1)
    }
  }, 30_000)
})
