/**
 * @ag/tribe/21052/19442-r2 — per-name session announce debounce.
 *
 * The startup suppress window (`suppressWindowMs` after daemon start) stops
 * hot-reload reconnect storms, but a CHURNING seat — an adapter crash-looping
 * or repeatedly reconnecting (the @agent/7 storm; @chief's 2026-07-10 churn:
 * 161 join/leave broadcasts in 12h, chief-name peaks of 10/hour) — rebroadcasts
 * "<name> joined/left" to every member on every cycle once that window passes.
 * The journal keeps full fidelity via `event.session.joined` rows; only the
 * `*`-broadcast channel copy needs coalescing.
 *
 * The gate is a per-name SLIDING window over the existing `suppressWindowMs`
 * knob (no new option): the first announce for a name passes; further
 * join/left announces for the SAME name inside the window are suppressed, and
 * every attempt — suppressed or not — re-arms the window, so a seat churning
 * faster than the window stays silent until it stabilizes.
 */
import { describe, expect, test } from "vitest"
import { createSessionAnnounceGate } from "./with-dispatcher.ts"

describe("createSessionAnnounceGate — per-name sliding announce window", () => {
  test("first announce for a name passes; a repeat inside the window is suppressed", () => {
    const gate = createSessionAnnounceGate(10_000)
    expect(gate("@agent/4", 1_000)).toBe(true)
    expect(gate("@agent/4", 5_000)).toBe(false)
  })

  test("a repeat after the window has fully elapsed announces again", () => {
    const gate = createSessionAnnounceGate(10_000)
    expect(gate("@agent/4", 1_000)).toBe(true)
    expect(gate("@agent/4", 12_000)).toBe(true)
  })

  test("SLIDING window: churn faster than the window stays silent until the seat stabilizes", () => {
    const gate = createSessionAnnounceGate(10_000)
    expect(gate("@chief", 0)).toBe(true)
    // rejoin/leave every 5s — each attempt re-arms the window, none announce
    expect(gate("@chief", 5_000)).toBe(false)
    expect(gate("@chief", 10_000)).toBe(false)
    expect(gate("@chief", 15_000)).toBe(false)
    // silence for a full window → the next event announces
    expect(gate("@chief", 26_000)).toBe(true)
  })

  test("distinct names have independent windows", () => {
    const gate = createSessionAnnounceGate(10_000)
    expect(gate("@agent/1", 1_000)).toBe(true)
    expect(gate("@agent/2", 2_000)).toBe(true)
    expect(gate("@agent/1", 3_000)).toBe(false)
  })

  test("windowMs <= 0 disables the gate entirely (TRIBE_NO_SUPPRESS parity)", () => {
    const gate = createSessionAnnounceGate(0)
    expect(gate("@agent/4", 1_000)).toBe(true)
    expect(gate("@agent/4", 1_001)).toBe(true)
  })
})
