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
import { spawnSync } from "node:child_process"
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
import { sendMessage } from "../messaging.ts"
import { registerSession } from "../session.ts"
import { withClientRegistry } from "./with-client-registry.ts"
import { createBaseTribe } from "./base.ts"
import { withDispatcher, type DispatcherRuntimeHooks } from "./with-dispatcher.ts"
import type { IdentityVerdict } from "../identity-verifier.ts"

// Syntactically readable claims whose signature the stub verifier cannot read. This keeps WA-R31's claimed fallback
// distinct from 26524's absent or malformed-token refusal on a managed persona.
const TOKEN_WITH_UNREADABLE_SIGNATURE = `e30.${Buffer.from(JSON.stringify({ sid: "unreadable-sid", act: { sub: "@dev/7" } })).toString("base64url")}.sig`

// Most older verifier fixtures name synthetic tokens by a short key. Present those keys in a readable JWT envelope
// at register, so the new daemon syntax gate tests the real shape while each stub still receives its original key.
const fixtureToken = (key: string) =>
  `e30.${Buffer.from(JSON.stringify({ sid: "fixture-sid", act: { sub: "@fixture" }, fixture: key })).toString("base64url")}.sig`
const fixtureKey = (token: string) => {
  const payload = token.split(".")[1]
  if (payload === undefined) return token
  try {
    return (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { fixture?: string }).fixture ?? token
  } catch {
    return token
  }
}

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
  delivery?: "push" | "pull"
  adapterExitRecord?: unknown
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
  filterMode?: string
}

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (!cleanup) return
  const dispose = cleanup
  cleanup = null
  await dispose()
})

describe("dispatcher explicit-persona takeover (@ag/tribe/20703)", () => {
  // @failure 26564: explicit malformed delivery must not silently inherit the omitted declaration's push default.
  // @level l2 @consumer raw registration validation before any transport becomes eligible
  it("refuses malformed delivery and retains push only for an omitted declaration", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    harness.addPendingClient("delivery-validation")
    const params = {
      name: "delivery-validation-member",
      role: "member",
      pid: 5101,
      project: "/tmp/p",
      protocolVersion: TRIBE_PROTOCOL_VERSION,
    }
    for (const delivery of [null, "invalid", 42, {}]) {
      const refusal = parseError(
        await harness.dispatcher.handleRequest(
          {
            jsonrpc: "2.0",
            id: "invalid-delivery",
            method: "register",
            params: { ...params, delivery },
          },
          "delivery-validation",
        ),
      )
      expect(refusal.code).toBe(-32602)
      expect(refusal.message).toContain("register delivery must be push or pull")
      expect(harness.registry.isPushTransport("delivery-validation")).toBe(false)
    }
    const accepted = parseResult<RegisterResult>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "omitted-delivery",
          method: "register",
          params,
        },
        "delivery-validation",
      ),
    )
    expect(accepted).toMatchObject({ transportDelivery: "push", delivery: "push" })
    expect(harness.registry.isPushTransport("delivery-validation")).toBe(true)
  })

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

