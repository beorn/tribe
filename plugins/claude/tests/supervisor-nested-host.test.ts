/**
 * @failure A provider run INSIDE a managed seat (an agy one-shot from bearly) starts its own tribe plugin supervisor,
 *          which inherits the seat's launch declaration, takes over the seat's supervisor claim, and makes the seat's
 *          real supervisor yield: the seat's adapter records host-stop and the seat goes dark (29567).
 * @level    l2
 * @consumer @dev/12 #29567, plugin supervisor start (server.ts superviseAdapter), @cto 42880a68, 4dc25c38, 6cbf36b7
 * @testonly none
 *
 * A managed launch declares its harness PID; the harness starts the provider, which starts the supervisor. So the
 * declared PID is exactly the supervisor's grandparent (census of 48 live supervisors, 2026-10-15). A supervisor that
 * sits deeper is a nested host: it exits 2 before it claims or connects, and records one row of its own decision in
 * the seat's exit record. The gap-5 respawn, a new launch generation and an exec'ing wrapper keep the seat's
 * supervisor admitted.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { HAB_ID_TOKEN_ENV, HAB_ID_TOKEN_FILE_ENV } from "tribe-wire/lib/hab-session-env"
import { TRIBE_PLUGIN_PROVIDER_PARENT_PID_ENV } from "tribe-wire/lib/session-identity-env"
import { AG_HOST_SESSION_STATE_DIR_ENV } from "tribe-wire/lib/ag-host-env"
import { PLUGIN_SUPERVISOR_CLAIM_FILE } from "../supervisor-claim.ts"
import { createLineParser } from "../../../packages/wire/src/parser.ts"
import { isRequest, makeResponse } from "../../../packages/wire/src/rpc.ts"
import { launchToken } from "../../../packages/wire/tests/launch-token.ts"

const PLUGIN_ROOT = resolve(import.meta.dirname, "..")
const SERVER = join(PLUGIN_ROOT, "server.ts")
const PROVIDER_HOST = join(PLUGIN_ROOT, "tests", "fixtures", "provider-host.ts")
const TRIBE_ROOT = resolve(PLUGIN_ROOT, "../..")
const EXIT_RECORD_FILE = "tribe-adapter-exits.jsonl"

type HostEvent =
  | { event: "host"; pid: number; ppid: number }
  | { event: "spawned"; pid: number }
  | { event: "stderr"; pid: number; line: string }
  | { event: "exit"; pid: number; code: number | null; signal: string | null }

type Host = { readonly process: ChildProcess; readonly events: HostEvent[] }

let dir: string
let claimPath: string
let socketPath: string
let server: Server
let sockets: Set<Socket>
let connections: number
const hosts: Host[] = []

/** A managed seat's environment: a launch token, the seat's state directory, and the declared harness PID. */
function seatEnv(declaredHarnessPid: number | null, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRIBE_SOCKET: socketPath,
    TRIBE_NO_AUTOSTART: "1",
    TRIBE_NAME: "@agent/test",
    [HAB_ID_TOKEN_ENV]: launchToken("29567-seat-launch", "@agent/test"),
    [AG_HOST_SESSION_STATE_DIR_ENV]: dir,
    TRIBE_PLUGIN_SUPERVISOR_CLAIM_POLL_MS: "25",
    FIXTURE_CLAIM_PATH: claimPath,
    ...extra,
  }
  delete env[HAB_ID_TOKEN_FILE_ENV]
  delete env[TRIBE_PLUGIN_PROVIDER_PARENT_PID_ENV]
  if (declaredHarnessPid !== null) env[TRIBE_PLUGIN_PROVIDER_PARENT_PID_ENV] = String(declaredHarnessPid)
  return env
}

/**
 * Start a provider host under this test process. `direct`: the host is this process's child. `spawning`: a shell
 * that runs the host as its child and waits, so one more process sits between. `exec`: a shell that execs the host,
 * as every cmux wrapper and cursor-agent's launcher do.
 */
