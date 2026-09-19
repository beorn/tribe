import { describe, expect, test, vi } from "vitest"
import { BoundedProcessCommandError } from "../../../recall/src/lib/bounded-process.ts"
import {
  createAlertState,
  formatCollectedHealthAlert,
  recordAttributionBlindness,
  type HealthAlert,
} from "./health-monitor-plugin.ts"
import { createHealthProcessSource, SYSMON_COMMAND_TIMEOUT_MS } from "./health-process-source.ts"

// The incident a reader actually receives when the census could not attribute.
// @i/1-instruments/24962: today it reports a DESIGNED bound as an unexplained
// absence, and leaves the reader without a next move.

const EXCLUDED = ["standalone-os-resample", "cross-batch-attribution", "implicit-unowned"] as const
const SESSION_DIR = "/hh/main.hab/run/sessions"

function cpuCritical(): Pick<HealthAlert, "type" | "message" | "topOffenders"> {
  return { type: "cpu", message: "CPU critical: load 49.62", topOffenders: [] }
}

function unavailableObservation(reason: string) {
  return {
    diagnostic: {
      excluded: EXCLUDED,
      location: SESSION_DIR,
      query: "latest exact process census with owner attribution",
    },
    kind: "unavailable",
    reason,
    schema: "process-observation/1",
  } as const
}

function format(reason: string, consecutive = 1): string {
  return formatCollectedHealthAlert(
    cpuCritical(),
    unavailableObservation(reason) as never,
    new Map<number, number>(),
    [],
    consecutive,
  ).message
}

describe("an unattributable incident carries its own explanation", () => {
  test("a census timeout says the bound FIRED and that this is expected under load", () => {
    const message = format("source-command-timeout")

    // The bound is designed and its value is knowable; reporting it as a bare
    // reason string reads as an unexplained absence.
    expect(message).toContain("2.5s")
    expect(message).toMatch(/expected under load/i)
  })

  test("it names the manual command a reader runs instead, with the real state root", () => {
    const message = format("source-command-timeout")

    expect(message).toContain(`hab sysmon snapshot --state-root ${SESSION_DIR}`)
  })

  test("producer-to-formatter: unavailable location is the census state-root, not .../habmod", async () => {
    // Live bug: unavailable() recorded controllerSessionDir (.../sessions/habmod)
    // while the snapshot ran against dirname(that). The formatter then printed
    // `--state-root .../habmod`. Drive the producer, then the formatter.
    const controllerSessionDir = `${SESSION_DIR}/habmod`
    const runCommand = vi.fn(async () => {
      throw new BoundedProcessCommandError({
        kind: "timeout",
        message: `sysmon snapshot exceeded ${String(SYSMON_COMMAND_TIMEOUT_MS)}ms (killed)`,
        settlementFailures: [],
      })
    })
    const source = createHealthProcessSource({
      env: {
        HAB_SCALAR_JOURNAL_DIR: controllerSessionDir,
        HAB_SESSION_HABITAT_ROOT: "/hh/main.hab",
        HAB_SESSION_LAUNCH_ID: "70296c6b-21dd-41a9-8614-b6b6bff113e0",
      },
      runCommand,
    })
    expect(source.kind).toBe("managed")
    if (source.kind !== "managed") throw new Error("expected managed source")
    const observation = await source.read()
    expect(observation.kind).toBe("unavailable")
    if (observation.kind !== "unavailable") throw new Error("unreachable")
    expect(observation.diagnostic.location).toBe(SESSION_DIR)
    expect(observation.diagnostic.location).not.toBe(controllerSessionDir)
    expect(runCommand).toHaveBeenCalledWith(expect.arrayContaining(["--state-root", SESSION_DIR]))

    const message = formatCollectedHealthAlert(cpuCritical(), observation, new Map<number, number>(), [], 1).message
    expect(message).toContain(`hab sysmon snapshot --state-root ${SESSION_DIR}`)
    expect(message).not.toContain(`--state-root ${controllerSessionDir}`)
  })

  test("a reason that is NOT the bound must not claim the bound fired", () => {
    // Negative control. Without this, "the 2.5s bound fired" would be printed
    // for every unavailable reason, which is a louder lie than the silence it
    // replaces.
    const message = format("source-protocol-invalid")

    expect(message).not.toContain("2.5s")
    expect(message).not.toMatch(/expected under load/i)
    // but the reader still gets a next move
    expect(message).toContain(`hab sysmon snapshot --state-root ${SESSION_DIR}`)
  })

  test("it still carries the forensic fields it carried before", () => {
    const message = format("source-command-timeout")

    expect(message).toContain("CPU critical: load 49.62")
    expect(message).toContain("source-command-timeout")
    expect(message).toContain("latest exact process census with owner attribution")
    expect(message).toContain(SESSION_DIR)
    expect(message).toContain(EXCLUDED.join(","))
  })
})

describe("the monitor counts its own failure to attribute", () => {
  // The counting rule, not its rendering. Handing the formatter a number proves
  // the formatter; this drives the thing that produces the number.
  test("consecutive unavailable censuses advance the run", () => {
    const state = createAlertState()

    expect(recordAttributionBlindness(state, { kind: "unavailable" })).toBe(1)
    expect(recordAttributionBlindness(state, { kind: "unavailable" })).toBe(2)
    expect(recordAttributionBlindness(state, { kind: "unavailable" })).toBe(3)
    expect(recordAttributionBlindness(state, { kind: "unavailable" })).toBe(4)
    expect(state.attributionBlindSamples).toBe(4)
  })

  test("one successful census clears the run", () => {
    const state = createAlertState()

    recordAttributionBlindness(state, { kind: "unavailable" })
    recordAttributionBlindness(state, { kind: "unavailable" })
    expect(recordAttributionBlindness(state, { kind: "available" })).toBe(0)
    // and the next failure starts a NEW run rather than resuming the old one
    expect(recordAttributionBlindness(state, { kind: "unavailable" })).toBe(1)
  })

  test("a standalone-os census also clears the run", () => {
    const state = createAlertState()

    recordAttributionBlindness(state, { kind: "unavailable" })
    expect(recordAttributionBlindness(state, { kind: "standalone-os" })).toBe(0)
  })

  test("the fourth consecutive failure says so in the incident", () => {
    // The 2026-09-17 specimen: four for four, each reading as a separate event.
    expect(format("source-command-timeout", 4)).toContain("failed 4 consecutive samples")
  })

  test("a first failure does NOT claim a run", () => {
    // "failed 1 consecutive samples" is noise, and worse, it would make a
    // transient timeout look like a standing failure.
    const message = format("source-command-timeout", 1)

    expect(message).not.toMatch(/consecutive samples/)
  })
})
