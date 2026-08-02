/**
 * Version-skew recovery: a deterministic protocol mismatch is reported and
 * allowed to use the adapter's existing degraded/reconnect machinery instead
 * of terminating the transport before that machinery can run.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createServer, type Server, type Socket } from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createLineParser } from "../src/parser.ts"
import { isRequest, makeError, makeResponse } from "../src/rpc.ts"
import {
  protocolVersionAdvertisement,
  protocolVersionsFromMismatch,
  reconnectRegistrationJitterMs,
  TRIBE_PROTOCOL_VERSION,
} from "../src/lib/socket.ts"

const PLUGIN_SERVER = resolve(dirname(fileURLToPath(import.meta.url)), "../../../plugins/claude/server.ts")
const STDIO_ADAPTER = resolve(dirname(fileURLToPath(import.meta.url)), "../src/stdio-adapter.ts")
const BUN_BIN = process.versions.bun ? process.execPath : "bun"
const STANDALONE_PLUGIN_ENV = {
  TRIBE_LAUNCH_ID: "",
  TRIBE_PLUGIN_ADAPTER_CHILD: "",
  TRIBE_PLUGIN_PROVIDER_PARENT_PID: "",
}

function spawnSkewedDaemon(socketPath: string): Promise<{ server: Server; clients: Socket[] }> {
  const clients: Socket[] = []
  return new Promise((resolveServer) => {
    const server = createServer((socket) => {
      clients.push(socket)
      const parse = createLineParser((msg) => {
        if (!isRequest(msg)) return
        if (msg.method === "register") {
          socket.write(
            makeResponse(msg.id, {
              sessionId: "skew-s1",
              name: "skew-test",
              role: "member",
              chief: "",
              protocolVersion: 999_999,
            }),
          )
          return
        }
        if (msg.method === "tribe.members") {
          socket.write(makeResponse(msg.id, { content: [{ type: "text", text: JSON.stringify({ sessions: [] }) }] }))
          return
        }
        socket.write(makeResponse(msg.id, { ok: true }))
      })
      socket.on("data", parse)
      socket.on("error", () => {
        /* test teardown */
      })
    })
    server.listen(socketPath, () => resolveServer({ server, clients }))
  })
}

function spawnGenerationDaemon(socketPath: string): Promise<{
  server: Server
  clients: Socket[]
  registrations: number[]
  setPid(pid: number): void
}> {
  const clients: Socket[] = []
  const registrations: number[] = []
  let daemonPid = 1001
  return new Promise((resolveServer) => {
    const server = createServer((socket) => {
      clients.push(socket)
      const parse = createLineParser((msg) => {
        if (!isRequest(msg)) return
        if (msg.method === "register") {
          registrations.push(daemonPid)
          socket.write(
            makeResponse(msg.id, {
              sessionId: `generation-${daemonPid}`,
              name: "generation-test",
              role: "member",
              chief: "",
              protocolVersion: TRIBE_PROTOCOL_VERSION,
              daemon: { pid: daemonPid, uptime: 0 },
            }),
          )
          return
        }
        if (msg.method === "tribe.members") {
          socket.write(makeResponse(msg.id, { content: [{ type: "text", text: JSON.stringify({ sessions: [] }) }] }))
          return
        }
        socket.write(makeResponse(msg.id, { ok: true }))
      })
      socket.on("data", parse)
      socket.on("error", () => {
        /* test teardown */
      })
    })
    server.listen(socketPath, () =>
      resolveServer({
        server,
        clients,
        registrations,
        setPid(pid: number) {
          daemonPid = pid
        },
      }),
    )
  })
}

