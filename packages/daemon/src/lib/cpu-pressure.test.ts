/**
 * @failure The daemon's health:cpu page has no pressure gate at all: it fires on load against
 *          cores, and a fleet that merely keeps 32 cores busy (load 82.97 against 40 runnable)
 *          pages as if the host were starving. Read as "CPU PSI full is 0.00", which at the root
 *          of a cgroup hierarchy is zero by definition — the reading that cannot support the
 *          conclusion drawn from it. `@i/4-supervision/27335/34311`.
 * @level   l1 — the pure interpreter of the canonical host:scalars pressure metric, driven from
 *          fixed lists. The contract under test is that every absence and every malformed value is
 *          named, never turned into a zero, and that no host is read here.
 * @consumer @chief, who reads health:cpu alerts for runtime health.
 */
import { describe, expect, it } from "vitest"
import { cpuPressureReading } from "./cpu-pressure"

const measured = (cpuSomeAvg60Percent: number) =>
  ({ kind: "supported", value: { cpuSomeAvg60Percent } }) as const

describe("cpuPressureReading", () => {
  it("passes through the percentage the host:scalars fact reported", () => {
    expect(cpuPressureReading(measured(2.55))).toEqual({ kind: "measured", someAvg60Percent: 2.55 })
  })

  it("accepts the boundary values 0 and 100", () => {
    expect(cpuPressureReading(measured(0))).toEqual({ kind: "measured", someAvg60Percent: 0 })
    expect(cpuPressureReading(measured(100))).toEqual({ kind: "measured", someAvg60Percent: 100 })
  })

  it("refuses a number outside 0..100 instead of clamping it", () => {
    for (const value of [-1, 100.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const reading = cpuPressureReading(measured(value))
      expect(reading.kind).toBe("unreadable")
      expect(reading.kind === "unreadable" && reading.detail).toContain("is not a percentage")
    }
  })

  it("calls an absent metric a platform limit and keeps the producer's reason", () => {
    expect(cpuPressureReading(undefined)).toEqual({
      kind: "absent",
      detail: "the host:scalars fact carries no pressure metric, so this host reports no CPU pressure",
    })
    expect(
      cpuPressureReading({
        kind: "unavailable",
        metric: "pressure",
        reason: "not-reported",
        detail: "/proc/pressure/cpu: ENOENT",
      }),
    ).toEqual({ kind: "absent", detail: "not-reported: /proc/pressure/cpu: ENOENT" })
    expect(cpuPressureReading({ kind: "unavailable", metric: "pressure", reason: "unsupported-on-platform" })).toEqual({
      kind: "absent",
      detail: "unsupported-on-platform",
    })
  })

  it("calls a failed read unreadable, naming the producer's reason", () => {
    for (const reason of ["access-denied", "provider-error", "source-protocol-invalid"]) {
      const reading = cpuPressureReading({ kind: "unavailable", metric: "pressure", reason, detail: "/proc/pressure/cpu" })
      expect(reading.kind).toBe("unreadable")
      expect(reading.kind === "unreadable" && reading.detail).toContain(`${reason}: /proc/pressure/cpu`)
    }
  })
})
