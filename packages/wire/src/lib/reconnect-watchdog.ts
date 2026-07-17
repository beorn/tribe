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

    // Disarm before handing control to a callback that normally exits the
    // adapter. This prevents a throwing test seam from firing twice.
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