function spawnCompatibleDaemon(socketPath: string): Promise<{
  server: Server
  clients: Socket[]
  registrations: Array<{ protocolVersion?: unknown; supportedProtocolVersions?: unknown }>
}> {
  const clients: Socket[] = []
  const registrations: Array<{ protocolVersion?: unknown; supportedProtocolVersions?: unknown }> = []
  return new Promise((resolveServer) => {
    const server = createServer((socket) => {
      clients.push(socket)
      const parse = createLineParser((msg) => {
        if (!isRequest(msg)) return
        if (msg.method === "register") {
          registrations.push(msg.params ?? {})
          const params = msg.params as {
            protocolVersion?: unknown
            supportedProtocolVersions?: unknown
          }
          if (
            params.protocolVersion !== TRIBE_PROTOCOL_VERSION - 1 ||
            JSON.stringify(params.supportedProtocolVersions) !==
              JSON.stringify([TRIBE_PROTOCOL_VERSION, TRIBE_PROTOCOL_VERSION - 1])
          ) {
            socket.write(
              makeError(
                msg.id,
                -32006,
                `Protocol version mismatch: client=${String(params.protocolVersion)}; daemon=${TRIBE_PROTOCOL_VERSION - 1}; supported=${TRIBE_PROTOCOL_VERSION - 1}. Advance the Tribe daemon to v${TRIBE_PROTOCOL_VERSION - 1} or newer, then reconnect.`,
              ),
            )
            return
          }
          socket.write(
            makeResponse(msg.id, {
              sessionId: "compatible-s1",
              name: "compatible-test",
              role: "member",
              chief: "",
              protocolVersion: TRIBE_PROTOCOL_VERSION - 1,
              daemon: { pid: 3003, uptime: 0 },
            }),
          )
          return
        }
        if (msg.method === "tribe.members") {
          socket.write(makeResponse(msg.id, { content: [{ type: "text", text: JSON.stringify({ sessions: [] }) }] }))
          return
        }
        socket.write(makeResponse(msg.id, { ok: true }))
      })
      socket.on("data", parse)
      socket.on("error", () => {
        /* test teardown */
      })
    })
    server.listen(socketPath, () => resolveServer({ server, clients, registrations }))
  })
}

function spawnExtendedReconnectDaemon(socketPath: string): Promise<{
  server: Server
  clients: Socket[]
  registrations: number
}> {
  const clients: Socket[] = []
  let registrations = 0
  return new Promise((resolveServer) => {
    const server = createServer((socket) => {
      clients.push(socket)
      const parse = createLineParser((msg) => {
        if (!isRequest(msg)) return
        if (msg.method === "register") {
          registrations += 1
          if (registrations >= 2 && registrations <= 4) {
            socket.write(makeError(msg.id, -32000, "daemon reload is still settling"))
            return
          }
          socket.write(
            makeResponse(msg.id, {
              sessionId: `reconnect-s${registrations}`,
              name: "reconnect-test",
              role: "member",
              chief: "",
              protocolVersion: TRIBE_PROTOCOL_VERSION,
              daemon: { pid: 4004, uptime: 0 },
            }),
          )
          if (registrations === 1) setTimeout(() => socket.destroy(), 25)
          return
        }
        if (msg.method === "tribe.members") {
          socket.write(makeResponse(msg.id, { content: [{ type: "text", text: JSON.stringify({ sessions: [] }) }] }))
          return
        }
        socket.write(makeResponse(msg.id, { ok: true }))
      })
      socket.on("data", parse)
      socket.on("error", () => {
        /* test teardown */
      })
    })
    server.listen(socketPath, () =>
      resolveServer({
        server,
        clients,
        get registrations() {
          return registrations
        },
      }),
    )
  })
}

