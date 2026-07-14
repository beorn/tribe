import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createServer, type Server, type Socket } from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createLineParser } from "../src/parser.ts"
import { isRequest, makeError, makeNotification, makeResponse } from "../src/rpc.ts"
import { MAX_REPLAY_EVENTS } from "../src/lib/replay-cap.ts"

const ADAPTER = resolve(dirname(fileURLToPath(import.meta.url)), "../src/stdio-adapter.ts")
const BUN_BIN = process.versions.bun ? process.execPath : "bun"

type FakeDaemon = {
  readonly server: Server
  readonly clients: Socket[]
  readonly requests: Record<string, unknown>[]
}

function spawnFakeDaemon(
  socketPath: string,
  opts: {
    fetchEvents?: Array<Record<string, unknown>>
    inboxWaitResult?: Record<string, unknown>
    registerError?: { code: number; message: string; data?: unknown }
    registerErrorAfter?: number
    registerErrorUntil?: number
    registerName?: string
  } = {},
): Promise<FakeDaemon> {
  const clients: Socket[] = []
  const requests: Record<string, unknown>[] = []
  let registerCount = 0
  return new Promise((resolveServer) => {
    const server = createServer((socket) => {
      clients.push(socket)
      const parse = createLineParser((msg) => {
        if (!isRequest(msg)) return
        requests.push(msg as Record<string, unknown>)
        if (msg.method === "register") {
          registerCount++
          if (
            opts.registerError &&
            registerCount >= (opts.registerErrorAfter ?? 1) &&
            registerCount <= (opts.registerErrorUntil ?? Number.POSITIVE_INFINITY)
          ) {
            socket.write(
              makeError(msg.id, opts.registerError.code, opts.registerError.message, opts.registerError.data),
            )
            return
          }
          socket.write(
            makeResponse(msg.id, {
              sessionId: "daemon-s1",
              name: opts.registerName ?? "@agent/test",
              role: "member",
              chief: "",
            }),
          )
          return
        }
        if (msg.method === "tribe.members") {
          socket.write(makeResponse(msg.id, { content: [{ type: "text", text: JSON.stringify({ sessions: [] }) }] }))
          return
        }
        if (msg.method === "tribe.join") {
          socket.write(
            makeResponse(msg.id, {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    joined: true,
                    name: "@agent/test",
                    role: "member",
                    domains: ["silvercode"],
                    delivery: "push",
                  }),
                },
              ],
            }),
          )
          return
        }
        if (msg.method === "tribe.fetch") {
          socket.write(
            makeResponse(msg.id, {
              content: [{ type: "text", text: JSON.stringify({ events: opts.fetchEvents ?? [] }) }],
            }),
          )
          return
        }
        if (msg.method === "tribe.inbox.wait") {
          socket.write(
            makeResponse(msg.id, {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    opts.inboxWaitResult ?? {
                      session: "@agent/test",
                      unread_count: 0,
                      oldest_unread_age_min: 0,
                      oldest_unread_ts: 0,
                      waited_ms: 0,
                      timed_out: true,
                      aborted: false,
                    },
                  ),
                },
              ],
            }),
          )
          return
        }
        socket.write(makeResponse(msg.id, { ok: true }))
      })
      socket.on("data", parse)
      socket.on("error", () => {
        /* ignore test socket teardown */
      })
    })
    server.listen(socketPath, () => resolveServer({ server, clients, requests }))
  })
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  opts: { timeoutMs?: number } = {},
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const timeoutMs = opts.timeoutMs ?? 2_000
  return new Promise((resolveExit, reject) => {
    if (child.exitCode !== null) {
      resolveExit({ code: child.exitCode, signal: null })
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error("timed out waiting for adapter exit"))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      child.off("exit", onExit)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      resolveExit({ code, signal })
    }
    child.on("exit", onExit)
  })
}

