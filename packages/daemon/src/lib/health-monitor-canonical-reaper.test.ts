/**
 * @failure Managed reaper decisions use bare PIDs, age while attribution is
 *          unavailable, resample with ps, or broadcast-ask a known owner.
 * @level   l2
 * @consumer @hab/21960-hab-sysmon S2 reaper cutover
 */

import { describe, expect, it, vi } from "vitest"
import type { TribeClientApi } from "./plugin-api.ts"
import type { CanonicalProcessObservation, ProcessRoutingAttribution } from "./health-process-source.ts"
import {
  checkCanonicalReaper,
  createCanonicalReaperState,
  SOURCE_RECOVERY_SAMPLES,
} from "./health-monitor-canonical-reaper.ts"
import { defaultThresholds } from "./health-monitor-plugin.ts"

function observation(
  attribution: ProcessRoutingAttribution,
  options: { observedAt?: number; pid?: number; sequence?: number; startTime?: string } = {},
): CanonicalProcessObservation {
  const pid = options.pid ?? 10
  return {
    diagnostic: {
      excluded: ["standalone-os-resample", "cross-batch-attribution", "implicit-unowned"],
      location: "/hab/session",
      query: "latest exact process census with owner attribution",
    },
    kind: "available",
    observedAt: options.observedAt ?? 1_000,
    processes: [
      {
        attribution,
        process: {
          command: "bun worker.ts",
          cpuPercent: 99,
          pgid: pid,
          pid,
          ppid: 1,
          startTime: options.startTime ?? `linux:boot:${pid}`,
        },
      },
    ],
    schema: "process-observation/1",
    source: { epoch: "host-a", sequence: options.sequence ?? 7 },
  }
}

function unavailable(reason = "journal-diagnostic", detail = "journal has a torn tail"): CanonicalProcessObservation {
  return {
    diagnostic: {
      detail,
      excluded: ["standalone-os-resample", "cross-batch-attribution", "implicit-unowned"],
      location: "/hab/session",
      query: "latest exact process census with owner attribution",
    },
    kind: "unavailable",
    reason,
    schema: "process-observation/1",
  }
}

function api() {
  const broadcasts: Array<{ message: string; type: string }> = []
  const sends: Array<{ recipient: string; message: string; type: string }> = []
  return {
    broadcasts,
    client: {
      id: "test",
      broadcast: (message: string, type: string) => broadcasts.push({ message, type }),
      send: (recipient: string, message: string, type: string) => sends.push({ recipient, message, type }),
      hasRecentMessage: () => false,
    } as unknown as TribeClientApi,
    sends,
  }
}

const thresholds = { ...defaultThresholds(), reaperAgeMinutes: 0, reaperGraceSamples: 2 }
const sessions = [{ name: "@dev/3", pid: 100, role: "dev" }]

