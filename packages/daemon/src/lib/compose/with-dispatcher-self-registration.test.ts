import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createConnection, createServer, type Server, type Socket as NetSocket } from "node:net"
import { addWriter, getLogLevel, setLogLevel, setSuppressConsole, type LogEvent } from "loggily"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createScope, type InboxWaitResult } from "tribe-wire"
import { TRIBE_PROTOCOL_VERSION, type JsonRpcRequest } from "tribe-wire/lib/socket"
import type { TribeRole } from "tribe-wire/lib/config"
import { createTribeContext } from "../context.ts"
import { openDatabase, createStatements } from "../database.ts"
import { sendMessage } from "../messaging.ts"
import type { ClientSession } from "./with-client-registry.ts"
import { withDispatcher } from "./with-dispatcher.ts"

type TestSocket = NetSocket & {
  destroyedByDispatcher: boolean
  emitClose(hadError?: boolean): void
  emitError(error: Error): void
  writes: string[]
}

type RegisterResult = {
  sessionId: string
  name: string
  role: TribeRole
}

type SendResult = {
  id: string
  sent: boolean
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
const logCleanups: Array<() => void> = []

afterEach(async () => {
  while (logCleanups.length > 0) logCleanups.pop()?.()
  if (cleanup) {
    const dispose = cleanup
    cleanup = null
    await dispose()
  }
})

describe("dispatcher self-registration collision handling (@ag/tribe/19594)", () => {
  it("attributes a pre-registration send to its socket instead of a claimed sender", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    const client = harness.connectClient()

    const sent = parseResult<{ structuredContent: SendResult }>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "send-before-register",
          method: "tribe.send",
          params: {
            to: "@agent/7",
            message: "forged attribution attempt",
            type: "notify",
            sender: "@chief",
          },
        },
        client.connId,
      ),
    ).structuredContent

    expect(sent.sent).toBe(true)
    expect(client.name).toMatch(/^pending-/u)
    expect(harness.messageSender(sent.id)).toBe(client.name)
  })

  it("persists a startup notification filter before the session becomes connected", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    harness.addPendingClient("conn-fleet")

    await harness.register("conn-fleet", {
      name: "@fleet",
      pid: liveHolderPid,
      project: "/tmp/km",
      filterMode: "focus",
    })

    expect(harness.sessionFilter("@fleet")).toEqual({ mode: "focus", until: null, mute: null })
  })

  it("preserves or overrides the stored notification filter when another transport fans in", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    harness.addPendingClient("conn-fleet-primary")

    const primary = parseResult<RegisterResult>(
      await harness.register("conn-fleet-primary", {
        name: "@fleet",
        pid: liveHolderPid,
        project: "/tmp/km",
        launchId: "fleet-filter-launch",
        launchParentPid: process.pid,
      }),
    )
    const staleFilter = {
      mode: "focus",
      until: Date.now() + 60_000,
      mute: JSON.stringify(["github:*"]),
    }
    harness.setSessionFilter("@fleet", staleFilter)

    harness.addPendingClient("conn-fleet-secondary")
    const secondary = parseResult<RegisterResult>(
      await harness.register("conn-fleet-secondary", {
        name: "@fleet",
        pid: otherLivePid,
        project: "/tmp/km",
        launchId: "fleet-filter-launch",
        launchParentPid: process.pid,
      }),
    )

    expect(secondary.sessionId).toBe(primary.sessionId)
    expect(harness.sessionFilter("@fleet")).toEqual(staleFilter)

    harness.addPendingClient("conn-fleet-override")
    const overridden = parseResult<RegisterResult>(
      await harness.register("conn-fleet-override", {
        name: "@fleet",
        pid: otherLivePid,
        project: "/tmp/km",
        launchId: "fleet-filter-launch",
        launchParentPid: process.pid,
        filterMode: "normal",
      }),
    )

    expect(overridden.sessionId).toBe(primary.sessionId)
    expect(harness.sessionFilter("@fleet")).toEqual({ mode: "normal", until: null, mute: null })

    harness.addPendingClient("conn-fleet-invalid")
    const invalid = parseError(
      await harness.register("conn-fleet-invalid", {
        name: "@fleet",
        pid: otherLivePid,
        project: "/tmp/km",
        launchId: "fleet-filter-launch",
        launchParentPid: process.pid,
        filterMode: "everything",
      }),
    )
    expect(invalid).toMatchObject({ code: -32602, message: expect.stringContaining("focus|normal|ambient") })
    expect(harness.sessionFilter("@fleet")).toEqual({ mode: "normal", until: null, mute: null })
  })

  it("starts reconnect grace only after the last launch sibling transport closes", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    const launch = { launchId: "shared-grace-launch", launchParentPid: process.pid }

    const firstClient = harness.connectClient()
    const first = parseResult<RegisterResult>(
      await harness.register(firstClient.connId, {
        name: "@agent/9",
        pid: liveHolderPid,
        project: "/tmp/km-wt9",
        ...launch,
      }),
    )
    const secondClient = harness.connectClient()
    const second = parseResult<RegisterResult>(
      await harness.register(secondClient.connId, {
        name: "@agent/9",
        pid: otherLivePid,
        project: "/tmp/km-wt9",
        ...launch,
      }),
    )

    expect(second.sessionId).toBe(first.sessionId)
    expect(harness.transportLifetimeEvents()).toEqual([
      { type: "connected", sessionId: first.sessionId },
      { type: "connected", sessionId: first.sessionId },
    ])

    firstClient.socket.emitClose()
    expect(harness.transportLifetimeEvents().some((event) => event.type === "disconnected")).toBe(false)

    secondClient.socket.emitClose()
    expect(harness.transportLifetimeEvents().at(-1)).toEqual({ type: "disconnected", sessionId: first.sessionId })
  })

  it("lets the same live PID re-register an explicit agent name", async () => {
    const logs = captureDispatcherLogs()
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const firstClient = harness.connectClient()
    const first = parseResult<RegisterResult>(
      await harness.register(firstClient.connId, {
        name: "@agent/9",
        pid: liveHolderPid,
        project: "/tmp/km-wt9",
      }),
    )

    const secondClient = harness.connectClient()
    const second = parseResult<RegisterResult>(
      await harness.register(secondClient.connId, {
        name: "@agent/9",
        pid: liveHolderPid,
        project: "/tmp/km-wt9",
      }),
    )

    expect(second.name).toBe("@agent/9")
    expect(second.sessionId).toBe(first.sessionId)
    expect(firstClient.socket.destroyedByDispatcher).toBe(true)
    expect(secondClient.socket.destroyedByDispatcher).toBe(false)

    firstClient.socket.emitClose()
    expect(
      logs.find(
        (event) =>
          event.level === "debug" &&
          event.message === "transport.retired" &&
          event.props?.connection_id === firstClient.connId,
      )?.props,
    ).toMatchObject({ name: "@agent/9", reason: "self-registration-replaced" })
    expect(
      logs.some(
        (event) => event.message === "connection.disconnected" && event.props?.connection_id === firstClient.connId,
      ),
    ).toBe(false)

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

  it("clamps a registered client to the highest mutually supported wire protocol", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    harness.addPendingClient("conn-current")

    const current = parseResult<{ protocolVersion: number }>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "register-current",
          method: "register",
          params: {
            name: "@agent/current",
            role: "member",
            pid: liveHolderPid,
            project: "/tmp/km-wt9",
            projectName: "km-wt9",
            projectId: "test-project",
            delivery: "pull",
            // Keep the old scalar at N-1 so a pre-window daemon can still
            // accept this registration, while the new daemon intersects the
            // advertised capability set and selects N.
            protocolVersion: TRIBE_PROTOCOL_VERSION - 1,
            supportedProtocolVersions: [TRIBE_PROTOCOL_VERSION, TRIBE_PROTOCOL_VERSION - 1],
          },
        },
        "conn-current",
      ),
    )

    expect(current.protocolVersion).toBe(TRIBE_PROTOCOL_VERSION)
    expect(harness.sessionCount("@agent/current")).toBe(1)

    harness.addPendingClient("conn-legacy")
    const legacy = parseResult<{ protocolVersion: number }>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "register-legacy",
          method: "register",
          params: {
            name: "@agent/legacy",
            role: "member",
            pid: otherLivePid,
            project: "/tmp/km-wt9",
            projectName: "km-wt9",
            projectId: "test-project",
            delivery: "pull",
            protocolVersion: TRIBE_PROTOCOL_VERSION - 1,
          },
        },
        "conn-legacy",
      ),
    )

    expect(legacy.protocolVersion).toBe(TRIBE_PROTOCOL_VERSION - 1)
    expect(harness.sessionCount("@agent/legacy")).toBe(1)

    harness.addPendingClient("conn-too-old")
    const error = parseError(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "register-too-old",
          method: "register",
          params: {
            name: "@agent/too-old",
            role: "member",
            pid: otherLivePid + 1,
            project: "/tmp/km-wt9",
            projectName: "km-wt9",
            projectId: "test-project",
            delivery: "pull",
            protocolVersion: TRIBE_PROTOCOL_VERSION - 2,
          },
        },
        "conn-too-old",
      ),
    )

    expect(error.message).toContain(`client=${TRIBE_PROTOCOL_VERSION - 2}`)
    expect(error.message).toContain(`supported=${TRIBE_PROTOCOL_VERSION},${TRIBE_PROTOCOL_VERSION - 1}`)
    expect(error.message).toMatch(/upgrade.*client.*reconnect/i)
    expect(harness.sessionCount("@agent/too-old")).toBe(0)
  })

  it("exposes the current wire protocol without creating session state", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const result = parseResult<{ protocol_version: number }>(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "protocol", method: "cli_protocol", params: {} },
        "conn-protocol-probe",
      ),
    )

    expect(result).toEqual({
      protocol_version: TRIBE_PROTOCOL_VERSION,
      supported_protocol_versions: [TRIBE_PROTOCOL_VERSION, TRIBE_PROTOCOL_VERSION - 1],
    })
    expect(harness.sessionCount("@agent/protocol-probe")).toBe(0)
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

