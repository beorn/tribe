/**
 * @failure  A stop handler runs while the supervisor is parked in its wait for
 *           the daemon's landing root, and the supervisor starts an adapter
 *           anyway -- `stopping` is read only at the top of the supervisor
 *           loop, so a root reply that lands after the signal still spawns a
 *           child, and the respawn wait (unbounded by design) never observes
 *           the stop at all. A stopped host then leaves an adapter behind that
 *           nothing will signal (28380).
 * @level    l2 - a real supervisor process, a fake daemon that holds the
 *           code-root reply, and a scratch observer that records the native
 *           SIGTERM listener actually executing before that reply is released
 * @consumer @i/4-supervision/27459-coordination-overhead-has-no-budget/27531-adapters-run-from-the-daemon-landing-root-learned-from-the-daemon-never-shared-main/28380-supervisor-spawns-after-stop
 * @testonly none
 */
import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createLineParser } from "../../../packages/wire/src/parser.ts"
import { isRequest, makeResponse } from "../../../packages/wire/src/rpc.ts"
import { AG_HOST_SESSION_STATE_DIR_ENV } from "tribe-wire/lib/ag-host-env"
import { HAB_ID_TOKEN_ENV } from "tribe-wire/lib/hab-session-env"
import { TRIBE_PLUGIN_PROVIDER_PARENT_PID_ENV } from "tribe-wire/lib/session-identity-env"

const PLUGIN_ROOT = resolve(import.meta.dirname, "..")
const SERVER = join(PLUGIN_ROOT, "server.ts")

let dir: string
let landing: string
let socketPath: string
let markerPath: string
let stopAckPath: string
let observerPath: string
let daemon: Server
const children: ChildProcess[] = []
/** The supervisor's own stderr, where every decided outcome is named. */
let stderr: string
/** Every code-root request the daemon is deliberately not answering yet. */
let held: Array<() => void> = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stop-race-"))
  landing = join(dir, "landing")
  mkdirSync(join(landing, "plugins", "claude"), { recursive: true })
  socketPath = join(dir, "tribe.sock")
  markerPath = join(dir, "spawn.jsonl")
  stopAckPath = join(dir, "stop-ack.jsonl")
  held = []
  stderr = ""
  // The stub stands in for the landing's adapter entry: it records that it ran,
  // then exits with the code the case needs (0 for the stall, 7 for the respawn).
  writeFileSync(
    join(landing, "plugins", "claude", "server.ts"),
    [
      'import { appendFileSync } from "node:fs"',
      "appendFileSync(process.env.SPAWN_MARKER,",
      '  JSON.stringify({ entry: process.argv[1], cwd: process.cwd(), at: Date.now() }) + "\\n")',
      "process.exit(Number(process.env.STUB_EXIT_CODE ?? 0))",
      "",
    ].join("\n"),
  )
  // A scratch observer wraps ONLY the registration of the two stop signals and
  // calls the production listener unchanged. It is the barrier that proves the
  // native stop handler has already run when the held reply is released, so the
  // case is a race on the supervisor's own boundary rather than a sleep.
  observerPath = join(dir, "stop-observer.ts")
  writeFileSync(
    observerPath,
    [
      'import { appendFileSync } from "node:fs"',
      "const ack = process.env.SUPERVISOR_STOP_ACK",
      "const registration = process.once.bind(process)",
      "process.once = (event, listener) => {",
      '  if (event !== "SIGTERM" && event !== "SIGINT") return registration(event, listener)',
      "  return registration(event, (...args) => {",
      '    appendFileSync(ack, String(event) + "\\n")',
      "    return listener(...args)",
      "  })",
      "}",
      "await import(process.env.SUPERVISOR_ENTRY)",
      "",
    ].join("\n"),
  )
})

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL")
  daemon?.close()
  rmSync(dir, { recursive: true, force: true })
})

/** A daemon that records every code-root request instead of answering it. */
function startFakeDaemon(): Promise<void> {
  daemon = createServer((socket: Socket) => {
    const parse = createLineParser((msg) => {
      if (!isRequest(msg)) return
      if (msg.method === "cli_status") held.push(() => socket.write(makeResponse(msg.id, publishedRoot())))
    })
    socket.on("data", parse)
    socket.on("error", () => {})
  })
  return new Promise((done) => daemon.listen(socketPath, done))
}

function publishedRoot(): unknown {
  return { sessions: [], daemon: { code_identity: { cert: "fixture-cert", root: landing } } }
}

