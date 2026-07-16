import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Server, Socket as NetSocket } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createScope } from "tribe-wire"
import { TRIBE_PROTOCOL_VERSION, type JsonRpcRequest } from "tribe-wire/lib/socket"
import type { TribeRole } from "tribe-wire/lib/config"
import { createTribeContext } from "../context.ts"
import { openDatabase, createStatements } from "../database.ts"
import { sendMessage } from "../messaging.ts"
import type { ClientSession } from "./with-client-registry.ts"
import { withDispatcher } from "./with-dispatcher.ts"

type TestSocket = NetSocket & {
  destroyedByDispatcher: boolean
  emitClose(): void
  writes: string[]
}

type RegisterResult = {
  sessionId: string
  name: string
  role: TribeRole
}

type CliStatusResult = {
  sessions: Array<{
    id: string
    name: string
    pid: number
    role: TribeRole
    transportPids: number[]
  }>
}

type InboxDrainResult = {
  session: string
  unread_count: number
  drained_count: number
  events: Array<{ content: string }>
}

type InboxStatusResult = {
  session: string
  unread_count: number
}

type InboxWaitResult = {
  session: string
  unread_count: number
  waited_ms: number
  timed_out: boolean
  aborted: boolean
}

type JsonRpcResponse<T> = {
  result?: T
  error?: {
    code: number
    message: string
  }
}

const liveHolderPid = process.pid
const otherLivePid = process.pid + 1

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (!cleanup) return
  const dispose = cleanup
  cleanup = null
  await dispose()
})

describe("dispatcher self-registration collision handling (@ag/tribe/19594)", () => {
  it("lets the same live PID re-register an explicit agent name", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const firstSocket = harness.addPendingClient("conn-first")
    const first = parseResult<RegisterResult>(
      await harness.register("conn-first", {
        name: "@agent/9",
        pid: liveHolderPid,
        project: "/tmp/km-wt9",
      }),
    )

    const secondSocket = harness.addPendingClient("conn-second")
    const second = parseResult<RegisterResult>(
      await harness.register("conn-second", {
        name: "@agent/9",
        pid: liveHolderPid,
        project: "/tmp/km-wt9",
      }),
    )

    expect(second.name).toBe("@agent/9")
    expect(second.sessionId).toBe(first.sessionId)
    expect(firstSocket.destroyedByDispatcher).toBe(true)
    expect(secondSocket.destroyedByDispatcher).toBe(false)

    const status = parseResult<CliStatusResult>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "status",
          method: "cli_status",
          params: {},
        },
        "conn-second",
      ),
    )
    const agentSessions = status.sessions.filter((s) => s.name === "@agent/9")
    expect(agentSessions).toHaveLength(1)
    expect(agentSessions[0]?.pid).toBe(liveHolderPid)
  })

  it("still rejects an explicit duplicate name from a different live PID", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    harness.addPendingClient("conn-holder")
    const holder = parseResult<RegisterResult>(
      await harness.register("conn-holder", {
        name: "@agent/9",
        pid: liveHolderPid,
        project: "/tmp/km-wt9",
      }),
    )
    expect(holder.name).toBe("@agent/9")

    harness.addPendingClient("conn-contender")
    const duplicate = parseError(
      await harness.register("conn-contender", {
        name: "@agent/9",
        pid: otherLivePid,
        project: "/tmp/km-wt9",
      }),
    )

    expect(duplicate.message).toBe(`Name "@agent/9" is already taken by live pid ${liveHolderPid}`)
  })

  it("projects launch fan-in as one canonical session and omits pending probes", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    harness.addPendingClient("conn-agent")
    const registered = parseResult<RegisterResult>(
      await harness.register("conn-agent", {
        name: "@agent/5",
        pid: liveHolderPid,
        project: "/tmp/km-wt5",
      }),
    )
    harness.addTransport("conn-mcp", "conn-agent", liveHolderPid + 2)
    harness.addPendingClient("conn-status-probe")

    const status = parseResult<CliStatusResult>(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "status", method: "cli_status", params: {} },
        "conn-status-probe",
      ),
    )

    expect(status.sessions).toHaveLength(1)
    expect(status.sessions[0]).toMatchObject({
      id: registered.sessionId,
      name: "@agent/5",
      pid: liveHolderPid,
      transportPids: [liveHolderPid, liveHolderPid + 2],
    })
    expect(status.sessions.some((session) => session.name.startsWith("pending-"))).toBe(false)
  })
})

