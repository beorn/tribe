/**
 * @failure The idle-quit census reads connected sockets only, so a fully-populated
 *          pull-delivery fleet reads as "no clients" and the daemon stops the
 *          coordination rail under it.
 * @level   l1
 * @consumer withIdleQuit — the only self-stop decision in the daemon
 *
 * Written 2026-08-12 after exactly that outage: the daemon's log said "no clients"
 * while 13 pull-delivery sessions were registered. Pull seats connect per poll, so
 * between polls the socket count is legally zero; the registered-session rows are
 * the fleet. Registered live sessions of ANY delivery mode count as clients for
 * the idle-quit decision — and ONLY for that decision: the socket-path-gone
 * backstop stays socket-only, because a daemon whose socket path is gone cannot
 * serve those registered sessions' next poll anyway (squatting is the bug there).
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { createScope } from "tribe-wire"
import { createBaseTribe } from "./base.ts"
import { withClientRegistry, type ClientSession } from "./with-client-registry.ts"
import { withIdleQuit, type IdleQuitOpts } from "./with-idle-quit.ts"
import type { TribeConfig } from "./with-config.ts"

const THIRTY_MIN_MS = 1800 * 1000

function makeConfig(overrides: Partial<TribeConfig> = {}): TribeConfig {
  return {
    socketPath: "/nonexistent/idle-quit-test/tribe.sock",
    dbPath: ":memory:",
    recallDbPath: ":memory:",
    idleQuitAfterSec: 1800,
    idleQuitSource: "default",
    inheritFd: null,
    focusPollMs: 60_000,
    summaryPollMs: 120_000,
    summarizerMode: "off",
    recallEnabled: false,
    ...overrides,
  }
}

type Harness = {
  shutdown: ReturnType<typeof vi.fn>
  getDeadline: () => number | null
  markActive: () => void
  markIdle: () => void
  clients: Map<string, ClientSession>
  setDurable: (n: number) => void
  advance: (ms: number) => void
  /** Let the real (short-interval) tick run a few times. */
  settle: () => Promise<void>
}

const scopes: Array<{ [Symbol.asyncDispose](): Promise<void> }> = []

async function makeHarness(
  config: Partial<TribeConfig> = {},
  opts: Partial<IdleQuitOpts> & { durable?: number } = {},
): Promise<Harness> {
  const scope = createScope("idle-quit-test")
  scopes.push(scope)
  let fakeNow = 1_000_000_000
  let durable = opts.durable ?? 0
  const shutdown = vi.fn()
  const base = { ...createBaseTribe({ scope }), config: makeConfig(config) }
  const withRegistry = withClientRegistry<typeof base>()(base)
  const shape = withIdleQuit<typeof withRegistry>({
    triggerShutdown: shutdown,
    countDurableSessions: () => durable,
    tickIntervalMs: 1,
    socketPathExists: opts.socketPathExists ?? (() => true),
    socketPathGoneTimeoutMs: opts.socketPathGoneTimeoutMs ?? 30_000,
    now: () => fakeNow,
  })(withRegistry)
  return {
    shutdown,
    getDeadline: () => shape.idleQuit.getDeadline(),
    markActive: () => shape.idleQuit.markActive(),
    markIdle: () => shape.idleQuit.markIdle(),
    clients: shape.registry.clients,
    setDurable: (n) => {
      durable = n
    },
    advance: (ms) => {
      fakeNow += ms
    },
    settle: () => new Promise((resolve) => setTimeout(resolve, 25)),
  }
}

function fakeMemberClient(): ClientSession {
  return { role: "member", registeredAt: Date.now() } as unknown as ClientSession
}

afterEach(async () => {
  for (const scope of scopes.splice(0)) await scope[Symbol.asyncDispose]()
})

describe("withIdleQuit client census", () => {
  it("pins the 2026-08-12 outage: 13 registered pull sessions, zero sockets — no idle-quit, ever", async () => {
    const h = await makeHarness({}, { durable: 13 })
    expect(h.getDeadline()).toBeNull()
    h.advance(10 * THIRTY_MIN_MS)
    await h.settle()
    expect(h.getDeadline()).toBeNull()
    expect(h.shutdown).not.toHaveBeenCalled()
  })

  it("still idle-quits a truly empty daemon (no sockets, no registered sessions)", async () => {
    const h = await makeHarness()
    expect(h.getDeadline()).not.toBeNull()
    h.advance(THIRTY_MIN_MS + 1000)
    await h.settle()
    expect(h.shutdown).toHaveBeenCalled()
  })

  it("aborts a running countdown when a session registers mid-count (no socket involved)", async () => {
    const h = await makeHarness()
    expect(h.getDeadline()).not.toBeNull()
    h.setDurable(5)
    await h.settle()
    expect(h.getDeadline()).toBeNull()
    h.advance(10 * THIRTY_MIN_MS)
    await h.settle()
    expect(h.shutdown).not.toHaveBeenCalled()
  })

  it("self-arms from the tick when the last registered session disappears without a socket edge", async () => {
    // Rows vanish via the stale-transport reaper / takeover sweeps, not via a
    // disconnect callback — the tick must start the countdown on its own.
    const h = await makeHarness({}, { durable: 3 })
    expect(h.getDeadline()).toBeNull()
    h.setDurable(0)
    await h.settle()
    expect(h.getDeadline()).not.toBeNull()
    h.advance(THIRTY_MIN_MS + 1000)
    await h.settle()
    expect(h.shutdown).toHaveBeenCalled()
  })

  it("a connected socket holds the daemon up exactly as before", async () => {
    const h = await makeHarness()
    h.clients.set("conn-1", fakeMemberClient())
    await h.settle()
    expect(h.getDeadline()).toBeNull()
    h.advance(10 * THIRTY_MIN_MS)
    await h.settle()
    expect(h.shutdown).not.toHaveBeenCalled()
  })

  it("markIdle defers (not arms) while registered sessions exist", async () => {
    const h = await makeHarness({}, { durable: 2 })
    h.markIdle() // the dispatcher's onIdle edge — registry of sockets just emptied
    expect(h.getDeadline()).toBeNull()
  })

  it("never arms with --idle-quit-after never (-1), census empty or not", async () => {
    const h = await makeHarness({ idleQuitAfterSec: -1, idleQuitSource: "flag" })
    h.markIdle()
    h.advance(100 * THIRTY_MIN_MS)
    await h.settle()
    expect(h.getDeadline()).toBeNull()
    expect(h.shutdown).not.toHaveBeenCalled()
  })

  it("0 quits as soon as the census is empty", async () => {
    const h = await makeHarness({ idleQuitAfterSec: 0, idleQuitSource: "flag" })
    await h.settle()
    expect(h.shutdown).toHaveBeenCalled()
  })

  it("socket-path-gone backstop ignores registered sessions — no squatting on a dead socket path", async () => {
    const h = await makeHarness({}, { durable: 13, socketPathExists: () => false })
    await h.settle() // a tick records the missing path and starts the backstop window
    h.advance(31_000)
    await h.settle()
    // The idle-quit deadline stayed off (13 registered sessions), but the
    // backstop still fired: an unreachable daemon must yield the socket.
    expect(h.getDeadline()).toBeNull()
    expect(h.shutdown).toHaveBeenCalled()
  })
})
