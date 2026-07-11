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

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createStatements, openDatabase } from "../../daemon/src/lib/database.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const ADAPTER = resolve(HERE, "../src/stdio-adapter.ts")
const DAEMON = resolve(HERE, "../../daemon/src/daemon.ts")
const BUN_BIN = process.versions.bun ? process.execPath : "bun"
const PROVIDER_PARENT_WRAPPER = `
const command = JSON.parse(process.env.TRIBE_TEST_CHILD_COMMAND)
const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env })
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal))
process.exit(await child.exited)
`

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
  if (typeof text !== "string") return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(text)
  }
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
    launchId: string | undefined,
    opts: { takeover?: boolean; distinctProviderParent?: boolean } = {},
  ): Promise<{ child: ChildProcessWithoutNullStreams; stdout: Record<string, unknown>[]; logPath: string }> {
    const logPath = join(tmpDir, logName)
    const adapterCommand = [BUN_BIN, ADAPTER, "--socket", socketPath, "--name", NAME]
    const child = spawn(
      BUN_BIN,
      opts.distinctProviderParent ? ["-e", PROVIDER_PARENT_WRAPPER] : adapterCommand.slice(1),
      {
        cwd: tmpDir,
        env: {
          ...process.env,
          TRIBE_DELIVERY: "pull",
          TRIBE_PULL_TRANSPORT: "mcp",
          TRIBE_NO_AUTOSTART: "1",
          TRIBE_REQUIRE_JOIN: "0",
          TRIBE_TAKEOVER: opts.takeover === false ? "0" : "1",
          ...(launchId === undefined ? {} : { TRIBE_LAUNCH_ID: launchId }),
          ...(opts.distinctProviderParent
            ? {
                // Hostile/unsanitized nested launch: both identity inputs are
                // inherited unchanged; only real OS-parent provenance differs.
                TRIBE_NAME: NAME,
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
    for (const [index, adapter] of launchAdapters.entries())
      writeJson(adapter.child, callToolPayload(index + 2, "members", {}))
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

    const members = (await callLaunchTool(launchAdapters[0]!, 20, "members", {})) as {
      sessions?: Array<{
        name?: string
        member_id?: string
        launch_id?: string
        launch_parent_pid?: number
        transport_pids?: number[]
      }>
    }
    const member = members.sessions?.find((session) => session.name === NAME)
    expect(member).toMatchObject({ launch_id: launchId, launch_parent_pid: process.pid })
    expect(member?.member_id).toEqual(expect.any(String))
    const initialMemberId = member!.member_id!
    expect(member?.transport_pids?.toSorted((a, b) => a - b)).toEqual(
      launchAdapters.map(({ child }) => child.pid!).toSorted((a, b) => a - b),
    )
    const health = (await callLaunchTool(launchAdapters[1]!, 19, "health", {})) as {
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
      launch_id: launchId,
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
      callLaunchTool(launchAdapters[2]!, 23, "fetch", { ids: [sent.id], limit: 50 }),
    ])) as [{ pending?: Array<{ request_id?: string }> }, { events?: Array<{ id?: string; content?: string }> }]
    expect(pending.pending?.some((request) => request.request_id === sent.id)).toBe(true)
    expect(
      fetched.events?.some((event) => event.id === sent.id && event.content === "same-launch fan-in request"),
    ).toBe(true)

    // Replacing one transport inside the same provider launch retains the
    // logical member and restores the three-transport diagnostic set.
    launchAdapters[1]!.child.kill("SIGTERM")
    await once(launchAdapters[1]!.child, "exit")
    const replacement = await spawnLaunchAdapter(socketPath, "launch-adapter-2b.log", launchId)
    launchAdapters[1] = replacement
    const afterReconnect = (await callLaunchTool(replacement, 24, "members", {})) as {
      sessions?: Array<{ name?: string; member_id?: string; launch_id?: string; transport_pids?: number[] }>
    }
    expect(afterReconnect.sessions?.find((session) => session.name === NAME)).toMatchObject({
      member_id: initialMemberId,
      launch_id: launchId,
      transport_pids: expect.arrayContaining(launchAdapters.map(({ child }) => child.pid!)),
    })

    // A daemon restart drops every socket simultaneously. All three native
    // adapters must reconnect and re-fan into the persisted logical member.
    daemonProc.kill("SIGTERM")
    await once(daemonProc, "exit")
    await waitForCondition(() => !existsSync(socketPath), "old daemon socket removal")
    daemonProc = spawnDaemon(socketPath, dbPath)
    await waitForCondition(() => existsSync(socketPath), "restarted daemon socket")
    await waitForCondition(
      () =>
        launchAdapters.every(({ logPath }) => {
          if (!existsSync(logPath)) return false
          return (readFileSync(logPath, "utf8").match(/Registered as/g) ?? []).length >= 2
        }),
      "all launch adapters to register after daemon restart",
    )
    const afterDaemonRestart = await Promise.all(
      launchAdapters.map((adapter, index) => callLaunchTool(adapter, 30 + index, "members", {})),
    )
    for (const result of afterDaemonRestart as Array<{
      sessions?: Array<{ name?: string; member_id?: string; launch_id?: string; transport_pids?: number[] }>
    }>) {
      expect(result.sessions?.filter((session) => session.name === NAME)).toHaveLength(1)
      expect(result.sessions?.find((session) => session.name === NAME)).toMatchObject({
        member_id: initialMemberId,
        launch_id: launchId,
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
    const successorMembers = (await callLaunchTool(successor, 41, "members", {})) as {
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
  }, 30_000)

  it("does not adopt a dead launch when a new provider inherits its stale launch id", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const dbPath = join(tmpDir, "tribe.db")
    daemonProc = spawnDaemon(socketPath, dbPath)
    await waitForCondition(() => existsSync(socketPath), "daemon socket")

    const staleLaunchId = "stale-dead-provider-launch"
    const first = await spawnLaunchAdapter(socketPath, "stale-launch-1.log", staleLaunchId)
    const firstMembers = (await callLaunchTool(first, 50, "members", {})) as {
      sessions?: Array<{ name?: string; member_id?: string }>
    }
    const firstMemberId = firstMembers.sessions?.find((session) => session.name === NAME)?.member_id
    expect(firstMemberId).toEqual(expect.any(String))
    first.child.kill("SIGTERM")
    await once(first.child, "exit")

    const inherited = await spawnLaunchAdapter(socketPath, "stale-launch-2.log", staleLaunchId, {
      distinctProviderParent: true,
    })
    const inheritedMembers = (await callLaunchTool(inherited, 51, "members", {})) as {
      sessions?: Array<{ name?: string; member_id?: string; launch_id?: string }>
    }
    const inheritedMember = inheritedMembers.sessions?.find((session) => session.name === NAME)
    expect(inheritedMember).toMatchObject({ launch_id: staleLaunchId })
    expect(inheritedMember?.member_id).toEqual(expect.any(String))
    expect(inheritedMember?.member_id).not.toBe(firstMemberId)
  }, 30_000)
})
