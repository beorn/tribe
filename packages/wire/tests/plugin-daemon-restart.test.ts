/**
 * 21416 — literal host-plugin recovery across the daemon's real
 * close/unlink/fresh-bind SIGHUP path.
 *
 * Production safety: every process is pointed at a temporary socket/database,
 * plugins are disabled, and no production daemon is signalled.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { connectToDaemon, type DaemonClient } from "../src/client.ts"
import { TRIBE_PROTOCOL_VERSION } from "../src/lib/socket.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const DAEMON = resolve(HERE, "../../daemon/src/daemon.ts")
const PLUGIN_SERVER = resolve(HERE, "../../../plugins/claude/server.ts")
const STDIO_ADAPTER = resolve(HERE, "../src/stdio-adapter.ts")
const BUN_BIN = process.versions.bun ? process.execPath : "bun"
const PERSONA = "@agent/restart-test"

type JsonObject = Record<string, unknown>
type Member = {
  member_id?: string
  name?: string
  delivery?: "push" | "pull"
  launch_id?: string
  launch_parent_pid?: number
  transport_pids?: number[]
  transport_state?: "connected" | "disconnected"
  owner_state?: "live" | "dead" | "unknown"
}
type MembershipDiscrepancy = {
  status?: "degraded"
  connected_durable_launches?: number
  known_durable_launches?: number
  missing_count?: number
  missing?: Array<{
    member_id?: string
    name?: string
    launch_id?: string
    launch_parent_pid?: number
    state?: "missing-transport"
  }>
  meaning?: string
}
type ToolJson = {
  sessions?: Member[]
  transport_wedges?: Array<Record<string, unknown>>
  anonymous_disconnected?: number
  membership_discrepancy?: MembershipDiscrepancy
  joined?: boolean
  name?: string
  delivery?: "push" | "pull"
  id?: string
  sent?: boolean
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolveTick) => setTimeout(resolveTick, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function collectJsonLines(child: ChildProcessWithoutNullStreams): JsonObject[] {
  const lines: JsonObject[] = []
  let carry = ""
  child.stdout.on("data", (chunk: Buffer | string) => {
    const parts = (carry + chunk.toString()).split(/\r?\n/u)
    carry = parts.pop() ?? ""
    for (const line of parts) {
      try {
        lines.push(JSON.parse(line) as JsonObject)
      } catch {
        /* diagnostics never count as MCP frames */
      }
    }
  })
  return lines
}

function writeJson(child: ChildProcessWithoutNullStreams, payload: JsonObject): void {
  child.stdin.write(`${JSON.stringify(payload)}\n`)
}

function initializePayload(id: number): JsonObject {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "tribe-restart-test", version: "0" },
    },
  }
}

function callToolPayload(id: number, name: string, args: JsonObject): JsonObject {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }
}

function parseToolJson(result: unknown): ToolJson {
  const content = (result as { content?: Array<{ text?: string }> } | undefined)?.content
  const text = content?.[0]?.text
  return typeof text === "string" ? (JSON.parse(text) as ToolJson) : {}
}

function mcpToolJson(lines: JsonObject[], id: number): ToolJson {
  return parseToolJson(lines.find((line) => line.id === id)?.result)
}

async function connectToGeneration(
  socketPath: string,
  predicate: (pid: number) => boolean = () => true,
): Promise<{ client: DaemonClient; pid: number }> {
  let lastError: unknown
  const deadline = Date.now() + 15_000
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
  throw new Error(`timed out connecting to expected daemon generation: ${String(lastError)}`)
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

async function terminateTestProcess(pid: number): Promise<void> {
  if (!pidExists(pid)) return
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    return
  }
  try {
    await waitFor(() => !pidExists(pid), `test process ${pid} exit`, 2_000)
    return
  } catch {
    if (!pidExists(pid)) return
  }
  process.kill(pid, "SIGKILL")
  await waitFor(() => !pidExists(pid), `test process ${pid} forced exit`, 2_000)
}

