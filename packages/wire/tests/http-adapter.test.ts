import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type Server, type Socket } from "node:net"
import { describe, expect, it, vi } from "vitest"
import { startTribeHttpMcpServer, type TribeHttpMcpServer } from "../src/http-adapter.ts"
import { createLineParser } from "../src/parser.ts"
import { isRequest, makeResponse } from "../src/rpc.ts"

type HttpFetch = (
  request: Request,
  server: { timeout(request: Request, seconds: number): void },
) => Response | Promise<Response>

type FakeDaemon = {
  readonly server: Server
  readonly clients: Socket[]
  readonly requests: Array<{ method?: string; params?: Record<string, unknown> }>
  disconnectClients(): void
}

function spawnFakeDaemon(
  socketPath: string,
  respond: (request: FakeDaemon["requests"][number]) => unknown | Promise<unknown> = () => ({
    name: "@agent/http",
    role: "member",
  }),
): Promise<FakeDaemon> {
  const clients: Socket[] = []
  const requests: FakeDaemon["requests"] = []
  return new Promise((resolveServer) => {
    const server = createServer((socket) => {
      clients.push(socket)
      const parse = createLineParser((message) => {
        if (!isRequest(message)) return
        requests.push(message)
        void Promise.resolve(respond(message)).then((result) => {
          if (!socket.destroyed) socket.write(makeResponse(message.id, result))
        })
      })
      socket.on("data", parse)
      socket.on("error", () => undefined)
    })
    server.listen(socketPath, () =>
      resolveServer({
        server,
        clients,
        requests,
        disconnectClients() {
          for (const client of clients.splice(0)) client.destroy()
        },
      }),
    )
  })
}

