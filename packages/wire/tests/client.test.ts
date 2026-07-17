import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createServer, type Server, type Socket } from "node:net"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  connectExisting,
  connectOrStart,
  createReconnectingClient,
  connectToDaemon,
  type ConnectToDaemonOpts,
  type DaemonClient,
  waitForSocketAlive,
} from "../src/client.ts"
import { createLineParser } from "../src/parser.ts"
import { isRequest, makeNotification, makeResponse } from "../src/rpc.ts"

/** errno-tagged error, like the ones node:net throws on connect failures. */
function errno(code: string): Error {
  return Object.assign(new Error(code), { code })
}

/** Minimal stand-in for a connected client (the retry helpers only check truthiness). */
const FAKE_CLIENT = {
  call: async () => null,
  notify: () => {},
  onNotification: () => {},
  close: () => {},
  socket: {},
} as unknown as DaemonClient

/**
 * Spin up a tiny in-memory daemon that echoes calls and pushes notifications.
 * No file paths, no process spawn — just a Unix domain socket server.
 */
function spawnFakeDaemon(socketPath: string): Promise<{ server: Server; clients: Socket[] }> {
  const clients: Socket[] = []
  return new Promise((resolveServer) => {
    const server = createServer((socket) => {
      clients.push(socket)
      const parse = createLineParser((msg) => {
        if (isRequest(msg)) {
          if (msg.method === "echo") {
            socket.write(makeResponse(msg.id, { echoed: msg.params }))
          } else if (msg.method === "ping") {
            socket.write(makeResponse(msg.id, { pong: true }))
            socket.write(makeNotification("pushed", { from: "ping" }))
          } else if (msg.method === "closeWithoutResponse") {
            socket.end()
          } else {
            socket.write(makeResponse(msg.id, null))
          }
        }
      })
      socket.on("data", parse)
      socket.on("error", () => {
        /* ignore */
      })
    })
    server.listen(socketPath, () => resolveServer({ server, clients }))
  })
}

