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
import {
  type AlertState,
  checkReaper,
  createAlertState,
  defaultThresholds,
  evaluateAlerts,
  formatThresholdRefusals,
  type HealthMetrics,
} from "./health-monitor-plugin.ts"

function observation(
  attribution: ProcessRoutingAttribution,
  options: {
    command?: string
    cpuPercent?: number
    observedAt?: number
    pid?: number
    sequence?: number
    startTime?: string
  } = {},
): Extract<CanonicalProcessObservation, { kind: "available" }> {
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
          command: options.command ?? "bun worker.ts",
          cpuPercent: options.cpuPercent ?? 99,
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

  it("names a parked process whose canonical owner is a stopped seat, with the seat and the start time (hh 27765)", () => {
    const state = createCanonicalReaperState()
    const sink = api()
    for (let index = 0; index < 4; index++) {
      checkCanonicalReaper(
        observation(
          { kind: "owned", ownerId: "@dev/luna6", via: "env", ownerLiveness: "down" },
          {
            command: "bun arm-bound-probe.ts",
            cpuPercent: 0,
            observedAt: 1_000 + index * 30_000,
            pid: 2_548_408,
            sequence: 7 + index,
            startTime: "linux:boot:2548408",
          },
        ),
        thresholds,
        state,
        sink.client,
        sessions,
      )
    }

    const pages = sink.broadcasts.filter(({ type }) => type === "health:reaper:owner-down")
    expect(pages).toHaveLength(1)
    expect(pages[0]!.message).toContain("@dev/luna6")
    expect(pages[0]!.message).toContain("2548408")
    expect(pages[0]!.message).toContain("linux:boot:2548408")
    expect(sink.sends.some(({ recipient }) => recipient === "@dev/luna6")).toBe(false)
  })

  it("stays silent for a parked process whose canonical owner is still live (hh 27765)", () => {
    const state = createCanonicalReaperState()
    const sink = api()
    for (let index = 0; index < 4; index++) {
      checkCanonicalReaper(
        observation(
          { kind: "owned", ownerId: "@dev/3", via: "env" },
          { cpuPercent: 0, observedAt: 1_000 + index * 30_000, pid: 51, sequence: 7 + index },
        ),
        thresholds,
        state,
        sink.client,
        sessions,
      )
    }

    expect(sink.broadcasts).toEqual([])
    expect(sink.sends).toEqual([])
  })

  // 28276: custody paths do not prove owner liveness; the canonical producer supplies it independently.
  it("never pages a parked process whose service owner is alive in the census (hh 28276)", () => {
    const state = createCanonicalReaperState()
    const sink = api()
    const atRest = observation(
      { kind: "owned", ownerId: "habmod", via: "root", ownerLiveness: "live" },
      { command: "bun habmod.ts", cpuPercent: 0, pid: 913_768, startTime: "linux:boot:913768" },
    )
    for (let index = 0; index < 4; index++) {
      checkCanonicalReaper(
        {
          ...atRest,
          observedAt: 1_000 + index * 30_000,
          processes: [
            ...atRest.processes,
            {
              attribution: { kind: "owned", ownerId: "habmod", via: "tree", ownerLiveness: "live" },
              process: {
                ...atRest.processes[0]!.process,
                command: "bun habmod-worker.ts",
                cpuPercent: 0,
                pid: 919_689,
                startTime: "linux:boot:919689",
              },
            },
          ],
          source: { epoch: "host-a", sequence: 60 + index },
        },
        thresholds,
        state,
        sink.client,
        sessions,
      )
    }

    expect(sink.broadcasts).toEqual([])
    expect(sink.sends).toEqual([])
  })

  // #28276: three fresh down censuses are required; a changed lifecycle breaks the run.
  // Other aging tests change custody or source availability, not an owned row's lifecycle.
  it.each(["live", "unknown"] as const)("%s between down observations resets owner-down aging", (middle) => {
    const state = createCanonicalReaperState()
    const sink = api()
    const lifecycle = ["down", "down", middle, "down", "down", "down"] as const
    lifecycle.forEach((ownerLiveness, index) => {
      checkCanonicalReaper(
        observation(
          { kind: "owned", ownerId: "km-daemon", via: "env", ownerLiveness },
          {
            cpuPercent: 0,
            observedAt: 1_000 + index * 30_000,
            sequence: 70 + index,
          },
        ),
        thresholds,
        state,
        sink.client,
        [],
      )
      expect(sink.broadcasts.filter(({ type }) => type === "health:reaper:owner-down")).toHaveLength(
        index === 5 ? 1 : 0,
      )
    })
  })

  it("still names a service-owned process once its unit is gone from the census (hh 28276)", () => {
    const state = createCanonicalReaperState()
    const sink = api()
    for (let index = 0; index < 4; index++) {
      checkCanonicalReaper(
        observation(
          { kind: "owned", ownerId: "km-daemon", via: "env", ownerLiveness: "down" },
          {
            command: "bun km-daemon.ts",
            cpuPercent: 0,
            observedAt: 1_000 + index * 30_000,
            pid: 700_001,
            sequence: 70 + index,
            startTime: "linux:boot:700001",
          },
        ),
        thresholds,
        state,
        sink.client,
        sessions,
      )
    }

    const pages = sink.broadcasts.filter(({ type }) => type === "health:reaper:owner-down")
    expect(pages).toHaveLength(1)
    expect(pages[0]!.message).toContain("km-daemon")
    expect(pages[0]!.message).toContain("700001")
  })

  it("says once that a suspect left the watch when its census row turned malformed; an exited one leaves silently (hh 25917)", () => {
    const state = createCanonicalReaperState()
    const sink = api()
    checkCanonicalReaper(observation({ kind: "unowned" }, { pid: 10 }), thresholds, state, sink.client, sessions)
    checkCanonicalReaper(observation({ kind: "unowned" }, { pid: 20, sequence: 8 }), thresholds, state, sink.client, [])
    const excluded: CanonicalProcessObservation = {
      ...observation({ kind: "unowned" }, { pid: 30, observedAt: 31_000, sequence: 9 }),
      excludedRows: [{ command: "bun worker.ts", detail: "invalid pgid", field: "pgid", pid: 20, value: -1 }],
    }
    const before = sink.broadcasts.length

    checkCanonicalReaper(excluded, thresholds, state, sink.client, sessions)

    const notes = sink.broadcasts.slice(before).filter(({ type }) => type === "health:reaper:unknown")
    expect(notes.map(({ message }) => message)).toEqual([
      expect.stringContaining("PID 20 (bun worker.ts) left the watch: its census row is malformed (pgid=-1)"),
    ])
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

  it("names an EMPTY-evidence unknown row (owner-probe-unavailable, leader-exited) and never kills it (29584)", () => {
    // 29584: the per-row unknown tests above drive `owner-evidence-conflict`, which carries real
    // evidence (`owners=@a,@b`). The two reasons the census emits with NO owner evidence —
    // `owner-probe-unavailable` (the owner env could not be read) and `leader-exited` (a zombie leader
    // that already left) — were never driven through the reaper, so nothing proved an empty-evidence
    // unknown is still reported by name and kept off the kill path.
    for (const reason of ["owner-probe-unavailable", "leader-exited"] as const) {
      const state = createCanonicalReaperState()
      const broadcasts: Array<{ message: string; type: string }> = []
      const sends: string[] = []
      const hasRecentMessage = vi.fn(() => false)
      const client = {
        broadcast: (message: string, type: string) => broadcasts.push({ message, type }),
        hasRecentMessage,
        id: "test",
        send: (_recipient: string, _message: string, type: string) => sends.push(type),
      } as unknown as TribeClientApi
      const row: ProcessRoutingAttribution = {
        evidence: { ownerCount: 0, ownerIds: [], vias: [] },
        kind: "unknown",
        reason,
      }
      for (let index = 0; index < 5; index++) {
        checkCanonicalReaper(
          observation(row, { observedAt: 1_000 + index * 30_000, sequence: 7 + index }),
          thresholds,
          state,
          client,
          sessions,
        )
      }
      const types = broadcasts.map(({ type }) => type)
      const diagnostic = broadcasts.find(({ type }) => type === "health:reaper:unknown")?.message
      expect(diagnostic, reason).toContain(reason)
      expect(diagnostic, reason).toContain("owners=none")
      // never escalated to a kill: no query, no claim lookup, no direct send, no unclaimed broadcast
      expect(types, reason).not.toContain("health:reaper:query")
      expect(types, reason).not.toContain("health:reaper:unclaimed")
      expect(hasRecentMessage, reason).not.toHaveBeenCalled()
      expect(sends, reason).toEqual([])
    }
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

describe("the reaper's CPU threshold is read strictly, and a refusal stays inside the reaper", () => {
  const refusalFor = (read: ReturnType<typeof defaultThresholds>, envVar = "HEALTH_REAPER_CPU_THRESHOLD") =>
    read.thresholdRefusals?.find((entry) => entry.envVar === envVar)
  const withThreshold = (value: string | undefined, run: () => void): void => {
    const previous = process.env.HEALTH_REAPER_CPU_THRESHOLD
    try {
      if (value === undefined) delete process.env.HEALTH_REAPER_CPU_THRESHOLD
      else process.env.HEALTH_REAPER_CPU_THRESHOLD = value
      run()
    } finally {
      if (previous === undefined) delete process.env.HEALTH_REAPER_CPU_THRESHOLD
      else process.env.HEALTH_REAPER_CPU_THRESHOLD = previous
    }
  }

  it("returns the refusal instead of throwing, for a value that is not a number and for one not above zero", () => {
    // Number("eighty") is NaN and the reaper's own gate is `cpu > threshold`, which reads FALSE for every row at NaN
    // and at 0 or below, so a mistyped threshold did not fail: it admitted every bun/node row as a suspect and turned
    // the gate off silently (29561 item 4). The refusal must NOT throw, because defaultThresholds() runs inside the
    // plugin's start() and the loader disables any plugin whose start throws (@cto, 2026-10-15): it turns the reaper
    // off, and start() pages once about it.
    withThreshold("eighty", () => {
      const read = defaultThresholds()
      expect(refusalFor(read)).toMatchObject({
        envVar: "HEALTH_REAPER_CPU_THRESHOLD",
        raw: "eighty",
        reason: "not-a-number",
      })
      expect(read.reaperEnabled).toBe(false)
      // The folded consequence is the data that says what the refusal does (29572).
      expect(refusalFor(read)?.consequence).toContain("process reaper")
      expect(refusalFor(read)?.consequence).toContain("is OFF")
    })
    // A finite value at or below zero fails exactly the way NaN does, so it is refused the same way.
    withThreshold("0", () => {
      expect(refusalFor(defaultThresholds())).toMatchObject({
        envVar: "HEALTH_REAPER_CPU_THRESHOLD",
        raw: "0",
        reason: "not-positive",
      })
    })
    withThreshold("-5", () => {
      const read = defaultThresholds()
      expect(refusalFor(read)).toMatchObject({
        envVar: "HEALTH_REAPER_CPU_THRESHOLD",
        raw: "-5",
        reason: "not-positive",
      })
      expect(read.reaperEnabled).toBe(false)
    })
    // And the old throw is gone, on every one of those values: this is the wider failure the revise removed.
    for (const raw of ["eighty", "0", "-5"]) {
      withThreshold(raw, () => expect(() => defaultThresholds()).not.toThrow())
    }
  })

  it("still reads the default, and a number the operator did set", () => {
    withThreshold(undefined, () => {
      const read = defaultThresholds()
      expect(refusalFor(read)).toBeUndefined()
      expect(read.reaperCpuThreshold).toBe(80)
      expect(read.reaperEnabled).toBe(true)
    })
    withThreshold("55", () => {
      const read = defaultThresholds()
      expect(refusalFor(read)).toBeUndefined()
      expect(read.reaperCpuThreshold).toBe(55)
    })
  })
})

describe("all twelve thresholds are read strictly, and a refusal is contained (29572)", () => {
  type Read = ReturnType<typeof defaultThresholds>
  // [envVar, declared default, field, what the refusal does]. A passive alert keeps its declared default - an alert
  // left running protects more than one switched off. A reaper parameter is different: the reaper kills processes, so
  // any refused reaper value turns it OFF rather than run it on a number the operator never chose.
  const PASSIVE: ReadonlyArray<readonly [string, number, (t: Read) => number]> = [
    ["HEALTH_CPU_WARNING", 0.8, (t) => t.cpuWarningMultiplier],
    ["HEALTH_CPU_CRITICAL", 1.5, (t) => t.cpuCriticalMultiplier],
    ["HEALTH_MEM_WARNING", 85, (t) => t.memWarningPercent],
    ["HEALTH_MEM_CRITICAL", 95, (t) => t.memCriticalPercent],
    ["HEALTH_PROC_WARNING", 50, (t) => t.processCountWarning],
    ["HEALTH_PROC_PER_AGENT", 10, (t) => t.processPerAgent],
    ["HEALTH_PROC_CHIEF_CONST", 6, (t) => t.processChiefConst],
    ["HEALTH_PROC_SAFETY_MARGIN", 1.5, (t) => t.processSafetyMargin],
    ["HEALTH_DISK_WARNING", 85, (t) => t.diskWarningPercent],
    ["HEALTH_DISK_CRITICAL", 95, (t) => t.diskCriticalPercent],
    ["HEALTH_FD_WARNING", 70, (t) => t.fdWarningPercent],
    ["HEALTH_GH_RATELIMIT_WARNING", 20, (t) => t.ghRateLimitWarning],
  ]
  const REAPER: ReadonlyArray<readonly [string, number, (t: Read) => number]> = [
    ["HEALTH_REAPER_CPU_THRESHOLD", 80, (t) => t.reaperCpuThreshold],
    ["HEALTH_REAPER_AGE_MINUTES", 30, (t) => t.reaperAgeMinutes],
    ["HEALTH_REAPER_GRACE_SAMPLES", 6, (t) => t.reaperGraceSamples],
  ]

  const withEnv = (envVar: string, value: string | undefined, run: () => void): void => {
    const previous = process.env[envVar]
    try {
      if (value === undefined) delete process.env[envVar]
      else process.env[envVar] = value
      run()
    } finally {
      if (previous === undefined) delete process.env[envVar]
      else process.env[envVar] = previous
    }
  }

  it("refuses a mistyped value on every one of the twelve, with the consequence its check now has", () => {
    for (const [envVar, fallback, get] of PASSIVE) {
      withEnv(envVar, "eighty-ish", () => {
        const read = defaultThresholds()
        expect(get(read)).toBe(fallback)
        expect(read.thresholdRefusals?.[0]).toMatchObject({ envVar, raw: "eighty-ish", reason: "not-a-number" })
        expect(read.thresholdRefusals?.[0]?.consequence).toBe("default " + fallback + " in use")
        expect(read.reaperEnabled).toBe(true)
      })
    }
    for (const [envVar, fallback, get] of REAPER) {
      withEnv(envVar, "eighty-ish", () => {
        const read = defaultThresholds()
        expect(get(read)).toBe(fallback)
        expect(read.thresholdRefusals?.[0]).toMatchObject({ envVar, raw: "eighty-ish", reason: "not-a-number" })
        expect(read.thresholdRefusals?.[0]?.consequence).toContain("process reaper")
        expect(read.thresholdRefusals?.[0]?.consequence).toContain("is OFF")
        // A refused reaper parameter turns the reaper off, whichever of the three it is.
        expect(read.reaperEnabled).toBe(false)
      })
    }
  })

  it("refuses a value at or below zero on every one of the twelve", () => {
    // A percent field refuses 0 as "not-a-percent" (its bound is 0 < v <= 100); everything else as "not-positive".
    const PERCENT = new Set([
      "HEALTH_MEM_WARNING",
      "HEALTH_MEM_CRITICAL",
      "HEALTH_DISK_WARNING",
      "HEALTH_DISK_CRITICAL",
      "HEALTH_FD_WARNING",
      "HEALTH_GH_RATELIMIT_WARNING",
    ])
    for (const [envVar, fallback, get] of [...PASSIVE, ...REAPER]) {
      withEnv(envVar, "0", () => {
        const read = defaultThresholds()
        expect(get(read)).toBe(fallback)
        expect(read.thresholdRefusals?.[0]?.reason).toBe(PERCENT.has(envVar) ? "not-a-percent" : "not-positive")
      })
    }
  })

  it("refuses a non-whole number on an integer field, rather than truncating it (85.5 is not 85)", () => {
    for (const [envVar, fallback, get] of [
      ["HEALTH_PROC_WARNING", 50, (t: Read) => t.processCountWarning],
      ["HEALTH_PROC_CHIEF_CONST", 6, (t: Read) => t.processChiefConst],
    ] as const) {
      withEnv(envVar, "85.5", () => {
        const read = defaultThresholds()
        expect(get(read)).toBe(fallback)
        expect(read.thresholdRefusals?.[0]).toMatchObject({ raw: "85.5", reason: "not-an-integer" })
      })
    }
  })

  it("refuses a value outside 0..100 on a percent field, so a fat-fingered 850 cannot switch the alert off", () => {
    for (const [envVar, fallback, get] of [
      ["HEALTH_MEM_WARNING", 85, (t: Read) => t.memWarningPercent],
      ["HEALTH_DISK_CRITICAL", 95, (t: Read) => t.diskCriticalPercent],
      ["HEALTH_FD_WARNING", 70, (t: Read) => t.fdWarningPercent],
      ["HEALTH_GH_RATELIMIT_WARNING", 20, (t: Read) => t.ghRateLimitWarning],
    ] as const) {
      withEnv(envVar, "850", () => {
        const read = defaultThresholds()
        expect(get(read)).toBe(fallback)
        expect(read.thresholdRefusals?.[0]).toMatchObject({ raw: "850", reason: "not-a-percent" })
      })
    }
  })

  it("refuses trailing garbage that parseInt/parseFloat used to swallow silently", () => {
    withEnv("HEALTH_MEM_WARNING", "85abc", () => {
      const read = defaultThresholds()
      expect(read.memWarningPercent).toBe(85)
      expect(read.thresholdRefusals?.[0]?.reason).toBe("not-a-number")
    })
    withEnv("HEALTH_CPU_WARNING", "0.8x", () => {
      const read = defaultThresholds()
      expect(read.cpuWarningMultiplier).toBe(0.8)
      expect(read.thresholdRefusals?.[0]?.reason).toBe("not-a-number")
    })
  })

  it("leaves nothing comparing against NaN, and never throws out of defaultThresholds", () => {
    for (const [envVar, , get] of [...PASSIVE, ...REAPER]) {
      withEnv(envVar, "wat", () => {
        expect(() => defaultThresholds()).not.toThrow()
        expect(Number.isNaN(get(defaultThresholds()))).toBe(false)
      })
    }
  })

  it("names every refused variable in ONE message, with what each check does now", () => {
    withEnv("HEALTH_MEM_WARNING", "nope", () => {
      withEnv("HEALTH_DISK_CRITICAL", "-1", () => {
        withEnv("HEALTH_REAPER_AGE_MINUTES", "30m", () => {
          const read = defaultThresholds()
          expect(read.thresholdRefusals).toHaveLength(3)
          const message = formatThresholdRefusals(read.thresholdRefusals ?? [])
          expect(message).toContain("HEALTH_MEM_WARNING")
          expect(message).toContain("HEALTH_DISK_CRITICAL")
          expect(message).toContain("HEALTH_REAPER_AGE_MINUTES")
          expect(message).toContain("default 85 in use")
          expect(message).toContain("process reaper")
          expect(message).toContain("3 health thresholds refused")
          expect(message).toContain("no check was left comparing against a value nobody chose")
        })
      })
    })
  })

  it("reads every declared default, and a number the operator did set, with no refusal", () => {
    for (const [envVar, fallback, get] of [...PASSIVE, ...REAPER]) {
      withEnv(envVar, undefined, () => {
        const read = defaultThresholds()
        expect(get(read)).toBe(fallback)
        expect(read.thresholdRefusals).toBeUndefined()
      })
      withEnv(envVar, String(fallback), () => {
        const read = defaultThresholds()
        expect(get(read)).toBe(fallback)
        expect(read.thresholdRefusals).toBeUndefined()
      })
    }
  })

  it("keeps the folded item-4 value on the same field, with the reaper OFF and one list for all twelve", () => {
    withEnv("HEALTH_REAPER_CPU_THRESHOLD", "eighty", () => {
      const read = defaultThresholds()
      expect(read.reaperEnabled).toBe(false)
      expect(read.thresholdRefusals).toHaveLength(1)
      expect(read.thresholdRefusals?.[0]).toMatchObject({
        envVar: "HEALTH_REAPER_CPU_THRESHOLD",
        raw: "eighty",
        reason: "not-a-number",
      })
    })
  })
})

describe("a refused reaper parameter turns the reaper OFF on BOTH consumer paths (29572)", () => {
  const withEnv = (envVar: string, value: string | undefined, run: () => void): void => {
    const previous = process.env[envVar]
    try {
      if (value === undefined) delete process.env[envVar]
      else process.env[envVar] = value
      run()
    } finally {
      if (previous === undefined) delete process.env[envVar]
      else process.env[envVar] = previous
    }
  }

  it("managed (checkCanonicalReaper): a refused age asks nothing, because reaperEnabled is false", () => {
    for (const envVar of ["HEALTH_REAPER_AGE_MINUTES", "HEALTH_REAPER_GRACE_SAMPLES"]) {
      withEnv(envVar, "thirty-ish", () => {
        const t = defaultThresholds()
        // reaperEnabled false is the off switch both consumers return on first (canonical-reaper.ts:186).
        expect(t.reaperEnabled).toBe(false)
        const state = createCanonicalReaperState()
        const sink = api()
        for (let index = 0; index < 6; index++) {
          checkCanonicalReaper(
            observation(
              { kind: "unowned" },
              { observedAt: 1_000 + 31 * 60_000 + index * 30_000, sequence: 20 + index },
            ),
            t,
            state,
            sink.client,
            sessions,
          )
        }
        // Long past the age floor and the grace, and still nothing: the reaper is off, and it says why on the page.
        expect(sink.broadcasts).toEqual([])
        expect(sink.sends).toEqual([])
      })
    }
  })

  it("legacy (checkReaper): a refused age tracks nothing, because reaperEnabled is false", async () => {
    const spawn = vi.spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
      const etime = Number(argv[2]) === 424_242 ? "00:01:00" : "00:40:00"
      return { stdout: new Blob([`${etime}\n`]).stream() } as unknown as ReturnType<typeof Bun.spawn>
    }) as unknown as typeof Bun.spawn)
    try {
      for (const envVar of ["HEALTH_REAPER_AGE_MINUTES", "HEALTH_REAPER_GRACE_SAMPLES"]) {
        const previous = process.env[envVar]
        process.env[envVar] = "thirty-ish"
        try {
          const t = defaultThresholds()
          expect(t.reaperEnabled).toBe(false)
          const state = { reaperSuspects: new Map() } as unknown as AlertState
          const legacyApi = { broadcast: () => {}, hasRecentMessage: () => false } as unknown as TribeClientApi
          await checkReaper(
            [
              { pid: 424_242, cpu: 99, command: "bun young.ts" },
              { pid: 424_243, cpu: 99, command: "bun old.ts" },
            ],
            new Map(),
            [],
            t,
            state,
            legacyApi,
            () => false,
          )
          // Off means off: not even the 40-minute-old process is tracked, so nothing can be reaped on a refused value.
          expect(state.reaperSuspects.size).toBe(0)
        } finally {
          if (previous === undefined) delete process.env[envVar]
          else process.env[envVar] = previous
        }
      }
    } finally {
      spawn.mockRestore()
    }
  })
})

describe("a refused passive alert keeps RUNNING at its declared default (29572)", () => {
  // Control: 80% fd usage against the declared default of 70 is a real warning, so the row can fail loudly for an
  // unrelated reason rather than passing by accident.
  const highFds: HealthMetrics["fdCount"] = {
    total: 8_000,
    perSession: [],
    limit: 10_000,
    basis: "linux-file-nr-vs-file-max",
  }
  const metrics = (fdCount?: HealthMetrics["fdCount"], memory?: HealthMetrics["memory"]): HealthMetrics => ({
    cpu: { topProcesses: [] },
    ...(fdCount === undefined ? {} : { fdCount }),
    ...(memory === undefined ? {} : { memory }),
    processObservation: { kind: "standalone-os" },
    scalarObservation: { kind: "standalone-os", unavailable: ["disk.bytes", "disk.inodes"] },
    timestamp: Date.now(),
    worktrees: 0,
  })

  const withFdEnv = (value: string | undefined, run: () => void): void => {
    const previous = process.env.HEALTH_FD_WARNING
    try {
      if (value === undefined) delete process.env.HEALTH_FD_WARNING
      else process.env.HEALTH_FD_WARNING = value
      run()
    } finally {
      if (previous === undefined) delete process.env.HEALTH_FD_WARNING
      else process.env.HEALTH_FD_WARNING = previous
    }
  }

  it("still fires the fd warning at the declared default once the threshold is refused", () => {
    withFdEnv(undefined, () => {
      const alerts = evaluateAlerts(metrics(highFds), defaultThresholds(), createAlertState())
      expect(alerts.filter((alert) => alert.type === "fd-count")).toHaveLength(1)
    })
    // Refused: the check is NOT switched off - an alert left running protects more than one switched off - and the
    // refusal is paged, naming the default it runs at.
    withFdEnv("ninety-nine", () => {
      const thresholds = defaultThresholds()
      expect(thresholds.thresholdRefusals?.[0]?.consequence).toBe("default 70 in use")
      const alerts = evaluateAlerts(metrics(highFds), thresholds, createAlertState())
      expect(alerts.filter((alert) => alert.type === "fd-count")).toHaveLength(1)
    })
  })

  it("does not take a different check down with it, so the monitor is not disabled", () => {
    withFdEnv("ninety-nine", () => {
      const alerts = evaluateAlerts(
        metrics(highFds, { totalMB: 32_000, usedMB: 30_400, availableMB: 1_600, pressurePercent: 96 }),
        defaultThresholds(),
        createAlertState(),
      )
      expect(alerts.filter((alert) => alert.type === "fd-count")).toHaveLength(1)
      expect(alerts.filter((alert) => alert.type === "memory")).toHaveLength(1)
    })
  })
})
