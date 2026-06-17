/**
 * daemon-recovery — the throttle decision for a degraded session re-attempting
 * its daemon connection.
 *
 * The MCP stdio adapter's reconnect loop (createReconnectingClient) only fires
 * after a SUCCESSFUL connect. An *initial*-connect failure — e.g. a transient
 * ECONNREFUSED while the socket was being churned during a startup herd, or the
 * daemon being briefly down at launch — therefore leaves the session
 * permanently solo: every tribe tool call returns the "running solo" degrade
 * message and nothing ever retries (the 19851 "loud but soft" path suppressed
 * actionable reconnect). This is exactly the "active-pane-no-tribe" symptom seen
 * from the agent side.
 *
 * The fix: on a degraded tool call, re-attempt the connect — but throttled, so a
 * daemon that is genuinely down is not spawned/hammered on every single call.
 * This pure predicate is the throttle gate; the adapter owns the wiring.
 */

export interface DaemonRecoveryState {
  /** True once a daemon client is established (no recovery needed). */
  daemonConnected: boolean
  /** True once an earlier connect attempt failed (the degrade was armed). */
  degraded: boolean
  /** Wall-clock ms of the last recovery attempt (0 = none yet). */
  lastAttemptMs: number
  /** Now, in wall-clock ms. */
  nowMs: number
  /** Minimum gap between recovery attempts. */
  throttleMs: number
}

/**
 * Decide whether a degraded session should re-attempt the daemon connect now.
 *
 * - Already connected → never (nothing to recover).
 * - Not degraded → never (the initial attempt is still pending or succeeded;
 *   callers `await` the in-flight connect rather than starting a competing one).
 * - Degraded → yes, but only once the throttle window has elapsed since the
 *   last attempt.
 */
export function shouldAttemptDaemonRecovery(state: DaemonRecoveryState): boolean {
  if (state.daemonConnected) return false
  if (!state.degraded) return false
  return state.nowMs - state.lastAttemptMs >= state.throttleMs
}
