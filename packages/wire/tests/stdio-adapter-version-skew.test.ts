/**
 * Version-skew guard (km @km/silvercode/19851 slice 3): when the daemon's
 * register response carries a different protocolVersion, the adapter fails
 * loud instead of continuing with an incompatible payload contract.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createServer, type Server, type Socket } from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createLineParser } from "../src/parser.ts"
import { isRequest, makeResponse } from "../src/rpc.ts"

const ADAPTER = resolve(dirname(fileURLToPath(import.meta.url)), "../src/stdio-adapter.ts")
const BUN_BIN = process.versions.bun ? process.execPath : "bun"

function spawnSkewedDaemon(socketPath: string): Promise<{ server: Server; clients: Socket[] }> {
  const clients: Socket[] = []
  return new Promise((resolveServer) => {
    const server = createServer((socket) => {
      clients.push(socket)
      const parse = createLineParser((msg) => {
        if (!isRequest(msg)) return
        if (msg.method === "register") {
          socket.write(
            makeResponse(msg.id, {
              sessionId: "skew-s1",
              name: "skew-test",
              role: "member",
              chief: "",
              protocolVersion: 999_999,
            }),
          )
          return
        }
        if (msg.method === "tribe.members") {
          socket.write(makeResponse(msg.id, { content: [{ type: "text", text: JSON.stringify({ sessions: [] }) }] }))
          return
        }
        socket.write(makeResponse(msg.id, { ok: true }))
      })
      socket.on("data", parse)
      socket.on("error", () => {
        /* test teardown */
      })
    })
    server.listen(socketPath, () => resolveServer({ server, clients }))
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe("stdio adapter — protocol version skew", () => {
  let tmpDir: string
  let child: ChildProcessWithoutNullStreams | undefined
  let daemon: { server: Server; clients: Socket[] } | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-skew-"))
  })

  afterEach(async () => {
    child?.kill("SIGTERM")
    child = undefined
    for (const s of daemon?.clients ?? []) s.destroy()
    if (daemon) await new Promise<void>((r) => daemon!.server.close(() => r()))
    daemon = undefined
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("fails loud on mismatch instead of serving tools across incompatible payload contracts", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const logPath = join(tmpDir, "adapter.log")
    daemon = await spawnSkewedDaemon(socketPath)
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "skew-test"], {
      cwd: tmpDir,
      env: { ...process.env, TRIBE_DELIVERY: "pull", DEBUG_LOG: logPath, LOG_LEVEL: "warn" },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams

    await waitFor(
      () => {
        try {
          return readFileSync(logPath, "utf8").includes("protocol version mismatch")
        } catch {
          return false
        }
      },
      8_000,
      "skew failure in adapter log",
    )

    await waitFor(() => child?.exitCode !== null, 8_000, "adapter exit")
    expect(child.exitCode).toBe(2)
  }, 20_000)
})