describe("connectToDaemon", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-client-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("connects, sends a request, and resolves with the response result", async () => {
    const sock = join(tmpDir, "d.sock")
    const { server } = await spawnFakeDaemon(sock)
    try {
      const client = await connectToDaemon(sock)
      const result = await client.call("echo", { hello: "world" })
      expect(result).toEqual({ echoed: { hello: "world" } })
      client.close()
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it("delivers server-pushed notifications to the registered handler", async () => {
    const sock = join(tmpDir, "d.sock")
    const { server } = await spawnFakeDaemon(sock)
    try {
      const client = await connectToDaemon(sock)
      const seen: Array<{ method: string; params?: Record<string, unknown> }> = []
      client.onNotification((method, params) => {
        seen.push({ method, params })
      })
      await client.call("ping")
      // Give the server a tick to flush the notification.
      await new Promise<void>((r) => setTimeout(r, 50))
      expect(seen).toHaveLength(1)
      expect(seen[0]!.method).toBe("pushed")
      expect(seen[0]!.params).toEqual({ from: "ping" })
      client.close()
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it("rejects pending calls when the socket closes without a response", async () => {
    const sock = join(tmpDir, "d.sock")
    const { server } = await spawnFakeDaemon(sock)
    try {
      const client = await connectToDaemon(sock)
      await expect(client.call("closeWithoutResponse")).rejects.toThrow("Connection closed")
      client.close()
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it("rejects with ENOENT when the socket file does not exist", async () => {
    const missing = join(tmpDir, "nope.sock")
    await expect(connectToDaemon(missing)).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("connectExisting (retry before declaring a daemon dead)", () => {
  it("retries a transient ECONNREFUSED, then resolves with the client", async () => {
    let calls = 0
    const delays: number[] = []
    const client = await connectExisting("/ignored.sock", {
      connectFn: async () => {
        calls++
        if (calls < 3) throw errno("ECONNREFUSED")
        return FAKE_CLIENT
      },
      delayFn: async (ms) => {
        delays.push(ms)
      },
    })
    expect(client).toBe(FAKE_CLIENT)
    expect(calls).toBe(3)
    // Backed off twice (50ms, 100ms) before the successful third attempt.
    expect(delays).toEqual([50, 100])
  })

  it("default retry budget survives a startup-herd refusal streak", async () => {
    let calls = 0
    const delays: number[] = []
    const client = await connectExisting("/ignored.sock", {
      connectFn: async () => {
        calls++
        if (calls < 7) throw errno("ECONNREFUSED")
        return FAKE_CLIENT
      },
      delayFn: async (ms) => {
        delays.push(ms)
      },
    })
    expect(client).toBe(FAKE_CLIENT)
    expect(calls).toBe(7)
    expect(delays).toEqual([50, 100, 200, 400, 800, 1000])
  })

  it("short-circuits to null on ENOENT without retrying (no socket file)", async () => {
    let calls = 0
    const client = await connectExisting("/ignored.sock", {
      connectFn: async () => {
        calls++
        throw errno("ENOENT")
      },
      delayFn: async () => {},
    })
    expect(client).toBeNull()
    expect(calls).toBe(1)
  })

  it("returns null after exhausting attempts on persistent ECONNREFUSED", async () => {
    let calls = 0
    const client = await connectExisting("/ignored.sock", {
      attempts: 4,
      connectFn: async () => {
        calls++
        throw errno("ECONNREFUSED")
      },
      delayFn: async () => {},
    })
    expect(client).toBeNull()
    expect(calls).toBe(4)
  })

  it("propagates a non-refusal error (e.g. EACCES) immediately", async () => {
    let calls = 0
    await expect(
      connectExisting("/ignored.sock", {
        connectFn: async () => {
          calls++
          throw errno("EACCES")
        },
        delayFn: async () => {},
      }),
    ).rejects.toMatchObject({ code: "EACCES" })
    expect(calls).toBe(1)
  })
})

describe("waitForSocketAlive (retry-biased liveness)", () => {
  it("returns true on the first successful probe", async () => {
    let calls = 0
    const alive = await waitForSocketAlive("/ignored.sock", {
      aliveFn: async () => {
        calls++
        return true
      },
    })
    expect(alive).toBe(true)
    expect(calls).toBe(1)
  })

  it("retries transient false probes, then returns true", async () => {
    let calls = 0
    const alive = await waitForSocketAlive("/ignored.sock", {
      delayMs: 0,
      aliveFn: async () => {
        calls++
        return calls >= 3
      },
    })
    expect(alive).toBe(true)
    expect(calls).toBe(3)
  })

  it("returns false only after every attempt refuses", async () => {
    let calls = 0
    const alive = await waitForSocketAlive("/ignored.sock", {
      attempts: 4,
      delayMs: 0,
      aliveFn: async () => {
        calls++
        return false
      },
    })
    expect(alive).toBe(false)
    expect(calls).toBe(4)
  })
})

describe("connectOrStart (never destroys a live daemon's socket)", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-cos-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("retries a transiently-refused LIVE daemon and leaves its socket intact", async () => {
    const sock = join(tmpDir, "d.sock")
    const { server } = await spawnFakeDaemon(sock)
    const inodeBefore = statSync(sock).ino
    let calls = 0
    // First connect attempt is refused (simulating a full accept backlog /
    // hot-reload window against the LIVE daemon); subsequent attempts succeed.
    const flaky = (p: string, o?: ConnectToDaemonOpts): Promise<DaemonClient> => {
      calls++
      if (calls === 1) return Promise.reject(errno("ECONNREFUSED"))
      return connectToDaemon(p, o)
    }
    try {
      // daemonScript points at a nonexistent file: if the fix regressed and
      // unlinked the live socket, the spawn path would run and never produce a
      // working client — so reaching `echo` proves we connected to the original.
      const client = await connectOrStart(sock, {
        connectFn: flaky,
        daemonScript: join(tmpDir, "nonexistent-daemon.ts"),
      })
      const result = await client.call("echo", { ok: 1 })
      expect(result).toEqual({ echoed: { ok: 1 } })
      expect(calls).toBeGreaterThanOrEqual(2) // retried past the transient refusal
      // The live socket file must be untouched — same inode, never unlinked.
      expect(statSync(sock).ino).toBe(inodeBefore)
      client.close()
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it("noSpawn rejects instead of spawning when no daemon is reachable", async () => {
    const sock = join(tmpDir, "absent.sock")
    await expect(connectOrStart(sock, { noSpawn: true, connectAttempts: 1 })).rejects.toBeTruthy()
  })
})

describe("createReconnectingClient transport recovery", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-reconnect-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("closes an initial candidate when registration rejects", async () => {
    const sock = join(tmpDir, "initial-registration-reject.sock")
    const { server, clients } = await spawnFakeDaemon(sock)
    try {
      await expect(
        createReconnectingClient({
          socketPath: sock,
          maxStartupAttempts: 1,
          onConnect: async () => {
            throw new Error("registration refused")
          },
        }),
      ).rejects.toThrow("registration refused")
      await vi.waitFor(() => expect(clients[0]?.destroyed).toBe(true))
    } finally {
      for (const socket of clients) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("closes each reconnect candidate whose registration rejects", async () => {
    const sock = join(tmpDir, "reconnect-registration-reject.sock")
    const { server, clients } = await spawnFakeDaemon(sock)
    let registrations = 0
    let exhausted = false
    const client = await createReconnectingClient({
      socketPath: sock,
      maxAttempts: 1,
      maxStartupAttempts: 1,
      onConnect: async () => {
        registrations += 1
        if (registrations > 1) throw new Error("reconnect registration refused")
      },
      onReconnectExhausted: () => {
        exhausted = true
      },
    })
    try {
      clients[0]?.destroy()
      await vi.waitFor(() => expect(exhausted).toBe(true))
      await vi.waitFor(() => expect(clients[1]?.destroyed).toBe(true))
    } finally {
      client.close()
      for (const socket of clients) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("re-arms callbacks and notifications after one client transport closes while the daemon stays healthy", async () => {
    const sock = join(tmpDir, "d.sock")
    const { server, clients } = await spawnFakeDaemon(sock)
    const lifecycle: string[] = []
    const pushed: string[] = []
    const client = await createReconnectingClient({
      socketPath: sock,
      maxAttempts: 3,
      maxStartupAttempts: 1,
      onDisconnect: () => lifecycle.push("closed"),
      onReconnect: () => lifecycle.push("reconnected"),
    })
    client.onNotification((method) => pushed.push(method))
    try {
      const socketInode = statSync(sock).ino
      clients[0]?.destroy()
      await vi.waitFor(() => {
        expect(clients).toHaveLength(2)
        expect(lifecycle).toEqual(["closed", "reconnected"])
      })

      await client.call("ping")
      await vi.waitFor(() => expect(pushed).toContain("pushed"))
      expect(statSync(sock).ino).toBe(socketInode)
    } finally {
      client.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("reports bounded reconnect exhaustion with the final error", async () => {
    const sock = join(tmpDir, "exhausted.sock")
    const { server, clients } = await spawnFakeDaemon(sock)
    let exhausted: { error: unknown; attempts: number } | undefined
    const client = await createReconnectingClient({
      socketPath: sock,
      maxAttempts: 1,
      maxStartupAttempts: 1,
      onReconnectExhausted: (error, attempts) => {
        exhausted = { error, attempts }
      },
    })

    for (const socket of clients) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    try {
      await vi.waitFor(() => {
        expect(exhausted?.attempts).toBe(1)
        expect(exhausted?.error).toBeInstanceOf(Error)
      })
    } finally {
      client.close()
    }
  })

  it("elects one daemon across four simultaneous adapter starters and reconnects them to one successor", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const sock = join(tmpDir, "startup-election.sock")
    const db = join(tmpDir, "startup-election.db")
    const starts = join(tmpDir, "starter-pids.txt")
    const gate = join(tmpDir, "starter-gate.txt")
    const statuses = join(tmpDir, "starter-status.txt")
    const wrapper = join(tmpDir, "daemon-start-barrier.ts")
    const daemon = resolve(import.meta.dirname, "../../daemon/src/daemon.ts")
    writeFileSync(gate, "0")
    writeFileSync(
      wrapper,
      `import { appendFileSync, readFileSync } from "node:fs"
const starts = ${JSON.stringify(starts)}
const gate = ${JSON.stringify(gate)}
const statuses = ${JSON.stringify(statuses)}
appendFileSync(starts, \`${"${process.pid}"}\\n\`)
process.on("exit", code => appendFileSync(statuses, \`${"${process.pid}"} exit ${"${code}"}\\n\`))
process.on("uncaughtException", error => {
  appendFileSync(statuses, \`${"${process.pid}"} uncaught ${"${error instanceof Error ? error.stack : String(error)}"}\\n\`)
  process.exit(1)
})
process.on("unhandledRejection", error => {
  appendFileSync(statuses, \`${"${process.pid}"} rejection ${"${error instanceof Error ? error.stack : String(error)}"}\\n\`)
  process.exit(1)
})
const count = () => readFileSync(starts, "utf8").trim().split(/\\n/u).filter(Boolean).length
const wave = Math.ceil(count() / 4)
const deadline = Date.now() + 15_000
while (Number(readFileSync(gate, "utf8")) < wave && Date.now() < deadline) await Bun.sleep(10)
if (Number(readFileSync(gate, "utf8")) < wave) throw new Error(\`starter gate timed out for wave ${"${wave}"}\`)
await import(${JSON.stringify(new URL(`file://${daemon}`).href)})
`,
    )

    const previousNoPlugins = process.env.TRIBE_NO_PLUGINS
    process.env.TRIBE_NO_PLUGINS = "1"
    const clients: DaemonClient[] = []
    const reconnected = new Set<number>()
    const starterPids = () =>
      existsSync(starts) ? readFileSync(starts, "utf8").trim().split(/\n/u).filter(Boolean).map(Number) : []
    const pidAlive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const stop = (pid: number) => {
      try {
        process.kill(pid, "SIGTERM")
      } catch {
        /* already exited */
      }
    }

    try {
      const connecting = Array.from({ length: 4 }, (_, index) =>
        createReconnectingClient({
          socketPath: sock,
          daemonScript: wrapper,
          daemonArgs: ["--db", db, "--foreground", "--no-lore"],
          maxAttempts: 10,
          maxStartupAttempts: 20,
          onReconnect: () => reconnected.add(index),
        }),
      )
      await vi.waitFor(() => expect(starterPids()).toHaveLength(4), { timeout: 10_000, interval: 25 })
      writeFileSync(gate, "1")
      try {
        clients.push(...(await Promise.all(connecting)))
      } catch (error) {
        const evidence = existsSync(statuses) ? readFileSync(statuses, "utf8") : "(no child exit status)"
        throw new Error(
          `initial four-starter election failed; pids=${starterPids().join(",")} alive=${starterPids().filter(pidAlive).join(",")} socket=${existsSync(sock)}\n${evidence}`,
          { cause: error },
        )
      }

      const firstDaemonPids = await Promise.all(
        clients.map(async (client) => (await client.call("cli_daemon")) as { pid: number }),
      )
      expect(new Set(firstDaemonPids.map(({ pid }) => pid)).size).toBe(1)
      const firstWinner = firstDaemonPids[0]!.pid
      const firstSocketInode = statSync(sock).ino
      await vi.waitFor(() => expect(starterPids().slice(0, 4).filter(pidAlive)).toEqual([firstWinner]), {
        timeout: 10_000,
        interval: 25,
      })
      expect(statSync(sock).ino).toBe(firstSocketInode)

      stop(firstWinner)
      await vi.waitFor(() => expect(starterPids()).toHaveLength(8), { timeout: 15_000, interval: 25 })
      writeFileSync(gate, "2")
      await vi.waitFor(() => expect(reconnected.size).toBe(4), { timeout: 15_000, interval: 25 })

      const secondDaemonPids = await Promise.all(
        clients.map(async (client) => (await client.call("cli_daemon")) as { pid: number }),
      )
      expect(new Set(secondDaemonPids.map(({ pid }) => pid)).size).toBe(1)
      const secondWinner = secondDaemonPids[0]!.pid
      expect(secondWinner).not.toBe(firstWinner)
      const secondSocketInode = statSync(sock).ino
      await vi.waitFor(() => expect(starterPids().slice(4, 8).filter(pidAlive)).toEqual([secondWinner]), {
        timeout: 10_000,
        interval: 25,
      })
      expect(statSync(sock).ino).toBe(secondSocketInode)
    } finally {
      for (const client of clients) client.close()
      for (const pid of starterPids()) stop(pid)
      warn.mockRestore()
      if (previousNoPlugins === undefined) delete process.env.TRIBE_NO_PLUGINS
      else process.env.TRIBE_NO_PLUGINS = previousNoPlugins
    }
  }, 40_000)
})