function createDispatcherHarness(
  hooks: DispatcherRuntimeHooks = {},
  seed?: (ctx: ReturnType<typeof createTribeContext>) => void,
) {
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
  seed?.(daemonCtx)
  const { registry } = withClientRegistry()(createBaseTribe({ scope }))
  const { clients, socketToClient } = registry
  const healthLogs: Array<{ type: string; message: string }> = []
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
    registry,
    broadcast: {
      notify() {},
      pushToClient() {},
      persistDeliveredCursor() {},
      async toConnected() {},
      log(message: string, type: string) {
        healthLogs.push({ message, type })
      },
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
  const verifier = hooks.identityVerifier
  const daemon = withDispatcher({
    suppressWindowMs: Number.MAX_SAFE_INTEGER,
    ...hooks,
    ...(verifier === undefined || verifier === null
      ? {}
      : {
          identityVerifier: {
            ...verifier,
            async verify(token: string) {
              const key = fixtureKey(token)
              try {
                return await verifier.verify(key)
              } catch (error) {
                // Preserve the real verifier's leakage shape: its fault may echo the presented token, not our key.
                if (key !== token && error instanceof Error) throw new Error(error.message.replaceAll(key, token))
                throw error
              }
            },
          },
        }),
  })(shape)

  return {
    dispatcher: daemon.dispatcher,
    registry,
    healthLogs,
    register(connId: string, params: RegisterParams) {
      const req: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: `register-${connId}`,
        method: "register",
        params: {
          ...params,
          ...(hooks.identityVerifier &&
          params.idToken &&
          params.idToken !== "not-a-jws" &&
          !params.idToken.includes(".")
            ? { idToken: fixtureToken(params.idToken) }
            : {}),
          role: "member",
          projectName: "km-wt9",
          projectId: "test-project",
          delivery: params.delivery ?? "pull",
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
      registry.removeTransport(connId)
    },
    addWatchTransport(connId: string, sessionId: string): TestSocket {
      const member = Array.from(clients.values()).find(
        (client) => client.role === "member" && client.ctx.sessionId === sessionId,
      )
      if (!member) throw new Error(`cannot attach watch transport: member session ${sessionId} is not connected`)
      const socket = createTestSocket()
      registry.attachTransport(connId, {
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
      registry.attachTransport(connId, {
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
    "token-dev7": { result: "verified", actor: "@dev/7", sid: "sid-dev7", gen: 1 },
    "token-dev8": { result: "verified", actor: "@dev/8", sid: "sid-dev8", gen: 1 },
    "token-watch": { result: "verified", actor: "coordination-watch", sid: "sid-watch", gen: 1 },
    "token-dead": { result: "contradicted", reason: "instance-is-live: @dev/7 is not live at generation 3" },
    "token-garbled": { result: "unreadable", reason: "malformed token" },
    "not-a-jws": { result: "unreadable", reason: "malformed token" },
    [TOKEN_WITH_UNREADABLE_SIGNATURE]: { result: "unreadable", reason: "signature key unavailable" },
    "token-absent": { result: "absent" },
    "token-fault": new Error("signing key unreadable"),
    "token-leaky": new Error("verifier failed on token-leaky"),
  }
  const identityVerifier = {
    path: "/stub/identity-verifier.ts",
    suppliesGen: false,
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
      await harness.register("conn-verified", {
        name: "@dev/7",
        pid: 4101,
        project: "/tmp/p",
        launchParentPid: 4100,
        idToken: "token-dev7",
      }),
    )
    harness.addPendingClient("conn-claimed")
    parseResult<RegisterResult>(
      await harness.register("conn-claimed", { name: "hand-shell", pid: 4102, project: "/tmp/p" }),
    )

    expect(identitySid(harness, "@dev/7")).toBe("sid-dev7")
    expect(await membersAuthority(harness)).toMatchObject({ "@dev/7": "verified", "hand-shell": "claimed" })
  })

  /**
   * @failure A managed daemon accepts an addressable persona with no usable launch token as a claimed session.
   * @level l1
   * @consumer 26524: the register refusal precedes session creation and names the repair.
   */
  it.each([
    { label: "missing", idToken: undefined },
    { label: "verifier-absent", idToken: "token-absent" },
    { label: "malformed", idToken: "not-a-jws" },
  ])("refuses a managed explicit persona with a $label identity token", async ({ label, idToken }) => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient(`conn-${label}`)
    const refusal = parseError(
      await harness.register(`conn-${label}`, { name: "@dev/9", pid: 4102, project: "/tmp/p", idToken }),
    )
    expect(refusal).toMatchObject({ code: -32003, data: { kind: "identity-token-missing" } })
    expect(refusal.message).toContain("@dev/9")
    expect(refusal.message).toContain("HAB_ID_TOKEN")
    expect(refusal.message).toContain("launch through hab")
    expect(refusal.message).toContain("join without a persona name")
    expect(harness.db.prepare("SELECT count(*) AS n FROM sessions WHERE name = '@dev/9'").get()).toEqual({ n: 0 })
    expect(harness.healthLogs).toEqual([
      { type: "health:identity-token-missing", message: expect.stringContaining("@dev/9") },
    ])
  })

  it("keeps a tokenless bare name and unnamed child claimed under a managed daemon", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-bare")
    parseResult<RegisterResult>(
      await harness.register("conn-bare", { name: "standalone", pid: 4102, project: "/tmp/p" }),
    )
    harness.addPendingClient("conn-unnamed")
    parseResult<RegisterResult>(await harness.register("conn-unnamed", { pid: 4103, project: "/tmp/p" }))
    expect(await membersAuthority(harness)).toMatchObject({ standalone: "claimed" })
    expect(harness.healthLogs).toEqual([])
  })

  /**
   * @failure A tokenless bare session registers successfully, then claims an explicit persona through join or rename.
   * @level l1
   * @consumer 26524: runtime identity changes obey the same managed-persona proof rule as register.
   */
  it.each([
    { method: "tribe.join", params: { name: "@dev/9" } },
    { method: "tribe.rename", params: { new_name: "@dev/9" } },
  ])(
    "refuses a tokenless runtime persona claim through $method while preserving the session",
    async ({ method, params }) => {
      const harness = createDispatcherHarness({ identityVerifier })
      cleanup = harness.dispose
      harness.addPendingClient("conn-bare")
      parseResult<RegisterResult>(
        await harness.register("conn-bare", { name: "standalone", pid: 4102, project: "/tmp/p" }),
      )
      const refusal = parseError(
        await harness.dispatcher.handleRequest(
          { jsonrpc: "2.0", id: `runtime-${method}`, method, params },
          "conn-bare",
        ),
      )
      expect(refusal).toMatchObject({ code: -32003, data: { kind: "identity-token-missing" } })
      expect(refusal.message).toContain("@dev/9")
      expect(refusal.message).toContain("HAB_ID_TOKEN")
      expect(harness.db.prepare("SELECT name FROM sessions WHERE name = 'standalone'").get()).toEqual({
        name: "standalone",
      })
      expect(harness.db.prepare("SELECT count(*) AS n FROM sessions WHERE name = '@dev/9'").get()).toEqual({ n: 0 })
      expect(await membersAuthority(harness)).toMatchObject({ standalone: "claimed" })
    },
  )

  /**
   * @failure A stale launch rename re-applies a persona to a tokenless bare register.
   * @level l1
   * @consumer 26524: persisted identity cannot bypass the managed register guard.
   */
  it("skips a persisted persona rename when the registering launch has no verified token", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.db
      .prepare("INSERT INTO launch_renames (launch_id, launch_parent_pid, name, renamed_at) VALUES (?, ?, ?, ?)")
      .run("bare-launch", 4101, "@dev/9", Date.now())
    harness.addPendingClient("conn-bare")
    const registered = parseResult<RegisterResult>(
      await harness.register("conn-bare", {
        name: "standalone",
        pid: 4102,
        project: "/tmp/p",
        launchId: "bare-launch",
        launchParentPid: 4101,
      }),
    )
    expect(registered.name).toBe("standalone")
    expect(await membersAuthority(harness)).toMatchObject({ standalone: "claimed" })
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).toContain('skipped persisted persona rename "@dev/9"')
  })

  it("refuses an implicit persona adoption through runtime join from a tokenless session", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-prior")
    parseResult<RegisterResult>(
      await harness.register("conn-prior", {
        name: "@dev/7",
        pid: 4101,
        project: "/tmp/p",
        idToken: "token-dev7",
        identityToken: "adoption-token",
        launchId: "sid-dev7",
        launchParentPid: 4100,
      }),
    )
    harness.dropClient("conn-prior")
    harness.addPendingClient("conn-bare")
    parseResult<RegisterResult>(
      await harness.register("conn-bare", { name: "standalone", pid: 4102, project: "/tmp/p" }),
    )
    const refusal = parseError(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "implicit-runtime-join",
          method: "tribe.join",
          params: { identity_token: "adoption-token" },
        },
        "conn-bare",
      ),
    )
    expect(refusal).toMatchObject({ code: -32003, data: { kind: "identity-token-missing" } })
    expect(harness.db.prepare("SELECT name FROM sessions WHERE name = 'standalone'").get()).toEqual({
      name: "standalone",
    })
  })

  it("refuses a bare tokenless register that would adopt a prior explicit persona by pid and cwd", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-prior")
    parseResult<RegisterResult>(
      await harness.register("conn-prior", {
        name: "@dev/7",
        pid: 4101,
        project: "/tmp/p",
        idToken: "token-dev7",
        launchId: "sid-dev7",
        launchParentPid: 4100,
      }),
    )
    harness.dropClient("conn-prior")
    harness.addPendingClient("conn-bare")
    const refusal = parseError(
      await harness.register("conn-bare", { name: "standalone", pid: 4101, project: "/tmp/p" }),
    )
    expect(refusal).toMatchObject({ code: -32003, data: { kind: "identity-token-missing" } })
    expect(refusal.message).toContain("@dev/7")
    expect(harness.db.prepare("SELECT count(*) AS n FROM sessions WHERE name = 'standalone'").get()).toEqual({ n: 0 })
    expect(identitySid(harness, "@dev/7")).toBe("sid-dev7")
    expect(harness.healthLogs).toEqual([
      { type: "health:identity-token-missing", message: expect.stringContaining("@dev/7") },
    ])
  })

  /**
   * @failure A bare register with an unusable token adopts a prior persona through pid/cwd and erases its verified sid.
   * @level l1
   * @consumer 26524: judge the effective name against the token verdict before reusing the prior session row.
   */
  it.each([
    { label: "malformed", idToken: "not-a-jws", reason: "malformed" },
    { label: "verifier-absent", idToken: "token-absent", reason: "absent" },
  ])("refuses a bare $label token adopting an explicit persona by pid and cwd", async ({ idToken, reason }) => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-prior")
    parseResult<RegisterResult>(
      await harness.register("conn-prior", {
        name: "@dev/7",
        pid: 4101,
        project: "/tmp/p",
        idToken: "token-dev7",
        launchId: "sid-dev7",
        launchParentPid: 4100,
      }),
    )
    harness.dropClient("conn-prior")
    harness.addPendingClient("conn-bare")
    const refusal = parseError(
      await harness.register("conn-bare", { name: "standalone", pid: 4101, project: "/tmp/p", idToken }),
    )
    expect(refusal).toMatchObject({ code: -32003, data: { kind: "identity-token-missing", reason } })
    expect(refusal.message).toContain("@dev/7")
    expect(harness.db.prepare("SELECT count(*) AS n FROM sessions WHERE name = 'standalone'").get()).toEqual({ n: 0 })
    expect(identitySid(harness, "@dev/7")).toBe("sid-dev7")
    expect(harness.healthLogs).toEqual([
      { type: "health:identity-token-missing", message: expect.stringContaining("@dev/7") },
    ])
  })

  it("keeps a readable token with an unreadable signature claimed after pid/cwd adoption", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-prior")
    parseResult<RegisterResult>(
      await harness.register("conn-prior", {
        name: "@dev/7",
        pid: 4101,
        project: "/tmp/p",
        idToken: "token-dev7",
        launchId: "sid-dev7",
        launchParentPid: 4100,
      }),
    )
    harness.dropClient("conn-prior")
    harness.addPendingClient("conn-bare")
    const result = parseResult<RegisterResult>(
      await harness.register("conn-bare", {
        name: "standalone",
        pid: 4101,
        project: "/tmp/p",
        idToken: TOKEN_WITH_UNREADABLE_SIGNATURE,
      }),
    )
    expect(result.name).toBe("@dev/7")
    expect(identitySid(harness, "@dev/7")).toBeNull()
    expect(await membersAuthority(harness)).toMatchObject({ "@dev/7": "claimed" })
  })

  // 25074 step 3 went live at 2026-09-24 08:02 PDT and every verified seat's `tribe inbox-status` answered "resolved to
  // 0 sessions": the CLI asks by the seat's bare launch id (HAB_SESSION_LAUNCH_ID, which IS the token's sid), and a
  // verified session is keyed "<sid>@<gen>", which neither the exact nor the "<id>::" arm of the lookup matched.
  it("a verified seat's inbox status resolves by its bare launch id, the token's sid", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-verified")
    parseResult<RegisterResult>(
      await harness.register("conn-verified", {
        name: "@dev/7",
        pid: 4101,
        project: "/tmp/p",
        launchParentPid: process.pid,
        idToken: "token-dev7",
      }),
    )
    for (const params of [
      { launch_id: "sid-dev7", id_token: "token-dev7" },
      { launch_id: "sid-dev7", persona: "@dev/7", id_token: "token-dev7" },
    ]) {
      expect(
        parseResult<{ session: string }>(
          await harness.dispatcher.handleRequest(
            {
              jsonrpc: "2.0",
              id: `verified-inbox-${params.persona ?? "bare"}`,
              method: "cli_inbox_status_by_launch_v1",
              params,
            },
            "conn-status",
          ),
        ),
      ).toMatchObject({ session: "@dev/7" })
    }
  })

  /**
   * @failure 25074 row 166: a persona-suffixed by-launch read could choose a derived session beside the verified
   * <sid>@<gen> holder instead of the session certified by the token (3d-3, @cto 657011c8).
   * @level l1
   * @consumer cli_inbox_status_by_launch_v1's token-context session filter.
   */
  it("a persona-suffixed inbox address selects its verified session beside a derived peer", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-verified")
    const verified = parseResult<RegisterResult>(
      await harness.register("conn-verified", {
        name: "@dev/7",
        pid: 4101,
        project: "/tmp/p",
        launchParentPid: process.pid,
        idToken: "token-dev7",
      }),
    )
    harness.addPendingClient("conn-derived")
    const derived = parseResult<RegisterResult>(
      await harness.register("conn-derived", {
        name: "dev8-peer",
        pid: 4102,
        project: "/tmp/p",
        launchId: "sid-dev7::dev8-peer",
        launchParentPid: process.pid,
      }),
    )
    expect(derived.sessionId).not.toBe(verified.sessionId)
    expect(harness.db.prepare("SELECT name, launch_id FROM sessions ORDER BY name").all()).toEqual([
      { name: "@dev/7", launch_id: "sid-dev7@1" },
      { name: "dev8-peer", launch_id: "sid-dev7::dev8-peer" },
    ])

    expect(
      parseResult<{ session: string; launch_id: string }>(
        await harness.dispatcher.handleRequest(
          {
            jsonrpc: "2.0",
            id: "mixed-inbox",
            method: "cli_inbox_status_by_launch_v1",
            params: { launch_id: "sid-dev7::%40dev%2F7", persona: "@dev/7", id_token: "token-dev7" },
          },
          "conn-status",
        ),
      ),
    ).toMatchObject({ session: "@dev/7", launch_id: "sid-dev7@1" })
  })

  /** @failure 25074: a raw daemon by-launch call can read a seat by guessing its launch id. */
  it("refuses a by-launch inbox read without a verified token or with another sid", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-verified")
    parseResult<RegisterResult>(
      await harness.register("conn-verified", {
        name: "@dev/7",
        pid: 4101,
        project: "/tmp/p",
        launchParentPid: process.pid,
        idToken: "token-dev7",
      }),
    )
    harness.addPendingClient("conn-other")
    parseResult<RegisterResult>(
      await harness.register("conn-other", {
        name: "@dev/8",
        pid: 4201,
        project: "/tmp/p",
        launchParentPid: process.pid,
        idToken: "token-dev8",
      }),
    )

    const refusalCount = async () => {
      const result = parseResult<{ content: Array<{ text: string }> }>(await harness.request("tribe.health", {}))
      return (
        JSON.parse(result.content[0]!.text) as {
          identity: {
            tokenless_by_launch_refusals: { count: number; last_at: string | null; last_launch_id: string | null }
          }
        }
      ).identity.tokenless_by_launch_refusals
    }
    expect(await refusalCount()).toEqual({ count: 0, last_at: null, last_launch_id: null })

    for (const [label, params, reason] of [
      ["missing", { launch_id: "sid-dev7" }, "session-authority-missing"],
      ["wrong-persona", { launch_id: "sid-dev7::%40dev%2F8", id_token: "token-dev7" }, "identity-sid-mismatch"],
      ["wrong-sid", { launch_id: "sid-dev7", id_token: "token-dev8" }, "identity-sid-mismatch"],
    ] as const) {
      const refusal = parseError(
        await harness.dispatcher.handleRequest(
          { jsonrpc: "2.0", id: label, method: "cli_inbox_status_by_launch_v1", params },
          "conn-status",
        ),
      )
      expect(refusal.message, label).toContain(label === "missing" ? "HAB_ID_TOKEN" : "sid")
      expect(refusal.data, label).toMatchObject({ reason })
      expect(JSON.stringify(refusal)).not.toContain("token-dev8")
    }
    expect(await refusalCount()).toMatchObject({ count: 1, last_launch_id: "sid-dev7" })
    expect(Date.parse((await refusalCount()).last_at ?? "")).not.toBeNaN()

    parseError(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "untrusted-launch-id",
          method: "cli_inbox_status_by_launch_v1",
          params: { launch_id: "token-leaky" },
        },
        "conn-status",
      ),
    )
    expect(await refusalCount()).toMatchObject({ count: 2, last_launch_id: null })
    expect(JSON.stringify(await refusalCount())).not.toContain("token-leaky")
    const members = parseResult<{ content: Array<{ text: string }> }>(await harness.request("tribe.members", {}))
    const rows = (JSON.parse(members.content[0]!.text) as { sessions: Array<Record<string, unknown>> }).sessions
    expect(rows.find((row) => row.name === "@dev/7")?.foreign_transport).toMatchObject({
      name: "@dev/8",
      launch_id: "sid-dev8",
    })
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const leaked = parseError(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "leaky-verifier",
          method: "cli_inbox_status_by_launch_v1",
          params: { launch_id: "sid-dev7", id_token: "token-leaky" },
        },
        "conn-status",
      ),
    )
    expect(leaked.data).toMatchObject({ reason: "identity-verifier-fault" })
    expect(JSON.stringify(leaked)).not.toContain("token-leaky")
    expect(JSON.stringify(errors.mock.calls)).not.toContain("token-leaky")
    errors.mockRestore()
    const journal = harness.db.prepare("SELECT content FROM messages").all() as Array<{ content: string }>
    expect(JSON.stringify(journal)).not.toContain("token-dev8")
    expect(JSON.stringify(journal)).not.toContain("token-leaky")
  })

  /** @failure 25074: a cross-seat health reader loses turn receipts when by-launch reads become self-only. */
  it("serves a turn receipt to a verified explicit reader and refuses tokenless or launch-targeted reads", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-seat")
    parseResult<RegisterResult>(
      await harness.register("conn-seat", {
        name: "@dev/7",
        pid: 4101,
        project: "/tmp/p",
        launchParentPid: process.pid,
        idToken: "token-dev7",
      }),
    )
    parseResult(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "turn-started",
          method: "host_turn_started_v1",
          params: {
            controller_session_id: "controller-1",
            provider_session_id: "provider-1",
            provider_turn_id: "turn-1",
            started_at: 1234,
          },
        },
        "conn-seat",
      ),
    )
    const read = (id: string, params: Record<string, unknown>) =>
      harness.dispatcher.handleRequest({ jsonrpc: "2.0", id, method: "cli_turn_start_receipt", params }, "conn-status")
    const received = parseResult<{ session: string; provider_turn_id: string }>(
      await read("watcher", { session: "@dev/7", id_token: "token-watch" }),
    )
    expect(received).toMatchObject({ session: "@dev/7", provider_turn_id: "turn-1" })
    expect(JSON.stringify(received)).not.toContain("token-watch")
    expect(parseError(await read("missing-token", { session: "@dev/7" }))).toMatchObject({
      code: -32004,
      message: expect.stringContaining("HAB_ID_TOKEN"),
    })
    expect(
      parseError(
        await read("launch-override", {
          session: "@dev/7",
          launch_id: "sid-dev7",
          id_token: "token-watch",
        }),
      ),
    ).toMatchObject({ code: -32602, message: expect.stringContaining("not launch identity") })
    const journal = harness.db.prepare("SELECT content FROM messages").all() as Array<{ content: string }>
    expect(JSON.stringify(journal)).not.toContain("token-watch")
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

  it("reports and pages a post-boot verifier fault, then clears on repair without exposing the token", async () => {
    const token = "secret-token-must-stay-private"
    let broken = true
    const harness = createDispatcherHarness({
      identityVerifier: {
        path: "/stub/identity-verifier.ts",
        suppliesGen: true,
        verify: async (presented) => {
          if (presented === TOKEN_WITH_UNREADABLE_SIGNATURE) {
            return { result: "unreadable", reason: "signature key unavailable" }
          }
          if (broken) throw new Error(`signing key unreadable for ${token}`)
          return { result: "verified", actor: "@dev/7", sid: "sid-dev7", gen: 1 }
        },
      },
    })
    cleanup = harness.dispose
    const health = async () => {
      const result = parseResult<{ content: Array<{ text: string }> }>(await harness.request("tribe.health", {}))
      return JSON.parse(result.content[0]!.text) as { issues: string[] }
    }
    expect((await health()).issues).not.toContainEqual(expect.stringContaining("identity verifier"))

    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    harness.addPendingClient("conn-key-broken")
    const refusal = parseError(
      await harness.register("conn-key-broken", {
        name: "@dev/7",
        pid: 4201,
        project: "/tmp/p",
        launchParentPid: process.pid,
        idToken: token,
      }),
    )
    expect(refusal.data).toMatchObject({ kind: "identity-verifier-fault" })
    const degraded = await health()
    expect(degraded.issues).toContainEqual(expect.stringContaining("signing key unreadable"))
    expect(degraded.issues).toContainEqual(expect.stringContaining("/stub/identity-verifier.ts"))
    const pages = harness.db
      .prepare(
        "SELECT recipient, content, type FROM messages WHERE type = 'health:identity-verifier-fault' ORDER BY ts",
      )
      .all() as Array<{ recipient: string; content: string; type: string }>
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ recipient: "@chief", content: expect.stringContaining("signing key unreadable") })
    expect(
      harness.db.prepare("SELECT count(*) AS n FROM pending_request WHERE request_kind = 'incident'").get(),
    ).toEqual({ n: 1 })
    expect(JSON.stringify({ refusal, degraded, pages, errors: errors.mock.calls })).not.toContain(token)

    // Parsing a malformed caller token does not prove the key is repaired.
    harness.addPendingClient("conn-malformed")
    parseResult<RegisterResult>(
      await harness.register("conn-malformed", {
        name: "@dev/8",
        pid: 4203,
        project: "/tmp/p",
        idToken: TOKEN_WITH_UNREADABLE_SIGNATURE,
      }),
    )
    expect((await health()).issues).toContainEqual(expect.stringContaining("signing key unreadable"))

    broken = false
    harness.addPendingClient("conn-key-repaired")
    parseResult<RegisterResult>(
      await harness.register("conn-key-repaired", {
        name: "@dev/7",
        pid: 4202,
        project: "/tmp/p",
        launchParentPid: process.pid,
        idToken: token,
      }),
    )
    expect((await health()).issues).not.toContainEqual(expect.stringContaining("identity verifier"))
    expect(
      harness.db.prepare("SELECT count(*) AS n FROM pending_request WHERE request_kind = 'incident'").get(),
    ).toEqual({ n: 0 })
    const clear = harness.db
      .prepare(
        "SELECT recipient, content FROM messages WHERE type = 'health:identity-verifier-fault' ORDER BY ts DESC LIMIT 1",
      )
      .get() as { recipient: string; content: string }
    expect(clear).toMatchObject({ recipient: "@chief", content: expect.stringContaining("repaired") })
    expect(JSON.stringify(clear)).not.toContain(token)
  })

  it("restores an open verifier incident into health after restart, then clears it on verified repair", async () => {
    const issue = "identity verifier /stub/identity-verifier.ts failed: signing key unreadable"
    const harness = createDispatcherHarness(
      {
        identityVerifier: {
          path: "/stub/identity-verifier.ts",
          suppliesGen: true,
          verify: async () => ({ result: "verified", actor: "@dev/7", sid: "sid-dev7", gen: 1 }),
        },
      },
      (ctx) => {
        sendMessage(
          ctx,
          "@chief",
          issue,
          "health:identity-verifier-fault",
          undefined,
          undefined,
          "direct",
          {
            summary: issue,
          },
          { incident: { emitter: "wire", subject: "identity-verifier", condition: "fault" } },
        )
      },
    )
    cleanup = harness.dispose
    const readIssues = async () => {
      const result = parseResult<{ content: Array<{ text: string }> }>(await harness.request("tribe.health", {}))
      return (JSON.parse(result.content[0]!.text) as { issues: string[] }).issues
    }
    expect(await readIssues()).toContain(issue)
    expect(
      harness.db.prepare("SELECT count(*) AS n FROM pending_request WHERE request_kind = 'incident'").get(),
    ).toEqual({ n: 1 })

    harness.addPendingClient("conn-repaired-after-restart")
    parseResult<RegisterResult>(
      await harness.register("conn-repaired-after-restart", {
        name: "@dev/7",
        pid: 4204,
        project: "/tmp/p",
        launchParentPid: process.pid,
        idToken: "verified-token",
      }),
    )
    expect(await readIssues()).not.toContain(issue)
    expect(
      harness.db.prepare("SELECT count(*) AS n FROM pending_request WHERE request_kind = 'incident'").get(),
    ).toEqual({ n: 0 })
  })

  it("a syntactically readable token with an unreadable signature is served on its claimed name", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-garbled")
    parseResult<RegisterResult>(
      await harness.register("conn-garbled", {
        name: "@dev/7",
        pid: 4301,
        project: "/tmp/p",
        idToken: TOKEN_WITH_UNREADABLE_SIGNATURE,
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

  it("a tokenless takeover of a live verified persona is refused before displacement", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    const seatSocket = harness.addPendingClient("conn-seat")
    const seat = parseResult<RegisterResult>(
      await harness.register("conn-seat", {
        name: "@dev/7",
        pid: 4401,
        project: "/tmp/p",
        launchParentPid: 4400,
        idToken: "token-dev7",
      }),
    )
    harness.addPendingClient("conn-squatter")
    const refusal = parseError(
      await harness.register("conn-squatter", { name: "@dev/7", pid: 4402, project: "/tmp/p", takeover: true }),
    )

    expect(refusal).toMatchObject({
      code: -32003,
      message: expect.stringContaining("explicit persona @dev/7 has a missing HAB_ID_TOKEN"),
      data: { kind: "identity-token-missing" },
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

  it("a verified registration displaces a holder with an unreadable token, and the holder's journal says why", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    const claimedSocket = harness.addPendingClient("conn-claimed")
    parseResult<RegisterResult>(
      await harness.register("conn-claimed", {
        name: "@dev/7",
        pid: 4501,
        project: "/tmp/p",
        idToken: TOKEN_WITH_UNREADABLE_SIGNATURE,
      }),
    )
    harness.addPendingClient("conn-verified")
    parseResult<RegisterResult>(
      await harness.register("conn-verified", {
        name: "@dev/7",
        pid: 4502,
        project: "/tmp/p",
        launchParentPid: 4500,
        idToken: "token-dev7",
      }),
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

// 25074 3c-2a (@cto aa2918fd): a verified register that sends no launch id takes its launch identity from the token,
// `<sid>@<gen>`, so fan-in, the takeover fence and the launch-declared filter key on it unchanged. A verdict without
// gen cannot key such a session and refuses by name; a sender that still sends a launch id keeps that path.
describe("token-keyed launch identity (25074 3c-2a)", () => {
  const verdicts: Record<string, IdentityVerdict> = {
    "token-g3": { result: "verified", actor: "@dev/7", sid: "sid-dev7", gen: 3 },
    "token-g4": { result: "verified", actor: "@dev/7", sid: "sid-dev7", gen: 4 },
    "token-g2": { result: "verified", actor: "@dev/7", sid: "sid-dev7", gen: 2 },
    "token-nogen": { result: "verified", actor: "@dev/7", sid: "sid-dev7" },
    "token-dead": { result: "contradicted", reason: "instance-is-live: @dev/7 is not live at generation 3" },
    [TOKEN_WITH_UNREADABLE_SIGNATURE]: { result: "unreadable", reason: "signature key unavailable" },
    "token-job": { result: "verified", actor: "state-checkout-sync", sid: "state-checkout-sync:1790263588867", gen: 0 },
  }
  const identityVerifier = {
    path: "/stub/identity-verifier.ts",
    suppliesGen: true,
    verify: async (token: string): Promise<IdentityVerdict> => {
      const verdict = verdicts[token]
      if (verdict === undefined) throw new Error(`stub has no verdict for ${token}`)
      return verdict
    },
  }
  const sessionRow = (harness: ReturnType<typeof createDispatcherHarness>, sessionId: string) =>
    harness.db
      .prepare(
        "SELECT launch_id, launch_parent_pid, identity_sid, identity_gen, verified_id_token, filter_mode FROM sessions WHERE id = ?",
      )
      .get(sessionId) as {
      launch_id: string | null
      launch_parent_pid: number | null
      identity_sid: string | null
      identity_gen: number | null
      verified_id_token: string | null
      filter_mode: string | null
    }

  // 24604 (a), @cto 5b98b2a1: a verified successor generation replaces a predecessor that is between connections,
  // even while the predecessor's launch parent lives; the same generation from another parent stays refused.
  const departures = (harness: ReturnType<typeof createDispatcherHarness>) =>
    (
      harness.db.prepare("SELECT content, ref FROM messages WHERE type = 'event.session.left'").all() as Array<{
        content: string
        ref: string
      }>
    ).map((row) => ({ ref: row.ref, ...(JSON.parse(row.content) as Record<string, unknown>) }))

  it("a successor generation displaces a predecessor between connections with a live parent, naming both gens", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-g3")
    const predecessor = parseResult<RegisterResult>(
      await harness.register("conn-g3", {
        name: "@dev/7",
        pid: 5201,
        project: "/tmp/p",
        launchParentPid: process.pid,
        idToken: "token-g3",
      }),
    )
    harness.dropClient("conn-g3")
    harness.addPendingClient("conn-g4")
    const successor = parseResult<RegisterResult>(
      await harness.register("conn-g4", {
        name: "@dev/7",
        pid: 5202,
        project: "/tmp/p",
        launchParentPid: process.pid,
        idToken: "token-g4",
      }),
    )
    expect(successor.sessionId).not.toBe(predecessor.sessionId)
    expect(sessionRow(harness, successor.sessionId)).toMatchObject({ launch_id: "sid-dev7@4" })
    expect(harness.db.prepare("SELECT id FROM sessions WHERE id = ?").get(predecessor.sessionId)).toBeNull()
    expect(departures(harness)).toContainEqual(
      expect.objectContaining({
        ref: predecessor.sessionId,
        reason: "replaced-by-successor-generation",
        holder_gen: 3,
        successor_gen: 4,
      }),
    )
  })

  it("the same generation from another parent is refused while the holder's parent lives", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-g3")
    const holder = parseResult<RegisterResult>(
      await harness.register("conn-g3", {
        name: "@dev/7",
        pid: 5301,
        project: "/tmp/p",
        launchParentPid: process.pid,
        idToken: "token-g3",
      }),
    )
    harness.dropClient("conn-g3")
    harness.addPendingClient("conn-g3-other")
    const refused = parseError(
      await harness.register("conn-g3-other", {
        name: "@dev/7",
        pid: 5302,
        project: "/tmp/p",
        launchParentPid: process.ppid,
        idToken: "token-g3",
      }),
    )
    expect(refused.message).toBe(
      `Name "@dev/7" belongs to launch sid-dev7@3, whose parent process ${process.pid} is alive (same start time). ` +
        "Its session is between connections, not gone. Stop that process or wait for it to exit, then register again.",
    )
    expect(harness.db.prepare("SELECT id FROM sessions WHERE id = ?").get(holder.sessionId)).toEqual({
      id: holder.sessionId,
    })
  })

  // 25666: an unverified claim proves no lineage, so it never takes a verified durable holder's row by launch id alone.
  // Only the launch's own parent reconnecting without its token is still that launch.
  const verifiedHolderBetweenConnections = async (harness: ReturnType<typeof createDispatcherHarness>) => {
    harness.addPendingClient("conn-g3")
    const holder = parseResult<RegisterResult>(
      await harness.register("conn-g3", {
        name: "@dev/7",
        pid: 5401,
        project: "/tmp/p",
        launchParentPid: process.pid,
        idToken: "token-g3",
      }),
    )
    harness.dropClient("conn-g3")
    return holder
  }

  it("an unverified claim of a verified holder's launch id from another live parent is refused, and the row stays", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    const holder = await verifiedHolderBetweenConnections(harness)
    harness.addPendingClient("conn-unverified")
    const refused = parseError(
      await harness.register("conn-unverified", {
        name: "@dev/7",
        pid: 5402,
        project: "/tmp/p",
        idToken: TOKEN_WITH_UNREADABLE_SIGNATURE,
        launchId: "sid-dev7@3",
        launchParentPid: process.ppid,
      }),
    )
    expect(refused.message).toBe(
      `Name "@dev/7" belongs to launch sid-dev7@3, whose parent process ${process.pid} is alive (same start time). ` +
        "Its session is between connections, not gone. Stop that process or wait for it to exit, then register again.",
    )
    expect(sessionRow(harness, holder.sessionId)).toMatchObject({ launch_id: "sid-dev7@3", identity_sid: "sid-dev7" })
    expect(departures(harness)).not.toContainEqual(expect.objectContaining({ ref: holder.sessionId }))
  })

  it("an unverified claim of a CONNECTED verified holder's launch id is refused too, and the holder stays", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-g3")
    const holder = parseResult<RegisterResult>(
      await harness.register("conn-g3", {
        name: "@dev/7",
        pid: 5501,
        project: "/tmp/p",
        launchParentPid: process.pid,
        idToken: "token-g3",
      }),
    )
    harness.addPendingClient("conn-unverified")
    const refused = parseError(
      await harness.register("conn-unverified", {
        name: "@dev/7",
        pid: 5502,
        project: "/tmp/p",
        idToken: TOKEN_WITH_UNREADABLE_SIGNATURE,
        launchId: "sid-dev7@3",
        launchParentPid: process.ppid,
      }),
    )
    expect(refused.message).toBe('Name "@dev/7" is already taken by live pid 5501')
    expect(sessionRow(harness, holder.sessionId)).toMatchObject({ launch_id: "sid-dev7@3", identity_sid: "sid-dev7" })
  })

  it("the verified launch's own parent cannot reconnect its persona without its token", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    const holder = await verifiedHolderBetweenConnections(harness)
    harness.addPendingClient("conn-own-parent")
    const refused = parseError(
      await harness.register("conn-own-parent", {
        name: "@dev/7",
        pid: 5403,
        project: "/tmp/p",
        launchId: "sid-dev7@3",
        launchParentPid: process.pid,
      }),
    )
    expect(refused.data).toMatchObject({ kind: "identity-token-missing" })
    expect(sessionRow(harness, holder.sessionId)).toMatchObject({ identity_sid: "sid-dev7", identity_gen: 3 })
    expect(departures(harness)).toEqual([])
  })

  // 25688: the own-parent reconnect formerly restated the row with identity_sid null. The new refusal must leave it
  // verified, so an unreadable-token claim from another parent still cannot take it.
  it("a refused tokenless own-parent reconnect preserves verified identity and the foreign-parent fence", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    const holder = await verifiedHolderBetweenConnections(harness)
    const verified = sessionRow(harness, holder.sessionId)
    expect(verified).toMatchObject({ identity_sid: "sid-dev7", identity_gen: 3 })
    harness.addPendingClient("conn-own-parent")
    const ownRefusal = parseError(
      await harness.register("conn-own-parent", {
        name: "@dev/7",
        pid: 5403,
        project: "/tmp/p",
        launchId: "sid-dev7@3",
        launchParentPid: process.pid,
      }),
    )
    expect(ownRefusal.data).toMatchObject({ kind: "identity-token-missing" })
    expect(sessionRow(harness, holder.sessionId)).toMatchObject({
      identity_sid: "sid-dev7",
      identity_gen: 3,
      verified_id_token: verified.verified_id_token,
    })
    harness.dropClient("conn-own-parent")

    harness.addPendingClient("conn-unverified")
    const refused = parseError(
      await harness.register("conn-unverified", {
        name: "@dev/7",
        pid: 5404,
        project: "/tmp/p",
        idToken: TOKEN_WITH_UNREADABLE_SIGNATURE,
        launchId: "sid-dev7@3",
        launchParentPid: process.ppid,
      }),
    )
    expect(refused.message).toMatch(/belongs to launch sid-dev7@3, whose parent process \d+ is alive/u)
    expect(sessionRow(harness, holder.sessionId)).toMatchObject({ launch_id: "sid-dev7@3", identity_sid: "sid-dev7" })
  })

  // 25688 P4: a tokenless persona cannot adopt the row even if it names the same launch id from another parent.
  it("a tokenless persona claiming the same launch id from another parent is refused", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    // The holder's parent has exited; the missing token still prevents a claimed replacement.
    const deadParent = spawnSync("true").pid as number
    harness.addPendingClient("conn-dead-parent")
    const holder = parseResult<RegisterResult>(
      await harness.register("conn-dead-parent", {
        name: "@dev/7",
        pid: 5401,
        project: "/tmp/p",
        launchParentPid: deadParent,
        idToken: "token-g3",
      }),
    )
    harness.dropClient("conn-dead-parent")
    harness.addPendingClient("conn-other-parent")
    const refusal = parseError(
      await harness.register("conn-other-parent", {
        name: "@dev/7",
        pid: 5401,
        project: "/tmp/p",
        launchId: "sid-dev7@3",
        launchParentPid: process.pid,
      }),
    )
    expect(refusal.data).toMatchObject({ kind: "identity-token-missing" })
    expect(sessionRow(harness, holder.sessionId)).toMatchObject({
      identity_sid: "sid-dev7",
      identity_gen: 3,
      verified_id_token: fixtureToken("token-g3"),
    })
  })

  it("a tokenless persona claiming another launch id from the same parent is refused", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    const holder = await verifiedHolderBetweenConnections(harness)
    harness.addPendingClient("conn-other-launch")
    const refusal = parseError(
      await harness.register("conn-other-launch", {
        name: "@dev/7",
        pid: 5401,
        project: "/tmp/p",
        launchId: "sid-dev7@2",
        launchParentPid: process.pid,
      }),
    )
    expect(refusal.data).toMatchObject({ kind: "identity-token-missing" })
    expect(sessionRow(harness, holder.sessionId)).toMatchObject({
      identity_sid: "sid-dev7",
      identity_gen: 3,
      verified_id_token: fixtureToken("token-g3"),
    })
  })

  // @failure A later pull bootstrap demotes push, or a push adapter fans in without updating delivery.
  // @level l2
  // @consumer Fresh managed Claude launches with both bootstrap and adapter (26564).
  it.each([
    ["pull", "push"],
    ["push", "pull"],
  ] as const)(
    "keeps a mixed verified launch push in attachment order %s then %s",
    async (firstDelivery, secondDelivery) => {
      const harness = createDispatcherHarness({ identityVerifier })
      cleanup = harness.dispose
      const exitRecord = "/tmp/tribe-test-adapter-exit.json"
      const eligibleExitRecords: unknown[] = []
      const stopObservation = harness.registry.onTransportsChanged((sessionId) => {
        if (harness.registry.getSessionDelivery(sessionId) === "push") {
          eligibleExitRecords.push(
            harness.db.prepare("SELECT adapter_exit_record FROM sessions WHERE id = ?").get(sessionId),
          )
        }
      })
      harness.addPendingClient("conn-first-delivery")
      const first = parseResult<RegisterResult>(
        await harness.register("conn-first-delivery", {
          name: "@dev/7",
          pid: 5101,
          project: "/tmp/p",
          takeover: true,
          launchParentPid: 5100,
          idToken: "token-g3",
          delivery: firstDelivery,
          ...(firstDelivery === "push" ? { adapterExitRecord: exitRecord } : {}),
        }),
      )
      harness.addPendingClient("conn-second-delivery")
      const second = parseResult<RegisterResult>(
        await harness.register("conn-second-delivery", {
          name: "@dev/7",
          pid: 5102,
          project: "/tmp/p",
          takeover: true,
          launchParentPid: 5100,
          idToken: "token-g3",
          delivery: secondDelivery,
          ...(secondDelivery === "push" ? { adapterExitRecord: exitRecord } : {}),
        }),
      )
      expect(second.sessionId).toBe(first.sessionId)
      expect(harness.db.prepare("SELECT adapter_exit_record FROM sessions WHERE id = ?").get(first.sessionId)).toEqual({
        adapter_exit_record: exitRecord,
      })
      expect(harness.db.prepare("SELECT delivery FROM sessions WHERE id = ?").get(first.sessionId)).toEqual({
        delivery: "push",
      })
      expect(first).toMatchObject({ transportDelivery: firstDelivery, delivery: firstDelivery })
      expect(second).toMatchObject({ transportDelivery: secondDelivery, delivery: "push" })
      expect(eligibleExitRecords.length).toBeGreaterThan(0)
      for (const row of eligibleExitRecords) expect(row).toEqual({ adapter_exit_record: exitRecord })
      stopObservation()
      // A refresh by the pull transport cannot demote its still-connected push sibling.
      const pullConn = firstDelivery === "pull" ? "conn-first-delivery" : "conn-second-delivery"
      const pushConn = firstDelivery === "push" ? "conn-first-delivery" : "conn-second-delivery"
      const joined = parseResult<{ content: Array<{ text: string }> }>(
        await harness.dispatcher.handleRequest(
          { jsonrpc: "2.0", id: "pull-refresh", method: "tribe.join", params: { name: "@dev/7", delivery: "pull" } },
          pullConn,
        ),
      )
      expect(JSON.parse(joined.content[0]!.text)).toMatchObject({
        joined: true,
        transportDelivery: "pull",
        delivery: "push",
      })
      expect(harness.db.prepare("SELECT delivery FROM sessions WHERE id = ?").get(first.sessionId)).toEqual({
        delivery: "push",
      })
      expect(harness.db.prepare("SELECT adapter_exit_record FROM sessions WHERE id = ?").get(first.sessionId)).toEqual({
        adapter_exit_record: exitRecord,
      })
      harness.dropClient(pushConn)
      expect(harness.db.prepare("SELECT delivery FROM sessions WHERE id = ?").get(first.sessionId)).toEqual({
        delivery: "pull",
      })
    },
  )

  // @failure 26564: an old daemon's persisted push mode must not certify a consumer after startup.
  // @level l2 @consumer restarted daemon session delivery projection
  it("resets a stale disconnected push projection before accepting registrations", () => {
    const harness = createDispatcherHarness({}, (ctx) => {
      const stale = createTribeContext({
        ...ctx,
        sessionId: "stale-push-session",
        sessionRole: "member",
        initialName: "stale-push-member",
      })
      registerSession(stale, "test-project", undefined, undefined, 0, "push")
      expect(ctx.db.prepare("SELECT delivery FROM sessions WHERE id = ?").get(stale.sessionId)).toEqual({
        delivery: "push",
      })
    })
    cleanup = harness.dispose
    expect(harness.db.prepare("SELECT delivery FROM sessions WHERE id = ?").get("stale-push-session")).toEqual({
      delivery: "pull",
    })
    expect(harness.registry.getSessionDelivery("stale-push-session")).toBe("pull")
  })

  // @failure 26564: a fan-in cannot accept unusable exit metadata and then expose the push transport.
  // @level l2 @consumer adapter registration refusal and the surviving bootstrap
  it.each(["relative-exit.json", null, 42])("refuses fan-in with invalid adapterExitRecord %s", async (badPath) => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("exit-bootstrap")
    const bootstrap = parseResult<RegisterResult>(
      await harness.register("exit-bootstrap", {
        name: "@dev/7",
        pid: 5101,
        project: "/tmp/p",
        takeover: true,
        launchParentPid: 5100,
        idToken: "token-g3",
        delivery: "pull",
      }),
    )
    harness.addPendingClient("bad-exit-adapter")
    const refusal = parseError(
      await harness.register("bad-exit-adapter", {
        name: "@dev/7",
        pid: 5102,
        project: "/tmp/p",
        takeover: true,
        launchParentPid: 5100,
        idToken: "token-g3",
        delivery: "push",
        adapterExitRecord: badPath,
      }),
    )
    expect(refusal.code).toBe(-32602)
    expect(refusal.message).toContain("adapterExitRecord must be an absolute file path")
    expect(harness.registry.isPushTransport("bad-exit-adapter")).toBe(false)
    expect(
      harness.db.prepare("SELECT delivery, adapter_exit_record FROM sessions WHERE id = ?").get(bootstrap.sessionId),
    ).toEqual({
      delivery: "pull",
      adapter_exit_record: null,
    })
  })

  it("the bootstrap and the adapter of one generation fan into ONE session keyed sid@gen, and the filter applies", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    const bootstrapSocket = harness.addPendingClient("conn-bootstrap")
    const bootstrap = parseResult<RegisterResult>(
      await harness.register("conn-bootstrap", {
        name: "@dev/7",
        pid: 5101,
        project: "/tmp/p",
        takeover: true,
        launchParentPid: 5100,
        idToken: "token-g3",
      }),
    )
    const adapterSocket = harness.addPendingClient("conn-adapter")
    const adapter = parseResult<RegisterResult>(
      await harness.register("conn-adapter", {
        name: "@dev/7",
        pid: 5102,
        project: "/tmp/p",
        takeover: true,
        launchParentPid: 5100,
        idToken: "token-g3",
        filterMode: "focus",
      }),
    )

    expect(adapter.sessionId).toBe(bootstrap.sessionId)
    expect(bootstrapSocket.destroyedByDispatcher).toBe(false)
    expect(adapterSocket.destroyedByDispatcher).toBe(false)
    expect(harness.supersededEvents("@dev/7")).toEqual([])
    expect(sessionRow(harness, bootstrap.sessionId)).toEqual({
      launch_id: "sid-dev7@3",
      launch_parent_pid: 5100,
      identity_sid: "sid-dev7",
      filter_mode: "focus",
      identity_gen: 3,
      verified_id_token: fixtureToken("token-g3"),
    })
  })

  it("a verified verdict without gen, from a sender that sent no launch id, refuses by name", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-nogen")
    expect(
      parseError(
        await harness.register("conn-nogen", {
          name: "@dev/7",
          pid: 5201,
          project: "/tmp/p",
          launchParentPid: 5200,
          idToken: "token-nogen",
        }),
      ),
    ).toMatchObject({
      code: -32003,
      message: expect.stringContaining("verifier verdict carries no gen; the daemon cannot key this session"),
      data: { kind: "identity-verdict-without-gen" },
    })
    expect(harness.db.prepare("SELECT count(*) AS n FROM sessions WHERE name = '@dev/7'").get()).toEqual({ n: 0 })
  })

  // 25074 3c-2b forward fix (@cto 95c2be2d): the client never omits a launch id it was given, and the daemon decides
  // the keying from the one register that carries both.
  it("(a) a verified token with gen keys sid@gen even beside a launch id whose provider part is its sid", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-both")
    const registered = parseResult<RegisterResult & { launchId?: string }>(
      await harness.register("conn-both", {
        name: "@dev/7",
        pid: 5301,
        project: "/tmp/p",
        launchId: "sid-dev7::%40dev%2F7",
        launchParentPid: 5300,
        idToken: "token-g3",
      }),
    )
    expect(registered.launchId).toBe("sid-dev7@3")
    expect(sessionRow(harness, registered.sessionId)).toMatchObject({
      launch_id: "sid-dev7@3",
      identity_sid: "sid-dev7",
    })
  })

  // 25074 P1 (@chief 2e492d1c): a hab job's environment carries its persona launch id `<svc>:<occurrence>::<svc>`,
  // while its verified session is keyed `<svc>:<occurrence>@<gen>`. The one-shot send resolves its caller by that
  // launch id, so the verified range is over the provider part, or every scheduled job's page is refused.
  it("a hab job's verified session resolves by the persona launch id its environment carries", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    const launchId = "state-checkout-sync:1790263588867::state-checkout-sync"
    harness.addPendingClient("conn-job")
    const registered = parseResult<RegisterResult & { launchId?: string }>(
      await harness.register("conn-job", {
        name: "state-checkout-sync",
        pid: 5351,
        project: "/tmp/p",
        launchId,
        launchParentPid: 5350,
        idToken: "token-job",
      }),
    )
    expect(registered.launchId).toBe("state-checkout-sync:1790263588867@0")
    for (const params of [
      { launch_id: launchId, id_token: "token-job" },
      { launch_id: launchId, persona: "state-checkout-sync", id_token: "token-job" },
    ]) {
      expect(
        parseResult<{ session: string; launch_id: string }>(
          await harness.dispatcher.handleRequest(
            {
              jsonrpc: "2.0",
              id: `job-inbox-${params.persona ?? "bare"}`,
              method: "cli_inbox_status_by_launch_v1",
              params,
            },
            "conn-status",
          ),
        ),
      ).toMatchObject({ session: "state-checkout-sync", launch_id: "state-checkout-sync:1790263588867@0" })
    }
  })

  it("(a) a verified token beside a launch id of another sid is refused by name, and nothing registers", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-mismatch")
    const refused = parseError(
      await harness.register("conn-mismatch", {
        name: "@dev/7",
        pid: 5311,
        project: "/tmp/p",
        launchId: "sid-other::%40dev%2F7",
        launchParentPid: 5310,
        idToken: "token-g3",
      }),
    )
    expect(refused).toMatchObject({
      code: -32003,
      data: { kind: "identity-mismatch", launch_id: "sid-other::%40dev%2F7", sid: "sid-dev7" },
    })
    expect(harness.db.prepare("SELECT count(*) AS n FROM sessions WHERE name = '@dev/7'").get()).toEqual({ n: 0 })
  })

  it("a verified token without gen beside its own launch id keeps that launch identity", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-legacy")
    const registered = parseResult<RegisterResult>(
      await harness.register("conn-legacy", {
        name: "@dev/7",
        pid: 5301,
        project: "/tmp/p",
        launchId: "sid-dev7::%40dev%2F7",
        launchParentPid: 5300,
        idToken: "token-nogen",
      }),
    )
    expect(sessionRow(harness, registered.sessionId)).toMatchObject({
      launch_id: "sid-dev7::%40dev%2F7",
      identity_sid: "sid-dev7",
    })
  })

  // @cto ab05bc5c dropped 95c2be2d's (b): hab's job and controller tokens verify to no sid (they were refused -32602,
  // after verification), so the launch id the client now always sends is their whole cure. A fault stays a refusal,
  // so an adapter keeps retrying until its token verifies (P2-A).
  it("an undecided token is refused as a verifier fault even beside a launch id; nothing registers", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    vi.spyOn(console, "error").mockImplementation(() => {})
    harness.addPendingClient("conn-undecided")
    expect(
      parseError(
        await harness.register("conn-undecided", {
          name: "@dev/7",
          pid: 5321,
          project: "/tmp/p",
          launchId: "sid-dev7::%40dev%2F7",
          launchParentPid: 5320,
          idToken: "token-undecided",
        }),
      ),
    ).toMatchObject({ code: -32003, data: { kind: "identity-verifier-fault" } })
    expect(harness.db.prepare("SELECT count(*) AS n FROM sessions WHERE name = '@dev/7'").get()).toEqual({ n: 0 })
  })

  it("a token that verifies to no sid beside a launch id registers on that launch id: hab's jobs and controller", async () => {
    const harness = createDispatcherHarness({
      identityVerifier: { ...identityVerifier, verify: async () => ({ result: "absent" }) as IdentityVerdict },
    })
    cleanup = harness.dispose
    harness.addPendingClient("conn-job")
    const registered = parseResult<RegisterResult & { launchId?: string }>(
      await harness.register("conn-job", {
        name: "state-checkout-sync",
        pid: 5351,
        project: "/tmp/p",
        launchId: "job-launch-7",
        launchParentPid: 5350,
        idToken: "hab-job-token",
      }),
    )
    expect(registered.launchId).toBe("job-launch-7")
    expect(sessionRow(harness, registered.sessionId)).toMatchObject({ launch_id: "job-launch-7", identity_sid: null })
  })

  it("(c) a contradicted token is refused whatever launch id it carries", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-dead")
    expect(
      parseError(
        await harness.register("conn-dead", {
          name: "@dev/7",
          pid: 5331,
          project: "/tmp/p",
          launchId: "sid-dev7::%40dev%2F7",
          launchParentPid: 5330,
          idToken: "token-dead",
        }),
      ),
    ).toMatchObject({ code: -32003, data: { kind: "identity-contradicted" } })
  })

  it("(d) an undecided token with no launch id is still refused as a verifier fault", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    vi.spyOn(console, "error").mockImplementation(() => {})
    harness.addPendingClient("conn-nolaunch")
    expect(
      parseError(
        await harness.register("conn-nolaunch", {
          name: "@dev/7",
          pid: 5341,
          project: "/tmp/p",
          launchParentPid: 5340,
          idToken: "token-hab-job",
        }),
      ),
    ).toMatchObject({ code: -32003, data: { kind: "identity-verifier-fault" } })
  })

  it("a higher generation of the same seat is the successor takeover, and the holder is told", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    const holderSocket = harness.addPendingClient("conn-g3")
    parseResult<RegisterResult>(
      await harness.register("conn-g3", {
        name: "@dev/7",
        pid: 5401,
        project: "/tmp/p",
        takeover: true,
        launchParentPid: 5400,
        idToken: "token-g3",
      }),
    )
    harness.addPendingClient("conn-g4")
    const successor = parseResult<RegisterResult>(
      await harness.register("conn-g4", {
        name: "@dev/7",
        pid: 5411,
        project: "/tmp/p",
        takeover: true,
        launchParentPid: 5410,
        idToken: "token-g4",
      }),
    )

    expect(holderSocket.destroyedByDispatcher).toBe(true)
    expect(harness.supersededEvents("@dev/7")).toEqual([expect.objectContaining({ old_pid: 5401, new_pid: 5411 })])
    expect(sessionRow(harness, successor.sessionId)).toMatchObject({ launch_id: "sid-dev7@4" })
  })

  it("a lower generation of the same seat is refused as stale by name, and the holder is untouched", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    const holderSocket = harness.addPendingClient("conn-g3")
    parseResult<RegisterResult>(
      await harness.register("conn-g3", {
        name: "@dev/7",
        pid: 5501,
        project: "/tmp/p",
        takeover: true,
        launchParentPid: 5500,
        idToken: "token-g3",
      }),
    )
    harness.addPendingClient("conn-g2")
    expect(
      parseError(
        await harness.register("conn-g2", {
          name: "@dev/7",
          pid: 5491,
          project: "/tmp/p",
          takeover: true,
          launchParentPid: 5490,
          idToken: "token-g2",
        }),
      ),
    ).toMatchObject({
      code: -32003,
      message: expect.stringContaining("generation 2 is older than the live holder's generation 3"),
      data: { kind: "foreign-identity-transport", reason: "identity-generation-stale" },
    })
    expect(holderSocket.destroyedByDispatcher).toBe(false)
    expect(harness.supersededEvents("@dev/7")).toEqual([])
  })

  // 25074 3c-2b (@cto def441bf): a bootstrap with a syntactically readable token that the verifier could not read
  // registered on its claimed name under its launch
  // id, which is the Hab session id, `<sid>::<persona>`. The same seat's token-only adapter (keyed `<sid>@<gen>`) promotes that
  // session in place: the token's sid IS that launch's provider part and both carry the launcher pid.
  const fallbackBootstrap = async (
    harness: ReturnType<typeof createDispatcherHarness>,
    launchId: string,
    launchParentPid: number,
  ) => {
    const socket = harness.addPendingClient("conn-bootstrap")
    const registered = parseResult<RegisterResult>(
      await harness.register("conn-bootstrap", {
        name: "@dev/7",
        pid: launchParentPid,
        project: "/tmp/p",
        takeover: true,
        launchId,
        launchParentPid,
        idToken: TOKEN_WITH_UNREADABLE_SIGNATURE,
      }),
    )
    return { socket, registered }
  }
  const promotions = (harness: ReturnType<typeof createDispatcherHarness>) =>
    (
      harness.db
        .prepare("SELECT content FROM messages WHERE type = 'event.session.identity-promoted' ORDER BY ts ASC")
        .all() as Array<{ content: string }>
    ).map((row) => JSON.parse(row.content) as Record<string, unknown>)

  it("a token-only adapter promotes its own fallback bootstrap's session in place, and says so", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    const bootstrap = await fallbackBootstrap(harness, "sid-dev7::%40dev%2F7", 5600)
    harness.addPendingClient("conn-adapter")
    const adapter = parseResult<RegisterResult>(
      await harness.register("conn-adapter", {
        name: "@dev/7",
        pid: 5602,
        project: "/tmp/p",
        takeover: true,
        launchParentPid: 5600,
        idToken: "token-g3",
      }),
    )

    expect(adapter.sessionId).toBe(bootstrap.registered.sessionId)
    expect(bootstrap.socket.destroyedByDispatcher).toBe(false)
    expect(harness.supersededEvents("@dev/7")).toEqual([])
    expect(sessionRow(harness, adapter.sessionId)).toMatchObject({
      launch_id: "sid-dev7@3",
      launch_parent_pid: 5600,
      identity_sid: "sid-dev7",
    })
    expect(promotions(harness)).toEqual([
      expect.objectContaining({
        name: "@dev/7",
        sid: "sid-dev7",
        gen: 3,
        parent_pid: 5600,
        from_launch_id: "sid-dev7::%40dev%2F7",
        transport_class: "bootstrap-fallback-promoted",
      }),
    ])
  })

  // 25074 08:06 PDT outage: a daemon restarted WITHOUT the verifier inherits authority rows a verifier daemon keyed
  // `<sid>@<gen>`. The seat's tokenless re-register presents `<sid>::<persona>`; it must read as the same provider
  // launch and reuse its row, or a flag-off restart refuses the whole fleet as foreign identities.
  it("a flag-off daemon re-registers a seat whose authority row a verifier daemon keyed sid@gen", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    const previous = await fallbackBootstrap(harness, "sid-dev7::%40dev%2F7", 5670)
    harness.db
      .prepare("UPDATE sessions SET launch_id = ? WHERE id = ?")
      .run("sid-dev7@3", previous.registered.sessionId)
    harness.dropClient("conn-bootstrap")

    const again = await fallbackBootstrap(harness, "sid-dev7::%40dev%2F7", 5670)
    expect(again.registered.sessionId).toBe(previous.registered.sessionId)
  })

  it("(e) an adapter sending its token AND its projected launch id still promotes its own fallback bootstrap", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    const bootstrap = await fallbackBootstrap(harness, "sid-dev7::%40dev%2F7", 5660)
    harness.addPendingClient("conn-adapter")
    const adapter = parseResult<RegisterResult>(
      await harness.register("conn-adapter", {
        name: "@dev/7",
        pid: 5662,
        project: "/tmp/p",
        takeover: true,
        launchId: "sid-dev7::%40dev%2F7",
        launchParentPid: 5660,
        idToken: "token-g3",
      }),
    )

    expect(adapter.sessionId).toBe(bootstrap.registered.sessionId)
    expect(harness.supersededEvents("@dev/7")).toEqual([])
    expect(sessionRow(harness, adapter.sessionId)).toMatchObject({ launch_id: "sid-dev7@3", identity_sid: "sid-dev7" })
    expect(promotions(harness)).toEqual([expect.objectContaining({ transport_class: "bootstrap-fallback-promoted" })])
  })

  it("a same-sid holder under another launcher pid is a previous generation: displaced and told, not promoted", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    const previous = await fallbackBootstrap(harness, "sid-dev7::%40dev%2F7", 5700)
    harness.addPendingClient("conn-adapter")
    const adapter = parseResult<RegisterResult>(
      await harness.register("conn-adapter", {
        name: "@dev/7",
        pid: 5712,
        project: "/tmp/p",
        takeover: true,
        launchParentPid: 5710,
        idToken: "token-g3",
      }),
    )

    expect(adapter.sessionId).not.toBe(previous.registered.sessionId)
    expect(previous.socket.destroyedByDispatcher).toBe(true)
    expect(harness.supersededEvents("@dev/7")).toEqual([expect.objectContaining({ old_pid: 5700, new_pid: 5712 })])
    expect(promotions(harness)).toEqual([])
  })

  it("a token-only adapter whose sid is not the fallback holder's launch takes over as before", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    const other = await fallbackBootstrap(harness, "sid-other::%40dev%2F7", 5800)
    harness.addPendingClient("conn-adapter")
    parseResult<RegisterResult>(
      await harness.register("conn-adapter", {
        name: "@dev/7",
        pid: 5802,
        project: "/tmp/p",
        takeover: true,
        launchParentPid: 5800,
        idToken: "token-g3",
      }),
    )

    expect(other.socket.destroyedByDispatcher).toBe(true)
    expect(harness.supersededEvents("@dev/7")).toHaveLength(1)
    expect(promotions(harness)).toEqual([])
  })

  // 25074 P3 (review-adhoc5 8fdd03db, Arm F3): a verified holder is judged by 3c-2a's fence, never promoted
  // in place like a fallback bootstrap.
  it("a verified holder at gen N, then a register at gen N or lower under the same launcher, is refused, not promoted", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    const holderSocket = harness.addPendingClient("conn-holder")
    parseResult<RegisterResult>(
      await harness.register("conn-holder", {
        name: "@dev/7",
        pid: 5901,
        project: "/tmp/p",
        takeover: true,
        launchParentPid: 5900,
        idToken: "token-g3",
      }),
    )
    harness.addPendingClient("conn-lower")
    const refused = parseError(
      await harness.register("conn-lower", {
        name: "@dev/7",
        pid: 5902,
        project: "/tmp/p",
        takeover: true,
        launchParentPid: 5900,
        idToken: "token-g2",
      }),
    )
    expect(refused).toMatchObject({
      code: -32003,
      data: { kind: "foreign-identity-transport", reason: "identity-generation-stale" },
    })
    expect(holderSocket.destroyedByDispatcher).toBe(false)
    expect(promotions(harness)).toEqual([])

    // Arm F3 witness: a verified holder under its launch id is never promoted by a token register
    // from the same launcher PID, even when its provider launch matches the token sid.
    const legacyHolderSocket = harness.addPendingClient("conn-legacy-holder")
    const legacy = parseResult<RegisterResult>(
      await harness.register("conn-legacy-holder", {
        name: "@dev/7",
        pid: 5911,
        project: "/tmp/p",
        takeover: true,
        launchId: "sid-dev7::%40dev%2F7",
        launchParentPid: 5910,
        idToken: "token-nogen",
      }),
    )
    harness.addPendingClient("conn-legacy-token")
    const tokenClient = parseResult<RegisterResult>(
      await harness.register("conn-legacy-token", {
        name: "@dev/7",
        pid: 5912,
        project: "/tmp/p",
        takeover: true,
        launchParentPid: 5910,
        idToken: "token-g3",
      }),
    )
    expect(tokenClient.sessionId).not.toBe(legacy.sessionId)
    expect(legacyHolderSocket.destroyedByDispatcher).toBe(true)
    expect(promotions(harness)).toEqual([])
  })

  it("health's identity facet says whether the loaded verifier supplies gen", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    const result = parseResult<{ content: Array<{ text: string }> }>(await harness.request("tribe.health", {}))
    const health = JSON.parse(result.content[0]!.text) as { identity: { verifier: string; supplies_gen: boolean } }
    expect(health.identity).toMatchObject({ verifier: "/stub/identity-verifier.ts", supplies_gen: true })
  })
})