describe("dispatcher bounded mailbox drain", () => {
  it("binds acknowledgement to the managed launch's authenticated current session", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const launch = { launchId: "launch-agent-3", launchParentPid: 4242 }
    const holderSocket = harness.addPendingClient("conn-holder")
    const holder = parseResult<RegisterResult>(
      await harness.register("conn-holder", {
        name: "@agent/3",
        pid: liveHolderPid,
        project: "/tmp/km-wt3",
        ...launch,
      }),
    )
    harness.addPendingClient("conn-drain")
    const drainTransport = parseResult<RegisterResult>(
      await harness.register("conn-drain", {
        name: "@agent/3",
        pid: otherLivePid,
        project: "/tmp/km-wt3",
        ...launch,
      }),
    )
    expect(drainTransport.sessionId).toBe(holder.sessionId)
    expect(holderSocket.destroyedByDispatcher).toBe(false)
    expect(harness.sessionCount("@agent/3")).toBe(1)

    harness.sendActionable("@chief", "chief-only request")
    harness.sendActionable("@agent/3", "agent request")

    const crossRole = parseError(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "cross-role-drain",
          method: "cli_inbox_drain",
          params: { session: "@chief", limit: 1 },
        },
        "conn-drain",
      ),
    )
    expect(crossRole).toMatchObject({ code: -32602 })
    expect(crossRole.message).toMatch(/session override is forbidden/)

    const first = parseResult<InboxDrainResult>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "drain-1",
          method: "cli_inbox_drain",
          params: { limit: 1 },
        },
        "conn-drain",
      ),
    )
    expect(first).toMatchObject({ session: "@agent/3", drained_count: 1, unread_count: 0 })
    expect(first.events.map((event) => event.content)).toEqual(["agent request"])

    const chiefStatus = parseResult<InboxStatusResult>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "chief-status",
          method: "cli_inbox_status",
          params: { session: "@chief" },
        },
        "conn-drain",
      ),
    )
    expect(chiefStatus).toMatchObject({ session: "@chief", unread_count: 1 })
  })

  it("rejects unregistered and non-member callers", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    harness.addPendingClient("conn-pending")
    expect(
      parseError(
        await harness.dispatcher.handleRequest(
          { jsonrpc: "2.0", id: "pending-drain", method: "cli_inbox_drain", params: {} },
          "conn-pending",
        ),
      ),
    ).toMatchObject({ code: -32001 })

    harness.addPendingClient("conn-watch")
    await harness.register("conn-watch", {
      name: "watcher",
      role: "watch",
      pid: liveHolderPid,
      project: "/tmp/km-watch",
    })
    expect(
      parseError(
        await harness.dispatcher.handleRequest(
          { jsonrpc: "2.0", id: "watch-drain", method: "cli_inbox_drain", params: {} },
          "conn-watch",
        ),
      ),
    ).toMatchObject({ code: -32001 })
  })

  it("validates the bound before mutation and preserves fetch trust and attention eligibility", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    harness.addPendingClient("conn-drain")
    await harness.register("conn-drain", {
      name: "@agent/3",
      pid: liveHolderPid,
      project: "/tmp/km-wt3",
    })
    harness.sendActionable("@agent/3", "forged daemon request", {
      sender: "unregistered-sender",
      topic: "daemon:forged",
    })
    harness.sendActionable("@agent/3", "non-actionable notice", { type: "notify" })
    harness.sendActionable("@agent/3", "trusted actionable request", {
      sender: "daemon",
      topic: "daemon:request",
    })

    for (const limit of [0, -1, 101, 1.5, "1"] as unknown[]) {
      const invalid = parseError(
        await harness.dispatcher.handleRequest(
          {
            jsonrpc: "2.0",
            id: `invalid-${String(limit)}`,
            method: "cli_inbox_drain",
            params: { limit },
          },
          "conn-drain",
        ),
      )
      expect(invalid).toMatchObject({ code: -32602 })
    }

    const valid = parseResult<InboxDrainResult>(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "valid-drain", method: "cli_inbox_drain", params: { limit: 1 } },
        "conn-drain",
      ),
    )
    expect(valid).toMatchObject({ session: "@agent/3", drained_count: 1, unread_count: 0 })
    expect(valid.events.map((event) => event.content)).toEqual(["trusted actionable request"])

    const empty = parseResult<InboxDrainResult>(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "empty-drain", method: "cli_inbox_drain", params: { limit: 1 } },
        "conn-drain",
      ),
    )
    expect(empty).toMatchObject({ drained_count: 0, unread_count: 0, events: [] })
  })
})

