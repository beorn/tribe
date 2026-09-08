/**
 * @failure The fd alarm counted `lsof -n | wc -l` LINES as open descriptors and
 *          divided them by `ulimit -n`, a PER-PROCESS limit. It broadcast
 *          "725140 open fds (138% of 524288 limit)" to a fleet whose kernel held
 *          6,825 file handles — two orders out, flapping with thread count, and
 *          read by two seats while they held live admissions.
 * @level   l2 for the threshold arms — the real exported `evaluateAlerts` with
 *          the real `createAlertState` and `defaultThresholds`, because the
 *          contract is what the production evaluator EMITS. l1 for the parsers.
 * @consumer every seat that trusts the host-health broadcast, and @chief, who
 *           reads it for runtime health.
 *
 * Tracked: @ag/tribe/24297.
 */

import { describe, expect, it } from "vitest"

import {
  createAlertState,
  defaultThresholds,
  evaluateAlerts,
  parseFileMax,
  parseFileNr,
  resolveFdReading,
  type HealthMetrics,
} from "./health-monitor-plugin.ts"

/** Exactly what this host's /proc/sys/fs/file-nr printed while the false alarm
 *  was live: allocated, free, max — and only the FIRST field is the count. */
const FILE_NR = "6825\t0\t9223372036854775807\n"
const FILE_MAX = "9223372036854775807\n"

function metrics(fdCount?: HealthMetrics["fdCount"]): HealthMetrics {
  return {
    cpu: { topProcesses: [] },
    processObservation: { kind: "standalone-os" },
    scalarObservation: { kind: "standalone-os", unavailable: ["disk.bytes", "disk.inodes"] },
    timestamp: Date.now(),
    worktrees: 0,
    ...(fdCount === undefined ? {} : { fdCount }),
  }
}

describe("24297 — the fd reading is host-wide on both sides, or it is not a reading", () => {
  it("takes the ALLOCATED field from file-nr, never the ceiling sitting beside it", () => {
    // The three fields are allocated, free, max. Taking the wrong one here is
    // how a count becomes astronomically large without anything looking broken.
    expect(parseFileNr(FILE_NR)).toBe(6825)
    expect(parseFileMax(FILE_MAX)).toBe(9223372036854775807)
  })

  it("pairs a host-wide count with a host-wide ceiling and says which", () => {
    const reading = resolveFdReading({ fileNr: FILE_NR, fileMax: FILE_MAX })

    expect(reading.kind).toBe("measured")
    if (reading.kind !== "measured") return
    expect(reading.total).toBe(6825)
    // The basis is on the reading so a consumer can tell a host-wide number
    // from a per-process one without reading this file.
    expect(reading.basis).toBe("linux-file-nr-vs-file-max")
  })

  it("reports NOT MEASURED rather than a value when neither source is readable", () => {
    const reading = resolveFdReading({})

    expect(reading.kind).toBe("not-measured")
    if (reading.kind !== "not-measured") return
    // The reason must name what it needed. "Unavailable" alone sends the reader
    // looking for a broken sensor rather than an absent interface.
    expect(reading.reason).toContain("/proc/sys/fs/file-nr")
    expect(reading.reason).toContain("file-max")
  })

  it("does not invent a number from unparseable input", () => {
    expect(resolveFdReading({ fileNr: "not a number", fileMax: FILE_MAX }).kind).toBe("not-measured")
    expect(resolveFdReading({ fileNr: FILE_NR, fileMax: "0" }).kind).toBe("not-measured")
    // Half a pair is not a reading: a count with no ceiling has no percentage.
    expect(resolveFdReading({ fileNr: FILE_NR }).kind).toBe("not-measured")
  })
})

describe("24297 — the alarm fires on pressure and not on arithmetic", () => {
  it("does NOT warn at this host's real numbers", () => {
    const reading = resolveFdReading({ fileNr: FILE_NR, fileMax: FILE_MAX })
    if (reading.kind !== "measured") throw new Error("fixture must produce a reading")

    const alerts = evaluateAlerts(
      metrics({ total: reading.total, perSession: [], limit: reading.limit, basis: reading.basis }),
      defaultThresholds(),
      createAlertState(),
    )

    // 6,825 against an effectively unbounded ceiling. The predecessor called
    // this same host 138% consumed.
    expect(alerts.filter((alert) => alert.type === "fd-count")).toHaveLength(0)
  })

  it("STILL warns when the host really is running out — the control", () => {
    // Without this the arm above would pass just as well if fd alerting were
    // deleted outright, which is not the fix.
    const alerts = evaluateAlerts(
      metrics({ total: 900_000, perSession: [], limit: 1_000_000, basis: "linux-file-nr-vs-file-max" }),
      defaultThresholds(),
      createAlertState(),
    )

    const fd = alerts.filter((alert) => alert.type === "fd-count")
    expect(fd).toHaveLength(1)
    expect(fd[0]?.message).toContain("90%")
    // The message carries the basis, so a reader is never left guessing whether
    // a percentage is per-process or host-wide.
    expect(fd[0]?.message).toContain("linux-file-nr-vs-file-max")
  })
})

describe("24297 — the BLIND notice speaks only for sensors it reads", () => {
  it("no longer claims fd-count is silenced by the scalar outage", () => {
    const blind: HealthMetrics = {
      cpu: { topProcesses: [] },
      processObservation: { kind: "standalone-os" },
      scalarObservation: { kind: "canonical-unavailable", reason: "scalar-fact-unavailable" },
      timestamp: Date.now(),
      worktrees: 0,
    }

    const state = createAlertState()
    // The notice fires only after consecutive blind samples, so drive it.
    let messages: string[] = []
    for (let sample = 0; sample < 6; sample += 1) {
      messages = messages.concat(evaluateAlerts(blind, defaultThresholds(), state).map((alert) => alert.message))
    }
    const notice = messages.find((message) => message.includes("Host scalar monitoring is BLIND"))
    expect(notice, "the blind notice must still fire — this arm is not about silencing it").toBeDefined()

    // The old text said "disk, memory, cpu and fd-count are all silent for this
    // ONE reason". fd-count reads /proc/sys/fs directly and fired eighteen
    // minutes after that notice, which is the opposite of silent.
    expect(notice).not.toContain("fd-count are all silent")
    expect(notice).toContain("fd-count is NOT among them")
  })
})
