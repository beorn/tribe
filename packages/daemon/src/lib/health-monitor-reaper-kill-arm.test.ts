import { afterEach, describe, expect, it, vi } from "vitest"
import { type AlertState, checkReaper, defaultThresholds, type HealthThresholds } from "./health-monitor-plugin.ts"
import type { TribeClientApi } from "./plugin-api.ts"

// No-automatic-reaping doctrine: detection + claim-query are automatic, but the
// kill arm must NEVER fire unless explicitly opted in (HEALTH_REAPER_KILL=1).
// Regression for the 2026-07-22 incident where the reaper SIGTERMed live Yrd
// check jobs ("Polite quit request" deaths at 33-37s, zero queue landings).

function makeApi() {
  const broadcasts: Array<{ msg: string; type: string }> = []
  const api = {
    id: "test",
    broadcast: (msg: string, type: string) => {
      broadcasts.push({ msg, type })
    },
    hasRecentMessage: () => false,
  } as unknown as TribeClientApi
  return { api, broadcasts }
}

// Past the grace window (asked + samples >= 3 + graceSamples) — the point where
// the old code killed. Uses the test runner's own live pid so the stillAlive
// `ps` check passes; if the kill arm ever fires here the test suite dies loudly.
function stateAtKillPoint(pid: number): AlertState {
  return {
    reaperSuspects: new Map([
      [
        pid,
        { firstSeen: Date.now() - 3_600_000, samples: 20, asked: true, command: "bun repro", cpu: 99, etime: "60:00" },
      ],
    ]),
  } as unknown as AlertState
}

const thresholds = {
  reaperEnabled: true,
  reaperCpuThreshold: 80,
  reaperAgeMinutes: 30,
  reaperGraceSamples: 6,
  reaperKillEnabled: false,
} as HealthThresholds

afterEach(() => {
  vi.restoreAllMocks()
})

describe("checkReaper — kill arm is opt-in, never automatic", () => {
  it("defaultThresholds ships with the kill arm OFF unless HEALTH_REAPER_KILL=1", () => {
    expect(process.env.HEALTH_REAPER_KILL).not.toBe("1")
    expect(defaultThresholds().reaperKillEnabled).toBe(false)
  })

  it("an unclaimed suspect past grace is escalated ONCE and never signaled", async () => {
    const pid = process.pid
    const state = stateAtKillPoint(pid)
    const { api, broadcasts } = makeApi()
    const killSpy = vi.spyOn(process, "kill")

    await checkReaper([{ pid, cpu: 99, command: "bun repro" }], new Map(), [], thresholds, state, api, () => false)

    expect(killSpy, "kill arm must not fire with reaperKillEnabled=false").not.toHaveBeenCalled()
    const escalations = broadcasts.filter((b) => b.type === "health:reaper:unclaimed")
    expect(escalations, "exactly one escalation broadcast").toHaveLength(1)
    expect(escalations[0]!.msg).toContain("auto-kill is disabled")
    expect(state.reaperSuspects.get(pid)?.escalated, "suspect stays tracked, marked escalated").toBe(true)

    // Second pass: still no kill, no duplicate escalation spam.
    await checkReaper([{ pid, cpu: 99, command: "bun repro" }], new Map(), [], thresholds, state, api, () => false)
    expect(killSpy).not.toHaveBeenCalled()
    expect(broadcasts.filter((b) => b.type === "health:reaper:unclaimed")).toHaveLength(1)
  })

  it("a claim still clears an escalated suspect", async () => {
    const pid = process.pid
    const state = stateAtKillPoint(pid)
    const { api } = makeApi()
    ;(api as unknown as { hasRecentMessage: () => boolean }).hasRecentMessage = () => true

    await checkReaper([{ pid, cpu: 99, command: "bun repro" }], new Map(), [], thresholds, state, api, () => false)
    expect(state.reaperSuspects.has(pid), "claimed suspect is dropped").toBe(false)
  })

  it("the claim query no longer threatens an automatic kill when the arm is off", async () => {
    const pid = process.pid
    const state = {
      reaperSuspects: new Map([
        [
          pid,
          { firstSeen: Date.now() - 3_600_000, samples: 3, asked: false, command: "bun repro", cpu: 99, etime: "60:00" },
        ],
      ]),
    } as unknown as AlertState
    const { api, broadcasts } = makeApi()

    await checkReaper([{ pid, cpu: 99, command: "bun repro" }], new Map(), [], thresholds, state, api, () => false)

    const queries = broadcasts.filter((b) => b.type === "health:reaper:query")
    expect(queries).toHaveLength(1)
    expect(queries[0]!.msg).not.toContain("will be killed")
  })
})
