/**
 * @failure  The supervisor's child runs from shared main (the supervisor's own
 *           location) instead of the landing root the daemon publishes, so the
 *           adapter executes a projection that can move under it, and the child
 *           cwd is dragged to that root instead of the host's identity cwd
 *           (27531; @cto corrections A and B).
 * @level    l2 - a real supervisor process, a fake daemon on a temp socket, and
 *           a stub landing entry that records how it was spawned
 * @consumer @i/4-supervision/27459-coordination-overhead-has-no-budget/27531-adapters-run-from-the-daemon-landing-root-learned-from-the-daemon-never-shared-main
 * @testonly none
 */
import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:net"
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
let daemon: Server
const children: ChildProcess[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "source-root-"))
  landing = join(dir, "landing")
  mkdirSync(join(landing, "plugins", "claude"), { recursive: true })
  socketPath = join(dir, "tribe.sock")
  markerPath = join(dir, "spawn.jsonl")
  // The stub stands in for the landing's adapter entry: it records argv[1] and
  // cwd, so the test reads exactly how the supervisor spawned it.
  writeFileSync(
    join(landing, "plugins", "claude", "server.ts"),
    [
      'import { appendFileSync } from "node:fs"',
      "appendFileSync(process.env.SPAWN_MARKER,",
      '  JSON.stringify({ entry: process.argv[1], cwd: process.cwd(), marker: process.argv[2] ?? null }) + "\\n")',
      "",
    ].join("\n"),
  )
})

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL")
  daemon?.close()
  rmSync(dir, { recursive: true, force: true })
})

/** A daemon that publishes the landing root (or no code identity at all). */
function startFakeDaemon(status: unknown): Promise<void> {
  daemon = createServer((socket) => {
    const parse = createLineParser((msg) => {
      if (!isRequest(msg)) return
      if (msg.method === "cli_status") socket.write(makeResponse(msg.id, status))
    })
    socket.on("data", parse)
    socket.on("error", () => {})
  })
  return new Promise((done) => daemon.listen(socketPath, done))
}

function startSupervisor(): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRIBE_SOCKET: socketPath,
    TRIBE_NO_AUTOSTART: "1",
    TRIBE_NAME: "@agent/test",
    SPAWN_MARKER: markerPath,
    [AG_HOST_SESSION_STATE_DIR_ENV]: dir,
  }
  delete env[HAB_ID_TOKEN_ENV]
  delete env[TRIBE_PLUGIN_PROVIDER_PARENT_PID_ENV]
  const child = spawn(process.execPath, [SERVER], { cwd: PLUGIN_ROOT, env, stdio: ["pipe", "pipe", "pipe"] })
  children.push(child)
  return child
}

function spawnRecord(): { entry: string; cwd: string; marker: string | null } | null {
  try {
    const line = readFileSync(markerPath, "utf8").trim().split("\n").at(-1)
    return line === undefined || line === "" ? null : JSON.parse(line)
  } catch (error) {
    // The marker file does not exist until the stub entry writes its first line; the caller polls for that.
    // Anything else (a permission error, a torn line) is not "no spawn yet" and must surface.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

describe("the supervisor spawns the adapter from the daemon's landing root", () => {
  it("entry is <root>/plugins/claude/server.ts, and the child cwd stays the host's", async () => {
    await startFakeDaemon({
      sessions: [],
      daemon: { code_identity: { cert: "cert-1", root: landing } },
    })
    startSupervisor()
    await vi.waitFor(() => expect(spawnRecord()).not.toBeNull(), { timeout: 8_000 })
    expect(spawnRecord()?.entry).toBe(join(landing, "plugins", "claude", "server.ts"))
    expect(spawnRecord()?.cwd).toBe(PLUGIN_ROOT)
  }, 20_000)

  it("a daemon that publishes no root is never guessed at: no spawn from the supervisor's own tree", async () => {
    await startFakeDaemon({ sessions: [] })
    const supervisor = startSupervisor()
    await new Promise((done) => setTimeout(done, 1_500))
    expect(spawnRecord()).toBeNull()
    expect(supervisor.exitCode).toBeNull()
  }, 20_000)
})