function startHost(shape: "direct" | "spawning" | "exec", env: NodeJS.ProcessEnv): Host {
  const command =
    shape === "direct"
      ? [process.execPath, PROVIDER_HOST, SERVER]
      : ["sh", "-c", shape === "exec" ? 'exec "$@"' : '"$@"; exit $?', "sh", process.execPath, PROVIDER_HOST, SERVER]
  const [file, ...args] = command as [string, ...string[]]
  // Its own process group, so cleanup reaches the supervisors and adapters below it.
  const child = spawn(file, args, { cwd: PLUGIN_ROOT, env, stdio: ["ignore", "pipe", "inherit"], detached: true })
  const host: Host = { process: child, events: [] }
  hosts.push(host)
  let pending = ""
  child.stdout?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => {
    pending += chunk
    const lines = pending.split("\n")
    pending = lines.pop() ?? ""
    for (const line of lines) host.events.push(JSON.parse(line) as HostEvent)
  })
  return host
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolveTick) => setTimeout(resolveTick, 20))
  }
}

function spawnedPids(host: Host): number[] {
  return host.events.flatMap((row) => (row.event === "spawned" ? [row.pid] : []))
}

function exitOf(host: Host, pid: number): Extract<HostEvent, { event: "exit" }> | undefined {
  return host.events.find(
    (row): row is Extract<HostEvent, { event: "exit" }> => row.event === "exit" && row.pid === pid,
  )
}

function hostOf(host: Host): Extract<HostEvent, { event: "host" }> | undefined {
  return host.events.find((row): row is Extract<HostEvent, { event: "host" }> => row.event === "host")
}

function claimPid(): number | null {
  if (!existsSync(claimPath)) return null
  try {
    return (JSON.parse(readFileSync(claimPath, "utf8")) as { pid: number }).pid
  } catch {
    return null // a claim mid-write; the caller waits for a settled one
  }
}

function exitRows(): Array<Record<string, unknown>> {
  const path = join(dir, EXIT_RECORD_FILE)
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** Start the seat's own supervisor (the harness is this test process) and wait until it holds the claim. */
async function startSeat(): Promise<{ host: Host; supervisor: number }> {
  const host = startHost("direct", seatEnv(process.pid))
  await waitFor(() => spawnedPids(host).length === 1, "the seat's supervisor")
  const supervisor = spawnedPids(host)[0] as number
  await waitFor(() => claimPid() === supervisor, "the seat's supervisor claim")
  return { host, supervisor }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tribe-supervisor-nested-"))
  claimPath = join(dir, PLUGIN_SUPERVISOR_CLAIM_FILE)
  socketPath = join(dir, "tribe.sock")
  sockets = new Set()
  connections = 0
  server = createServer((socket) => {
    // Accept and idle, answering cli_status with this checkout as the landing root (27531), as the takeover test does.
    connections += 1
    sockets.add(socket)
    const parse = createLineParser((msg) => {
      if (!isRequest(msg)) return
      if (msg.method === "cli_status") {
        socket.write(
          makeResponse(msg.id, { sessions: [], daemon: { code_identity: { cert: "test-cert", root: TRIBE_ROOT } } }),
        )
      }
    })
    socket.on("data", parse)
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise<void>((res) => server.listen(socketPath, res))
})

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    try {
      if (host.process.pid !== undefined) process.kill(-host.process.pid, "SIGKILL")
    } catch {
      // the group is already gone
    }
  }
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await new Promise<void>((res) => server.close(() => res()))
  rmSync(dir, { recursive: true, force: true })
})

