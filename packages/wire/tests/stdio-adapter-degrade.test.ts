/**
 * Daemon-unavailable degrade (km @km/silvercode/19851 slice 2 — "loud but
 * soft"): when the daemon can never start (no socket, no daemon script),
 * the stdio adapter must
 *
 *   1. still answer the MCP `initialize` handshake (session opens fine),
 *   2. return a clean per-call error from tribe tools — never crash,
 *   3. stay alive across repeated calls (no unhandled-rejection death from
 *      the `daemonReady.then(...)` notification chain),
 *   4. emit ONE degrade notice (log/channel), not one per call.
 *
 * A solo session with tribe broken is a fully functional session.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const ADAPTER = resolve(dirname(fileURLToPath(import.meta.url)), "../src/stdio-adapter.ts")
const BUN_BIN = process.versions.bun ? process.execPath : "bun"

function writeJson(child: ChildProcessWithoutNullStreams, payload: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(payload)}\n`)
}

function collectJson(child: ChildProcessWithoutNullStreams): Record<string, unknown>[] {
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
        /* non-json noise */
      }
    }
  })
  return lines
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  label: string | (() => string) = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for ${typeof label === "function" ? label() : label}`)
}

describe("stdio adapter — daemon-unavailable degrade", () => {
  let tmpDir: string
  let child: ChildProcessWithoutNullStreams | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-degrade-"))
  })

  afterEach(() => {
    child?.kill("SIGTERM")
    child = undefined
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("no daemon + no daemon script: initialize works, tool calls error cleanly, adapter survives", async () => {
    const socketPath = join(tmpDir, "absent.sock")
    const logPath = join(tmpDir, "adapter.log")
    const env = { ...process.env, TRIBE_DELIVERY: "pull", DEBUG_LOG: logPath, LOG_LEVEL: "warn" }
    delete (env as Record<string, string | undefined>).TRIBE_DAEMON_SCRIPT
    delete (env as Record<string, string | undefined>).TRIBE_SOCKET
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "degrade-test"], {
      cwd: tmpDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams
    let stderr = ""
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8")
    })
    const out = collectJson(child)

    // 1. MCP handshake answers even though the daemon can never come up.
    writeJson(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "degrade-test", version: "0" } },
    })
    await waitFor(
      () => out.some((l) => l.id === 1 && "result" in l),
      5_000,
      () => `initialize response; exit=${child?.exitCode} jsonLines=${out.length} stderr:\n${stderr.slice(-1500)}`,
    )

    // 2 + 3. Two tool calls in sequence: clean error content both times, no crash.
    for (const id of [2, 3]) {
      writeJson(child, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "members", arguments: {} } })
      await waitFor(() => out.some((l) => l.id === id && "result" in l), 5_000, `tools/call ${id} response`)
      const reply = out.find((l) => l.id === id) as {
        result?: { content?: Array<{ text?: string }> }
      }
      const text = reply.result?.content?.[0]?.text ?? ""
      expect(text.toLowerCase()).toContain("tribe unavailable")
      expect(text).toContain("solo")
    }
    expect(child.exitCode).toBeNull()
    expect(stderr).not.toContain("Unhandled")

    // 4. Exactly ONE degrade notice in the log — not one per call.
    const log = readFileSync(logPath, "utf8")
    const notices = log.split("\n").filter((l) => l.includes("running solo"))
    expect(notices.length).toBe(1)
  }, 20_000)
})
