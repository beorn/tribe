/**
 * Tests for the `inbox-wait` long-poll core (`src/lib/inbox-wait.ts`).
 *
 * The wait loop is pure + injected: a fake `pollActionable` probe, a fake
 * `sleep`, and a fake `now()` clock make every case deterministic — no real
 * timers, no flaky wall-clock timing.
 *
 *   - immediate-message: actionable already pending → returns instantly, exit 0
 *   - delayed-message:   actionable arrives after N polls → returns when it
 *                        lands (not before), exit 0
 *   - timeout:           no actionable within the budget → exit 64
 *   - ambient-not-actionable: ambient/broadcast traffic (count stays 0) does
 *                        NOT wake the wait — it blocks until timeout
 *   - signal:            a termination signal ends the wait cleanly, exit 0
 *   - no-tight-retry:    the loop AWAITS sleep between probes — poll count over
 *                        a delayed-message window stays small/bounded (it does
 *                        not spin the probe thousands of times)
 *
 * Bead: @km/bearly/20352-inbox-wait
 */

import { describe, expect, test } from "vitest"
import {
  EXIT_ACTIONABLE,
  EXIT_SIGNAL,
  EXIT_TIMEOUT,
  runInboxWait,
  type ActionableSnapshot,
} from "../src/lib/inbox-wait.ts"
import { parseTimeoutMs } from "../src/cli/read.ts"

/**
 * A fake clock + fake sleep. `sleep(ms)` advances the clock by `ms` and
 * resolves on a microtask — no real time passes, so a 30s timeout test runs in
 * microseconds and the poll count is exact + deterministic.
 */
function fakeClock(startAt = 0): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = startAt
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms
      return Promise.resolve()
    },
  }
}

const NONE: ActionableSnapshot = { count: 0, oldestTs: 0 }
function some(count: number, oldestTs = 1_000): ActionableSnapshot {
  return { count, oldestTs }
}