describe("dispatcher operational logging", () => {
  it("binds a connection to its named seat and records operations and peer-close reason without payloads", async () => {
    const logs = captureDispatcherLogs()
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    const client = harness.connectClient()

    expect(logs.filter((event) => event.level === "info")).toEqual([])

    const registered = parseResult<RegisterResult>(
      await harness.register(client.connId, {
        name: "@agent/6",
        pid: liveHolderPid,
        project: "/tmp/km-wt6",
        launchId: "launch-agent-6",
        launchParentPid: 6006,
      }),
    )
    const privatePayload = "message-payload-must-not-enter-logs"
    parseResult<{ structuredContent: SendResult }>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "send-after-identify",
          method: "tribe.send",
          params: {
            to: "@agent/7",
            message: privatePayload,
            type: "notify",
          },
        },
        client.connId,
      ),
    )
    const hostileOperation = `${privatePayload}\n${"x".repeat(128)}`
    await harness.dispatcher.handleRequest(
      {
        jsonrpc: "2.0",
        id: "hostile-operation-name",
        method: hostileOperation,
        params: {},
      },
      client.connId,
    )
    client.socket.emitClose()

    const identified = logs.find((event) => event.level === "info" && event.message === "session.identified")
    expect(identified?.props).toMatchObject({
      connection_id: client.connId,
      member_id: registered.sessionId,
      name: "@agent/6",
      operation: "register",
      launch_id: "launch-agent-6",
      launch_parent_pid: 6006,
    })
    expect(identified?.time).toEqual(expect.any(Number))

    const operation = logs.find(
      (event) =>
        event.level === "info" && event.message === "operation.received" && event.props?.operation === "tribe.send",
    )
    expect(operation?.props).toMatchObject({
      connection_id: client.connId,
      member_id: registered.sessionId,
      name: "@agent/6",
      direction: "inbound",
      operation: "tribe.send",
    })
    expect(
      logs.find(
        (event) =>
          event.level === "info" && event.message === "operation.received" && event.props?.operation === "<invalid>",
      ),
    ).toBeDefined()

    const disconnected = logs.find((event) => event.level === "info" && event.message === "session.disconnected")
    expect(disconnected?.props).toMatchObject({
      connection_id: client.connId,
      member_id: registered.sessionId,
      name: "@agent/6",
      reason: "peer-close",
    })
    expect(disconnected?.props).not.toHaveProperty("operations")
    expect(disconnected?.props).not.toHaveProperty("last_operation")
    expect(JSON.stringify(logs)).not.toContain(privatePayload)
    expect(logs.some((event) => event.level === "info" && event.message.startsWith("Client connected:"))).toBe(false)
  })

  it("keeps every same-launch fan-in at debug and emits one canonical identity at info", async () => {
    const logs = captureDispatcherLogs()
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    const first = harness.connectClient()
    const firstRegistration = parseResult<RegisterResult>(
      await harness.register(first.connId, {
        name: "@ci",
        pid: liveHolderPid,
        project: "/tmp/km-wt6",
        launchId: "launch-ci",
        launchParentPid: 7007,
      }),
    )
    const second = harness.connectClient()
    const secondRegistration = parseResult<RegisterResult>(
      await harness.register(second.connId, {
        name: "@ci",
        pid: otherLivePid,
        project: "/tmp/km-wt6",
        launchId: "launch-ci",
        launchParentPid: 7007,
      }),
    )
    const third = harness.connectClient()
    const thirdRegistration = parseResult<RegisterResult>(
      await harness.register(third.connId, {
        name: "@ci",
        pid: otherLivePid + 1,
        project: "/tmp/km-wt6",
        launchId: "launch-ci",
        launchParentPid: 7007,
      }),
    )

    expect(secondRegistration.sessionId).toBe(firstRegistration.sessionId)
    expect(thirdRegistration.sessionId).toBe(firstRegistration.sessionId)
    expect(
      logs.filter(
        (event) => event.level === "info" && event.message === "session.identified" && event.props?.name === "@ci",
      ),
    ).toHaveLength(1)
    expect(logs.some((event) => event.level === "info" && event.message === "transport.fan-in")).toBe(false)
    expect(
      logs.find(
        (event) =>
          event.level === "debug" &&
          event.message === "transport.attached" &&
          event.props?.connection_id === second.connId,
      )?.props,
    ).toMatchObject({
      connection_id: second.connId,
      member_id: firstRegistration.sessionId,
      launch_id: "launch-ci",
      transport_class: "same-launch-fan-in",
    })
    expect(
      logs.filter(
        (event) => event.level === "debug" && event.message === "transport.attached" && event.props?.name === "@ci",
      ),
    ).toHaveLength(2)
    expect(logs.some((event) => event.level === "info" && event.message.startsWith("launch fan-in:"))).toBe(false)

    first.socket.emitClose()
    second.socket.emitClose()
    third.socket.emitClose()

    const reconnected = harness.connectClient()
    await harness.register(reconnected.connId, {
      name: "@ci",
      pid: liveHolderPid,
      project: "/tmp/km-wt6",
      launchId: "launch-ci",
      launchParentPid: 7007,
    })
    const reconnectedFanIn = harness.connectClient()
    await harness.register(reconnectedFanIn.connId, {
      name: "@ci",
      pid: otherLivePid,
      project: "/tmp/km-wt6",
      launchId: "launch-ci",
      launchParentPid: 7007,
    })

    expect(
      logs.filter(
        (event) => event.level === "info" && event.message === "session.identified" && event.props?.name === "@ci",
      ),
    ).toHaveLength(2)
    expect(
      logs.filter(
        (event) => event.level === "debug" && event.message === "transport.attached" && event.props?.name === "@ci",
      ),
    ).toHaveLength(3)
    expect(logs.some((event) => event.level === "info" && event.message === "transport.fan-in")).toBe(false)
  })

  it("attributes an immediate socket error and disconnect to the resolved seat with a bounded reason", async () => {
    const logs = captureDispatcherLogs()
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    const client = harness.connectClient()
    const registered = parseResult<RegisterResult>(
      await harness.register(client.connId, {
        name: "@agent/4",
        pid: liveHolderPid,
        project: "/tmp/km-wt4",
        launchId: "launch-agent-4",
        launchParentPid: 4004,
      }),
    )
    const socketError = Object.assign(new Error("sensitive socket detail"), { code: "ECONNRESET" })

    client.socket.emitError(socketError)
    client.socket.emitClose(true)

    expect(logs.find((event) => event.level === "warn" && event.message === "connection.error")?.props).toMatchObject({
      connection_id: client.connId,
      member_id: registered.sessionId,
      name: "@agent/4",
      reason: "socket-error",
      error_code: "ECONNRESET",
    })
    expect(
      logs.find((event) => event.level === "info" && event.message === "session.disconnected")?.props,
    ).toMatchObject({
      connection_id: client.connId,
      member_id: registered.sessionId,
      name: "@agent/4",
      reason: "socket-error",
    })
    const disconnected = logs.find((event) => event.level === "info" && event.message === "session.disconnected")
    expect(disconnected?.props).not.toHaveProperty("error_code")
    expect(disconnected?.props).not.toHaveProperty("operations")
    expect(JSON.stringify(logs)).not.toContain(socketError.message)
  })

  it("preserves the socket-error reason through a real Unix socket close", async () => {
    const logs = captureDispatcherLogs()
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    let resolveAcceptedSocket!: (socket: NetSocket) => void
    const acceptedSocket = new Promise<NetSocket>((resolve) => {
      resolveAcceptedSocket = resolve
    })
    const server = createServer((socket) => {
      resolveAcceptedSocket(socket)
      harness.dispatcher.handleConnection(socket)
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(harness.socketPath, resolve)
    })
    const client = createConnection(harness.socketPath)
    client.on("error", () => {})

    try {
      await new Promise<void>((resolve) => client.once("connect", resolve))
      const response = readSocketLine(client)
      client.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "real-socket-register",
          method: "register",
          params: {
            name: "@agent/4",
            role: "member",
            domains: [],
            delivery: "pull",
            project: "/tmp/km-wt4",
            projectName: "km-wt4",
            projectId: "test-project",
            pid: liveHolderPid,
            launchId: "launch-agent-4-real-socket",
            launchParentPid: 4004,
            protocolVersion: TRIBE_PROTOCOL_VERSION,
          },
        })}\n`,
      )
      const registered = parseResult<RegisterResult>(await response)
      const serverSocket = await acceptedSocket
      const closed = new Promise<void>((resolve) => serverSocket.once("close", () => resolve()))
      serverSocket.destroy(Object.assign(new Error("sensitive real-socket detail"), { code: "ECONNRESET" }))
      await closed

      expect(logs.find((event) => event.level === "warn" && event.message === "connection.error")?.props).toMatchObject(
        {
          member_id: registered.sessionId,
          name: "@agent/4",
          reason: "socket-error",
          error_code: "ECONNRESET",
        },
      )
      expect(
        logs.find((event) => event.level === "info" && event.message === "session.disconnected")?.props,
      ).toMatchObject({
        member_id: registered.sessionId,
        name: "@agent/4",
        reason: "socket-error",
      })
      expect(harness.healthLogs()).toEqual([
        {
          message:
            "tribe:dispatcher: managed bridge lost after socket error " +
            "(name=@agent/4, launch=launch-agent-4-real-socket, parent_pid=4004)",
          type: "health:daemon:warn",
        },
      ])
      expect(JSON.stringify(logs)).not.toContain("sensitive real-socket detail")
    } finally {
      client.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe("dispatcher bounded mailbox drain", () => {
  it("accepts turn-start receipts only from a launch-authenticated member and deduplicates provider turns", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    const params = {
      controller_session_id: "s1",
      provider_session_id: "provider-session-1",
      provider_turn_id: "provider-turn-1",
      started_at: 1_234,
    }

    harness.addPendingClient("conn-untrusted")
    const untrusted = parseError(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "untrusted-receipt", method: "host_turn_started_v1", params },
        "conn-untrusted",
      ),
    )
    expect(untrusted.code).toBe(-32003)

    const { connId } = harness.connectClient()
    await harness.register(connId, {
      name: "@agent/0",
      pid: liveHolderPid,
      project: "/tmp/hh",
      launchId: "launch-a",
      launchParentPid: process.pid,
    })

    const spoofed = parseError(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "spoofed-receipt",
          method: "host_turn_started_v1",
          params: { ...params, session: "@agent/9", launch_id: "launch-spoofed" },
        },
        connId,
      ),
    )
    expect(spoofed.code).toBe(-32602)

    const first = parseResult<Record<string, unknown>>(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "receipt-1", method: "host_turn_started_v1", params },
        connId,
      ),
    )
    const duplicate = parseResult<Record<string, unknown>>(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "receipt-2", method: "host_turn_started_v1", params },
        connId,
      ),
    )
    expect(first).toMatchObject({ recorded: true, duplicate: false, session: "@agent/0", launch_id: "launch-a" })
    expect(duplicate).toMatchObject({ recorded: true, duplicate: true })

    const latest = parseResult<Record<string, unknown>>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "latest-receipt",
          method: "cli_turn_start_receipt_by_launch_v1",
          params: { launch_id: "launch-a" },
        },
        "conn-status",
      ),
    )
    expect(latest).toMatchObject({
      session: "@agent/0",
      launch_id: "launch-a",
      launch_parent_pid: process.pid,
      controller_session_id: "s1",
      provider_session_id: "provider-session-1",
      provider_turn_id: "provider-turn-1",
      started_at: 1_234,
    })
  })

  it("validates daemon-derived launch targets and fails closed on conflicting authorities", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    for (const [label, params, code] of [
      ["missing launch id", {}, -32602],
      ["empty launch id", { launch_id: "" }, -32602],
      ["session override", { launch_id: "managed-launch", session: "@chief" }, -32602],
      ["caller parent override", { launch_id: "managed-launch", launch_parent_pid: process.pid }, -32602],
      ["unknown launch", { launch_id: "missing-launch" }, -32003],
    ] as const) {
      const error = parseError(
        await harness.dispatcher.handleRequest(
          { jsonrpc: "2.0", id: `invalid-${label}`, method: "cli_inbox_status_by_launch_v1", params },
          "conn-status",
        ),
      )
      expect(error.code, label).toBe(code)
    }

    for (const [connId, name, pid, project, launchParentPid] of [
      ["conn-outer", "@agent/outer", process.pid, "/tmp/km-outer", process.pid],
      ["conn-inner", "@agent/inner", process.ppid, "/tmp/km-inner", process.ppid],
    ] as const) {
      harness.addPendingClient(connId)
      await harness.register(connId, {
        name,
        pid,
        project,
        launchId: "shared-inherited-launch",
        launchParentPid,
      })
    }

    const ambiguous = parseError(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "ambiguous-launch-inbox",
          method: "cli_inbox_status_by_launch_v1",
          params: { launch_id: "shared-inherited-launch" },
        },
        "conn-status",
      ),
    )

    expect(ambiguous.code).toBe(-32003)
    expect(ambiguous.message).toMatch(/resolved to 2 sessions|ambiguous/i)
  })

  it("resolves a launch to its sole routable session when connected tombstones share the launch id", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    const launchId = "retained-dead-launch"

    for (const index of [1, 2, 3]) {
      const { connId } = harness.connectClient()
      await harness.register(connId, {
        name: `@chief-dead-${String(index).padStart(8, "0")}`,
        pid: liveHolderPid + index,
        project: "/tmp/hh",
        launchId,
        launchParentPid: process.pid,
      })
    }

    const { connId: liveConnId } = harness.connectClient()
    await harness.register(liveConnId, {
      name: "@chief",
      pid: liveHolderPid,
      project: "/tmp/hh",
      launchId,
      launchParentPid: process.pid,
    })

    const status = parseResult<{ session: string; unread_count: number }>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "retained-dead-launch-inbox",
          method: "cli_inbox_status_by_launch_v1",
          params: { launch_id: launchId },
        },
        "conn-status",
      ),
    )

    expect(status).toMatchObject({ session: "@chief", unread_count: 0 })
  })

  it("projects the latest actionable cursor structurally without exposing message content", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    const launchId = "await-shadow-launch"
    const { connId } = harness.connectClient()
    await harness.register(connId, {
      name: "@agent/0",
      pid: liveHolderPid,
      project: "/tmp/hh",
      launchId,
      launchParentPid: process.pid,
    })
    harness.sendActionable("@agent/0", "older private body")
    const latest = harness.sendActionable("@agent/0", "newer private body")

    const status = parseResult<Record<string, unknown>>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "await-shadow-inbox",
          method: "cli_inbox_status_by_launch_v1",
          params: { launch_id: launchId },
        },
        "conn-status",
      ),
    )

    expect(status).toMatchObject({
      session: "@agent/0",
      unread_count: 2,
      latest_actionable_seq: latest.rowid,
      latest_message_id: latest.id,
      latest_type: "request",
    })
    expect(status).not.toHaveProperty("content")

    const delivery = parseResult<Record<string, unknown>>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "await-shadow-delivery",
          method: "cli_inbox_delivery_by_launch_v1",
          params: { launch_id: launchId, message_seq: latest.rowid, message_id: latest.id },
        },
        "conn-status",
      ),
    )
    expect(delivery).toMatchObject({
      session: "@agent/0",
      launch_id: launchId,
      message: {
        seq: latest.rowid,
        id: latest.id,
        type: "request",
        sender: "daemon",
        content: "newer private body",
      },
    })

    const log = parseResult<{ messages: Array<Record<string, unknown>> }>(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "await-shadow-log", method: "cli_log", params: { all: true } },
        "conn-status",
      ),
    )
    expect(log.messages.at(-1)).not.toHaveProperty("rowid")
  })

  it("keeps legal names containing the tombstone marker routable", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    const launchId = "legal-dead-marker-launch"
    const name = "@agent/foo-dead-letter"
    const { connId } = harness.connectClient()
    await harness.register(connId, {
      name,
      pid: liveHolderPid,
      project: "/tmp/hh",
      launchId,
      launchParentPid: process.pid,
    })

    const status = parseResult<{ session: string }>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "legal-dead-marker-inbox",
          method: "cli_inbox_status_by_launch_v1",
          params: { launch_id: launchId },
        },
        "conn-status",
      ),
    )

    expect(status.session).toBe(name)
  })

  it("advances the durable role cursor without creating a transient registration", async () => {
    const harness = createDispatcherHarness({ operatorCapability: "operator-test-secret" })
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
          params: { session: "@chief", limit: 2, operator_capability: "operator-test-secret" },
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
          params: { session: "@chief", limit: 2, operator_capability: "operator-test-secret" },
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
    expect(wait.attention.actionable_unread).toEqual([])
    expect(wait.attention.pending_balls).toHaveLength(3)
    expect(harness.sessionCount("@chief")).toBe(0)
    expect(harness.sessionAnnouncements("@chief")).toEqual([])
  })

  it("denies a registered role that tries to acknowledge another role's mailbox", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    harness.addPendingClient("conn-agent-7")
    await harness.register("conn-agent-7", {
      name: "@agent/7",
      pid: liveHolderPid,
      project: "/tmp/km-wt7",
    })
    harness.sendActionable("@chief", "chief-only request")
    harness.sendActionable("@agent/7", "agent-owned request")

    const denied = parseError(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "cross-role-drain",
          method: "cli_inbox_drain",
          params: { session: "@chief", limit: 10 },
        },
        "conn-agent-7",
      ),
    )
    expect(denied.message).toMatch(/bound to the authenticated current session.*session override/i)

    const selfAsserted = parseError(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "self-asserted-drain",
          method: "cli_inbox_drain",
          params: { session: "@agent/7", limit: 10 },
        },
        "conn-agent-7",
      ),
    )
    expect(selfAsserted.message).toMatch(/bound to the authenticated current session.*session override/i)

    const own = parseResult<InboxDrainResult>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "own-role-drain",
          method: "cli_inbox_drain",
          params: { limit: 10 },
        },
        "conn-agent-7",
      ),
    )
    expect(own.events.map((event) => event.content)).toEqual(["agent-owned request"])
    const chiefStatus = parseResult<{ unread_count: number }>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "chief-status",
          method: "cli_inbox_status",
          params: { session: "@chief" },
        },
        "conn-agent-7",
      ),
    )
    expect(chiefStatus.unread_count).toBe(1)
  })

  it("reports indeterminate authority when no operator capability exists to evaluate", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    harness.sendActionable("@chief", "must remain unread")

    const indeterminate = parseError(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "unconfigured-authority-drain",
          method: "cli_inbox_drain",
          params: { session: "@chief", limit: 10 },
        },
        "conn-untrusted",
      ),
    )
    expect(indeterminate).toMatchObject({
      code: -32004,
      message: expect.stringMatching(/could-not-evaluate.*operator capability is not configured/i),
      data: { kind: "could-not-evaluate", reason: "operator-capability-unconfigured" },
    })

    const status = parseResult<{ unread_count: number }>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "chief-status-after-indeterminate",
          method: "cli_inbox_status",
          params: { session: "@chief" },
        },
        "conn-untrusted",
      ),
    )
    expect(status.unread_count).toBe(1)
  })

  it("reports unauthenticated when an unregistered caller presents the wrong operator capability", async () => {
    const harness = createDispatcherHarness({ operatorCapability: "operator-test-secret" })
    cleanup = harness.dispose
    harness.sendActionable("@chief", "must remain unread")

    const denied = parseError(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "untrusted-drain",
          method: "cli_inbox_drain",
          params: { session: "@chief", limit: 10, operator_capability: "wrong-secret" },
        },
        "conn-untrusted",
      ),
    )
    expect(denied).toMatchObject({
      code: -32003,
      message: expect.stringMatching(/unauthenticated.*operator capability was rejected/i),
      data: { kind: "unauthenticated", reason: "operator-capability-rejected" },
    })

    const status = parseResult<{ unread_count: number }>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "chief-status-after-denial",
          method: "cli_inbox_status",
          params: { session: "@chief" },
        },
        "conn-untrusted",
      ),
    )
    expect(status.unread_count).toBe(1)
  })
})

describe("dispatcher durable log projection", () => {
  it("filters correlation refs and reply ids by literal prefix without deriving controller policy", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    harness.sendWithRef("ball-controller:v1:owner-epoch:@agent/6:launch-1")
    harness.sendWithRef("ball-controller:v1:answer-sla:req-2")
    harness.sendWithRef("another-controller:v1:owner-epoch:@agent/7:launch-2")
    harness.sendReply("ball-rescue:v1:%40agent%2F6:launch-1")
    harness.sendReply("another-controller:v1:request-2")

    const result = parseResult<{
      messages: Array<{ ref: string | null; reply: string | null }>
      query: { all: boolean; ref_prefix: string | null; reply_prefix: string | null }
    }>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "controller-journal",
          method: "cli_log",
          params: { all: true, ref_prefix: "ball-controller:v1:", reply_prefix: "ball-rescue:v1:" },
        },
        "conn-log",
      ),
    )

    expect(result.messages.map(({ ref, reply }) => ({ ref, reply }))).toEqual([
      { ref: "ball-controller:v1:owner-epoch:@agent/6:launch-1", reply: null },
      { ref: "ball-controller:v1:answer-sla:req-2", reply: null },
      { ref: null, reply: "ball-rescue:v1:%40agent%2F6:launch-1" },
    ])
    expect(result.query).toEqual({
      all: true,
      ref_prefix: "ball-controller:v1:",
      reply_prefix: "ball-rescue:v1:",
    })
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
    expect(result).not.toHaveProperty("baseline_seq")
    expect(result.attention.actionable_unread).toEqual([expect.objectContaining({ content: "wake inbox wait" })])
    expect(result.attention.pending_balls).toEqual([expect.objectContaining({ recipient: "@agent/wait" })])
  })

  it("caps the full MCP window and wakes only an opted-in requester on its validated reply", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    for (const [connId, name] of [
      ["conn-requester", "@requester"],
      ["conn-responder", "@responder"],
    ] as const) {
      harness.addPendingClient(connId)
      await registerMember(harness, connId, name)
    }

    parseResult(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "request",
          method: "tribe.send",
          params: {
            to: "@responder",
            message: "please respond",
            type: "request",
            request: "req-correlated",
          },
        },
        "conn-requester",
      ),
    )

    const wait = harness.dispatcher.handleRequest(
      {
        jsonrpc: "2.0",
        id: "wait-correlated",
        method: "tribe.inbox.wait",
        params: {
          session: "@requester",
          timeout_ms: 24 * 60 * 60_000,
          wake_on_correlated_reply: true,
        },
      },
      "conn-requester",
    )

    parseResult(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "reply",
          method: "tribe.send",
          params: {
            to: "@requester",
            message: "correlated reply",
            type: "response",
            reply: "req-correlated",
          },
        },
        "conn-responder",
      ),
    )

    await expect(wait.then(parseResult<InboxWaitResult>)).resolves.toMatchObject({
      session: "@requester",
      unread_count: 0,
      effective_timeout_ms: 30 * 60_000,
      timed_out: false,
      aborted: false,
    })
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
    expect(result.attention).toEqual({
      actionable_unread: [],
      pending_balls: [],
      pending_balls_summary: { total: 0, oldest_age_ms: 0 },
    })
  })

  it("records an inbox-wait attention receipt for the authenticated caller, never an explicit target", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    harness.addPendingClient("conn-reader")
    await harness.register("conn-reader", {
      name: "@agent/reader",
      pid: liveHolderPid,
      project: "/tmp/km-wt-reader",
    })

    const receiptAt = Date.now() + 5_000
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(receiptAt)
    try {
      const result = parseResult<InboxWaitResult>(
        await harness.dispatcher.handleRequest(
          {
            jsonrpc: "2.0",
            id: "wait-explicit-target",
            method: "tribe.inbox.wait",
            params: { session: "@agent/other", timeoutMs: 0 },
          },
          "conn-reader",
        ),
      )
      expect(result.timed_out).toBe(true)
      expect(harness.mailboxAttentionReadAt("@agent/reader")).toBe(receiptAt)
      expect(harness.mailboxAttentionReadAt("@agent/other")).toBeNull()
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("records a launch-correlated CLI wait receipt but never an explicit operator wait receipt", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    const launchId = "managed-inbox-reader"
    const name = "@agent/launch-reader"
    const { connId } = harness.connectClient()
    await harness.register(connId, {
      name,
      pid: liveHolderPid,
      project: "/tmp/km-wt-launch-reader",
      launchId,
      launchParentPid: process.pid,
    })

    const receiptAt = Date.now() + 5_000
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(receiptAt)
    try {
      const explicit = parseResult<InboxWaitResult & { baseline_seq: number }>(
        await harness.dispatcher.handleRequest(
          {
            jsonrpc: "2.0",
            id: "wait-explicit-operator",
            method: "cli_inbox_wait",
            params: { session: name, timeoutMs: 0 },
          },
          "conn-cli",
        ),
      )
      expect(explicit.timed_out).toBe(true)
      expect(explicit.baseline_seq).toBe(0)
      expect(harness.mailboxAttentionReadAt(name)).toBeNull()

      const correlated = parseResult<InboxWaitResult & { baseline_seq: number }>(
        await harness.dispatcher.handleRequest(
          {
            jsonrpc: "2.0",
            id: "wait-launch-correlated",
            method: "cli_inbox_wait_by_launch_v1",
            params: { launch_id: launchId, timeoutMs: 0 },
          },
          "conn-cli",
        ),
      )
      expect(correlated.timed_out).toBe(true)
      expect(correlated.baseline_seq).toBe(0)
      expect(harness.mailboxAttentionReadAt(name)).toBe(receiptAt)
    } finally {
      nowSpy.mockRestore()
    }
  })
})

function createDispatcherHarness(
  options: { suppressWindowMs?: number; socketStartedAt?: number; operatorCapability?: string } = {},
) {
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
  const transportLifetimeEvents: Array<{ type: "connected" | "disconnected"; sessionId: string }> = []
  const healthLogs: Array<{ message: string; type: string }> = []
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
      operatorCapability: options.operatorCapability ?? null,
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
      markTransportConnected(sessionId: string) {
        transportLifetimeEvents.push({ type: "connected", sessionId })
      },
      markTransportDisconnected(sessionId: string) {
        transportLifetimeEvents.push({ type: "disconnected", sessionId })
      },
      isReconnectGraceProtected(): boolean {
        return false
      },
      startupReconnectGraceRemainingMs(): number {
        return 0
      },
      forgetTransportSessions() {},
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
      startedAt: options.socketStartedAt ?? Date.now(),
      handedOff: false,
    },
  }
  const daemon = withDispatcher({ suppressWindowMs: options.suppressWindowMs ?? Number.MAX_SAFE_INTEGER })(shape)

  return {
    socketPath: shape.config.socketPath,
    dispatcher: daemon.dispatcher,
    register(
      connId: string,
      params: {
        name: string
        pid: number
        project: string
        launchId?: string
        launchParentPid?: number
        filterMode?: string
      },
    ) {
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
      return sendMessage(daemonCtx, recipient, content, "request", undefined, undefined, "direct")
    },
    sendWithRef(ref: string) {
      sendMessage(daemonCtx, "@fleet", `effect ${ref}`, "notify", undefined, ref, "direct")
    },
    sendReply(reply: string) {
      sendMessage(daemonCtx, "@controller", `reply ${reply}`, "verdict", undefined, undefined, "direct", {}, { reply })
    },
    transportLifetimeEvents() {
      return [...transportLifetimeEvents]
    },
    healthLogs() {
      return [...healthLogs]
    },
    connectClient(): { connId: string; name: string; socket: TestSocket } {
      const socket = createTestSocket()
      daemon.dispatcher.handleConnection(socket)
      const connId = socketToClient.get(socket)
      if (!connId) throw new Error("dispatcher did not register the connected socket")
      const name = clients.get(connId)?.name
      if (!name) throw new Error("dispatcher did not name the connected socket")
      return { connId, name, socket }
    },
    messageSender(id: string): string | null {
      const row = db.prepare("SELECT sender FROM messages WHERE id = ?").get(id) as { sender: string } | null
      return row?.sender ?? null
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
    mailboxAttentionReadAt(name: string): number | null {
      const row = db.prepare("SELECT last_attention_read_at FROM mailbox_cursors WHERE recipient = ?").get(name) as {
        last_attention_read_at: number | null
      } | null
      return row?.last_attention_read_at ?? null
    },
    sessionFilter(name: string): { mode: string; until: number | null; mute: string | null } | undefined {
      const row = db
        .prepare("SELECT filter_mode, filter_until, filter_mute FROM sessions WHERE name = ?")
        .get(name) as { filter_mode: string; filter_until: number | null; filter_mute: string | null } | null
      return row ? { mode: row.filter_mode, until: row.filter_until, mute: row.filter_mute } : undefined
    },
    setSessionFilter(name: string, filter: { mode: string; until: number | null; mute: string | null }): void {
      db.prepare(
        "UPDATE sessions SET filter_mode = $mode, filter_until = $until, filter_mute = $mute WHERE name = $name",
      ).run({ $name: name, $mode: filter.mode, $until: filter.until, $mute: filter.mute })
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

function readSocketLine(socket: NetSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ""
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      const newline = buffer.indexOf("\n")
      if (newline < 0) return
      cleanupListeners()
      resolve(buffer.slice(0, newline))
    }
    const onError = (error: Error) => {
      cleanupListeners()
      reject(error)
    }
    const cleanupListeners = () => {
      socket.off("data", onData)
      socket.off("error", onError)
    }
    socket.on("data", onData)
    socket.on("error", onError)
  })
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

function parseError(line: string): { code: number; message: string; data?: unknown } {
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
    emitClose(hadError = false) {
      for (const handler of handlers.get("close") ?? []) handler(hadError)
    },
    emitError(error: Error) {
      for (const handler of handlers.get("error") ?? []) handler(error)
    },
  }
  return socket as unknown as TestSocket
}

function captureDispatcherLogs(): LogEvent[] {
  const events: LogEvent[] = []
  const previousLogLevel = getLogLevel()
  setLogLevel("debug")
  setSuppressConsole(true)
  const unsubscribe = addWriter({ ns: "tribe:dispatcher" }, (_formatted, _level, _namespace, event) => {
    if (event.kind === "log") events.push(event)
  })
  logCleanups.push(() => {
    unsubscribe()
    setLogLevel(previousLogLevel)
    setSuppressConsole(false)
  })
  return events
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
