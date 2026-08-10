import { describe, expect, test } from "vitest"
import {
  createAlertState,
  checkChiefAbsent,
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
    worktrees: 0,
    timestamp,
  }
}

describe("health alert delivery", () => {
  test("absent chief with actionable unread escalates immediately to a live authority", () => {
    const state = createAlertState()
    const check = (chiefOnline: boolean) => checkChiefAbsent({ count: 1, oldestTs: BASE_TIME_MS }, chiefOnline, state)

    expect(check(false)).toMatchObject({
      type: "chief-absent",
      severity: "critical",
      message: expect.stringMatching(/@chief is absent.*live @cto or @fleet.*user/iu),
    })
    expect(check(false)).toBeNull()
    expect(check(true)).toBeNull()
    expect(check(false)?.type).toBe("chief-absent")
  })

  test("online chief inbox staleness is delegated to the generic WATCH fact consumer", () => {
    const state = createAlertState()
    expect(checkChiefAbsent({ count: 2, oldestTs: BASE_TIME_MS - 10 * 60_000 }, true, state)).toBeNull()
    expect(state.firedAlerts.has("chief-silent:warning")).toBe(false)
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

  test("broadcasts one operator diagnostic when an attributed warning has no live recipient", () => {
    const broadcasts: string[] = []
    const sends: string[] = []
    const api = {
      broadcast: (message: string) => broadcasts.push(message),
      getActiveSessions: () => [],
      send: (recipient: string) => sends.push(recipient),
    } as unknown as TribeClientApi

    expect(
      deliverHealthAlert(
        api,
        { type: "cpu", severity: "warning" },
        "CPU warning sample",
        new Set(["yrd-runner"]),
        false,
        [],
      ),
    ).toEqual({ kind: "broadcast" })

    expect(sends).toEqual([])
    expect(broadcasts).toEqual([
      "CPU warning sample. routing diagnostic: attributed owner(s) are not live Tribe recipients: yrd-runner",
    ])
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

  test("counts one canonical scalar fact once toward a sustained alert", () => {
    const thresholds = { ...defaultThresholds(), cpuCriticalMultiplier: 2, sustainedSamples: 2 }
    const state = createAlertState()
    const canonical = (sequence: number, timestamp: number): HealthMetrics => ({
      ...metrics(9, timestamp),
      scalarObservation: {
        kind: "canonical-available",
        observedAt: timestamp,
        source: { epoch: "host-a", sequence },
        unavailable: [],
      },
    })

    const first = canonical(1, BASE_TIME_MS)
    expect(evaluateAlerts(first, thresholds, state)).toEqual([])
    expect(evaluateAlerts(first, thresholds, state)).toEqual([])
    expect(evaluateAlerts(canonical(2, BASE_TIME_MS + 20_000), thresholds, state)).toEqual([
      expect.objectContaining({ severity: "critical", type: "cpu" }),
    ])
  })

  test("an unavailable scalar fact breaks a sustained sequence without inventing healthy values", () => {
    const thresholds = { ...defaultThresholds(), cpuCriticalMultiplier: 2, sustainedSamples: 2 }
    const state = createAlertState()
    const high = (sequence: number, timestamp: number): HealthMetrics => ({
      ...metrics(9, timestamp),
      scalarObservation: {
        kind: "canonical-available",
        observedAt: timestamp,
        source: { epoch: "host-a", sequence },
        unavailable: [],
      },
    })
    const unavailable: HealthMetrics = {
      ...metrics(0, BASE_TIME_MS + 10_000),
      cpu: { topProcesses: [] },
      memory: undefined,
      scalarObservation: { kind: "canonical-unavailable", reason: "scalar-fact-stale" },
    }

    expect(evaluateAlerts(high(1, BASE_TIME_MS), thresholds, state)).toEqual([])
    expect(evaluateAlerts(unavailable, thresholds, state)).toEqual([])
    expect(evaluateAlerts(high(2, BASE_TIME_MS + 20_000), thresholds, state)).toEqual([])
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