describe("dispatcher session announcement recovery (@ag/tribe/21052/19442)", () => {
  it("coalesces a reconnecting name without losing durable join events", async () => {
    const suppressWindowMs = 10_000
    let now = 100_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const harness = createDispatcherHarness({
        suppressWindowMs,
        socketStartedAt: now - suppressWindowMs - 1,
      })
      cleanup = harness.dispose

      // The daemon-start window has elapsed, so this exercises live adapter
      // churn rather than startup suppression. Every suppressed attempt must
      // re-arm the per-name window, while another name remains independent.
      const first = harness.connectClient()
      await registerMember(harness, first.connId, "@agent/6")
      now += 5_000
      first.socket.emitClose()

      now += 5_000
      const second = harness.connectClient()
      await registerMember(harness, second.connId, "@agent/6")
      now += 5_000
      second.socket.emitClose()

      // The boundary itself is outside the window; callers must not need an
      // undocumented extra millisecond before the next stable announcement.
      now += 10_000
      const stable = harness.connectClient()
      await registerMember(harness, stable.connId, "@agent/6")
      const independent = harness.connectClient()
      await registerMember(harness, independent.connId, "@agent/7")

      const announcements = harness.sessionAnnouncements("@agent/6")
      expect(announcements).toHaveLength(2)
      expect(announcements.every((content) => content.includes("@agent/6 joined (member)"))).toBe(true)
      expect(harness.sessionAnnouncements("@agent/7")).toHaveLength(1)
      expect(harness.sessionJoinEvents("@agent/6")).toHaveLength(3)
      expect(harness.sessionJoinEvents("@agent/7")).toHaveLength(1)
      expect(harness.sessionLeftEvents("@agent/6")).toHaveLength(2)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("suppresses both channel transitions during daemon startup without losing durable lifecycle events", async () => {
    const suppressWindowMs = 10_000
    let now = 200_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const harness = createDispatcherHarness({ suppressWindowMs, socketStartedAt: now })
      cleanup = harness.dispose

      const client = harness.connectClient()
      await registerMember(harness, client.connId, "@agent/6")
      // Even if this startup-created connection outlives the startup window,
      // a suppressed join must not later produce an orphan "left" line.
      now += 15_000
      client.socket.emitClose()

      expect(harness.sessionAnnouncements("@agent/6")).toEqual([])
      expect(harness.sessionJoinEvents("@agent/6")).toHaveLength(1)
      expect(harness.sessionLeftEvents("@agent/6")).toHaveLength(1)
    } finally {
      nowSpy.mockRestore()
    }
  })
})

describe("dispatcher inbox-wait parsing", () => {
  it("wakes waits for actionable messages sent through a registered client context", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    harness.addPendingClient("conn-sender")
    await harness.register("conn-sender", {
      name: "@agent/sender",
      pid: liveHolderPid,
      project: "/tmp/km-wt9",
    })

    const wait = harness.dispatcher.handleRequest(
      {
        jsonrpc: "2.0",
        id: "wait",
        method: "tribe.inbox.wait",
        params: { session: "@agent/wait", timeoutMs: 100 },
      },
      "conn-wait",
    )

    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    parseResult(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "send",
          method: "tribe.send",
          params: {
            to: "@agent/wait",
            message: "wake inbox wait",
            type: "request",
          },
        },
        "conn-sender",
      ),
    )

    const result = parseResult<InboxWaitResult>(await wait)
    expect(result.session).toBe("@agent/wait")
    expect(result.unread_count).toBe(1)
    expect(result.timed_out).toBe(false)
    expect(result.aborted).toBe(false)
  })

  it("uses the same timeoutMs fallback accepted by the MCP handler", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const wait = harness.dispatcher.handleRequest(
      {
        jsonrpc: "2.0",
        id: "wait",
        method: "tribe.inbox.wait",
        params: { session: "@agent/wait", timeoutMs: 0 },
      },
      "conn-wait",
    )

    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    harness.sendActionable("@agent/wait")

    const result = parseResult<InboxWaitResult>(await wait)
    expect(result.session).toBe("@agent/wait")
    expect(result.unread_count).toBe(0)
    expect(result.timed_out).toBe(true)
    expect(result.aborted).toBe(false)
  })
})

