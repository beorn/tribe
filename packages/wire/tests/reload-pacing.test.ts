/**
 * A reload never re-execs the fleet's adapters at once (25663, @cto ce976914).
 *
 * The 2026-09-24 generation re-execs at 08:02 and 08:15 PDT took every seat's bridge down together; rejoins took 2 to
 * 16 s. The witness runs twenty adapters through the SAME planner the live path calls, at both measured rejoin times,
 * and counts how many are absent at once. Arms: all-at-once (the red arm, 20 absent), uniform jitter over the window
 * (fails N at 16 s, which is why the schedule ranks), and three colliding ranks (the stated tolerance, 6).
 */

import { describe, expect, test } from "vitest"
import {
  RELOAD_DEADLINE_MS,
  RELOAD_MAX_ABSENT,
  RELOAD_READY_TIMEOUT_MS,
  RELOAD_SLOT_MS,
  RELOAD_WINDOW_CAP_MS,
  pacedReexec,
  planReloadDelay,
  reloadRank,
  type ReloadDaemonView,
} from "../src/lib/reload-pacing.ts"

const FLEET = 20
const SEEDS = 200

function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The most adapters absent at once when each leaves at its delay and is gone for `rejoinMs`. */
function peakAbsent(delays: readonly number[], rejoinMs: number): number {
  return Math.max(...delays.map((start) => delays.filter((other) => other >= start && other < start + rejoinMs).length))
}

const ranked = (random: () => number, ranks: readonly number[] = [...Array(FLEET).keys()]) =>
  ranks.map((rank) => planReloadDelay(rank, FLEET, RELOAD_SLOT_MS, RELOAD_WINDOW_CAP_MS, random))

describe("the reload schedule, through the shipped planner", () => {
  test("the constants carry their derivation: slot = rejoinMax / N, and the deadline is window cap + ready timeout", () => {
    expect(RELOAD_SLOT_MS).toBe(4_000)
    expect(FLEET * RELOAD_SLOT_MS).toBeLessThanOrEqual(RELOAD_WINDOW_CAP_MS)
    expect(RELOAD_DEADLINE_MS).toBe(RELOAD_WINDOW_CAP_MS + RELOAD_READY_TIMEOUT_MS)
  })

  test.each([2_000, 16_000])("ranked: never more than N absent at a %i ms rejoin, and none absent past the deadline", (rejoinMs) => {
    for (let seed = 0; seed < SEEDS; seed++) {
      const delays = ranked(seeded(seed))
      expect(peakAbsent(delays, rejoinMs), `seed ${seed}`).toBeLessThanOrEqual(RELOAD_MAX_ABSENT)
      expect(Math.max(...delays) + rejoinMs).toBeLessThanOrEqual(RELOAD_DEADLINE_MS)
    }
  })

  test("red arm: all at once is the whole fleet absent together", () => {
    expect(peakAbsent(Array<number>(FLEET).fill(0), 2_000)).toBe(FLEET)
  })

  test("uniform jitter over the window fails N at the 16 s rejoin, which is why the schedule ranks", () => {
    const worst = Math.max(
      ...Array.from({ length: SEEDS }, (_, seed) => {
        const random = seeded(seed)
        return peakAbsent(
          Array.from({ length: FLEET }, () => planReloadDelay(null, FLEET, RELOAD_SLOT_MS, RELOAD_WINDOW_CAP_MS, random)),
          16_000,
        )
      }),
    )
    expect(worst).toBeGreaterThan(RELOAD_MAX_ABSENT)
  })

  test("three colliding ranks cost one more absent adapter, the stated tolerance", () => {
    const ranks = [...Array(FLEET).keys()].map((rank) => (rank === 5 ? 4 : rank === 12 ? 11 : rank === 17 ? 16 : rank))
    for (let seed = 0; seed < SEEDS; seed++) {
      expect(peakAbsent(ranked(seeded(seed), ranks), 16_000)).toBeLessThanOrEqual(RELOAD_MAX_ABSENT + 1)
    }
  })

  test("a rank past the window shares the last slot instead of leaving the cap", () => {
    const delay = planReloadDelay(50, 60, RELOAD_SLOT_MS, RELOAD_WINDOW_CAP_MS, () => 0.99)
    expect(delay).toBeLessThan(RELOAD_WINDOW_CAP_MS)
  })
})

