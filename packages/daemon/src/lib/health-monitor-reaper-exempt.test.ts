import { describe, expect, it } from "vitest"
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
  it("an EXEMPT high-CPU suspect is removed from suspects (never asked / killed)", async () => {
    const pid = 999999
    const state = stateWithSuspect(pid)
    await checkReaper([{ pid, cpu: 99, command: "bun repro" }], new Map(), [], thresholds, state, api, () => true)
    expect(state.reaperSuspects.has(pid), "exempt repro must be dropped from the kill path").toBe(false)
  })

  it("a NON-exempt suspect below the kill threshold is left intact (the exempt path didn't touch it)", async () => {
    const pid = 999998
    const state = stateWithSuspect(pid)
    await checkReaper([{ pid, cpu: 99, command: "bun repro" }], new Map(), [], thresholds, state, api, () => false)
    expect(state.reaperSuspects.has(pid), "non-exempt suspect stays tracked").toBe(true)
  })
})
