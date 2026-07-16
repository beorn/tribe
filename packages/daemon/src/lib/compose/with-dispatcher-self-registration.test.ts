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
import { TRIBE_COORD_METHODS } from "../handlers.ts"

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
  it("advances the durable role cursor without creating a transient registration", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    harness.sendActionable("@chief", "first historical request")
    harness.sendActionable("@chief", "second historical request")
    harness.sendActionable("@chief", "third historical request")

    const first = parseResult<InboxDrainResult>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "drain-1",
          method: "cli_inbox_drain",
          params: { session: "@chief", limit: 2 },
        },
        "conn-drain",
      ),
    )
    expect(first.events.map((event) => event.content)).toEqual([
      "first historical request",
      "second historical request",
    ])
    expect(first.drained_count).toBe(2)
    expect(first.unread_count).toBe(1)

    const second = parseResult<InboxDrainResult>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "drain-2",
          method: "cli_inbox_drain",
          params: { session: "@chief", limit: 2 },
        },
        "conn-drain",
      ),
    )
    expect(second.events.map((event) => event.content)).toEqual(["third historical request"])
    expect(second.unread_count).toBe(0)

    const wait = parseResult<InboxWaitResult>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "wait-after-drain",
          method: "cli_inbox_wait",
          params: { session: "@chief", timeout_ms: 1 },
        },
        "conn-drain",
      ),
    )
    expect(wait.timed_out).toBe(true)
    expect(wait.unread_count).toBe(0)
    expect(harness.sessionCount("@chief")).toBe(0)
    expect(harness.sessionAnnouncements("@chief")).toEqual([])
  })
})

