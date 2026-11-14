/**
 * @failure The daemon's health:cpu page has no pressure gate at all: it fires on load against
 *          cores, and a fleet that merely keeps 32 cores busy (load 82.97 against 40 runnable)
 *          pages as if the host were starving. Read as "CPU PSI full is 0.00", which at the root
 *          of a cgroup hierarchy is zero by definition — the reading that cannot support the
 *          conclusion drawn from it. `@i/4-supervision/27335/34311`.
 * @level   l1 — the exported parser and reader, with the path injected. The contract under test is
 *          that a malformed or absent reading is named, never turned into a zero.
 * @consumer @chief, who reads health:cpu alerts for runtime health.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { parseCpuPressure, readCpuPressure } from "./cpu-pressure"

const REAL_BODY = "some avg10=6.54 avg60=4.93 avg300=7.67 total=1234\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"
const scratch = mkdtempSync(join(tmpdir(), "cpu-pressure-test-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe("parseCpuPressure", () => {
  it("reads some avg60 as the percentage the kernel reported", () => {
    expect(parseCpuPressure(REAL_BODY)).toEqual({ kind: "measured", someAvg60Percent: 4.93 })
  })

  it("accepts a whole-number average", () => {
    expect(parseCpuPressure("some avg10=0.00 avg60=61 avg300=0.00 total=0\n")).toEqual({
      kind: "measured",
      someAvg60Percent: 61,
    })
  })

  it("names a body with no some line instead of reading zero", () => {
    const reading = parseCpuPressure("full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n", "/proc/pressure/cpu")
    expect(reading.kind).toBe("unreadable")
    expect(reading.kind === "unreadable" && reading.detail).toContain('no "some" line')
  })

  it("names an empty body instead of reading zero", () => {
    const reading = parseCpuPressure("")
    expect(reading.kind).toBe("unreadable")
    expect(reading.kind === "unreadable" && reading.detail).toContain("empty")
  })

  it("names a some line with no avg60 field", () => {
    const reading = parseCpuPressure("some avg10=0.00 avg300=0.00 total=0\n")
    expect(reading.kind).toBe("unreadable")
    expect(reading.kind === "unreadable" && reading.detail).toContain("no avg60 field")
  })

  it("refuses an average outside 0..100 instead of clamping it", () => {
    const reading = parseCpuPressure("some avg10=0.00 avg60=150.00 avg300=0.00 total=0\n")
    expect(reading.kind).toBe("unreadable")
    expect(reading.kind === "unreadable" && reading.detail).toContain("is not a percentage")
  })
})

describe("readCpuPressure", () => {
  it("reads a real file through the same parse", () => {
    const path = join(scratch, "cpu")
    writeFileSync(path, REAL_BODY)
    expect(readCpuPressure(path)).toEqual({ kind: "measured", someAvg60Percent: 4.93 })
  })

  it("calls a missing file absent — a platform limit, not an outage", () => {
    const reading = readCpuPressure(join(scratch, "does-not-exist"))
    expect(reading.kind).toBe("absent")
    expect(reading.kind === "absent" && reading.detail).toContain("does not exist")
  })

  it("calls an unreadable path unreadable, naming the errno", () => {
    const path = join(scratch, "a-directory")
    mkdirSync(path, { recursive: true })
    const reading = readCpuPressure(path)
    expect(reading.kind).toBe("unreadable")
    expect(reading.kind === "unreadable" && reading.detail).toContain("EISDIR")
  })
})
