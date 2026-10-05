/**
 * @failure  The supervisor spawns the adapter from its own location (shared main
 *           or a stale landing) rather than the landing root the daemon runs,
 *           and a cold start with no daemon either guesses a root or hangs past
 *           the host's MCP startup budget
 *           (27531; /hh/hub/rulings/27531-adapter-root-design-note-ruling-2026-10-05.md).
 * @level    l0 - pure policy over injected time and randomness
 * @consumer @i/4-supervision/27459-coordination-overhead-has-no-budget/27531-adapters-run-from-the-daemon-landing-root-learned-from-the-daemon-never-shared-main
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import {
  adapterEntryForRoot,
  CODE_ROOT_WAIT_BASE_MS,
  CODE_ROOT_WAIT_MAX_MS,
  codeRootWaitWindowMs,
  evaluateCodeRootWait,
  PLUGIN_CODE_ROOT_WINDOW_ENV,
  SUPERVISOR_CODE_ROOT_WINDOW_MS,
} from "../supervisor-policy.ts"

describe("SUPERVISOR_CODE_ROOT_WINDOW_MS", () => {
  it("covers a measured cold daemon start and stays under the host's startup budget", () => {
    // Measured 2026-10-05, 3/3: a cold tribe daemon answers cli_status in 149-156 ms.
    // The smallest numeric MCP startup default readable from the installed host
    // (Claude Code 2.1.289) is 1e4 ms; hh declares no MCP_TIMEOUT override.
    expect(SUPERVISOR_CODE_ROOT_WINDOW_MS).toBeGreaterThanOrEqual(1_000)
    expect(SUPERVISOR_CODE_ROOT_WINDOW_MS).toBeLessThan(10_000)
  })

  it("an explicit override wins; an absent or malformed one falls back to the measured default", () => {
    expect(codeRootWaitWindowMs({ [PLUGIN_CODE_ROOT_WINDOW_ENV]: "300" })).toBe(300)
    expect(codeRootWaitWindowMs({ [PLUGIN_CODE_ROOT_WINDOW_ENV]: "0" })).toBe(SUPERVISOR_CODE_ROOT_WINDOW_MS)
    expect(codeRootWaitWindowMs({ [PLUGIN_CODE_ROOT_WINDOW_ENV]: "soon" })).toBe(SUPERVISOR_CODE_ROOT_WINDOW_MS)
    expect(codeRootWaitWindowMs({})).toBe(SUPERVISOR_CODE_ROOT_WINDOW_MS)
  })
})

describe("evaluateCodeRootWait", () => {
  it("a cold start inside the window retries with a bounded, non-zero backoff", () => {
    const decision = evaluateCodeRootWait({ firstSpawn: true, waitedMs: 0, attempt: 1 }, {
      windowMs: 1_000,
      random: () => 0.5,
    })
    expect(decision).toMatchObject({ retry: true, giveUp: false })
    expect(decision.retryDelayMs).toBeGreaterThanOrEqual(CODE_ROOT_WAIT_BASE_MS)
    expect(decision.retryDelayMs).toBeLessThanOrEqual(CODE_ROOT_WAIT_MAX_MS)
  })

  it("a cold start that exhausts the window gives up, naming the window it waited", () => {
    const decision = evaluateCodeRootWait({ firstSpawn: true, waitedMs: 1_000, attempt: 9 }, {
      windowMs: 1_000,
      random: () => 0.5,
    })
    expect(decision.retry).toBe(false)
    expect(decision.giveUp).toBe(true)
    expect(decision.reason).toMatch(/1000 ms/)
  })

  it("a respawn never gives up for daemon absence, however long it waits", () => {
    const decision = evaluateCodeRootWait({ firstSpawn: false, waitedMs: 600_000, attempt: 500 }, {
      windowMs: 1_000,
      random: () => 0.5,
    })
    expect(decision).toMatchObject({ retry: true, giveUp: false })
  })
})

describe("adapterEntryForRoot", () => {
  it("is the adapter entry under the daemon's landing root", () => {
    expect(adapterEntryForRoot("/hh/dev-landings/abc")).toBe("/hh/dev-landings/abc/plugins/claude/server.ts")
  })

  it("refuses an absent or relative root by name instead of guessing shared main", () => {
    expect(() => adapterEntryForRoot(null)).toThrow(/refus/i)
    expect(() => adapterEntryForRoot("")).toThrow(/refus/i)
    expect(() => adapterEntryForRoot("vendor/tribe")).toThrow(/refus/i)
  })
})