async function waitForRegistrationCount(daemon: FakeDaemon, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (daemon.requests.filter((request) => request.method === "register").length >= count) return
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${count} HTTP adapter registrations`)
}

describe("HTTP MCP adapter", () => {
  it("disables Bun's request timeout while forwarding the public HTTP MCP wait contract", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribe-http-adapter-wait-"))
    const socketPath = join(tempDir, "tribe.sock")
    const daemon = await spawnFakeDaemon(socketPath, async (request) => {
      if (request.method !== "tribe.inbox.wait") return { name: "@agent/http", role: "member" }
      return {
        session: "@agent/http",
        unread_count: 0,
        oldest_unread_age_min: 0,
        oldest_unread_ts: 0,
        waited_ms: 7,
        effective_timeout_ms: 30 * 60_000,
        timed_out: true,
        aborted: false,
        attention: {
          actionable_unread: [],
          pending_balls: [],
          pending_balls_summary: { total: 0, oldest_age_ms: 0 },
        },
      }
    })
    let bridge: TribeHttpMcpServer | undefined
    let handleFetch: HttpFetch | undefined
    const timeout = vi.fn()
    const stop = vi.fn()
    const originalServe = Bun.serve
    try {
      const fakeServe = ((options: { fetch: HttpFetch }) => {
        handleFetch = options.fetch
        return { port: 41_729, stop }
      }) as unknown as typeof Bun.serve
      if (!Reflect.set(Bun, "serve", fakeServe)) throw new Error("could not replace Bun.serve for HTTP adapter test")
      bridge = await startTribeHttpMcpServer({ socketPath, name: "@agent/http", requireJoin: false })
      if (!Reflect.set(Bun, "serve", originalServe))
        throw new Error("could not restore Bun.serve after HTTP adapter test")
      if (!handleFetch) throw new Error("HTTP adapter did not register a fetch handler")
      const request = new Request(bridge.url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "inbox.wait",
            arguments: {
              timeout_ms: 24 * 60 * 60_000,
              wake_on_correlated_reply: true,
            },
          },
        }),
      })
      const response = await handleFetch(request, { timeout })
      const payload = (await response.json()) as {
        result?: { content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown> }
      }
      const result = JSON.parse(payload.result?.content?.[0]?.text ?? "{}") as {
        effective_timeout_ms?: number
      }

      expect(response.status).toBe(200)
      expect(timeout).toHaveBeenCalledWith(request, 0)
      expect(result.effective_timeout_ms).toBe(30 * 60_000)
      expect(payload.result?.structuredContent).toMatchObject(result)
      expect(daemon.requests.find((request) => request.method === "tribe.inbox.wait")?.params).toEqual({
        timeout_ms: 30 * 60_000,
        wake_on_correlated_reply: true,
      })
    } finally {
      Reflect.set(Bun, "serve", originalServe)
      bridge?.close()
      for (const client of daemon.clients) client.destroy()
      await new Promise<void>((resolve) => daemon.server.close(() => resolve()))
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("declares the launch notification filter during registration", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribe-http-adapter-filter-"))
    const socketPath = join(tempDir, "tribe.sock")
    const daemon = await spawnFakeDaemon(socketPath)
    const previousFilterMode = process.env.TRIBE_FILTER_MODE
    let bridge: TribeHttpMcpServer | undefined
    try {
      process.env.TRIBE_FILTER_MODE = "focus"
      bridge = await startTribeHttpMcpServer({ socketPath })
      const register = daemon.requests.find((request) => request.method === "register")
      expect(register?.params).toMatchObject({ filterMode: "focus" })
    } finally {
      if (previousFilterMode === undefined) delete process.env.TRIBE_FILTER_MODE
      else process.env.TRIBE_FILTER_MODE = previousFilterMode
      bridge?.close()
      for (const client of daemon.clients) client.destroy()
      await new Promise<void>((resolve) => daemon.server.close(() => resolve()))
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("registers the launcher identity used to join its roster row", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribe-http-adapter-"))
    const socketPath = join(tempDir, "tribe.sock")
    const daemon = await spawnFakeDaemon(socketPath)
    let bridge: TribeHttpMcpServer | undefined
    try {
      bridge = await startTribeHttpMcpServer({ socketPath, launchId: "  launch-current-app  " })
      const register = daemon.requests.find((request) => request.method === "register")
      expect(register?.params).toMatchObject({
        launchId: "launch-current-app",
        launchParentPid: process.pid,
      })
    } finally {
      bridge?.close()
      for (const client of daemon.clients) client.destroy()
      await new Promise<void>((resolve) => daemon.server.close(() => resolve()))
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("re-registers the resolved member name after a daemon reconnect", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribe-http-adapter-reconnect-"))
    const socketPath = join(tempDir, "tribe.sock")
    const daemon = await spawnFakeDaemon(socketPath)
    let bridge: TribeHttpMcpServer | undefined
    try {
      bridge = await startTribeHttpMcpServer({
        socketPath,
        name: "codex",
        requireJoin: true,
        launchId: "launch-current-app",
      })
      const first = daemon.requests.find((request) => request.method === "register")
      expect(first?.params).not.toHaveProperty("name")

      daemon.disconnectClients()
      await waitForRegistrationCount(daemon, 2)
      const registrations = daemon.requests.filter((request) => request.method === "register")
      expect(registrations[1]?.params).toMatchObject({ name: "@agent/http" })
    } finally {
      bridge?.close()
      for (const client of daemon.clients) client.destroy()
      await new Promise<void>((resolve) => daemon.server.close(() => resolve()))
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("omits both launch fields when the caller supplies no usable identity", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribe-http-adapter-legacy-"))
    const socketPath = join(tempDir, "tribe.sock")
    const daemon = await spawnFakeDaemon(socketPath)
    const bridges: TribeHttpMcpServer[] = []
    try {
      bridges.push(await startTribeHttpMcpServer({ socketPath }))
      bridges.push(await startTribeHttpMcpServer({ socketPath, launchId: "   " }))
      const registrations = daemon.requests.filter((request) => request.method === "register")
      expect(registrations).toHaveLength(2)
      for (const registration of registrations) {
        expect(registration.params).not.toHaveProperty("launchId")
        expect(registration.params).not.toHaveProperty("launchParentPid")
      }
    } finally {
      for (const bridge of bridges) bridge.close()
      for (const client of daemon.clients) client.destroy()
      await new Promise<void>((resolve) => daemon.server.close(() => resolve()))
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
