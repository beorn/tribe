/**
 * @failure  A host that re-spawns its MCP supervisor without closing the old
 *           stdio pipe leaves the old supervisor+adapter pair running for days
 *           (#27459 gap-5). This proves the OLDER supervisor exits once a newer
 *           one for the same launch claims the slot, while the newer survives.
 * @level    l2
 * @consumer @dev/luna6 #27459 gap-5, plugin supervisor lifecycle
 * @testonly none
 */
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { HAB_ID_TOKEN_ENV } from "tribe-wire/lib/hab-session-env"
import { TRIBE_PLUGIN_PROVIDER_PARENT_PID_ENV } from "tribe-wire/lib/session-identity-env"
import { AG_HOST_SESSION_STATE_DIR_ENV } from "tribe-wire/lib/ag-host-env"
import { PLUGIN_SUPERVISOR_CLAIM_FILE } from "../supervisor-claim.ts"

const PLUGIN_ROOT = resolve(import.meta.dirname, "..")
const SERVER = join(PLUGIN_ROOT, "server.ts")

let dir: string
let claimPath: string
let socketPath: string
let server: Server
let sockets: Set<Socket>
const children: ChildProcess[] = []

function supervisorEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // A live socket keeps the adapter child connected and long-lived, so the
    // takeover cannot pass by the child having exited on its own.
    TRIBE_SOCKET: socketPath,
    TRIBE_NO_AUTOSTART: "1",
    TRIBE_NAME: "@agent/test",
    [AG_HOST_SESSION_STATE_DIR_ENV]: dir,
    TRIBE_PLUGIN_SUPERVISOR_CLAIM_POLL_MS: "25",
  }
  // No managed launch: the wrapper falls back to its real provider parent, which
  // is this test process for both supervisors.
  delete env[HAB_ID_TOKEN_ENV]
  delete env[TRIBE_PLUGIN_PROVIDER_PARENT_PID_ENV]
  return env
}

function startSupervisor(): ChildProcess {
  const child = spawn(process.execPath, [SERVER], {
    cwd: PLUGIN_ROOT,
    env: supervisorEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  })
  children.push(child)
  return child
}

function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((res) => child.once("exit", (code, signal) => res({ code, signal })))
}

function alive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolveTick) => setTimeout(resolveTick, 20))
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tribe-supervisor-takeover-"))
  claimPath = join(dir, PLUGIN_SUPERVISOR_CLAIM_FILE)
  socketPath = join(dir, "tribe.sock")
  sockets = new Set()
  server = createServer((socket) => {
    // Accept and idle: the adapter stays connected and never sees EOF.
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise<void>((res) => server.listen(socketPath, res))
})

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (alive(child)) child.kill("SIGKILL")
  }
  // A supervisor killed with SIGKILL can leave its adapter child holding the
  // accepted socket; close the server side so the listener can finish closing.
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await new Promise<void>((res) => server.close(() => res()))
  rmSync(dir, { recursive: true, force: true })
})

describe("plugin supervisor takeover (#27459 gap-5)", () => {
  it("the older supervisor exits when a second one starts for the same launch", async () => {
    const first = startSupervisor()
    await waitFor(() => existsSync(claimPath), "first supervisor claim")
    expect(alive(first)).toBe(true)
    expect((JSON.parse(readFileSync(claimPath, "utf8")) as { pid: number }).pid).toBe(first.pid)

    const firstExit = exited(first)
    const second = startSupervisor()
    const result = await firstExit

    // The older pair yields the launch to the newer one.
    expect(result.code).toBe(0)
    expect(alive(second)).toBe(true)
    await waitFor(
      () => (JSON.parse(readFileSync(claimPath, "utf8")) as { pid: number }).pid === second.pid,
      "second supervisor claim",
    )
  })
})
