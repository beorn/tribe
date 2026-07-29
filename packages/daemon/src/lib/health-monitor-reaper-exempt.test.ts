import { afterEach, describe, expect, it, vi } from "vitest"
import { type AlertState, checkReaper, type HealthThresholds } from "./health-monitor-plugin.ts"
import type { TribeClientApi } from "./plugin-api.ts"

// @km/infra/reaper-and-cwd-guard-hardening-followons gap 1 — checkReaper must
// honor an exempt marker and never reap a flagged live #undead repro.

const thresholds = {
  reaperEnabled: true,
  reaperCpuThreshold: 80,
  reaperAgeMinutes: 30,
  reaperGraceSamples: 6,
} as HealthThresholds

// Minimal api — checkReaper only calls broadcast / hasRecentMessage.
const api = {
  id: "test",
  broadcast: () => {},
  hasRecentMessage: () => false,
} as unknown as TribeClientApi

afterEach(() => {
  vi.restoreAllMocks()
})

function stateWithSuspect(pid: number): AlertState {
  return {
    reaperSuspects: new Map([
      [
        pid,
        { firstSeen: Date.now() - 600_000, samples: 5, asked: true, command: "bun repro", cpu: 99, etime: "40:00" },
      ],
    ]),
  } as unknown as AlertState
}

describe("checkReaper — gap 1 reaper-exempt skip", () => {
  it("an EXEMPT high-CPU suspect is removed from suspects", async () => {
    const pid = 999999
    const state = stateWithSuspect(pid)
    await checkReaper([{ pid, cpu: 99, command: "bun repro" }], new Map(), [], thresholds, state, api, () => true)
    expect(state.reaperSuspects.has(pid), "exempt repro must be dropped from the kill path").toBe(false)
  })

  it("a NON-exempt suspect below the escalation threshold is left intact", async () => {
    const pid = 999998
    const state = stateWithSuspect(pid)
    await checkReaper([{ pid, cpu: 99, command: "bun repro" }], new Map(), [], thresholds, state, api, () => false)
    expect(state.reaperSuspects.has(pid), "non-exempt suspect stays tracked").toBe(true)
  })
})

describe("checkReaper — operator escalation lifecycle", () => {
  it("escalates an unclaimed suspect once without signaling it", async () => {
    const pid = process.pid
    const state = {
      reaperSuspects: new Map([
        [
          pid,
          {
            firstSeen: Date.now() - 3_600_000,
            samples: 20,
            asked: true,
            command: "bun repro",
            cpu: 99,
            etime: "60:00",
          },
        ],
      ]),
    } as unknown as AlertState
    const broadcasts: Array<{ msg: string; type: string }> = []
    const escalationApi = {
      id: "test",
      broadcast: (msg: string, type: string) => broadcasts.push({ msg, type }),
      hasRecentMessage: () => false,
    } as unknown as TribeClientApi
    const killSpy = vi.spyOn(process, "kill")

    await checkReaper(
      [{ pid, cpu: 99, command: "bun repro" }],
      new Map(),
      [],
      thresholds,
      state,
      escalationApi,
      () => false,
    )
    await checkReaper(
      [{ pid, cpu: 99, command: "bun repro" }],
      new Map(),
      [],
      thresholds,
      state,
      escalationApi,
      () => false,
    )

    expect(killSpy).not.toHaveBeenCalled()
    expect(broadcasts.filter((broadcast) => broadcast.type === "health:reaper:unclaimed")).toHaveLength(1)
    expect(state.reaperSuspects.get(pid)?.escalated).toBe(true)
  })

  it("clears an escalated suspect when a session claims it", async () => {
    const pid = process.pid
    const state = {
      reaperSuspects: new Map([
        [
          pid,
          {
            firstSeen: Date.now() - 3_600_000,
            samples: 20,
            asked: true,
            escalated: true,
            command: "bun repro",
            cpu: 99,
            etime: "60:00",
          },
        ],
      ]),
    } as unknown as AlertState
    const claimApi = {
      id: "test",
      broadcast: () => {},
      hasRecentMessage: () => true,
    } as unknown as TribeClientApi

    await checkReaper([{ pid, cpu: 99, command: "bun repro" }], new Map(), [], thresholds, state, claimApi, () => false)

    expect(state.reaperSuspects.has(pid)).toBe(false)
  })

  it("asks for a claim without threatening automatic termination", async () => {
    const pid = process.pid
    const state = {
      reaperSuspects: new Map([
        [
          pid,
          {
            firstSeen: Date.now() - 3_600_000,
            samples: 3,
            asked: false,
            command: "bun repro",
            cpu: 99,
            etime: "60:00",
          },
        ],
      ]),
    } as unknown as AlertState
    const broadcasts: Array<{ msg: string; type: string }> = []
    const queryApi = {
      id: "test",
      broadcast: (msg: string, type: string) => broadcasts.push({ msg, type }),
      hasRecentMessage: () => false,
    } as unknown as TribeClientApi

    await checkReaper([{ pid, cpu: 99, command: "bun repro" }], new Map(), [], thresholds, state, queryApi, () => false)

    const queries = broadcasts.filter((broadcast) => broadcast.type === "health:reaper:query")
    expect(queries).toHaveLength(1)
    expect(queries[0]!.msg).toContain("escalated to the operator")
  })
})
