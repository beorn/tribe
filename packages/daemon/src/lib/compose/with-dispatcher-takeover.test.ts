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
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Server, Socket as NetSocket } from "node:net"
import type { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getLogLevel, setLogLevel } from "loggily"
import { createScope } from "tribe-wire"
import { TRIBE_PROTOCOL_VERSION, type JsonRpcRequest } from "tribe-wire/lib/socket"
import type { TribeRole } from "tribe-wire/lib/config"
import { createTribeContext } from "../context.ts"
import { openDatabase, createStatements } from "../database.ts"
import type { ClientSession } from "./with-client-registry.ts"
import { withDispatcher, type DispatcherRuntimeHooks } from "./with-dispatcher.ts"
import type { IdentityVerdict } from "../identity-verifier.ts"

beforeEach(() => {
  // Takeover specimens intentionally exercise the dispatcher's loud ownership
  // handoff diagnostics; behavioral assertions below prove the displacement.
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

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
  idToken?: string
  mailboxAuthorityHash?: string
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

  it("consumes takeover once per launch so a displaced launch cannot reclaim the persona", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    harness.addPendingClient("conn-launch-a")
    parseResult<RegisterResult>(
      await harness.register("conn-launch-a", {
        name: "@agent/84",
        pid: 8401,
        project: "/tmp/km-wt9-launch-a",
        launchId: "provider-launch-a",
        launchParentPid: 84,
        takeover: true,
      }),
    )
    harness.db
      .prepare("INSERT INTO dedup (key, session_id, ts) VALUES (?, ?, ?)")
      .run("short-lived:test-key", "daemon-test", 0)
    harness.cleanupDedup(Number.MAX_SAFE_INTEGER)
    expect(harness.db.prepare("SELECT key FROM dedup ORDER BY key").all()).toEqual([
      { key: 'launch-takeover:["@agent/84","provider-launch-a",84]' },
    ])

    harness.addPendingClient("conn-launch-b")
    parseResult<RegisterResult>(
      await harness.register("conn-launch-b", {
        name: "@agent/84",
        pid: 8402,
        project: "/tmp/km-wt9-launch-b",
        launchId: "provider-launch-b",
        launchParentPid: 85,
        takeover: true,
      }),
    )

    harness.addPendingClient("conn-launch-a-replay")
    const replay = parseError(
      await harness.register("conn-launch-a-replay", {
        name: "@agent/84",
        pid: 8403,
        project: "/tmp/km-wt9-launch-a",
        launchId: "provider-launch-a",
        launchParentPid: 84,
        takeover: true,
      }),
    )
    expect(replay.message).toBe('Name "@agent/84" is already taken by live pid 8402')

    const status = parseResult<CliStatusResult>(await harness.cliStatus())
    expect(status.sessions.filter((session) => session.name === "@agent/84")).toEqual([
      expect.objectContaining({ pid: 8402 }),
    ])
    expect(harness.supersededEvents("@agent/84")).toHaveLength(1)
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

    harness.dropClient("conn-parent-publisher")
    harness.dropClient("conn-mcp-adapter")
    harness.dropClient("conn-parent-publisher-reconnect")

    const restartedParentSocket = harness.addPendingClient("conn-parent-after-daemon-restart")
    const restartedParent = parseResult<RegisterResult>(
      await harness.register("conn-parent-after-daemon-restart", {
        name: "@dev/2",
        pid: 48829,
        project: "/tmp/hh-wt2",
        takeover: true,
      }),
    )
    expect(restartedParent.sessionId).toBe(parent.sessionId)
    expect(restartedParentSocket.destroyedByDispatcher).toBe(false)

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

function createDispatcherHarness(hooks: DispatcherRuntimeHooks = {}) {
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
      vaultDbPath: null,
      idleQuitAfterSec: -1,
      idleQuitSource: "flag" as const,
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
      recordForeignIdentityTransport() {},
      getForeignIdentityTransport() {
        return undefined
      },
      onTransportDisconnected() {},
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
  const daemon = withDispatcher({ suppressWindowMs: Number.MAX_SAFE_INTEGER, ...hooks })(shape)

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
    cleanupDedup(cutoff: number): void {
      stmts.cleanupDedup.run({ $cutoff: cutoff })
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

// 25074 3b — the verifier seam on register (@cto 4a194bbf). The verifier is a stub keyed by token, so each case
// states exactly what the composing layer answered; hh's real module has its own test at the root.
describe("dispatcher identity verification on register (25074 3b)", () => {
  const verdicts: Record<string, IdentityVerdict | Error> = {
    "token-dev7": { result: "verified", actor: "@dev/7", sid: "sid-dev7" },
    "token-dev8": { result: "verified", actor: "@dev/8", sid: "sid-dev8" },
    "token-dead": { result: "contradicted", reason: "instance-is-live: @dev/7 is not live at generation 3" },
    "token-garbled": { result: "unreadable", reason: "malformed token" },
    "token-fault": new Error("signing key unreadable"),
  }
  const identityVerifier = {
    path: "/stub/identity-verifier.ts",
    verify: async (token: string): Promise<IdentityVerdict> => {
      const verdict = verdicts[token]
      if (verdict === undefined) throw new Error(`stub has no verdict for ${token}`)
      if (verdict instanceof Error) throw verdict
      return verdict
    },
  }
  const identitySid = (harness: ReturnType<typeof createDispatcherHarness>, name: string) =>
    (
      harness.db.prepare("SELECT identity_sid FROM sessions WHERE name = ?").get(name) as {
        identity_sid: string | null
      }
    ).identity_sid
  const membersAuthority = async (harness: ReturnType<typeof createDispatcherHarness>) => {
    const result = parseResult<{ content: Array<{ text: string }> }>(await harness.request("tribe.members", {}))
    const sessions = (JSON.parse(result.content[0]!.text) as { sessions: Array<{ name: string; authority: string }> })
      .sessions
    return Object.fromEntries(sessions.map((session) => [session.name, session.authority]))
  }

  it("a verified token registers the session keyed by its sid, and members reads it as verified", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-verified")
    parseResult<RegisterResult>(
      await harness.register("conn-verified", { name: "@dev/7", pid: 4101, project: "/tmp/p", idToken: "token-dev7" }),
    )
    harness.addPendingClient("conn-claimed")
    parseResult<RegisterResult>(
      await harness.register("conn-claimed", { name: "@dev/9", pid: 4102, project: "/tmp/p" }),
    )

    expect(identitySid(harness, "@dev/7")).toBe("sid-dev7")
    expect(await membersAuthority(harness)).toMatchObject({ "@dev/7": "verified", "@dev/9": "claimed" })
  })

  it("a token naming another actor, a contradicted token and a verifier fault each refuse register", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    const refused = async (connId: string, idToken: string) => {
      harness.addPendingClient(connId)
      return parseError(await harness.register(connId, { name: "@dev/7", pid: 4201, project: "/tmp/p", idToken }))
    }

    expect(await refused("conn-mismatch", "token-dev8")).toMatchObject({
      code: -32003,
      message: "register refused: this transport claims @dev/7, but its identity token names @dev/8",
      data: { kind: "identity-name-mismatch" },
    })
    expect(await refused("conn-dead", "token-dead")).toMatchObject({
      code: -32003,
      message: expect.stringContaining("is contradicted: instance-is-live"),
      data: { kind: "identity-contradicted" },
    })
    // A throwing verifier is a fault, never "unreadable": serving the seat as claimed would hide a broken verifier.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await refused("conn-fault", "token-fault")).toMatchObject({
      code: -32003,
      message: expect.stringContaining(
        "the identity verifier failed on the token @dev/7 presented: signing key unreadable",
      ),
      data: { kind: "identity-verifier-fault", verifier: "/stub/identity-verifier.ts" },
    })
    expect(String(errors.mock.calls.flat())).toContain("identity verifier /stub/identity-verifier.ts failed")
    expect(harness.db.prepare("SELECT count(*) AS n FROM sessions WHERE name = '@dev/7'").get()).toEqual({ n: 0 })
  })

  it("an unreadable token is served on its claimed name", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-garbled")
    parseResult<RegisterResult>(
      await harness.register("conn-garbled", {
        name: "@dev/7",
        pid: 4301,
        project: "/tmp/p",
        idToken: "token-garbled",
      }),
    )
    expect(identitySid(harness, "@dev/7")).toBeNull()
    expect(await membersAuthority(harness)).toMatchObject({ "@dev/7": "claimed" })
  })

  it("with no verifier configured a token verifies nothing: the session is served on its claimed name", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    harness.addPendingClient("conn-standalone")
    parseResult<RegisterResult>(
      await harness.register("conn-standalone", {
        name: "@dev/7",
        pid: 4302,
        project: "/tmp/p",
        idToken: "token-dev7",
      }),
    )
    expect(identitySid(harness, "@dev/7")).toBeNull()
    expect(await membersAuthority(harness)).toMatchObject({ "@dev/7": "claimed" })
  })

  it("a tokenless takeover of a live verified seat is refused as a foreign identity and the seat is untouched", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    const seatSocket = harness.addPendingClient("conn-seat")
    const seat = parseResult<RegisterResult>(
      await harness.register("conn-seat", { name: "@dev/7", pid: 4401, project: "/tmp/p", idToken: "token-dev7" }),
    )
    harness.addPendingClient("conn-squatter")
    const refusal = parseError(
      await harness.register("conn-squatter", { name: "@dev/7", pid: 4402, project: "/tmp/p", takeover: true }),
    )

    expect(refusal).toMatchObject({
      code: -32003,
      message: expect.stringContaining("claims @dev/7 with claimed authority, but a live verified session holds it"),
      data: {
        kind: "foreign-identity-transport",
        reason: "identity-precedence",
        transport: { name: "@dev/7", authority: "claimed" },
        holder: { name: "@dev/7", authority: "verified" },
      },
    })
    expect(seatSocket.destroyedByDispatcher).toBe(false)
    expect(harness.supersededEvents("@dev/7")).toEqual([])
    const status = parseResult<CliStatusResult>(await harness.cliStatus())
    expect(status.sessions.filter((session) => session.name === "@dev/7")).toEqual([
      expect.objectContaining({ pid: 4401 }),
    ])
    expect(identitySid(harness, "@dev/7")).toBe("sid-dev7")
    expect(seat.name).toBe("@dev/7")
  })

  // @cto §10 (2), 25074 3c: a bearer takeover of a verified holder asks whether that holder's instance is still live,
  // by re-verifying the token it registered with. Live refuses (verified outranks bearer); dead or superseded yields,
  // loudly; undecided refuses as a fault the claimant retries. Each case flips the holder's verdict after it registers.
  describe("a bearer takeover of a verified holder is gated on the holder's liveness (25074 3c)", () => {
    const relaunch = (harness: ReturnType<typeof createDispatcherHarness>) => {
      harness.addPendingClient("conn-relaunch")
      return harness.register("conn-relaunch", {
        name: "@dev/7",
        pid: 4552,
        project: "/tmp/p",
        takeover: true,
        launchId: "provider-launch-relaunch",
        launchParentPid: 4552,
        mailboxAuthorityHash: "b".repeat(64),
      })
    }
    const registerHolder = async (harness: ReturnType<typeof createDispatcherHarness>) => {
      verdicts["token-holder"] = { result: "verified", actor: "@dev/7", sid: "sid-holder" }
      const socket = harness.addPendingClient("conn-verified")
      parseResult<RegisterResult>(
        await harness.register("conn-verified", {
          name: "@dev/7",
          pid: 4551,
          project: "/tmp/p",
          idToken: "token-holder",
        }),
      )
      return socket
    }
    const holderUntouched = async (
      harness: ReturnType<typeof createDispatcherHarness>,
      socket: { destroyedByDispatcher: boolean },
    ) => {
      expect(socket.destroyedByDispatcher).toBe(false)
      expect(harness.supersededEvents("@dev/7")).toEqual([])
      expect(identitySid(harness, "@dev/7")).toBe("sid-holder")
      expect(await membersAuthority(harness)).toMatchObject({ "@dev/7": "verified" })
    }
    afterEach(() => {
      delete verdicts["token-holder"]
    })

    it("a live verified holder is never displaced: the bearer takeover is refused and the holder is untouched", async () => {
      const harness = createDispatcherHarness({ identityVerifier })
      cleanup = harness.dispose
      const holder = await registerHolder(harness)

      expect(parseError(await relaunch(harness))).toMatchObject({
        code: -32003,
        message: expect.stringContaining("claims @dev/7 with bearer authority, but a live verified session holds it"),
        data: {
          kind: "foreign-identity-transport",
          reason: "identity-precedence",
          transport: { name: "@dev/7", authority: "bearer" },
          holder: { name: "@dev/7", authority: "verified" },
        },
      })
      await holderUntouched(harness, holder)
    })

    it("a dead or superseded verified holder is displaced by the bearer takeover, told, and the name reads bearer", async () => {
      const harness = createDispatcherHarness({ identityVerifier })
      cleanup = harness.dispose
      const holder = await registerHolder(harness)
      verdicts["token-holder"] = {
        result: "contradicted",
        reason: "instance-is-live: seat-other-generation: @dev/7 runs generation 4, the token names 3",
      }
      parseResult<RegisterResult>(await relaunch(harness))

      expect(holder.destroyedByDispatcher).toBe(true)
      expect(harness.supersededEvents("@dev/7")).toEqual([
        expect.objectContaining({ old_pid: 4551, new_pid: 4552, reason: "explicit-persona takeover (20703)" }),
      ])
      expect(identitySid(harness, "@dev/7")).toBeNull()
      expect(await membersAuthority(harness)).toMatchObject({ "@dev/7": "bearer" })
    })

    it("a holder whose liveness is undecided refuses the takeover as a verifier fault, and the holder is untouched", async () => {
      const harness = createDispatcherHarness({ identityVerifier })
      cleanup = harness.dispose
      const holder = await registerHolder(harness)
      verdicts["token-holder"] = new Error("@dev/7 is undecided (seat-starting: start in flight)")
      const warnings = vi.spyOn(console, "warn").mockImplementation(() => {})

      expect(parseError(await relaunch(harness))).toMatchObject({
        code: -32003,
        message: expect.stringContaining("can be judged neither live nor gone right now (@dev/7 is undecided"),
        data: {
          kind: "identity-verifier-fault",
          reason: "holder-liveness-undecided",
          holder: { name: "@dev/7", authority: "verified" },
        },
      })
      warnings.mockRestore()
      await holderUntouched(harness, holder)
    })
  })

  it("a verified registration displaces a holder that only claimed the name, and the holder's journal says why", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    const claimedSocket = harness.addPendingClient("conn-claimed")
    parseResult<RegisterResult>(
      await harness.register("conn-claimed", { name: "@dev/7", pid: 4501, project: "/tmp/p" }),
    )
    harness.addPendingClient("conn-verified")
    parseResult<RegisterResult>(
      await harness.register("conn-verified", { name: "@dev/7", pid: 4502, project: "/tmp/p", idToken: "token-dev7" }),
    )

    expect(claimedSocket.destroyedByDispatcher).toBe(true)
    expect(harness.supersededEvents("@dev/7")).toEqual([
      expect.objectContaining({
        old_pid: 4501,
        new_pid: 4502,
        reason: "a verified identity displaced a claimed holder (25074)",
      }),
    ])
    expect(await membersAuthority(harness)).toMatchObject({ "@dev/7": "verified" })
  })
})

