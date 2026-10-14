import type { ManagedTimers } from "../timers.ts"

export type ReconnectWatchdog = {
  /** Idempotently arm from the first observed disconnect. */
  markReconnecting(): void
  /** Cancel after a successful daemon registration. */
  markConnected(): void
}

export function createReconnectWatchdog(opts: {
  timers: Pick<ManagedTimers, "setTimeout" | "clearTimeout">
  thresholdMs: number
  retryMs: number
  now: () => number
  probeDaemon: () => Promise<boolean>
  /**
   * 29162 — an optional gate consulted only at the moment a fire is due, after a
   * fresh probe has already succeeded. When it returns false the fire is deferred
   * and the armed window is KEPT (the watchdog re-probes after retryMs) rather than
   * consumed: a decision that a replacement must wait (e.g. a daemon generation
   * change is in flight and its own paced re-exec owns the reconnect) must not burn
   * the last armed window, which is what left seats dark at 17:01:15.
   */
  shouldFire?: () => boolean
  onStuck: (evidence: { reconnectingMs: number }) => void
}): ReconnectWatchdog {
  const thresholdMs = Math.max(0, opts.thresholdMs)
  const retryMs = Math.max(1, opts.retryMs)
  let reconnectingSince: number | null = null
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null

  function clearTimer(): void {
    if (timer === null) return
    opts.timers.clearTimeout(timer)
    timer = null
  }

  function schedule(ms: number): void {
    clearTimer()
    timer = opts.timers.setTimeout(() => {
      timer = null
      void inspect()
    }, ms)
  }

  async function inspect(): Promise<void> {
    const startedAt = reconnectingSince
    if (startedAt === null) return
    const reconnectingMs = Math.max(0, opts.now() - startedAt)
    if (reconnectingMs < thresholdMs) {
      schedule(thresholdMs - reconnectingMs)
      return
    }

    let daemonAnswersFreshConnections = false
    try {
      daemonAnswersFreshConnections = await opts.probeDaemon()
    } catch {
      // Probe failure is the expected daemon-down state. Keep the invariant
      // armed; a later healthy fresh connection is the actionable contrast.
    }
    if (reconnectingSince !== startedAt) return
    if (!daemonAnswersFreshConnections) {
      schedule(retryMs)
      return
    }

    // 29162 (#4): defer without consuming — stay armed and re-check after retryMs.
    if (opts.shouldFire !== undefined && !opts.shouldFire()) {
      schedule(retryMs)
      return
    }

    reconnectingSince = null
    clearTimer()
    opts.onStuck({ reconnectingMs })
  }

  return {
    markReconnecting() {
      if (reconnectingSince !== null) return
      reconnectingSince = opts.now()
      schedule(thresholdMs)
    },
    markConnected() {
      reconnectingSince = null
      clearTimer()
    },
  }
}
