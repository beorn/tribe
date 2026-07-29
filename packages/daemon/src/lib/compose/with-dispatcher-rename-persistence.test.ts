/**
 * Runtime-rename persistence across daemon restart / transport reconnect
 * (@ag/tribe/21454).
 *
 * THREE live specimens 2026-07-17: chief's runtime rename `@chief/next` →
 * `@chief` silently reverted every time the tribe daemon restarted (each
 * vendor/tribe pin landing hot-reloads the daemon) or the adapter transport
 * re-exec'd. The adapter's register params freeze the SPAWN-TIME launch name,
 * so every re-register restores the stale name: ball-close replies no-op,
 * chief-absent:critical fires, and the fleet loses its coordination identity.
 *
 * Contract pinned here: an explicit runtime rename (tribe.rename, or an
 * explicit tribe.join to a different name) WRITES THROUGH to a persisted
 * authority record keyed by launch identity (launch_id, launch_parent_pid).
 * Registration re-applies that record, so the renamed identity survives:
 *   (1) daemon restart + adapter re-exec (new transport pid, same launch),
 *   (2) transport reconnect within one daemon generation (same launch),
 *   (4) explicit-join renames, symmetrically with tribe.rename.
 * Guard (3): re-application never steals a name held by a LIVE session of a
 * DIFFERENT launch — a demoted predecessor reconnecting cannot displace the
 * successor that legitimately holds the name now.
 *
 * Harness is the `with-dispatcher-takeover.test.ts` fake-socket shape, widened
 * with (a) a caller-owned db dir so a second dispatcher can open the SAME
 * sqlite file (daemon restart), and (b) `dropClient()` to model a transport
 * disconnect without a daemon restart.
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

type JsonRpcResponse<T> = {
  result?: T
  error?: { code: number; message: string }
}

type RegisterParams = {
  name?: string
  pid: number
  project: string
  launchId?: string
  launchParentPid?: number
}

const dirs: string[] = []
let cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) await dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function sharedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tribe-rename-persist-"))
  dirs.push(dir)
  return dir
}

describe("runtime rename persists across reconnect/restart (@ag/tribe/21454)", () => {
  it("daemon restart: a re-exec'd adapter registering the stale launch name gets the persisted rename back", async () => {
    const dir = sharedDir()
    const daemon1 = createDispatcherHarness(dir)
    cleanups.push(daemon1.dispose)

    // Launch: seat spawned as @chief/next (launch identity from the spawn env).
    daemon1.addPendingClient("conn-gen1")
    const reg1 = parseResult<RegisterResult>(
      await daemon1.register("conn-gen1", {
        name: "@chief/next",
        pid: 5101,
        project: "/repo/hh",
        launchId: "launch-chief-a",
        launchParentPid: 900,
      }),
    )
    expect(reg1.name).toBe("@chief/next")

    // Runtime rename — the successor handoff's release step.
    const renamed = parseToolJson<{ renamed: boolean; new_name: string }>(await daemon1.rename("conn-gen1", "@chief"))
    expect(renamed).toMatchObject({ renamed: true, new_name: "@chief" })

    // Daemon restarts (pin landing). Old process gone; same sqlite file. The
    // adapter re-execs on generation change, so it comes back with a NEW
    // transport pid but the SAME launch identity and the STALE launch name.
    await daemon1.dispose()
    cleanups = cleanups.filter((d) => d !== daemon1.dispose)
    const daemon2 = createDispatcherHarness(dir)
    cleanups.push(daemon2.dispose)

    daemon2.addPendingClient("conn-gen2")
    const reg2 = parseResult<RegisterResult>(
      await daemon2.register("conn-gen2", {
        name: "@chief/next",
        pid: 6202,
        project: "/repo/hh",
        launchId: "launch-chief-a",
        launchParentPid: 900,
      }),
    )
    // The whole bead: this came back "@chief/next" three times on 2026-07-17.
    expect(reg2.name).toBe("@chief")
  })

  it("transport reconnect: a re-registering adapter in the same daemon generation keeps the rename", async () => {
    const daemon = createDispatcherHarness(sharedDir())
    cleanups.push(daemon.dispose)

    daemon.addPendingClient("conn-t1")
    parseResult<RegisterResult>(
      await daemon.register("conn-t1", {
        name: "@chief/next",
        pid: 5301,
        project: "/repo/hh",
        launchId: "launch-chief-b",
        launchParentPid: 901,
      }),
    )
    parseToolJson<{ renamed: boolean }>(await daemon.rename("conn-t1", "@chief"))

    // Socket drops (daemon alive); the adapter re-execs and reconnects with a
    // new transport pid — pid/cwd adoption cannot see it, only the launch
    // identity can.
    daemon.dropClient("conn-t1")
    daemon.addPendingClient("conn-t2")
    const reg2 = parseResult<RegisterResult>(
      await daemon.register("conn-t2", {
        name: "@chief/next",
        pid: 5302,
        project: "/repo/hh",
        launchId: "launch-chief-b",
        launchParentPid: 901,
      }),
    )
    expect(reg2.name).toBe("@chief")
  })

  it("guard: re-application never steals a name held by a LIVE session of a different launch", async () => {
    // Pin the level: the parent shell's LOG_LEVEL must not decide whether this
    // behavior assertion sees the warning.
    const previousLogLevel = getLogLevel()
    setLogLevel("warn")
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const daemon = createDispatcherHarness(sharedDir())
      cleanups.push(daemon.dispose)

      // Launch A becomes @chief, then goes away (predecessor).
      daemon.addPendingClient("conn-a")
      parseResult<RegisterResult>(
        await daemon.register("conn-a", {
          name: "@chief/next",
          pid: 5401,
          project: "/repo/hh",
          launchId: "launch-old-chief",
          launchParentPid: 902,
        }),
      )
      parseToolJson<{ renamed: boolean }>(await daemon.rename("conn-a", "@chief"))
      daemon.dropClient("conn-a")

      // Launch B (the successor) legitimately claims @chief and stays LIVE.
      daemon.addPendingClient("conn-b")
      parseResult<RegisterResult>(
        await daemon.register("conn-b", {
          name: "@relief",
          pid: 5402,
          project: "/repo/hh",
          launchId: "launch-new-chief",
          launchParentPid: 903,
        }),
      )
      const bRename = parseToolJson<{ renamed: boolean; new_name: string }>(await daemon.rename("conn-b", "@chief"))
      expect(bRename).toMatchObject({ renamed: true, new_name: "@chief" })

      // Launch A's zombie adapter reconnects. Its persisted rename says @chief,
      // but a live DIFFERENT launch holds it — A must NOT displace B.
      daemon.addPendingClient("conn-a2")
      const regA2 = parseResult<RegisterResult>(
        await daemon.register("conn-a2", {
          name: "@chief/next",
          pid: 5403,
          project: "/repo/hh",
          launchId: "launch-old-chief",
          launchParentPid: 902,
        }),
      )
      expect(regA2.name).toBe("@chief/next")
      // And the successor is untouched.
      const bRow = daemon.db.prepare("SELECT name FROM sessions WHERE launch_id = 'launch-new-chief'").get() as {
        name: string
      } | null
      expect(bRow?.name).toBe("@chief")
      // The refusal is LOUD — the guard names the launch and the kept name.
      expect(warnSpy.mock.calls.map((call) => call.join(" ")).join("\n")).toContain(
        'persisted rename "@chief" for launch launch-old-chief is held by a live different-launch session',
      )
    } finally {
      warnSpy.mockRestore()
      setLogLevel(previousLogLevel)
    }
  })

  it("explicit tribe.join writes through like tribe.rename; no launch identity means no persistence", async () => {
    const dir = sharedDir()
    const daemon1 = createDispatcherHarness(dir)
    cleanups.push(daemon1.dispose)

    // Join-based rename (the /up hat-claim shape) with a launch identity.
    daemon1.addPendingClient("conn-j1")
    parseResult<RegisterResult>(
      await daemon1.register("conn-j1", {
        name: "@agent/5",
        pid: 5501,
        project: "/repo/hh",
        launchId: "launch-worker-5",
        launchParentPid: 904,
      }),
    )
    parseToolJson<{ name: string }>(await daemon1.join("conn-j1", "@agent/7"))

    // A launch-less session renames — nothing must persist for it.
    daemon1.addPendingClient("conn-legacy")
    parseResult<RegisterResult>(
      await daemon1.register("conn-legacy", { name: "roving-cli", pid: 5502, project: "/repo/hh" }),
    )
    parseToolJson<{ renamed: boolean }>(await daemon1.rename("conn-legacy", "roving-cli-2"))
    const persisted = daemon1.db
      .prepare("SELECT launch_id, name FROM launch_renames ORDER BY launch_id")
      .all() as Array<{
      launch_id: string
      name: string
    }>
    expect(persisted).toEqual([{ launch_id: "launch-worker-5", name: "@agent/7" }])

    // Restart: the stale-name re-register gets the joined name back.
    await daemon1.dispose()
    cleanups = cleanups.filter((d) => d !== daemon1.dispose)
    const daemon2 = createDispatcherHarness(dir)
    cleanups.push(daemon2.dispose)

    daemon2.addPendingClient("conn-j2")
    const reg2 = parseResult<RegisterResult>(
      await daemon2.register("conn-j2", {
        name: "@agent/5",
        pid: 5503,
        project: "/repo/hh",
        launchId: "launch-worker-5",
        launchParentPid: 904,
      }),
    )
    expect(reg2.name).toBe("@agent/7")
  })

  it("join refuses a still-connected name holder even when its heartbeat is stale", async () => {
    const daemon = createDispatcherHarness(sharedDir())
    cleanups.push(daemon.dispose)

    const holderSocket = daemon.addPendingClient("conn-holder")
    const holder = parseResult<RegisterResult>(
      await daemon.register("conn-holder", {
        name: "@ci",
        pid: 5601,
        project: "/repo/hh",
        launchId: "launch-ci-holder",
        launchParentPid: 905,
      }),
    )
    daemon.db
      .prepare("UPDATE sessions SET updated_at = $updated_at WHERE id = $id")
      .run({ $updated_at: Date.now() - 60 * 60_000, $id: holder.sessionId })

    daemon.addPendingClient("conn-claimant")
    parseResult<RegisterResult>(
      await daemon.register("conn-claimant", {
        name: "@temp-ci",
        pid: 5602,
        project: "/repo/hh",
        launchId: "launch-ci-claimant",
        launchParentPid: 906,
      }),
    )
    const joined = parseToolJson<{ error?: string; name?: string }>(await daemon.join("conn-claimant", "@ci"))

    expect(joined.error).toContain('Name "@ci" is already taken')
    expect(joined.name).toBeUndefined()
    expect(holderSocket.destroyedByDispatcher).toBe(false)
    expect(daemon.db.prepare("SELECT name FROM sessions WHERE id = $id").get({ $id: holder.sessionId })).toEqual({
      name: "@ci",
    })
    expect(daemon.db.prepare("SELECT name FROM sessions WHERE name LIKE '@ci-dead-%' ORDER BY name").all()).toEqual([])
  })

  it("join and rename refuse a name holder while only a same-session watch transport remains connected", async () => {
    const daemon = createDispatcherHarness(sharedDir())
    cleanups.push(daemon.dispose)

    daemon.addPendingClient("conn-holder-member")
    const holder = parseResult<RegisterResult>(
      await daemon.register("conn-holder-member", {
        name: "@ci",
        pid: 5651,
        project: "/repo/hh",
        launchId: "launch-ci-watch-holder",
        launchParentPid: 905,
      }),
    )
    daemon.addWatchTransport("conn-holder-watch", holder.sessionId)
    daemon.dropClient("conn-holder-member")

    daemon.addPendingClient("conn-claimant")
    parseResult<RegisterResult>(
      await daemon.register("conn-claimant", {
        name: "@temp-ci",
        pid: 5652,
        project: "/repo/hh",
        launchId: "launch-ci-watch-claimant",
        launchParentPid: 906,
      }),
    )
    const joined = parseToolJson<{ error?: string; name?: string }>(await daemon.join("conn-claimant", "@ci"))
    const renamed = parseToolJson<{ error?: string; renamed?: boolean }>(await daemon.rename("conn-claimant", "@ci"))

    expect(joined.error).toContain('Name "@ci" is already taken')
    expect(joined.name).toBeUndefined()
    expect(renamed.error).toContain('Name "@ci" is already taken')
    expect(renamed.renamed).toBeUndefined()
    expect(daemon.db.prepare("SELECT name FROM sessions WHERE id = $id").get({ $id: holder.sessionId })).toEqual({
      name: "@ci",
    })
    expect(daemon.db.prepare("SELECT name FROM sessions WHERE name LIKE '@ci-dead-%' ORDER BY name").all()).toEqual([])
  })

  it("rename-to-context-name repairs a tombstoned DB identity instead of falsely returning no-op", async () => {
    const daemon = createDispatcherHarness(sharedDir())
    cleanups.push(daemon.dispose)

    daemon.addPendingClient("conn-corrupt")
    const registered = parseResult<RegisterResult>(
      await daemon.register("conn-corrupt", {
        name: "@ci",
        pid: 5701,
        project: "/repo/hh",
        launchId: "launch-ci-corrupt",
        launchParentPid: 907,
      }),
    )
    daemon.db
      .prepare("UPDATE sessions SET name = $name WHERE id = $id")
      .run({ $name: "@ci-dead-corrupt", $id: registered.sessionId })

    const renamed = parseToolJson<{
      renamed: boolean
      old_name?: string
      new_name?: string
      name?: string
    }>(await daemon.rename("conn-corrupt", "@ci"))

    expect(renamed).toEqual({
      renamed: true,
      old_name: "@ci-dead-corrupt",
      new_name: "@ci",
    })
    expect(daemon.db.prepare("SELECT name FROM sessions WHERE id = $id").get({ $id: registered.sessionId })).toEqual({
      name: "@ci",
    })
  })
})

// ---------------------------------------------------------------------------
// Harness (with-dispatcher-takeover.test.ts shape; caller-owned db dir)
// ---------------------------------------------------------------------------

function createDispatcherHarness(dir: string) {
  const scope = createScope("dispatcher-rename-persist-test")
  const db = openDatabase(join(dir, "tribe.sqlite"))
  const stmts = createStatements(db)
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
      socketPath: join(dir, "tribe.sock"),
      dbPath: join(dir, "tribe.sqlite"),
      recallDbPath: join(dir, "recall.sqlite"),
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
        return new Set(
          Array.from(clients.values())
            .filter((client) => client.role === "member")
            .map((client) => client.ctx.sessionId),
        )
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
        return Array.from(clients.values()).map((c) => ({
          id: c.ctx.sessionId,
          name: c.name,
          pid: c.pid,
          cwd: c.project,
          role: c.role,
          claudeSessionId: c.claudeSessionId,
          registeredAt: c.registeredAt,
          launchId: c.launchId,
          launchParentPid: c.launchParentPid,
          transportPids: c.pid > 0 ? [c.pid] : [],
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
      socketPath: join(dir, "tribe.sock"),
      binding: Promise.resolve("listening" as const),
      inheritedFd: false,
      startedAt: Date.now(),
      handedOff: false,
    },
  }
  const daemon = withDispatcher({ suppressWindowMs: Number.MAX_SAFE_INTEGER })(shape)

  return {
    register(connId: string, params: RegisterParams) {
      const req: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: `register-${connId}`,
        method: "register",
        params: {
          ...params,
          role: "member",
          projectName: "hh",
          projectId: "test-project",
          delivery: "pull",
          protocolVersion: TRIBE_PROTOCOL_VERSION,
        },
      }
      return daemon.dispatcher.handleRequest(req, connId)
    },
    rename(connId: string, newName: string) {
      const req: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: `rename-${connId}-${newName}`,
        method: "tribe.rename",
        params: { new_name: newName },
      }
      return daemon.dispatcher.handleRequest(req, connId)
    },
    join(connId: string, name: string) {
      const req: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: `join-${connId}-${name}`,
        method: "tribe.join",
        params: { name },
      }
      return daemon.dispatcher.handleRequest(req, connId)
    },
    /** Model a transport disconnect: the registry forgets the connection. */
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
        project: "/repo/hh",
        projectName: "hh",
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

/** Tool results wrap JSON in MCP content blocks — unwrap one level. */
function parseToolJson<T>(line: string): T {
  const result = parseResult<{ content: Array<{ text: string }> }>(line)
  return JSON.parse(result.content?.[0]?.text ?? "{}") as T
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
