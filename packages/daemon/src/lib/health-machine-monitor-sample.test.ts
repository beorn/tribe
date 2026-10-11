/**
 * @failure cli_health re-runs the process census on every request while the
 *          background monitor already holds a sample, occupying the
 *          single-threaded daemon so 5s-deadline readers queue behind it — and
 *          it does it AGAIN once the sample looks old, so the very request that
 *          reports health stalls behind a >5 s census run — specimen 4,
 *          23:22:08Z: WATCH failsafe:seats and tribe-inbox-facts both failed
 *          with "Request cli_health timed out after 5000ms").
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
  it("serves the monitor's sample and cannot await a census", () => {
    const observedAt = 1_000_000
    const result = resolveHealthMachine({
      now: () => observedAt + POLL_MS,
      pollIntervalMs: POLL_MS,
      sample: monitorSample(observedAt),
    })
    // Synchronous by contract: a census on this path is what took >5 s
    // (specimen 4), and a synchronous result cannot wait on one.
    expect(result).not.toBeInstanceOf(Promise)
    expect(result.source).toBe("monitor-sample")
    expect(result.stale).toBe(false)
    expect(result.ageMs).toBe(POLL_MS)
    expect(tokenOf(result.metrics as HealthMetrics)).toBe("monitor")
  })

  it("still serves the monitor's sample once it is past the stale bound — it does not collect fresh", () => {
    const observedAt = 2_000_000
    const age = POLL_MS * HEALTH_SAMPLE_STALE_INTERVALS + 1
    const result = resolveHealthMachine({
      now: () => observedAt + age,
      pollIntervalMs: POLL_MS,
      sample: monitorSample(observedAt),
    })
    // The stale sample is served WITH its age and the stale flag; replacing it
    // with a fresh census is exactly the stall being fixed.
    expect(result.source).toBe("monitor-sample")
    expect(result.stale).toBe(true)
    expect(result.ageMs).toBe(age)
    expect(result.staleAfterMs).toBe(POLL_MS * HEALTH_SAMPLE_STALE_INTERVALS)
    expect(tokenOf(result.metrics as HealthMetrics)).toBe("monitor")
  })

  it("reports no sample (never a silent healthy default) before the monitor's first tick", () => {
    const result = resolveHealthMachine({ now: () => 3_000_000, pollIntervalMs: POLL_MS, sample: undefined })
    expect(result.metrics).toBeNull()
    expect(result.source).toBe("none")
    expect(result.stale).toBe(true)
    expect(result.ageMs).toBeNull()
    expect(result.staleAfterMs).toBe(POLL_MS * HEALTH_SAMPLE_STALE_INTERVALS)
  })
})