describe("a provider nested inside a managed seat (29567)", () => {
  it("is refused before it claims or connects, records one row of its own, and leaves the seat's supervisor holding the launch", async () => {
    const seat = await startSeat()
    await waitFor(() => connections > 0, "the seat's adapter connection")
    const seatConnections = connections

    // The nested host inherits the seat's whole environment, declaration included, one process deeper.
    const nested = startHost("spawning", seatEnv(process.pid))
    await waitFor(() => spawnedPids(nested).length === 1 && hostOf(nested) !== undefined, "the nested supervisor")
    const nestedSupervisor = spawnedPids(nested)[0] as number
    // Before the cure the nested supervisor never exits: it takes the claim and the seat's supervisor yields instead.
    await waitFor(
      () => exitOf(nested, nestedSupervisor) !== undefined || exitOf(seat.host, seat.supervisor) !== undefined,
      "the nested supervisor's exit or the seat's supervisor yielding",
    )
    const nestedHost = hostOf(nested) as Extract<HostEvent, { event: "host" }>

    // The seat's supervisor still holds the launch and was never told to stop.
    expect({ claim: claimPid(), seatExit: exitOf(seat.host, seat.supervisor) }).toEqual({
      claim: seat.supervisor,
      seatExit: undefined,
    })
    expect(exitOf(nested, nestedSupervisor)?.code).toBe(2)
    const reason =
      `refused to act as this seat's supervisor: its provider ${nestedHost.pid} is not a direct child of the seat's ` +
      `harness ${process.pid}; the provider's parent is ${nestedHost.ppid} (29567)`
    expect(nested.events).toContainEqual({
      event: "stderr",
      pid: nestedSupervisor,
      line: `tribe plugin supervisor: ${reason}; exit 2`,
    })

    // Nothing new connected, and the seat's record holds the refusal's own row and no exit of the seat's adapter.
    expect(connections).toBe(seatConnections)
    expect(exitRows()).toEqual([
      {
        at: expect.any(String),
        adapter_pid: null,
        code: null,
        signal: null,
        decision: "nested-host-refused",
        reason,
      },
    ])
  }, 20_000)

  it("an exec'ing wrapper between the harness and the provider keeps the seat's supervisor admitted", async () => {
    const host = startHost("exec", seatEnv(process.pid))
    await waitFor(() => spawnedPids(host).length === 1, "the supervisor")
    const supervisor = spawnedPids(host)[0] as number
    await waitFor(() => claimPid() === supervisor, "its claim")
    expect(hostOf(host)?.ppid).toBe(process.pid)
    expect(exitOf(host, supervisor)).toBeUndefined()
    expect(exitRows()).toEqual([])
  }, 20_000)

  it("a gap-5 respawn under the seat's own provider still supersedes the older supervisor", async () => {
    const host = startHost("direct", seatEnv(process.pid, { FIXTURE_SUPERVISORS: "2" }))
    await waitFor(() => spawnedPids(host).length === 2, "the respawned supervisor")
    const [older, newer] = spawnedPids(host) as [number, number]
    await waitFor(() => exitOf(host, older) !== undefined, "the older supervisor's exit")

    expect(exitOf(host, older)?.code).toBe(0)
    await waitFor(() => claimPid() === newer, "the newer supervisor's claim")
    expect(exitOf(host, newer)).toBeUndefined()
  }, 20_000)

  it("a new launch generation, a new harness on the same state directory, still takes the launch over", async () => {
    // Each launch's harness is its own process: a shell between this test and the host, declared by the host.
    const first = startHost("spawning", seatEnv(null, { FIXTURE_DECLARE_PARENT: "1" }))
    await waitFor(() => spawnedPids(first).length === 1, "the first generation's supervisor")
    const older = spawnedPids(first)[0] as number
    await waitFor(() => claimPid() === older, "the first generation's claim")

    const second = startHost("spawning", seatEnv(null, { FIXTURE_DECLARE_PARENT: "1" }))
    await waitFor(() => spawnedPids(second).length === 1, "the second generation's supervisor")
    const newer = spawnedPids(second)[0] as number
    await waitFor(() => exitOf(first, older) !== undefined, "the first generation's exit")

    expect(exitOf(first, older)?.code).toBe(0)
    await waitFor(() => claimPid() === newer, "the second generation's claim")
    expect(exitOf(second, newer)).toBeUndefined()
  }, 20_000)
})
