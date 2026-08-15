/**
 * A periodic async poller scheduled with `setInterval(() => void poll(), ms)`
 * starts a new run every tick whether or not the previous run finished. When
 * one run outlasts the interval — the health sampler spawns `iostat -d -c 2`
 * (>=2s by construction), `lsof -n | wc -l`, a full `ps -axo` dump and a
 * network `gh api rate_limit`, each slurped unbounded into memory — the runs
 * overlap, and every further tick adds another concurrent run for as long as
 * the slowness lasts. Nothing removes them, so in-flight work grows with
 * uptime rather than settling: the measured daemon wedge (sustained ~50% CPU,
 * 40 threads, every RPC past the client's 10s deadline, cured instantly by a
 * restart because the pile is purely in-process).
 *
 * The invariant this pins: a periodic runner never runs concurrently with
 * itself, and the ticks it drops are counted and reported rather than
 * silently discarded.
 */
import { describe, expect, it } from "vitest"

import { createSingleFlightRunner } from "./single-flight-ticker.ts"

/** A run whose completion the test controls, so overlap is deterministic. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe("single-flight runner — a periodic poller never overlaps itself", () => {
  it("holds concurrency at one while ticks keep arriving during a slow run", async () => {
    const gates = [deferred(), deferred()]
    let started = 0
    let concurrent = 0
    let maxConcurrent = 0

    const runner = createSingleFlightRunner({
      name: "health-sample",
      intervalMs: 10_000,
      run: async () => {
        const gate = gates[started]
        started++
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await gate?.promise
        concurrent--
      },
    })

    // One slow run, then 99 further ticks arrive while it is still in flight —
    // 100 ticks is ~17 minutes of a 10s poll, well short of the 4h wedge.
    runner.tick()
    for (let i = 0; i < 99; i++) runner.tick()

    expect(maxConcurrent).toBe(1)
    expect(started).toBe(1)
    expect(runner.stats().inFlight).toBe(true)
    expect(runner.stats().skipped).toBe(99)

    gates[0]?.resolve()
    await runner.settled()

    expect(concurrent).toBe(0)
    expect(runner.stats().inFlight).toBe(false)
    expect(runner.stats().completed).toBe(1)
  })

  it("resumes on the next tick once the slow run drains", async () => {
    const gates = [deferred(), deferred()]
    let started = 0

    const runner = createSingleFlightRunner({
      name: "health-sample",
      intervalMs: 10_000,
      run: async () => {
        const gate = gates[started]
        started++
        await gate?.promise
      },
    })

    runner.tick()
    runner.tick() // skipped — first still in flight
    gates[0]?.resolve()
    await runner.settled()

    runner.tick() // idle again, so this one runs
    expect(started).toBe(2)
    expect(runner.stats().skipped).toBe(1)

    gates[1]?.resolve()
    await runner.settled()
    expect(runner.stats().completed).toBe(2)
  })

  it("counts and reports every dropped tick instead of shedding it silently", async () => {
    const warnings: string[] = []
    const gate = deferred()

    const runner = createSingleFlightRunner({
      name: "health-sample",
      intervalMs: 10_000,
      run: () => gate.promise,
      log: { warn: (message) => warnings.push(message) },
    })

    runner.tick()
    for (let i = 0; i < 5; i++) runner.tick()

    // NO SILENT ERRORS: shed load is reported, and the report carries the
    // count, the runner's name and how long the blocking run has been going,
    // so the next wedge names itself instead of needing a stack walk.
    expect(warnings.length).toBeGreaterThan(0)
    const report = warnings.join("\n")
    expect(report).toContain("health-sample")
    expect(report).toMatch(/skip/i)
    expect(warnings.at(-1)).toContain("5")

    gate.resolve()
    await runner.settled()
    expect(runner.stats().skipped).toBe(5)
  })

  it("a throwing run releases the slot instead of wedging the poller forever", async () => {
    const errors: string[] = []
    let started = 0

    const runner = createSingleFlightRunner({
      name: "health-sample",
      intervalMs: 10_000,
      run: async () => {
        started++
        throw new Error("sysmon snapshot unavailable")
      },
      log: { error: (message) => errors.push(message) },
    })

    runner.tick()
    await runner.settled()
    runner.tick()
    await runner.settled()

    // A failed run must not leave the in-flight flag set: that would convert a
    // transient child-process failure into a permanently dead sampler, which
    // is the silent-failure mirror image of the pile-up.
    expect(started).toBe(2)
    expect(runner.stats().failed).toBe(2)
    expect(runner.stats().inFlight).toBe(false)
    expect(errors.join("\n")).toContain("sysmon snapshot unavailable")
  })

  it("releases the slot when run() throws SYNCHRONOUSLY, not just via a rejected promise", async () => {
    // An `async` run that throws yields a REJECTED PROMISE — the body has
    // already suspended, so the slot assignment has long since happened. A
    // function that throws synchronously is a different path: it runs to
    // completion inside the caller's own frame, before the assignment. The
    // slot must already be claimed by then, or the assignment lands after the
    // release and wedges the runner forever.
    const errors: string[] = []
    let started = 0
    const runner = createSingleFlightRunner({
      name: "health-sample",
      intervalMs: 10_000,
      // Deliberately NOT async: this returns nothing and throws in-frame.
      run: (() => {
        started++
        throw new Error("spawn failed in-frame")
      }) as unknown as () => Promise<void>,
      log: { error: (message) => errors.push(message) },
    })

    runner.tick()
    expect(runner.stats().inFlight).toBe(false)
    expect(runner.stats().failed).toBe(1)

    // The slot must be usable again immediately — this is the assertion that
    // fails fast when the ordering regresses, before any hang can occur.
    runner.tick()
    expect(started).toBe(2)
    expect(runner.stats().failed).toBe(2)
    expect(runner.stats().skipped).toBe(0)
    expect(errors.join("\n")).toContain("spawn failed in-frame")
  })

  it("settled() resolves after a synchronous throw instead of spinning on a resolved promise", async () => {
    const runner = createSingleFlightRunner({
      name: "health-sample",
      intervalMs: 10_000,
      run: (() => {
        throw new Error("spawn failed in-frame")
      }) as unknown as () => Promise<void>,
      log: {},
    })

    runner.tick()
    // On the wedged ordering this never returns: `while (inFlight !== null)
    // await inFlight` re-queues a microtask forever, starving even timers, so
    // a racing deadline could not rescue it. Resolution IS the assertion.
    await runner.settled()
    expect(runner.stats().inFlight).toBe(false)
  })

  it("reports the overrun so a run outlasting its interval names itself", async () => {
    const warnings: string[] = []
    const gate = deferred()
    let clock = 0

    const runner = createSingleFlightRunner({
      name: "health-sample",
      intervalMs: 10_000,
      run: () => gate.promise,
      now: () => clock,
      log: { warn: (message) => warnings.push(message) },
    })

    runner.tick()
    clock = 45_000
    gate.resolve()
    await runner.settled()

    const overrun = warnings.find((message) => /overran|overrun/i.test(message))
    expect(overrun).toBeDefined()
    expect(overrun).toContain("health-sample")
    expect(overrun).toContain("45000")
    expect(runner.stats().maxObservedRunMs).toBe(45_000)
  })
})
