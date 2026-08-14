/**
 * Version-skew recovery: a deterministic protocol mismatch is reported and
 * allowed to use the adapter's existing degraded/reconnect machinery instead
 * of terminating the transport before that machinery can run.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
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

const childStderr = new WeakMap<ChildProcessWithoutNullStreams, string[]>()

/** Attach a stderr collector to a spawned child so a later timeout error can
 * carry what it printed. Mirrors actionable-recovery-journey.test.ts's
 * spawnDaemon/daemonStderr (eb3d56fb). */
function captureStderr(proc: ChildProcessWithoutNullStreams): ChildProcessWithoutNullStreams {
  const chunks: string[] = []
  proc.stderr.on("data", (chunk: Buffer | string) => {
    chunks.push(chunk.toString())
  })
  childStderr.set(proc, chunks)
  return proc
}

/**
 * Round-4's fix widened this wait's budget (12s -> 40s) and it did NOT close
 * the flake: CI runs 31770926539 and 31773186498 both timed out again AT the
 * widened 40s, plus once more in a 4-core constrained harness — always the
 * same evidence-free "timed out waiting for X" with nothing to say whether
 * the watched child was still working or already dead. Exactly the class
 * waitForDaemonSocket (eb3d56fb) named: two states — genuinely slow, or
 * crashed/hung — produce byte-identical evidence from a bare predicate-poll
 * wait. Fixed the same way: fail fast the instant the watched child exits
 * instead of burning the remaining budget polling a corpse, and carry exit
 * code + stderr + DEBUG_LOG tail in the thrown error so the NEXT occurrence
 * (here or in CI) self-diagnoses instead of reporting nothing
 * (@km/tribe/ci-deflake-version-skew).
 */
async function waitForRegistrations(
  proc: ChildProcessWithoutNullStreams,
  count: () => number,
  target: number,
  timeoutMs: number,
  label: string,
  logPath?: string,
): Promise<void> {
  // Node leaves exitCode null for a SIGNAL-terminated process (it sets
  // signalCode instead) — checking exitCode alone missed a killed child
  // entirely and burned the full budget polling a corpse, caught by the
  // deliberate-kill RED proof below before this shipped.
  const dead = () => proc.exitCode !== null || proc.signalCode !== null
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !dead()) {
    if (count() >= target) return
    await new Promise((r) => setTimeout(r, 25))
  }
  if (count() >= target) return
  const stderrTail = (childStderr.get(proc)?.join("") ?? "").slice(-4_000) || "(empty)"
  const logTail =
    logPath !== undefined && existsSync(logPath)
      ? readFileSync(logPath, "utf8").split("\n").slice(-30).join("\n")
      : "(no log)"
  // `proc` (PLUGIN_SERVER) is a supervisor whose actual re-exec work happens
  // in a child of its own — this round's own reproduction needed a process
  // tree to prove no replacement was ever spawned, not just that `proc`
  // itself stayed alive. Kept permanently for the same reason: the next
  // occurrence should not need to re-derive this from scratch.
  let procTree = "(ps failed)"
  try {
    procTree = execFileSync("ps", ["-eo", "pid,ppid,stat,args"], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.includes(String(proc.pid)) || line.trim().startsWith("PID"))
      .join("\n")
  } catch {
    /* best effort */
  }
  throw new Error(
    `${dead() ? `child exited before reaching ${label}` : `timed out waiting for ${label}`}; ` +
      `exit=${String(proc.exitCode)} signal=${String(proc.signalCode)} count=${count()}/${target}\n` +
      `--- child stderr ---\n${stderrTail}\n--- child DEBUG_LOG tail ---\n${logTail}\n--- proc tree ---\n${procTree}`,
  )
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
    const logPath = join(tmpDir, "generation-test.log")
    const generationDaemon = await spawnGenerationDaemon(socketPath)
    daemon = generationDaemon
    child = captureStderr(
      spawn(BUN_BIN, [PLUGIN_SERVER, "--socket", socketPath, "--name", "generation-test"], {
        cwd: tmpDir,
        // LOG_LEVEL bumped from "silent" and DEBUG_LOG wired (unlike this
        // test's neighbors) specifically so a re-exec failure has somewhere
        // to leave a trace — round 4 shipped with neither and the resulting
        // timeouts carried zero evidence. "debug" (not "info"): the
        // reconnect loop's own per-attempt failure line
        // (client.ts's `Reconnect attempt N failed`) is logged at debug —
        // "info" silently dropped exactly the evidence this round exists to
        // capture; the first reproduction under "info" showed the
        // registration count frozen at 1/3 for the full 40s with nothing
        // else, which does not distinguish "not retrying at all" from
        // "retrying and failing silently" without this.
        env: {
          ...process.env,
          ...STANDALONE_PLUGIN_ENV,
          TRIBE_DELIVERY: "pull",
          DEBUG_LOG: logPath,
          LOG_LEVEL: "debug",
        },
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams,
    )

    await waitForRegistrations(child, () => generationDaemon.registrations.length, 1, 15_000, "initial registration")
    generationDaemon.setPid(2002)
    for (const socket of generationDaemon.clients.splice(0)) socket.destroy()

    // ARCHITECTURAL FINDING (@km/tribe/ci-deflake-version-skew), reported
    // rather than guess-fixed here per this round's own scope: this is NOT
    // "genuinely slow." Reproduced 4 times across 28 constrained runs
    // (~14%), always identical — registrations frozen at 1/3 for the full
    // wait, proc (PLUGIN_SERVER) alive, its stderr empty, and its DEBUG_LOG
    // silent after the initial registration even at LOG_LEVEL=debug. A
    // temporary production-side probe (client.ts's createReconnectingClient,
    // reverted — never committed) confirmed setupReconnect's `close`
    // listener attaches exactly once and never fires: the process tree at
    // failure shows only the ORIGINAL inner adapter, never a replacement.
    // The socket's own "close" event is the sole trigger for this client's
    // entire reconnect path (packages/wire/src/client.ts, createReconnectingClient) —
    // under contention it can apparently go unobserved indefinitely, not
    // just late, leaving a live adapter that will never self-heal from a
    // real daemon restart either. That is a self-heal-path bug, not a test
    // budget problem; the underlying diagnosis needs someone with authority
    // over client.ts, not a guessed patch from this test file.
    await waitForRegistrations(
      child,
      () => generationDaemon.registrations.length,
      3,
      40_000,
      "replacement registration",
      logPath,
    )
    expect(generationDaemon.registrations).toEqual([1001, 2002, 2002])
    expect(child.exitCode).toBeNull()
  }, 60_000)
})
