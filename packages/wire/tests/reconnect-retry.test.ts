// 20703 — safe-reload client resilience: retry-on-reconnect for SAFE calls.
//
// Doctrine: a daemon restart/reload must cost callers latency only — zero
// surfaced errors, zero duplicated sends, zero lost reads. The base branch
// already threads a per-call `{ timeoutMs }` and exempts long-poll expiries
// from the 3-strike destroy. This suite covers the missing half: when the
// daemon-side socket dies mid-call, `createReconnectingClient` must
//
//   (a) transparently re-issue a WHITELISTED SNAPSHOT call after reconnect,
//       bounded by the call's deadline — the caller sees only latency; and
//   (b) NEVER blind-retry a cursor-advancing default-drain fetch (the server
//       advances the cursor + acks the mailbox even when the response is lost
//       — a silent retry would skip rows: the NO-SILENT-ERRORS / message-loss
//       class); and
//   (c) retry a send ONLY when it carries a client-minted `idempotencyKey`, so
//       the daemon dedups by key and exactly one row lands; and
//   (d) NEVER retry identity calls (register/join/rename).
//
// The disconnect is driven the way the recurrence hits in the field: the fake
// daemon accepts the request, withholds the response, and KILLS THE SOCKET
// mid-call. Millisecond-scale: the reconnect backoff floor (500ms) dominates.

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type Server, type Socket } from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createReconnectingClient, isRetriableTribeCall } from "../src/client.ts"
import { createLineParser } from "../src/parser.ts"
import { isRequest, makeResponse } from "../src/rpc.ts"

/**
 * Fake daemon that KILLS the first request of a chosen method mid-call (accept,
 * withhold response, destroy the server-side socket after a tick) and answers
 * every later request of that method normally. Records what it saw so the test
 * can prove single-vs-double delivery and cursor discipline.
 */
type FakeDaemon = {
  server: Server
  /** Every request line the daemon received, in order. */
  seen: Array<{ method: string; params: Record<string, unknown> | undefined }>
  /** Message rows the daemon "committed" (send dedup by idempotencyKey). */
  deliveries: Array<{ id: string; key: string | undefined }>
}

function spawnKillOnceDaemon(socketPath: string, killMethod: string): Promise<FakeDaemon> {
  const seen: FakeDaemon["seen"] = []
  const deliveries: FakeDaemon["deliveries"] = []
  const killedOnce = { done: false }
  let nextId = 1
  return new Promise((resolveServer) => {
    const server = createServer((socket: Socket) => {
      const safeWrite = (line: string) => {
        if (socket.writable) socket.write(line)
      }
      const parse = createLineParser((msg) => {
        if (!isRequest(msg)) return
        const params = msg.params as Record<string, unknown> | undefined
        seen.push({ method: msg.method, params })

        // Kill the socket mid-call on the FIRST request of the chosen method.
        if (msg.method === killMethod && !killedOnce.done) {
          killedOnce.done = true
          const t = setTimeout(() => socket.destroy(), 15)
          ;(t as { unref?: () => void }).unref?.()
          return // withhold the response
        }

        if (msg.method === "tribe.send") {
          // Idempotent commit keyed by client-minted idempotencyKey.
          const key = typeof params?.idempotencyKey === "string" ? params.idempotencyKey : undefined
          const existing = key !== undefined ? deliveries.find((d) => d.key === key) : undefined
          if (existing) {
            safeWrite(makeResponse(msg.id, { sent: true, id: existing.id }))
            return
          }
          const id = `m${nextId++}`
          deliveries.push({ id, key })
          safeWrite(makeResponse(msg.id, { sent: true, id }))
          return
        }

        if (msg.method === "tribe.members") {
          safeWrite(makeResponse(msg.id, { members: ["@a", "@b"] }))
          return
        }

        if (msg.method === "tribe.fetch") {
          safeWrite(makeResponse(msg.id, { events: [], cursor: 0 }))
          return
        }

        if (msg.method === "tribe.join") {
          safeWrite(makeResponse(msg.id, { name: "@me", role: "member" }))
          return
        }

        safeWrite(makeResponse(msg.id, null))
      })
      socket.on("data", parse)
      socket.on("error", () => {
        /* ignore */
      })
    })
    server.listen(socketPath, () => resolveServer({ server, seen, deliveries }))
  })
}

describe("isRetriableTribeCall (snapshot-safe whitelist)", () => {
  it("treats pure-read methods as retriable", () => {
    for (const m of ["tribe.members", "tribe.health", "tribe.pending", "tribe.lifecycle", "tribe.debug"]) {
      expect(isRetriableTribeCall(m, undefined)).toBe(true)
    }
  })

  it("treats snapshot-mode fetch (ids/with/from/to) as retriable", () => {
    expect(isRetriableTribeCall("tribe.fetch", { ids: ["x"] })).toBe(true)
    expect(isRetriableTribeCall("tribe.fetch", { with: "@peer" })).toBe(true)
    expect(isRetriableTribeCall("tribe.fetch", { from: "@peer" })).toBe(true)
    expect(isRetriableTribeCall("tribe.fetch", { to: "@peer" })).toBe(true)
  })

  it("treats default-drain fetch and advancing fetch as NON-retriable", () => {
    expect(isRetriableTribeCall("tribe.fetch", undefined)).toBe(false)
    expect(isRetriableTribeCall("tribe.fetch", {})).toBe(false)
    expect(isRetriableTribeCall("tribe.fetch", { limit: 50 })).toBe(false)
    // advance:true and since-driven advance advance the cursor server-side.
    expect(isRetriableTribeCall("tribe.fetch", { with: "@peer", advance: true })).toBe(false)
    expect(isRetriableTribeCall("tribe.fetch", { since: 10 })).toBe(false)
  })

  it("treats send as retriable ONLY with an idempotencyKey", () => {
    expect(isRetriableTribeCall("tribe.send", { to: "@x", message: "hi" })).toBe(false)
    expect(isRetriableTribeCall("tribe.send", { to: "@x", message: "hi", idempotencyKey: "" })).toBe(false)
    expect(isRetriableTribeCall("tribe.send", { to: "@x", message: "hi", idempotencyKey: "k1" })).toBe(true)
  })

  it("never retries identity / mutation methods", () => {
    for (const m of [
      "tribe.join",
      "tribe.rename",
      "tribe.reload",
      "tribe.repair",
      "tribe.filter",
      "tribe.inbox.wait",
    ]) {
      expect(isRetriableTribeCall(m, {})).toBe(false)
    }
  })
})

