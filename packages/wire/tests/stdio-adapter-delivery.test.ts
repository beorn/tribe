import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createServer, type Server, type Socket } from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createLineParser } from "../src/parser.ts"
import { isRequest, makeError, makeNotification, makeResponse } from "../src/rpc.ts"
import { MAX_REPLAY_EVENTS } from "../src/lib/replay-cap.ts"
import { loadDeliveryLedger } from "../src/lib/delivery-ledger.ts"
import { buildFleetDeliveryReport } from "../src/lib/delivery-report.ts"
import { launchEnvironment } from "./launch-token.ts"

const ADAPTER = resolve(dirname(fileURLToPath(import.meta.url)), "../src/stdio-adapter.ts")
// #28378 — the same adapter entered through a transport fault seam that rejects
// the first FAULT-ROW channel notification (see notification-fault-entry.ts).
const FAULT_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "./notification-fault-entry.ts")
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
    fetchAttention?: {
      actionable_unread?: Array<Record<string, unknown>>
      pending_balls?: Array<Record<string, unknown>>
      pending_balls_summary?: {
        total: number
        oldest_age_ms: number
        truncated: boolean
        withheld?: {
          total: number
          by_kind: { request: number; incident: number }
        }
      }
    }
    inboxWaitResult?: Record<string, unknown>
    pendingResult?: Record<string, unknown>
    registerError?: { code: number; message: string; data?: unknown }
    registerErrorAfter?: number
    registerErrorUntil?: number
    registerAck?: Record<string, unknown>
    joinAck?: Record<string, unknown>
    wakeupDuringRegister?: boolean
    toolError?: { code: number; message: string; method?: string }
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
          if (opts.wakeupDuringRegister) {
            socket.write(makeNotification("wakeup", { reason: "actionable-recovery" }))
          }
          const delivery = (msg.params as Record<string, unknown>)?.delivery
          socket.write(
            makeResponse(msg.id, {
              sessionId: "daemon-s1",
              name: "@agent/test",
              role: "member",
              chief: "",
              protocolVersion: 11,
              transportDelivery: delivery,
              delivery,
              ...opts.registerAck,
            }),
          )
          return
        }
        if (
          opts.toolError !== undefined &&
          msg.method !== "register" &&
          (opts.toolError.method === undefined || msg.method === opts.toolError.method)
        ) {
          socket.write(makeError(msg.id, opts.toolError.code, opts.toolError.message))
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
                    transportDelivery: (msg.params as Record<string, unknown>)?.delivery,
                    delivery: (msg.params as Record<string, unknown>)?.delivery,
                    ...opts.joinAck,
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
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ attention: opts.fetchAttention, events: opts.fetchEvents ?? [] }),
                },
              ],
            }),
          )
          return
        }
        if (msg.method === "tribe.pending") {
          socket.write(
            makeResponse(msg.id, {
              content: [{ type: "text", text: JSON.stringify(opts.pendingResult ?? { balls: [] }) }],
            }),
          )
          return
        }
        if (msg.method === "tribe.inbox.wait") {
          socket.write(
            makeResponse(
              msg.id,
              opts.inboxWaitResult ?? {
                status: "timeout",
                session: "@agent/test",
                unread_count: 0,
                oldest_unread_age_min: 0,
                oldest_unread_ts: 0,
                waited_ms: 0,
                effective_timeout_ms: 30_000,
                timed_out: true,
                aborted: false,
                attention: {
                  actionable_unread: [],
                  pending_balls: [],
                  pending_balls_summary: { total: 0, oldest_age_ms: 0, truncated: false },
                },
              },
            ),
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
  opts: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const line = waitForLine(child, predicate, opts)
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

function initInstructions(init: Record<string, unknown>): string {
  return (init.result as { instructions?: string } | undefined)?.instructions ?? ""
}

/** The delivery capability a tools/list response advertises on inbox.wait. */
function inboxWaitCapability(
  list: Record<string, unknown>,
): { delivery?: string; acknowledgement?: { acknowledged: boolean; cause?: string } } | undefined {
  const tools = (list.result as { tools?: Array<{ name?: string; _meta?: Record<string, unknown> }> } | undefined)
    ?.tools
  return tools?.find((tool) => tool.name === "inbox.wait")?._meta?.["tribe.deliveryCapability"] as
    | { delivery?: string; acknowledgement?: { acknowledged: boolean; cause?: string } }
    | undefined
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

  // @failure 26564: configured push is not confirmed push; malformed register ACK must leave stdio/tools usable.
  // @level l2 @consumer native MCP delivery capability and startup confirmation
  it.each([
    { transportDelivery: undefined },
    { transportDelivery: "sometimes" },
    { delivery: undefined },
    { delivery: "pull" },
  ])("keeps tools open and capability pull for invalid register ACK %j", async (registerAck) => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath, { registerAck })
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "push",
        TRIBE_REQUIRE_JOIN: "0",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout = collectStdoutJson(child)
    const init = await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    await waitForCondition(() => daemon!.requests.some((r) => r.method === "tribe.members"), "registration banner")
    const list = await writeJsonAndWaitForLine(child, toolsListPayload(2), (line) => line.id === 2)
    expect(inboxWaitCapability(list)).toMatchObject({
      delivery: "pull",
      acknowledgement: { acknowledged: false, cause: expect.any(String) },
    })
    expect(initInstructions(init)).toContain("startup banner")
    const members = await writeJsonAndWaitForLine(child, callToolPayload(3, "members", {}), (line) => line.id === 3)
    expect(members).toHaveProperty("result.content")
    expect(child.exitCode).toBeNull()
    await waitForCondition(
      () => stdout.some((line) => JSON.stringify(line).includes("unacknowledged")),
      "unacknowledged startup cause",
    )
    await waitForCondition(
      () => readFileSync(join(tmpDir, "adapter.log"), "utf8").includes("delivery acknowledgement"),
      "acknowledgement diagnostic log",
    )
  })

  /**
   * @failure A tool call that throws inside the stdio adapter is caught and returned as a normal
   *          result with no isError, so a host that keys on isError reads a transport failure as
   *          success (@ag/tribe/27428).
   * @level l2
   * @consumer MCP CallToolResult consumers of both wire adapters
   */
  it("marks a thrown tool call as an error result instead of a successful one", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath, {
      toolError: { code: -32010, message: "daemon refused the tool call", method: "tribe.pending" },
    })
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    const refusal = await writeJsonAndWaitForLine(
      child,
      callToolPayload(2, "pending", { owner: "@agent/test" }),
      (line) => line.id === 2,
    )
    expect(refusal).toMatchObject({
      result: { isError: true, content: [{ text: expect.stringContaining("daemon refused the tool call") }] },
    })
  })

  it("pull delivery does not advertise or emit Claude-only channel notifications", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath, { registerAck: { delivery: "push" } })
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
    await waitForCondition(
      () => daemon!.requests.some((request) => request.method === "tribe.members"),
      "own pull ACK beside push sibling",
    )
    const list = await writeJsonAndWaitForLine(child, toolsListPayload(2), (line) => line.id === 2)
    expect(inboxWaitCapability(list)).toMatchObject({ delivery: "pull", acknowledgement: { acknowledged: true } })

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

  /**
   * @failure A managed daemon refuses a tokenless persona but stdio stays alive with advertised tools and retries.
   * @level l1
   * @consumer 26524: the daemon refusal is terminal and visible to the host.
   */
  it("exits on a managed daemon's missing identity token refusal before serving tools", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath, {
      registerError: {
        code: -32003,
        message:
          "register refused: explicit persona @chief has a missing HAB_ID_TOKEN; launch through hab or join without a persona name",
        data: { kind: "identity-token-missing" },
      },
    })
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@chief"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        HAB_ID_TOKEN: "",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stderr = new Promise<string>((resolveStderr) => {
      let output = ""
      child!.stderr.on("data", (chunk: Buffer | string) => {
        output += chunk.toString()
      })
      child!.stderr.on("close", () => resolveStderr(output))
    })
    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    const tool = await writeJsonAndWaitForLine(child, callToolPayload(2, "members", {}), (line) => line.id === 2)
    expect(tool).toMatchObject({
      result: { isError: true, content: [{ text: expect.stringContaining("HAB_ID_TOKEN") }] },
    })
    const [exit, errorText] = await Promise.all([waitForExit(child), stderr])
    expect(exit.code).toBe(2)
    expect(errorText).toContain("@chief")
    expect(errorText).toContain("HAB_ID_TOKEN")
    expect(daemon.requests.filter((request) => request.method === "register")).toHaveLength(1)
  })

  it("exits after a missing-token refusal on re-register instead of retrying", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath, {
      registerErrorAfter: 2,
      registerError: {
        code: -32003,
        message:
          "register refused: explicit persona @chief has a missing HAB_ID_TOKEN; launch through hab or join without a persona name",
        data: { kind: "identity-token-missing" },
      },
    })
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@chief"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        HAB_ID_TOKEN: "",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stderr = new Promise<string>((resolveStderr) => {
      let output = ""
      child!.stderr.on("data", (chunk: Buffer | string) => {
        output += chunk.toString()
      })
      child!.stderr.on("close", () => resolveStderr(output))
    })
    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    await waitForCondition(
      () => daemon!.requests.some((request) => request.method === "tribe.members"),
      "initial registration",
    )
    daemon.clients.at(-1)?.destroy()
    const [exit, errorText] = await Promise.all([waitForExit(child), stderr])
    expect(exit.code).toBe(2)
    expect(errorText).toContain("HAB_ID_TOKEN")
    expect(daemon.requests.filter((request) => request.method === "register")).toHaveLength(2)
  })

  it("21768: seeds a nested successor persona at initial register", async () => {
    // Live 2026-07-22: `@chief/@ci/next` failed the pre-seed predicate at the
    // SECOND sigil, so the seat registered unnamed and sat as `unknown-cmayz`
    // for 4m17s while everything addressed to its persona was dropped.
    // `$up @role/next` is a first-class launch surface, so every successor
    // rotation carried that blind window.
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath)
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_NAME: "@chief/@ci/next",
        TRIBE_REQUIRE_JOIN: "1",
        TRIBE_DELIVERY: "push",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)

    const register = daemon.requests.find((msg) => msg.method === "register") as
      | { params?: { name?: string } }
      | undefined
    expect(register?.params?.name).toBe("@chief/@ci/next")
  })

  it("21768: a well-formed sigil-less launch name still registers unnamed, not fatally", async () => {
    // The fail-loud line is MALFORMED vs. merely sigil-less. A bare name is a
    // legitimate unidentified session (the daemon accepts `ci`, `agent/7`), so
    // it must keep the old behaviour: not pre-seeded under require-join, joins
    // from inside. Drawing the line at "not an @persona" instead broke the
    // degrade and version-skew suites, which launch as `degrade-test` /
    // `skew-test`.
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath)
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "degrade-test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_REQUIRE_JOIN: "1",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)

    const register = daemon.requests.find((msg) => msg.method === "register") as
      | { params?: { name?: string } }
      | undefined
    expect(register).toBeDefined()
    expect(register?.params?.name).toBeUndefined()
  })

  it("21768: fails loudly when an explicitly requested launch name is malformed", async () => {
    // A name that could never be a valid tribe name is an operator error: the
    // daemon would reject it at register/join anyway, so degrading to an
    // `unknown-<rand>` placeholder only converts a fixable startup error into
    // minutes of silently dropped messages.
    const socketPath = join(tmpDir, "tribe.sock")
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_NAME: "@Chief Next",
        TRIBE_REQUIRE_JOIN: "1",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stderr = new Promise<string>((resolveStderr) => {
      let output = ""
      child!.stderr.on("data", (chunk: Buffer | string) => {
        output += chunk.toString()
      })
      child!.stderr.on("close", () => resolveStderr(output))
    })

    const [exit, errorText] = await Promise.all([waitForExit(child), stderr])
    expect(exit.code).not.toBe(0)
    expect(errorText).toContain('Invalid TRIBE_NAME="@Chief Next"')
  })

  it("declares a configured notification filter during initial registration", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath)
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@fleet"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "push",
        TRIBE_FILTER_MODE: "focus",
        TRIBE_NO_AUTOSTART: "1",
        TRIBE_REQUIRE_JOIN: "0",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)

    const register = daemon.requests.find((msg) => msg.method === "register") as
      | { params?: { name?: string; delivery?: string; filterMode?: string } }
      | undefined
    expect(register?.params).toMatchObject({ name: "@fleet", delivery: "push", filterMode: "focus" })
  })

  it("fails loudly on an invalid launch notification filter", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@fleet"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_FILTER_MODE: "everything",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stderr = new Promise<string>((resolveStderr) => {
      let output = ""
      child!.stderr.on("data", (chunk: Buffer | string) => {
        output += chunk.toString()
      })
      child!.stderr.on("close", () => resolveStderr(output))
    })

    const [exit, errorText] = await Promise.all([waitForExit(child), stderr])
    expect(exit.code).not.toBe(0)
    expect(errorText).toContain('Invalid TRIBE_FILTER_MODE="everything"; expected focus|normal|ambient')
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
        ...launchEnvironment("provider-launch-a"),
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
    expect(register?.params?.launchId).toBe("provider-launch-a::%40agent%2F9")
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
        ...launchEnvironment(""),
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

  // 25074 3c-2b (@cto def441bf): a seat launched by its token inherits no TRIBE_LAUNCH_ID. Its adapter registers by the
  // token with its launch parent pid, and the daemon keys it `<sid>@<gen>`.
  it("25074: a token with no launch id registers by the token and its launch parent pid, sending no launch id", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath)
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/9"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "pull",
        TRIBE_TAKEOVER: "1",
        TRIBE_LAUNCH_ID: "",
        HAB_ID_TOKEN: "seat-token",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)

    const register = daemon.requests.find((msg) => msg.method === "register") as
      | { params?: { launchId?: string; launchParentPid?: number; idToken?: string } }
      | undefined
    expect(register?.params?.idToken).toBe("seat-token")
    expect(register?.params && "launchId" in register.params).toBe(false)
    expect(register?.params?.launchParentPid).toBe(process.pid)
  })

  it("21049: takeover is a launch capability and is not replayed after reconnect", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath)
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

  // @failure 26564: a disconnected push adapter must withdraw its acknowledged push capability.
  // @level l2 @consumer tools/list through the native adapter during reconnect and recovery
  it("21049: repeated legacy reconnect conflicts keep native MCP alive, withdraw push, and recover", async () => {
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
        TRIBE_DELIVERY: "push",
        TRIBE_REQUIRE_JOIN: "0",
        TRIBE_PLUGIN_RESUME_JOINED: "0",
        TRIBE_TAKEOVER: "1",
        ...launchEnvironment(""),
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    // 21049 drives two full reconnect cycles through a real subprocess; the
    // shared waitForLine/waitForCondition defaults (2s / 3s) are sized for
    // simple single round trips and were the actual mechanism behind this
    // test's flakes under CI/full-suite contention — not an ordering race
    // (@km/tribe/ci-deflake-wire-daemon). Widened explicitly here rather than
    // raising the shared defaults, which 27 other call sites in this file
    // also rely on.
    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1, { timeoutMs: 10_000 })
    await waitForCondition(
      () => daemon!.requests.some((msg) => msg.method === "tribe.members"),
      "completed initial adapter registration",
      { timeoutMs: 10_000 },
    )
    await new Promise((resolveTick) => setTimeout(resolveTick, 50))

    const initialList = await writeJsonAndWaitForLine(child, toolsListPayload(1000), (line) => line.id === 1000)
    expect(inboxWaitCapability(initialList)).toMatchObject({ delivery: "push" })

    daemon.clients.at(-1)?.destroy()
    await waitForCondition(
      () => daemon!.requests.filter((msg) => msg.method === "register").length === 2,
      "transient reconnect registration conflict",
      { timeoutMs: 10_000 },
    )

    expect(child.exitCode).toBeNull()
    const disconnectedList = await writeJsonAndWaitForLine(child, toolsListPayload(1001), (line) => line.id === 1001)
    expect(inboxWaitCapability(disconnectedList)).toMatchObject({
      delivery: "pull",
      acknowledgement: { acknowledged: false, cause: expect.any(String) },
    })
    const closedReplyPromise = waitForLine(child, (line) => line.id === 2, { timeoutMs: 10_000 })
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
      { timeoutMs: 10_000 },
    )
    await new Promise((resolveTick) => setTimeout(resolveTick, 50))
    expect(child.exitCode).toBeNull()

    const repeatedClosedReplyPromise = waitForLine(child, (line) => line.id === 3, { timeoutMs: 10_000 })
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
      { timeoutMs: 10_000 },
    )
    // The daemon seeing the 4th register does not mean the client has installed
    // its successor yet; until it does, a call rejects with exactly the 22994
    // reconnect text and callers retry. Retry past only that text.
    type ToolReply = { result?: { isError?: boolean; content?: Array<{ text?: string }> } }
    let liveReply: ToolReply = {}
    for (let id = 4; id < 4 + 50; id++) {
      const replyPromise = waitForLine(child, (line) => line.id === id, { timeoutMs: 10_000 })
      writeJson(child, callToolPayload(id, "members", {}))
      liveReply = (await replyPromise) as ToolReply
      if (!liveReply.result?.content?.[0]?.text?.includes("daemon connection closed; reconnecting")) break
      await new Promise((resolveTick) => setTimeout(resolveTick, 100))
    }

    expect(child.exitCode).toBeNull()
    expect(liveReply.result?.isError).not.toBe(true)
    expect(liveReply.result?.content?.[0]?.text).toContain('"sessions":[]')
    const recoveredList = await writeJsonAndWaitForLine(child, toolsListPayload(1002), (line) => line.id === 1002)
    expect(inboxWaitCapability(recoveredList)).toMatchObject({
      delivery: "push",
      acknowledgement: { acknowledged: true },
    })
    const registrations = daemon.requests.filter((msg) => msg.method === "register") as Array<{
      params?: { takeover?: boolean }
    }>
    expect(registrations).toHaveLength(4)
    expect(registrations[1]?.params && "takeover" in registrations[1].params).toBe(false)
    expect(registrations[2]?.params && "takeover" in registrations[2].params).toBe(false)
    expect(registrations[3]?.params && "takeover" in registrations[3].params).toBe(false)
  }, 60_000)

  it("21049: a managed tool call recovers an initially unavailable daemon before reporting health", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const logPath = join(tmpDir, "adapter.log")
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@chief"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "pull",
        TRIBE_TAKEOVER: "1",
        ...launchEnvironment("provider-launch-a"),
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: logPath,
        LOG_LEVEL: "warn",
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
        status: "woken",
        session: "@agent/test",
        unread_count: 2,
        oldest_unread_age_min: 1,
        oldest_unread_ts: 123,
        waited_ms: 17,
        effective_timeout_ms: 5_000,
        timed_out: false,
        aborted: false,
        attention: {
          actionable_unread: [{ id: "request-1", content: "review this" }],
          pending_balls: [{ request_id: "request-1", recipient: "@agent/test" }],
          pending_balls_summary: { total: 1, oldest_age_ms: 500, truncated: false },
        },
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

    writeJson(
      child,
      callToolPayload(3, "inbox.wait", {
        session: "@agent/test",
        timeout_ms: 5_000,
        wake_on_correlated_reply: true,
      }),
    )
    const call = await waitForLine(child, (line) => line.id === 3)
    const content = ((call.result as { content?: Array<{ text?: string }> } | undefined)?.content ?? []) as Array<{
      text?: string
    }>
    const parsed = JSON.parse(content[0]?.text ?? "{}") as {
      status?: string
      session?: string
      unread_count?: number
      waited_ms?: number
      effective_timeout_ms?: number
      timed_out?: boolean
      aborted?: boolean
      attention?: {
        actionable_unread?: Array<{ id?: string }>
        pending_balls?: Array<{ request_id?: string }>
        pending_balls_summary?: { total?: number; oldest_age_ms?: number; truncated?: boolean }
      }
    }
    expect(parsed).toMatchObject({
      status: "woken",
      session: "@agent/test",
      unread_count: 2,
      waited_ms: 17,
      effective_timeout_ms: 5_000,
      timed_out: false,
      aborted: false,
      attention: {
        actionable_unread: [{ id: "request-1" }],
        pending_balls: [{ request_id: "request-1" }],
        pending_balls_summary: { total: 1, oldest_age_ms: 500, truncated: false },
      },
    })
    expect((call.result as { structuredContent?: unknown }).structuredContent).toMatchObject(parsed)

    const daemonRequest = daemon.requests.find((msg) => msg.method === "tribe.inbox.wait") as
      | { params?: { session?: string; timeout_ms?: number; wake_on_correlated_reply?: boolean } }
      | undefined
    expect(daemonRequest?.params).toMatchObject({
      session: "@agent/test",
      timeout_ms: 5_000,
      wake_on_correlated_reply: true,
    })

    writeJson(child, callToolPayload(4, "inbox.wait", { session: "@agent/test", timeout_ms: 600_000 }))
    const cutCall = await waitForLine(child, (line) => line.id === 4)
    const cutContent = ((cutCall.result as { content?: Array<{ text?: string }> } | undefined)?.content ??
      []) as Array<{
      text?: string
    }>
    const hostCut = JSON.parse(cutContent[0]?.text ?? "{}") as Record<string, unknown>
    expect(hostCut).toEqual({
      status: "host_cut",
      requested_ms: 600_000,
      ceiling_ms: 10_000,
      ceiling_source: "measured",
      advice: "cli_wait",
    })
    expect((cutCall.result as { structuredContent?: unknown }).structuredContent).toEqual(hostCut)
    expect(daemon.requests.filter((msg) => msg.method === "tribe.inbox.wait")).toHaveLength(1)
  })

  it("push delivery registers explicit persona as pull, says so, and suppresses channel notifications until tribe.join", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const joinAck: Record<string, unknown> = { joined: false, error: "join refused" }
    daemon = await spawnFakeDaemon(socketPath, { joinAck })
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "push",
        TRIBE_REQUIRE_JOIN: "1",
        TRIBE_PLUGIN_RESUME_JOINED: "0",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout = collectStdoutJson(child)

    writeJson(child, initializePayload(1))
    const init = await waitForLine(child, (line) => line.id === 1)
    // The channel stays declared so pushes can reach the model once it joins.
    expect(JSON.stringify(init)).toContain("claude/channel")
    // G9 P0 row 1: until tribe.join the daemon holds this session as pull, so the
    // model must be told pull. It was told "delivery=push ... do not poll", and
    // to wait for an auto-identify message the join gate never let through.
    const instructions = initInstructions(init)
    expect(instructions).toContain("delivery=pull")
    expect(instructions).toContain("This session is pull-delivery")
    expect(instructions).toContain("until this session calls tribe.join")
    expect(instructions).not.toContain("you do not need to fetch to receive them")
    expect(instructions).not.toContain("auto-identify")

    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    const listBeforeJoin = await writeJsonAndWaitForLine(child, toolsListPayload(2), (line) => line.id === 2)

    const register = daemon.requests.find((msg) => msg.method === "register") as
      | { params?: { name?: string; delivery?: string } }
      | undefined
    expect(register?.params?.name).toBe("@agent/test")
    expect(register?.params?.delivery).toBe("pull")
    expect(inboxWaitCapability(listBeforeJoin)?.delivery).toBe(register?.params?.delivery)

    daemon.clients[0]?.write(makeNotification("channel", { from: "chief", type: "request", content: "before" }))
    await new Promise((resolveTick) => setTimeout(resolveTick, 250))
    expect(
      stdout.some(
        (line) => line.method === "notifications/claude/channel" && JSON.stringify(line).includes('"before"'),
      ),
    ).toBe(false)

    await writeJsonAndWaitForLine(child, callToolPayload(3, "join", { name: "@agent/test" }), (line) => line.id === 3)
    const refusedList = await writeJsonAndWaitForLine(child, toolsListPayload(4), (line) => line.id === 4)
    expect(inboxWaitCapability(refusedList)?.delivery).toBe("pull")
    delete joinAck.joined
    delete joinAck.error
    await writeJsonAndWaitForLine(child, callToolPayload(5, "join", { name: "@agent/test" }), (line) => line.id === 5)
    const joinRequest = daemon.requests.find((msg) => msg.method === "tribe.join") as
      | { params?: { delivery?: string } }
      | undefined
    expect(joinRequest?.params?.delivery).toBe("push")
    const listAfterJoin = await writeJsonAndWaitForLine(child, toolsListPayload(6), (line) => line.id === 6)
    expect(inboxWaitCapability(listAfterJoin)?.delivery).toBe(joinRequest?.params?.delivery)

    daemon.clients[0]?.write(makeNotification("channel", { from: "chief", type: "request", content: "after" }))
    const channel = await waitForLine(child, (line) => line.method === "notifications/claude/channel")
    expect(JSON.stringify(channel)).toContain("after")
  })

  it("a push persona starts conservatively and confirms push only after its own registration ACK", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath)
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "push",
        TRIBE_REQUIRE_JOIN: "0",
        TRIBE_PLUGIN_RESUME_JOINED: "0",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    const init = await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    const instructions = initInstructions(init)
    expect(instructions).toContain("delivery=pull")
    expect(instructions).toContain("startup banner")
    expect(instructions).not.toContain("you do not need to fetch to receive them")
    expect(instructions).not.toContain("until this session calls tribe.join")

    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    await waitForCondition(() => daemon!.requests.some((msg) => msg.method === "tribe.members"), "registration ACK")
    const list = await writeJsonAndWaitForLine(child, toolsListPayload(2), (line) => line.id === 2)
    await waitForCondition(() => daemon!.requests.some((msg) => msg.method === "register"), "register")
    const register = daemon.requests.find((msg) => msg.method === "register") as
      | { params?: { delivery?: string } }
      | undefined
    expect(register?.params?.delivery).toBe("push")
    expect(inboxWaitCapability(list)?.delivery).toBe(register?.params?.delivery)
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
      () =>
        stdout.filter(
          (line) =>
            line.method === "notifications/claude/channel" &&
            (line.params as { meta?: { from?: string } })?.meta?.from !== "tribe-startup",
        ).length === MAX_REPLAY_EVENTS,
    )

    const channels = stdout.filter(
      (line) =>
        line.method === "notifications/claude/channel" &&
        (line.params as { meta?: { from?: string } })?.meta?.from !== "tribe-startup",
    )
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

  it("forwards attention actionables before capped ambient replay", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const recentTs = new Date().toISOString()
    const fetchEvents = Array.from({ length: MAX_REPLAY_EVENTS + 5 }, (_, i) => ({
      id: `ambient-${i}`,
      type: "status",
      from: "daemon",
      content: `ambient-${i}`,
      ts: recentTs,
    }))
    daemon = await spawnFakeDaemon(socketPath, {
      fetchEvents,
      fetchAttention: {
        actionable_unread: [
          {
            id: "late-verdict",
            type: "verdict",
            from: "@ci",
            content: "REVISE before continuing ordinary work",
            ts: recentTs,
          },
        ],
        pending_balls: [],
      },
    })
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

    await waitForStdout(child, stdout, () =>
      stdout.some((line) => JSON.stringify(line).includes("REVISE before continuing ordinary work")),
    )

    const channels = stdout.filter(
      (line) =>
        line.method === "notifications/claude/channel" &&
        (line.params as { meta?: { from?: string } })?.meta?.from !== "tribe-startup",
    )
    const verdict = channels.find((line) => JSON.stringify(line).includes("late-verdict"))
    expect(verdict).toBeDefined()
    expect(channels.indexOf(verdict!)).toBe(0)

    // 21757 — the wake-up drain is not a model read. Every fetch it sends
    // carries receipt:false, so the daemon neither acknowledges the mailbox
    // nor stamps an attention read; the verdict above stays owed to the
    // model's own in-turn read. Positive control: the drain DID fetch.
    const drainFetches = daemon.requests.filter((msg) => msg.method === "tribe.fetch") as Array<{
      params?: { limit?: number; receipt?: unknown }
    }>
    expect(drainFetches.length).toBeGreaterThanOrEqual(1)
    for (const fetch of drainFetches) {
      expect(fetch.params?.limit).toBe(500)
      expect(fetch.params?.receipt).toBe(false)
    }
  })

  it("never forwards an incident row as a channel envelope — the row's own kind decides (27488 phase 1, @cto Q3)", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const recentTs = new Date().toISOString()
    daemon = await spawnFakeDaemon(socketPath, {
      // The incident OPEN edge is a wake edge, so the daemon returns it in the
      // ambient events window; it sits beside an ordinary message row.
      fetchEvents: [
        {
          id: "incident-open-edge",
          type: "health:bridge-lost",
          from: "tribe-health",
          content: "MACHINE-BODY @dev/3's tribe bridge is lost",
          ts: recentTs,
          is_incident: true,
        },
        {
          id: "peer-notice",
          type: "status",
          from: "@daemon",
          content: "HUMAN-MESSAGE migrate finished",
          ts: recentTs,
          is_incident: false,
        },
      ],
      fetchAttention: {
        actionable_unread: [
          // Defensive: even if an incident ever reached attention, the kind still suppresses it.
          {
            id: "incident-in-attention",
            type: "request",
            from: "vault-db-page",
            content: "MACHINE-ATTENTION-LEAK",
            ts: recentTs,
            is_incident: true,
          },
          {
            id: "peer-request",
            type: "request",
            from: "@chief",
            content: "PEER-REQUEST-BODY",
            ts: recentTs,
            is_incident: false,
          },
        ],
        pending_balls: [],
      },
    })
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
    const channels = () =>
      stdout.filter(
        (line) =>
          line.method === "notifications/claude/channel" &&
          (line.params as { meta?: { from?: string } })?.meta?.from !== "tribe-startup",
      )

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    await writeJsonAndWaitForLine(child, callToolPayload(2, "join", { name: "@agent/test" }), (line) => line.id === 2)
    daemon.clients[0]?.write(makeNotification("wakeup", {}))

    await waitForStdout(child, stdout, () =>
      channels().some((line) => JSON.stringify(line).includes("PEER-REQUEST-BODY")),
    )
    await new Promise((resolveTick) => setTimeout(resolveTick, 250))
    const payloads = channels().map((line) => JSON.stringify(line))
    // The incident rows never become envelope content…
    expect(payloads.some((payload) => payload.includes("MACHINE-BODY"))).toBe(false)
    expect(payloads.some((payload) => payload.includes("MACHINE-ATTENTION-LEAK"))).toBe(false)
    // …while ordinary message rows still do (positive control).
    expect(payloads.some((payload) => payload.includes("HUMAN-MESSAGE"))).toBe(true)
    expect(payloads.some((payload) => payload.includes("PEER-REQUEST-BODY"))).toBe(true)
  })

  it("documents the authority hole: a CallTool fetch is a receipt whoever issued it — the adapter has no subagent-origin signal to honor (21757)", async () => {
    // An in-process subagent shares the seat's MCP connection. Its
    // tribe.fetch arrives as an ordinary CallTool, and the daemon treats a
    // model-initiated read as a receipt: the rows are acknowledged for a
    // steering model that never saw them, and health:inbox-stale cannot see
    // it because the cursor moved. The host sends no origin marker today
    // (nothing in the CallTool params is read for one), so the adapter
    // cannot pass receipt:false on a fork's behalf. This test pins the
    // hole as executable: when the host marks subagent-origin calls, the
    // adapter must pass receipt:false for them and this assertion flips.
    // Filed as its own bead; @cto ruling 2026-09-04 on 21757 v2.
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath, {
      fetchEvents: [],
      fetchAttention: { actionable_unread: [], pending_balls: [] },
    })
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: { ...process.env, TRIBE_DELIVERY: "push", TRIBE_NO_AUTOSTART: "1", DEBUG_LOG: join(tmpDir, "adapter.log") },
      stdio: ["pipe", "pipe", "pipe"],
    })
    void collectStdoutJson(child)
    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    await writeJsonAndWaitForLine(child, callToolPayload(2, "join", { name: "@agent/test" }), (line) => line.id === 2)

    // A fetch carrying origin metadata a host MIGHT one day attach.
    await writeJsonAndWaitForLine(
      child,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "fetch", arguments: {}, _meta: { "claude/subagent": true, origin: "fork" } },
      },
      (line) => line.id === 3,
    )
    const modelFetches = daemon.requests.filter((msg) => msg.method === "tribe.fetch") as Array<{
      params?: { receipt?: unknown }
    }>
    expect(modelFetches.length).toBeGreaterThanOrEqual(1)
    // The hole: no marker is honored, so this fetch is sent as a receipt.
    expect(modelFetches.at(-1)?.params?.receipt).not.toBe(false)
  })

  it("forwards one compact pending-ball summary, then suppresses an unchanged re-drain", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const fetchAttention = {
      actionable_unread: [],
      pending_balls_summary: {
        total: 108,
        oldest_age_ms: 9 * 24 * 60 * 60 * 1_000,
        truncated: true,
        withheld: {
          total: 98,
          by_kind: { request: 8, incident: 90 },
        },
      },
      pending_balls: [
        {
          request_id: "review-r3",
          sender: "@chief",
          message_id: "original-review-request",
          fanout: "first",
          age_ms: 2 * 60 * 60 * 1_000,
          summary: "Review the architecture revision",
        },
        {
          request_id: "query-r4",
          sender: "@agent/4",
          message_id: "second-query",
          fanout: "first",
          age_ms: 70 * 60 * 1_000,
          summary: "Confirm the migration invariant",
        },
        {
          request_id: "assign-r5",
          sender: "@chief",
          message_id: "third-assignment",
          fanout: "first",
          age_ms: 30 * 60 * 1_000,
          summary: "Run the focused verification",
        },
        {
          request_id: "request-r6",
          sender: "@agent/6",
          message_id: "fourth-request",
          fanout: "first",
          age_ms: 10 * 60 * 1_000,
          summary: "This fourth summary must be omitted",
        },
      ],
    }
    daemon = await spawnFakeDaemon(socketPath, { fetchAttention })
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
    const summaryLines = (text: string) =>
      stdout.filter((line) => line.method === "notifications/claude/channel" && JSON.stringify(line).includes(text))

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    await writeJsonAndWaitForLine(child, callToolPayload(2, "join", { name: "@agent/test" }), (line) => line.id === 2)

    const summaryText =
      "You own 108 balls, oldest 9d. Top: Review the architecture revision | Confirm the migration invariant | Run the focused verification Preview withheld 98 (8 request, 90 incident)."
    daemon.clients[0]?.write(makeNotification("wakeup", {}))
    await waitForStdout(child, stdout, () => summaryLines(summaryText).length === 1)

    const pending = summaryLines(summaryText)
    expect(pending).toHaveLength(1)
    expect(JSON.stringify(pending[0])).toContain('"type":"attention:pending-balls"')
    expect(JSON.stringify(pending[0])).not.toContain("This fourth summary must be omitted")

    // 27346: a re-drain of the SAME set fetches again but must not repeat the line.
    const fetchesBeforeSecondWake = daemon.requests.filter((request) => request.method === "tribe.fetch").length
    daemon.clients[0]?.write(makeNotification("wakeup", {}))
    await waitForCondition(
      () => daemon!.requests.filter((request) => request.method === "tribe.fetch").length > fetchesBeforeSecondWake,
      "second pending-ball fetch",
    )
    await new Promise((resolveTick) => setTimeout(resolveTick, 300))
    expect(summaryLines(summaryText)).toHaveLength(1)

    // A new ball outside the preview changes the total → the line re-surfaces.
    fetchAttention.pending_balls_summary.total = 109
    fetchAttention.pending_balls.push({
      request_id: "request-r7",
      sender: "@agent/7",
      message_id: "fifth-request",
      fanout: "first",
      age_ms: 1_000,
      summary: "A newly arrived ball",
    })
    daemon.clients[0]?.write(makeNotification("wakeup", {}))
    const grownText =
      "You own 109 balls, oldest 9d. Top: Review the architecture revision | Confirm the migration invariant | Run the focused verification Preview withheld 98 (8 request, 90 incident)."
    await waitForStdout(child, stdout, () => summaryLines(grownText).length === 1)
    expect(summaryLines(summaryText)).toHaveLength(1)
  })

  it("re-surfaces an unchanged pending-ball summary once the window elapses (#27346)", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const fetchAttention = {
      actionable_unread: [],
      pending_balls_summary: { total: 1, oldest_age_ms: 60_000, truncated: false },
      pending_balls: [{ request_id: "only-r1", sender: "@chief", age_ms: 60_000, summary: "The only ball" }],
    }
    daemon = await spawnFakeDaemon(socketPath, { fetchAttention })
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "push",
        TRIBE_NO_AUTOSTART: "1",
        // 27346: shrunk window so the 10-minute recurrence is testable without waiting.
        TRIBE_PENDING_BALL_SUMMARY_WINDOW_MS: "300",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout = collectStdoutJson(child)
    const summaryText = "You own 1 ball, oldest 1m. Top: The only ball"
    const summaryLines = () =>
      stdout.filter(
        (line) => line.method === "notifications/claude/channel" && JSON.stringify(line).includes(summaryText),
      )

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    await writeJsonAndWaitForLine(child, callToolPayload(2, "join", { name: "@agent/test" }), (line) => line.id === 2)

    daemon.clients[0]?.write(makeNotification("wakeup", {}))
    await waitForStdout(child, stdout, () => summaryLines().length === 1)

    const fetchesBefore = daemon.requests.filter((request) => request.method === "tribe.fetch").length
    await new Promise((resolveTick) => setTimeout(resolveTick, 600))
    daemon.clients[0]?.write(makeNotification("wakeup", {}))
    await waitForCondition(
      () => daemon!.requests.filter((request) => request.method === "tribe.fetch").length > fetchesBefore,
      "window-elapsed pending-ball fetch",
    )
    await waitForStdout(child, stdout, () => summaryLines().length === 2)
  })

  // #27459 gap-7 acceptance (@chief, plat gap 7): the open-ball summary line is
  // a pane handoff too, so an adapter RESTART must not re-present an unchanged
  // "You own N balls ..." line. The throttle fingerprint lives in the same
  // durable ledger as the forwarded-id set, and the throttle still fires on a
  // real change after the restart.
  it("does not re-present an unchanged pending-ball summary across an adapter restart (#27459 gap-7)", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const fetchAttention = {
      actionable_unread: [],
      pending_balls_summary: { total: 1, oldest_age_ms: 60_000, truncated: false },
      pending_balls: [{ request_id: "gap7-r1", sender: "@chief", age_ms: 60_000, summary: "The only ball" }],
    }
    const env = {
      ...process.env,
      TRIBE_DELIVERY: "push",
      TRIBE_NO_AUTOSTART: "1",
      TRIBE_DELIVERY_LEDGER_DIR: tmpDir,
      // Keep the 10-minute recurrence out of the way: this test is about the
      // restart, not the window reminder.
      TRIBE_PENDING_BALL_SUMMARY_WINDOW_MS: "600000",
      DEBUG_LOG: join(tmpDir, "adapter.log"),
    }
    daemon = await spawnFakeDaemon(socketPath, { fetchAttention })
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const forwarders: Array<() => string[]> = []
    const collect = () => {
      const stdout = collectStdoutJson(child!)
      forwarders.push(() =>
        stdout
          .filter((line) => line.method === "notifications/claude/channel")
          .map((line) => JSON.stringify(line) as string),
      )
    }
    collect()
    const text = () => forwarders.flatMap((forwarded) => forwarded())
    const countOf = (needle: string) => text().filter((line) => line.includes(needle)).length
    const summaryText = "You own 1 ball, oldest 1m. Top: The only ball"
    const handshake = async () => {
      await writeJsonAndWaitForLine(child!, initializePayload(1), (line) => line.id === 1)
      writeJson(child!, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
      await writeJsonAndWaitForLine(
        child!,
        callToolPayload(2, "join", { name: "@agent/test" }),
        (line) => line.id === 2,
      )
    }
    const drain = async (label: string) => {
      const before = daemon!.requests.filter((request) => request.method === "tribe.fetch").length
      daemon!.clients.at(-1)?.write(makeNotification("wakeup", {}))
      await waitForCondition(
        () => daemon!.requests.filter((request) => request.method === "tribe.fetch").length > before,
        label,
      )
      await new Promise((resolveTick) => setTimeout(resolveTick, 150))
    }

    await handshake()
    await drain("gap-7 first drain")
    expect(countOf(summaryText)).toBe(1)
    const ledgerPath = join(tmpDir, "tribe-delivery-v2-@agent%2Ftest.json")
    await waitForCondition(() => existsSync(ledgerPath), "gap-7 delivery ledger")

    child!.kill("SIGTERM")
    await waitForExit(child!)
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    collect()
    await handshake()
    await drain("gap-7 post-restart drain")

    // RED before gap-7: the in-memory-only throttle reset on restart, so this read 2.
    expect(countOf(summaryText)).toBe(1)

    // The throttle still fires on a real change AFTER the restart.
    fetchAttention.pending_balls_summary.total = 2
    fetchAttention.pending_balls.push({
      request_id: "gap7-r2",
      sender: "@chief",
      age_ms: 1_000,
      summary: "A newly arrived ball",
    })
    await drain("gap-7 changed-set drain")
    const grownText = "You own 2 balls, oldest 1m. Top: The only ball | A newly arrived ball"
    await waitForCondition(() => countOf(grownText) >= 1, "gap-7 grown summary")
    expect(countOf(summaryText)).toBe(1)
  })

  it("forwards each attention row once, keeping re-presented rows and ambient twins out (#27346)", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const recentTs = new Date().toISOString()
    // A durable-mailbox RECOVERY row that predates this seat: the daemon marks it
    // `replay:true` (registration tail-reset) even though this pane never saw it,
    // so it MUST still forward on its first delivery.
    const recoveryRow = {
      id: "recovered-request",
      type: "request",
      from: "@chief",
      content: "RECOVERY-ROW",
      ts: recentTs,
      replay: true,
    }
    // A row with no `replay` field at all (legacy daemon) must forward (fail open).
    const legacyRow = { id: "legacy-verdict", type: "verdict", from: "@ci", content: "LEGACY-NO-FIELD", ts: recentTs }
    const fetchAttention: {
      actionable_unread: Array<Record<string, unknown>>
      pending_balls: Array<Record<string, unknown>>
    } = { actionable_unread: [legacyRow, recoveryRow], pending_balls: [] }
    // Same id as the recovery row: the ambient path must NOT re-forward it.
    const fetchEvents = [
      { id: "recovered-request", type: "status", from: "daemon", content: "RECOVERY-AMBIENT", ts: recentTs },
    ]
    daemon = await spawnFakeDaemon(socketPath, { fetchAttention, fetchEvents })
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
    const channelText = () =>
      stdout
        .filter((line) => line.method === "notifications/claude/channel")
        .map((line) => JSON.stringify(line) as string)
    const drain = async (label: string) => {
      const before = daemon!.requests.filter((request) => request.method === "tribe.fetch").length
      daemon!.clients[0]?.write(makeNotification("wakeup", {}))
      await waitForCondition(
        () => daemon!.requests.filter((request) => request.method === "tribe.fetch").length > before,
        label,
      )
      await new Promise((resolveTick) => setTimeout(resolveTick, 250))
    }

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    await writeJsonAndWaitForLine(child, callToolPayload(2, "join", { name: "@agent/test" }), (line) => line.id === 2)

    // First delivery: both actionable rows forward (the recovery row despite
    // replay:true); the ambient twin does not.
    await drain("first replay-filter fetch")
    expect(channelText().some((line) => line.includes("LEGACY-NO-FIELD"))).toBe(true)
    expect(channelText().some((line) => line.includes("RECOVERY-ROW"))).toBe(true)
    expect(channelText().some((line) => line.includes("RECOVERY-AMBIENT"))).toBe(false)

    // Second drain of the same rows → nothing new reaches the pane.
    await drain("second replay-filter fetch")
    expect(channelText().filter((line) => line.includes("LEGACY-NO-FIELD"))).toHaveLength(1)
    expect(channelText().filter((line) => line.includes("RECOVERY-ROW"))).toHaveLength(1)

    // A genuinely new row still forwards on arrival.
    fetchAttention.actionable_unread = [
      ...fetchAttention.actionable_unread,
      { id: "fresh-verdict", type: "verdict", from: "@ci", content: "FRESH-ROW", ts: recentTs },
    ]
    await drain("third replay-filter fetch")
    expect(channelText().filter((line) => line.includes("FRESH-ROW"))).toHaveLength(1)
  })

  // #27459 — the independent per-pane delivery counter. Two drains of the same
  // two attention rows: four PRESENTATIONS, two DELIVERIES (the first of each id),
  // and two SUPPRESSED re-presentations. The durable first-handoff ledger is
  // written under the kpi dir so a restart can still call a re-handoff duplicate.
  it("counts presentations and deliveries across two drains, and persists the per-pane ledger (#27459)", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const recentTs = new Date().toISOString()
    const fetchAttention = {
      actionable_unread: [
        { id: "count-row-a", type: "request", from: "@chief", content: "COUNT-A", ts: recentTs },
        { id: "count-row-b", type: "verdict", from: "@ci", content: "COUNT-B", ts: recentTs },
      ],
      pending_balls: [],
    }
    daemon = await spawnFakeDaemon(socketPath, { fetchAttention })
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "push",
        TRIBE_NO_AUTOSTART: "1",
        TRIBE_DELIVERY_LEDGER_DIR: tmpDir,
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    collectStdoutJson(child)
    const drain = async (label: string) => {
      const before = daemon!.requests.filter((request) => request.method === "tribe.fetch").length
      daemon!.clients[0]?.write(makeNotification("wakeup", {}))
      await waitForCondition(
        () => daemon!.requests.filter((request) => request.method === "tribe.fetch").length > before,
        label,
      )
      await new Promise((resolveTick) => setTimeout(resolveTick, 250))
    }

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    await writeJsonAndWaitForLine(child, callToolPayload(2, "join", { name: "@agent/test" }), (line) => line.id === 2)

    await drain("first counted drain")
    await drain("second counted drain")

    const ledgerPath = join(tmpDir, "tribe-delivery-v2-@agent%2Ftest.json")
    await waitForCondition(() => existsSync(ledgerPath), "delivery ledger written")
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      ids: string[]
      counters: Record<string, number>
      coverage: { restarts: number; gap: boolean }
    }
    expect(ledger.counters.presentations).toBe(4)
    expect(ledger.counters.deliveries).toBe(2)
    expect(ledger.counters.newDeliveries).toBe(2)
    expect(ledger.counters.duplicateDeliveries).toBe(0)
    expect(ledger.counters.duplicatePresentations).toBe(2)
    expect(ledger.counters.suppressed).toBe(2)
    expect([...ledger.ids].sort()).toEqual(["count-row-a", "count-row-b"])
  })

  // #28283 — a save that FAILS must not leave a window that later reads as a
  // complete total. Driven through the real adapter: the ledger file's directory
  // is made read-only to fail the write, then restored, and the write that finally
  // lands must carry the gap, so the report reads the window unmeasured rather
  // than as a silent complete total. The failure must also be logged, not
  // swallowed — the "loud" half of the acceptance.
  it("marks the window a gap when a ledger save fails, so it never reads as a complete total (#28283)", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const recentTs = new Date().toISOString()
    const fetchAttention = {
      actionable_unread: [{ id: "gap-row-a", type: "request", from: "@chief", content: "GAP-A", ts: recentTs }],
      pending_balls: [],
    }
    daemon = await spawnFakeDaemon(socketPath, { fetchAttention })
    const ledgerDir = join(tmpDir, "ledger")
    mkdirSync(ledgerDir)
    const ledgerPath = join(ledgerDir, "pane.json")
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "push",
        TRIBE_NO_AUTOSTART: "1",
        TRIBE_DELIVERY_LEDGER: ledgerPath,
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    collectStdoutJson(child)
    const drain = async (label: string) => {
      const before = daemon!.requests.filter((request) => request.method === "tribe.fetch").length
      daemon!.clients[0]?.write(makeNotification("wakeup", {}))
      await waitForCondition(
        () => daemon!.requests.filter((request) => request.method === "tribe.fetch").length > before,
        label,
      )
      await new Promise((resolveTick) => setTimeout(resolveTick, 250))
    }
    const loadedState = () => loadDeliveryLedger(ledgerPath).state

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    await writeJsonAndWaitForLine(child, callToolPayload(2, "join", { name: "@agent/test" }), (line) => line.id === 2)

    await drain("first counted drain")
    await waitForCondition(() => existsSync(ledgerPath), "first delivery ledger written")
    expect(loadedState()?.coverage.gap).toBe(false)

    try {
      // Refuse the next write: a directory we cannot create a file in fails the save.
      chmodSync(ledgerDir, 0o500)
      await drain("drain with an unwritable ledger directory")
      await waitForCondition(
        () => readFileSync(join(tmpDir, "adapter.log"), "utf8").includes("Failed to persist tribe delivery ledger"),
        "the failed save must be logged, not swallowed",
      )
      // The failed write left only the last window that landed — still clean on disk.
      expect(loadedState()?.coverage.gap).toBe(false)
    } finally {
      chmodSync(ledgerDir, 0o700)
    }

    await drain("drain after the ledger directory is writable again")
    await waitForCondition(() => loadedState()?.coverage.gap === true, "the gap carried by the next landed save")
    const landed = loadedState()
    expect(landed?.coverage.gapReason).toBe("write")
    // The report reads the window unmeasured, never a clean total, and never fires the alert.
    const row = buildFleetDeliveryReport({ states: landed ? [landed] : [], now: Date.now() }).seats.find(
      (seat) => seat.pane === "@agent/test",
    )
    expect(row?.complete).toBe(false)
    expect(row?.alertInconclusive).toBe(true)
    expect(row?.alert).toBe(false)
  })

  // #28378 — a channel notification the host transport REJECTED is not a
  // completed handoff. The failed row must not enter the forwarded-id record,
  // the delivery counter or the durable ledger; the next healthy drain must be
  // able to forward the same row again; and the transport's cause must reach
  // the adapter log rather than being swallowed. The reviewed reproduction
  // injected exactly this rejection at the SDK transport boundary, so the
  // fixture patches that one seam and imports the real adapter unchanged.
  it("does not record a rejected channel notification as delivered, retries it, and surfaces the cause (#28378)", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const ledgerPath = join(tmpDir, "fault-ledger.json")
    const faultLog = join(tmpDir, "fault-attempts.jsonl")
    const adapterLog = join(tmpDir, "adapter.log")
    const recentTs = new Date().toISOString()
    const faultRow = { id: "fault-row-28378", type: "request", from: "@chief", content: "FAULT-ROW", ts: recentTs }
    const controlRow = {
      id: "control-row-28378",
      type: "request",
      from: "@chief",
      content: "CONTROL-ROW",
      ts: recentTs,
    }
    const fetchAttention: {
      actionable_unread: Array<Record<string, unknown>>
      pending_balls: Array<Record<string, unknown>>
    } = {
      actionable_unread: [],
      pending_balls: [],
    }
    daemon = await spawnFakeDaemon(socketPath, { fetchAttention })
    child = spawn(BUN_BIN, [FAULT_ENTRY, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "push",
        TRIBE_NO_AUTOSTART: "1",
        TRIBE_DELIVERY_LEDGER: ledgerPath,
        PROBE_FAULT_LOG: faultLog,
        DEBUG_LOG: adapterLog,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout = collectStdoutJson(child)
    const channelText = () =>
      stdout.filter((line) => line.method === "notifications/claude/channel").map((line) => JSON.stringify(line))
    const attempts = (): string[] =>
      existsSync(faultLog)
        ? readFileSync(faultLog, "utf8")
            .split("\n")
            .filter((row) => row.length > 0)
        : []
    const readLedger = () =>
      JSON.parse(readFileSync(ledgerPath, "utf8")) as { ids: string[]; counters: Record<string, number> }
    const drain = async (label: string) => {
      const before = daemon!.requests.filter((request) => request.method === "tribe.fetch").length
      daemon!.clients.at(-1)?.write(makeNotification("wakeup", {}))
      await waitForCondition(
        () => daemon!.requests.filter((request) => request.method === "tribe.fetch").length > before,
        label,
      )
      await new Promise((resolveTick) => setTimeout(resolveTick, 250))
    }

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    await writeJsonAndWaitForLine(child, callToolPayload(2, "join", { name: "@agent/test" }), (line) => line.id === 2)

    // First drain: the only row's notification is rejected by the transport.
    fetchAttention.actionable_unread = [faultRow]
    await drain("first faulted drain")
    await waitForCondition(() => attempts().length === 1, "one rejected send attempt")
    expect(channelText().some((line) => line.includes("FAULT-ROW"))).toBe(false)
    await waitForCondition(() => existsSync(ledgerPath), "the per-pane ledger written")
    const afterFailure = readLedger()
    expect(afterFailure.ids).not.toContain(faultRow.id)
    expect(afterFailure.counters.deliveries).toBe(0)
    expect(afterFailure.counters.newDeliveries).toBe(0)
    await waitForCondition(
      () => existsSync(adapterLog) && readFileSync(adapterLog, "utf8").includes("TEST_FAULT_SEND_REJECTED"),
      "the transport cause surfaced on the adapter log",
    )

    // Second drain: the same row is offered again and now its send succeeds.
    fetchAttention.actionable_unread = [faultRow, controlRow]
    await drain("second healthy drain")
    await waitForCondition(() => attempts().length === 2, "the rejected row retried")
    await waitForCondition(
      () => channelText().some((line) => line.includes("FAULT-ROW")),
      "the retried row forwarded to the host",
    )
    await waitForCondition(() => readLedger().ids.includes(faultRow.id), "the retried row recorded as delivered")
    expect(channelText().filter((line) => line.includes("CONTROL-ROW"))).toHaveLength(1)
    const afterRetry = readLedger()
    expect([...afterRetry.ids].sort()).toEqual([faultRow.id, controlRow.id].sort())
    expect(afterRetry.counters.deliveries).toBe(2)
  })

  // #28378 REVIEW (@dev/6) — the LIVE channel-push path. A push with no message
  // id fails open (nothing to record), but its rejection must still be consumed
  // and surfaced: an unhandled rejection here exited the adapter. The next
  // healthy ID-less push must reach the host on the same running adapter.
  it("survives a rejected ID-less channel push and still forwards the next one (#28378)", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const adapterLog = join(tmpDir, "adapter.log")
    const faultLog = join(tmpDir, "fault-attempts.jsonl")
    daemon = await spawnFakeDaemon(socketPath, { fetchAttention: { actionable_unread: [], pending_balls: [] } })
    child = spawn(BUN_BIN, [FAULT_ENTRY, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "push",
        TRIBE_NO_AUTOSTART: "1",
        TRIBE_DELIVERY_LEDGER: join(tmpDir, "push-ledger.json"),
        PROBE_FAULT_LOG: faultLog,
        DEBUG_LOG: adapterLog,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout = collectStdoutJson(child)
    const channelText = () =>
      stdout.filter((line) => line.method === "notifications/claude/channel").map((line) => JSON.stringify(line))

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    await writeJsonAndWaitForLine(child, callToolPayload(2, "join", { name: "@agent/test" }), (line) => line.id === 2)

    daemon.clients
      .at(-1)
      ?.write(makeNotification("channel", { from: "chief", type: "request", content: "FAULT-ROW id-less push" }))
    await waitForCondition(() => existsSync(faultLog), "the ID-less push attempted")
    await waitForCondition(
      () => existsSync(adapterLog) && readFileSync(adapterLog, "utf8").includes("TEST_FAULT_SEND_REJECTED"),
      "the ID-less push cause surfaced on the adapter log",
    )
    expect(child.exitCode).toBeNull()

    daemon.clients
      .at(-1)
      ?.write(makeNotification("channel", { from: "chief", type: "request", content: "HEALTHY-IDLESS-PUSH" }))
    await waitForCondition(
      () => channelText().some((line) => line.includes("HEALTHY-IDLESS-PUSH")),
      "the next healthy ID-less push forwarded",
    )
    expect(child.exitCode).toBeNull()
  })

  // #27459 REVISE (@dev/11): a restart RESUMES the in-flight 4h window, so the
  // first persist after it must carry the ledger cumulative same-window totals
  // forward — not overwrite them from the fresh in-memory counter. Before the
  // fix, `restore` seeded only the id set, so the next snapshot read all-zero
  // while windowStart stayed put: a silent under-count the 4h report would
  // render as a clean 0 with gap:false.
  it("keeps the resumed same-window counter totals across an adapter restart (#27459 REVISE)", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    // Resume the current filename, retaining schema-v1 counter conversion.
    const ledgerPath = join(tmpDir, "tribe-delivery-v2-@agent%2Ftest.json")
    const v2Path = ledgerPath
    const windowStartMs = Date.now() - 60_000
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        version: 1,
        pane: "@agent/test",
        windowStartMs,
        updatedAtMs: windowStartMs,
        ids: ["seed-row-a", "seed-row-b"],
        counters: {
          presentations: 120,
          newPresentations: 100,
          duplicatePresentations: 20,
          deliveries: 100,
          newDeliveries: 80,
          duplicateDeliveries: 20,
          duplicateBytes: 700,
          suppressed: 20,
        },
        pendingBallSummary: null,
        coverage: { restarts: 1, gap: false, gapReason: "none" },
      }),
      "utf8",
    )
    // No new activity: this drain exists only to make the adapter load and
    // re-persist the resumed window.
    const fetchAttention = { actionable_unread: [], pending_balls: [] }
    daemon = await spawnFakeDaemon(socketPath, { fetchAttention })
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "push",
        TRIBE_NO_AUTOSTART: "1",
        TRIBE_DELIVERY_LEDGER_DIR: tmpDir,
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    collectStdoutJson(child)

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    await writeJsonAndWaitForLine(child, callToolPayload(2, "join", { name: "@agent/test" }), (line) => line.id === 2)

    const before = daemon.requests.filter((request) => request.method === "tribe.fetch").length
    daemon.clients[0]?.write(makeNotification("wakeup", {}))
    await waitForCondition(
      () => daemon!.requests.filter((request) => request.method === "tribe.fetch").length > before,
      "REVISE restore drain",
    )
    // The fetch request is not a completed drain: wait for the adapter's first
    // persist rather than reading the seed ledger while the child is delayed.
    await waitForCondition(
      () => (JSON.parse(readFileSync(v2Path, "utf8")) as { updatedAtMs: number }).updatedAtMs > windowStartMs,
      "REVISE resumed window persisted",
    )

    const ledger = JSON.parse(readFileSync(v2Path, "utf8")) as {
      windowStartMs: number
      ids: string[]
      counters: Record<string, number>
      coverage: { restarts: number; gap: boolean }
    }
    // Still inside the first 4h: the window is unchanged, so the totals must be
    // the resumed ones, not a fresh zero.
    expect(ledger.windowStartMs).toBe(windowStartMs)
    expect(ledger.counters.presentations).toBe(120)
    expect(ledger.counters.deliveries).toBe(100)
    expect(ledger.counters.duplicateDeliveries).toBe(20)
    expect(ledger.counters.duplicateBytes).toBe(700)
    expect(ledger.counters.suppressed).toBe(20)
    expect([...ledger.ids].sort()).toEqual(["seed-row-a", "seed-row-b"])
    expect(ledger.coverage.restarts).toBe(2)
    expect(ledger.coverage.gap).toBe(false)
  })

  // @failure A foreign owner at the current filename suppresses unseen handoffs.
  // @level l3 @consumer adapter delivery and four-hour report
  // The first persona rejects a foreign v2 window with a named gap; the second
  // resumes its own v2 window and suppresses an already delivered row.
  it("keeps two colliding personas on separate delivery windows through the real adapter (#28376)", async () => {
    type FakeAttention = {
      actionable_unread?: Array<Record<string, unknown>>
      pending_balls?: Array<Record<string, unknown>>
    }
    const foreignPath = join(tmpDir, "tribe-delivery-v2-@dev_6.json")
    const v2Dev6 = join(tmpDir, "tribe-delivery-v2-@dev_6.json")
    const v2DevSlash6 = join(tmpDir, "tribe-delivery-v2-@dev%2F6.json")
    const windowStartMs = Date.now() - 60_000
    // A foreign window at the underscore persona's current path; the slash
    // persona also has its own v2 file. The row was handed only to @dev/6.
    const dev6Row = "broadcast-row-first-handed-only-to-dev-6"
    writeFileSync(
      foreignPath,
      JSON.stringify({
        version: 2,
        pane: "@dev/6",
        windowStartMs,
        updatedAtMs: windowStartMs,
        ids: [dev6Row],
        counters: {
          presentations: 1,
          newPresentations: 1,
          duplicatePresentations: 0,
          deliveries: 1,
          newDeliveries: 1,
          duplicateDeliveries: 0,
          duplicateBytes: 0,
          suppressed: 0,
          cost: {
            deliveredBytes: 0,
            handoffs: 0,
            readRepeatBodies: 0,
            readRepeatBytes: 0,
            readPulls: 0,
            readPullBytes: 0,
          },
        },
        pendingBallSummary: null,
        coverage: { restarts: 1, gap: false, gapReason: "none" },
      }),
      "utf8",
    )
    const originalBody = readFileSync(foreignPath, "utf8")
    writeFileSync(v2DevSlash6, originalBody, "utf8")

    const ledgerOf = (path: string) =>
      JSON.parse(readFileSync(path, "utf8")) as {
        pane: string
        ids: string[]
        counters: Record<string, number>
        coverage: { restarts: number; gap: boolean; gapReason: string }
      }
    // One adapter process for one persona: spawn its own daemon (the fake daemon
    // pins the name), join, drain once, and return the channel lines it forwarded.
    const runAdapter = async (opts: {
      socket: string
      ackName: string
      log: string
      fetchAttention: FakeAttention
    }): Promise<string[]> => {
      daemon = await spawnFakeDaemon(opts.socket, {
        fetchAttention: opts.fetchAttention,
        registerAck: { name: opts.ackName },
        joinAck: { name: opts.ackName },
      })
      child = spawn(BUN_BIN, [ADAPTER, "--socket", opts.socket, "--name", opts.ackName], {
        cwd: tmpDir,
        env: {
          ...process.env,
          TRIBE_DELIVERY: "push",
          TRIBE_NO_AUTOSTART: "1",
          TRIBE_DELIVERY_LEDGER_DIR: tmpDir,
          DEBUG_LOG: join(tmpDir, opts.log),
        },
        stdio: ["pipe", "pipe", "pipe"],
      })
      const stdout = collectStdoutJson(child)
      await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
      writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
      await writeJsonAndWaitForLine(child, callToolPayload(2, "join", { name: opts.ackName }), (line) => line.id === 2)
      const before = daemon.requests.filter((request) => request.method === "tribe.fetch").length
      daemon.clients[0]?.write(makeNotification("wakeup", {}))
      await waitForCondition(
        () => daemon!.requests.filter((request) => request.method === "tribe.fetch").length > before,
        `${opts.ackName} drain`,
      )
      await new Promise((resolveTick) => setTimeout(resolveTick, 300))
      return stdout
        .filter((line) => line.method === "notifications/claude/channel")
        .map((line) => JSON.stringify(line) as string)
    }
    const stopAdapter = async () => {
      child?.kill("SIGTERM")
      if (child) await waitForExit(child)
      for (const socket of daemon?.clients ?? []) socket.destroy()
      if (daemon) await new Promise<void>((resolveClose) => daemon!.server.close(() => resolveClose()))
      daemon = undefined
      child = undefined
    }

    // ---- @dev_6 first: the colliding persona must NOT inherit @dev/6's id. ----
    // The row served to @dev_6 is the same ID the foreign v2 file records for @dev/6,
    // so pre-fix (when @dev_6 restored that id set) this exact row read as already
    // handed off and the assertion below fails: genuine RED.
    const underscoreText = await runAdapter({
      socket: join(tmpDir, "tribe-underscore.sock"),
      ackName: "@dev_6",
      log: "adapter-underscore.log",
      fetchAttention: {
        actionable_unread: [
          {
            id: dev6Row,
            type: "verdict",
            from: "@chief",
            content: "UNDERSCORE-ROW",
            ts: new Date().toISOString(),
          },
        ],
        pending_balls: [],
      },
    })
    expect(underscoreText.some((line) => line.includes("UNDERSCORE-ROW"))).toBe(true)
    await waitForCondition(() => existsSync(v2Dev6), "@dev_6 persisted its own v2 ledger")
    const underscoreLedger = ledgerOf(v2Dev6)
    expect(underscoreLedger.pane).toBe("@dev_6")
    expect(underscoreLedger.coverage.gap).toBe(true)
    expect(underscoreLedger.coverage.gapReason).toBe("schema")
    // PRE-EXISTING foreign counters are not inherited: this window counts only
    // the one row it was actually handed.
    expect(underscoreLedger.counters.presentations).toBe(1)
    // The refusal is loud on the adapter's own log.
    const underscoreLog = readFileSync(join(tmpDir, "adapter-underscore.log"), "utf8")
    expect(underscoreLog).toContain("records owner @dev/6, not @dev_6")
    expect(underscoreLog).toContain("ignoring it (28376)")
    // Rejection leaves the slash persona's own v2 window unchanged.
    expect(readFileSync(v2DevSlash6, "utf8")).toBe(originalBody)
    await stopAdapter()

    // @dev/6 next: it resumes its own v2 window, so its row stays suppressed.
    const dev6Text = await runAdapter({
      socket: join(tmpDir, "tribe-slash.sock"),
      ackName: "@dev/6",
      log: "adapter-slash.log",
      fetchAttention: {
        actionable_unread: [
          { id: dev6Row, type: "verdict", from: "@chief", content: "DEV-6-OWN-ROW", ts: new Date().toISOString() },
        ],
        pending_balls: [],
      },
    })
    // A changed timestamp proves the seeded file was actually re-persisted.
    await waitForCondition(
      () => (JSON.parse(readFileSync(v2DevSlash6, "utf8")) as { updatedAtMs: number }).updatedAtMs > windowStartMs,
      "@dev/6 re-persisted its current v2 window",
    )
    expect(dev6Text.some((line) => line.includes("DEV-6-OWN-ROW"))).toBe(false)
    const dev6LedgerV2 = ledgerOf(v2DevSlash6)
    expect(dev6LedgerV2.pane).toBe("@dev/6")
    expect(dev6LedgerV2.ids).toEqual([dev6Row])
    expect(dev6LedgerV2.coverage.gap).toBe(false)
    // Each persona now has its own current file.
    expect(ledgerOf(v2Dev6).pane).toBe("@dev_6")
  })

  // #27459 - the ambient `events` path is the same pane inbox as attention: a
  // notify recovered from the mailbox cursor must obey the one forwarded-id
  // record, and both paths must feed the ledger, or the report misses the
  // measured residual duplicate rate.
  it("hands off an ambient event row once across drains, counts it, and still forwards a new row (#27459)", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const recentTs = new Date().toISOString()
    const fetchAttention = { actionable_unread: [], pending_balls: [] }
    const fetchEvents: Array<Record<string, unknown>> = [
      { id: "ambient-notify-a", type: "notify", from: "@chief", content: "AMBIENT-COUNTED", ts: recentTs },
    ]
    daemon = await spawnFakeDaemon(socketPath, { fetchAttention, fetchEvents })
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "push",
        TRIBE_NO_AUTOSTART: "1",
        TRIBE_DELIVERY_LEDGER_DIR: tmpDir,
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout = collectStdoutJson(child)
    const channelText = () =>
      stdout
        .filter((line) => line.method === "notifications/claude/channel")
        .map((line) => JSON.stringify(line) as string)
    const drain = async (label: string) => {
      const before = daemon!.requests.filter((request) => request.method === "tribe.fetch").length
      daemon!.clients[0]?.write(makeNotification("wakeup", {}))
      await waitForCondition(
        () => daemon!.requests.filter((request) => request.method === "tribe.fetch").length > before,
        label,
      )
      await new Promise((resolveTick) => setTimeout(resolveTick, 250))
    }

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    await writeJsonAndWaitForLine(child, callToolPayload(2, "join", { name: "@agent/test" }), (line) => line.id === 2)

    await drain("first ambient drain")
    await drain("second ambient drain")
    expect(channelText().filter((line) => line.includes("AMBIENT-COUNTED"))).toHaveLength(1)

    // A genuinely new row still forwards on arrival.
    fetchEvents.push({ id: "ambient-notify-b", type: "notify", from: "@chief", content: "AMBIENT-FRESH", ts: recentTs })
    await drain("third ambient drain")
    expect(channelText().filter((line) => line.includes("AMBIENT-FRESH"))).toHaveLength(1)
    expect(channelText().filter((line) => line.includes("AMBIENT-COUNTED"))).toHaveLength(1)

    const ledgerPath = join(tmpDir, "tribe-delivery-v2-@agent%2Ftest.json")
    await waitForCondition(() => existsSync(ledgerPath), "ambient delivery ledger written")
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      ids: string[]
      counters: Record<string, number>
    }
    expect([...ledger.ids].sort()).toEqual(["ambient-notify-a", "ambient-notify-b"])
    expect(ledger.counters.deliveries).toBe(2)
    expect(ledger.counters.newDeliveries).toBe(2)
    expect(ledger.counters.duplicateDeliveries).toBe(0)
    expect(ledger.counters.presentations).toBe(4)
    expect(ledger.counters.duplicatePresentations).toBe(2)
  })

  // #28282 - @cto 11:19 PDT: the counter is not broken, the two units are
  // deliberate. `duplicateDeliveries` is the RESIDUAL - a handoff that reached
  // the pane twice after the once-per-row record - and `duplicatePresentations`
  // is the daemon's re-offer the record absorbed. This drives a real residual
  // path through the real adapter: two rows carrying the SAME id in ONE drained
  // batch. The admission filter (:1670-1672) is evaluated for the whole batch
  // before the first handoff resolves, so both are admitted, both forward, and
  // `deliver()` counts the second one. A future path that reaches the pane
  // while skipping the record is what the >20% / >=100-deliveries alert is for.
  it("counts a second handoff of one id when both rows arrive in the same batch (#28282)", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const recentTs = new Date().toISOString()
    const fetchEvents: Array<Record<string, unknown>> = [
      { id: "dup-notify-a", type: "notify", from: "@chief", content: "DUP-COUNTED", ts: recentTs },
      { id: "dup-notify-a", type: "notify", from: "@chief", content: "DUP-COUNTED", ts: recentTs },
    ]
    daemon = await spawnFakeDaemon(socketPath, {
      fetchAttention: { actionable_unread: [], pending_balls: [] },
      fetchEvents,
    })
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "push",
        TRIBE_NO_AUTOSTART: "1",
        TRIBE_DELIVERY_LEDGER_DIR: tmpDir,
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout = collectStdoutJson(child)
    const channelText = () =>
      stdout
        .filter((line) => line.method === "notifications/claude/channel")
        .map((line) => JSON.stringify(line) as string)
    // #28282 follow-up (@dev/6): the drain is complete when the adapter has
    // EMITTED, not when a fixed settle elapses. Waiting on the observed channel
    // notification count is what makes this witness independent of host timing —
    // with a slow child the assertion below read 0 notifications while the
    // forwards were still in flight, so the test could fail on load alone.
    const drain = async (label: string, expected: { marker: string; count: number }) => {
      const before = daemon!.requests.filter((request) => request.method === "tribe.fetch").length
      daemon!.clients[0]?.write(makeNotification("wakeup", {}))
      await waitForCondition(
        () => daemon!.requests.filter((request) => request.method === "tribe.fetch").length > before,
        label,
      )
      await waitForCondition(
        () => channelText().filter((line) => line.includes(expected.marker)).length >= expected.count,
        `${label}: ${expected.count} channel notification(s) carrying ${expected.marker}`,
        { timeoutMs: 10_000 },
      )
    }

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    await writeJsonAndWaitForLine(child, callToolPayload(2, "join", { name: "@agent/test" }), (line) => line.id === 2)

    await drain("the batch is drained", { marker: "DUP-COUNTED", count: 2 })

    // The pane really received it twice: this is the residual, not a re-offer.
    expect(channelText().filter((line) => line.includes("DUP-COUNTED"))).toHaveLength(2)

    const ledgerPath = join(tmpDir, "tribe-delivery-v2-@agent%2Ftest.json")
    // Poll rather than read once: the drain persists asynchronously.
    await waitForCondition(() => {
      if (!existsSync(ledgerPath)) return false
      const counters = (JSON.parse(readFileSync(ledgerPath, "utf8")) as { counters?: Record<string, number> }).counters
      return (counters?.deliveries ?? 0) >= 2
    }, "both handoffs persisted")
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      ids: string[]
      counters: Record<string, number>
    }
    expect(ledger.counters.deliveries).toBe(2)
    expect(ledger.counters.duplicateDeliveries).toBe(1)
  })

  // #27459 - restart behavior is explicit against the durable ledger: the
  // forwarded-id record is seeded from the per-pane ledger, so an already-handed
  // ambient row stays suppressed in a fresh adapter process.
  it("does not re-forward an already-handed ambient row after an adapter restart (#27459)", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const recentTs = new Date().toISOString()
    const env = {
      ...process.env,
      TRIBE_DELIVERY: "push",
      TRIBE_NO_AUTOSTART: "1",
      TRIBE_DELIVERY_LEDGER_DIR: tmpDir,
      DEBUG_LOG: join(tmpDir, "adapter.log"),
    }
    daemon = await spawnFakeDaemon(socketPath, {
      fetchAttention: { actionable_unread: [], pending_balls: [] },
      fetchEvents: [
        { id: "ambient-restart-a", type: "notify", from: "@chief", content: "AMBIENT-RESTART", ts: recentTs },
      ],
    })
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const firstStdout = collectStdoutJson(child)
    const firstText = () =>
      firstStdout
        .filter((line) => line.method === "notifications/claude/channel")
        .map((line) => JSON.stringify(line) as string)
    const drain = async (label: string) => {
      const before = daemon!.requests.filter((request) => request.method === "tribe.fetch").length
      daemon!.clients.at(-1)?.write(makeNotification("wakeup", {}))
      await waitForCondition(
        () => daemon!.requests.filter((request) => request.method === "tribe.fetch").length > before,
        label,
      )
      await new Promise((resolveTick) => setTimeout(resolveTick, 250))
    }
    const handshake = async () => {
      await writeJsonAndWaitForLine(child!, initializePayload(1), (line) => line.id === 1)
      writeJson(child!, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
      await writeJsonAndWaitForLine(
        child!,
        callToolPayload(2, "join", { name: "@agent/test" }),
        (line) => line.id === 2,
      )
    }

    await handshake()
    await drain("pre-restart drain")
    expect(firstText().filter((line) => line.includes("AMBIENT-RESTART"))).toHaveLength(1)

    const ledgerPath = join(tmpDir, "tribe-delivery-v2-@agent%2Ftest.json")
    await waitForCondition(() => existsSync(ledgerPath), "delivery ledger before restart")

    child!.kill("SIGTERM")
    await waitForExit(child!)
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const secondStdout = collectStdoutJson(child)
    const secondText = () =>
      secondStdout
        .filter((line) => line.method === "notifications/claude/channel")
        .map((line) => JSON.stringify(line) as string)

    await handshake()
    await drain("post-restart drain")
    expect(secondText().filter((line) => line.includes("AMBIENT-RESTART"))).toHaveLength(0)
  })

  // #27459 gap-1 acceptance (@cto 202142ab §3): 20 drains plus 2 adapter
  // restarts over an UNCHANGED inbox — and a reconnect re-push of rows the pane
  // already holds — must hand each message id to the pane exactly once. Every
  // path (attention drain, ambient events, and the live `channel` push) shares
  // ONE forwarded-id record, and the durable ledger keeps it across restarts.
  it("hands each id to the pane once across 20 drains, 2 restarts, and a reconnect re-push (#27459 gap-1)", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const recentTs = new Date().toISOString()
    const fetchAttention = {
      actionable_unread: [
        { id: "gap1-attention-a", type: "request", from: "@chief", content: "GAP1-ATTENTION-A", ts: recentTs },
        { id: "gap1-attention-b", type: "verdict", from: "@ci", content: "GAP1-ATTENTION-B", ts: recentTs },
      ],
      pending_balls: [],
    }
    // An ambient twin of an already-forwarded attention id must stay out; a
    // distinct ambient row is the third id this pane may see exactly once.
    const fetchEvents: Array<Record<string, unknown>> = [
      { id: "gap1-attention-a", type: "notify", from: "@chief", content: "GAP1-AMBIENT-TWIN", ts: recentTs },
      { id: "gap1-ambient-c", type: "notify", from: "@chief", content: "GAP1-AMBIENT-C", ts: recentTs },
    ]
    const env = {
      ...process.env,
      TRIBE_DELIVERY: "push",
      TRIBE_NO_AUTOSTART: "1",
      TRIBE_DELIVERY_LEDGER_DIR: tmpDir,
      DEBUG_LOG: join(tmpDir, "adapter.log"),
    }
    daemon = await spawnFakeDaemon(socketPath, { fetchAttention, fetchEvents })
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const forwarders: Array<() => string[]> = []
    const collect = () => {
      const stdout = collectStdoutJson(child!)
      forwarders.push(() =>
        stdout
          .filter((line) => line.method === "notifications/claude/channel")
          .map((line) => JSON.stringify(line) as string),
      )
    }
    collect()
    const text = () => forwarders.flatMap((forwarded) => forwarded())
    const count = (needle: string) => text().filter((line) => line.includes(needle)).length
    const handshake = async () => {
      await writeJsonAndWaitForLine(child!, initializePayload(1), (line) => line.id === 1)
      writeJson(child!, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
      await writeJsonAndWaitForLine(
        child!,
        callToolPayload(2, "join", { name: "@agent/test" }),
        (line) => line.id === 2,
      )
    }
    const drain = async (label: string) => {
      const before = daemon!.requests.filter((request) => request.method === "tribe.fetch").length
      daemon!.clients.at(-1)?.write(makeNotification("wakeup", {}))
      await waitForCondition(
        () => daemon!.requests.filter((request) => request.method === "tribe.fetch").length > before,
        label,
      )
      await new Promise((resolveTick) => setTimeout(resolveTick, 120))
    }
    const restart = async (label: string) => {
      child!.kill("SIGTERM")
      await waitForExit(child!)
      child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
        cwd: tmpDir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      })
      collect()
      await handshake()
      await drain(label)
    }

    await handshake()
    await drain("first gap-1 drain")
    for (let index = 2; index <= 20; index += 1) await drain(`gap-1 drain ${index}`)

    expect(count("GAP1-ATTENTION-A")).toBe(1)
    expect(count("GAP1-ATTENTION-B")).toBe(1)
    expect(count("GAP1-AMBIENT-C")).toBe(1)
    expect(count("GAP1-AMBIENT-TWIN")).toBe(0)

    await restart("gap-1 post-restart-1 drain")
    await restart("gap-1 post-restart-2 drain")

    expect(count("GAP1-ATTENTION-A")).toBe(1)
    expect(count("GAP1-ATTENTION-B")).toBe(1)
    expect(count("GAP1-AMBIENT-C")).toBe(1)

    // A reconnect re-push of ids this pane already holds must not re-present
    // them; a genuinely new pushed id still forwards, exactly once.
    daemon.clients.at(-1)?.write(
      makeNotification("channel", {
        from: "chief",
        type: "notify",
        content: "GAP1-RECONNECT-A",
        message_id: "gap1-attention-a",
      }),
    )
    daemon.clients.at(-1)?.write(
      makeNotification("channel", {
        from: "chief",
        type: "notify",
        content: "GAP1-RECONNECT-C",
        message_id: "gap1-ambient-c",
      }),
    )
    daemon.clients.at(-1)?.write(
      makeNotification("channel", {
        from: "chief",
        type: "notify",
        content: "GAP1-RECONNECT-NEW",
        message_id: "gap1-pushed-d",
      }),
    )
    await waitForCondition(() => count("GAP1-RECONNECT-NEW") === 1, "new pushed row forwarded")
    await new Promise((resolveTick) => setTimeout(resolveTick, 300))
    expect(count("GAP1-RECONNECT-A")).toBe(0)
    expect(count("GAP1-RECONNECT-C")).toBe(0)
    expect(count("GAP1-RECONNECT-NEW")).toBe(1)

    const ledgerPath = join(tmpDir, "tribe-delivery-v2-@agent%2Ftest.json")
    await waitForCondition(() => existsSync(ledgerPath), "gap-1 delivery ledger written")
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      ids: string[]
      counters: Record<string, number>
    }
    expect([...ledger.ids].sort()).toEqual(["gap1-ambient-c", "gap1-attention-a", "gap1-attention-b", "gap1-pushed-d"])
    expect(ledger.counters.duplicateDeliveries).toBe(0)
  })

  it("drains and pushes attention when wakeup arrives within the register round-trip (#26969 row 5)", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const fetchAttention = {
      actionable_unread: [
        {
          id: "mid-reg-order",
          type: "request",
          from: "@chief",
          content: "delivered despite wakeup during register",
          ts: new Date().toISOString(),
        },
      ],
      pending_balls: [],
    }
    daemon = await spawnFakeDaemon(socketPath, {
      wakeupDuringRegister: true,
      fetchAttention,
    })
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "push",
        TRIBE_NO_AUTOSTART: "1",
        TRIBE_REQUIRE_JOIN: "0",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout = collectStdoutJson(child)

    await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })

    await waitForStdout(
      child,
      stdout,
      () =>
        stdout.some(
          (line) =>
            line.method === "notifications/claude/channel" &&
            JSON.stringify(line).includes("delivered despite wakeup during register"),
        ),
      { timeoutMs: 10_000 },
    )

    const delivered = stdout.find(
      (line) =>
        line.method === "notifications/claude/channel" &&
        JSON.stringify(line).includes("delivered despite wakeup during register"),
    )
    expect(delivered).toBeDefined()
  })

  // #27488 phase 0 - every MODEL-requested read is measured as the RESULT bytes
  // the model received, plus the bodies `fetch` returned twice inside ONE
  // response (attention.actionable_unread AND events, must-hold A). Phase 0
  // counts it; phase 1 fixes the read so the count can fall to 0.
  describe("model read cost (#27488 phase 0)", () => {
    it("measures each read tool by the result text returned, and fetch's repeated bodies", async () => {
      const socketPath = join(tmpDir, "tribe.sock")
      const recentTs = new Date().toISOString()
      const rowA = { id: "read-dup-a", type: "request", from: "@chief", content: "READ-DUP-A", ts: recentTs }
      const rowB = { id: "read-b", type: "notify", from: "pending-1", content: "READ-B", ts: recentTs }
      const fetchAttention = {
        actionable_unread: [rowA],
        pending_balls: [],
        pending_balls_summary: { total: 0, oldest_age_ms: 0, truncated: false },
      }
      daemon = await spawnFakeDaemon(socketPath, {
        fetchAttention,
        fetchEvents: [rowA, rowB],
        pendingResult: { balls: [{ id: "ball-1", owner: "@agent/test" }] },
      })
      child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
        cwd: tmpDir,
        env: {
          ...process.env,
          TRIBE_DELIVERY: "push",
          TRIBE_NO_AUTOSTART: "1",
          TRIBE_DELIVERY_LEDGER_DIR: tmpDir,
          DEBUG_LOG: join(tmpDir, "adapter.log"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      })
      collectStdoutJson(child)

      await writeJsonAndWaitForLine(child, initializePayload(1), (line) => line.id === 1)
      writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
      await writeJsonAndWaitForLine(child, callToolPayload(2, "join", { name: "@agent/test" }), (line) => line.id === 2)
      const fetchReply = await writeJsonAndWaitForLine(
        child,
        callToolPayload(3, "fetch", { limit: 10 }),
        (line) => line.id === 3,
      )
      const pendingReply = await writeJsonAndWaitForLine(
        child,
        callToolPayload(4, "pending", { owner: "@agent/test" }),
        (line) => line.id === 4,
      )
      const waitReply = await writeJsonAndWaitForLine(
        child,
        callToolPayload(5, "inbox.wait", { session: "@agent/test", timeout_ms: 1_000 }),
        (line) => line.id === 5,
      )

      // The read's cost is the result text the MODEL received, not the sum of the
      // rows' content fields (framing is part of what the model pays for). Mirrors
      // the adapter's own resultText(): every content block, in order.
      const replyText = (line: Record<string, unknown>): string =>
        ((line.result as { content?: Array<{ text?: string }> } | undefined)?.content ?? [])
          .map((block) => block.text ?? "")
          .join("")
      const expectedReadBytes =
        Buffer.byteLength(replyText(fetchReply), "utf8") +
        Buffer.byteLength(replyText(pendingReply), "utf8") +
        Buffer.byteLength(replyText(waitReply), "utf8")

      const ledgerPath = join(tmpDir, "tribe-delivery-v2-@agent%2Ftest.json")
      await waitForCondition(() => existsSync(ledgerPath), "cost ledger written")
      const cost = (
        JSON.parse(readFileSync(ledgerPath, "utf8")) as {
          counters: {
            cost?: { readPulls: number; readPullBytes: number; readRepeatBodies: number; readRepeatBytes: number }
          }
        }
      ).counters.cost
      // fetch, pending and inbox.wait are all reads the model can call.
      expect(cost?.readPulls).toBe(3)
      expect(cost?.readPullBytes).toBe(expectedReadBytes)
      // Only fetch exposes attention AND events, so its duplicated body is the one repeat.
      expect(cost?.readRepeatBodies).toBe(1)
      expect(cost?.readRepeatBytes).toBe(Buffer.byteLength("READ-DUP-A", "utf8"))
    })
  })
})
