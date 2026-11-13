/**
 * 34069 (@cto revise, message adb2b365) — `tribe health` must judge a
 * disconnected row with the SAME reconnect-grace predicate the reap sweep uses,
 * and that predicate must be the one the COMPOSED daemon wires. The regression
 * this pins: health asked the classifier with grace defaulted away, so seats
 * held by their reconnect window were reported as litter the sweep would remove.
 *
 * The harness composes the real `withDispatcher` (real registry, real handler
 * opts builder) and asks through `handleRequest`, so a missing wiring is a test
 * failure here and a compile error at the builder — never a silent `false`.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Server, Socket as NetSocket } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { createScope } from "tribe-wire"
import { TRIBE_PROTOCOL_VERSION, type JsonRpcRequest } from "tribe-wire/lib/socket"
import { createTribeContext } from "../context.ts"
import { openDatabase, createStatements } from "../database.ts"
import { withClientRegistry } from "./with-client-registry.ts"
import { createBaseTribe } from "./base.ts"
import { withDispatcher } from "./with-dispatcher.ts"

type TestSocket = NetSocket & {
  destroyedByDispatcher: boolean
  emitClose(hadError?: boolean): void
  writes: string[]
}

type HealthReport = {
  reconnect_grace_rows: { count: number; names: string[]; meaning: string }
  stale_transport_rows: { count: number; names: string[]; meaning: string }
}

/** `handleRequest` answers in the line protocol: a JSON string, not a live object. */
function parseResponse<T>(response: string | { result?: T; error?: { message: string } }): {
  result: T
  error?: { message: string }
} {
  return typeof response === "string" ? (JSON.parse(response) as { result: T }) : (response as { result: T })
}

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (!cleanup) return
  const dispose = cleanup
  cleanup = null
  await dispose()
})

function createHarness() {
  const tempDir = mkdtempSync(join(tmpdir(), "tribe-health-grace-"))
  const scope = createScope("dispatcher-health-grace-test")
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
  const { registry } = withClientRegistry()(createBaseTribe({ scope }))
  const { socketToClient } = registry

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
      operatorCapability: null,
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
      log() {},
      flushConnection() {},
      discardConnection() {},
      messageTap() {},
    },
    socket: {
      server: createFakeServer(),
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
    connect(): { connId: string; socket: TestSocket } {
      const socket = createTestSocket()
      daemon.dispatcher.handleConnection(socket)
      const connId = socketToClient.get(socket)
      if (!connId) throw new Error("dispatcher did not register the connected socket")
      return { connId, socket }
    },
    register(connId: string, name: string) {
      const req: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: `register-${connId}`,
        method: "register",
        params: {
          name,
          pid: process.pid,
          project: "/repo",
          role: "member",
          projectName: "km-wt9",
          projectId: "test-project",
          delivery: "pull",
          protocolVersion: TRIBE_PROTOCOL_VERSION,
        },
      }
      return daemon.dispatcher.handleRequest(req, connId).then((response) => {
        const parsed = parseResponse<unknown>(response as string)
        if (parsed.error) throw new Error(`register failed: ${parsed.error.message}`)
        return response
      })
    },
    health(connId: string) {
      return daemon.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "health", method: "tribe.health", params: {} },
        connId,
      )
    },
    async dispose() {
      await scope[Symbol.asyncDispose]()
    },
  }
}

/** @failure A seat inside its reconnect window is reported as litter the sweep would remove, or health throws
 *          instead of answering — both make the operator act on a row that is not dead yet.
 * @level l1
 * @consumer `tribe health` readers reconciling a fleet.
 */
describe("tribe health judges a disconnected row with the daemon's own grace predicate (34069)", () => {
  it("reports a grace-held row under reconnect_grace_rows and still answers", async () => {
    const harness = createHarness()
    cleanup = harness.dispose

    const watcher = harness.connect()
    await harness.register(watcher.connId, "@dev/watcher")

    const dropped = harness.connect()
    await harness.register(dropped.connId, "@dev/dropped")
    // The peer goes away: same path a closed socket takes, so its durable row
    // stays behind while the registry starts the reconnect window.
    dropped.socket.emitClose()

    const { result, error } = parseResponse<{ content: Array<{ text: string }> }>(
      (await harness.health(watcher.connId)) as string,
    )
    expect(error).toBeUndefined()
    const report = JSON.parse(result.content[0]!.text) as HealthReport

    expect(report.reconnect_grace_rows.names).toEqual(["@dev/dropped"])
    expect(report.reconnect_grace_rows.count).toBe(1)
    // The measured lie: this row used to be listed here while the sweep kept it.
    expect(report.stale_transport_rows.names).toEqual([])
    expect(report.stale_transport_rows.count).toBe(0)
  })
})

function createTestSocket(): TestSocket {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
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
    on(event: string, handler: (...args: unknown[]) => void) {
      const eventHandlers = handlers.get(event) ?? []
      eventHandlers.push(handler)
      handlers.set(event, eventHandlers)
      return this
    },
    once(event: string, handler: (...args: unknown[]) => void) {
      return this.on(event, handler)
    },
    emitClose(hadError = false) {
      for (const handler of handlers.get("close") ?? []) handler(hadError)
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