function waitForLine(
  child: ChildProcessWithoutNullStreams,
  predicate: (line: Record<string, unknown>) => boolean,
  opts: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = opts.timeoutMs ?? 2_000
  const seen: string[] = []
  let carry = ""
  return new Promise((resolveLine, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for adapter stdout line; saw: ${seen.join(" | ")}`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off("data", onData)
      child.off("exit", onExit)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(new Error(`adapter exited before expected line: code=${code} signal=${signal}; saw: ${seen.join(" | ")}`))
    }
    const onData = (chunk: Buffer | string) => {
      const lines = (carry + chunk.toString()).split(/\r?\n/u)
      carry = lines.pop() ?? ""
      for (const raw of lines) {
        if (raw.length === 0) continue
        seen.push(raw)
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>
        } catch {
          continue
        }
        if (predicate(parsed)) {
          cleanup()
          resolveLine(parsed)
          return
        }
      }
    }
    child.stdout.on("data", onData)
    child.on("exit", onExit)
  })
}

function collectStdoutJson(child: ChildProcessWithoutNullStreams): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = []
  let carry = ""
  child.stdout.on("data", (chunk: Buffer | string) => {
    const parts = (carry + chunk.toString()).split(/\r?\n/u)
    carry = parts.pop() ?? ""
    for (const raw of parts) {
      if (raw.length === 0) continue
      try {
        lines.push(JSON.parse(raw) as Record<string, unknown>)
      } catch {
        /* ignore non-json test noise */
      }
    }
  })
  return lines
}

function waitForStdout(
  child: ChildProcessWithoutNullStreams,
  lines: Record<string, unknown>[],
  predicate: () => boolean,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 2_000
  return new Promise((resolveWait, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for stdout condition; saw ${lines.length} json line(s)`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off("data", onData)
      child.off("exit", onExit)
    }
    const check = () => {
      if (!predicate()) return
      cleanup()
      resolveWait()
    }
    const onData = () => check()
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(new Error(`adapter exited while waiting for stdout condition: code=${code} signal=${signal}`))
    }
    child.stdout.on("data", onData)
    child.on("exit", onExit)
    check()
  })
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 3_000)
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolveTick) => setTimeout(resolveTick, opts.intervalMs ?? 25))
  }
  throw new Error(`timed out waiting for ${message}`)
}

