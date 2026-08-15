import { describe, expect, test } from "vitest"
import {
  deriveProcessMetricsFromSnapshot,
  formatHealthAlertForDelivery,
  type HealthAlert,
} from "./health-monitor-plugin.ts"

const PROCESS_SNAPSHOT = `
  PID  PPID  PGID  %CPU %MEM COMMAND
  100     1   100    0.2  0.1 bun tribe-daemon.ts
  101   100   100    0.0  0.0 bun stdio-adapter --name @fleet
  102   100   100   98.0  0.0 ps -axo pid=,ppid=,pgid=,%cpu=,%mem=,command=
  103   102   103   87.0  0.0 sh -c lsof -n | wc -l
  200     1   200    0.4  0.2 codex --name @agent/9
  201   200   200   72.5  0.3 bun vitest run packages/daemon
  202   200   200    0.0  0.0 bun stdio-adapter --name @agent/9
  300     1   300    0.2  0.2 codex --name @agent/6
  301   300   300    0.0  0.0 bun stdio-adapter --name @agent/6
`

function cpuWarning(topOffenders: HealthAlert["topOffenders"]): HealthAlert {
  return {
    type: "cpu",
    severity: "warning",
    message: "CPU warning: probe-heavy sample",
    metrics: {},
    topOffenders,
  }
}

describe("health monitor process attribution", () => {
  test("a probe-heavy scan excludes the supervisor process group and does not blame quiet seats", () => {
    const processMetrics = deriveProcessMetricsFromSnapshot(PROCESS_SNAPSHOT, 100)

    expect(processMetrics.topProcesses.map((process) => process.pid)).toEqual([201])
    expect(processMetrics.pidToParent.get(201)).toBe(200)
    expect(processMetrics.pidToParent.get(103)).toBe(102)

    const formatted = formatHealthAlertForDelivery(
      cpuWarning(processMetrics.topProcesses),
      processMetrics.pidToParent,
      [
        { name: "@fleet", pid: 101, role: "member" },
        { name: "@agent/9", pid: 202, role: "member" },
        { name: "@agent/6", pid: 301, role: "member" },
      ],
    )

    expect(formatted.message).toContain("@agent/9")
    expect(formatted.message).toContain("pid=201")
    expect(formatted.message).toContain("argv=bun vitest run packages/daemon")
    expect(formatted.message).not.toContain("@fleet")
    expect(formatted.message).not.toContain("@agent/6")
    expect(formatted.attributedSessions).toEqual(new Set(["@agent/9"]))
    expect(formatted.hasUnattributed).toBe(false)
  })

  test("an unattributed offender is still named by pid and argv", () => {
    const processMetrics = deriveProcessMetricsFromSnapshot(PROCESS_SNAPSHOT, 100)
    const formatted = formatHealthAlertForDelivery(
      cpuWarning([{ pid: 900, cpu: 51, mem: 0.1, command: "mds_stores --worker" }]),
      processMetrics.pidToParent,
      [],
    )

    expect(formatted.message).toContain("unattributed")
    expect(formatted.message).toContain("pid=900")
    expect(formatted.message).toContain("argv=mds_stores --worker")
    expect(formatted.attributedSessions).toEqual(new Set())
    expect(formatted.hasUnattributed).toBe(true)
  })

  test("a quiet fleet with only hot supervisor probes reports no external offender", () => {
    const processMetrics = deriveProcessMetricsFromSnapshot(
      PROCESS_SNAPSHOT.replace("  201   200   200   72.5", "  201   200   200    0.5"),
      100,
    )
    const formatted = formatHealthAlertForDelivery(
      cpuWarning(processMetrics.topProcesses),
      processMetrics.pidToParent,
      [
        { name: "@fleet", pid: 101, role: "member" },
        { name: "@agent/9", pid: 202, role: "member" },
        { name: "@agent/6", pid: 301, role: "member" },
      ],
    )

    expect(formatted.message).toContain("offenders=none above 3% after supervisor exclusion")
    expect(formatted.message).not.toContain("@fleet")
    expect(formatted.message).not.toContain("@agent/9")
    expect(formatted.message).not.toContain("@agent/6")
    expect(formatted.attributedSessions).toEqual(new Set())
    expect(formatted.hasUnattributed).toBe(false)
  })
})
