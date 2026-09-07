/**
 * @failure The disk branch cleared its own alerts and said NOTHING whenever the
 *          scalar lane produced no capacity, so a host with no scalar producer
 *          looked exactly like a host under no pressure. On 2026-09-07 a 61G
 *          RAM-backed tmpfs reached 86% — past the 85% warning threshold — and
 *          four seats lost their shells with no alert ever having been possible:
 *          `hab sysmon snapshot --kind scalars` returns
 *          `scalar-fact-unavailable`, meaning zero scalar facts exist, so
 *          `metrics.disk` is never populated and no threshold can fire.
 *          The monitor was not declining to warn. It could not see, and did not
 *          say so.
 * @consumer every seat that trusts the host-health broadcast, and @chief, who
 *           reads it for runtime health
 *
 * Drives the real exported `evaluateAlerts` with the real `createAlertState`
 * and `defaultThresholds` — the production evaluator, not a restatement of it.
 */

import { describe, expect, it } from "vitest"

import { createHealthProcessSource } from "./health-process-source.ts"
import {
  collectFullMetrics,
  createAlertState,
  defaultThresholds,
  evaluateAlerts,
  type HealthMetrics,
} from "./health-monitor-plugin.ts"

/**
 * Metrics with nothing the other branches alert on, and no disk — carrying the
 * REAL reason this host produces: `canonical-unavailable` /
 * `scalar-fact-unavailable`, which is what `hab sysmon snapshot --kind scalars`
 * returns when zero scalar facts exist.
 */
function blindMetrics(reason = "scalar-fact-unavailable"): HealthMetrics {
  return {
    cpu: { topProcesses: [] },
    // Inert here: `evaluateScalarMetrics` is derived from `scalarObservation`
    // alone, so the process lane cannot steer any assertion below. It is
    // present because `HealthMetrics` requires it.
    processObservation: { kind: "standalone-os" },
    scalarObservation: { kind: "canonical-unavailable", reason },
    timestamp: Date.now(),
    worktrees: 0,
  }
}

/**
 * A sample that carries scalar facts and NO disk number, because the platform
 * cannot report one. `standalone-os` names `disk.bytes` and `disk.inodes`
 * outright: it is not blind, it is honest. It reaches the same no-disk branch a
 * blind sample does, which is why recovering only through a sample that HAS a
 * disk number leaves this path untested.
 */
function platformLimitMetrics(): HealthMetrics {
  return {
    cpu: { topProcesses: [] },
    // Inert here: `evaluateScalarMetrics` is derived from `scalarObservation`
    // alone, so the process lane cannot steer any assertion below. It is
    // present because `HealthMetrics` requires it.
    processObservation: { kind: "standalone-os" },
    scalarObservation: { kind: "standalone-os", unavailable: ["disk.bytes", "disk.inodes"] },
    timestamp: Date.now(),
    worktrees: 0,
  }
}

/**
 * The same, with a disk reading comfortably under every threshold.
 *
 * `sequence` must differ per sample: `evaluateAlerts` skips the scalar branches
 * entirely when the observation identity is unchanged, so a fixture that reused
 * one sequence would test the skip rather than the reading.
 */
function seeingMetrics(usedFraction: number, sequence: number): HealthMetrics {
  const totalBytes = 4_096_000_000
  const usedBytes = Math.round(totalBytes * usedFraction)
  return {
    cpu: { topProcesses: [] },
    // Inert here: `evaluateScalarMetrics` is derived from `scalarObservation`
    // alone, so the process lane cannot steer any assertion below. It is
    // present because `HealthMetrics` requires it.
    processObservation: { kind: "standalone-os" },
    disk: {
      availableBytes: totalBytes - usedBytes,
      freeBytes: totalBytes - usedBytes,
      inodes: { kind: "unavailable", platform: "linux", reason: "not-reported" },
      path: "/tmp",
      totalBytes,
      usedBytes,
    } as unknown as NonNullable<HealthMetrics["disk"]>,
    scalarObservation: {
      kind: "canonical-available",
      observedAt: Date.now(),
      source: { epoch: "test-epoch", sequence },
      unavailable: [],
    },
    timestamp: Date.now(),
    worktrees: 0,
  }
}

const blindAlerts = (alerts: readonly { type: string; message: string }[]): readonly string[] =>
  alerts.filter((one) => one.message.includes("BLIND")).map((one) => one.message)