describe("runInboxWait — long-poll core", () => {
  test("immediate-message: actionable already pending returns instantly with exit 0", async () => {
    const clock = fakeClock()
    const result = await runInboxWait({
      pollActionable: () => Promise.resolve(some(1)),
      timeoutMs: 30_000,
      sleep: clock.sleep,
      now: clock.now,
    })
    expect(result.reason).toBe("actionable")
    expect(result.exitCode).toBe(EXIT_ACTIONABLE)
    expect(result.snapshot).toEqual(some(1))
    // Returned on the FIRST probe — never slept.
    expect(result.polls).toBe(1)
    expect(clock.now()).toBe(0)
  })

  test("delayed-message: returns when the actionable event lands, not before", async () => {
    const clock = fakeClock()
    // Actionable on the 4th probe; ambient (count 0) before that.
    let probe = 0
    const result = await runInboxWait({
      pollActionable: () => {
        probe++
        return Promise.resolve(probe >= 4 ? some(2) : NONE)
      },
      timeoutMs: 30_000,
      pollIntervalMs: 1000,
      sleep: clock.sleep,
      now: clock.now,
    })
    expect(result.reason).toBe("actionable")
    expect(result.exitCode).toBe(EXIT_ACTIONABLE)
    expect(result.snapshot).toEqual(some(2))
    // 4 probes, 3 sleeps of 1000ms between them.
    expect(result.polls).toBe(4)
    expect(clock.now()).toBe(3000)
  })

  test("timeout: no actionable event within budget exits with the timeout code", async () => {
    const clock = fakeClock()
    const result = await runInboxWait({
      pollActionable: () => Promise.resolve(NONE),
      timeoutMs: 5000,
      pollIntervalMs: 1000,
      sleep: clock.sleep,
      now: clock.now,
    })
    expect(result.reason).toBe("timeout")
    expect(result.exitCode).toBe(EXIT_TIMEOUT)
    expect(EXIT_TIMEOUT).not.toBe(EXIT_ACTIONABLE)
    expect(result.snapshot).toBeNull()
    // Clock advanced to exactly the budget, no overshoot.
    expect(clock.now()).toBe(5000)
  })

  test("ambient-not-actionable: ambient traffic (count stays 0) does not wake the wait", async () => {
    const clock = fakeClock()
    // Probe always reports 0 actionable even though (notionally) ambient
    // broadcasts/daemon events keep landing — the predicate filters them out.
    let probes = 0
    const result = await runInboxWait({
      pollActionable: () => {
        probes++
        return Promise.resolve(NONE)
      },
      timeoutMs: 10_000,
      pollIntervalMs: 1000,
      sleep: clock.sleep,
      now: clock.now,
    })
    expect(result.reason).toBe("timeout")
    expect(result.exitCode).toBe(EXIT_TIMEOUT)
    // It kept waiting through every ambient poll until the deadline.
    expect(probes).toBeGreaterThan(1)
    expect(clock.now()).toBe(10_000)
  })

  test("signal: a termination signal ends the wait cleanly with exit 0", async () => {
    const clock = fakeClock()
    let resolveSignal!: () => void
    const signal = new Promise<void>((r) => {
      resolveSignal = r
    })
    // Fire the signal during the first sleep.
    const result = await runInboxWait({
      pollActionable: () => Promise.resolve(NONE),
      timeoutMs: 30_000,
      pollIntervalMs: 1000,
      sleep: (ms) => {
        resolveSignal()
        return clock.sleep(ms)
      },
      now: clock.now,
      signal,
    })
    expect(result.reason).toBe("signal")
    expect(result.exitCode).toBe(EXIT_SIGNAL)
    expect(result.snapshot).toBeNull()
  })

  test("no-tight-retry: poll count over a delayed-message window stays bounded (no busy-spin)", async () => {
    const clock = fakeClock()
    // Message lands after 28s of a 30s budget. With a 1s bounded poll the loop
    // probes ~29 times — NOT thousands. A tight `while(true)` re-query would
    // probe an unbounded number of times in the same window.
    const LANDS_AT_MS = 28_000
    const result = await runInboxWait({
      pollActionable: () => Promise.resolve(clock.now() >= LANDS_AT_MS ? some(1) : NONE),
      timeoutMs: 30_000,
      pollIntervalMs: 1000,
      sleep: clock.sleep,
      now: clock.now,
    })
    expect(result.reason).toBe("actionable")
    // Hard upper bound: one probe per poll-interval over the budget, plus the
    // initial probe. 30_000 / 1000 + 1 = 31. We comfortably stay under that.
    expect(result.polls).toBeLessThanOrEqual(31)
    // And it actually waited the real window, not zero-spun to the answer.
    expect(result.polls).toBeGreaterThanOrEqual(28)
  })

  test("does not overshoot the deadline when pollInterval exceeds remaining budget", async () => {
    const clock = fakeClock()
    const result = await runInboxWait({
      pollActionable: () => Promise.resolve(NONE),
      timeoutMs: 1500,
      pollIntervalMs: 1000, // first sleep 1000, second sleep clamped to 500
      sleep: clock.sleep,
      now: clock.now,
    })
    expect(result.reason).toBe("timeout")
    expect(clock.now()).toBe(1500)
  })
})

describe("parseTimeoutMs — --timeout duration parsing", () => {
  test("parses s/m/h/d suffixes", () => {
    expect(parseTimeoutMs("30s")).toBe(30_000)
    expect(parseTimeoutMs("5m")).toBe(300_000)
    expect(parseTimeoutMs("1h")).toBe(3_600_000)
    expect(parseTimeoutMs("2d")).toBe(172_800_000)
  })

  test("0 / none / infinite mean wait-forever", () => {
    expect(parseTimeoutMs("0")).toBe(Infinity)
    expect(parseTimeoutMs("none")).toBe(Infinity)
    expect(parseTimeoutMs("infinite")).toBe(Infinity)
    expect(parseTimeoutMs("INF")).toBe(Infinity)
  })

  test("returns undefined for garbage (caller exits loud)", () => {
    expect(parseTimeoutMs("")).toBeUndefined()
    expect(parseTimeoutMs("abc")).toBeUndefined()
    expect(parseTimeoutMs("10x")).toBeUndefined()
    expect(parseTimeoutMs("-5s")).toBeUndefined()
  })
})
