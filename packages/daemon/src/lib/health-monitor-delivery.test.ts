import { describe, expect, test } from "vitest"
import {
  createAlertState,
  defaultThresholds,
  deliverHealthAlert,
  evaluateAlerts,
  planHealthAlertDelivery,
  type HealthMetrics,
} from "./health-monitor-plugin.ts"
import type { TribeClientApi } from "./plugin-api.ts"

const BASE_TIME_MS = 1_000_000
const CPU_ALERT_COOLDOWN_MS = 5 * 60_000

function metrics(loadAvg1m: number, timestamp: number): HealthMetrics {
  return {
    cpu: { loadAvg1m, loadAvg5m: loadAvg1m, coreCount: 4, topProcesses: [] },
    memory: { totalMB: 100, usedMB: 10, availableMB: 90, pressurePercent: 10, swapUsedMB: 0 },
    bunProcesses: 0,
    processObservation: { kind: "standalone-os" },
    scalarObservation: { kind: "standalone-os", unavailable: ["disk.bytes", "disk.inodes"] },
    timestamp,
  }
}

describe("health alert delivery", () => {
  test("standalone metrics carry explicit scalar provenance", () => {
    expect(metrics(0, BASE_TIME_MS).scalarObservation).toEqual({
      kind: "standalone-os",
      unavailable: ["disk.bytes", "disk.inodes"],
    })
  })

  test("uses one broadcast for fleet alerts and unique direct recipients only for attributable warnings", () => {
    expect(
      planHealthAlertDelivery({
        severity: "critical",
        attributedSessions: new Set(["@agent/5", "@chief"]),
        hasUnattributed: true,
      }),
    ).toEqual({ kind: "broadcast" })

    expect(
      planHealthAlertDelivery({
        severity: "warning",
        attributedSessions: new Set(["@agent/5", "@agent/2"]),
        hasUnattributed: false,
      }),
    ).toEqual({ kind: "direct", recipients: ["@agent/2", "@agent/5"] })
  })

  test("executes a critical delivery as one broadcast and no per-recipient sends", () => {
    const broadcasts: string[] = []
    const sends: string[] = []
    const api = {
      broadcast: (message: string) => broadcasts.push(message),
      send: (recipient: string) => sends.push(recipient),
    } as unknown as TribeClientApi

    deliverHealthAlert(
      api,
      { type: "cpu", severity: "critical" },
      "CPU critical sample",
      new Set(["@agent/5", "@chief"]),
      true,
    )

    expect(broadcasts).toEqual(["CPU critical sample"])
    expect(sends).toEqual([])
  })

  test("re-resolves a sampled generated name to the live canonical name immediately before direct delivery", () => {
    const sends: string[] = []
    const api = {
      broadcast: () => undefined,
      send: (recipient: string) => sends.push(recipient),
      getActiveSessions: () => [{ name: "@agent/7", pid: 7007, role: "member" }],
    } as unknown as TribeClientApi

    deliverHealthAlert(
      api,
      { type: "cpu", severity: "warning" },
      "CPU warning sample",
      new Set(["silvercode-ghost"]),
      false,
      [{ name: "silvercode-ghost", pid: 7007, role: "member" }],
    )

    expect(sends).toEqual(["@agent/7"])
  })

  test.each([
    { label: "mixed live and service owners", owners: ["@dev/5", "habmod", "km-daemon"], recipients: ["@dev/5"] },
    { label: "service owners only", owners: ["habmod", "km-daemon"], recipients: [] },
  ])("sends only to resolvable warning recipients: $label", ({ owners, recipients }) => {
    const broadcasts: string[] = []
    const sends: { recipient: string; message: string }[] = []
    const api = {
      broadcast: (message: string) => broadcasts.push(message),
      getActiveSessions: () => [{ name: "@dev/5", pid: 5005, role: "member" }],
      send: (recipient: string, message: string) => sends.push({ recipient, message }),
    } as unknown as TribeClientApi

    expect(
      deliverHealthAlert(api, { type: "cpu", severity: "warning" }, "CPU warning sample", new Set(owners), false),
    ).toEqual({ kind: "direct", recipients })

    expect(sends).toEqual(recipients.map((recipient) => ({ recipient, message: "CPU warning sample" })))
    expect(broadcasts).toEqual([])
  })

  test("rate-limits a repeated CPU episode after a brief below-threshold sample", () => {
    const thresholds = { ...defaultThresholds(), cpuCriticalMultiplier: 2, sustainedSamples: 1 }
    const state = createAlertState()
    const critical = (atMs: number) => evaluateAlerts(metrics(9, atMs), thresholds, state)
    const clear = (atMs: number) => evaluateAlerts(metrics(0, atMs), thresholds, state)

    expect(critical(BASE_TIME_MS).map((alert) => `${alert.type}:${alert.severity}`)).toContain("cpu:critical")
    clear(BASE_TIME_MS + 10_000)
    expect(critical(BASE_TIME_MS + 60_000).map((alert) => `${alert.type}:${alert.severity}`)).not.toContain(
      "cpu:critical",
    )

    clear(BASE_TIME_MS + CPU_ALERT_COOLDOWN_MS)
    expect(
      critical(BASE_TIME_MS + CPU_ALERT_COOLDOWN_MS + 1).map((alert) => `${alert.type}:${alert.severity}`),
    ).toContain("cpu:critical")
  })

  /**
   * 30382: a canonical observation carries `runnable` and is judged on observation time. `sequence` is the fact
   * identity, `at` the fact's own observedAt; 4 cores, so the warning line is 3.2 and the critical line 6.
   */
  const canonical = (
    sequence: number,
    at: number,
    load: number,
    runnableTasks: number,
    epoch = "host-a",
  ): HealthMetrics => ({
    ...metrics(load, at),
    cpu: { loadAvg1m: load, loadAvg5m: load, coreCount: 4, runnableTasks, topProcesses: [] },
    scalarObservation: {
      kind: "canonical-available",
      observedAt: at,
      source: { epoch, sequence },
      unavailable: [],
    },
  })
  const kinds = (alerts: readonly { type: string; severity: string }[]): string[] =>
    alerts.map((alert) => `${alert.type}:${alert.severity}`)

  test("counts one canonical scalar fact once toward a sustained alert", () => {
    // 30382 erratum 2: the canonical row carries `runnable` plus qualifying ELAPSED time. Fact 1 is re-read 5 s
    // later (a journal RETRY inside the same poll): ignored, so it is neither an observation nor time. Were it
    // re-judged, the page would read 4 observations. (A producer that stalls for a whole poll is a gap, not a repeat:
    // see "the gap bound is the cadence".)
    const thresholds = { ...defaultThresholds(), cpuCriticalMultiplier: 2, cpuQualifyingMs: 20_000 }
    const state = createAlertState()

    expect(evaluateAlerts(canonical(1, BASE_TIME_MS, 9, 9), thresholds, state)).toEqual([])
    expect(evaluateAlerts(canonical(1, BASE_TIME_MS + 5_000, 9, 9), thresholds, state)).toEqual([])
    expect(evaluateAlerts(canonical(2, BASE_TIME_MS + 10_000, 9, 9), thresholds, state)).toEqual([])
    const fired = evaluateAlerts(canonical(3, BASE_TIME_MS + 20_000, 9, 9), thresholds, state)
    expect(fired).toEqual([expect.objectContaining({ severity: "critical", type: "cpu" })])
    expect(fired[0]!.message).toContain("for 20s of the last 180s observed (3 observations covering 20s)")
  })

  test("an unavailable scalar fact breaks a sustained sequence without inventing healthy values", () => {
    // 30382 erratum 2: positive time accrues BEFORE the outage and no longer contributes after it — the window
    // resets, rather than the alarm dying or the pre-outage credit paging on the first samples back.
    const thresholds = { ...defaultThresholds(), cpuCriticalMultiplier: 2, cpuQualifyingMs: 30_000 }
    const state = createAlertState()
    const unavailable: HealthMetrics = {
      ...metrics(0, BASE_TIME_MS + 30_000),
      cpu: { topProcesses: [] },
      memory: undefined,
      scalarObservation: { kind: "canonical-unavailable", reason: "scalar-fact-stale" },
    }

    expect(evaluateAlerts(canonical(1, BASE_TIME_MS, 9, 9), thresholds, state)).toEqual([])
    expect(evaluateAlerts(canonical(2, BASE_TIME_MS + 10_000, 9, 9), thresholds, state)).toEqual([])
    expect(evaluateAlerts(canonical(3, BASE_TIME_MS + 20_000, 9, 9), thresholds, state)).toEqual([])
    expect(state.cpuWindow, "20 s of qualifying time accrued before the outage").toHaveLength(3)
    expect(evaluateAlerts(unavailable, thresholds, state)).toEqual([])
    expect(state.cpuWindow, "the outage resets the window").toHaveLength(0)
    // 20 s before the outage plus 20 s after would page here if the window carried across it.
    expect(evaluateAlerts(canonical(4, BASE_TIME_MS + 40_000, 9, 9), thresholds, state)).toEqual([])
    expect(evaluateAlerts(canonical(5, BASE_TIME_MS + 50_000, 9, 9), thresholds, state)).toEqual([])
    expect(evaluateAlerts(canonical(6, BASE_TIME_MS + 60_000, 9, 9), thresholds, state)).toEqual([])
    // ...and 30 s accrued after it pages: the alarm survived the outage.
    expect(kinds(evaluateAlerts(canonical(7, BASE_TIME_MS + 70_000, 9, 9), thresholds, state))).toContain(
      "cpu:critical",
    )
  })

  test("30382 AC1: a load burst that drains the runnable queue does not page", () => {
    // Load 9 on 4 cores sits above both lines for three minutes while the queue never exceeds the cores: churn.
    const thresholds = defaultThresholds()
    const state = createAlertState()
    for (let sample = 0; sample < 19; sample += 1) {
      expect(evaluateAlerts(canonical(sample + 1, BASE_TIME_MS + sample * 10_000, 9, 4), thresholds, state)).toEqual([])
    }
  })

  test("30382 AC2: a genuine plateau pages at both severities and names the window, the time and both metrics", () => {
    const thresholds = defaultThresholds()
    const state = createAlertState()
    let sequence = 0
    const step = (load: number, runnableTasks: number) => {
      sequence += 1
      return evaluateAlerts(
        canonical(sequence, BASE_TIME_MS + (sequence - 1) * 10_000, load, runnableTasks),
        thresholds,
        state,
      )
    }

    // Warning line (3.2) with 7 runnable tasks over 4 cores: 40 s of observation is not yet 50 s.
    for (let sample = 0; sample < 5; sample += 1) expect(step(5, 7)).toEqual([])
    const warning = step(5, 7)
    expect(kinds(warning)).toEqual(["cpu:warning"])
    expect(warning[0]!.message).toBe(
      "CPU warning: load 5 exceeds 3.2 (4 cores x 0.8) with 7 runnable tasks over 4 cores for 50s of the last 180s " +
        "observed (6 observations covering 50s)",
    )
    // Critical line (6): critical time starts accruing only once BOTH ends of an interval are critical.
    for (let sample = 0; sample < 5; sample += 1) expect(step(9, 7)).toEqual([])
    const critical = step(9, 7)
    expect(kinds(critical)).toEqual(["cpu:critical"])
    expect(critical[0]!.message).toBe(
      "CPU critical: load 9 exceeds 6.0 (4 cores x 1.5) with 7 runnable tasks over 4 cores for 50s of the last 180s " +
        "observed (12 observations covering 110s)",
    )
  })

  test("30382: the current observation must itself qualify — retained history alone never pages", () => {
    const thresholds = { ...defaultThresholds(), cpuQualifyingMs: 45_000 }
    const state = createAlertState()
    for (let sample = 0; sample < 5; sample += 1) {
      expect(evaluateAlerts(canonical(sample + 1, BASE_TIME_MS + sample * 10_000, 9, 7), thresholds, state)).toEqual([])
    }
    // 40 s of qualifying history; a drained queue now must not page on it, nor lend the next sample its credit.
    expect(evaluateAlerts(canonical(6, BASE_TIME_MS + 50_000, 9, 2), thresholds, state)).toEqual([])
    expect(evaluateAlerts(canonical(7, BASE_TIME_MS + 60_000, 9, 7), thresholds, state)).toEqual([])
  })

  test("30382: a sampling gap earns no credit and is disclosed in the page", () => {
    const thresholds = { ...defaultThresholds(), cpuQualifyingMs: 30_000 }
    const state = createAlertState()
    expect(evaluateAlerts(canonical(1, BASE_TIME_MS, 9, 7), thresholds, state)).toEqual([])
    expect(evaluateAlerts(canonical(2, BASE_TIME_MS + 10_000, 9, 7), thresholds, state)).toEqual([])
    // 40 s between observations: the sampler stalled and the condition in between is unknown, so no credit —
    // crediting it would page here (10 s + 40 s).
    expect(evaluateAlerts(canonical(3, BASE_TIME_MS + 50_000, 9, 7), thresholds, state)).toEqual([])
    expect(evaluateAlerts(canonical(4, BASE_TIME_MS + 60_000, 9, 7), thresholds, state)).toEqual([])
    const fired = evaluateAlerts(canonical(5, BASE_TIME_MS + 70_000, 9, 7), thresholds, state)
    expect(kinds(fired)).toEqual(["cpu:critical"])
    expect(fired[0]!.message).toContain(
      "for 30s of the last 180s observed (5 observations covering 30s; 1 sampling gap(s) totalling 40s not credited)",
    )
  })

  test("30382: the gap bound is the cadence — a late sample is credited, a missed poll is disclosed", () => {
    // Default cadence 10 s: the bound is one and a half polls (15 s). A 12 s interval is one late sample and counts;
    // a 20 s interval is a missed poll and is disclosed instead of credited. Were it credited, sample 4 would page.
    const thresholds = { ...defaultThresholds(), cpuQualifyingMs: 30_000 }
    expect(thresholds.cpuGapMs).toBe(15_000)
    const state = createAlertState()
    expect(evaluateAlerts(canonical(1, BASE_TIME_MS, 9, 7), thresholds, state)).toEqual([])
    expect(evaluateAlerts(canonical(2, BASE_TIME_MS + 12_000, 9, 7), thresholds, state)).toEqual([])
    expect(evaluateAlerts(canonical(3, BASE_TIME_MS + 32_000, 9, 7), thresholds, state)).toEqual([])
    expect(evaluateAlerts(canonical(4, BASE_TIME_MS + 44_000, 9, 7), thresholds, state)).toEqual([])
    const fired = evaluateAlerts(canonical(5, BASE_TIME_MS + 56_000, 9, 7), thresholds, state)
    expect(kinds(fired)).toEqual(["cpu:critical"])
    expect(fired[0]!.message).toContain(
      "for 36s of the last 180s observed (5 observations covering 36s; 1 sampling gap(s) totalling 20s not credited)",
    )
  })

  test("30382: a slower poll cadence still pages — the bound follows HEALTH_POLL_INTERVAL", () => {
    // start() hands the parsed cadence to defaultThresholds. At HEALTH_POLL_INTERVAL=60 every interval is 60 s of
    // observation time, not a gap; a fixed 30 s bound would have credited nothing and killed CPU paging silently.
    const thresholds = defaultThresholds(60)
    expect(thresholds.cpuGapMs).toBe(90_000)
    const state = createAlertState()
    expect(evaluateAlerts(canonical(1, BASE_TIME_MS, 9, 7), thresholds, state)).toEqual([])
    const fired = evaluateAlerts(canonical(2, BASE_TIME_MS + 60_000, 9, 7), thresholds, state)
    expect(kinds(fired)).toEqual(["cpu:critical"])
    expect(fired[0]!.message).toContain("for 60s of the last 180s observed (2 observations covering 60s)")
  })

  test("30382: a producer epoch change resets the window instead of continuing it", () => {
    const thresholds = { ...defaultThresholds(), cpuQualifyingMs: 30_000 }
    const state = createAlertState()
    expect(evaluateAlerts(canonical(1, BASE_TIME_MS, 9, 7), thresholds, state)).toEqual([])
    expect(evaluateAlerts(canonical(2, BASE_TIME_MS + 10_000, 9, 7), thresholds, state)).toEqual([])
    expect(evaluateAlerts(canonical(3, BASE_TIME_MS + 20_000, 9, 7), thresholds, state)).toEqual([])
    // A restarted producer: new epoch, sequence back at 1. Without the reset this sample would page (30 s).
    expect(evaluateAlerts(canonical(1, BASE_TIME_MS + 30_000, 9, 7, "host-b"), thresholds, state)).toEqual([])
    expect(state.cpuWindow).toHaveLength(1)
  })

  test("30382 AC3: a canonical fact without `runnable` is PARTIALLY blind — no CPU page, disk and memory still judged", () => {
    const thresholds = defaultThresholds()
    const state = createAlertState()
    const withoutRunnable = (sequence: number, at: number): HealthMetrics => ({
      ...canonical(sequence, at, 9, 7),
      cpu: {
        loadAvg1m: 9,
        loadAvg5m: 9,
        coreCount: 4,
        runnableUnavailable: { reason: "not-reported" },
        topProcesses: [],
      },
    })

    expect(evaluateAlerts(withoutRunnable(1, BASE_TIME_MS), thresholds, state)).toEqual([])
    const second = evaluateAlerts(withoutRunnable(2, BASE_TIME_MS + 10_000), thresholds, state)
    expect(kinds(second)).toEqual(["disk:warning"])
    expect(second[0]!.message).toContain("PARTIALLY BLIND")
    expect(second[0]!.message).toContain("reason `not-reported`")
    expect(second[0]!.message).toContain("Disk and memory ARE still being evaluated")
    expect(state.scalarBlindCause).toEqual({ kind: "runnable", reason: "not-reported" })
    // Held, not repeated — and load alone never pages a canonical observation.
    for (let sample = 3; sample < 10; sample += 1) {
      expect(evaluateAlerts(withoutRunnable(sample, BASE_TIME_MS + (sample - 1) * 10_000), thresholds, state)).toEqual(
        [],
      )
    }
    // The clearing edge is a fact that carries `runnable`.
    evaluateAlerts(canonical(10, BASE_TIME_MS + 90_000, 1, 1), thresholds, state)
    expect(state.scalarBlindSamples).toBe(0)
    expect(state.firedAlerts.has("disk:blind")).toBe(false)
    expect(state.scalarBlindCause).toBeUndefined()
  })

  test("30382 AC4: a standalone daemon keeps the load-only rule — no runnable, no AND", () => {
    const thresholds = defaultThresholds()
    const state = createAlertState()
    expect(evaluateAlerts(metrics(9, BASE_TIME_MS), thresholds, state)).toEqual([])
    expect(evaluateAlerts(metrics(9, BASE_TIME_MS + 10_000), thresholds, state)).toEqual([])
    const fired = evaluateAlerts(metrics(9, BASE_TIME_MS + 20_000), thresholds, state)
    expect(kinds(fired)).toEqual(["cpu:critical"])
    expect(fired[0]!.message).toContain("for 30s")
    expect(state.cpuWindow).toHaveLength(0)
  })

  test("process-source unavailability does not clear a live process-count episode", () => {
    const thresholds = { ...defaultThresholds(), processCountWarning: 1 }
    const state = createAlertState()
    const high: HealthMetrics = { ...metrics(0, BASE_TIME_MS), bunProcesses: 2 }
    const unavailable: HealthMetrics = {
      ...metrics(0, BASE_TIME_MS + 10_000),
      bunProcesses: undefined,
      processObservation: {
        diagnostic: {
          excluded: ["standalone-os-resample", "cross-batch-attribution", "implicit-unowned"],
          location: "/hab/habmod",
          query: "latest exact process census with owner attribution",
        },
        kind: "canonical-unavailable",
        reason: "process-fact-stale",
      },
    }

    expect(evaluateAlerts(high, thresholds, state)).toEqual([
      expect.objectContaining({ severity: "warning", type: "process-count" }),
    ])
    expect(evaluateAlerts(unavailable, thresholds, state)).toEqual([])
    expect(evaluateAlerts({ ...high, timestamp: BASE_TIME_MS + 20_000 }, thresholds, state)).toEqual([])
  })
})
