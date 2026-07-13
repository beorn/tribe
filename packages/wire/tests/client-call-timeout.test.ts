// 20703 — per-call timeout on DaemonClient.call.
//
// The wire client hard-caps every daemon RPC at `callTimeoutMs` (default 10s)
// and destroys the connection after 3 consecutive timeouts. The MCP inbox-wait
// tool advertises 30s-default / max-window long-polls, so every wait >10s errored
// at 10s and every third one tore down a HEALTHY connection — the churn generator
// behind the 20703 recurrence. The fix threads a per-call `{ timeoutMs }` override
// through `call`, and exempts an explicit-timeout expiry from the 3-strike destroy
// (an intentional long-poll expiring is not evidence the daemon is dead).
//
// Millisecond-scale timings only (never real 10s sleeps): default 50-100ms,
// daemon delay 300ms, per-call override 1000ms.

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type Server } from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { connectToDaemon } from "../src/client.ts"
import { createLineParser } from "../src/parser.ts"
import { isRequest, makeResponse } from "../src/rpc.ts"

/**
 * Fake daemon with configurable per-method latency on a temp Unix socket:
 *  - `echo` → responds immediately with the params.
 *  - `slow` → responds after `delayMs`.
 *  - `hang` (and anything else) → never responds (drives the per-call timeout).
 */
function spawnLatencyDaemon(socketPath: string, opts: { delayMs?: number } = {}): Promise<Server> {
  const delayMs = opts.delayMs ?? 300
  return new Promise((resolveServer) => {
    const server = createServer((socket) => {
      const safeWrite = (line: string) => {
        if (socket.writable) socket.write(line)
      }
      const parse = createLineParser((msg) => {
        if (!isRequest(msg)) return
        if (msg.method === "echo") {
          safeWrite(makeResponse(msg.id, { echoed: msg.params }))
        } else if (msg.method === "slow") {
          const t = setTimeout(() => safeWrite(makeResponse(msg.id, { echoed: msg.params })), delayMs)
          ;(t as { unref?: () => void }).unref?.()
        }
        // "hang" and unknown methods: deliberately silent.
      })
      socket.on("data", parse)
      socket.on("error", () => {
        /* ignore */
      })
    })
    server.listen(socketPath, () => resolveServer(server))
  })
}

describe("DaemonClient.call per-call timeout (20703)", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-call-timeout-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("honors a larger per-call timeout that exceeds the default callTimeoutMs", async () => {
    const sock = join(tmpDir, "d.sock")
    const server = await spawnLatencyDaemon(sock, { delayMs: 300 })
    try {
      // Default per-call timeout (100ms) is shorter than the daemon's 300ms
      // response — without the per-call override this call would time out.
      const client = await connectToDaemon(sock, { callTimeoutMs: 100 })
      const result = await client.call("slow", { hi: 1 }, { timeoutMs: 1000 })
      expect(result).toEqual({ echoed: { hi: 1 } })
      client.close()
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it("still times out a default (no-override) call that outruns callTimeoutMs", async () => {
    const sock = join(tmpDir, "d.sock")
    const server = await spawnLatencyDaemon(sock, { delayMs: 300 })
    try {
      const client = await connectToDaemon(sock, { callTimeoutMs: 100 })
      await expect(client.call("slow", { hi: 1 })).rejects.toThrow(/timed out/)
      client.close()
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it("does NOT destroy the connection after 3 explicit-timeout expiries (long-poll expiry is not death)", async () => {
    const sock = join(tmpDir, "d.sock")
    const server = await spawnLatencyDaemon(sock)
    try {
      const client = await connectToDaemon(sock, { callTimeoutMs: 50 })
      for (let i = 0; i < 3; i++) {
        await expect(client.call("hang", {}, { timeoutMs: 50 })).rejects.toThrow(/timed out/)
      }
      // The connection must survive an intentional long-poll expiry.
      expect(client.socket.destroyed).toBe(false)
      // ...and must still be usable.
      const result = await client.call("echo", { ok: 1 })
      expect(result).toEqual({ echoed: { ok: 1 } })
      client.close()
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it("still destroys the connection after 3 DEFAULT-timeout expiries (daemon may be dead)", async () => {
    const sock = join(tmpDir, "d.sock")
    const server = await spawnLatencyDaemon(sock)
    try {
      const client = await connectToDaemon(sock, { callTimeoutMs: 50 })
      for (let i = 0; i < 3; i++) {
        await expect(client.call("hang", {})).rejects.toThrow(/timed out/)
      }
      // Three consecutive default-timeout expiries still trip the destroy.
      expect(client.socket.destroyed).toBe(true)
      client.close()
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
