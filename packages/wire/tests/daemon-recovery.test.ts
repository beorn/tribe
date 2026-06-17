import { describe, expect, it } from "vitest"
import { shouldAttemptDaemonRecovery } from "../src/lib/daemon-recovery.ts"

describe("shouldAttemptDaemonRecovery (degraded-session reconnect throttle)", () => {
  const base = { daemonConnected: false, degraded: true, lastAttemptMs: 0, nowMs: 10_000, throttleMs: 5_000 }

  it("never recovers when already connected", () => {
    expect(shouldAttemptDaemonRecovery({ ...base, daemonConnected: true })).toBe(false)
  })

  it("never recovers when not degraded (initial connect still pending or succeeded)", () => {
    expect(shouldAttemptDaemonRecovery({ ...base, degraded: false })).toBe(false)
  })

  it("recovers when degraded and the throttle window has elapsed", () => {
    expect(shouldAttemptDaemonRecovery({ ...base, lastAttemptMs: 0, nowMs: 6_000, throttleMs: 5_000 })).toBe(true)
  })

  it("does NOT recover again within the throttle window", () => {
    expect(shouldAttemptDaemonRecovery({ ...base, lastAttemptMs: 4_000, nowMs: 6_000, throttleMs: 5_000 })).toBe(false)
  })

  it("recovers on the first degraded call (no prior attempt)", () => {
    expect(shouldAttemptDaemonRecovery({ ...base, lastAttemptMs: 0, nowMs: 5_000, throttleMs: 5_000 })).toBe(true)
  })
})
