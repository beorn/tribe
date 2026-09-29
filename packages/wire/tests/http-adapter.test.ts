import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createServer, type Server, type Socket } from "node:net"
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { startTribeHttpMcpServer, type TribeHttpMcpServer } from "../src/http-adapter.ts"
import { createLineParser } from "../src/parser.ts"
import { isRequest, makeError, makeResponse } from "../src/rpc.ts"
import { HAB_ID_TOKEN_ENV } from "../src/lib/identity-token.ts"
import { launchToken, writeClaimsVerifier } from "./launch-token.ts"
import { connectToDaemon, TRIBE_PROTOCOL_VERSION } from "../src/lib/socket.ts"
import { tribeAmbientEnvironmentNames } from "../src/daemon-environment.ts"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

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
  opts: { registerError?: { code: number; message: string; data?: unknown }; registerErrorAfter?: number } = {},
): Promise<FakeDaemon> {
  const clients: Socket[] = []
  const requests: FakeDaemon["requests"] = []
  return new Promise((resolveServer) => {
    const server = createServer((socket) => {
      clients.push(socket)
      const parse = createLineParser((message) => {
        if (!isRequest(message)) return
        requests.push(message)
        if (
          message.method === "register" &&
          opts.registerError !== undefined &&
          requests.filter((request) => request.method === "register").length >= (opts.registerErrorAfter ?? 1)
        ) {
          socket.write(
            makeError(message.id, opts.registerError.code, opts.registerError.message, opts.registerError.data),
          )
          return
        }
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
  /**
   * @failure A discovered loopback port lets an unauthenticated caller invoke the seat's daemon tools.
   * @level l2
   * @consumer CTO 2d40fcfc/e92ae0b2: bearer admission, exact Host and identity-free health.
   */
  it("admits MCP tools only with the launch secret and an exact local Host", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribe-http-admission-"))
    const daemon = await spawnFakeDaemon(join(tempDir, "tribe.sock"))
    let bridge: TribeHttpMcpServer | undefined
    try {
      bridge = await startTribeHttpMcpServer({ socketPath: join(tempDir, "tribe.sock"), requireJoin: false })
      const initialRequests = daemon.requests.length
      const invoke = (authorization?: string, host = `127.0.0.1:${bridge!.port}`) =>
        fetch(bridge!.url, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            host,
            ...(authorization === undefined ? {} : { authorization }),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "members", arguments: {} },
          }),
        })
      for (const authorization of [undefined, `Bearer ${"0".repeat(64)}`, "Bearer short", "Basic fixture"]) {
        const response = await invoke(authorization)
        expect(response.status).toBe(401)
        expect(daemon.requests).toHaveLength(initialRequests)
        expect(await response.text()).not.toContain(bridge.secret)
      }
      expect(bridge.secret).toMatch(/^[a-f0-9]{64}$/)
      const health = await fetch(new URL("/health", bridge.url))
      expect(health.status).toBe(200)
      expect(await health.json()).toEqual({ ok: true })
      for (const host of ["attacker.invalid", `127.0.0.1:${bridge.port + 1}`]) {
        expect((await invoke(`Bearer ${bridge.secret}`, host)).status).toBe(403)
        expect(daemon.requests).toHaveLength(initialRequests)
      }
      for (const host of [`127.0.0.1:${bridge.port}`, `localhost:${bridge.port}`]) {
        const response = await invoke(`Bearer ${bridge.secret}`, host)
        expect(response.status).toBe(200)
        const payload = (await response.json()) as { result?: { isError?: boolean }; error?: unknown }
        expect(payload.error).toBeUndefined()
        expect(payload.result?.isError).not.toBe(true)
      }
      expect(daemon.requests).toHaveLength(initialRequests + 2)
    } finally {
      bridge?.close()
      for (const client of daemon.clients) client.destroy()
      await new Promise<void>((resolve) => daemon.server.close(() => resolve()))
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  /**
   * @failure HTTP tools advertise the current protocol but lose managed authority or persisted rename on reconnect.
   * @level l3
   * @consumer CTO 9c5bc9de: registration, one real tool call and reconnect must agree against the current daemon.
   */
  it("current daemon preserves verified HTTP identity and rename through reconnect", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribe-http-protocol-"))
    const socketPath = join(tempDir, "tribe.sock")
    const verifierPath = join(tempDir, "claims-verifier.ts")
    writeClaimsVerifier(verifierPath)
    const validToken = launchToken("http-protocol", "@codi/hermes")
    vi.stubEnv(HAB_ID_TOKEN_ENV, validToken)
    const childEnv = { ...process.env }
    for (const name of tribeAmbientEnvironmentNames()) delete childEnv[name]
    childEnv.TRIBE_NO_PLUGINS = "1"
    childEnv.XDG_STATE_HOME = tempDir
    childEnv.XDG_CONFIG_HOME = tempDir
    childEnv.XDG_DATA_HOME = tempDir
    childEnv.TRIBE_ACTIVITY_LOG = join(tempDir, "activity.jsonl")
    childEnv.TRIBE_DAEMON_STDERR_LOG = join(tempDir, "daemon-stderr.log")
    const startDaemon = async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dirname, "../../daemon/src/daemon.ts"),
          "--socket",
          socketPath,
          "--db",
          join(tempDir, "tribe.db"),
          "--foreground",
          "--no-lore",
          "--identity-verifier",
          verifierPath,
        ],
        { cwd: tempDir, env: childEnv, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
      )
      const stderr = new Response(child.stderr).text()
      let lastError: unknown
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (child.exitCode !== null) throw new Error(`isolated HTTP daemon exited ${child.exitCode}: ${await stderr}`)
        try {
          const probe = await connectToDaemon(socketPath)
          probe.close()
          return { child, stderr }
        } catch (error) {
          lastError = error
          await new Promise<void>((resolve) => setTimeout(resolve, 25))
        }
      }
      child.kill()
      await child.exited
      throw new Error(`isolated HTTP daemon did not open ${socketPath}: ${String(lastError)}; ${await stderr}`)
    }
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
    let bridge: TribeHttpMcpServer | undefined
    try {
      daemon = await startDaemon()
      bridge = await startTribeHttpMcpServer({ socketPath, name: "@codi/hermes", pullTransport: "host-stream" })
      const tool = async (name: string, args: Record<string, unknown> = {}) => {
        if (bridge === undefined) throw new Error("HTTP journey has no bridge")
        const response = await fetch(bridge.url, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            authorization: `Bearer ${bridge.secret}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        })
        expect(response.status).toBe(200)
        const payload = (await response.json()) as {
          result?: { content?: Array<{ text?: string }>; isError?: boolean }
          error?: unknown
        }
        expect(payload.error).toBeUndefined()
        expect(payload.result?.isError).not.toBe(true)
        const resultText = payload.result?.content?.[0]?.text
        if (resultText === undefined) throw new Error(`HTTP ${name} returned no text: ${JSON.stringify(payload)}`)
        if (resultText.startsWith("Error:")) throw new Error(`HTTP ${name}: ${resultText}`)
        return JSON.parse(resultText) as {
          sessions?: Array<Record<string, unknown>>
          name?: string
        }
      }
      const initial = (await tool("members")).sessions?.find((row) => row.name === "@codi/hermes")
      expect(initial).toMatchObject({
        authority: "verified",
        launch_id: "http-protocol@1",
        version_state: "current",
        protocol_versions: [TRIBE_PROTOCOL_VERSION],
      })
      // 26524: this actual verifier daemon must refuse a tokenless named HTTP launch before an HTTP listener exists.
      vi.stubEnv(HAB_ID_TOKEN_ENV, "")
      const originalServe = Bun.serve
      let tokenlessListenerStarts = 0
      try {
        const countedServe = ((options: Parameters<typeof Bun.serve>[0]) => {
          tokenlessListenerStarts += 1
          return originalServe(options)
        }) as typeof Bun.serve
        if (!Reflect.set(Bun, "serve", countedServe)) throw new Error("could not count Bun.serve calls")
        const refused = await startTribeHttpMcpServer({ socketPath, name: "@codi/mac" }).then(
          (server) => {
            server.close()
            return null
          },
          (error: unknown) => error,
        )
        expect(refused).toBeInstanceOf(Error)
        expect(String(refused)).toContain("@codi/mac")
        expect(String(refused)).toContain("HAB_ID_TOKEN")
        expect(tokenlessListenerStarts).toBe(0)
        await vi.waitFor(() => {
          const db = new Database(join(tempDir, "tribe.db"), { readonly: true })
          try {
            const health = db
              .prepare("SELECT recipient, content FROM messages WHERE type = 'health:identity-token-missing'")
              .all() as Array<{ recipient: string; content: string }>
            expect(health).toHaveLength(1)
            expect(health[0]).toMatchObject({ recipient: "*", content: expect.stringContaining("@codi/mac") })
            expect(health[0]?.content).toContain("launch through hab")
          } finally {
            db.close()
          }
        })
      } finally {
        if (!Reflect.set(Bun, "serve", originalServe)) throw new Error("could not restore Bun.serve")
        vi.stubEnv(HAB_ID_TOKEN_ENV, validToken)
      }
      await tool("rename", { new_name: "@codi/renamed" })
      daemon.child.kill("SIGTERM")
      await daemon.child.exited
      await daemon.stderr
      daemon = await startDaemon()
      await vi.waitFor(
        async () => {
          const renamed = (await tool("members")).sessions?.find((row) => row.name === "@codi/renamed")
          expect(renamed).toMatchObject({
            authority: "verified",
            launch_id: "http-protocol@1",
            version_state: "current",
          })
        },
        { timeout: 5_000 },
      )
    } finally {
      bridge?.close()
      if (daemon !== undefined) {
        daemon.child.kill("SIGTERM")
        await daemon.child.exited
        await daemon.stderr
      }
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("disables Bun's request timeout while forwarding the public HTTP MCP wait contract", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribe-http-adapter-wait-"))
    const socketPath = join(tempDir, "tribe.sock")
    const daemon = await spawnFakeDaemon(socketPath, async (request) => {
      if (request.method !== "tribe.inbox.wait") return { name: "@agent/http", role: "member" }
      return {
        status: "timeout",
        session: "@agent/http",
        unread_count: 0,
        oldest_unread_age_min: 0,
        oldest_unread_ts: 0,
        waited_ms: 7,
        effective_timeout_ms: 5_000,
        timed_out: true,
        aborted: false,
        attention: {
          actionable_unread: [],
          pending_balls: [],
          pending_balls_summary: { total: 0, oldest_age_ms: 0, truncated: false },
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
      bridge = await startTribeHttpMcpServer({ socketPath, name: "codex", requireJoin: false })
      if (!Reflect.set(Bun, "serve", originalServe)) {
        throw new Error("could not restore Bun.serve after HTTP adapter test")
      }
      if (!handleFetch) throw new Error("HTTP adapter did not register a fetch handler")
      const request = new Request(bridge.url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          authorization: `Bearer ${bridge.secret}`,
          host: `127.0.0.1:${bridge.port}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "inbox.wait",
            arguments: {
              timeout_ms: 5_000,
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
      expect(result.effective_timeout_ms).toBe(5_000)
      expect(payload.result?.structuredContent).toMatchObject(result)
      expect(daemon.requests.find((request) => request.method === "tribe.inbox.wait")?.params).toEqual({
        timeout_ms: 5_000,
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

  /**
   * @failure Named SSH tools register without the signed launch identity and cannot read their managed mailbox.
   * @level l1
   * @consumer 25886 / WA-R7: the HTTP adapter presents the same named identity contract as stdio.
   */
  it.each([
    { kind: "named", name: "@codi/hermes", token: launchToken("http-launch", "@codi/hermes") },
    { kind: "unnamed", name: undefined, token: launchToken("http-launch", "@codi/hermes") },
    { kind: "malformed", name: "@codi/hermes", token: "malformed-fixture" },
    { kind: "absent", name: "@codi/hermes", token: "" },
  ])("$kind launch presents only its permitted identity and names missing proof", async ({ kind, name, token }) => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribe-http-identity-"))
    const daemon = await spawnFakeDaemon(join(tempDir, "tribe.sock"))
    vi.stubEnv(HAB_ID_TOKEN_ENV, token)
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    let bridge: TribeHttpMcpServer | undefined
    try {
      // Default requireJoin must not postpone an explicitly named persona's FIRST registration.
      bridge = await startTribeHttpMcpServer({ socketPath: join(tempDir, "tribe.sock"), name })
      const registration = daemon.requests.find((request) => request.method === "register")?.params
      expect(registration).toBeDefined()
      if (name) expect(registration).toHaveProperty("name", name)
      if (kind === "named") {
        expect(registration).toMatchObject({
          idToken: token,
          launchId: "http-launch::%40codi%2Fhermes",
          launchParentPid: process.pid,
        })
      } else if (kind === "malformed") {
        expect(registration).toHaveProperty("idToken", token)
        expect(registration).not.toHaveProperty("launchId")
        expect(stderr.mock.calls.map(([text]) => String(text)).join("")).toContain("HAB_ID_TOKEN is malformed")
      } else {
        expect(registration).not.toHaveProperty("idToken")
        expect(registration).not.toHaveProperty("launchId")
        expect(registration).not.toHaveProperty("launchParentPid")
        if (kind === "absent") {
          expect(stderr.mock.calls.map(([text]) => String(text)).join("")).toContain(
            "persona without launch token: a managed daemon will refuse",
          )
        }
      }
    } finally {
      bridge?.close()
      for (const client of daemon.clients) client.destroy()
      await new Promise<void>((resolve) => daemon.server.close(() => resolve()))
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  /** @failure A published launchId option is accepted while identity actually comes from another source.
   * @level l1
   * @consumer CTO 9c5bc9de: one transitional release refuses the published legacy option with its real cure.
   */
  it("refuses the published legacy launchId option instead of silently ignoring it", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribe-http-old-option-"))
    const daemon = await spawnFakeDaemon(join(tempDir, "tribe.sock"))
    const attempt = startTribeHttpMcpServer({ socketPath: join(tempDir, "tribe.sock"), launchId: "legacy-launch" })
    try {
      await expect(attempt).rejects.toThrow(/launchId.*remove.*launch token/s)
    } finally {
      ;(await attempt.catch(() => undefined))?.close()
      for (const client of daemon.clients) client.destroy()
      await new Promise<void>((resolve) => daemon.server.close(() => resolve()))
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("re-registers the resolved member name after a daemon reconnect", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribe-http-adapter-reconnect-"))
    const socketPath = join(tempDir, "tribe.sock")
    const daemon = await spawnFakeDaemon(socketPath)
    vi.stubEnv(HAB_ID_TOKEN_ENV, launchToken("inherited-parent", "@codi/hermes"))
    let bridge: TribeHttpMcpServer | undefined
    try {
      bridge = await startTribeHttpMcpServer({
        socketPath,
        name: "codex",
        requireJoin: true,
      })
      const first = daemon.requests.find((request) => request.method === "register")
      expect(first?.params).not.toHaveProperty("name")

      daemon.disconnectClients()
      await waitForRegistrationCount(daemon, 2)
      const registrations = daemon.requests.filter((request) => request.method === "register")
      expect(registrations[1]?.params).toMatchObject({ name: "@agent/http" })
      expect(registrations[1]?.params).not.toHaveProperty("idToken")
      expect(registrations[1]?.params).not.toHaveProperty("launchId")
    } finally {
      bridge?.close()
      for (const client of daemon.clients) client.destroy()
      await new Promise<void>((resolve) => daemon.server.close(() => resolve()))
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  /**
   * @failure A refused re-register leaves a named HTTP listener alive while the client retries the same refusal.
   * @level l1
   * @consumer 26524: a managed identity refusal ends service on reconnect.
   */
  it("closes the HTTP listener after a missing-token refusal on reconnect", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tribe-http-refused-reconnect-"))
    const socketPath = join(tempDir, "tribe.sock")
    const daemon = await spawnFakeDaemon(socketPath, undefined, {
      registerErrorAfter: 2,
      registerError: {
        code: -32003,
        message:
          "register refused: explicit persona @codi/hermes has a missing HAB_ID_TOKEN; launch through hab or join without a persona name",
        data: { kind: "identity-token-missing" },
      },
    })
    vi.stubEnv(HAB_ID_TOKEN_ENV, launchToken("http-reconnect", "@codi/hermes"))
    const originalServe = Bun.serve
    const stop = vi.fn()
    const refusalLines: string[] = []
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      refusalLines.push(String(chunk))
      return true
    })
    let bridge: TribeHttpMcpServer | undefined
    try {
      const fakeServe = (() => ({ port: 41_731, stop })) as unknown as typeof Bun.serve
      if (!Reflect.set(Bun, "serve", fakeServe)) throw new Error("could not replace Bun.serve for reconnect test")
      bridge = await startTribeHttpMcpServer({ socketPath, name: "@codi/hermes" })
      daemon.disconnectClients()
      await waitForRegistrationCount(daemon, 2)
      await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1), { timeout: 2_000 })
      expect(daemon.requests.filter((request) => request.method === "register")).toHaveLength(2)
      expect(refusalLines.join("")).toContain("register refused: explicit persona @codi/hermes")
    } finally {
      stderr.mockRestore()
      if (!Reflect.set(Bun, "serve", originalServe)) throw new Error("could not restore Bun.serve")
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
