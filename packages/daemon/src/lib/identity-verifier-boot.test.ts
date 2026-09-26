/**
 * @failure A launch line naming a verifier the daemon cannot use starts a bus that verifies nobody, and every seat
 *          silently degrades to its claimed name.
 * @level   l4
 * @consumer 25074 3b, @cto 4a194bbf: a boot-time check refusing startup naming the path
 *
 * Boots the real daemon in a fresh temp directory twice: once naming a module that does not exist, which exits 1
 * naming the path before any socket binds; once naming a stub verifier, which boots, names the verifier in health, and serves a registration carrying a token the stub verifies as verified.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { connectToDaemon, type DaemonClient } from "tribe-wire"

const DAEMON = resolve(import.meta.dirname, "../daemon.ts")
const BUN_BIN = process.versions.bun ? process.execPath : "bun"

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((tick) => setTimeout(tick, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe("the daemon's --identity-verifier boot check (25074 3b)", () => {
  let dir: string
  let daemon: ChildProcess | undefined
  let client: DaemonClient | undefined
  let output = ""

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tribe-identity-boot-"))
    output = ""
  })

  afterEach(async () => {
    client?.close()
    if (daemon?.pid && daemon.exitCode === null) {
      daemon.kill("SIGTERM")
      await waitFor(() => daemon?.exitCode !== null || daemon?.signalCode !== null, "daemon exit", 5_000).catch(() =>
        daemon?.kill("SIGKILL"),
      )
    }
    rmSync(dir, { recursive: true, force: true })
  })

  function startDaemon(verifierPath: string): string {
    const socketPath = join(dir, "tribe.sock")
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith("HAB_") || key.startsWith("TRIBE_")) delete env[key]
    Object.assign(env, { TRIBE_NO_AUTORELOAD: "1", TRIBE_NO_PLUGINS: "1", XDG_DATA_HOME: join(dir, "xdg-data") })
    daemon = spawn(
      BUN_BIN,
      [
        DAEMON,
        "--socket",
        socketPath,
        "--db",
        join(dir, "tribe.db"),
        "--recall-db",
        join(dir, "recall.db"),
        "--identity-verifier",
        verifierPath,
        "--foreground",
      ],
      { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] },
    )
    daemon.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()))
    daemon.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()))
    return socketPath
  }

  it("refuses startup naming the path when the verifier module does not exist, and binds no socket", async () => {
    const missing = join(dir, "moved", "verifier.ts")
    const socketPath = startDaemon(missing)
    await waitFor(() => daemon?.exitCode !== null, "daemon exit")

    expect(daemon?.exitCode, output).toBe(1)
    expect(output).toContain(`Refusing to start: --identity-verifier ${missing}: does not exist`)
    expect(existsSync(socketPath)).toBe(false)
  })

  it("boots with a stub verifier, names it and its gen supply, and serves a token-keyed registration as verified", async () => {
    const verifierPath = join(dir, "verifier.ts")
    writeFileSync(
      verifierPath,
      `export const IDENTITY_VERIFIER_INTERFACE = 1
       export const IDENTITY_VERIFIER_SUPPLIES_GEN = true
       export async function verifyIdentity(token) {
         return token === "token-dev7"
           ? { result: "verified", actor: "@dev/7", sid: "sid-dev7", gen: 1 }
           : { result: "absent" }
       }`,
    )
    const socketPath = startDaemon(verifierPath)
    await waitFor(() => existsSync(socketPath) || daemon?.exitCode !== null, "daemon socket")
    expect(daemon?.exitCode, output).toBeNull()

    client = await connectToDaemon(socketPath, { callTimeoutMs: 5_000 })
    await client.call("register", {
      name: "@dev/7",
      role: "member",
      pid: process.pid,
      project: dir,
      delivery: "pull",
      launchParentPid: process.pid,
      idToken: "token-dev7",
    })
    const health = (
      (await client.call("cli_health")) as {
        structuredContent: {
          identity: { verifier: string | null; supplies_gen: boolean | null; authority: Record<string, number> }
        }
      }
    ).structuredContent
    expect(health.identity).toEqual({
      verifier: verifierPath,
      supplies_gen: true,
      authority: { verified: 1, bearer: 0, claimed: 0 },
      // 25074 3d-3 prerequisite: a booted daemon counts from its own start; a verified register journals no row.
      bearer_served: expect.objectContaining({
        halves: ["messages", "messages_archive"],
        truncated_at: null,
        gate: expect.objectContaining({ total: 0 }),
        hand: expect.objectContaining({ total: 0 }),
      }),
    })
  })
})