describe("a monitor that cannot measure the disk says so (@i/4-supervision/24233)", () => {
  it("announces blindness FROM BOOT, without ever having seen a scalar", () => {
    const state = createAlertState()
    const thresholds = defaultThresholds()

    // Today's failure mode is startup blindness, not a working-to-blind
    // transition: the daemon had never seen a scalar at any point.
    const first = evaluateAlerts(blindMetrics(), thresholds, state)
    const second = evaluateAlerts(blindMetrics(), thresholds, state)

    // One failed read is not an incident.
    expect(blindAlerts(first), "a single blind sample must not page").toEqual([])
    expect(blindAlerts(second)).toHaveLength(1)
    expect(blindAlerts(second)[0]).toContain("no scalar facts")
    // The message has to be actionable on its own: it names the command that
    // shows the cause and the reason string that identifies it.
    expect(blindAlerts(second)[0]).toContain("hab sysmon snapshot --kind scalars")
    expect(blindAlerts(second)[0]).toContain("scalar-fact-unavailable")
  })

  it("holds ONE live condition rather than paging every sample", () => {
    const state = createAlertState()
    const thresholds = defaultThresholds()

    const rounds = [1, 2, 3, 4, 5].map(() => blindAlerts(evaluateAlerts(blindMetrics(), thresholds, state)))

    // Sustained blindness is one standing condition, asserted once.
    expect(rounds.flat()).toHaveLength(1)
    expect(rounds[1]).toHaveLength(1)
    expect(rounds.slice(2).flat()).toEqual([])
  })

  it("clears the condition when scalars come back, and can assert it again after", () => {
    const state = createAlertState()
    const thresholds = defaultThresholds()

    evaluateAlerts(blindMetrics(), thresholds, state)
    evaluateAlerts(blindMetrics(), thresholds, state)
    expect(state.firedAlerts.has("disk:blind")).toBe(true)

    // A reading is the clearing edge.
    evaluateAlerts(seeingMetrics(0.1, 1), thresholds, state)
    expect(state.firedAlerts.has("disk:blind")).toBe(false)
    expect(state.scalarBlindSamples).toBe(0)

    // And the condition is re-assertable, so a second outage is not swallowed
    // by a dedupe entry left behind from the first.
    evaluateAlerts(blindMetrics(), thresholds, state)
    const again = blindAlerts(evaluateAlerts(blindMetrics(), thresholds, state))
    expect(again).toHaveLength(1)
  })

  it("says nothing about blindness while it can actually see", () => {
    const state = createAlertState()
    const thresholds = defaultThresholds()

    // The positive control: a working monitor must not start crying blind, or
    // the alert is noise and gets muted, which is how it goes silent again.
    const alerts = evaluateAlerts(seeingMetrics(0.1, 1), thresholds, state)

    expect(blindAlerts(alerts)).toEqual([])
    expect(state.firedAlerts.has("disk:blind")).toBe(false)
  })
})

describe("the condition clears without ever seeing a disk number (@i/4-supervision/24233)", () => {
  it("clears on an honest platform limit, and the NEXT outage still pages", () => {
    const state = createAlertState()
    const thresholds = defaultThresholds()

    evaluateAlerts(blindMetrics(), thresholds, state)
    evaluateAlerts(blindMetrics(), thresholds, state)
    expect(state.firedAlerts.has("disk:blind")).toBe(true)

    // Recovery through a sample with no disk value at all. Resetting only the
    // counter here would leave `disk:blind` latched in firedAlerts, and the
    // latch is invisible until a real outage is swallowed by it.
    evaluateAlerts(platformLimitMetrics(), thresholds, state)
    expect(state.firedAlerts.has("disk:blind"), "an honest platform limit is not blindness").toBe(false)
    expect(state.scalarBlindSamples).toBe(0)

    const again = blindAlerts(evaluateAlerts(blindMetrics(), thresholds, state)).concat(
      blindAlerts(evaluateAlerts(blindMetrics(), thresholds, state)),
    )
    expect(again, "a second outage must re-assert, not be eaten by the first one's dedupe").toHaveLength(1)
  })
})