function spawnClampDaemon(socketPath: string): Promise<{
  server: Server
  clients: Socket[]
  registrations: number[]
}> {
  const clients: Socket[] = []
  const registrations: number[] = []
  return new Promise((resolveServer) => {
    const server = createServer((socket) => {
      clients.push(socket)
      const parse = createLineParser((msg) => {
        if (!isRequest(msg)) return
        if (msg.method === "register") {
          const protocolVersion = (msg.params as { protocolVersion?: unknown } | undefined)?.protocolVersion
          registrations.push(typeof protocolVersion === "number" ? protocolVersion : -1)
          if (registrations.length === 1) {
            socket.write(
              makeResponse(msg.id, {
                sessionId: "clamp-v10",
                name: "clamp-test",
                role: "member",
                chief: "",
                protocolVersion: TRIBE_PROTOCOL_VERSION,
                daemon: { pid: 5005, uptime: 0 },
              }),
            )
            setTimeout(() => socket.destroy(), 25)
            return
          }
          if (protocolVersion !== TRIBE_PROTOCOL_VERSION - 1) {
            socket.write(
              makeError(
                msg.id,
                -32006,
                `Protocol version mismatch: client=${String(protocolVersion)}; daemon=${TRIBE_PROTOCOL_VERSION - 1}; supported=${TRIBE_PROTOCOL_VERSION - 1}. Advance the Tribe daemon to v${TRIBE_PROTOCOL_VERSION - 1} or newer, then reconnect.`,
              ),
            )
            return
          }
          socket.write(
            makeResponse(msg.id, {
              sessionId: "clamp-s1",
              name: "clamp-test",
              role: "member",
              chief: "",
              protocolVersion: TRIBE_PROTOCOL_VERSION - 1,
              daemon: { pid: 5005, uptime: 0 },
            }),
          )
          return
        }
        if (msg.method === "tribe.members") {
          socket.write(makeResponse(msg.id, { content: [{ type: "text", text: JSON.stringify({ sessions: [] }) }] }))
          return
        }
        socket.write(makeResponse(msg.id, { ok: true }))
      })
      socket.on("data", parse)
      socket.on("error", () => {
        /* test teardown */
      })
    })
    server.listen(socketPath, () => resolveServer({ server, clients, registrations }))
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe("stdio adapter — protocol version skew", () => {
  let tmpDir: string
  let child: ChildProcessWithoutNullStreams | undefined
  let daemon: { server: Server; clients: Socket[] } | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-skew-"))
  })

  it("derives registration advertisement, mismatch versions, and bounded jitter from shared helpers", () => {
    expect(protocolVersionAdvertisement()).toEqual({
      protocolVersion: TRIBE_PROTOCOL_VERSION - 1,
      supportedProtocolVersions: [TRIBE_PROTOCOL_VERSION, TRIBE_PROTOCOL_VERSION - 1],
    })
    expect(
      protocolVersionsFromMismatch(
        `Protocol version mismatch: client=${TRIBE_PROTOCOL_VERSION}; daemon=${TRIBE_PROTOCOL_VERSION - 1}; supported=${TRIBE_PROTOCOL_VERSION - 1}.`,
      ),
    ).toEqual([TRIBE_PROTOCOL_VERSION - 1])
    expect(reconnectRegistrationJitterMs(() => 0)).toBe(0)
    expect(reconnectRegistrationJitterMs(() => 0.5)).toBe(125)
    expect(reconnectRegistrationJitterMs(() => 0.999)).toBe(249)
  })

  afterEach(async () => {
    child?.kill("SIGTERM")
    child = undefined
    for (const s of daemon?.clients ?? []) s.destroy()
    if (daemon) await new Promise<void>((r) => daemon!.server.close(() => r()))
    daemon = undefined
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("stays alive and reports a mismatch instead of exiting the adapter", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const logPath = join(tmpDir, "adapter.log")
    daemon = await spawnSkewedDaemon(socketPath)
    child = spawn(BUN_BIN, [STDIO_ADAPTER, "--socket", socketPath, "--name", "skew-test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        ...STANDALONE_PLUGIN_ENV,
        TRIBE_DELIVERY: "pull",
        DEBUG_LOG: logPath,
        LOG_LEVEL: "warn",
      },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams
    await waitFor(
      () => {
        try {
          return readFileSync(logPath, "utf8").includes("protocol version mismatch")
        } catch {
          return false
        }
      },
      8_000,
      "skew failure in adapter log",
    )

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(child.exitCode).toBeNull()
  }, 20_000)

  it("keeps retrying after the old three-attempt budget would have detached the transport", async () => {
    const socketPath = join(tmpDir, "tribe-reconnect-skew.sock")
    const reconnectDaemon = await spawnExtendedReconnectDaemon(socketPath)
    daemon = reconnectDaemon
    child = spawn(BUN_BIN, [STDIO_ADAPTER, "--socket", socketPath, "--name", "reconnect-test"], {
      cwd: tmpDir,
      env: { ...process.env, ...STANDALONE_PLUGIN_ENV, TRIBE_DELIVERY: "pull", LOG_LEVEL: "silent" },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams

    await waitFor(() => reconnectDaemon.registrations >= 5, 12_000, "reconnect after version mismatch")
    expect(child.exitCode).toBeNull()
  }, 20_000)

  it("clamps registration to a daemon version inside the advertised window", async () => {
    // Defence-in-depth for a future rolling transition. The live v9 daemon
    // accepts a freshly restarted v10 bridge through the N-1 scalar today;
    // version rejection was not the cause of the fleet outage.
    const socketPath = join(tmpDir, "tribe-clamp.sock")
    const clampDaemon = await spawnClampDaemon(socketPath)
    daemon = clampDaemon
    child = spawn(BUN_BIN, [STDIO_ADAPTER, "--socket", socketPath, "--name", "clamp-test"], {
      cwd: tmpDir,
      env: { ...process.env, ...STANDALONE_PLUGIN_ENV, TRIBE_DELIVERY: "pull", LOG_LEVEL: "silent" },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams

    await waitFor(() => clampDaemon.registrations.length >= 3, 8_000, "registration at the daemon-selected version")
    expect(clampDaemon.registrations).toEqual([
      TRIBE_PROTOCOL_VERSION - 1,
      TRIBE_PROTOCOL_VERSION,
      TRIBE_PROTOCOL_VERSION - 1,
    ])
    expect(child.exitCode).toBeNull()
  }, 20_000)

  it("keeps a client live when the daemon selects the previous supported version", async () => {
    const socketPath = join(tmpDir, "tribe-compatible.sock")
    const logPath = join(tmpDir, "compatible-adapter.log")
    const compatibleDaemon = await spawnCompatibleDaemon(socketPath)
    daemon = compatibleDaemon
    child = spawn(BUN_BIN, [PLUGIN_SERVER, "--socket", socketPath, "--name", "compatible-test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        ...STANDALONE_PLUGIN_ENV,
        TRIBE_DELIVERY: "pull",
        DEBUG_LOG: logPath,
        LOG_LEVEL: "info",
      },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams

    await waitFor(() => compatibleDaemon.registrations.length >= 1, 8_000, "compatible registration")
    expect(compatibleDaemon.registrations[0]).toMatchObject({
      protocolVersion: TRIBE_PROTOCOL_VERSION - 1,
      supportedProtocolVersions: [TRIBE_PROTOCOL_VERSION, TRIBE_PROTOCOL_VERSION - 1],
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(child.exitCode).toBeNull()
  }, 20_000)

  it("re-execs current disk code when a reconnect observes a new daemon pid", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const generationDaemon = await spawnGenerationDaemon(socketPath)
    daemon = generationDaemon
    child = spawn(BUN_BIN, [PLUGIN_SERVER, "--socket", socketPath, "--name", "generation-test"], {
      cwd: tmpDir,
      env: { ...process.env, ...STANDALONE_PLUGIN_ENV, TRIBE_DELIVERY: "pull", LOG_LEVEL: "silent" },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams

    await waitFor(() => generationDaemon.registrations.length >= 1, 8_000, "initial registration")
    generationDaemon.setPid(2002)
    for (const socket of generationDaemon.clients.splice(0)) socket.destroy()

    await waitFor(() => generationDaemon.registrations.length >= 3, 12_000, "replacement registration")
    expect(generationDaemon.registrations).toEqual([1001, 2002, 2002])
    expect(child.exitCode).toBeNull()
  }, 20_000)
})