function writeJson(child: ChildProcessWithoutNullStreams, payload: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(payload)}\n`)
}

function writeJsonAndWaitForLine(
  child: ChildProcessWithoutNullStreams,
  payload: Record<string, unknown>,
  predicate: (line: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const line = waitForLine(child, predicate)
  writeJson(child, payload)
  return line
}

function initializePayload(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "tribe-wire-test", version: "0" },
    },
  }
}

function callToolPayload(id: number, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }
}

function toolsListPayload(id: number): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "tools/list", params: {} }
}

describe("stdio adapter delivery modes", () => {
  let tmpDir: string
  let daemon: FakeDaemon | undefined
  let child: ChildProcessWithoutNullStreams | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-wire-stdio-"))
  })

  afterEach(async () => {
    child?.kill("SIGTERM")
    child = undefined
    for (const socket of daemon?.clients ?? []) socket.destroy()
    if (daemon) await new Promise<void>((resolveClose) => daemon!.server.close(() => resolveClose()))
    daemon = undefined
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("pull delivery does not advertise or emit Claude-only channel notifications", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath)
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "pull",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout = collectStdoutJson(child)

    writeJson(child, initializePayload(1))
    const init = await waitForLine(child, (line) => line.id === 1)
    expect(JSON.stringify(init)).not.toContain("claude/channel")
    expect(JSON.stringify(init)).not.toContain("New messages also arrive inline as <channel> envelopes")
    expect(JSON.stringify(init)).toContain("This session is pull-delivery")

    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    await writeJsonAndWaitForLine(child, toolsListPayload(2), (line) => line.id === 2)

    daemon.clients[0]?.write(makeNotification("channel", { from: "chief", type: "request", content: "status?" }))
    await new Promise((resolveTick) => setTimeout(resolveTick, 250))

    expect(stdout.some((line) => line.method === "notifications/claude/channel")).toBe(false)
  })

  it("pull delivery forces tribe.join to pull even when the model requests push", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath)
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "pull",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    await writeJsonAndWaitForLine(child, toolsListPayload(2), (line) => line.id === 2)

    await writeJsonAndWaitForLine(
      child,
      callToolPayload(3, "join", { name: "@agent/test", delivery: "push" }),
      (line) => line.id === 3,
    )

    const joinRequest = daemon.requests.find((msg) => msg.method === "tribe.join") as
      | { params?: { delivery?: string } }
      | undefined
    expect(joinRequest?.params?.delivery).toBe("pull")
  })

  it("pull delivery seeds an explicit TRIBE_NAME persona at initial register", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath)
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_NAME: "@chief",
        TRIBE_DELIVERY: "pull",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)

    const register = daemon.requests.find((msg) => msg.method === "register") as
      | { params?: { name?: string; delivery?: string } }
      | undefined
    expect(register?.params?.name).toBe("@chief")
    expect(register?.params?.delivery).toBe("pull")
  })

  it("21049: explicit persona registration carries launch identity with takeover", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath)
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/9"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "pull",
        TRIBE_TAKEOVER: "1",
        TRIBE_LAUNCH_ID: "provider-launch-a",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)

    const register = daemon.requests.find((msg) => msg.method === "register") as
      | { params?: { name?: string; takeover?: boolean; launchId?: string; launchParentPid?: number } }
      | undefined
    expect(register?.params?.name).toBe("@agent/9")
    expect(register?.params?.takeover).toBe(true)
    expect(register?.params?.launchId).toBe("provider-launch-a")
    expect(register?.params?.launchParentPid).toBe(process.pid)
  })

  it("21049: absent launch identity preserves legacy per-transport registration", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath)
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/9"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "pull",
        TRIBE_TAKEOVER: "1",
        TRIBE_LAUNCH_ID: "",
        TRIBE_LAUNCH_PARENT_PID: "",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)

    const register = daemon.requests.find((msg) => msg.method === "register") as
      | { params?: { launchId?: string; launchParentPid?: number } }
      | undefined
    expect(register?.params && "launchId" in register.params).toBe(false)
    expect(register?.params && "launchParentPid" in register.params).toBe(false)
  })

  it("21049: takeover is a launch capability and is not replayed after reconnect", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath, { registerName: "@chief" })
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@chief"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "pull",
        TRIBE_TAKEOVER: "1",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    await waitForCondition(
      () =>
        daemon!.requests.filter((msg) => msg.method === "register").length === 1 &&
        daemon!.requests.some((msg) => msg.method === "tribe.members"),
      "completed initial adapter registration",
    )
    await new Promise((resolveTick) => setTimeout(resolveTick, 50))

    daemon.clients.at(-1)?.destroy()
    await waitForCondition(
      () => daemon!.requests.filter((msg) => msg.method === "register").length >= 2,
      "adapter reconnect registration",
    )

    const registrations = daemon.requests.filter((msg) => msg.method === "register") as Array<{
      params?: { name?: string; takeover?: boolean }
    }>
    expect(registrations[0]?.params).toMatchObject({ name: "@chief", takeover: true })
    expect(registrations[1]?.params?.name).toBe("@chief")
    expect(registrations[1]?.params && "takeover" in registrations[1].params).toBe(false)
  })

  it("21111: reconnects a named launch with its latest resolved member name", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath, { registerName: "@chief" })
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@chief"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "pull",
        TRIBE_TAKEOVER: "1",
        TRIBE_LAUNCH_ID: "provider-launch-a",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    await writeJsonAndWaitForLine(child, toolsListPayload(2), (line) => line.id === 2)
    await writeJsonAndWaitForLine(child, callToolPayload(3, "join", { name: "@agent/test" }), (line) => line.id === 3)

    daemon.clients.at(-1)?.destroy()
    await waitForCondition(
      () => daemon!.requests.filter((msg) => msg.method === "register").length >= 2,
      "adapter reconnect registration",
    )

    const registrations = daemon.requests.filter((msg) => msg.method === "register") as Array<{
      params?: { name?: string; takeover?: boolean; launchId?: string }
    }>
    expect(registrations[0]?.params).toMatchObject({
      name: "@chief",
      takeover: true,
      launchId: "provider-launch-a",
    })
    expect(registrations[1]?.params?.name).toBe("@agent/test")
    expect(registrations[1]?.params && "takeover" in registrations[1].params).toBe(false)
  })

  it("21049: repeated legacy reconnect conflicts keep native MCP alive, report the exact cause, and recover", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath, {
      registerError: {
        code: -32000,
        message: 'Name "@chief" is already taken by live pid 4242',
        data: { existing_names: ["@chief"], holder_pid: 4242 },
      },
      registerErrorAfter: 2,
      registerErrorUntil: 3,
    })
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@chief"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "pull",
        TRIBE_TAKEOVER: "1",
        TRIBE_LAUNCH_ID: "",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    await waitForCondition(
      () => daemon!.requests.some((msg) => msg.method === "tribe.members"),
      "completed initial adapter registration",
    )
    await new Promise((resolveTick) => setTimeout(resolveTick, 50))

    daemon.clients.at(-1)?.destroy()
    await waitForCondition(
      () => daemon!.requests.filter((msg) => msg.method === "register").length === 2,
      "transient reconnect registration conflict",
    )

    expect(child.exitCode).toBeNull()
    const closedReplyPromise = waitForLine(child, (line) => line.id === 2)
    writeJson(child, callToolPayload(2, "members", {}))
    const closedReply = (await closedReplyPromise) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> }
    }
    const closedText = closedReply.result?.content?.[0]?.text ?? ""
    expect(closedReply.result?.isError).toBe(true)
    expect(closedText).toContain("required MCP tribe status=closed")
    expect(closedText).toContain('Name "@chief" is already taken by live pid 4242')
    expect(closedText).toContain("launch_id=missing")
    expect(closedText).toContain(`transport_pid=${child.pid}`)
    expect(closedText).toContain("reconnect_attempts=1")

    await waitForCondition(
      () => daemon!.requests.filter((msg) => msg.method === "register").length >= 3,
      "second consecutive reconnect registration conflict",
    )
    await new Promise((resolveTick) => setTimeout(resolveTick, 50))
    expect(child.exitCode).toBeNull()

    const repeatedClosedReplyPromise = waitForLine(child, (line) => line.id === 3)
    writeJson(child, callToolPayload(3, "members", {}))
    const repeatedClosedReply = (await repeatedClosedReplyPromise) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> }
    }
    const repeatedClosedText = repeatedClosedReply.result?.content?.[0]?.text ?? ""
    expect(repeatedClosedReply.result?.isError).toBe(true)
    expect(repeatedClosedText).toContain("required MCP tribe status=closed")
    expect(repeatedClosedText).toContain('Name "@chief" is already taken by live pid 4242')
    expect(repeatedClosedText).toContain("reconnect_attempts=2")

    await waitForCondition(
      () => daemon!.requests.filter((msg) => msg.method === "register").length >= 4,
      "automatic reconnect after repeated conflicts",
    )
    const liveReplyPromise = waitForLine(child, (line) => line.id === 4)
    writeJson(child, callToolPayload(4, "members", {}))
    const liveReply = (await liveReplyPromise) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> }
    }

    expect(child.exitCode).toBeNull()
    expect(liveReply.result?.isError).not.toBe(true)
    expect(liveReply.result?.content?.[0]?.text).toContain('"sessions":[]')
    const registrations = daemon.requests.filter((msg) => msg.method === "register") as Array<{
      params?: { takeover?: boolean }
    }>
    expect(registrations).toHaveLength(4)
    expect(registrations[1]?.params && "takeover" in registrations[1].params).toBe(false)
    expect(registrations[2]?.params && "takeover" in registrations[2].params).toBe(false)
    expect(registrations[3]?.params && "takeover" in registrations[3].params).toBe(false)
  })

  it("21049: a managed tool call recovers an initially unavailable daemon before reporting health", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const logPath = join(tmpDir, "adapter.log")
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@chief"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "pull",
        TRIBE_TAKEOVER: "1",
        TRIBE_LAUNCH_ID: "provider-launch-a",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: logPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    await waitForCondition(
      () => existsSync(logPath) && readFileSync(logPath, "utf8").includes("tribe daemon unavailable"),
      "initial daemon-unavailable state",
    )

    daemon = await spawnFakeDaemon(socketPath)
    const replyPromise = waitForLine(child, (line) => line.id === 2)
    writeJson(child, callToolPayload(2, "members", {}))
    const reply = (await replyPromise) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> }
    }

    expect(child.exitCode).toBeNull()
    expect(reply.result?.isError).not.toBe(true)
    expect(reply.result?.content?.[0]?.text).toContain('"sessions":[]')
    expect(daemon.requests.some((msg) => msg.method === "register")).toBe(true)
  })

  it("20703: without TRIBE_TAKEOVER, register never carries a takeover key", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath)
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/9"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "pull",
        TRIBE_TAKEOVER: "0",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)

    const register = daemon.requests.find((msg) => msg.method === "register") as
      | { params?: { name?: string; takeover?: boolean } }
      | undefined
    expect(register?.params?.name).toBe("@agent/9")
    expect(register?.params && "takeover" in register.params).toBe(false)
  })

  it("explicit managed persona name conflicts fail loud instead of degrading to solo", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath, {
      registerError: {
        code: -32000,
        message: 'Name "@agent/test" is already taken by live pid 4242',
        data: { existing_names: ["@agent/test"], holder_pid: 4242 },
      },
    })
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "pull",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    const exit = await waitForExit(child)

    expect(exit.code).not.toBe(0)
    expect(daemon.requests.some((msg) => msg.method === "register")).toBe(true)
  })

  it("advertises pullTransport metadata in tools/list", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath)
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "pull",
        TRIBE_PULL_TRANSPORT: "cli",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    writeJson(child, toolsListPayload(2))
    const list = await waitForLine(child, (line) => line.id === 2)

    const tools = ((list.result as { tools?: Array<Record<string, unknown>> } | undefined)?.tools ?? []) as Array<{
      name?: string
      description?: string
      _meta?: Record<string, unknown>
    }>
    const waitTool = tools.find((tool) => tool.name === "inbox.wait")
    expect(waitTool?.description).toContain("pullTransport=cli")
    expect(waitTool?._meta?.["tribe.deliveryCapability"]).toMatchObject({
      delivery: "pull",
      pullTransport: "cli",
      idleStrategy: "cli-inbox-wait",
    })
  })

  it("bridges tools/list and tools/call for inbox.wait with structured content", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath, {
      inboxWaitResult: {
        session: "@agent/test",
        unread_count: 2,
        oldest_unread_age_min: 1,
        oldest_unread_ts: 123,
        waited_ms: 17,
        timed_out: false,
        aborted: false,
      },
    })
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "pull",
        TRIBE_PULL_TRANSPORT: "cli",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })

    writeJson(child, toolsListPayload(2))
    const list = await waitForLine(child, (line) => line.id === 2)
    const tools = ((list.result as { tools?: Array<Record<string, unknown>> } | undefined)?.tools ?? []) as Array<{
      name?: string
      _meta?: Record<string, unknown>
    }>
    expect(tools.find((tool) => tool.name === "inbox.wait")?._meta?.["tribe.deliveryCapability"]).toMatchObject({
      idleStrategy: "cli-inbox-wait",
      pullTransport: "cli",
    })

    writeJson(child, callToolPayload(3, "inbox.wait", { session: "@agent/test", timeout_ms: 17 }))
    const call = await waitForLine(child, (line) => line.id === 3)
    const content = ((call.result as { content?: Array<{ text?: string }> } | undefined)?.content ?? []) as Array<{
      text?: string
    }>
    const parsed = JSON.parse(content[0]?.text ?? "{}") as {
      session?: string
      unread_count?: number
      waited_ms?: number
      timed_out?: boolean
      aborted?: boolean
    }
    expect(parsed).toMatchObject({
      session: "@agent/test",
      unread_count: 2,
      waited_ms: 17,
      timed_out: false,
      aborted: false,
    })

    const daemonRequest = daemon.requests.find((msg) => msg.method === "tribe.inbox.wait") as
      | { params?: { session?: string; timeout_ms?: number } }
      | undefined
    expect(daemonRequest?.params).toMatchObject({ session: "@agent/test", timeout_ms: 17 })
  })

  it("push delivery registers explicit persona as pull and suppresses channel notifications until tribe.join", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath)
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "push",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout = collectStdoutJson(child)

    writeJson(child, initializePayload(1))
    const init = await waitForLine(child, (line) => line.id === 1)
    expect(JSON.stringify(init)).toContain("claude/channel")
    expect(JSON.stringify(init)).toContain("New messages also arrive inline as <channel> envelopes")

    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    await writeJsonAndWaitForLine(child, toolsListPayload(2), (line) => line.id === 2)

    const register = daemon.requests.find((msg) => msg.method === "register") as
      | { params?: { name?: string; delivery?: string } }
      | undefined
    expect(register?.params?.name).toBe("@agent/test")
    expect(register?.params?.delivery).toBe("pull")

    daemon.clients[0]?.write(makeNotification("channel", { from: "chief", type: "request", content: "before" }))
    await new Promise((resolveTick) => setTimeout(resolveTick, 250))
    expect(stdout.some((line) => line.method === "notifications/claude/channel")).toBe(false)

    await writeJsonAndWaitForLine(child, callToolPayload(3, "join", { name: "@agent/test" }), (line) => line.id === 3)
    const joinRequest = daemon.requests.find((msg) => msg.method === "tribe.join") as
      | { params?: { delivery?: string } }
      | undefined
    expect(joinRequest?.params?.delivery).toBe("push")

    daemon.clients[0]?.write(makeNotification("channel", { from: "chief", type: "request", content: "after" }))
    const channel = await waitForLine(child, (line) => line.method === "notifications/claude/channel")
    expect(JSON.stringify(channel)).toContain("after")
  })

  it("bounds a connect-time channel-push burst to the cap (km 19442 push-path backstop)", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath)
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "push",
        TRIBE_NO_AUTOSTART: "1",
        // Tiny cap + a wide window so the whole burst lands inside one connect window.
        TRIBE_CHANNEL_REPLAY_MAX: "3",
        TRIBE_CHANNEL_REPLAY_WINDOW_MS: "60000",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout = collectStdoutJson(child)

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    await writeJsonAndWaitForLine(child, toolsListPayload(2), (line) => line.id === 2)

    // Join so push-mode channel forwarding is enabled.
    await writeJsonAndWaitForLine(child, callToolPayload(3, "join", { name: "@agent/test" }), (line) => line.id === 3)

    // Simulate a stale daemon dumping a 12-event message-BODY backlog on connect.
    for (let i = 0; i < 12; i++) {
      daemon.clients[0]?.write(makeNotification("channel", { from: "chief", type: "notify", content: `burst-${i}` }))
    }
    // Wait for the first forwarded burst event, then let the rest settle.
    await waitForLine(
      child,
      (line) => line.method === "notifications/claude/channel" && JSON.stringify(line).includes("burst-"),
    )
    await new Promise((resolveTick) => setTimeout(resolveTick, 400))

    const forwarded = stdout.filter(
      (line) => line.method === "notifications/claude/channel" && JSON.stringify(line).includes("burst-"),
    )
    // Cap=3 → exactly 3 of the 12 surface; the other 9 are dropped (still durable in
    // the daemon journal, fetchable via tribe.fetch). Without the gate, all 12 flood in.
    expect(forwarded.length).toBe(3)
  })

  // 19442 reframe note: with the mailbox-cursor daemon the drain returns only
  // unacked actionables + genuinely-new rows, so this cap never bites in
  // steady state. It remains as the STALE-DAEMON BACKSTOP — the fake daemon
  // below emulates a legacy daemon dumping a 100+ row backlog, and the
  // adapter must still bound what reaches the model. The end-state invariant
  // (exactly the actionable, zero ambient) lives in
  // actionable-recovery-journey.test.ts against the REAL daemon.
  it("bounds wakeup drain replay to recent capped events (stale-daemon backstop)", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const now = Date.now()
    const oldTs = new Date(now - 25 * 60 * 60 * 1000).toISOString()
    const recentTs = new Date(now - 1_000).toISOString()
    const fetchEvents = [
      { id: "old", type: "request", from: "chief", content: "old-stale", ts: oldTs },
      ...Array.from({ length: MAX_REPLAY_EVENTS + 5 }, (_, i) => ({
        id: `fresh-${i}`,
        type: "request",
        from: "chief",
        content: `fresh-${i}`,
        ts: recentTs,
      })),
    ]
    daemon = await spawnFakeDaemon(socketPath, { fetchEvents })
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "push",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout = collectStdoutJson(child)

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    await writeJsonAndWaitForLine(child, callToolPayload(2, "join", { name: "@agent/test" }), (line) => line.id === 2)

    daemon.clients[0]?.write(makeNotification("wakeup", {}))

    await waitForStdout(
      child,
      stdout,
      () => stdout.filter((line) => line.method === "notifications/claude/channel").length === MAX_REPLAY_EVENTS,
    )

    const channels = stdout.filter((line) => line.method === "notifications/claude/channel")
    const payloads = channels.map((line) => JSON.stringify(line))
    expect(payloads.some((payload) => payload.includes("old-stale"))).toBe(false)
    expect(payloads.some((payload) => payload.includes("fresh-0"))).toBe(true)
    expect(payloads.some((payload) => payload.includes(`fresh-${MAX_REPLAY_EVENTS - 1}`))).toBe(true)
    expect(payloads.some((payload) => payload.includes(`fresh-${MAX_REPLAY_EVENTS}`))).toBe(false)

    const fetchRequest = daemon.requests.find((msg) => msg.method === "tribe.fetch") as
      | { params?: { limit?: number } }
      | undefined
    expect(fetchRequest?.params?.limit).toBe(500)
  })
})