// 25074 3b — a one-shot caller's authority is its launch's identity token. The capability projection and the
// resolution move together, so a verified seat both reads its inbox by token and re-certifies (launch-registration's
// exactLaunchMember accepts the token reason).
describe("one-shot session authority by identity token (25074 3b)", () => {
  const identityVerifier = {
    path: "/stub/identity-verifier.ts",
    suppliesGen: false,
    verify: async (token: string): Promise<IdentityVerdict> => {
      if (token === "token-dev7") return { result: "verified", actor: "@dev/7", sid: "sid-dev7", gen: 1 }
      if (token === "token-dev8") return { result: "verified", actor: "@dev/8", sid: "sid-dev8", gen: 1 }
      if (token === "token-dead") return { result: "contradicted", reason: "instance-is-live: not live" }
      if (token === "token-undecided") {
        throw new Error("the liveness of @dev/9 sid-dev9@2 is undecided (seat-starting: no transport yet); retry")
      }
      return { result: "unreadable", reason: "malformed token" }
    },
  }
  const selfInbox = (harness: ReturnType<typeof createDispatcherHarness>, credentials: Record<string, unknown>) =>
    harness.request("cli_self_inbox_v1", { ...credentials, limit: 5, peek: true })

  it("a verified seat reads its own inbox and pending by token alone, and members says so", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-seat")
    parseResult<RegisterResult>(
      await harness.register("conn-seat", {
        name: "@dev/7",
        pid: 4601,
        project: "/tmp/p",
        launchParentPid: 4600,
        idToken: "token-dev7",
      }),
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

  it("refuses a verified token no session registered under, and a contradicted token", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-claimed")
    parseResult<RegisterResult>(
      await harness.register("conn-claimed", { name: "dev9-hand", pid: 4701, project: "/tmp/p" }),
    )

    expect(parseError(await selfInbox(harness, { authority: null, idToken: "token-dev8" }))).toMatchObject({
      code: -32003,
      message: expect.stringContaining(
        "@dev/8's token is verified, but no session is registered under its sid sid-dev8",
      ),
      data: { kind: "unauthenticated", reason: "identity-not-registered" },
    })
    expect(parseError(await selfInbox(harness, { authority: null, idToken: "token-dead" }))).toMatchObject({
      code: -32003,
      data: { kind: "unauthenticated", reason: "identity-contradicted" },
    })
  })
})

describe("one-shot session authority P3 rows (25074, @cto 03cff4b5 and 975a22e2, review-adhoc5 4293dae2)", () => {
  const identityVerifier = {
    path: "/stub/identity-verifier.ts",
    suppliesGen: true,
    verify: async (token: string): Promise<IdentityVerdict> => {
      if (token === "token-dead") return { result: "contradicted", reason: "instance-is-live: not live" }
      throw new Error("the liveness of @dev/9 sid-dev9@2 is undecided (seat-starting: no transport yet); retry")
    },
  }
  beforeEach(() => {
    // A verifier fault is logged at error; the refusal it produces is what these rows assert.
    vi.spyOn(console, "error").mockImplementation(() => {})
  })
  const selfInbox = (harness: ReturnType<typeof createDispatcherHarness>, credentials: Record<string, unknown>) =>
    harness.request("cli_self_inbox_v1", { ...credentials, limit: 5, peek: true })

  it("a faulting token refuses as a verifier fault, and a contradicted token refuses", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-4911")
    parseResult<RegisterResult>(
      await harness.register("conn-4911", { name: "dev9-hand", pid: 4911, project: "/tmp/p" }),
    )

    expect(parseError(await selfInbox(harness, { authority: null, idToken: "token-undecided" }))).toMatchObject({
      code: -32003,
      data: { kind: "unauthenticated", reason: "identity-verifier-fault" },
    })
    expect(parseError(await selfInbox(harness, { authority: null, idToken: "token-dead" }))).toMatchObject({
      code: -32003,
      data: { kind: "unauthenticated", reason: "identity-contradicted" },
    })
    expect(parseError(await selfInbox(harness, { authority: "stale-bearer", idToken: "token-dead" }))).toMatchObject({
      code: -32003,
      message: expect.stringContaining("no longer accepted"),
      data: { kind: "unauthenticated", reason: "identity-contradicted", stray_authority: true },
    })
  })
})

