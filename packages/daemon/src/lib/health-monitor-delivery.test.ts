import { describe, expect, test } from "vitest"
import {
  createAlertState,
  defaultThresholds,
  deliverHealthAlert,
  evaluateAlerts,
  measureCpuWindow,
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
    boot?: string,
  ): HealthMetrics => ({
    ...metrics(load, at),
    cpu: { loadAvg1m: load, loadAvg5m: load, coreCount: 4, runnableTasks, topProcesses: [] },
    scalarObservation: {
      // 30427: `boot` is the validated oomKill boot id; without one the observation's boot is unproved.
      boot: boot === undefined ? { kind: "unproved", reason: "oomKill absent" } : { id: boot, kind: "proved" },
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
    expect(state.cpuWindow, "the earlier credit is retained across the gap, not reset by it").toHaveLength(5)
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
    // A restarted producer: new epoch, sequence back at 1. Without the reset this sample would page (30 s). Neither
    // side carries a boot proof (30427), so the reset stands.
    expect(evaluateAlerts(canonical(1, BASE_TIME_MS + 30_000, 9, 7, "host-b"), thresholds, state)).toEqual([])
    expect(state.cpuWindow).toHaveLength(1)
  })

  test("30427: a sampler replacement on the same proven boot carries the window; the crossing itself is excluded", () => {
    const thresholds = { ...defaultThresholds(), cpuQualifyingMs: 30_000 }
    const state = createAlertState()
    // 20 s of critical credit under sampler host-a, every fact proving kernel boot "boot-1".
    expect(evaluateAlerts(canonical(1, BASE_TIME_MS, 9, 7, "host-a", "boot-1"), thresholds, state)).toEqual([])
    expect(evaluateAlerts(canonical(2, BASE_TIME_MS + 10_000, 9, 7, "host-a", "boot-1"), thresholds, state)).toEqual([])
    expect(evaluateAlerts(canonical(3, BASE_TIME_MS + 20_000, 9, 7, "host-a", "boot-1"), thresholds, state)).toEqual([])
    // The sampler is replaced 10 s later: new epoch, sequence back at 1, the same kernel boot. The credit is carried
    // but the 10 s crossing is excluded — were it credited, this sample would page at 30 s.
    expect(evaluateAlerts(canonical(1, BASE_TIME_MS + 30_000, 9, 7, "host-b", "boot-1"), thresholds, state)).toEqual([])
    expect(state.cpuWindow).toHaveLength(4)
    expect(state.cpuWindow[3]).toMatchObject({ crossing: true, epoch: "host-b", sequence: 1 })
    // The next qualifying observation pages on 30 s (20 s before + 10 s after the replacement) and the page names the
    // excluded crossing: the exclusion holds on this later measurement as well.
    const fired = evaluateAlerts(canonical(2, BASE_TIME_MS + 40_000, 9, 7, "host-b", "boot-1"), thresholds, state)
    expect(kinds(fired)).toEqual(["cpu:critical"])
    expect(fired[0]!.message).toContain(
      "for 30s of the last 180s observed (5 observations covering 30s; 1 sampler replacement(s) totalling 10s excluded)",
    )
  })

  test("30427: carried credit still needs the current observation to qualify, and pages on the next one that does", () => {
    // Accrue 40 s of critical credit under a 45 s threshold: nothing fires, so neither dedupe nor cooldown is armed.
    const accrue = { ...defaultThresholds(), cpuQualifyingMs: 45_000 }
    const state = createAlertState()
    for (let sample = 0; sample < 5; sample += 1) {
      expect(
        evaluateAlerts(canonical(sample + 1, BASE_TIME_MS + sample * 10_000, 9, 7, "host-a", "boot-1"), accrue, state),
      ).toEqual([])
    }
    // Carried across the replacement at 50 s with the crossing excluded: still 40 s, still nothing fired.
    expect(evaluateAlerts(canonical(1, BASE_TIME_MS + 50_000, 9, 7, "host-b", "boot-1"), accrue, state)).toEqual([])
    expect(state.cpuWindow[5]).toMatchObject({ crossing: true, epoch: "host-b" })
    // Judge what follows against a 30 s threshold (thresholds are a per-call input), so the retained 40 s sits ABOVE
    // qualification while no page has ever fired: nothing but the current-observation predicate can hold a page back.
    const judge = { ...defaultThresholds(), cpuQualifyingMs: 30_000 }
    const retained = measureCpuWindow(state.cpuWindow, BASE_TIME_MS + 60_000, judge.cpuWindowMs, judge.cpuGapMs)
    expect(retained).toMatchObject({ criticalMs: 40_000, crossings: 1, crossingMs: 10_000 })
    expect(retained.criticalMs).toBeGreaterThanOrEqual(judge.cpuQualifyingMs)
    expect(state.firedAlerts.size, "no dedupe entry can explain a held page").toBe(0)
    expect(state.firedAt.size, "no cooldown can explain a held page").toBe(0)
    // A drained queue on the new sampler: retained credit above the line, current observation not qualifying, no page.
    expect(evaluateAlerts(canonical(2, BASE_TIME_MS + 60_000, 9, 2, "host-b", "boot-1"), judge, state)).toEqual([])
    expect(state.firedAlerts.size).toBe(0)
    expect(state.firedAt.size).toBe(0)
    // The next qualifying observation pages on the retained credit alone — its own interval is uncredited because the
    // observation before it did not qualify — and the page still names the excluded replacement.
    const fired = evaluateAlerts(canonical(3, BASE_TIME_MS + 70_000, 9, 7, "host-b", "boot-1"), judge, state)
    expect(kinds(fired)).toEqual(["cpu:critical"])
    expect(fired[0]!.message).toContain(
      "for 40s of the last 180s observed (8 observations covering 60s; 1 sampler replacement(s) totalling 10s excluded)",
    )
  })

  /**
   * 30427 reset rows. Each first accrues 30 s of critical credit under sampler host-a with a proven boot — the page
   * proves the credit is real — then replaces the sampler and reads the window: 1 sample is a reset, 5 is a carry.
   */
  const accrueAndPage = (
    state: ReturnType<typeof createAlertState>,
    thresholds: ReturnType<typeof defaultThresholds>,
    boot?: string,
  ) => {
    for (let sample = 0; sample < 3; sample += 1) {
      expect(
        evaluateAlerts(canonical(sample + 1, BASE_TIME_MS + sample * 10_000, 9, 7, "host-a", boot), thresholds, state),
      ).toEqual([])
    }
    expect(kinds(evaluateAlerts(canonical(4, BASE_TIME_MS + 30_000, 9, 7, "host-a", boot), thresholds, state))).toEqual(
      ["cpu:critical"],
    )
    expect(state.cpuWindow).toHaveLength(4)
  }

  test("30427: a changed kernel boot resets the window even across a 1 s gap", () => {
    const thresholds = { ...defaultThresholds(), cpuQualifyingMs: 30_000 }
    const state = createAlertState()
    accrueAndPage(state, thresholds, "boot-1")
    expect(evaluateAlerts(canonical(1, BASE_TIME_MS + 31_000, 9, 7, "host-b", "boot-2"), thresholds, state)).toEqual([])
    expect(state.cpuWindow).toHaveLength(1)
    expect(state.cpuWindow[0]).toMatchObject({ boot: "boot-2", crossing: false, epoch: "host-b" })
  })

  test("30427: an unproved boot on either side of the replacement keeps the reset", () => {
    const thresholds = { ...defaultThresholds(), cpuQualifyingMs: 30_000 }
    // History proved, the new sampler's boot unproved (a producer that predates oomKill, or darwin).
    const proved = createAlertState()
    accrueAndPage(proved, thresholds, "boot-1")
    expect(evaluateAlerts(canonical(1, BASE_TIME_MS + 40_000, 9, 7, "host-b"), thresholds, proved)).toEqual([])
    expect(proved.cpuWindow).toHaveLength(1)
    // History unproved, the new sampler's boot proved: nothing to compare against, so the reset stands too.
    const unproved = createAlertState()
    accrueAndPage(unproved, thresholds)
    expect(evaluateAlerts(canonical(1, BASE_TIME_MS + 40_000, 9, 7, "host-b", "boot-1"), thresholds, unproved)).toEqual(
      [],
    )
    expect(unproved.cpuWindow).toHaveLength(1)
  })

  test("30427: a matched boot is carried at exactly the gap bound and reset one millisecond past it", () => {
    const thresholds = { ...defaultThresholds(), cpuQualifyingMs: 30_000 }
    expect(thresholds.cpuGapMs).toBe(15_000)
    const atBound = createAlertState()
    accrueAndPage(atBound, thresholds, "boot-1")
    expect(evaluateAlerts(canonical(1, BASE_TIME_MS + 45_000, 9, 7, "host-b", "boot-1"), thresholds, atBound)).toEqual(
      [],
    )
    expect(atBound.cpuWindow).toHaveLength(5)
    expect(atBound.cpuWindow[4]).toMatchObject({ crossing: true })
    const pastBound = createAlertState()
    accrueAndPage(pastBound, thresholds, "boot-1")
    expect(
      evaluateAlerts(canonical(1, BASE_TIME_MS + 45_001, 9, 7, "host-b", "boot-1"), thresholds, pastBound),
    ).toEqual([])
    expect(pastBound.cpuWindow).toHaveLength(1)
  })

  test("30427: a matched boot never carries across a rewound clock, and same-epoch rewinds still reset", () => {
    const thresholds = { ...defaultThresholds(), cpuQualifyingMs: 30_000 }
    // The replacement's first fact is stamped before the old sampler's last one: a clock rewind, no carry.
    const rewoundAcross = createAlertState()
    accrueAndPage(rewoundAcross, thresholds, "boot-1")
    expect(
      evaluateAlerts(canonical(1, BASE_TIME_MS + 29_000, 9, 7, "host-b", "boot-1"), thresholds, rewoundAcross),
    ).toEqual([])
    expect(rewoundAcross.cpuWindow).toHaveLength(1)
    // Same epoch, sequence rewound (30382 rule, row added here): reset.
    const sequenceRewind = createAlertState()
    accrueAndPage(sequenceRewind, thresholds, "boot-1")
    expect(
      evaluateAlerts(canonical(2, BASE_TIME_MS + 40_000, 9, 7, "host-a", "boot-1"), thresholds, sequenceRewind),
    ).toEqual([])
    expect(sequenceRewind.cpuWindow).toHaveLength(1)
    // Same epoch, clock rewound (30382 rule, row added here): reset.
    const clockRewind = createAlertState()
    accrueAndPage(clockRewind, thresholds, "boot-1")
    expect(
      evaluateAlerts(canonical(5, BASE_TIME_MS + 29_000, 9, 7, "host-a", "boot-1"), thresholds, clockRewind),
    ).toEqual([])
    expect(clockRewind.cpuWindow).toHaveLength(1)
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