describe("dispatcher session announcement recovery (@ag/tribe/21052/19442)", () => {
  it("re-attaches a reconnecting name to ONE durable member without join spam", async () => {
    // Durable identity (Goal 1) supersedes the old time-window join coalescing:
    // a name that reconnects re-ATTACHES to its existing member (one identity,
    // one row) instead of re-joining. The first join announces; every re-attach
    // is silent. Durable history stays lossless — the initial `session.joined`
    // plus one `session.attached` per reconnect — so nothing is dropped.
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
      // churn rather than startup suppression.
      const first = harness.connectClient()
      const r1 = await registerMember(harness, first.connId, "@agent/6")
      now += 5_000
      first.socket.emitClose()

      now += 5_000
      const second = harness.connectClient()
      const r2 = await registerMember(harness, second.connId, "@agent/6")
      now += 5_000
      second.socket.emitClose()

      now += 10_000
      const stable = harness.connectClient()
      const r3 = await registerMember(harness, stable.connId, "@agent/6")
      const independent = harness.connectClient()
      await registerMember(harness, independent.connId, "@agent/7")

      // ONE durable member: all three registrations resolve the SAME sessionId
      // and there is exactly one row for the name.
      expect(r2.sessionId).toBe(r1.sessionId)
      expect(r3.sessionId).toBe(r1.sessionId)
      expect(harness.memberRowCount("@agent/6")).toBe(1)

      // Only the first join announces; the two re-attaches are silent.
      const announcements = harness.sessionAnnouncements("@agent/6")
      expect(announcements).toHaveLength(1)
      expect(announcements.every((content) => content.includes("@agent/6 joined (member)"))).toBe(true)
      expect(harness.sessionAnnouncements("@agent/7")).toHaveLength(1)

      // Durable history is lossless: one join + one attach per reconnect.
      expect(harness.sessionJoinEvents("@agent/6")).toHaveLength(1)
      expect(harness.sessionAttachedEvents("@agent/6")).toHaveLength(2)
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

describe("durable member identity (Goal 1)", () => {
  it("keeps the member row across disconnect so fetch/pending still resolve the owner", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const first = harness.connectClient()
    const r1 = parseResult<RegisterResult>(
      await harness.register(first.connId, { name: "@cli-chief", pid: 7001, project: "/tmp/km-wt6" }),
    )

    // An actionable lands for the member — opens its durable, name-keyed mailbox.
    harness.sendActionable("@cli-chief", "please verify")

    // Disconnect DETACHES; the durable row must persist (not be deleted).
    first.socket.emitClose()
    expect(harness.memberRowCount("@cli-chief")).toBe(1)

    // The owner still resolves while detached: the mailbox is name-keyed.
    const status = parseResult<{ unread_count: number }>(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "s", method: "cli_inbox_status", params: { session: "@cli-chief" } },
        "conn-probe",
      ),
    )
    expect(status.unread_count).toBeGreaterThanOrEqual(1)

    // Reconnecting (fresh pid = true CLI churn) re-attaches to the SAME member.
    const second = harness.connectClient()
    const r2 = parseResult<RegisterResult>(
      await harness.register(second.connId, { name: "@cli-chief", pid: 7002, project: "/tmp/km-wt6" }),
    )
    expect(r2.sessionId).toBe(r1.sessionId)
    expect(harness.memberRowCount("@cli-chief")).toBe(1)
  })

  it("attributes 3 CLI connect-send-disconnect cycles to ONE member with zero join/left broadcasts", async () => {
    // suppressWindowMs 0 turns OFF the time-window coalescer, so the ONLY thing
    // that can silence a re-attach is the durable-identity attach path itself.
    const harness = createDispatcherHarness({ suppressWindowMs: 0 })
    cleanup = harness.dispose

    // Establish the durable member (a genuine first join is allowed to announce).
    const est = harness.connectClient()
    const established = parseResult<RegisterResult>(
      await harness.register(est.connId, { name: "@cli-chief", pid: 8000, project: "/tmp/km-wt6" }),
    )
    est.socket.emitClose()
    const baselineAnnouncements = harness.sessionAnnouncements("@cli-chief").length

    // 3 CLI-style cycles, a FRESH pid each (no pid+cwd adoption → attach-by-name).
    for (let i = 0; i < 3; i++) {
      const c = harness.connectClient()
      const res = parseResult<RegisterResult>(
        await harness.register(c.connId, { name: "@cli-chief", pid: 8100 + i, project: "/tmp/km-wt6" }),
      )
      expect(res.sessionId).toBe(established.sessionId)
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: `send-${i}`,
          method: TRIBE_COORD_METHODS.send,
          params: { to: "*", message: `cycle ${i}`, type: "status" },
        },
        c.connId,
      )
      c.socket.emitClose()
    }

    // ONE member row, and the 3 cycles added ZERO join/left broadcasts.
    expect(harness.memberRowCount("@cli-chief")).toBe(1)
    expect(harness.sessionAnnouncements("@cli-chief").length).toBe(baselineAnnouncements)
  })

  it("removes the member on explicit leave", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const c = harness.connectClient()
    await harness.register(c.connId, { name: "@cli-chief", pid: 9001, project: "/tmp/km-wt6" })
    c.socket.emitClose()
    expect(harness.memberRowCount("@cli-chief")).toBe(1)

    const left = parseResult<{ left: boolean; removed: number; name: string }>(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "leave", method: "cli_leave", params: { session: "@cli-chief" } },
        "conn-leave",
      ),
    )
    expect(left.left).toBe(true)
    expect(left.removed).toBe(1)
    expect(harness.memberRowCount("@cli-chief")).toBe(0)
  })

  it("distinguishes attached from detached members in the sessions view", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const liveClient = harness.connectClient()
    await harness.register(liveClient.connId, { name: "@cli-worker", pid: 9101, project: "/tmp/km-wt6" })
    const gone = harness.connectClient()
    await harness.register(gone.connId, { name: "@cli-chief", pid: 9102, project: "/tmp/km-wt6" })
    gone.socket.emitClose()

    const status = parseResult<{ sessions: Array<{ name: string; attached: boolean; epoch: number }> }>(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "st", method: "cli_status", params: {} },
        liveClient.connId,
      ),
    )
    const worker = status.sessions.find((s) => s.name === "@cli-worker")
    const chief = status.sessions.find((s) => s.name === "@cli-chief")
    expect(worker?.attached).toBe(true)
    expect(chief?.attached).toBe(false)
    expect(chief?.epoch ?? 0).toBeGreaterThanOrEqual(1)
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
    register(connId: string, params: { name: string; pid: number; project: string }) {
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
    sendActionable(recipient: string, content: string = "wake inbox wait") {
      sendMessage(daemonCtx, recipient, content, "request", undefined, undefined, "direct")
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
    sessionAttachedEvents(name: string): Array<{ name: string }> {
      const rows = db
        .prepare("SELECT content FROM messages WHERE type = 'event.session.attached' ORDER BY ts ASC, id ASC")
        .all() as Array<{ content: string }>
      return rows.map((row) => JSON.parse(row.content) as { name: string }).filter((event) => event.name === name)
    },
    /** Count of durable `sessions` rows currently holding this exact name. */
    memberRowCount(name: string): number {
      return (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE name = $name").get({ $name: name }) as { n: number })
        .n
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
