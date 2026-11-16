/**
 * @failure  a Hab service actor registers through the stdio adapter without the certified service shape — no
 *           principalClass, a foreign launch key, or a keyed pid that is not its own — so the daemon's service
 *           lifetime, reconnect latch, and ball ownership attach to an identity nobody certified.
 * @level    l1
 * @consumer @i/6-dev/30968 (@cto delta GO: repair the existing stdio adapter's service registration)
 *
 * Fake-daemon wire contract for the adapter's service registration: the register carries principalClass
 * service, the exact token actor, this process as pid and launchParentPid, and pull delivery; hostile ACKs
 * (downgraded class, foreign pid, foreign or generation-shifted launch key) never yield a usable adapter.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createServer, type Server, type Socket } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { createLineParser } from "../src/parser.ts"
import { isRequest, makeResponse } from "../src/rpc.ts"
import { launchToken } from "./launch-token.ts"

const ADAPTER = resolve(dirname(fileURLToPath(import.meta.url)), "../src/stdio-adapter.ts")
const BUN_BIN = process.versions.bun ? process.execPath : "bun"

type RegisterParams = Record<string, unknown>

function fakeDaemon(
  socketPath: string,
  registers: RegisterParams[],
  opts: {
    principalClass?: string
    launchId?: string
    launchParentPid?: number
    /** Per-register launch keys (index by register count); closes the socket after each register reply. */
    launchIdSequence?: string[]
  } = {},
): Promise<Server> {
  return new Promise((resolveServer) => {
    const server = createServer((socket: Socket) => {
      const reply = (payload: string) => {
        if (!socket.destroyed && !socket.writableEnded) socket.write(payload)
      }
      const parse = createLineParser((msg) => {
        if (!isRequest(msg)) return
        const params = (msg.params ?? {}) as RegisterParams
        if (msg.method === "register") {
          registers.push(params)
          const sequenceKey = opts.launchIdSequence?.[registers.length - 1]
          reply(
            makeResponse(msg.id, {
              sessionId: "daemon-svc-1",
              name: params.name,
              role: "member",
              chief: "",
              protocolVersion: 11,
              principalClass: opts.principalClass ?? params.principalClass,
              launchId: sequenceKey ?? opts.launchId ?? params.launchId,
              launchParentPid: opts.launchParentPid ?? params.launchParentPid,
              transportDelivery: params.delivery,
              delivery: params.delivery,
            }),
          )
          if (opts.launchIdSequence !== undefined) socket.end()
          return
        }
        if (msg.method === "tribe.members") {
          reply(makeResponse(msg.id, { content: [{ type: "text", text: JSON.stringify({ sessions: [] }) }] }))
          return
        }
        reply(makeResponse(msg.id, { ok: true }))
      })
      socket.on("data", (chunk: Buffer) => parse(chunk))
    })
    server.listen(socketPath, () => resolveServer(server))
  })
}

describe("stdio adapter service registration (30968)", () => {
  let dir = ""
  let server: Server | undefined
  let child: ChildProcessWithoutNullStreams | undefined

  afterEach(async () => {
    child?.kill("SIGKILL")
    child = undefined
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    server = undefined
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ""
  })

  it("a Hab service actor registers through the certified service path: principalClass service, own pid, pull delivery", async () => {
    dir = mkdtempSync(join(tmpdir(), "tribe-svc-adapter-"))
    const socketPath = join(dir, "daemon.sock")
    const registers: RegisterParams[] = []
    server = await fakeDaemon(socketPath, registers)
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "grok-30968"], {
      cwd: dir,
      env: {
        ...process.env,
        HAB_ID_TOKEN: launchToken("svc-launch-1", "grok-30968", "service"),
        TRIBE_REQUIRE_JOIN: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "svc-test", version: "0" },
        },
      })}\n`,
    )
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`)
    const deadline = Date.now() + 15_000
    while (registers.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    expect(registers.length).toBeGreaterThan(0)
    const reg = registers[0]!
    expect(reg.principalClass).toBe("service")
    expect(reg.name).toBe("grok-30968")
    expect(reg.pid).toBe(child.pid)
    expect(reg.launchParentPid).toBe(child.pid)
    expect(reg.delivery).toBe("pull")
    expect(existsSync(socketPath)).toBe(true)
  }, 20_000)

  it.each([
    ["downgrades the registration to a non-service principal", { principalClass: "agent" }],
    ["keys the launch under another process", { launchParentPid: 999_999 }],
    ["returns a foreign launch key", { launchId: "someone-else@9" }],
  ] as const)(
    "refuses a daemon that %s",
    async (_label, ack) => {
      dir = mkdtempSync(join(tmpdir(), "tribe-svc-adapter-"))
      const socketPath = join(dir, "daemon.sock")
      const registers: RegisterParams[] = []
      server = await fakeDaemon(socketPath, registers, ack)
      child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "grok-30968"], {
        cwd: dir,
        env: {
          ...process.env,
          HAB_ID_TOKEN: launchToken("svc-launch-1", "grok-30968", "service"),
          TRIBE_REQUIRE_JOIN: "0",
        },
        stdio: ["pipe", "pipe", "pipe"],
      })
      let stdoutText = ""
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutText += chunk.toString()
      })
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "svc-test", version: "0" },
          },
        })}\n`,
      )
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`)
      const deadline = Date.now() + 15_000
      while (registers.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      expect(registers.length).toBeGreaterThan(0)
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "members", arguments: {} },
        })}\n`,
      )
      // The adapter must never present a downgraded registration as usable: the
      // members call gets no successful answer while certification keeps
      // refusing the registration (bounded 5s observation window).
      await new Promise((r) => setTimeout(r, 5_000))
      const responseLine = stdoutText.split("\n").find((line) => line.includes('"id":2'))
      expect(responseLine).toBeUndefined()
      expect(registers.length).toBeGreaterThan(0)
    },
    20_000,
  )

  it("latches the certified launch key across reconnects: a shifted generation is refused", async () => {
    dir = mkdtempSync(join(tmpdir(), "tribe-svc-adapter-"))
    const socketPath = join(dir, "daemon.sock")
    const registers: RegisterParams[] = []
    // Register 1 certifies the claimed derived key; register 2 presents a
    // shifted generation (`@2`, while the token's gen is 1) instead of the
    // token's exact verified instance and must never certify.
    server = await fakeDaemon(socketPath, registers, {
      launchIdSequence: ["svc-launch-1::grok-30968", "svc-launch-1@2"],
    })
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "grok-30968"], {
      cwd: dir,
      env: {
        ...process.env,
        HAB_ID_TOKEN: launchToken("svc-launch-1", "grok-30968", "service"),
        TRIBE_REQUIRE_JOIN: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdoutText = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutText += chunk.toString()
    })
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "svc-test", version: "0" },
        },
      })}\n`,
    )
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`)
    const deadline = Date.now() + 25_000
    while (registers.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    expect(registers.length).toBeGreaterThanOrEqual(2)
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "members", arguments: {} },
      })}\n`,
    )
    await new Promise((r) => setTimeout(r, 3_000))
    // No successful members answer: the shifted generation never certifies,
    // so the call answers as an error (or not at all), never with sessions.
    const responseLine = stdoutText.split("\n").find((line) => line.includes('"id":2'))
    if (responseLine !== undefined) {
      const response = JSON.parse(responseLine) as { result?: { isError?: boolean; content?: unknown } }
      expect(response.result?.isError).toBe(true)
      expect(JSON.stringify(response.result?.content ?? "")).not.toContain("sessions")
    }
  }, 30_000)
})
