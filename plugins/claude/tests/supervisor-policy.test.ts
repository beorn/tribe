import { describe, expect, it } from "vitest"
import { ADAPTER_STABLE_MS, evaluateAdapterReexec } from "../supervisor-policy.ts"

describe("Claude plugin adapter re-exec budget", () => {
  it("allows a second quick re-exec when two legitimate daemon generations arrive in one restart burst", () => {
    expect(evaluateAdapterReexec(1, 10_000)).toEqual({
      consecutiveReexecs: 2,
      retry: true,
      retryDelayMs: 500,
    })
  })

  it("keeps non-generation re-exec failures on the one-retry fail-loud path", () => {
    expect(evaluateAdapterReexec(1, 10_000, 1)).toEqual({
      consecutiveReexecs: 2,
      retry: false,
      retryDelayMs: 0,
    })
  })

  it("still bounds a persistently re-executing adapter", () => {
    let consecutiveReexecs = 0
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const decision = evaluateAdapterReexec(consecutiveReexecs, 10_000)
      expect(decision).toEqual({
        consecutiveReexecs: attempt,
        retry: true,
        retryDelayMs: Math.min(250 * 2 ** (attempt - 1), 4_000),
      })
      consecutiveReexecs = decision.consecutiveReexecs
    }
    expect(evaluateAdapterReexec(consecutiveReexecs, 10_000)).toEqual({
      consecutiveReexecs: 6,
      retry: false,
      retryDelayMs: 0,
    })
  })

  it("re-arms one replacement after a genuinely stable adapter lifetime", () => {
    expect(ADAPTER_STABLE_MS).toBeGreaterThan(60_000)
    expect(evaluateAdapterReexec(1, ADAPTER_STABLE_MS)).toEqual({
      consecutiveReexecs: 1,
      retry: true,
      retryDelayMs: 250,
    })
  })
})