describe("canonical managed reaper", () => {
  it("fails closed once when the source is unavailable and never asks or resamples", () => {
    const state = createCanonicalReaperState()
    const sink = api()
    const spawn = vi.spyOn(Bun, "spawn")

    checkCanonicalReaper(unavailable(), thresholds, state, sink.client, sessions)
    checkCanonicalReaper(unavailable(), thresholds, state, sink.client, sessions)

    expect(sink.broadcasts).toHaveLength(1)
    expect(sink.broadcasts[0]).toMatchObject({ type: "health:reaper:unknown" })
    expect(sink.broadcasts[0]!.message).toContain("/hab/session")
    expect(sink.broadcasts[0]!.message).toContain("standalone-os-resample")
    expect(sink.broadcasts.some(({ type }) => type === "health:reaper:query")).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
    spawn.mockRestore()
  })

  it("routes one sustained owned incarnation through the live recipient and does not repeat", () => {
    const state = createCanonicalReaperState()
    const sink = api()
    for (let index = 0; index < 5; index++) {
      checkCanonicalReaper(
        observation(
          { kind: "owned", ownerId: "@dev/3", via: "root" },
          { observedAt: 1_000 + index * 30_000, sequence: 7 + index },
        ),
        thresholds,
        state,
        sink.client,
        sessions,
      )
    }

    expect(sink.sends).toEqual([expect.objectContaining({ recipient: "@dev/3", type: "health:reaper:owned" })])
    expect(sink.broadcasts.some(({ type }) => type === "health:reaper:query")).toBe(false)
  })

  it("counts one canonical source sequence once even when Tribe polls it repeatedly", () => {
    const state = createCanonicalReaperState()
    const sink = api()
    const same = observation({ kind: "owned", ownerId: "@dev/3", via: "root" })

    for (let index = 0; index < 5; index++) checkCanonicalReaper(same, thresholds, state, sink.client, sessions)

    expect([...state.suspects.values()]).toEqual([expect.objectContaining({ samples: 1 })])
    expect(sink.sends).toEqual([])
  })

  it("keys lifecycle state by pid and startTime so PID reuse starts from sample one", () => {
    const state = createCanonicalReaperState()
    const sink = api()
    const old = observation({ kind: "unowned" }, { pid: 10, startTime: "old" })
    checkCanonicalReaper(old, thresholds, state, sink.client, sessions)
    checkCanonicalReaper(
      observation({ kind: "unowned" }, { pid: 10, sequence: 8, startTime: "old" }),
      thresholds,
      state,
      sink.client,
      sessions,
    )
    checkCanonicalReaper(
      observation({ kind: "unowned" }, { pid: 10, sequence: 9, startTime: "new" }),
      thresholds,
      state,
      sink.client,
      sessions,
    )

    expect(sink.broadcasts.some(({ type }) => type === "health:reaper:query")).toBe(false)
    expect([...state.suspects.values()]).toEqual([expect.objectContaining({ samples: 1, startTime: "new" })])
  })

  it("unknown attribution resets the unowned clock and names bounded evidence", () => {
    const state = createCanonicalReaperState()
    const sink = api()
    const unowned = observation({ kind: "unowned" })
    checkCanonicalReaper(unowned, thresholds, state, sink.client, sessions)
    checkCanonicalReaper(observation({ kind: "unowned" }, { sequence: 8 }), thresholds, state, sink.client, sessions)
    checkCanonicalReaper(
      observation(
        {
          evidence: { ownerCount: 2, ownerIds: ["@a", "@b"], vias: ["root", "tree"] },
          kind: "unknown",
          reason: "owner-evidence-conflict",
        },
        { sequence: 9 },
      ),
      thresholds,
      state,
      sink.client,
      sessions,
    )
    checkCanonicalReaper(observation({ kind: "unowned" }, { sequence: 10 }), thresholds, state, sink.client, sessions)
    checkCanonicalReaper(observation({ kind: "unowned" }, { sequence: 11 }), thresholds, state, sink.client, sessions)

    expect(sink.broadcasts.filter(({ type }) => type === "health:reaper:query")).toEqual([])
    const diagnostic = sink.broadcasts.find(({ type }) => type === "health:reaper:unknown")?.message
    expect(diagnostic).toContain("owner-evidence-conflict")
    expect(diagnostic).toContain("owners=@a,@b")
    expect(diagnostic).toContain("via=root,tree")

    checkCanonicalReaper(observation({ kind: "unowned" }, { sequence: 12 }), thresholds, state, sink.client, sessions)
    expect(sink.broadcasts.filter(({ type }) => type === "health:reaper:query")).toHaveLength(1)
  })

  it("restarts age and samples after source unavailability", () => {
    const state = createCanonicalReaperState()
    const sink = api()
    const agedThresholds = { ...thresholds, reaperAgeMinutes: 1 }

    checkCanonicalReaper(
      observation({ kind: "unowned" }, { observedAt: 1_000, sequence: 7 }),
      agedThresholds,
      state,
      sink.client,
      sessions,
      { now: () => 1_000 },
    )
    checkCanonicalReaper(unavailable(), agedThresholds, state, sink.client, sessions, { now: () => 61_000 })
    checkCanonicalReaper(
      observation({ kind: "unowned" }, { observedAt: 121_000, sequence: 8 }),
      agedThresholds,
      state,
      sink.client,
      sessions,
      { now: () => 121_000 },
    )

    expect([...state.suspects.values()]).toEqual([expect.objectContaining({ firstSeen: 121_000, samples: 0 })])
  })

  it("requires a claim for the exact process incarnation", () => {
    const state = createCanonicalReaperState()
    const sink = api()
    const oldClaim = 'reaper:claim PID 10 START "old"'
    ;(sink.client as any).hasRecentMessage = vi.fn((query: string) => query === oldClaim)

    for (let index = 0; index < 5; index++) {
      checkCanonicalReaper(
        observation({ kind: "unowned" }, { observedAt: 1_000 + index * 30_000, sequence: 7 + index, startTime: "new" }),
        thresholds,
        state,
        sink.client,
        sessions,
      )
    }

    expect(state.suspects.size).toBe(1)
    expect(sink.broadcasts.at(-1)?.message).toContain('reaper:claim PID 10 START "new"')
    expect(sink.client.hasRecentMessage).toHaveBeenCalledWith('reaper:claim PID 10 START "new"')
  })

  it("rearms unavailable and unknown diagnostics after recovery", () => {
    const state = createCanonicalReaperState()
    const sink = api()
    const unknown = (sequence: number) =>
      observation(
        {
          evidence: { ownerCount: 1, ownerIds: ["@a"], vias: ["tree"] },
          kind: "unknown",
          reason: "owner-evidence-conflict",
        },
        { sequence },
      )

    checkCanonicalReaper(unavailable(), thresholds, state, sink.client, sessions)
    // Recovery is DURABLE health, not one healthy tick. This test used to pass a
    // single observation here and expect the identical condition to announce
    // itself again — which is the flap that produced 2,031 broadcasts of ~19
    // distinct strings on the live journal. Re-arming is still required; it just
    // costs more than one sample now. Exempt rows keep the source healthy
    // without creating suspects that would escalate on their own.
    for (let i = 0; i < SOURCE_RECOVERY_SAMPLES; i++) {
      checkCanonicalReaper(
        observation({ kind: "exempt", ownerId: "diagnostic", via: "root" }, { sequence: 7 + i }),
        thresholds,
        state,
        sink.client,
        sessions,
      )
    }
    checkCanonicalReaper(unavailable(), thresholds, state, sink.client, sessions)
    checkCanonicalReaper(unknown(10), thresholds, state, sink.client, sessions)
    checkCanonicalReaper(observation({ kind: "unowned" }, { sequence: 11 }), thresholds, state, sink.client, sessions)
    checkCanonicalReaper(unknown(12), thresholds, state, sink.client, sessions)

    expect(sink.broadcasts.filter(({ message }) => message.includes("source unavailable"))).toHaveLength(2)
    expect(sink.broadcasts.filter(({ message }) => message.includes("ownership unknown"))).toHaveLength(2)
  })

  it("drops an exempt incarnation without querying or notifying", () => {
    const state = createCanonicalReaperState()
    const sink = api()
    checkCanonicalReaper(
      observation({ kind: "exempt", ownerId: "diagnostic", via: "root" }),
      thresholds,
      state,
      sink.client,
      sessions,
    )

    expect(sink.broadcasts).toEqual([])
    expect(sink.sends).toEqual([])
    expect(state.suspects.size).toBe(0)
  })
})

