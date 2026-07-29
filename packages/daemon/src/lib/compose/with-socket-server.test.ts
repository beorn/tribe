import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type Server } from "node:net"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createScope } from "tribe-wire"
import { probeAndCleanSocket, withSocketServer } from "./with-socket-server.ts"

/**
 * Regression guard for the tribe presence/offline root cause: a daemon
 * starting up must NEVER unlink a socket a LIVE daemon already owns. The old
 * single-probe check could transiently fail against a busy-but-live winner
 * (full accept backlog / hot-reload window) and delete its socket before
 * binding a competitor — the split-brain that left every pane
 * "active-pane-no-tribe". probeAndCleanSocket now retries before reclaiming.
 */
describe("probeAndCleanSocket (never unlinks a live socket)", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-probe-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns true and preserves the socket when a daemon is listening", async () => {
    const sock = join(tmpDir, "live.sock")
    const server: Server = await new Promise((resolveServer) => {
      const s = createServer()
      s.listen(sock, () => resolveServer(s))
    })
    try {
      const alive = await probeAndCleanSocket(sock)
      expect(alive).toBe(true)
      // The live socket must remain — reclaiming it would orphan the daemon.
      expect(existsSync(sock)).toBe(true)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it("returns false and reclaims a stale (dead) socket file", async () => {
    const sock = join(tmpDir, "stale.sock")
    // A leftover file with nothing listening — every probe refuses.
    writeFileSync(sock, "")
    const alive = await probeAndCleanSocket(sock)
    expect(alive).toBe(false)
    expect(existsSync(sock)).toBe(false)
  })

  it("returns false when the socket file is absent (nothing to clean)", async () => {
    const sock = join(tmpDir, "absent.sock")
    const alive = await probeAndCleanSocket(sock)
    expect(alive).toBe(false)
    expect(existsSync(sock)).toBe(false)
  })

  it("reports a non-election bind failure through the daemon health gate", async () => {
    const scope = createScope("socket-bind-health-test")
    const healthLog = vi.fn()
    const subject = withSocketServer()({
      scope,
      config: {
        inheritFd: null,
        socketPath: join(tmpDir, "missing", "tribe.sock"),
      },
      broadcast: { log: healthLog },
    } as never)

    await expect(subject.socket.binding).rejects.toMatchObject({ code: "ENOENT" })
    expect(healthLog).toHaveBeenCalledWith("tribe:socket: bind failed (code=ENOENT)", "health:daemon:error")
    await scope[Symbol.asyncDispose]()
  })
})
