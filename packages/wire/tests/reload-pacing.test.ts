/**
 * @failure A fleet-wide reload re-execs every adapter at once and takes every seat's bridge down together, or a daemon
 *          that never answers holds a reload past the deadline 25662's bridge-lost grace is sized for.
 * @level l0
 * @consumer the stdio adapter's paced re-exec (25663) and 25662's bridge-lost grace
 * @testonly none
 *
 * A reload never re-execs the fleet's adapters at once (25663, @cto ce976914).
 *
 * The 2026-09-24 generation re-execs at 08:02 and 08:15 PDT took every seat's bridge down together; rejoins took 2 to
 * 16 s. The witness runs twenty adapters through the SAME planner the live path calls, at both measured rejoin times,
 * and counts how many are absent at once. Arms: all-at-once (the red arm, 20 absent), uniform jitter over the window
 * (fails N at 16 s, which is why the schedule ranks), and three colliding ranks (the stated tolerance, 6).
 *
 * On a daemon generation change each adapter reads the list just after its own re-register (25663 P3). The
 * per-adapter-read rows model that: ranked on sessions[].name the adapters collide (the red arm); ranked on
 * reload_peers each takes its roster place whenever it reads (@cto bf0417a0).
 */

import { describe, expect, test } from "vitest"
import {
  RELOAD_DEADLINE_MS,
  RELOAD_MAX_ABSENT,
  RELOAD_MAX_DECLARED,
  RELOAD_PROBE_TIMEOUT_MS,
  RELOAD_READY_TIMEOUT_MS,
  RELOAD_SLOT_MS,
  RELOAD_WINDOW_CAP_MS,
  pacedReexec,
  planReloadDelay,
  reloadCapacityRefusal,
  reloadRank,
  type ReloadDaemonView,
  type ReloadPeers,
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
  test("the constants carry their derivation: slot = rejoinMax / N, and the deadline adds two bounded reads", () => {
    expect(RELOAD_SLOT_MS).toBe(4_000)
    expect(FLEET * RELOAD_SLOT_MS).toBeLessThanOrEqual(RELOAD_WINDOW_CAP_MS)
    expect(RELOAD_DEADLINE_MS).toBe(RELOAD_WINDOW_CAP_MS + RELOAD_READY_TIMEOUT_MS + 2 * RELOAD_PROBE_TIMEOUT_MS)
    // 25663 r2: the window holds 28 declared seats, one slot each; the live roster declared 23 on 2026-09-24.
    expect(RELOAD_MAX_DECLARED).toBe(28)
    expect(RELOAD_MAX_DECLARED * RELOAD_SLOT_MS).toBe(RELOAD_WINDOW_CAP_MS)
  })

  test.each([2_000, 16_000])(
    "ranked: never more than N absent at a %i ms rejoin, and none absent past the deadline",
    (rejoinMs) => {
      for (let seed = 0; seed < SEEDS; seed++) {
        const delays = ranked(seeded(seed))
        expect(peakAbsent(delays, rejoinMs), `seed ${seed}`).toBeLessThanOrEqual(RELOAD_MAX_ABSENT)
        expect(Math.max(...delays) + rejoinMs).toBeLessThanOrEqual(RELOAD_DEADLINE_MS)
      }
    },
  )

  test("red arm: all at once is the whole fleet absent together", () => {
    expect(peakAbsent(Array<number>(FLEET).fill(0), 2_000)).toBe(FLEET)
  })

  test("uniform jitter over the window fails N at the 16 s rejoin, which is why the schedule ranks", () => {
    const worst = Math.max(
      ...Array.from({ length: SEEDS }, (_, seed) => {
        const random = seeded(seed)
        return peakAbsent(
          Array.from({ length: FLEET }, () =>
            planReloadDelay(null, FLEET, RELOAD_SLOT_MS, RELOAD_WINDOW_CAP_MS, random),
          ),
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

describe("each adapter ranks from its own read, just after its own re-register", () => {
  const names = Array.from({ length: FLEET }, (_, index) => `@dev/${String(index).padStart(2, "0")}`)

  /**
   * Adapters re-register over `spreadMs`, each reads cli_status 10-50 ms after its own re-register, and the live list
   * it reads holds only those re-registered by then. Each leaves at its read plus its planned delay.
   */
  function generationChange(seed: number, spreadMs: number, peersAt: (live: string[]) => ReloadPeers) {
    const random = seeded(seed)
    const registeredAt = names.map(() => random() * spreadMs)
    const readAt = registeredAt.map((at) => at + 10 + random() * 40)
    const ranks: number[] = []
    const leaves = names.map((self, index) => {
      const live = names.filter((_, other) => registeredAt[other]! <= readAt[index]!)
      const ranked = reloadRank(self, peersAt(live))
      ranks.push(ranked.rank)
      return (
        readAt[index]! + planReloadDelay(ranked.rank, ranked.peerCount, RELOAD_SLOT_MS, RELOAD_WINDOW_CAP_MS, random)
      )
    })
    return { ranks, peak: peakAbsent(leaves, 16_000) }
  }
  const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
  const seeds = [...Array(SEEDS).keys()]

  test.each([250, 2_000])(
    "red arm: ranked on sessions[].name, above N in every seed (%i ms re-register spread)",
    (spreadMs) => {
      const peaks = seeds.map(
        (seed) => generationChange(seed, spreadMs, (live) => ({ declared: [], liveUndeclared: live })).peak,
      )
      expect(Math.min(...peaks)).toBeGreaterThan(RELOAD_MAX_ABSENT)
    },
  )

  test.each([250, 2_000])(
    "ranked on reload_peers, every adapter takes its roster place (%i ms re-register spread)",
    (spreadMs) => {
      const runs = seeds.map((seed) =>
        generationChange(seed, spreadMs, (live) => ({ declared: names, liveUndeclared: live })),
      )
      for (const run of runs) expect(run.ranks).toEqual([...names.keys()])
      // The full-list number: exactly N at a 250 ms spread. A 2 s spread shifts each slot by its adapter's read time,
      // which costs at most the one more absent adapter the collision row states.
      if (spreadMs === 250) expect(mean(runs.map((run) => run.peak))).toBe(RELOAD_MAX_ABSENT)
      expect(Math.max(...runs.map((run) => run.peak))).toBeLessThanOrEqual(RELOAD_MAX_ABSENT + 1)
    },
  )
})

describe("reloadRank", () => {
  const peers = (declared: string[], liveUndeclared: string[] = []): ReloadPeers => ({ declared, liveUndeclared })

  test("ranks by sorted, de-duplicated declared name, live or not", () => {
    expect(reloadRank("@dev/3", peers(["@dev/4", "@chief", "@dev/3", "@dev/3"]))).toEqual({
      rank: 1,
      peerCount: 3,
      found: true,
      declared: true,
    })
  })

  test("undeclared live adapters follow the declared set in name order, never one shared last slot", () => {
    const shared = peers(["@dev/2", "@chief"], ["@grok/2", "@chief", "@grok/1"])
    expect(reloadRank("@grok/1", shared)).toEqual({ rank: 2, peerCount: 4, found: true, declared: false })
    expect(reloadRank("@grok/2", shared)).toEqual({ rank: 3, peerCount: 4, found: true, declared: false })
  })

  test("an adapter missing from the list goes last, never first", () => {
    expect(reloadRank("@dev/9", peers(["@chief", "@dev/3"]))).toEqual({
      rank: 2,
      peerCount: 3,
      found: false,
      declared: false,
    })
  })
})

describe("pacedReexec", () => {
  /** A current daemon's view: every live name is declared. */
  const view = (declared: string[], runningCert: string | null): ReloadDaemonView => ({
    liveNames: declared,
    peers: { declared, liveUndeclared: [] },
    runningCert,
  })
  function harness(views: Array<ReloadDaemonView | Error | "hang">, onDisk: string | null = "abc") {
    let now = 0
    const log: string[] = []
    const infos: string[] = []
    const sleeps: number[] = []
    return {
      log,
      infos,
      sleeps,
      elapsed: () => now,
      deps: {
        self: "@dev/3",
        readDaemon: async () => {
          const next = views.length > 1 ? views.shift() : views[0]
          if (next === "hang") return new Promise<ReloadDaemonView>(() => {})
          if (next instanceof Error) throw next
          return next as ReloadDaemonView
        },
        // The read bound fires only when the read hangs; it spends the fake clock the way a real timer spends time.
        timeout: async (ms: number) => {
          await new Promise<void>((resolve) => setImmediate(resolve))
          now += ms
        },
        onDiskCert: () => onDisk,
        now: () => now,
        sleep: async (ms: number) => {
          sleeps.push(ms)
          now += ms
        },
        warn: (message: string) => log.push(`warn: ${message}`),
        info: (message: string) => infos.push(message),
        reexec: (reason: string) => log.push(`reexec: ${reason}`),
        random: () => 0,
      },
    }
  }

  test("waits for its rank's slot, then for a daemon on the disk's code, then re-execs", async () => {
    const live = ["@chief", "@dev/2", "@dev/3"]
    const run = harness([view(live, "abc"), view(live, "old"), view(live, "abc")])
    await pacedReexec(run.deps, "source changed")
    expect(run.sleeps[0]).toBe(2 * RELOAD_SLOT_MS)
    expect(run.infos).toEqual([`reload pacing: @dev/3 rank 2 of 3 peers, slot 2; waiting ${2 * RELOAD_SLOT_MS} ms`])
    expect(run.log).toEqual(["reexec: source changed"])
  })

  test("a failed list read spreads over the cap and says so", async () => {
    const run = harness([new Error("socket gone"), view([], "abc")])
    await pacedReexec({ ...run.deps, random: () => 0.5 }, "generation changed")
    expect(run.sleeps[0]).toBe(RELOAD_WINDOW_CAP_MS / 2)
    expect(run.log[0]).toBe(
      `warn: reload pacing: cli_status read failed (socket gone); spreading over the ${RELOAD_WINDOW_CAP_MS} ms cap`,
    )
  })

  test("a missing self takes the last slot and says so", async () => {
    const run = harness([view(["@chief", "@dev/2"], "abc")])
    await pacedReexec(run.deps, "x")
    expect(run.sleeps[0]).toBe(2 * RELOAD_SLOT_MS)
    expect(run.log[0]).toMatch(/@dev\/3 is not in cli_status reload_peers; taking the last slot \(2\)/u)
  })

  test("a daemon older than reload_peers ranks on sessions[].name and says so", async () => {
    const run = harness([{ liveNames: ["@chief", "@dev/3"], peers: null, runningCert: "abc" }])
    await pacedReexec(run.deps, "x")
    expect(run.sleeps[0]).toBe(RELOAD_SLOT_MS)
    expect(run.log[0]).toMatch(/cli_status carries no reload_peers .*; ranking on sessions\[\]\.name/u)
  })

  test("a daemon with no declared roster ranks on the live adapters and says so", async () => {
    const run = harness([
      { liveNames: ["@dev/3"], peers: { declared: [], liveUndeclared: ["@dev/3"] }, runningCert: "abc" },
    ])
    await pacedReexec(run.deps, "x")
    expect(run.log[0]).toMatch(/the daemon has no declared roster; ranking on the live adapters alone/u)
  })

  test("an undeclared adapter ranks after the roster and says an unseen one can share its slot", async () => {
    const run = harness([
      { liveNames: ["@dev/3"], peers: { declared: ["@chief"], liveUndeclared: ["@dev/3"] }, runningCert: "abc" },
    ])
    await pacedReexec(run.deps, "x")
    expect(run.sleeps[0]).toBe(RELOAD_SLOT_MS)
    expect(run.log[0]).toMatch(/@dev\/3 is not in the declared roster; ranked 1 after it/u)
  })

  const roster = (count: number) =>
    Array.from({ length: count }, (_, index) => `@dev/${String(index).padStart(2, "0")}`)

  test("a 23-seat roster gives every declared seat its own slot, with no warning", async () => {
    const declared = roster(23)
    const slots: number[] = []
    for (const self of declared) {
      const run = harness([view(declared, "abc")])
      await pacedReexec({ ...run.deps, self }, "x")
      expect(run.log, self).toEqual(["reexec: x"])
      slots.push(run.sleeps[0]! / RELOAD_SLOT_MS)
    }
    expect(slots).toEqual([...declared.keys()])
  })

  test("a roster larger than the window refuses, naming the count and the cap", async () => {
    expect(reloadCapacityRefusal(RELOAD_MAX_DECLARED)).toBeNull()
    const run = harness([view(roster(40), "abc")])
    await pacedReexec({ ...run.deps, self: "@dev/35" }, "x")
    expect(run.log[0]).toBe(
      "warn: reload pacing: the declared roster names 40 seats but the paced reload holds 28 (112000 ms window of 4000 ms slots inside the 146000 ms deadline); declared seats past slot 27 share it",
    )
    expect(run.log[1]).toMatch(/rank 35 of 40 peers shares the last slot \(27\)/u)
  })

  test("only an undeclared adapter past a full roster shares the last slot, and says so", async () => {
    const run = harness([
      { liveNames: ["@grok/1"], peers: { declared: roster(28), liveUndeclared: ["@grok/1"] }, runningCert: "abc" },
    ])
    await pacedReexec({ ...run.deps, self: "@grok/1" }, "x")
    expect(run.sleeps[0]).toBe(27 * RELOAD_SLOT_MS)
    expect(run.log[0]).toMatch(/@grok\/1 is not in the declared roster; ranked 28 after it/u)
    expect(run.log[1]).toMatch(/rank 28 of 29 peers shares the last slot \(27\) inside the 112000 ms cap/u)
  })

  test("a daemon with no code identity is judged on liveness, warned once, naming 25670", async () => {
    const run = harness([view(["@dev/3"], null)])
    await pacedReexec(run.deps, "x")
    expect(run.log).toEqual([
      "warn: reload pacing: no code identity to compare (daemon reports none, disk abc); readiness is liveness alone until 25670",
      "reexec: x",
    ])
  })

  test("an adapter whose disk commit is unresolved is judged on liveness too, never waiting out the timeout", async () => {
    const run = harness([view(["@dev/3"], "abc")], null)
    await pacedReexec(run.deps, "x")
    expect(run.log).toEqual([
      "warn: reload pacing: no code identity to compare (daemon abc, disk unresolved); readiness is liveness alone until 25670",
      "reexec: x",
    ])
  })

  test("a daemon never on the disk's code re-execs anyway at the timeout, loudly", async () => {
    const run = harness([view(["@dev/3"], "old")])
    await pacedReexec(run.deps, "x")
    expect(run.log[0]).toMatch(
      /daemon not ready after 30000 ms \(the daemon runs other code than the disk\); re-execing anyway/u,
    )
    expect(run.log[1]).toBe("reexec: x")
  })

  test.each([0, 0.999])(
    "a daemon that never answers still re-execs, loudly, within the deadline (random %d)",
    async (unit) => {
      const run = harness(["hang"])
      await pacedReexec({ ...run.deps, random: () => unit }, "x")
      expect(run.log[0]).toMatch(/cli_status read failed \(cli_status did not answer within 2000 ms\)/u)
      expect(run.log.at(-2)).toMatch(/daemon not ready after \d+ ms \(cli_status did not answer within 2000 ms\)/u)
      expect(run.log.at(-1)).toBe("reexec: x")
      expect(run.elapsed()).toBeLessThanOrEqual(RELOAD_DEADLINE_MS)
    },
  )
})
