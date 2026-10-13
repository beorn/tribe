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
  it("covers the measured restart-to-publish tail and stays under the host's startup budget (28920)", () => {
    // The window has to survive a daemon RESTART, not just a cold boot. Measured 2026-10-13 over 128 wire restarts
    // (the daemon's own stdout, shutdown -> "tribe:socket Listening on", /hh/main.hab/run/sessions/wire/habcp.log):
    // p50 4 s, p90 6 s, p99 8 s, max 8 s. The pairs are second-resolution, so the three logged at 8 s span 8.0-8.9 s
    // and the bucket the window must cover is 9000: four intervals EXCEEDED 6000 ms. That the four would each have
    // become a give-up is not proven by the gaps alone - a respawn is unbounded and start offsets vary - so 8000 is
    // the negative control below, not an accepted value.
    // Ceiling: the smallest host-side MCP startup budget substantiated is 1e4 ms (Claude Code 2.1.296's plugin-sync
    // MCP path, CLAUDE_CODE_SYNC_PLUGINS_MCP_TIMEOUT_MS ?? 1e4); codex and cursor declare no readable default.
    expect(SUPERVISOR_CODE_ROOT_WINDOW_MS).toBeGreaterThanOrEqual(9_000)
    expect(SUPERVISOR_CODE_ROOT_WINDOW_MS).toBeLessThan(10_000)
    // Negative control (RED as 8000): the quantized 8 s bucket is 8.0-8.9 s, so 8000 still misses it.
    expect(8_000).toBeLessThan(SUPERVISOR_CODE_ROOT_WINDOW_MS)
  })

  it("an explicit override wins; an absent or malformed one falls back to the measured default", () => {
    expect(codeRootWaitWindowMs({ [PLUGIN_CODE_ROOT_WINDOW_ENV]: "300" })).toBe(300)
    expect(codeRootWaitWindowMs({ [PLUGIN_CODE_ROOT_WINDOW_ENV]: "0" })).toBe(SUPERVISOR_CODE_ROOT_WINDOW_MS)
    expect(codeRootWaitWindowMs({ [PLUGIN_CODE_ROOT_WINDOW_ENV]: "soon" })).toBe(SUPERVISOR_CODE_ROOT_WINDOW_MS)
    expect(codeRootWaitWindowMs({})).toBe(SUPERVISOR_CODE_ROOT_WINDOW_MS)
  })

  it("a present but malformed override warns once, naming the bad value and the default (27531)", () => {
    const lines: string[] = []
    expect(codeRootWaitWindowMs({ [PLUGIN_CODE_ROOT_WINDOW_ENV]: "soon" }, (line) => lines.push(line))).toBe(
      SUPERVISOR_CODE_ROOT_WINDOW_MS,
    )
    expect(lines).toEqual([
      `tribe plugin supervisor: ${PLUGIN_CODE_ROOT_WINDOW_ENV}="soon" is not a positive integer; using the default ${SUPERVISOR_CODE_ROOT_WINDOW_MS} ms`,
    ])
    const zero: string[] = []
    expect(codeRootWaitWindowMs({ [PLUGIN_CODE_ROOT_WINDOW_ENV]: "0" }, (line) => zero.push(line))).toBe(
      SUPERVISOR_CODE_ROOT_WINDOW_MS,
    )
    expect(zero).toEqual([
      `tribe plugin supervisor: ${PLUGIN_CODE_ROOT_WINDOW_ENV}="0" is not a positive integer; using the default ${SUPERVISOR_CODE_ROOT_WINDOW_MS} ms`,
    ])
  })

  it("a valid override and an absent one warn nothing (27531)", () => {
    const lines: string[] = []
    expect(codeRootWaitWindowMs({ [PLUGIN_CODE_ROOT_WINDOW_ENV]: "300" }, (line) => lines.push(line))).toBe(300)
    expect(codeRootWaitWindowMs({}, (line) => lines.push(line))).toBe(SUPERVISOR_CODE_ROOT_WINDOW_MS)
    expect(lines).toEqual([])
  })
})

describe("evaluateCodeRootWait", () => {
  it("a cold start inside the window retries with a bounded, non-zero backoff", () => {
    const decision = evaluateCodeRootWait(
      { firstSpawn: true, waitedMs: 0, attempt: 1 },
      {
        windowMs: 1_000,
        random: () => 0.5,
      },
    )
    expect(decision).toMatchObject({ retry: true, giveUp: false })
    expect(decision.retryDelayMs).toBeGreaterThanOrEqual(CODE_ROOT_WAIT_BASE_MS)
    expect(decision.retryDelayMs).toBeLessThanOrEqual(CODE_ROOT_WAIT_MAX_MS)
  })

  it("a cold start that exhausts the window gives up, naming the window it waited", () => {
    const decision = evaluateCodeRootWait(
      { firstSpawn: true, waitedMs: 1_000, attempt: 9 },
      {
        windowMs: 1_000,
        random: () => 0.5,
      },
    )
    expect(decision.retry).toBe(false)
    expect(decision.giveUp).toBe(true)
    expect(decision.reason).toMatch(/1000 ms/)
  })

  it("a respawn never gives up for daemon absence, however long it waits", () => {
    const decision = evaluateCodeRootWait(
      { firstSpawn: false, waitedMs: 600_000, attempt: 500 },
      {
        windowMs: 1_000,
        random: () => 0.5,
      },
    )
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