describe("the diagnostic names the stage its reason actually means (@i/4-supervision/24233)", () => {
  const fire = (reason: string): string => {
    const state = createAlertState()
    const thresholds = defaultThresholds()
    evaluateAlerts(blindMetrics(reason), thresholds, state)
    const fired = blindAlerts(evaluateAlerts(blindMetrics(reason), thresholds, state))
    expect(fired).toHaveLength(1)
    return fired[0] ?? ""
  }

  it("hands over the DISCRIMINATING TEST instead of naming a cause it cannot know", () => {
    // RE-PINNED, not loosened. The previous version of this test asserted that
    // `scalar-fact-unavailable` means nothing is writing facts — and that claim
    // was FALSE on the host that motivated the change: the producer was healthy
    // and 22 host:scalars sat in the journal while the reader could not resolve
    // them. The reason means only THE READER FOUND NOTHING. A diagnostic that
    // cannot separate a missing producer from an unresolvable reader has to give
    // the reader the experiment that can (@cto, voiding the earlier PASS).
    const message = fire("scalar-fact-unavailable")

    expect(message).toContain("scalar-fact-unavailable")
    expect(message).toContain("THE READER FOUND NOTHING")
    expect(message, "the experiment must be runnable as printed").toContain("hab sysmon snapshot --session-dir")
    expect(message).toContain("--state-root")
    // Both outcomes named, so the reader knows what either result means.
    expect(message).toContain("READER path")
    expect(message).toContain("producer really is absent")
    // And it must NOT assert the cause it used to assert.
    expect(message, "must not claim a missing producer").not.toContain("nothing is writing them")
  })

  it("says the producer STOPPED for scalar-fact-stale, and never claims nothing is writing", () => {
    // Opposite provenance, opposite repair: facts EXIST and the newest is past
    // its max age, so a sampler wrote and died. Reporting the absent-producer
    // wording here sends the reader hunting for a declaration that is already
    // present — a diagnostic that names the wrong stage is worse than silence,
    // because it is actionable and false.
    const message = fire("scalar-fact-stale")

    expect(message).toContain("scalar-fact-stale")
    expect(message).toContain("EXIST")
    expect(message).toContain("a sampler wrote and then stopped")
    expect(message, "the absent-producer wording must not appear on a stale fact").not.toContain(
      "nothing is writing them",
    )
  })

  it("gives an unrecognised reason the same experiment rather than a guess", () => {
    // `scalar-fact-invalid` and `journal-diagnostic` reach this branch too, and
    // they mean neither missing nor stopped. They get the discriminating test
    // for the same reason the common case does: the alert does not know, and
    // saying so while handing over the way to find out beats every guess.
    const message = fire("scalar-fact-invalid")

    expect(message).toContain("scalar-fact-invalid")
    expect(message).toContain("THE READER FOUND NOTHING")
    expect(message).toContain("hab sysmon snapshot --session-dir")
    expect(message, "must not assert the missing-producer provenance").not.toContain("nothing is writing them")
    expect(message, "must not assert the stopped-producer provenance").not.toContain("a sampler wrote and then stopped")
  })

  it("names the ENVIRONMENT, not the producer, when hab config is contradictory", () => {
    // The one reason where the alert CAN name a stage, because the source itself
    // established it: hab markers present, gate variable absent. Here the cause
    // is in this process's own environment and pointing at the producer would
    // send the reader to a machine that is working fine.
    const message = fire("hab-environment-contradictory")

    expect(message).toContain("under hab and cannot locate its journal")
    expect(message, "the fault is local, and the message must say so").toContain("not in the producer")
    expect(message, "an inspectable command beats a description").toContain("/proc/")
    expect(message).not.toContain("nothing is writing them")
    expect(message).not.toContain("a sampler wrote and then stopped")
  })
})

describe("END TO END through the consumer's own read path (@cto term 3b)", () => {
  it("a contradictory hab environment reaches the ALERT, not a silent standalone", async () => {
    // TERM 3b, sharpened by the incident that produced it: the assertion runs
    // env → createHealthProcessSource → collectFullMetrics → evaluateAlerts,
    // never against the store and never through a different reader.
    //
    // Asserted store-side this would have said HEALTHY on 2026-09-07 — the
    // journal held 22 host:scalars and every store-side check passed while the
    // daemon read nothing. Only the end-to-end path crosses the seam where the
    // defect lives.
    const env = {
      HAB_SESSION_HABITAT_ROOT: "/hh/main.hab",
      HAB_SESSION_LAUNCH_ID: "70296c6b-21dd-41a9-8614-b6b6bff113e0",
    }
    const source = createHealthProcessSource({
      env,
      runCommand: () => {
        throw new Error("must never spawn")
      },
    })
    const thresholds = defaultThresholds()
    const state = createAlertState()

    // Two samples: sustained blindness is one standing condition, and one
    // failed read does not page.
    const first = await collectFullMetrics(source)
    evaluateAlerts(first.metrics, thresholds, state)
    const second = await collectFullMetrics(source)
    const alerts = blindAlerts(evaluateAlerts(second.metrics, thresholds, state))

    expect(alerts, "the daemon that never asks must say WHY it cannot ask").toHaveLength(1)
    expect(alerts[0]).toContain("under hab and cannot locate its journal")
    expect(alerts[0]).toContain("not in the producer")
  })

  it("a genuinely non-hab environment yields standalone-os, and standalone-os stays SILENT", () => {
    // TWO LEVELS, NOT END TO END, and the limit is stated rather than hidden.
    // `collectFullMetrics` spawns `ps`, a worktree listing, an fd count and
    // `ulimit` on this branch, so driving the control through it measures this
    // machine and hangs the suite. What matters is the pair: the env yields
    // standalone-os, and standalone-os never cries blind. The positive case
    // above IS end to end, which is where term 3b binds — an assertion that the
    // fact APPEARS must cross the seam; an assertion that nothing appears is
    // satisfied at the two ends.
    const source = createHealthProcessSource({ env: { PATH: "/usr/bin" } })
    expect(source).toEqual({ kind: "standalone-os" })

    const thresholds = defaultThresholds()
    const state = createAlertState()
    for (const _ of [1, 2, 3]) {
      expect(blindAlerts(evaluateAlerts(platformLimitMetrics(), thresholds, state))).toEqual([])
    }
  })
})
