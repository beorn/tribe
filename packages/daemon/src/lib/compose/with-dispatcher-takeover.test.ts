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
}

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (!cleanup) return
  const dispose = cleanup
  cleanup = null
  await dispose()
})

describe("dispatcher explicit-persona takeover (@ag/tribe/20703)", () => {
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
    // The takeover branch logs a loud recovery line via log.warn (routes to
    // console.warn through loggily) — some runners (e.g. the hh vendor-project
    // vitest setup) fail any test that produces console output, so the spy
    // both captures the line for assertion and suppresses it from stdout.
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
      getActiveSessionInfo() {
        return Array.from(clients.values()).map((c) => ({
          id: c.ctx.sessionId,
          name: c.name,
          pid: c.pid,
          role: c.role,
          claudeSessionId: c.claudeSessionId,
          registeredAt: c.registeredAt,
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
    /** Direct journal-row read — `event.session.superseded` rows written by logEvent(). */
    supersededEvents(name: string): Array<{ name: string; old_pid: number; new_pid: number; reason: string }> {
      const rows = db
        .prepare("SELECT content FROM messages WHERE type = 'event.session.superseded' ORDER BY ts ASC")
        .all() as Array<{ content: string }>
      return rows
        .map((r) => JSON.parse(r.content) as { name: string; old_pid: number; new_pid: number; reason: string })
        .filter((e) => e.name === name)
    },
    addPendingClient(connId: string): TestSocket {
      const socket = createTestSocket()
      clients.set(connId, {
        socket,
        id: connId,
        name: `pending-${connId}`,
        role: "pending",
        domains: [],
        project: "/tmp/km-wt9",
        projectName: "km-wt9",
        projectId: "test-project",
        pid: 0,
        claudeSessionId: null,
        peerSocket: null,
        conn: "test",
        ctx: daemonCtx,
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
