import { describe, expect, test } from "vitest"
import { formatCollectedHealthAlert, type HealthAlert } from "./health-monitor-plugin.ts"

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

function format(reason: string): string {
  return formatCollectedHealthAlert(
    cpuCritical(),
    unavailableObservation(reason) as never,
    new Map<number, number>(),
    [],
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
