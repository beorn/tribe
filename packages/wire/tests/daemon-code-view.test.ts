/**
 * @failure  an adapter or a supervisor reads the daemon's code identity while
 *           dropping `root` or guessing it, so the (root, cert) identity gate
 *           can never agree and a landing keeps executing a projection that
 *           moved under it
 *           (27531; /hh/hub/rulings/27531-adapter-root-design-note-ruling-2026-10-05.md).
 * @level    l1 - one real Unix-socket daemon on a temp path; no process spawned
 * @consumer @i/4-supervision/27459-coordination-overhead-has-no-budget/27531-adapters-run-from-the-daemon-landing-root-learned-from-the-daemon-never-shared-main
 * @testonly none
 */
import { mkdtempSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createLineParser } from "../src/parser.ts"
import { isRequest, makeResponse } from "../src/rpc.ts"
import {
  DAEMON_CODE_VIEW_CALL_TIMEOUT_MS,
  parseDaemonCodeView,
  readDaemonCodeView,
} from "../src/lib/code-identity.ts"

const servers: Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

/** A fake daemon whose cli_status answer the test chooses; null means "never answer". */
function spawnFakeDaemon(
  status: unknown | null,
): Promise<{ socketPath: string; connections: Socket[]; closed: Socket[] }> {
  const dir = mkdtempSync(join(tmpdir(), "daemon-code-view-"))
  const socketPath = join(dir, "tribe.sock")
  const connections: Socket[] = []
  const closed: Socket[] = []
  const server = createServer((socket) => {
    connections.push(socket)
    socket.on("close", () => closed.push(socket))
    const parse = createLineParser((msg) => {
      if (!isRequest(msg)) return
      if (msg.method === "cli_status" && status !== null) socket.write(makeResponse(msg.id, status))
    })
    socket.on("data", parse)
    socket.on("error", () => {
      /* a closed probe is the test's own teardown */
    })
  })
  servers.push(server)
  return new Promise((resolve) => {
    server.listen(socketPath, () => resolve({ socketPath, connections, closed }))
  })
}

const fullStatus = {
  sessions: [{ name: "@dev/luna6" }],
  daemon: { code_identity: { cert: "cert-1", root: "/hh/dev-landings/aaaa" } },
}

describe("parseDaemonCodeView", () => {
  it("reads the landing root and the cert a daemon publishes", () => {
    expect(parseDaemonCodeView(fullStatus)).toEqual({ root: "/hh/dev-landings/aaaa", cert: "cert-1" })
  })

  it("an older daemon that publishes no code identity is two named nulls, never a guess", () => {
    expect(parseDaemonCodeView({ sessions: [] })).toEqual({ root: null, cert: null })
    expect(parseDaemonCodeView({ daemon: {} })).toEqual({ root: null, cert: null })
  })

  it("keeps the half a daemon does publish and nulls the other", () => {
    expect(parseDaemonCodeView({ daemon: { code_identity: { cert: "cert-1" } } })).toEqual({
      root: null,
      cert: "cert-1",
    })
  })

  it("a present but non-string field is a broken daemon and is named, not swallowed", () => {
    expect(() => parseDaemonCodeView({ daemon: { code_identity: { root: 42, cert: "cert-1" } } })).toThrow(
      /daemon\.code_identity\.root/,
    )
    expect(() => parseDaemonCodeView({ daemon: { code_identity: { root: "/r", cert: "" } } })).toThrow(
      /daemon\.code_identity\.cert/,
    )
    expect(() => parseDaemonCodeView("not a status")).toThrow(/daemon\.code_identity/)
  })
})

describe("readDaemonCodeView", () => {
  it("one cli_status call over one connection, and it is closed, not leaked", async () => {
    const { socketPath, connections, closed } = await spawnFakeDaemon(fullStatus)
    await expect(readDaemonCodeView(socketPath)).resolves.toEqual({
      root: "/hh/dev-landings/aaaa",
      cert: "cert-1",
    })
    expect(connections).toHaveLength(1)
    await vi.waitFor(() => expect(closed).toHaveLength(1))
  })

  it("the read is bounded by the caller's deadline, never hung", async () => {
    const { socketPath } = await spawnFakeDaemon(null)
    await expect(readDaemonCodeView(socketPath, { callTimeoutMs: 50 })).rejects.toThrow()
    expect(DAEMON_CODE_VIEW_CALL_TIMEOUT_MS).toBe(1_000)
  })

  it("an absent daemon socket is a loud failure that names the path", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "daemon-code-view-missing-")), "tribe.sock")
    await expect(readDaemonCodeView(missing)).rejects.toThrow()
  })
})