describe("createReconnectingClient safe-call retry across a mid-call socket kill (20703)", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-reconnect-retry-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("(a) transparently succeeds a whitelisted snapshot call after the daemon kills the socket mid-call", async () => {
    const sock = join(tmpDir, "d.sock")
    const daemon = await spawnKillOnceDaemon(sock, "tribe.members")
    const client = await createReconnectingClient({ socketPath: sock, maxAttempts: 5, maxStartupAttempts: 1 })
    try {
      // The first tribe.members is killed mid-call; the client must reconnect
      // and re-issue transparently, within the (default) call deadline.
      const result = await client.call("tribe.members", {})
      expect(result).toEqual({ members: ["@a", "@b"] })
      // Proof it actually round-tripped twice (killed once, answered once).
      const memberCalls = daemon.seen.filter((s) => s.method === "tribe.members")
      expect(memberCalls.length).toBe(2)
    } finally {
      client.close()
      await new Promise<void>((r) => daemon.server.close(() => r()))
    }
  }, 15_000)

  it("(b) does NOT retry a default-drain fetch — it fails loud (cursor advanced server-side)", async () => {
    const sock = join(tmpDir, "d.sock")
    const daemon = await spawnKillOnceDaemon(sock, "tribe.fetch")
    const client = await createReconnectingClient({ socketPath: sock, maxAttempts: 5, maxStartupAttempts: 1 })
    try {
      // Default drain (no ids/with/from/to) → cursor-advancing → must reject,
      // never silently re-issued.
      await expect(client.call("tribe.fetch", {})).rejects.toThrow(/Connection closed/)
      // The daemon saw exactly ONE drain — no silent retry.
      const fetchCalls = daemon.seen.filter((s) => s.method === "tribe.fetch")
      expect(fetchCalls.length).toBe(1)
    } finally {
      client.close()
      await new Promise<void>((r) => daemon.server.close(() => r()))
    }
  }, 15_000)

  it("(c) retries an idempotency-keyed send after a mid-call kill and lands EXACTLY ONE message row", async () => {
    const sock = join(tmpDir, "d.sock")
    const daemon = await spawnKillOnceDaemon(sock, "tribe.send")
    const client = await createReconnectingClient({ socketPath: sock, maxAttempts: 5, maxStartupAttempts: 1 })
    try {
      const result = (await client.call("tribe.send", {
        to: "@x",
        message: "hello",
        idempotencyKey: "key-abc",
      })) as { sent: boolean; id: string }
      expect(result.sent).toBe(true)
      // The daemon received the send twice (killed once, retried once) but
      // deduped by idempotencyKey → exactly one committed row, same id.
      const sendCalls = daemon.seen.filter((s) => s.method === "tribe.send")
      expect(sendCalls.length).toBe(2)
      expect(daemon.deliveries.length).toBe(1)
      expect(result.id).toBe(daemon.deliveries[0]!.id)
    } finally {
      client.close()
      await new Promise<void>((r) => daemon.server.close(() => r()))
    }
  }, 15_000)

  it("(d) does NOT retry a register/join call — it fails loud", async () => {
    const sock = join(tmpDir, "d.sock")
    const daemon = await spawnKillOnceDaemon(sock, "tribe.join")
    const client = await createReconnectingClient({ socketPath: sock, maxAttempts: 5, maxStartupAttempts: 1 })
    try {
      await expect(client.call("tribe.join", { name: "@me" })).rejects.toThrow(/Connection closed/)
      const joinCalls = daemon.seen.filter((s) => s.method === "tribe.join")
      expect(joinCalls.length).toBe(1)
    } finally {
      client.close()
      await new Promise<void>((r) => daemon.server.close(() => r()))
    }
  }, 15_000)

  it("(e) an un-keyed send is NOT retried (double-delivery guard) — it fails loud", async () => {
    const sock = join(tmpDir, "d.sock")
    const daemon = await spawnKillOnceDaemon(sock, "tribe.send")
    const client = await createReconnectingClient({ socketPath: sock, maxAttempts: 5, maxStartupAttempts: 1 })
    try {
      await expect(client.call("tribe.send", { to: "@x", message: "no-key" })).rejects.toThrow(/Connection closed/)
      const sendCalls = daemon.seen.filter((s) => s.method === "tribe.send")
      expect(sendCalls.length).toBe(1)
    } finally {
      client.close()
      await new Promise<void>((r) => daemon.server.close(() => r()))
    }
  }, 15_000)
})