// 25074 3d-3 (@cto 657011c8): the launcher-minted bearer is gone. Each row names one refusal a pre-3d-3 daemon did not
// give, because the bearer served the call. The bearer here is a live seat's own: its hash sits on its session row the
// way a pre-cut register left it, so only the deleted bearer path could have served these calls.
describe("one-shot session authority is the identity token alone (25074 3d-3)", () => {
  const identityVerifier = {
    path: "/stub/identity-verifier.ts",
    suppliesGen: true,
    verify: async (token: string): Promise<IdentityVerdict> => {
      if (token === "token-dev7") return { result: "verified", actor: "@dev/7", sid: "sid-dev7", gen: 1 }
      if (token === "token-dev8") return { result: "verified", actor: "@dev/8", sid: "sid-dev8", gen: 1 }
      if (token === "token-garbled") return { result: "unreadable", reason: "malformed token" }
      if (token === TOKEN_WITH_UNREADABLE_SIGNATURE) {
        return { result: "unreadable", reason: "signature key unavailable" }
      }
      throw new Error("the verifier's signing key is unreadable")
    },
  }
  beforeEach(() => {
    // A verifier fault is logged at error; the refusal it produces is what these rows assert.
    vi.spyOn(console, "error").mockImplementation(() => {})
  })
  const bearer = `${"F".repeat(42)}0`
  const selfInbox = (harness: ReturnType<typeof createDispatcherHarness>, credentials: Record<string, unknown>) =>
    harness.request("cli_self_inbox_v1", { ...credentials, limit: 5, peek: true })
  const pendingOwner = async (
    harness: ReturnType<typeof createDispatcherHarness>,
    credentials: Record<string, unknown>,
  ) => {
    const result = parseResult<{ content: Array<{ text: string }> }>(
      await harness.request("cli_session_pending_read_v1", credentials),
    )
    return (JSON.parse(result.content[0]!.text) as { owner: string }).owner
  }
  /** @dev/8, claimed after a readable token got an unreadable verifier verdict, with its pre-cut bearer hash. */
  const preCutBearerSeat = async (harness: ReturnType<typeof createDispatcherHarness>) => {
    harness.addPendingClient("conn-dev8")
    parseResult<RegisterResult>(
      await harness.register("conn-dev8", {
        name: "@dev/8",
        pid: 4801,
        project: "/tmp/p",
        idToken: TOKEN_WITH_UNREADABLE_SIGNATURE,
      }),
    )
    harness.db
      .prepare("UPDATE sessions SET mailbox_authority_hash = ? WHERE name = '@dev/8'")
      .run(createHash("sha256").update(bearer).digest("hex"))
  }
  const strayRefusal = (reason: string) => ({
    code: -32003,
    message: expect.stringMatching(/; the bearer authority it also carried is no longer accepted$/u),
    data: { kind: "unauthenticated", reason, stray_authority: true },
  })

  it("(a) no token and no authority is missing authority, naming the token and the hand-session flags", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    await preCutBearerSeat(harness)

    const refusal = parseError(await selfInbox(harness, { authority: null }))
    expect(refusal).toMatchObject({
      code: -32004,
      data: { kind: "could-not-evaluate", reason: "session-authority-missing" },
    })
    expect(refusal.data).not.toHaveProperty("stray_authority")
    expect(refusal.message).toContain("HAB_ID_TOKEN")
    expect(refusal.message).toContain("--session")
    expect(refusal.message).toContain("--anonymous")
    expect(refusal.message).not.toContain("AG_SESSION_AUTH")
  })

  it("(b) no token beside a live seat's valid bearer is refused, and names the bearer as no longer accepted", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    await preCutBearerSeat(harness)

    const refusal = parseError(await selfInbox(harness, { authority: bearer }))
    expect(refusal).toMatchObject({
      code: -32004,
      data: { kind: "could-not-evaluate", reason: "session-authority-missing", stray_authority: true },
    })
    expect(refusal.message).toContain("no longer accepted")
    expect(parseError(await harness.request("cli_session_pending_read_v1", { authority: bearer }))).toMatchObject({
      code: -32004,
      data: { reason: "session-authority-missing", stray_authority: true },
    })
  })

  it("(c) a verifier fault beside that bearer refuses as a fault to retry, never served by the bearer", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    await preCutBearerSeat(harness)

    const refusal = parseError(await selfInbox(harness, { authority: bearer, idToken: "token-undecided" }))
    expect(refusal).toMatchObject(strayRefusal("identity-verifier-fault"))
    expect(refusal.message).toContain(
      "the identity verifier failed: the verifier's signing key is unreadable; retry; the bearer authority",
    )
    const result = parseResult<{ content: Array<{ text: string }> }>(await harness.request("tribe.health", {}))
    const health = JSON.parse(result.content[0]!.text) as { issues: string[] }
    expect(health.issues).toContainEqual(expect.stringContaining("the verifier's signing key is unreadable"))
  })

  it("(d) a verified token whose sid has no session beside its own seat's bearer is not registered yet", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    await preCutBearerSeat(harness)

    const refusal = parseError(await selfInbox(harness, { authority: bearer, idToken: "token-dev8" }))
    expect(refusal).toMatchObject({
      code: -32003,
      data: { kind: "unauthenticated", reason: "identity-not-registered" },
    })
    expect(refusal.message).toContain("the adapter registers with the token on its next connect")
    // The token verified, so the bearer beside it is ignored, not named: the refusal is the token's alone.
    expect(refusal.data).not.toHaveProperty("stray_authority")
  })

  it("(e) an unreadable token beside that bearer is refused as unreadable, never served by the bearer", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    await preCutBearerSeat(harness)

    expect(parseError(await selfInbox(harness, { authority: bearer, idToken: "token-garbled" }))).toMatchObject(
      strayRefusal("identity-token-unreadable"),
    )
    expect(parseError(await selfInbox(harness, { authority: null, idToken: "token-garbled" }))).toMatchObject({
      code: -32003,
      data: { kind: "unauthenticated", reason: "identity-token-unreadable" },
    })
  })

  it("(f) a registered verified token is served as its own seat; a stray authority beside it is ignored", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    await preCutBearerSeat(harness)
    harness.addPendingClient("conn-dev7")
    parseResult<RegisterResult>(
      await harness.register("conn-dev7", {
        name: "@dev/7",
        pid: 4701,
        project: "/tmp/p",
        idToken: "token-dev7",
        launchParentPid: 4701,
      }),
    )

    expect(await pendingOwner(harness, { authority: bearer, idToken: "token-dev7" })).toBe("@dev/7")
    expect(await pendingOwner(harness, { authority: "not-any-bearer", idToken: "token-dev7" })).toBe("@dev/7")
    parseResult(await selfInbox(harness, { authority: bearer, idToken: "token-dev7" }))
    // Another seat's bearer beside the token is no longer a foreign transport on that seat's session.
    const members = parseResult<{ content: Array<{ text: string }> }>(await harness.request("tribe.members", {}))
    const sessions = (JSON.parse(members.content[0]!.text) as { sessions: Array<Record<string, unknown>> }).sessions
    expect(sessions.find((session) => session.name === "@dev/8")).not.toHaveProperty("foreign_transport")
  })

  it("(g) a register carrying mailboxAuthorityHash, well-formed or not, registers and stores no hash", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-hex")
    harness.addPendingClient("conn-malformed")

    parseResult<RegisterResult>(
      await harness.register("conn-hex", {
        name: "dev5-hand",
        pid: 4501,
        project: "/tmp/p",
        mailboxAuthorityHash: "a".repeat(64),
      }),
    )
    parseResult<RegisterResult>(
      await harness.register("conn-malformed", {
        name: "dev6-hand",
        pid: 4601,
        project: "/tmp/p",
        mailboxAuthorityHash: "zz",
      }),
    )
    expect(
      harness.db
        .prepare(
          "SELECT name, mailbox_authority_hash FROM sessions WHERE name IN ('dev5-hand', 'dev6-hand') ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: "dev5-hand", mailbox_authority_hash: null },
      { name: "dev6-hand", mailbox_authority_hash: null },
    ])
  })

  /** @dev/7 registered on its verified token (sid-dev7), then renamed at runtime to @dev/7b; the sid stays. */
  const renamedVerifiedSeat = async (harness: ReturnType<typeof createDispatcherHarness>) => {
    harness.addPendingClient("conn-dev7")
    parseResult<RegisterResult>(
      await harness.register("conn-dev7", {
        name: "@dev/7",
        pid: 4701,
        project: "/tmp/p",
        idToken: "token-dev7",
        launchParentPid: 4701,
      }),
    )
    harness.db.prepare("UPDATE sessions SET name = '@dev/7b' WHERE name = '@dev/7'").run()
  }

  it("(h) a seat renamed at runtime still reads its own mailbox by its token: the sole session under its sid", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    await renamedVerifiedSeat(harness)

    expect(await pendingOwner(harness, { idToken: "token-dev7" })).toBe("@dev/7b")
    parseResult(await selfInbox(harness, { idToken: "token-dev7" }))
  })

  it("(i) two sessions under one sid, neither the token's actor, is refused by name, never guessed", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    await renamedVerifiedSeat(harness)
    await preCutBearerSeat(harness)
    harness.db.prepare("UPDATE sessions SET identity_sid = 'sid-dev7' WHERE name = '@dev/8'").run()

    const refusal = parseError(await selfInbox(harness, { idToken: "token-dev7" }))
    expect(refusal).toMatchObject({ code: -32003, data: { kind: "unauthenticated", reason: "identity-ambiguous" } })
    expect(refusal.message).toContain("2 sessions are registered under its sid sid-dev7")
    expect(refusal.message).toContain("--session")
  })

  // @cto eabd0565: tribe members documents foreign_transport as the roster's answer to "why is this seat's transport
  // refused" (24767). With the bearer gone, the token path's name mismatch is what records it.
  it("(j) seat B's token registering as seat A is refused naming both, and A's roster row names B", async () => {
    const harness = createDispatcherHarness({ identityVerifier })
    cleanup = harness.dispose
    harness.addPendingClient("conn-dev7")
    parseResult<RegisterResult>(
      await harness.register("conn-dev7", {
        name: "@dev/7",
        pid: 4701,
        project: "/tmp/p",
        idToken: "token-dev7",
        launchParentPid: 4701,
      }),
    )
    harness.dropClient("conn-dev7")

    harness.addPendingClient("conn-foreign")
    expect(
      parseError(
        await harness.register("conn-foreign", { name: "@dev/7", pid: 4801, project: "/tmp/p", idToken: "token-dev8" }),
      ),
    ).toMatchObject({
      code: -32003,
      message: "register refused: this transport claims @dev/7, but its identity token names @dev/8",
      data: { kind: "identity-name-mismatch", claimed: "@dev/7", actor: "@dev/8" },
    })

    // A's transport is gone, so its row is disconnected: `all` shows it.
    const members = parseResult<{ content: Array<{ text: string }> }>(
      await harness.request("tribe.members", { all: true }),
    )
    const sessions = (JSON.parse(members.content[0]!.text) as { sessions: Array<Record<string, unknown>> }).sessions
    expect(sessions.find((session) => session.name === "@dev/7")).toMatchObject({
      transport_reason: "transport-carries-another-seats-identity",
      foreign_transport: { name: "@dev/8", pid: 4801, refused_at: expect.any(String) },
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
    destroyed: false,
    writable: true,
    writes: [] as string[],
    write(payload: string | Uint8Array) {
      this.writes.push(String(payload))
      return true
    },
    destroy() {
      this.destroyedByDispatcher = true
      this.destroyed = true
      this.writable = false
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