/**
 * Measured 2026-08-14 on the live journal: `health:reaper:unknown` produced
 * 2,031 broadcasts carrying 19 distinct strings — 1,012 of
 * `process-census-incomplete` and 997 of `process-fact-invalid`, byte-identical
 * within each group. Every one was read by all 25 seats: 50,775 agent-reads of
 * one unfixed condition, 43.6% of ALL fleet broadcast traffic.
 *
 * The de-duplication was already there and could not work. `lastSourceDiagnostic`
 * is a single slot, and BOTH branches below defeat it:
 *
 *   1. two conditions alternating never match the one remembered value;
 *   2. any healthy observation reset the slot to `undefined`, so even a single
 *      condition re-announced itself after every recovery blip.
 *
 * A condition is news when it STARTS and when it ENDS. Repetition is not news.
 */
describe("canonical source conditions announce edges, not observations", () => {
  it("announces each distinct condition once even while two alternate", () => {
    const state = createCanonicalReaperState()
    const sink = api()

    // The production flap, verbatim.
    for (let i = 0; i < 8; i++) {
      checkCanonicalReaper(unavailable("process-census-incomplete"), thresholds, state, sink.client, sessions)
      checkCanonicalReaper(
        unavailable("process-fact-invalid", "process fact is from the future"),
        thresholds,
        state,
        sink.client,
        sessions,
      )
    }

    expect(sink.broadcasts).toHaveLength(2)
    expect(sink.broadcasts.map(({ message }) => message.includes("process-census-incomplete"))).toEqual([true, false])
    expect(sink.broadcasts[1]!.message).toContain("process-fact-invalid")
  })

  it("does not re-announce a condition because one healthy observation landed between", () => {
    const state = createCanonicalReaperState()
    const sink = api()
    const healthy = observation({ kind: "owned", ownerId: "@dev/3", via: "pgid" }, { sequence: 1 })

    checkCanonicalReaper(unavailable("process-census-incomplete"), thresholds, state, sink.client, sessions)
    checkCanonicalReaper(healthy, thresholds, state, sink.client, sessions)
    checkCanonicalReaper(unavailable("process-census-incomplete"), thresholds, state, sink.client, sessions)

    // One condition, one announcement — a single healthy blip is not a recovery.
    expect(sink.broadcasts.filter(({ type }) => type === "health:reaper:unknown")).toHaveLength(1)
  })

  it("announces recovery once the source is durably healthy, and re-arms after it", () => {
    const state = createCanonicalReaperState()
    const sink = api()
    const unknowns = () => sink.broadcasts.filter(({ type }) => type === "health:reaper:unknown")
    const recoveries = () => sink.broadcasts.filter(({ type }) => type === "health:reaper:recovered")

    checkCanonicalReaper(unavailable("process-census-incomplete"), thresholds, state, sink.client, sessions)
    expect(unknowns()).toHaveLength(1)

    for (let i = 0; i < SOURCE_RECOVERY_SAMPLES; i++) {
      checkCanonicalReaper(
        observation({ kind: "owned", ownerId: "@dev/3", via: "pgid" }, { sequence: 10 + i }),
        thresholds,
        state,
        sink.client,
        sessions,
      )
    }

    expect(recoveries()).toHaveLength(1)
    expect(recoveries()[0]!.message).toContain("process-census-incomplete")

    // Genuinely new episode — this one IS news again.
    checkCanonicalReaper(unavailable("process-census-incomplete"), thresholds, state, sink.client, sessions)
    expect(unknowns()).toHaveLength(2)
  })

  it("keys the regression condition on its shape, not on volatile epoch/sequence text", () => {
    const state = createCanonicalReaperState()
    const sink = api()

    checkCanonicalReaper(
      observation({ kind: "owned", ownerId: "@dev/3", via: "pgid" }, { sequence: 9 }),
      thresholds,
      state,
      sink.client,
      sessions,
    )
    // Each regression carries different sequence/timestamp text, so a
    // string-keyed dedup announces every one of them.
    for (let i = 0; i < 5; i++) {
      checkCanonicalReaper(
        observation({ kind: "owned", ownerId: "@dev/3", via: "pgid" }, { observedAt: 500 - i, sequence: 4 - i }),
        thresholds,
        state,
        sink.client,
        sessions,
      )
    }

    expect(sink.broadcasts.filter(({ message }) => message.includes("regressed"))).toHaveLength(1)
  })
})
