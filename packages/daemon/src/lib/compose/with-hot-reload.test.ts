/**
 * Safe-reload admission gate — daemon compose cores (@ag/tribe/20703).
 *
 * User doctrine 2026-07-13: hot-reload STAYS, but a reload must never replace a
 * working daemon with a broken one, and must be observable. These tests pin the
 * two pure cores the `withHotReload` factory wires:
 *
 *   - `admitAndReload` — runs the admission precheck; on failure it refuses the
 *     re-exec (keeps serving), logs loud, and emits `daemon:reload-refused`
 *     with the literal error. On success it commits the re-exec exactly once.
 *   - `runPostReloadVerify` — the new generation health-checks itself once
 *     ready and emits `daemon:reload-ok` (green) or `daemon:reload-degraded`
 *     (red, LOUD, with the degraded facts), stamped old→new SHA.
 *
 * Both take injected deps so they run without a real daemon / socket / DB.
 */

import { afterEach, describe, expect, it } from "vitest"

import type { AdmissionResult } from "tribe-wire/lib/hot-reload"
import { createBaseTribe, type BaseTribe } from "./base.ts"
import type { WithSocketServer } from "./with-socket-server.ts"
import {
  admitAndReload,
  runPostReloadVerify,
  withHotReload,
  RELOAD_REFUSED,
  RELOAD_OK,
  RELOAD_DEGRADED,
} from "./with-hot-reload.ts"

function admission(overrides: Partial<AdmissionResult>): AdmissionResult {
  return { ok: false, code: 1, signal: null, timedOut: false, stderr: "", ...overrides }
}

describe("admitAndReload", () => {
  it("refuses the re-exec when the precheck fails — keeps serving, emits reload-refused with the literal error", async () => {
    const events: Array<[string, string]> = []
    let committed = 0
    const res = await admitAndReload({
      runPrecheck: async () => admission({ ok: false, code: 1, stderr: "SyntaxError: Unexpected token '='" }),
      commitReExec: () => committed++,
      emit: (type, content) => events.push([type, content]),
    })
    expect(res.admitted).toBe(false)
    expect(committed).toBe(0) // THE INVARIANT: broken source never replaces a working daemon
    expect(events).toHaveLength(1)
    expect(events[0]![0]).toBe(RELOAD_REFUSED)
    expect(events[0]![1]).toContain("SyntaxError: Unexpected token '='")
  })

  it("refuses on precheck timeout without re-execing", async () => {
    let committed = 0
    const events: Array<[string, string]> = []
    const res = await admitAndReload({
      runPrecheck: async () => admission({ ok: false, code: null, timedOut: true }),
      commitReExec: () => committed++,
      emit: (type, content) => events.push([type, content]),
    })
    expect(res.admitted).toBe(false)
    expect(committed).toBe(0)
    expect(events[0]![0]).toBe(RELOAD_REFUSED)
    expect(events[0]![1]).toMatch(/timed out|timeout/i)
  })

  it("commits the re-exec exactly once when the precheck passes", async () => {
    let committed = 0
    const events: Array<[string, string]> = []
    const res = await admitAndReload({
      runPrecheck: async () => admission({ ok: true, code: 0 }),
      commitReExec: () => committed++,
      emit: (type, content) => events.push([type, content]),
    })
    expect(res.admitted).toBe(true)
    expect(committed).toBe(1)
    // No refusal event on the happy path.
    expect(events.find((e) => e[0] === RELOAD_REFUSED)).toBeUndefined()
  })
})

