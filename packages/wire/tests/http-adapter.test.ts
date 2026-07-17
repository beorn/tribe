import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type Server, type Socket } from "node:net"
import { describe, expect, it } from "vitest"
import { startTribeHttpMcpServer, type TribeHttpMcpServer } from "../src/http-adapter.ts"
import { createLineParser } from "../src/parser.ts"
import { isRequest, makeResponse } from "../src/rpc.ts"

type FakeDaemon = {
  readonly server: Server
  readonly clients: Socket[]
  readonly requests: Array<{ method?: string; params?: Record<string, unknown> }>
  disconnectClients(): void
}

function spawnFakeDaemon(socketPath: string): Promise<FakeDaemon> {
  const clients: Socket[] = []
  const requests: FakeDaemon["requests"] = []
  return new Promise((resolveServer) => {
    const server = createServer((socket) => {
      clients.push(socket)
      const parse = createLineParser((message) => {
        if (!isRequest(message)) return
        requests.push(message)
        socket.write(makeResponse(message.id, { name: "@agent/http", role: "member" }))
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