/** Answer every held code-root request; the supervisor reads one over each connection. */
function releaseHeldRoot(): void {
  for (const answer of held.splice(0)) answer()
}

function startSupervisor(stubExitCode: number): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRIBE_SOCKET: socketPath,
    TRIBE_NO_AUTOSTART: "1",
    TRIBE_NAME: "@agent/test",
    SPAWN_MARKER: markerPath,
    STUB_EXIT_CODE: String(stubExitCode),
    SUPERVISOR_STOP_ACK: stopAckPath,
    SUPERVISOR_ENTRY: SERVER,
    [AG_HOST_SESSION_STATE_DIR_ENV]: dir,
  }
  delete env[HAB_ID_TOKEN_ENV]
  delete env[TRIBE_PLUGIN_PROVIDER_PARENT_PID_ENV]
  const child = spawn(process.execPath, [observerPath], { cwd: PLUGIN_ROOT, env, stdio: ["pipe", "pipe", "pipe"] })
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  child.stdout?.resume()
  children.push(child)
  return child
}

/** How the supervisor spawned its adapter child, one record per spawn. */
function spawnRecords(): Array<{ entry: string; cwd: string; at: number }> {
  try {
    return readFileSync(markerPath, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { entry: string; cwd: string; at: number })
  } catch (error) {
    // The marker file does not exist until the stub entry writes its first line; the caller polls for that.
    // Anything else (a permission error, a torn line) is not "no spawn yet" and must surface.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

/** Which stop signals the installed native listener has actually run for. */
function stopAcks(): string[] {
  try {
    return readFileSync(stopAckPath, "utf8")
      .split("\n")
      .filter((line) => line !== "")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

describe("the supervisor observes a stop while it waits for the daemon's landing root (28380)", () => {
  it("control: the same held reply, with no stop, still starts the child from the daemon's landing root", async () => {
    await startFakeDaemon()
    startSupervisor(0)
    await vi.waitFor(() => expect(held.length).toBeGreaterThan(0), { timeout: 10_000 })
    releaseHeldRoot()
    await vi.waitFor(() => expect(spawnRecords().length).toBeGreaterThan(0), { timeout: 10_000 })
    expect(spawnRecords()[0]?.entry).toBe(join(landing, "plugins", "claude", "server.ts"))
    expect(spawnRecords()[0]?.cwd).toBe(PLUGIN_ROOT)
  }, 30_000)

  it("a stop handler that has already run before the root reply lands starts no child", async () => {
    await startFakeDaemon()
    const supervisor = startSupervisor(0)
    await vi.waitFor(() => expect(held.length).toBeGreaterThan(0), { timeout: 10_000 })
    supervisor.kill("SIGTERM")
    // The barrier: release only after the native listener itself has run.
    await vi.waitFor(() => expect(stopAcks().length).toBeGreaterThan(0), { timeout: 10_000 })
    releaseHeldRoot()
    await vi.waitFor(() => expect(supervisor.exitCode).not.toBeNull(), { timeout: 10_000 })
    expect(spawnRecords()).toHaveLength(0)
    // The outcome is named, not silent: a supervisor that quits without a line is a silent error.
    expect(stderr).toContain("stop observed while waiting for the daemon's landing root; no adapter was started")
  }, 30_000)

  it("a stop handler terminates the unbounded respawn wait for a landing root", async () => {
    await startFakeDaemon()
    const supervisor = startSupervisor(7)
    await vi.waitFor(() => expect(held.length).toBeGreaterThan(0), { timeout: 10_000 })
    releaseHeldRoot()
    await vi.waitFor(() => expect(spawnRecords()).toHaveLength(1), { timeout: 10_000 })
    // The stub child exited 7, so the supervisor is respawning, and this second
    // root request is held for good: that wait is the unbounded one a stop must end.
    await vi.waitFor(() => expect(held.length).toBeGreaterThan(0), { timeout: 15_000 })
    const spawnedBeforeStop = spawnRecords().length
    supervisor.kill("SIGTERM")
    await vi.waitFor(() => expect(stopAcks().length).toBeGreaterThan(0), { timeout: 10_000 })
    await vi.waitFor(() => expect(supervisor.exitCode).not.toBeNull(), { timeout: 15_000 })
    expect(spawnRecords()).toHaveLength(spawnedBeforeStop)
    expect(stderr).toContain("stop observed while waiting for the daemon's landing root; no adapter was started")
  }, 45_000)
})