describe("reloadRank", () => {
  test("ranks by sorted, de-duplicated name", () => {
    expect(reloadRank("@dev/3", ["@dev/4", "@chief", "@dev/3", "@dev/3"])).toEqual({ rank: 1, liveCount: 3, found: true })
  })

  test("an adapter missing from the list goes last, never first", () => {
    expect(reloadRank("@dev/9", ["@chief", "@dev/3"])).toEqual({ rank: 2, liveCount: 3, found: false })
  })
})

describe("pacedReexec", () => {
  function harness(views: Array<ReloadDaemonView | Error>, onDisk: string | null = "abc") {
    let now = 0
    const log: string[] = []
    const sleeps: number[] = []
    return {
      log,
      sleeps,
      deps: {
        self: "@dev/3",
        readDaemon: async () => {
          const next = views.length > 1 ? views.shift() : views[0]
          if (next instanceof Error) throw next
          return next as ReloadDaemonView
        },
        onDiskCert: () => onDisk,
        now: () => now,
        sleep: async (ms: number) => {
          sleeps.push(ms)
          now += ms
        },
        warn: (message: string) => log.push(`warn: ${message}`),
        reexec: (reason: string) => log.push(`reexec: ${reason}`),
        random: () => 0,
      },
    }
  }

  test("waits for its rank's slot, then for a daemon on the disk's code, then re-execs", async () => {
    const live = ["@chief", "@dev/2", "@dev/3"]
    const run = harness([
      { liveNames: live, runningCert: "abc" },
      { liveNames: live, runningCert: "old" },
      { liveNames: live, runningCert: "abc" },
    ])
    await pacedReexec(run.deps, "source changed")
    expect(run.sleeps[0]).toBe(2 * RELOAD_SLOT_MS)
    expect(run.log).toEqual(["reexec: source changed"])
  })

  test("a failed list read spreads over the cap and says so", async () => {
    const run = harness([new Error("socket gone"), { liveNames: [], runningCert: "abc" }])
    await pacedReexec({ ...run.deps, random: () => 0.5 }, "generation changed")
    expect(run.sleeps[0]).toBe(RELOAD_WINDOW_CAP_MS / 2)
    expect(run.log[0]).toMatch(/cli_status read failed \(socket gone\); spreading over the 90000 ms cap/u)
  })

  test("a missing self takes the last slot and says so", async () => {
    const run = harness([{ liveNames: ["@chief", "@dev/2"], runningCert: "abc" }])
    await pacedReexec(run.deps, "x")
    expect(run.sleeps[0]).toBe(2 * RELOAD_SLOT_MS)
    expect(run.log[0]).toMatch(/@dev\/3 is not in cli_status sessions\[\]\.name; taking the last slot \(2\)/u)
  })

  test("a daemon with no code identity is judged on liveness, warned once, naming 25670", async () => {
    const run = harness([{ liveNames: ["@dev/3"], runningCert: null }])
    await pacedReexec(run.deps, "x")
    expect(run.log).toEqual([
      "warn: reload pacing: no code identity to compare (daemon reports none, disk abc); readiness is liveness alone until 25670",
      "reexec: x",
    ])
  })

  test("an adapter whose disk commit is unresolved is judged on liveness too, never waiting out the timeout", async () => {
    const run = harness([{ liveNames: ["@dev/3"], runningCert: "abc" }], null)
    await pacedReexec(run.deps, "x")
    expect(run.log).toEqual([
      "warn: reload pacing: no code identity to compare (daemon abc, disk unresolved); readiness is liveness alone until 25670",
      "reexec: x",
    ])
  })

  test("a daemon never on the disk's code re-execs anyway at the timeout, loudly", async () => {
    const run = harness([{ liveNames: ["@dev/3"], runningCert: "old" }])
    await pacedReexec(run.deps, "x")
    expect(run.log[0]).toMatch(/daemon not ready after 30000 ms \(the daemon runs other code than the disk\); re-execing anyway/u)
    expect(run.log[1]).toBe("reexec: x")
  })
})
