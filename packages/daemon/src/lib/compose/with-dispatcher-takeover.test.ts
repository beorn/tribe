/**
 * Explicit-persona takeover (20703) — a managed respawn that registers with
 * an EXPLICIT persona name AND `takeover: true` supersedes a live holder of
 * that name instead of hitting NameConflictError. Covers:
 *
 *   (a) regression pin — without `takeover`, an explicit-name collision from
 *       a different live pid still fails loud (c0b8caf behavior, unchanged).
 *   (b) takeover success — with `takeover: true` + the same explicit name,
 *       the live holder is retired (socket destroyed, dropped from the live
 *       roster) and a `session.superseded` journal event is recorded.
 *   (c) explicit-name guard — `takeover: true` WITHOUT an explicit `name`
 *       (the auto/adopted-name path) never supersedes, even when the
 *       resolved name collides with a live holder's name.
 *
 * Harness is a trimmed copy of `with-dispatcher-self-registration.test.ts`'s
 * `createDispatcherHarness()` (same fake-socket / fake-server shape), widened
 * to accept `claudeSessionName` and `takeover` register params and to expose
 * `db` for direct journal-row assertions.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Server, Socket as NetSocket } from "node:net"
import type { Database } from "bun:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { getLogLevel, setLogLevel } from "loggily"
import { createScope } from "tribe-wire"
import { TRIBE_PROTOCOL_VERSION, type JsonRpcRequest } from "tribe-wire/lib/socket"
import type { TribeRole } from "tribe-wire/lib/config"
import { createTribeContext } from "../context.ts"
import { openDatabase, createStatements } from "../database.ts"
import type { ClientSession } from "./with-client-registry.ts"
import { withDispatcher } from "./with-dispatcher.ts"

type TestSocket = NetSocket & {
  destroyedByDispatcher: boolean
  writes: string[]
}

type RegisterResult = {
  sessionId: string
  name: string
  role: TribeRole
}

type CliStatusResult = {
  sessions: Array<{
    name: string
    pid: number
    role: TribeRole
  }>
}

type JsonRpcResponse<T> = {
  result?: T
  error?: {
    code: number
    message: string
    data?: { existing_names?: string[]; holder_pid?: number | null }
  }
}

type RegisterParams = {
  name?: string
  pid: number
  project: string
  claudeSessionName?: string
  takeover?: boolean
  identityToken?: string
  launchId?: string
  launchParentPid?: number
}

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (!cleanup) return
  const dispose = cleanup
  cleanup = null
  await dispose()
})

describe("dispatcher explicit-persona takeover (@ag/tribe/20703)", () => {
  it("rejects partial launch identity instead of silently downgrading to legacy registration", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    harness.addPendingClient("conn-id-only")
    const idOnly = parseError(
      await harness.register("conn-id-only", {
        name: "@agent/76",
        pid: 2901,
        project: "/tmp/km-wt9-partial",
        launchId: "provider-launch-a",
      }),
    )
    expect(idOnly).toMatchObject({
      code: -32602,
      message: "register requires launchId and launchParentPid together; omit both for legacy transport registration",
    })

    harness.addPendingClient("conn-parent-only")
    const parentOnly = parseError(
      await harness.register("conn-parent-only", {
        name: "@agent/76",
        pid: 2902,
        project: "/tmp/km-wt9-partial",
        launchParentPid: 100,
      }),
    )
    expect(parentOnly).toMatchObject({
      code: -32602,
      message: "register requires launchId and launchParentPid together; omit both for legacy transport registration",
    })

    harness.addPendingClient("conn-invalid-pair")
    const invalidPair = parseError(
      await harness.register("conn-invalid-pair", {
        name: "@agent/76",
        pid: 2903,
        project: "/tmp/km-wt9-partial",
        launchId: " ",
        launchParentPid: 0,
      }),
    )
    expect(invalidPair).toMatchObject({
      code: -32602,
      message:
        "register launch identity requires a non-empty launchId and positive integer launchParentPid; omit both for legacy transport registration",
    })
  })

  it("(a) regression pin: without takeover, an explicit-name collision from a different live pid still fails loud", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    harness.addPendingClient("conn-holder")
    const holder = parseResult<RegisterResult>(
      await harness.register("conn-holder", { name: "@agent/77", pid: 3001, project: "/tmp/km-wt9-a" }),
    )
    expect(holder.name).toBe("@agent/77")

    harness.addPendingClient("conn-contender")
    const err = parseError(
      await harness.register("conn-contender", { name: "@agent/77", pid: 3002, project: "/tmp/km-wt9-a" }),
    )
    expect(err.message).toBe('Name "@agent/77" is already taken by live pid 3001')
    expect(err.data?.holder_pid).toBe(3001)

    const status = parseResult<CliStatusResult>(await harness.cliStatus())
    const agentSessions = status.sessions.filter((s) => s.name === "@agent/77")
    expect(agentSessions).toHaveLength(1)
    expect(agentSessions[0]?.pid).toBe(3001)
    expect(harness.supersededEvents("@agent/77")).toHaveLength(0)
  })

  it("(b) takeover: explicit takeover:true supersedes the live holder and journals session.superseded", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const holderSocket = harness.addPendingClient("conn-holder")
    parseResult<RegisterResult>(
      await harness.register("conn-holder", { name: "@agent/78", pid: 4001, project: "/tmp/km-wt9-b" }),
    )

    harness.addPendingClient("conn-taker")
    // Pin the level: the parent shell's LOG_LEVEL must not decide whether this
    // behavior assertion sees the warning.
    const previousLogLevel = getLogLevel()
    setLogLevel("warn")
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const taker = parseResult<RegisterResult>(
        await harness.register("conn-taker", {
          name: "@agent/78",
          pid: 4002,
          project: "/tmp/km-wt9-b",
          takeover: true,
        }),
      )
      expect(taker.name).toBe("@agent/78")

      expect(holderSocket.destroyedByDispatcher).toBe(true)

      const status = parseResult<CliStatusResult>(await harness.cliStatus())
      const agentSessions = status.sessions.filter((s) => s.name === "@agent/78")
      expect(agentSessions).toHaveLength(1)
      expect(agentSessions[0]?.pid).toBe(4002)

      const events = harness.supersededEvents("@agent/78")
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        name: "@agent/78",
        old_pid: 4001,
        new_pid: 4002,
        reason: "explicit-persona takeover (20703)",
      })

      // Loud-recovery evidence: the warn line names the superseded name and
      // both pids, so a human scanning logs can see the takeover happened
      // without querying the journal.
      const warnLines = warnSpy.mock.calls.map((call) => call.join(" "))
      const takeoverLine = warnLines.find((line) => /takeover: superseding live holder of "@agent\/78"/.test(line))
      expect(takeoverLine).toBeDefined()
      expect(takeoverLine).toContain("old pid 4001")
      expect(takeoverLine).toContain("new pid 4002")
    } finally {
      warnSpy.mockRestore()
      setLogLevel(previousLogLevel)
    }
  })

  it("(c) takeover requires an explicit name: takeover:true without `name` never supersedes, even on a resolved-name collision", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const holderSocket = harness.addPendingClient("conn-holder")
    parseResult<RegisterResult>(
      await harness.register("conn-holder", { name: "@agent/79", pid: 5001, project: "/tmp/km-wt9-c" }),
    )

    // No `name` param — only `claudeSessionName`, which resolveName() falls
    // back to (case 2) precisely because p.name is absent. It happens to
    // collide with the live holder's name, exercising the "resolved name
    // matches a live holder" branch WITHOUT the caller ever supplying an
    // explicit `name` — the exact guard `typeof p.name === "string"` protects.
    harness.addPendingClient("conn-contender")
    const err = parseError(
      await harness.register("conn-contender", {
        pid: 5002,
        project: "/tmp/km-wt9-c",
        claudeSessionName: "@agent/79",
        takeover: true,
      }),
    )
    expect(err.message).toBe('Name "@agent/79" is already taken by live pid 5001')
    expect(err.data?.holder_pid).toBe(5001)

    expect(holderSocket.destroyedByDispatcher).toBe(false)
    const status = parseResult<CliStatusResult>(await harness.cliStatus())
    const agentSessions = status.sessions.filter((s) => s.name === "@agent/79")
    expect(agentSessions).toHaveLength(1)
    expect(agentSessions[0]?.pid).toBe(5001)
    expect(harness.supersededEvents("@agent/79")).toHaveLength(0)
  })
})

describe("provider-parent transport fan-in (@ag/tribe/22631)", () => {
  it("attaches a legacy parent publisher and its launch-bearing MCP child without mutual takeover", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const parentSocket = harness.addPendingClient("conn-parent-publisher")
    const parent = parseResult<RegisterResult>(
      await harness.register("conn-parent-publisher", {
        name: "@dev/2",
        pid: 48829,
        project: "/tmp/hh-wt2",
        takeover: true,
      }),
    )

    const mcpSocket = harness.addPendingClient("conn-mcp-adapter")
    const mcp = parseResult<RegisterResult>(
      await harness.register("conn-mcp-adapter", {
        name: "@dev/2",
        pid: 49853,
        project: "/tmp/hh-wt2",
        takeover: true,
        identityToken: "tok-dev-2",
        launchId: "hab-dev-2-g7-a1",
        launchParentPid: 48829,
      }),
    )

    const reconnectedParentSocket = harness.addPendingClient("conn-parent-publisher-reconnect")
    const reconnectedParent = parseResult<RegisterResult>(
      await harness.register("conn-parent-publisher-reconnect", {
        name: "@dev/2",
        pid: 48829,
        project: "/tmp/hh-wt2",
        takeover: true,
      }),
    )

    expect(mcp.sessionId).toBe(parent.sessionId)
    expect(reconnectedParent.sessionId).toBe(parent.sessionId)
    expect(parentSocket.destroyedByDispatcher).toBe(false)
    expect(mcpSocket.destroyedByDispatcher).toBe(false)
    expect(reconnectedParentSocket.destroyedByDispatcher).toBe(false)
    expect(harness.supersededEvents("@dev/2")).toHaveLength(0)

    const persisted = harness.db
      .prepare("SELECT pid, identity_token, launch_id, launch_parent_pid FROM sessions WHERE id = ?")
      .get(parent.sessionId) as {
      pid: number
      identity_token: string | null
      launch_id: string | null
      launch_parent_pid: number | null
    }
    expect(persisted).toEqual({
      pid: 48829,
      identity_token: "tok-dev-2",
      launch_id: "hab-dev-2-g7-a1",
      launch_parent_pid: 48829,
    })
  })

  it("keeps a different full launch on the explicit takeover path", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const holderSocket = harness.addPendingClient("conn-launch-holder")
    const holder = parseResult<RegisterResult>(
      await harness.register("conn-launch-holder", {
        name: "@dev/2",
        pid: 49853,
        project: "/tmp/hh-wt2",
        takeover: true,
        identityToken: "tok-dev-2-old",
        launchId: "hab-dev-2-g7-a1",
        launchParentPid: 48829,
      }),
    )

    harness.addPendingClient("conn-foreign-launch")
    const foreign = parseResult<RegisterResult>(
      await harness.register("conn-foreign-launch", {
        name: "@dev/2",
        pid: 50999,
        project: "/tmp/hh-wt2",
        takeover: true,
        identityToken: "tok-dev-2-new",
        launchId: "hab-dev-2-g8-a1",
        launchParentPid: 49853,
      }),
    )

    expect(foreign.sessionId).not.toBe(holder.sessionId)
    expect(holderSocket.destroyedByDispatcher).toBe(true)
    expect(harness.supersededEvents("@dev/2")).toEqual([
      expect.objectContaining({
        old_pid: 49853,
        new_pid: 50999,
        reason: "explicit-persona takeover (20703)",
      }),
    ])
  })
})

describe("asymmetric identity displacement (@ag/tribe/21052)", () => {
  // The 19442 agent/4 adapter-death class: a token-less carrier (CLI drains
  // register with no identityToken) grabs a persona name across a daemon
  // restart; the managed adapter's re-register then hits NameConflictError and
  // its 20703 squatter-cleanup exit kills it permanently — the "squatter"
  // verdict was wrong. A token-BEARING explicit-persona claim must displace a
  // token-LESS live holder WITHOUT takeover. One-directional by construction:
  // token-less claimants never displace, and token-vs-token keeps fail-loud
  // semantics so 21049's mutual-eviction loop stays impossible.
  it("(a) token-bearing explicit claim supersedes a token-less live holder without takeover", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const holderSocket = harness.addPendingClient("conn-cli-holder")
    parseResult<RegisterResult>(
      await harness.register("conn-cli-holder", { name: "@agent/81", pid: 6001, project: "/tmp/km-wt9-d" }),
    )

    harness.addPendingClient("conn-adapter")
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const claimant = parseResult<RegisterResult>(
        await harness.register("conn-adapter", {
          name: "@agent/81",
          pid: 6002,
          project: "/tmp/km-wt9-d",
          identityToken: "tok-agent81",
        }),
      )
      expect(claimant.name).toBe("@agent/81")
      expect(holderSocket.destroyedByDispatcher).toBe(true)

      const status = parseResult<CliStatusResult>(await harness.cliStatus())
      const agentSessions = status.sessions.filter((s) => s.name === "@agent/81")
      expect(agentSessions).toHaveLength(1)
      expect(agentSessions[0]?.pid).toBe(6002)

      const events = harness.supersededEvents("@agent/81")
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        name: "@agent/81",
        old_pid: 6001,
        new_pid: 6002,
        reason: "identity displacement of token-less holder (21052)",
      })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("(b) loop-proof pin: token-bearing vs token-bearing still fails loud (21049 unchanged)", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    harness.addPendingClient("conn-adapter-1")
    parseResult<RegisterResult>(
      await harness.register("conn-adapter-1", {
        name: "@agent/82",
        pid: 7001,
        project: "/tmp/km-wt9-e",
        identityToken: "tok-first",
      }),
    )

    harness.addPendingClient("conn-adapter-2")
    const err = parseError(
      await harness.register("conn-adapter-2", {
        name: "@agent/82",
        pid: 7002,
        project: "/tmp/km-wt9-e",
        identityToken: "tok-second",
      }),
    )
    expect(err.message).toBe('Name "@agent/82" is already taken by live pid 7001')
    expect(harness.supersededEvents("@agent/82")).toHaveLength(0)
  })

  it("(c) token-less claimant never displaces a token-bearing holder", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const holderSocket = harness.addPendingClient("conn-adapter-holder")
    parseResult<RegisterResult>(
      await harness.register("conn-adapter-holder", {
        name: "@agent/83",
        pid: 8001,
        project: "/tmp/km-wt9-f",
        identityToken: "tok-holder",
      }),
    )

    harness.addPendingClient("conn-cli-claimant")
    const err = parseError(
      await harness.register("conn-cli-claimant", { name: "@agent/83", pid: 8002, project: "/tmp/km-wt9-f" }),
    )
    expect(err.message).toBe('Name "@agent/83" is already taken by live pid 8001')
    expect(holderSocket.destroyedByDispatcher).toBe(false)
    expect(harness.supersededEvents("@agent/83")).toHaveLength(0)
  })
})

describe("one-shot CLI join checkpoint (@ag/tribe/22429)", () => {
  it("observes the live native holder without claiming, renaming, or retiring it", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const holderSocket = harness.addPendingClient("conn-native-holder")
    const holder = parseResult<RegisterResult>(
      await harness.register("conn-native-holder", {
        name: "@agent/8",
        pid: 8801,
        project: "/tmp/km-wt8",
        launchId: "provider-launch-agent-8",
        launchParentPid: 88,
        takeover: true,
      }),
    )
    const sessionLinesBefore = harness.sessionLines()

    const checkpoint = parseResult<{
      joined: boolean
      observed: boolean
      name: string
      memberId: string
      transportPids: number[]
    }>(
      await harness.request("cli_join", {
        name: "@agent/8",
        role: "member",
        domains: ["test-lean"],
        delivery: "pull",
      }),
    )

    expect(checkpoint).toMatchObject({
      joined: true,
      observed: true,
      name: "@agent/8",
      memberId: holder.sessionId,
      transportPids: [8801],
    })
    expect(holderSocket.destroyedByDispatcher).toBe(false)
    expect(parseResult<CliStatusResult>(await harness.cliStatus()).sessions).toEqual([
      expect.objectContaining({ name: "@agent/8", pid: 8801 }),
    ])
    expect(harness.sessionLines()).toBe(sessionLinesBefore)
  })

  it("fails loud when no persistent native holder can own the requested persona", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const result = parseResult<{ joined: boolean; observed: boolean; error: string }>(
      await harness.request("cli_join", { name: "@agent/8", role: "member", domains: [], delivery: "pull" }),
    )

    expect(result).toMatchObject({ joined: false, observed: false })
    expect(result.error).toContain("one-shot CLI cannot establish persistent membership")
    expect(parseResult<CliStatusResult>(await harness.cliStatus()).sessions).toEqual([])
  })

  it("does not mistake a surviving watch transport for a persistent member", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    harness.addPendingClient("conn-native-holder")
    const holder = parseResult<RegisterResult>(
      await harness.register("conn-native-holder", {
        name: "@agent/8",
        pid: 8801,
        project: "/tmp/km-wt8",
        takeover: true,
      }),
    )
    harness.addWatchTransport("conn-watch", holder.sessionId)
    harness.dropClient("conn-native-holder")

    const result = parseResult<{ joined: boolean; observed: boolean; error: string }>(
      await harness.request("cli_join", { name: "@agent/8" }),
    )

    expect(result).toMatchObject({ joined: false, observed: false })
    expect(result.error).toContain("one-shot CLI cannot establish persistent membership")
    expect(parseResult<CliStatusResult>(await harness.cliStatus()).sessions).toEqual([])
  })
})

function createDispatcherHarness() {
  const tempDir = mkdtempSync(join(tmpdir(), "tribe-dispatcher-takeover-"))
  const scope = createScope("dispatcher-takeover-test")
  const db = openDatabase(join(tempDir, "tribe.sqlite"))
  const stmts = createStatements(db)
  scope.defer(() => rmSync(tempDir, { recursive: true, force: true }))
  scope.defer(() => db.close())

  const daemonCtx = createTribeContext({
    db,
    stmts,
    sessionId: "daemon-test",
    sessionRole: "daemon",
    initialName: "daemon",
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
    onMessageInserted: undefined,
  })
  const clients = new Map<string, ClientSession>()
  const socketToClient = new Map<NetSocket, string>()
  const fakeServer = createFakeServer()

  const shape = {
    scope,
    daemonSessionId: "daemon-test",
    startedAt: Date.now(),
    daemonVersion: "test",
    daemonPid: process.pid,
    config: {
      socketPath: join(tempDir, "tribe.sock"),
      dbPath: join(tempDir, "tribe.sqlite"),
      recallDbPath: join(tempDir, "recall.sqlite"),
      quitTimeoutSec: -1,
      inheritFd: null,
      focusPollMs: 60_000,
      summaryPollMs: 120_000,
      summarizerMode: "off" as const,
      recallEnabled: false,
    },
    db,
    stmts,
    daemonCtx,
    recall: null,
    registry: {
      clients,
      socketToClient,
      getActiveSessionIds(): Set<string> {
        return new Set(Array.from(clients.values(), (c) => c.ctx.sessionId))
      },
      hasActiveTransport(sessionId: string): boolean {
        return Array.from(clients.values()).some(
          (client) => client.role !== "pending" && client.ctx.sessionId === sessionId,
        )
      },
      markTransportConnected() {},
      markTransportDisconnected() {},
      isReconnectGraceProtected(): boolean {
        return false
      },
      startupReconnectGraceRemainingMs(): number {
        return 0
      },
      forgetTransportSessions() {},
      getActiveSessionInfo() {
        return Array.from(clients.values())
          .filter((client) => client.role === "member")
          .map((client) => ({
            id: client.ctx.sessionId,
            name: client.name,
            pid: client.pid,
            cwd: client.project,
            role: client.role,
            claudeSessionId: client.claudeSessionId,
            registeredAt: client.registeredAt,
            launchId: client.launchId,
            launchParentPid: client.launchParentPid,
            transportPids: client.pid > 0 ? [client.pid] : [],
          }))
      },
    },
    broadcast: {
      notify() {},
      pushToClient() {},
      persistDeliveredCursor() {},
      async toConnected() {},
      log() {},
      flushConnection() {},
      discardConnection() {},
      messageTap() {},
    },
    socket: {
      server: fakeServer,
      socketPath: join(tempDir, "tribe.sock"),
      binding: Promise.resolve("listening" as const),
      inheritedFd: false,
      startedAt: Date.now(),
      handedOff: false,
    },
  }
  const daemon = withDispatcher({ suppressWindowMs: Number.MAX_SAFE_INTEGER })(shape)

  return {
    dispatcher: daemon.dispatcher,
    register(connId: string, params: RegisterParams) {
      const req: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: `register-${connId}`,
        method: "register",
        params: {
          ...params,
          role: "member",
          projectName: "km-wt9",
          projectId: "test-project",
          delivery: "pull",
          protocolVersion: TRIBE_PROTOCOL_VERSION,
        },
      }
      return daemon.dispatcher.handleRequest(req, connId)
    },
    cliStatus() {
      return daemon.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "status", method: "cli_status", params: {} },
        "conn-status-probe",
      )
    },
    request(method: string, params: Record<string, unknown>) {
      return daemon.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: `request-${method}`, method, params },
        `conn-${method}-probe`,
      )
    },
    dropClient(connId: string): void {
      const client = clients.get(connId)
      if (client) socketToClient.delete(client.socket)
      clients.delete(connId)
    },
    addWatchTransport(connId: string, sessionId: string): TestSocket {
      const member = Array.from(clients.values()).find(
        (client) => client.role === "member" && client.ctx.sessionId === sessionId,
      )
      if (!member) throw new Error(`cannot attach watch transport: member session ${sessionId} is not connected`)
      const socket = createTestSocket()
      clients.set(connId, {
        ...member,
        socket,
        id: connId,
        role: "watch",
        conn: "test-watch",
        registeredAt: Date.now(),
        lastActivityAt: Date.now(),
      })
      socketToClient.set(socket, connId)
      return socket
    },
    /** Direct journal-row read — `event.session.superseded` rows written by logEvent(). */
    supersededEvents(name: string): Array<{ name: string; old_pid: number; new_pid: number; reason: string }> {
      const rows = db
        .prepare("SELECT content FROM messages WHERE type = 'event.session.superseded' ORDER BY ts ASC")
        .all() as Array<{ content: string }>
      return rows
        .map((r) => JSON.parse(r.content) as { name: string; old_pid: number; new_pid: number; reason: string })
        .filter((e) => e.name === name)
    },
    sessionLines(): string {
      const rows = db.prepare("SELECT content FROM messages WHERE type = 'session' ORDER BY ts ASC").all() as Array<{
        content: string
      }>
      return rows.map((row) => row.content).join("\n")
    },
    addPendingClient(connId: string): TestSocket {
      const socket = createTestSocket()
      const pendingName = `pending-${connId}`
      const pendingCtx = createTribeContext({
        db,
        stmts,
        sessionId: connId,
        sessionRole: "pending",
        initialName: pendingName,
        domains: [],
        claudeSessionId: null,
        claudeSessionName: null,
        onMessageInserted: daemonCtx.onMessageInserted,
      })
      clients.set(connId, {
        socket,
        id: connId,
        name: pendingName,
        role: "pending",
        domains: [],
        project: "/tmp/km-wt9",
        projectName: "km-wt9",
        projectId: "test-project",
        pid: 0,
        launchId: null,
        launchParentPid: null,
        claudeSessionId: null,
        peerSocket: null,
        conn: "test",
        ctx: pendingCtx,
        registeredAt: Date.now(),
        lastActivityAt: Date.now(),
        recall: { sessionId: null, claudePid: null },
      })
      socketToClient.set(socket, connId)
      return socket
    },
    db: db as Database,
    async dispose() {
      await scope[Symbol.asyncDispose]()
    },
  }
}

function parseResult<T>(line: string): T {
  const response = JSON.parse(line) as JsonRpcResponse<T>
  expect(response.error).toBeUndefined()
  expect(response.result).toBeDefined()
  return response.result as T
}

function parseError(line: string): { code: number; message: string; data?: { holder_pid?: number | null } } {
  const response = JSON.parse(line) as JsonRpcResponse<unknown>
  expect(response.result).toBeUndefined()
  expect(response.error).toBeDefined()
  return response.error!
}

function createTestSocket(): TestSocket {
  const socket = {
    destroyedByDispatcher: false,
    writes: [] as string[],
    write(payload: string | Uint8Array) {
      this.writes.push(String(payload))
      return true
    },
    destroy() {
      this.destroyedByDispatcher = true
      return this
    },
    end() {
      return this
    },
    on() {
      return this
    },
    once() {
      return this
    },
  }
  return socket as unknown as TestSocket
}

function createFakeServer(): Server {
  const server = {
    on() {
      return server
    },
    removeListener() {
      return server
    },
  }
  return server as unknown as Server
}
