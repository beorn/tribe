import { afterEach, describe, expect, it, vi } from "vitest"
import { createReconnectWatchdog } from "../src/lib/reconnect-watchdog.ts"
import { createTimers } from "../src/timers.ts"

describe("stdio bridge reconnect watchdog", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("requests supervised replacement only after 60s reconnecting while a fresh daemon probe succeeds", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-17T03:00:00.000Z"))
    const ac = new AbortController()
    const probeDaemon = vi.fn(async () => true)
    const onStuck = vi.fn()
    const watchdog = createReconnectWatchdog({
      timers: createTimers(ac.signal),
      thresholdMs: 60_000,
      retryMs: 5_000,
      now: () => Date.now(),
      probeDaemon,
      onStuck,
    })

    watchdog.markReconnecting()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(probeDaemon).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(probeDaemon).toHaveBeenCalledTimes(1)
    expect(onStuck).toHaveBeenCalledWith(expect.objectContaining({ reconnectingMs: 60_000 }))
    ac.abort()
  })

  it("keeps probing while the daemon is unavailable, then fires when a fresh probe succeeds", async () => {
    vi.useFakeTimers()
    const ac = new AbortController()
    const probeDaemon = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const onStuck = vi.fn()
    const watchdog = createReconnectWatchdog({
      timers: createTimers(ac.signal),
      thresholdMs: 60_000,
      retryMs: 5_000,
      now: () => Date.now(),
      probeDaemon,
      onStuck,
    })

    watchdog.markReconnecting()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(probeDaemon).toHaveBeenCalledTimes(1)
    expect(onStuck).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(probeDaemon).toHaveBeenCalledTimes(2)
    expect(onStuck).toHaveBeenCalledOnce()
    ac.abort()
  })

  it("cancels a pending successful probe when registration recovers first", async () => {
    vi.useFakeTimers()
    const ac = new AbortController()
    let resolveProbe!: (value: boolean) => void
    const probeDaemon = vi.fn(() => new Promise<boolean>((resolve) => (resolveProbe = resolve)))
    const onStuck = vi.fn()
    const watchdog = createReconnectWatchdog({
      timers: createTimers(ac.signal),
      thresholdMs: 60_000,
      retryMs: 5_000,
      now: () => Date.now(),
      probeDaemon,
      onStuck,
    })

    watchdog.markReconnecting()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(probeDaemon).toHaveBeenCalledOnce()
    watchdog.markConnected()
    resolveProbe(true)
    await Promise.resolve()
    expect(onStuck).not.toHaveBeenCalled()
    ac.abort()
  })

  it("keeps the armed window while shouldFire is false, then fires once it lifts (29162 #4)", async () => {
    vi.useFakeTimers()
    const ac = new AbortController()
    const probeDaemon = vi.fn(async () => true)
    const onStuck = vi.fn()
    let suppressed = true
    const watchdog = createReconnectWatchdog({
      timers: createTimers(ac.signal),
      thresholdMs: 60_000,
      retryMs: 5_000,
      now: () => Date.now(),
      probeDaemon,
      shouldFire: () => !suppressed,
      onStuck,
    })

    watchdog.markReconnecting()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(probeDaemon).toHaveBeenCalledTimes(1)
    expect(onStuck).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(probeDaemon).toHaveBeenCalledTimes(2)
    expect(onStuck).not.toHaveBeenCalled()

    suppressed = false
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onStuck).toHaveBeenCalledOnce()
    expect(onStuck).toHaveBeenCalledWith(expect.objectContaining({ reconnectingMs: 70_000 }))
    ac.abort()
  })
})