describe("runPostReloadVerify", () => {
  it("emits reload-ok with old→new SHA when the new generation is healthy", async () => {
    const events: Array<[string, string]> = []
    const res = await runPostReloadVerify({
      probeHealth: async () => ({ degraded: [] }),
      fromSha: "aaaaaaaaaaaa1111",
      toSha: "bbbbbbbbbbbb2222",
      emit: (type, content) => events.push([type, content]),
    })
    expect(res.ok).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0]![0]).toBe(RELOAD_OK)
    expect(events[0]![1]).toContain("aaaaaaaaaaaa")
    expect(events[0]![1]).toContain("bbbbbbbbbbbb")
  })

  it("emits reload-degraded LOUD with the degraded facts when the new generation is unhealthy", async () => {
    const events: Array<[string, string]> = []
    const warned: string[] = []
    const res = await runPostReloadVerify({
      probeHealth: async () => ({ degraded: ["wal_bytes", "tool_latency.fetch.p95_ms"] }),
      fromSha: "aaaa",
      toSha: "bbbb",
      emit: (type, content) => events.push([type, content]),
      log: { warn: (m) => warned.push(m) },
    })
    expect(res.ok).toBe(false)
    expect(res.degraded).toEqual(["wal_bytes", "tool_latency.fetch.p95_ms"])
    expect(events[0]![0]).toBe(RELOAD_DEGRADED)
    expect(events[0]![1]).toContain("wal_bytes")
    expect(events[0]![1]).toContain("tool_latency.fetch.p95_ms")
    expect(warned.length).toBeGreaterThan(0) // loud
  })

  it("surfaces a health-probe failure LOUD (never silent) as degraded", async () => {
    const events: Array<[string, string]> = []
    const warned: string[] = []
    const res = await runPostReloadVerify({
      probeHealth: async () => {
        throw new Error("health rpc exploded")
      },
      fromSha: null,
      toSha: null,
      emit: (type, content) => events.push([type, content]),
      log: { warn: (m) => warned.push(m) },
    })
    expect(res.ok).toBe(false)
    expect(events[0]![0]).toBe(RELOAD_DEGRADED)
    expect(events[0]![1]).toContain("health rpc exploded")
    expect(warned.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Factory-level wiring — a minimal fake socket shape (no real daemon / socket
// / DB), watcher disabled. These pin that the factory routes reload() through
// the admission gate and the boot-time verify through the env markers.
// ---------------------------------------------------------------------------

type FakeShape = BaseTribe & WithSocketServer

function makeFakeShape(binding: "listening" | "occupied" = "listening"): {
  shape: FakeShape
  closes: () => number
} {
  let closes = 0
  const base = createBaseTribe()
  const socket = {
    server: {
      close: () => {
        closes++
      },
    } as unknown as FakeShape["socket"]["server"],
    socketPath: "/nonexistent/safe-reload-gate-test.sock",
    binding: Promise.resolve(binding),
    inheritedFd: false,
    startedAt: Date.now(),
    handedOff: false,
  }
  return { shape: { ...base, socket }, closes: () => closes }
}

function makeFactoryOpts(overrides?: Partial<Parameters<typeof withHotReload>[0]>): {
  opts: Parameters<typeof withHotReload>[0]
  events: Array<[string, string]>
  counters: { stopPlugins: number; shutdown: number; prechecks: number }
} {
  const events: Array<[string, string]> = []
  const counters = { stopPlugins: 0, shutdown: 0, prechecks: 0 }
  const opts: Parameters<typeof withHotReload>[0] = {
    stopPlugins: () => counters.stopPlugins++,
    triggerShutdown: () => counters.shutdown++,
    emitEvent: (type, content) => events.push([type, content]),
    probeHealth: async () => ({ degraded: [] }),
    disableWatch: true,
    disableVerify: true,
    ...overrides,
  }
  return { opts, events, counters }
}

async function settle(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe("withHotReload factory — admission gate wiring", () => {
  afterEach(() => {
    delete process.env.__TRIBE_RELOAD_VERIFY
    delete process.env.__TRIBE_RELOAD_FROM_SHA
  })

  it("a refused precheck leaves the daemon serving: no socket close, no handoff, no plugin stop", async () => {
    const { shape, closes } = makeFakeShape()
    const { opts, events, counters } = makeFactoryOpts({
      precheckRunner: async () => {
        counters.prechecks++
        return { ok: false, code: 1, signal: null, timedOut: false, stderr: "Cannot resolve module './gone.ts'" }
      },
    })
    const withReload = withHotReload<FakeShape>(opts)(shape)

    withReload.hotReload.reload()
    await settle()

    expect(counters.prechecks).toBe(1)
    expect(shape.socket.handedOff).toBe(false) // socket never handed off
    expect(closes()).toBe(0) // server.close never called
    expect(counters.stopPlugins).toBe(0) // plugins keep running on refusal
    expect(counters.shutdown).toBe(0)
    expect(events.map(([t]) => t)).toEqual([RELOAD_REFUSED])
    expect(events[0]![1]).toContain("Cannot resolve module './gone.ts'")
  })

  it("triggers during a pending precheck coalesce into the in-flight reload", async () => {
    const { shape } = makeFakeShape()
    const { opts, counters } = makeFactoryOpts({
      precheckRunner: async () => {
        counters.prechecks++
        await settle(40)
        return { ok: false, code: 1, signal: null, timedOut: false, stderr: "still broken" }
      },
    })
    const withReload = withHotReload<FakeShape>(opts)(shape)

    withReload.hotReload.reload()
    withReload.hotReload.reload() // explicit trigger while watch trigger pending
    withReload.hotReload.reload()
    await settle(80)

    expect(counters.prechecks).toBe(1) // ONE admission run, not three

    // After the in-flight reload resolves, a new trigger runs a fresh precheck.
    withReload.hotReload.reload()
    await settle(80)
    expect(counters.prechecks).toBe(2)
  })

  it("boot-time verify: env markers trigger ONE health probe and a reload-ok emit, and the markers are cleared", async () => {
    process.env.__TRIBE_RELOAD_VERIFY = "1"
    process.env.__TRIBE_RELOAD_FROM_SHA = "cafebabecafe0000"
    const { shape } = makeFakeShape("listening")
    let probes = 0
    const { opts, events } = makeFactoryOpts({
      disableVerify: false,
      probeHealth: async () => {
        probes++
        return { degraded: [] }
      },
    })
    withHotReload<FakeShape>(opts)(shape)
    await settle()

    expect(process.env.__TRIBE_RELOAD_VERIFY).toBeUndefined() // marker consumed
    expect(process.env.__TRIBE_RELOAD_FROM_SHA).toBeUndefined()
    expect(probes).toBe(1)
    expect(events.map(([t]) => t)).toEqual([RELOAD_OK])
    expect(events[0]![1]).toContain("cafebabecafe") // old-generation SHA stamped
  })

  it("boot-time verify: a lost bind election never probes (no generation to verify)", async () => {
    process.env.__TRIBE_RELOAD_VERIFY = "1"
    const { shape } = makeFakeShape("occupied")
    let probes = 0
    const { opts, events } = makeFactoryOpts({
      disableVerify: false,
      probeHealth: async () => {
        probes++
        return { degraded: [] }
      },
    })
    withHotReload<FakeShape>(opts)(shape)
    await settle()

    expect(probes).toBe(0)
    expect(events).toHaveLength(0)
  })

  it("no verify without the env marker (a normal boot emits nothing)", async () => {
    const { shape } = makeFakeShape("listening")
    let probes = 0
    const { opts, events } = makeFactoryOpts({
      disableVerify: false,
      probeHealth: async () => {
        probes++
        return { degraded: [] }
      },
    })
    withHotReload<FakeShape>(opts)(shape)
    await settle()

    expect(probes).toBe(0)
    expect(events).toHaveLength(0)
  })
})