describe("Claude plugin daemon-restart self-heal", () => {
  let tmpDir: string
  let socketPath: string
  const plugins = new Set<ChildProcessWithoutNullStreams>()
  const daemonPids = new Set<number>()
  const adapterPids = new Set<number>()

  function spawnTestDaemon(dbPath: string, logPath: string): ChildProcessWithoutNullStreams {
    const child = spawn(BUN_BIN, [DAEMON, "--socket", socketPath, "--db", dbPath, "--foreground", "--no-lore"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_NO_PLUGINS: "1",
        TRIBE_NO_AUTORELOAD: "1",
        DEBUG_LOG: logPath,
        LOG_FILE: logPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams
    child.stdout.resume()
    child.stderr.resume()
    if (child.pid) daemonPids.add(child.pid)
    return child
  }

  function spawnTestPlugin(opts: {
    dbPath: string
    logPath: string
    name: string
    launchId: string
    providerParentPid?: string
    delivery: "push" | "pull"
    requireJoin: boolean
  }): ChildProcessWithoutNullStreams {
    const child = spawn(BUN_BIN, [PLUGIN_SERVER, "--socket", socketPath, "--name", opts.name], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DB: opts.dbPath,
        TRIBE_DELIVERY: opts.delivery,
        ...(opts.delivery === "pull" ? { TRIBE_PULL_TRANSPORT: "mcp" } : {}),
        ...(opts.requireJoin ? {} : { TRIBE_REQUIRE_JOIN: "0" }),
        TRIBE_TAKEOVER: "1",
        TRIBE_LAUNCH_ID: opts.launchId,
        TRIBE_PLUGIN_ADAPTER_CHILD: "",
        ...(opts.providerParentPid === undefined
          ? { TRIBE_PLUGIN_PROVIDER_PARENT_PID: "" }
          : { TRIBE_PLUGIN_PROVIDER_PARENT_PID: opts.providerParentPid }),
        TRIBE_NO_PLUGINS: "1",
        TRIBE_NO_AUTORELOAD: "1",
        DEBUG_LOG: opts.logPath,
        LOG_FILE: opts.logPath,
        LOG_LEVEL: "info",
      },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams
    plugins.add(child)
    return child
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-plugin-restart-"))
    socketPath = join(tmpDir, "tribe.sock")
  })

  afterEach(async () => {
    if (existsSync(socketPath)) {
      try {
        const current = await connectToDaemon(socketPath, { callTimeoutMs: 500 })
        const status = (await current.call("cli_daemon")) as { pid?: number }
        if (typeof status.pid === "number") daemonPids.add(status.pid)
        current.close()
      } catch {
        /* no reachable daemon remains */
      }
    }
    for (const plugin of plugins) {
      const pluginPid = plugin.pid
      plugin.kill("SIGTERM")
      if (pluginPid) await terminateTestProcess(pluginPid)
    }
    for (const pid of adapterPids) await terminateTestProcess(pid)
    for (const pid of daemonPids) await terminateTestProcess(pid)
    plugins.clear()
    adapterPids.clear()
    daemonPids.clear()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("keeps host stdio, re-execs the adapter, and rejoins the same member after close/unlink/fresh-bind", async () => {
    const dbPath = join(tmpDir, "tribe.db")
    const daemonLog = join(tmpDir, "daemon.log")
    const adapterLog = join(tmpDir, "adapter.log")
    spawnTestDaemon(dbPath, daemonLog)
    await waitFor(() => existsSync(socketPath), "initial daemon socket")
    const firstDaemon = await connectToGeneration(socketPath)
    daemonPids.add(firstDaemon.pid)

    const harnessParentPid = process.ppid
    expect(harnessParentPid).not.toBe(process.pid)
    const plugin = spawnTestPlugin({
      dbPath,
      logPath: adapterLog,
      name: PERSONA,
      launchId: "restart-journey-launch",
      providerParentPid: String(harnessParentPid),
      delivery: "push",
      requireJoin: true,
    })
    let pluginStderr = ""
    plugin.stderr.on("data", (chunk: Buffer | string) => {
      pluginStderr += chunk.toString()
    })
    const stdout = collectJsonLines(plugin)
    writeJson(plugin, initializePayload(1))
    await waitFor(() => stdout.some((line) => line.id === 1), "plugin initialize")
    writeJson(plugin, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    await waitFor(async () => {
      const roster = parseToolJson(await firstDaemon.client.call("tribe.members", { all: true }))
      return (
        roster.sessions?.some((session) => session.name === PERSONA && session.transport_state === "connected") ?? false
      )
    }, "initial daemon-side membership")
    writeJson(plugin, callToolPayload(10, "join", { name: PERSONA }))
    await waitFor(() => stdout.some((line) => line.id === 10), "shipping-mode explicit join")
    expect(mcpToolJson(stdout, 10)).toMatchObject({ joined: true, name: PERSONA, delivery: "push" })
    await firstDaemon.client.call("register", {
      name: "@agent/restart-sender",
      role: "member",
      domains: ["test"],
      project: tmpDir,
      projectName: "test",
      protocolVersion: TRIBE_PROTOCOL_VERSION,
      pid: process.pid,
      delivery: "pull",
    })
    await firstDaemon.client.call("tribe.send", {
      to: PERSONA,
      message: "22322 channel before restart",
      type: "request",
    })
    await waitFor(
      () =>
        stdout.some(
          (line) =>
            line.method === "notifications/claude/channel" &&
            JSON.stringify(line).includes("22322 channel before restart"),
        ),
      "pre-restart push channel delivery",
    )
    writeJson(plugin, callToolPayload(2, "members", { all: true }))
    await waitFor(() => stdout.some((line) => line.id === 2), "initial members tool call")

    const firstMember = mcpToolJson(stdout, 2).sessions?.find((session) => session.name === PERSONA)
    expect(firstMember).toMatchObject({
      member_id: expect.any(String),
      launch_id: expect.stringContaining("restart-journey-launch"),
      launch_parent_pid: harnessParentPid,
      transport_state: "connected",
      owner_state: "live",
      transport_pids: [expect.any(Number)],
    })
    const firstLaunchParentPid = firstMember!.launch_parent_pid
    const firstTransportPid = firstMember!.transport_pids![0]!
    adapterPids.add(firstTransportPid)

    await firstDaemon.client.call("tribe.restart", { reason: "21416 restart acceptance" })
    firstDaemon.client.close()
    const successor = await connectToGeneration(socketPath, (pid) => pid !== firstDaemon.pid)
    daemonPids.add(successor.pid)

    let rejoined: Member | undefined
    await waitFor(async () => {
      const result = await successor.client.call("tribe.members", { all: true })
      const candidate = parseToolJson(result).sessions?.find((session) => session.name === PERSONA)
      if (
        candidate?.transport_state === "connected" &&
        candidate.transport_pids?.length === 1 &&
        candidate.transport_pids[0] !== firstTransportPid
      ) {
        rejoined = candidate
      }
      return rejoined !== undefined
    }, "supervised adapter rejoin")

    expect(rejoined).toMatchObject({
      member_id: firstMember?.member_id,
      launch_id: firstMember?.launch_id,
      launch_parent_pid: firstLaunchParentPid,
      transport_state: "connected",
      owner_state: "live",
    })
    for (const pid of rejoined?.transport_pids ?? []) adapterPids.add(pid)
    const firstRejoinedPid = rejoined!.transport_pids![0]!
    expect(rejoined?.transport_pids).not.toContain(firstTransportPid)
    await waitFor(() => !pidExists(firstTransportPid), "replaced adapter process exit")
    expect(plugin.exitCode, pluginStderr).toBeNull()

    writeJson(plugin, callToolPayload(3, "members", { all: true }))
    await waitFor(() => stdout.some((line) => line.id === 3), "post-restart tool call")
    expect(mcpToolJson(stdout, 3).sessions?.find((session) => session.name === PERSONA)).toMatchObject({
      member_id: firstMember?.member_id,
      transport_state: "connected",
      transport_pids: rejoined?.transport_pids,
    })

    // Production incident 22322 restarted the daemon twice ten seconds apart.
    // The first generation replacement succeeded, but the wrapper's one-reexec
    // budget killed the bridge on the second legitimate generation change.
    await successor.client.call("tribe.restart", { reason: "22322 rapid second restart acceptance" })
    successor.client.close()
    const secondSuccessor = await connectToGeneration(socketPath, (pid) => pid !== successor.pid)
    daemonPids.add(secondSuccessor.pid)

    let secondRejoined: Member | undefined
    await waitFor(async () => {
      const result = await secondSuccessor.client.call("tribe.members", { all: true })
      const candidate = parseToolJson(result).sessions?.find((session) => session.name === PERSONA)
      if (
        candidate?.transport_state === "connected" &&
        candidate.transport_pids?.length === 1 &&
        candidate.transport_pids[0] !== firstRejoinedPid
      ) {
        secondRejoined = candidate
      }
      return secondRejoined !== undefined
    }, "supervised adapter rejoin after a rapid second daemon generation")

    expect(secondRejoined).toMatchObject({
      member_id: firstMember?.member_id,
      launch_id: firstMember?.launch_id,
      launch_parent_pid: firstLaunchParentPid,
      transport_state: "connected",
      owner_state: "live",
    })
    for (const pid of secondRejoined?.transport_pids ?? []) adapterPids.add(pid)
    await waitFor(() => !pidExists(firstRejoinedPid), "second replaced adapter process exit")
    expect(plugin.exitCode, pluginStderr).toBeNull()

    writeJson(plugin, callToolPayload(4, "members", { all: true }))
    await waitFor(() => stdout.some((line) => line.id === 4), "post-second-restart tool call")
    expect(mcpToolJson(stdout, 4).sessions?.find((session) => session.name === PERSONA)).toMatchObject({
      member_id: firstMember?.member_id,
      transport_state: "connected",
      transport_pids: secondRejoined?.transport_pids,
    })
    await secondSuccessor.client.call("register", {
      name: "@agent/restart-sender",
      role: "member",
      domains: ["test"],
      project: tmpDir,
      projectName: "test",
      protocolVersion: TRIBE_PROTOCOL_VERSION,
      pid: process.pid,
      delivery: "pull",
    })
    await secondSuccessor.client.call("tribe.send", {
      to: PERSONA,
      message: "22322 channel after two restarts",
      type: "request",
    })
    await waitFor(
      () =>
        stdout.some(
          (line) =>
            line.method === "notifications/claude/channel" &&
            JSON.stringify(line).includes("22322 channel after two restarts"),
        ),
      "post-restart push channel delivery",
    )
    expect(readFileSync(adapterLog, "utf8").match(/daemon generation changed/g)).toHaveLength(2)
    secondSuccessor.client.close()
  }, 45_000)

  it("keeps the stable MCP endpoint alive through repeated adapter crashes", async () => {
    const dbPath = join(tmpDir, "tribe-adapter-crash.db")
    const daemonLog = join(tmpDir, "daemon-adapter-crash.log")
    const adapterLog = join(tmpDir, "adapter-crash.log")
    spawnTestDaemon(dbPath, daemonLog)
    await waitFor(() => existsSync(socketPath), "adapter-crash daemon socket")
    const generation = await connectToGeneration(socketPath)
    daemonPids.add(generation.pid)

    const plugin = spawnTestPlugin({
      dbPath,
      logPath: adapterLog,
      name: PERSONA,
      launchId: "adapter-crash-launch",
      providerParentPid: String(process.pid),
      delivery: "push",
      requireJoin: true,
    })
    let pluginStderr = ""
    plugin.stderr.on("data", (chunk: Buffer | string) => {
      pluginStderr += chunk.toString()
    })
    const wrapperPid = plugin.pid!
    const stdout = collectJsonLines(plugin)
    writeJson(plugin, initializePayload(20))
    await waitFor(() => stdout.some((line) => line.id === 20), "adapter-crash plugin initialization")
    writeJson(plugin, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })

    let initialMember: Member | undefined
    await waitFor(async () => {
      const roster = parseToolJson(await generation.client.call("tribe.members", { all: true }))
      initialMember = roster.sessions?.find(
        (session) => session.name === PERSONA && session.transport_state === "connected",
      )
      return initialMember?.transport_pids?.length === 1
    }, "adapter-crash initial membership")
    const initialTransportPid = initialMember!.transport_pids![0]!
    adapterPids.add(initialTransportPid)
    expect(initialMember).toMatchObject({ delivery: "pull" })

    process.kill(initialTransportPid, "SIGKILL")
    await waitFor(() => !pidExists(initialTransportPid), "crashed adapter exit")

    let restoredMember: Member | undefined
    await waitFor(
      async () => {
        const roster = parseToolJson(await generation.client.call("tribe.members", { all: true }))
        const candidate = roster.sessions?.find(
          (session) => session.name === PERSONA && session.transport_state === "connected",
        )
        if (candidate?.transport_pids?.length === 1 && candidate.transport_pids[0] !== initialTransportPid) {
          restoredMember = candidate
        }
        return restoredMember !== undefined
      },
      "adapter-crash supervised recovery",
      5_000,
    )

    expect(plugin.pid).toBe(wrapperPid)
    expect(plugin.exitCode).toBeNull()
    expect(restoredMember).toMatchObject({
      member_id: initialMember?.member_id,
      launch_id: initialMember?.launch_id,
      launch_parent_pid: process.pid,
      delivery: "pull",
      transport_state: "connected",
      owner_state: "live",
    })
    for (const pid of restoredMember?.transport_pids ?? []) adapterPids.add(pid)

    writeJson(plugin, callToolPayload(21, "join", { name: PERSONA }))
    await waitFor(() => stdout.some((line) => line.id === 21), "post-crash explicit join")
    expect(mcpToolJson(stdout, 21)).toMatchObject({ joined: true, name: PERSONA, delivery: "push" })

    let transportPid = restoredMember!.transport_pids![0]!
    for (let crash = 2; crash <= 6; crash += 1) {
      process.kill(transportPid, "SIGKILL")
      await waitFor(() => !pidExists(transportPid), `crashed adapter ${crash} exit`)

      const priorTransportPid = transportPid
      let recoveredMember: Member | undefined
      await waitFor(
        async () => {
          const roster = parseToolJson(await generation.client.call("tribe.members", { all: true }))
          const candidate = roster.sessions?.find(
            (session) => session.name === PERSONA && session.transport_state === "connected",
          )
          if (candidate?.transport_pids?.length === 1 && candidate.transport_pids[0] !== priorTransportPid) {
            recoveredMember = candidate
            transportPid = candidate.transport_pids[0]!
            adapterPids.add(transportPid)
            return true
          }
          return false
        },
        `persistent adapter recovery ${crash}`,
        crash === 6 ? 12_000 : 6_000,
      )
      if (crash === 2) {
        expect(recoveredMember).toMatchObject({
          member_id: initialMember?.member_id,
          delivery: "push",
          transport_pids: [transportPid],
        })
        writeJson(plugin, callToolPayload(22, "members", { all: true }))
        await waitFor(() => stdout.some((line) => line.id === 22), "post-join crash MCP tool call")
        expect(mcpToolJson(stdout, 22).sessions?.find((session) => session.name === PERSONA)).toMatchObject({
          member_id: initialMember?.member_id,
          delivery: "push",
          transport_pids: [transportPid],
        })
      }
    }

    expect(plugin.pid).toBe(wrapperPid)
    expect(plugin.exitCode).toBeNull()
    expect(pluginStderr).toContain("adapter exited unexpectedly; retrying")
    const recoveredRoster = parseToolJson(await generation.client.call("tribe.members", { all: true }))
    expect(recoveredRoster.sessions?.find((session) => session.name === PERSONA)).toMatchObject({
      member_id: initialMember?.member_id,
      delivery: "push",
      transport_state: "connected",
      transport_pids: [transportPid],
    })
    writeJson(plugin, callToolPayload(23, "members", { all: true }))
    await waitFor(() => stdout.some((line) => line.id === 23), "post-budget MCP tool call")
    expect(mcpToolJson(stdout, 23).sessions?.find((session) => session.name === PERSONA)).toMatchObject({
      member_id: initialMember?.member_id,
      transport_state: "connected",
      transport_pids: [transportPid],
    })
    generation.client.close()
  }, 45_000)

  it.each([
    ["a malformed parent PID", "not-a-pid", "invalid-provider-parent-launch"],
    ["a dead parent PID", String(Number.MAX_SAFE_INTEGER), "dead-provider-parent-launch"],
    ["a parent PID without a launch id", String(process.ppid), ""],
  ])("fails loudly when a managed wrapper inherits %s", async (_label, providerParentPid, launchId) => {
    const dbPath = join(tmpDir, "tribe-invalid-provider-parent.db")
    const adapterLog = join(tmpDir, "adapter-invalid-provider-parent.log")

    const plugin = spawnTestPlugin({
      dbPath,
      logPath: adapterLog,
      name: PERSONA,
      launchId,
      providerParentPid,
      delivery: "pull",
      requireJoin: false,
    })
    let pluginStderr = ""
    plugin.stderr.on("data", (chunk: Buffer | string) => {
      pluginStderr += chunk.toString()
    })

    await waitFor(() => plugin.exitCode !== null, "invalid-provider-parent plugin exit", 2_000)
    expect(plugin.exitCode).toBe(2)
    expect(pluginStderr).toContain("valid provider-parent provenance")
  })

  // A host's env is fixed at launch, so rejecting an absent provider-parent PID
  // takes down every seat launched before the bootstrap injected it and offers
  // no in-band remedy. It warns and falls back instead; only a SUPPLIED-but-bad
  // tuple is a launcher bug the wrapper can attribute.
  it("warns but keeps serving when a managed launch supplies no provider-parent PID", async () => {
    const dbPath = join(tmpDir, "tribe-legacy-provider-parent.db")
    const adapterLog = join(tmpDir, "adapter-legacy-provider-parent.log")
    spawnTestDaemon(dbPath, join(tmpDir, "daemon-legacy-provider-parent.log"))
    await waitFor(() => existsSync(socketPath), "legacy-provider-parent daemon socket")

    const plugin = spawnTestPlugin({
      dbPath,
      logPath: adapterLog,
      name: PERSONA,
      launchId: "legacy-launch-without-provider-parent",
      providerParentPid: "",
      delivery: "pull",
      requireJoin: false,
    })
    let pluginStderr = ""
    plugin.stderr.on("data", (chunk: Buffer | string) => {
      pluginStderr += chunk.toString()
    })

    await waitFor(() => pluginStderr.includes("supplied no provider-parent PID"), "legacy-parent warning", 5_000)
    expect(plugin.exitCode).toBeNull()
    expect(pluginStderr).not.toContain("valid provider-parent provenance")
  })

  it("restores a runtime-joined name when a launch-less Claude wrapper re-execs", async () => {
    const dbPath = join(tmpDir, "tribe-runtime-name.db")
    const daemonLog = join(tmpDir, "daemon-runtime-name.log")
    const adapterLog = join(tmpDir, "adapter-runtime-name.log")
    spawnTestDaemon(dbPath, daemonLog)
    await waitFor(() => existsSync(socketPath), "runtime-name initial daemon socket")
    const firstDaemon = await connectToGeneration(socketPath)
    daemonPids.add(firstDaemon.pid)

    // Standalone Claude plugin installs do not have Ag's durable launch tuple.
    // Their model-issued join is therefore the only canonical identity source,
    // and the wrapper must carry that effective name across child re-exec.
    const plugin = spawn(BUN_BIN, [PLUGIN_SERVER, "--socket", socketPath], {
      cwd: tmpDir,
      env: {
        ...process.env,
        CLAUDE_SESSION_ID: "22322-launchless-runtime-name",
        TRIBE_NAME: "",
        TRIBE_LAUNCH_ID: "",
        TRIBE_PLUGIN_ADAPTER_CHILD: "",
        TRIBE_PLUGIN_PROVIDER_PARENT_PID: "",
        TRIBE_PLUGIN_REEXEC_EXIT_CODE: "",
        TRIBE_PLUGIN_RESUME_JOINED: "",
        TRIBE_DELIVERY: "push",
        TRIBE_TAKEOVER: "1",
        TRIBE_NO_PLUGINS: "1",
        TRIBE_NO_AUTORELOAD: "1",
        DEBUG_LOG: adapterLog,
        LOG_FILE: adapterLog,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams
    plugins.add(plugin)
    let pluginStderr = ""
    plugin.stderr.on("data", (chunk: Buffer | string) => {
      pluginStderr += chunk.toString()
    })
    const stdout = collectJsonLines(plugin)
    writeJson(plugin, initializePayload(20))
    await waitFor(() => stdout.some((line) => line.id === 20), "runtime-name plugin initialize")
    writeJson(plugin, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    await waitFor(async () => {
      const roster = parseToolJson(await firstDaemon.client.call("tribe.members", { all: true })).sessions ?? []
      return roster.some(
        (session) =>
          session.name?.startsWith("unknown-") === true &&
          session.transport_state === "connected" &&
          session.transport_pids?.length === 1,
      )
    }, "launch-less initial registration")

    writeJson(plugin, callToolPayload(21, "join", { name: "@cto" }))
    await waitFor(() => stdout.some((line) => line.id === 21), "runtime-name explicit join")
    expect(mcpToolJson(stdout, 21)).toMatchObject({ joined: true, name: "@cto", delivery: "push" })

    const initialRoster = parseToolJson(await firstDaemon.client.call("tribe.members", { all: true })).sessions ?? []
    const initial = initialRoster.find((session) => session.name === "@cto" && session.transport_state === "connected")
    expect(initial).toMatchObject({
      member_id: expect.any(String),
      transport_pids: [expect.any(Number)],
    })
    const initialTransportPid = initial!.transport_pids![0]!
    adapterPids.add(initialTransportPid)

    await firstDaemon.client.call("tribe.restart", { reason: "22322 runtime-name restart acceptance" })
    firstDaemon.client.close()
    const successor = await connectToGeneration(socketPath, (pid) => pid !== firstDaemon.pid)
    daemonPids.add(successor.pid)

    let rejoined: Member | undefined
    await waitFor(async () => {
      const roster = parseToolJson(await successor.client.call("tribe.members", { all: true })).sessions ?? []
      const candidate = roster.find(
        (session) =>
          session.member_id === initial?.member_id &&
          session.transport_state === "connected" &&
          session.transport_pids?.length === 1 &&
          session.transport_pids[0] !== initialTransportPid,
      )
      if (candidate) rejoined = candidate
      return rejoined !== undefined
    }, "launch-less wrapper process re-registration")

    expect(rejoined).toMatchObject({
      member_id: initial?.member_id,
      name: "@cto",
      transport_state: "connected",
      owner_state: "live",
    })
    for (const pid of rejoined?.transport_pids ?? []) adapterPids.add(pid)
    await waitFor(() => !pidExists(initialTransportPid), "runtime-name replaced adapter process exit")
    expect(plugin.exitCode, pluginStderr).toBeNull()
    successor.client.close()
  }, 45_000)

  it("keeps an unsupervised pull adapter alive after a daemon generation change", async () => {
    const dbPath = join(tmpDir, "tribe-direct.db")
    const daemonLog = join(tmpDir, "daemon-direct.log")
    const adapterLog = join(tmpDir, "adapter-direct.log")
    spawnTestDaemon(dbPath, daemonLog)
    await waitFor(() => existsSync(socketPath), "direct-adapter initial daemon socket")
    const firstDaemon = await connectToGeneration(socketPath)
    daemonPids.add(firstDaemon.pid)

    const adapter = spawn(BUN_BIN, [STDIO_ADAPTER, "--socket", socketPath, "--name", PERSONA], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DB: dbPath,
        TRIBE_DELIVERY: "pull",
        TRIBE_PULL_TRANSPORT: "mcp",
        TRIBE_REQUIRE_JOIN: "0",
        TRIBE_TAKEOVER: "1",
        TRIBE_LAUNCH_ID: "restart-direct-launch",
        TRIBE_NO_PLUGINS: "1",
        TRIBE_NO_AUTORELOAD: "1",
        DEBUG_LOG: adapterLog,
        LOG_FILE: adapterLog,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams
    plugins.add(adapter)
    let adapterStderr = ""
    adapter.stderr.on("data", (chunk: Buffer | string) => {
      adapterStderr += chunk.toString()
    })
    const stdout = collectJsonLines(adapter)
    writeJson(adapter, initializePayload(10))
    await waitFor(() => stdout.some((line) => line.id === 10), "direct-adapter initialize")
    writeJson(adapter, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    let initialMember: Member | undefined
    await waitFor(async () => {
      const roster = parseToolJson(await firstDaemon.client.call("tribe.members", { all: true })).sessions ?? []
      initialMember = roster.find(
        (session) => session.name === PERSONA && session.transport_state === "connected" && session.transport_pids?.[0],
      )
      return initialMember !== undefined
    }, "direct-adapter initial membership")

    await firstDaemon.client.call("tribe.restart", { reason: "22322 direct adapter restart acceptance" })
    firstDaemon.client.close()
    const successor = await connectToGeneration(socketPath, (pid) => pid !== firstDaemon.pid)
    daemonPids.add(successor.pid)
    await waitFor(async () => {
      const roster = parseToolJson(await successor.client.call("tribe.members", { all: true })).sessions ?? []
      return roster.some((session) => session.name === PERSONA && session.transport_state === "connected")
    }, "direct-adapter rejoin")
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))

    expect(adapter.exitCode, adapterStderr).toBeNull()
    writeJson(adapter, callToolPayload(11, "members", { all: true }))
    await waitFor(() => stdout.some((line) => line.id === 11), "direct-adapter post-restart tool call")
    expect(mcpToolJson(stdout, 11).sessions?.find((session) => session.name === PERSONA)).toMatchObject({
      launch_id: initialMember?.launch_id,
      transport_state: "connected",
      owner_state: "live",
    })
    successor.client.close()
  }, 35_000)

  it("keeps an unnamed adapter disconnect out of addressable health alarms", async () => {
    const dbPath = join(tmpDir, "tribe-unnamed-health.db")
    const daemonLog = join(tmpDir, "daemon-unnamed-health.log")
    const adapterLog = join(tmpDir, "adapter-unnamed-health.log")
    spawnTestDaemon(dbPath, daemonLog)
    await waitFor(() => existsSync(socketPath), "unnamed-health daemon socket")
    const daemon = await connectToGeneration(socketPath)
    daemonPids.add(daemon.pid)

    const before = parseToolJson(await daemon.client.call("tribe.health"))
    const adapter = spawn(BUN_BIN, [STDIO_ADAPTER, "--socket", socketPath], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DB: dbPath,
        TRIBE_NAME: "",
        TRIBE_DELIVERY: "pull",
        TRIBE_PULL_TRANSPORT: "mcp",
        TRIBE_REQUIRE_JOIN: "0",
        TRIBE_LAUNCH_ID: "unnamed-health-launch",
        TRIBE_NO_PLUGINS: "1",
        TRIBE_NO_AUTORELOAD: "1",
        DEBUG_LOG: adapterLog,
        LOG_FILE: adapterLog,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams
    plugins.add(adapter)
    const stdout = collectJsonLines(adapter)
    writeJson(adapter, initializePayload(30))
    await waitFor(() => stdout.some((line) => line.id === 30), "unnamed adapter initialize")
    writeJson(adapter, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    await waitFor(async () => {
      const roster = parseToolJson(await daemon.client.call("tribe.members", { all: true })).sessions ?? []
      return roster.some(
        (session) => session.launch_id === "unnamed-health-launch" && session.transport_state === "connected",
      )
    }, "unnamed adapter registration")
    const connectedRoster = parseToolJson(await daemon.client.call("tribe.members", { all: true })).sessions ?? []
    expect(connectedRoster.find((session) => session.launch_id === "unnamed-health-launch")?.name).toMatch(/^unknown-/u)

    const adapterPid = adapter.pid
    if (adapterPid === undefined) throw new Error("unnamed adapter did not expose a process id")
    await terminateTestProcess(adapterPid)
    let after: ToolJson = {}
    await waitFor(async () => {
      after = parseToolJson(await daemon.client.call("tribe.health"))
      return after.anonymous_disconnected === (before.anonymous_disconnected ?? 0) + 1
    }, "unnamed adapter disconnected health projection")

    expect(after.transport_wedges).toEqual(before.transport_wedges)
    expect(after.membership_discrepancy).toEqual(before.membership_discrepancy)
    expect(after.anonymous_disconnected).toBe((before.anonymous_disconnected ?? 0) + 1)
    daemon.client.close()
  }, 35_000)

  it("after an N-seat restart, returns every live seat and reports any missing seat as a discrepancy", async () => {
    const dbPath = join(tmpDir, "tribe-multi.db")
    const daemonLog = join(tmpDir, "daemon-multi.log")
    spawnTestDaemon(dbPath, daemonLog)
    await waitFor(() => existsSync(socketPath), "multi-seat initial daemon socket")
    let generation = await connectToGeneration(socketPath)
    daemonPids.add(generation.pid)

    const personas = ["@agent/restart-a", "@agent/restart-b", "@agent/restart-c"]
    const harnesses = personas.map((persona, index) => {
      const adapterLog = join(tmpDir, `adapter-${index}.log`)
      const child = spawnTestPlugin({
        dbPath,
        logPath: adapterLog,
        name: persona,
        launchId: `restart-multi-${index}`,
        providerParentPid: String(process.pid),
        delivery: "pull",
        requireJoin: false,
      })
      child.stderr.resume()
      const stdout = collectJsonLines(child)
      writeJson(child, initializePayload(index + 1))
      return { child, persona, stdout }
    })
    await waitFor(
      () => harnesses.every(({ stdout }, index) => stdout.some((line) => line.id === index + 1)),
      "multi-seat plugin initialization",
    )
    for (const { child } of harnesses) {
      writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    }

    const initialMembers = new Map<string, Member>()
    await waitFor(async () => {
      const roster = parseToolJson(await generation.client.call("tribe.members", { all: true })).sessions ?? []
      for (const persona of personas) {
        const member = roster.find((session) => session.name === persona && session.transport_state === "connected")
        if (member) initialMembers.set(persona, member)
      }
      return initialMembers.size === personas.length
    }, "all multi-seat initial memberships")

    let priorTransportPids = new Map(
      personas.map((persona) => [persona, initialMembers.get(persona)!.transport_pids![0]!]),
    )
    const withheldPersona = personas[2]!
    for (let restart = 1; restart <= 2; restart += 1) {
      const expectedPersonas = restart === 1 ? personas : personas.filter((persona) => persona !== withheldPersona)
      if (restart === 2) {
        const withheld = harnesses.find(({ persona }) => persona === withheldPersona)!
        await terminateTestProcess(withheld.child.pid!)
      }

      const priorDaemonPid = generation.pid
      await generation.client.call("tribe.restart", { reason: `22322 multi-seat restart ${restart}` })
      generation.client.close()
      generation = await connectToGeneration(socketPath, (pid) => pid !== priorDaemonPid)
      daemonPids.add(generation.pid)

      const rejoined = new Map<string, Member>()
      await waitFor(async () => {
        const roster = parseToolJson(await generation.client.call("tribe.members", { all: true })).sessions ?? []
        for (const persona of expectedPersonas) {
          const candidate = roster.find(
            (session) =>
              session.name === persona &&
              session.transport_state === "connected" &&
              session.transport_pids?.length === 1 &&
              session.transport_pids[0] !== priorTransportPids.get(persona),
          )
          if (candidate) rejoined.set(persona, candidate)
        }
        return rejoined.size === expectedPersonas.length
      }, `all multi-seat memberships after daemon restart ${restart}`)

      for (const persona of expectedPersonas) {
        const member = rejoined.get(persona)!
        expect(member.member_id).toBe(initialMembers.get(persona)?.member_id)
        expect(member.launch_parent_pid).toBe(initialMembers.get(persona)?.launch_parent_pid)
        for (const pid of member.transport_pids ?? []) adapterPids.add(pid)
      }
      priorTransportPids = new Map(
        expectedPersonas.map((persona) => [persona, rejoined.get(persona)!.transport_pids![0]!]),
      )
      expect(harnesses.filter(({ persona }) => persona !== withheldPersona).map(({ child }) => child.exitCode)).toEqual(
        [null, null],
      )

      if (restart === 2) {
        const roster = parseToolJson(await generation.client.call("tribe.members", { all: true }))
        expect(roster.membership_discrepancy).toMatchObject({
          status: "degraded",
          connected_durable_launches: 2,
          known_durable_launches: 3,
          missing_count: 1,
          missing: [
            {
              member_id: initialMembers.get(withheldPersona)?.member_id,
              name: withheldPersona,
              launch_id: initialMembers.get(withheldPersona)?.launch_id,
              launch_parent_pid: initialMembers.get(withheldPersona)?.launch_parent_pid,
              state: "missing-transport",
            },
          ],
          meaning: "missing transport does not establish agent absence",
        })
      }
    }

    const finalRoster = parseToolJson(await generation.client.call("tribe.members", { all: true })).sessions ?? []
    expect(
      finalRoster
        .filter((session) => session.transport_state === "connected")
        .map((session) => session.name)
        .sort(),
    ).toEqual(personas.filter((persona) => persona !== withheldPersona).sort())
    generation.client.close()
  }, 45_000)
})