function createDispatcherHarness(options: { suppressWindowMs?: number; socketStartedAt?: number } = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "tribe-dispatcher-"))
  const scope = createScope("dispatcher-self-registration-test")
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
        const members = new Map<
          string,
          {
            id: string
            name: string
            pid: number
            cwd: string
            role: TribeRole
            claudeSessionId: string | null
            registeredAt: number
            launchId: string | null
            launchParentPid: number | null
            transportPids: number[]
          }
        >()
        for (const client of clients.values()) {
          if (client.role !== "member") continue
          const id = client.ctx.sessionId
          const member = members.get(id)
          if (member) {
            if (client.pid > 0 && !member.transportPids.includes(client.pid)) member.transportPids.push(client.pid)
            member.registeredAt = Math.min(member.registeredAt, client.registeredAt)
            continue
          }
          members.set(id, {
            id,
            name: client.name,
            pid: client.pid,
            cwd: client.project,
            role: client.role,
            claudeSessionId: client.claudeSessionId,
            registeredAt: client.registeredAt,
            launchId: client.launchId,
            launchParentPid: client.launchParentPid,
            transportPids: client.pid > 0 ? [client.pid] : [],
          })
        }
        return Array.from(members.values())
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
      startedAt: options.socketStartedAt ?? Date.now(),
      handedOff: false,
    },
  }
  const daemon = withDispatcher({ suppressWindowMs: options.suppressWindowMs ?? Number.MAX_SAFE_INTEGER })(shape)

  return {
    dispatcher: daemon.dispatcher,
    register(
      connId: string,
      params: {
        name: string
        pid: number
        project: string
        role?: TribeRole
        launchId?: string
        launchParentPid?: number
      },
    ) {
      const req: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: `register-${connId}`,
        method: "register",
        params: {
          ...params,
          role: params.role ?? "member",
          projectName: "km-wt9",
          projectId: "test-project",
          delivery: "pull",
          protocolVersion: TRIBE_PROTOCOL_VERSION,
        },
      }
      return daemon.dispatcher.handleRequest(req, connId)
    },
    sendActionable(
      recipient: string,
      content: string = "wake inbox wait",
      options: { sender?: string; topic?: string; type?: string } = {},
    ) {
      sendMessage(
        daemonCtx,
        recipient,
        content,
        options.type ?? "request",
        undefined,
        undefined,
        "direct",
        options.topic ? { topic: options.topic } : {},
        {},
        options.sender ? { sender: options.sender } : {},
      )
    },
    connectClient(): { connId: string; socket: TestSocket } {
      const socket = createTestSocket()
      daemon.dispatcher.handleConnection(socket)
      const connId = socketToClient.get(socket)
      if (!connId) throw new Error("dispatcher did not register the connected socket")
      return { connId, socket }
    },
    sessionAnnouncements(name: string): string[] {
      const rows = db
        .prepare("SELECT content FROM messages WHERE type = 'session' ORDER BY ts ASC, id ASC")
        .all() as Array<{ content: string }>
      return rows.map((row) => row.content).filter((content) => content.includes(name))
    },
    sessionCount(name: string): number {
      const row = db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE name = ?").get(name) as { count: number }
      return row.count
    },
    sessionJoinEvents(name: string): Array<{ name: string }> {
      const rows = db
        .prepare("SELECT content FROM messages WHERE type = 'event.session.joined' ORDER BY ts ASC, id ASC")
        .all() as Array<{ content: string }>
      return rows.map((row) => JSON.parse(row.content) as { name: string }).filter((event) => event.name === name)
    },
    sessionLeftEvents(name: string): Array<{ name: string }> {
      const rows = db
        .prepare("SELECT content FROM messages WHERE type = 'event.session.left' ORDER BY ts ASC, id ASC")
        .all() as Array<{ content: string }>
      return rows.map((row) => JSON.parse(row.content) as { name: string }).filter((event) => event.name === name)
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
        launchId: null,
        launchParentPid: null,
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
    addTransport(connId: string, canonicalConnId: string, pid: number): TestSocket {
      const canonical = clients.get(canonicalConnId)
      if (!canonical) throw new Error(`canonical client ${canonicalConnId} not found`)
      const socket = createTestSocket()
      clients.set(connId, {
        ...canonical,
        socket,
        id: connId,
        pid,
        registeredAt: canonical.registeredAt + 1,
        lastActivityAt: canonical.lastActivityAt + 1,
      })
      socketToClient.set(socket, connId)
      return socket
    },
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

async function registerMember(
  harness: ReturnType<typeof createDispatcherHarness>,
  connId: string,
  name: string,
): Promise<RegisterResult> {
  return parseResult<RegisterResult>(
    await harness.register(connId, {
      name,
      pid: liveHolderPid,
      project: "/tmp/km-wt6",
    }),
  )
}

function parseError(line: string): { code: number; message: string } {
  const response = JSON.parse(line) as JsonRpcResponse<unknown>
  expect(response.result).toBeUndefined()
  expect(response.error).toBeDefined()
  return response.error!
}

function createTestSocket(): TestSocket {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
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
    on(event: string, handler: (...args: unknown[]) => void) {
      const eventHandlers = handlers.get(event) ?? []
      eventHandlers.push(handler)
      handlers.set(event, eventHandlers)
      return this
    },
    once(event: string, handler: (...args: unknown[]) => void) {
      const wrapped = (...args: unknown[]) => {
        handlers.set(
          event,
          (handlers.get(event) ?? []).filter((candidate) => candidate !== wrapped),
        )
        handler(...args)
      }
      const eventHandlers = handlers.get(event) ?? []
      eventHandlers.push(wrapped)
      handlers.set(event, eventHandlers)
      return this
    },
    emitClose() {
      for (const handler of handlers.get("close") ?? []) handler()
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
