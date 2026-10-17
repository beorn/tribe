/**
 * @failure  The supervisor's child runs from shared main (the supervisor's own
 *           location) instead of the landing root the daemon publishes, so the
 *           adapter executes a projection that can move under it, and the child
 *           cwd is dragged to that root instead of the host's identity cwd
 *           (27531; @cto corrections A and B). Also: a cold-start give-up exits
 *           the endpoint without the durable exit row every other terminal
 *           adapter exit leaves, so a darkened seat has no record naming why
 *           (28920).
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
import { PLUGIN_CODE_ROOT_WINDOW_ENV } from "../supervisor-policy.ts"
import { isRequest, makeResponse } from "../../../packages/wire/src/rpc.ts"
import { AG_HOST_SESSION_STATE_DIR_ENV } from "tribe-wire/lib/ag-host-env"
import { HAB_ID_TOKEN_ENV, HAB_ID_TOKEN_FILE_ENV } from "tribe-wire/lib/hab-session-env"
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

function startSupervisor(overrides: NodeJS.ProcessEnv = {}): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRIBE_SOCKET: socketPath,
    TRIBE_NO_AUTOSTART: "1",
    TRIBE_NAME: "@agent/test",
    SPAWN_MARKER: markerPath,
    [AG_HOST_SESSION_STATE_DIR_ENV]: dir,
    ...overrides,
  }
  delete env[HAB_ID_TOKEN_ENV]
  delete env[HAB_ID_TOKEN_FILE_ENV]
  delete env[TRIBE_PLUGIN_PROVIDER_PARENT_PID_ENV]
  const child = spawn(process.execPath, [SERVER], { cwd: PLUGIN_ROOT, env, stdio: ["pipe", "pipe", "pipe"] })
  children.push(child)
  return child
}

function spawnRecord(): { entry: string; cwd: string; marker: string | null } | null {
  try {
    const line = readFileSync(markerPath, "utf8").trim().split("\n").at(-1)
    if (line === undefined || line === "") return null
    const record: unknown = JSON.parse(line)
    if (
      typeof record !== "object" ||
      record === null ||
      !("entry" in record) ||
      typeof record.entry !== "string" ||
      !("cwd" in record) ||
      typeof record.cwd !== "string" ||
      !("marker" in record) ||
      (record.marker !== null && typeof record.marker !== "string")
    ) {
      throw new Error(
        `invalid spawn marker record in ${markerPath}: expected string entry/cwd and string or null marker`,
      )
    }
    return { entry: record.entry, cwd: record.cwd, marker: record.marker }
  } catch (error) {
    // The marker file does not exist until the stub entry writes its first line; the caller polls for that.
    // Anything else (a permission error, a torn line) is not "no spawn yet" and must surface.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

describe("the supervisor spawns the adapter from the daemon's landing root", () => {
  it("refuses malformed spawn records instead of treating them as no spawn", () => {
    expect(spawnRecord()).toBeNull()
    for (const record of [
      null,
      {},
      { entry: null, cwd: "cwd", marker: null },
      { entry: "entry", cwd: 1, marker: null },
      { entry: "entry", cwd: "cwd", marker: false },
    ]) {
      writeFileSync(markerPath, JSON.stringify(record) + "\n")
      expect(() => spawnRecord()).toThrow("invalid spawn marker record")
    }
    writeFileSync(markerPath, "{\n")
    expect(() => spawnRecord()).toThrow(SyntaxError)
  })

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

  it("a cold-start give-up leaves one durable exit row naming the reason (28920)", async () => {
    // The terminal give-up used to leave only a stderr line in the host's own capture,
    // which nobody reads for a seat that goes dark. It is the same terminal event as
    // every other adapter exit, so it must leave the same durable row.
    const exitsPath = join(dir, "tribe-adapter-exits.jsonl")
    await startFakeDaemon({ sessions: [] })
    const supervisor = startSupervisor({ [PLUGIN_CODE_ROOT_WINDOW_ENV]: "300" })
    await vi.waitFor(() => expect(supervisor.exitCode).toBe(2), { timeout: 8_000 })
    expect(spawnRecord()).toBeNull()
    const rows: unknown[] = readFileSync(exitsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ instance_id: null, adapter_pid: null, code: null, signal: null, decision: "stop" })
    expect((rows[0] as { reason?: unknown }).reason).toContain("no code root within 300 ms of the cold start")
    // @cto 857b0478 (28920 step 3, reading B): the row is what the reader of a dark seat actually sees, so the
    // remedy rides the reason, host-neutral - no host is named in code.
    expect((rows[0] as { reason?: unknown }).reason).toContain(
      "a host that does not respawn this child leaves the seat dark; relaunch the seat",
    )
  }, 20_000)
})
