import { describe, expect, test } from "vitest"
import {
  createAlertState,
  checkChiefSilent,
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
    worktrees: 0,
    timestamp,
  }
}

describe("health alert delivery", () => {
  test("chief-silent recovery directs the canonical attention projection instead of a sender-filtered snapshot", () => {
    const alert = checkChiefSilent(
      { count: 2, oldestTs: BASE_TIME_MS - 10 * 60_000 },
      true,
      createAlertState(),
      { ...defaultThresholds(), chiefSilentMinUnreadAgeMin: 1 },
      BASE_TIME_MS,
    )

    expect(alert?.message).toContain("tribe.fetch({limit:10})")
    expect(alert?.message).toContain("attention.actionable_unread")
    expect(alert?.message).toContain("attention.pending_balls")
    expect(alert?.message).not.toContain('from:"@agent/*"')
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
})
