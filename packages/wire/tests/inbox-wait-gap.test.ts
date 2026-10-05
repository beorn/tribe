/**
 * @failure  the retry backoff, gap budget, pre-first-success grace and deadline
 *           bounds are re-implemented per cli_inbox_wait caller and drift, so a
 *           promotion restart is retried by one consumer and ends another
 *           terminally (27397 Change 2 / #27416)
 * @level    l0 - pure state machine over an injected clock, no daemon or socket
 * @consumer @i/4-supervision/27416-tribe-wire-inboxwait-retry-vs-fail
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { InboxWaitGapController, type InboxWaitGapAction } from "../src/lib/inbox-wait-gap.ts"

const coded = (code: string, message = code): Error => Object.assign(new Error(message), { code })
const terminal = (action: InboxWaitGapAction): Extract<InboxWaitGapAction, { action: "terminal" }> => {
  if (action.action !== "terminal") throw new Error(`expected a terminal action, got ${action.action}`)
  return action
}
const sleepMs = (action: InboxWaitGapAction): number => {
  if (action.action !== "sleep") throw new Error(`expected a sleep action, got ${action.action}`)
  return action.ms
}

describe("InboxWaitGapController", () => {
  it("proceeds on the first call even with no time left, then stops at the deadline (slack 0)", () => {
    let now = 1_000
    const gap = new InboxWaitGapController({
      deadlineMs: 1_000,
      monotonicNow: () => now,
      backoff: { kind: "fixed", intervalMs: 250 },
    })

    expect(gap.beforeCall()).toEqual({ proceed: true, remainingMs: 0 })
    now = 1_000
    expect(gap.beforeCall()).toEqual({ proceed: false, reason: "deadline" })
  })

  it("reports the remaining time before the deadline", () => {
    let now = 0
    const gap = new InboxWaitGapController({
      deadlineMs: 30_000,
      monotonicNow: () => now,
      backoff: { kind: "fixed", intervalMs: 250 },
    })
    now = 12_000
    expect(gap.beforeCall()).toEqual({ proceed: true, remainingMs: 18_000 })
  })

  it("grows the delay exponentially and caps it, then resets on success", () => {
    let now = 0
    const gap = new InboxWaitGapController({
      deadlineMs: 1_000_000,
      monotonicNow: () => now,
      backoff: { kind: "exponential", initialMs: 250, capMs: 5_000 },
    })

    const delays: number[] = []
    for (let i = 0; i < 7; i += 1) {
      delays.push(sleepMs(gap.afterError(coded("ECONNRESET"))))
      now += 1
    }
    expect(delays).toEqual([250, 500, 1_000, 2_000, 4_000, 5_000, 5_000])

    gap.afterSuccess()
    now += 1
    expect(sleepMs(gap.afterError(coded("ECONNRESET")))).toBe(250)
  })

  it("keeps a fixed retry interval regardless of consecutive gaps", () => {
    let now = 0
    const gap = new InboxWaitGapController({
      deadlineMs: 1_000_000,
      monotonicNow: () => now,
      backoff: { kind: "fixed", intervalMs: 250 },
    })
    for (let i = 0; i < 5; i += 1) {
      expect(sleepMs(gap.afterError(coded("ENOENT")))).toBe(250)
      now += 1
    }
  })

  it("throws a non-retryable error immediately, without sleeping", () => {
    const gap = new InboxWaitGapController({
      deadlineMs: 1_000_000,
      monotonicNow: () => 0,
      backoff: { kind: "fixed", intervalMs: 250 },
    })
    const real = coded("EACCES")
    expect(() => gap.afterError(real)).toThrow(real)
  })

  it("stops on the deadline, at slack 0 for the CLI and at the retry interval for the seat", () => {
    const cli = new InboxWaitGapController({
      deadlineMs: 10_000,
      monotonicNow: () => 10_000,
      backoff: { kind: "exponential", initialMs: 250, capMs: 5_000 },
    })
    expect(terminal(cli.afterError(coded("ECONNRESET"))).reason).toBe("deadline")

    const seat = new InboxWaitGapController({
      deadlineMs: 10_250,
      monotonicNow: () => 10_000,
      backoff: { kind: "fixed", intervalMs: 250 },
      deadlineSlackMs: 250,
    })
    // remaining 250 <= slack 250: the retry could not finish before the deadline.
    expect(terminal(seat.afterError(coded("ECONNRESET"))).reason).toBe("deadline")
  })

  it("stops once the total gap age reaches the gap budget", () => {
    let now = 0
    const gap = new InboxWaitGapController({
      deadlineMs: 1_000_000,
      monotonicNow: () => now,
      backoff: { kind: "fixed", intervalMs: 250 },
      gapBudgetMs: 1_000,
    })
    now = 750
    expect(sleepMs(gap.afterError(coded("ECONNRESET")))).toBe(250)
    // The gap opened at 750, so 1_000ms of gap age is reached at 1_750.
    now = 1_750
    const action = terminal(gap.afterError(coded("ECONNRESET")))
    expect(action.reason).toBe("gap-budget")
    expect(action.gapAgeMs).toBe(1_000)
    expect(action.kind).toBe("transport-close")
  })

  it("applies the absent-daemon grace only before the first success", () => {
    let now = 0
    const gap = new InboxWaitGapController({
      deadlineMs: 1_000_000,
      monotonicNow: () => now,
      backoff: { kind: "exponential", initialMs: 250, capMs: 5_000 },
      unavailableGraceMs: 2_000,
    })

    now = 500
    expect(sleepMs(gap.afterError(coded("ENOENT")))).toBe(250)
    // The absence grace began at 500, so 2_000ms of it is reached at 2_500.
    now = 2_500
    expect(terminal(gap.afterError(coded("ENOENT"))).reason).toBe("unavailable-grace")

    // A success disarms the grace: a later absence is a fresh, bounded retry.
    gap.afterSuccess()
    now = 10_000
    expect(sleepMs(gap.afterError(coded("ENOENT")))).toBe(250)
    now = 10_500
    expect(sleepMs(gap.afterError(coded("ENOENT")))).toBe(500)
  })

  it("clears the absence grace on a non-absent gap, as the CLI did", () => {
    let now = 0
    const gap = new InboxWaitGapController({
      deadlineMs: 1_000_000,
      monotonicNow: () => now,
      backoff: { kind: "exponential", initialMs: 250, capMs: 5_000 },
      unavailableGraceMs: 2_000,
    })
    now = 0
    expect(sleepMs(gap.afterError(coded("ENOENT")))).toBe(250)
    now = 1_500
    expect(sleepMs(gap.afterError(coded("ECONNRESET")))).toBe(500)
    now = 1_800
    // The grace restarts here; without the clear it would fire at 2_000.
    expect(sleepMs(gap.afterError(coded("ENOENT")))).toBe(1_000)
    now = 3_000
    expect(sleepMs(gap.afterError(coded("ENOENT")))).toBe(2_000)
  })

  it("reports a closed gap once, with its age, and then reports no recovery", () => {
    let now = 0
    const gap = new InboxWaitGapController({
      deadlineMs: 1_000_000,
      monotonicNow: () => now,
      backoff: { kind: "fixed", intervalMs: 250 },
    })
    expect(gap.afterSuccess()).toEqual({ recovered: false, gapAgeMs: 0 })
    now = 0
    gap.afterError(coded("ECONNRESET"))
    now = 400
    expect(gap.afterSuccess()).toEqual({ recovered: true, gapAgeMs: 400 })
    now = 500
    expect(gap.afterSuccess()).toEqual({ recovered: false, gapAgeMs: 0 })
  })

  it("clamps a retry delay to the time left before the deadline", () => {
    let now = 0
    const gap = new InboxWaitGapController({
      deadlineMs: 300,
      monotonicNow: () => now,
      backoff: { kind: "exponential", initialMs: 250, capMs: 5_000 },
    })
    now = 100
    expect(sleepMs(gap.afterError(coded("ECONNRESET")))).toBe(200)
  })
})
