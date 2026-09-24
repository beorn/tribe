/**
 * @failure A daemon launched with `--vault-db` on a missing file exits at startup, and because the daemon is wire
 *          (the bus), a moved pm/.km/state.db keeps the whole fleet's bus down under hab's restart loop.
 * @level   l4
 * @consumer 25149, @cto 405805a7: the bus outranks the vault
 *
 * Boots the real daemon in a fresh temp directory (socket, db, recall db) with `--vault-db` naming no file, then
 * proves it boots, answers wire RPCs, refuses the recall call that needs the vault naming the path, and that its
 * boot line and health document carry the refusal. The page's raise-once / clear-on-restart edge is witnessed at
 * l2 in vault-db-page.test.ts.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { connectToDaemon, type DaemonClient } from "tribe-wire"
import { RECALL_ERRORS, RECALL_PROTOCOL_VERSION, TRIBE_METHODS } from "../../../../plugins/claude/recall/lib/rpc.ts"

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

describe("a daemon whose --vault-db names no file boots with the recall vault REFUSED (25149)", () => {
  let dir: string
  let daemon: ChildProcess | undefined
  let client: DaemonClient | undefined
  let output = ""

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tribe-vault-refused-"))
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

  it("boots, answers wire RPCs, refuses inject_delta naming the path, and says so on its boot line and in health", async () => {
    const socketPath = join(dir, "tribe.sock")
    const missing = join(dir, "moved", "state.db")
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
        "--vault-db",
        missing,
        "--foreground",
      ],
      { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] },
    )
    daemon.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()))
    daemon.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()))
    await waitFor(() => existsSync(socketPath) || daemon?.exitCode !== null, "daemon socket")
    expect(daemon.exitCode, output).toBeNull()

    client = await connectToDaemon(socketPath, { callTimeoutMs: 5_000 })
    // The health document is MCP-shaped: `tribe health` reads its structured content.
    const health = (
      (await client.call("cli_health")) as {
        structuredContent: { issues: string[]; recall_vault?: { state: string; path: string; reason: string } }
      }
    ).structuredContent
    expect(health.recall_vault).toEqual({
      state: "refused",
      path: missing,
      reason: `${missing} does not exist (pass the vault's state.db path)`,
    })
    expect(health.issues).toContain(
      `recall vault REFUSED: --vault-db ${missing} does not exist (pass the vault's state.db path)`,
    )

    await client.call(TRIBE_METHODS.hello, {
      clientName: "vault-refused-test",
      clientVersion: "0.0.0",
      protocolVersion: RECALL_PROTOCOL_VERSION,
    })
    const refused = await client.call(TRIBE_METHODS.injectDelta, { prompt: "anything", sessionId: "s1" }).then(
      () => null,
      (error: unknown) => error as Error & { code?: number },
    )
    expect(refused?.message).toContain(`recall vault REFUSED: ${missing} does not exist`)
    expect(refused?.code).toBe(RECALL_ERRORS.vaultRefused)

    await waitFor(() => output.includes("Recall vault: REFUSED"), "the boot line", 5_000)
    expect(output).toContain(`Recall vault: REFUSED ${missing} does not exist (pass the vault's state.db path)`)
  })
})
