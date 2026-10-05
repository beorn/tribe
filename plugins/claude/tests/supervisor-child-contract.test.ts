/**
 * @failure  The supervisor and its adapter child disagree about the contract
 *           between them -- an env name renamed on one side only, the
 *           `tribePluginIdentity` IPC message parsed under a different key, or
 *           the re-exec exit-code arithmetic drifting -- so a supervisor
 *           replaces its child without the join state, or refuses to replace it
 *           at all, and the host's MCP endpoint dies silently
 *           (27531; the contract must be pinned before the spawn moves to R).
 * @level    l2 - a real supervisor process, a fake daemon publishing a temp
 *           landing, and a stub child that speaks the real IPC message
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
/** The supervisor's own constants, pinned here so a rename cannot move them silently. */
const REEXEC_EXIT_CODE = 75
const JOINED_OFFSET = 1

let dir: string
let landing: string
let socketPath: string
let markerPath: string
let daemon: Server
const children: ChildProcess[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "child-contract-"))
  landing = join(dir, "landing")
  mkdirSync(join(landing, "plugins", "claude"), { recursive: true })
  socketPath = join(dir, "tribe.sock")
  markerPath = join(dir, "spawn.jsonl")
  // The stub child records the env the supervisor built for it; on its FIRST
  // spawn it reports its supervised identity over the real IPC message and asks
  // for a joined re-exec; on the resume spawn it exits clean.
  writeFileSync(
    join(landing, "plugins", "claude", "server.ts"),
    [
      'import { appendFileSync } from "node:fs"',
      "const seen = {",
      "  entry: process.argv[1],",
      "  cwd: process.cwd(),",
      "  child: process.env.TRIBE_PLUGIN_ADAPTER_CHILD ?? null,",
      "  name: process.env.TRIBE_NAME ?? null,",
      "  resumeJoined: process.env.TRIBE_PLUGIN_RESUME_JOINED ?? null,",
      "  providerParentPid: process.env.TRIBE_PLUGIN_PROVIDER_PARENT_PID ?? null,",
      "  reexecExitCode: process.env.TRIBE_PLUGIN_REEXEC_EXIT_CODE ?? null,",
      "  refusalExitCode: process.env.TRIBE_PLUGIN_PERSONA_REFUSAL_EXIT_CODE ?? null,",
      "  exitRecord: process.env.TRIBE_PLUGIN_ADAPTER_EXIT_RECORD ?? null,",
      "}",
      'appendFileSync(process.env.SPAWN_MARKER!, JSON.stringify(seen) + "\\n")',
      'if (seen.resumeJoined === "1") process.exit(0)',
      'process.send?.({ tribePluginIdentity: { name: "@agent/contract", joined: true } })',
      `process.exit(${REEXEC_EXIT_CODE + JOINED_OFFSET})`,
      "",
    ].join("\n"),
  )
})

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL")
  daemon?.close()
  rmSync(dir, { recursive: true, force: true })
})

function startFakeDaemon(): Promise<void> {
  daemon = createServer((socket) => {
    const parse = createLineParser((msg) => {
      if (!isRequest(msg)) return
      if (msg.method === "cli_status") {
        socket.write(
          makeResponse(msg.id, { sessions: [], daemon: { code_identity: { cert: "cert-1", root: landing } } }),
        )
      }
    })
    socket.on("data", parse)
    socket.on("error", () => {})
  })
  return new Promise((done) => daemon.listen(socketPath, done))
}

function startSupervisor(): void {
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
  children.push(spawn(process.execPath, [SERVER], { cwd: PLUGIN_ROOT, env, stdio: ["pipe", "pipe", "pipe"] }))
}

interface SpawnRecord {
  readonly entry: string
  readonly cwd: string
  readonly child: string | null
  readonly name: string | null
  readonly resumeJoined: string | null
  readonly providerParentPid: string | null
  readonly reexecExitCode: string | null
  readonly refusalExitCode: string | null
  readonly exitRecord: string | null
}

function records(): SpawnRecord[] {
  try {
    return readFileSync(markerPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as SpawnRecord)
  } catch (error) {
    // The marker file does not exist until the stub entry writes its first line; the caller polls for that.
    // Anything else (a permission error, a torn line) is not "no records yet" and must surface.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

describe("the supervisor<->child contract (27531 RED 6)", () => {
  it("the env names, the identity IPC message and the joined re-exec code all cross as spelled", async () => {
    await startFakeDaemon()
    startSupervisor()
    await vi.waitFor(() => expect(records()).toHaveLength(2), { timeout: 20_000, interval: 100 })
    const [first, second] = records()
    // The child is the landing's entry, told it is the child, with the host cwd.
    expect(first!.entry).toBe(join(landing, "plugins", "claude", "server.ts"))
    expect(first!.cwd).toBe(PLUGIN_ROOT)
    expect(first!.child).toBe("1")
    // The env names the pair shares, by their wire-level spelling and value.
    expect(first!.reexecExitCode).toBe(String(REEXEC_EXIT_CODE))
    expect(first!.refusalExitCode).toBe("79")
    expect(first!.providerParentPid).toMatch(/^[1-9]\d*$/u)
    expect(first!.exitRecord).not.toBeNull()
    // The submitted identity (tribePluginIdentity) and the joined bit (75+1)
    // reached the supervisor: the resume spawn carries the reported name and
    // the joined marker, overriding the supervisor's own inherited TRIBE_NAME.
    expect(second!.name).toBe("@agent/contract")
    expect(second!.resumeJoined).toBe("1")
  }, 30_000)
})
