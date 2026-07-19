import { describe, expect, it } from "vitest"
import { ADAPTER_STABLE_MS, evaluateAdapterReexec } from "../supervisor-policy.ts"

describe("Claude plugin adapter re-exec budget", () => {
  it("stops a replacement that reaches the 60s reconnect watchdog instead of respawning forever", () => {
    expect(ADAPTER_STABLE_MS).toBeGreaterThan(60_000)
    expect(evaluateAdapterReexec(1, 60_000)).toEqual({ consecutiveReexecs: 2, retry: false })
  })

  it("re-arms one replacement after a genuinely stable adapter lifetime", () => {
    expect(evaluateAdapterReexec(1, ADAPTER_STABLE_MS)).toEqual({ consecutiveReexecs: 1, retry: true })
  })
})
