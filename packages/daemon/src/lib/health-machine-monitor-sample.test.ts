/**
 * @failure cli_health re-runs the process census on every request while the
 *          background monitor already holds a fresh sample, occupying the
 *          single-threaded daemon so 5s-deadline readers queue behind it.
 * @level   l2
 * @consumer @chief 28196 (tribe socket reads time out at 5 s under load)
 * @testonly none
 */

import { describe, expect, it } from "vitest"
import { HEALTH_SAMPLE_STALE_INTERVALS, resolveHealthMachine, type HealthMetrics } from "./health-monitor-plugin.ts"

const POLL_MS = 10_000
const sampleMetrics = (token: string) => ({ token }) as unknown as HealthMetrics
const tokenOf = (metrics: HealthMetrics) => (metrics as unknown as { token: string }).token
const monitorSample = (observedAt: number) => ({ metrics: sampleMetrics("monitor"), observedAt })

describe("resolveHealthMachine — serve the monitor's sample (28196)", () => {
  it("does NOT collect while the monitor holds a sample younger than its interval", async () => {
    const observedAt = 1_000_000
    const sample = monitorSample(observedAt)
    let collects = 0
    // Two consecutive reads stand in for two cli_health requests; neither may
    // spawn the census while the monitor's sample is fresh.
    const first = await resolveHealthMachine({
      now: () => observedAt + POLL_MS,
      pollIntervalMs: POLL_MS,
      sample,
      collect: async () => {
        collects += 1
        return sampleMetrics("fresh")
      },
    })
    const second = await resolveHealthMachine({
      now: () => observedAt + POLL_MS,
      pollIntervalMs: POLL_MS,
      sample,
      collect: async () => {
        collects += 1
        return sampleMetrics("fresh")
      },
    })
    expect(collects).toBe(0)
    expect(first.source).toBe("monitor-sample")
    expect(first.stale).toBe(false)
    expect(first.ageMs).toBe(POLL_MS)
    expect(tokenOf(first.metrics)).toBe("monitor")
    expect(second.source).toBe("monitor-sample")
  })

  it("collects fresh and reports stale once the sample is past the bound", async () => {
    const observedAt = 2_000_000
    const age = POLL_MS * HEALTH_SAMPLE_STALE_INTERVALS + 1
    let collects = 0
    const resolve = await resolveHealthMachine({
      now: () => observedAt + age,
      pollIntervalMs: POLL_MS,
      sample: monitorSample(observedAt),
      collect: async () => {
        collects += 1
        return sampleMetrics("fresh")
      },
    })
    expect(collects).toBe(1)
    expect(resolve.source).toBe("fresh")
    expect(resolve.stale).toBe(true)
    expect(resolve.ageMs).toBe(age)
    expect(tokenOf(resolve.metrics)).toBe("fresh")
  })

  it("reports stale (never a silent healthy default) when no sample has landed", async () => {
    let collects = 0
    const resolve = await resolveHealthMachine({
      now: () => 3_000_000,
      pollIntervalMs: POLL_MS,
      sample: undefined,
      collect: async () => {
        collects += 1
        return sampleMetrics("fresh")
      },
    })
    expect(collects).toBe(1)
    expect(resolve.source).toBe("fresh")
    expect(resolve.stale).toBe(true)
    expect(resolve.ageMs).toBeNull()
    expect(resolve.staleAfterMs).toBe(POLL_MS * HEALTH_SAMPLE_STALE_INTERVALS)
  })
})