// 25074 3b — one-shot callers are dual-keyed until 3d: the launch's identity token beside the bearer. The
// capability projection and the resolution move together, so a verified seat both reads its inbox by token and
// re-certifies (launch-registration's exactLaunchMember accepts the token reason).
describe("one-shot session authority by identity token (25074 3b)", () => {
  const identityVerifier = {
    path: "/stub/identity-verifier.ts",
    verify: async (token: string): Promise<IdentityVerdict> => {
      if (token === "token-dev7") return { result: "verified", actor: "@dev/7", sid: "sid-dev7" }
      if (token === "token-dev8") return { result: "verified", actor: "@dev/8", sid: "sid-dev8" }
      if (token === "token-dead") return { result: "contradicted", reason: "instance-is-live: not live" }
      return { result: "unreadable", reason: "malformed token" }
    },
  }
  const bearer = `${"C".repeat(42)}0`
  const selfInbox = (harness: ReturnType<typeof createDispatcherHarness>, credentials: Record<string, unknown>) =>
    harness.request("cli_self_inbox_v1", { ...credentials, limit: 5, peek: true })

  it("a verified seat reads its own inbox and pending by token alone, and members says so", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-seat")
    parseResult<RegisterResult>(
      await harness.register("conn-seat", { name: "@dev/7", pid: 4601, project: "/tmp/p", idToken: "token-dev7" }),
    )

    parseResult(await selfInbox(harness, { authority: null, idToken: "token-dev7" }))
    parseResult(await harness.request("cli_session_pending_read_v1", { authority: null, idToken: "token-dev7" }))
    const members = parseResult<{ content: Array<{ text: string }> }>(await harness.request("tribe.members", {}))
    const row = (
      JSON.parse(members.content[0]!.text) as {
        sessions: Array<{ name: string; mailbox_read_capability: { state: string; reason: string } }>
      }
    ).sessions.find((session) => session.name === "@dev/7")
    expect(row?.mailbox_read_capability).toMatchObject({ state: "available", reason: "self-mailbox-authority-token" })
  })

  it("refuses a verified token no session registered under, and a contradicted token even beside a bearer", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-bearer")
    parseResult<RegisterResult>(
      await harness.register("conn-bearer", {
        name: "@dev/9",
        pid: 4701,
        project: "/tmp/p",
        mailboxAuthorityHash: createHash("sha256").update(bearer).digest("hex"),
      }),
    )

    expect(parseError(await selfInbox(harness, { authority: null, idToken: "token-dev8" }))).toMatchObject({
      code: -32003,
      message: expect.stringContaining("@dev/8's token is verified, but no session registered under its sid sid-dev8"),
      data: { kind: "unauthenticated", reason: "identity-not-registered" },
    })
    expect(parseError(await selfInbox(harness, { authority: bearer, idToken: "token-dead" }))).toMatchObject({
      code: -32003,
      data: { kind: "unauthenticated", reason: "identity-contradicted" },
    })
  })

  it("an unreadable token falls back to the bearer; with neither, the authority is missing", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-bearer")
    parseResult<RegisterResult>(
      await harness.register("conn-bearer", {
        name: "@dev/9",
        pid: 4801,
        project: "/tmp/p",
        mailboxAuthorityHash: createHash("sha256").update(bearer).digest("hex"),
      }),
    )

    parseResult(await selfInbox(harness, { authority: bearer, idToken: "token-garbled" }))
    expect(parseError(await selfInbox(harness, { authority: null, idToken: "token-garbled" }))).toMatchObject({
      code: -32004,
      message: expect.stringContaining("HAB_ID_TOKEN or AG_SESSION_AUTH must be inherited"),
    })
  })
})

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
