/**
 * Slow-request admission — which RPCs the daemon reports as slow, and why.
 *
 * The wire client gives up on a fixed 10s timer and reports only that the call
 * failed, so from the outside every wedge looks the same no matter which method
 * ate the event loop. On this host a stack walk cannot settle it either: yama
 * `ptrace_scope` and `perf_event_paranoid` block strace, perf and
 * /proc/PID/syscall, and Bun exposes no inspector port. The daemon's own log is
 * therefore the only evidence that survives a wedge, which makes "which method
 * was slow, and for how long" worth recording at the dispatch chokepoint.
 *
 * Long polls are excluded: `tribe.inbox.wait` and its CLI forms block until
 * work arrives or the caller's own timeout expires, so a long duration is the
 * contract rather than a symptom, and including them would bury the real signal
 * under one line per waiting seat.
 */

/**
 * Report at 2s — comfortably inside the client's 10s deadline, so a method that
 * is heading for a timeout is named before the client gives up, while ordinary
 * sub-second traffic stays silent.
 */
export const SLOW_REQUEST_LOG_MS = 2_000

export const LONG_POLL_METHODS: ReadonlySet<string> = new Set([
  "cli_inbox_wait",
  "cli_inbox_wait_by_launch_v1",
  "tribe.inbox.wait",
])

/** True when this request took long enough that the daemon should name it. */
export function shouldLogSlowRequest(
  method: string,
  elapsedMs: number,
  thresholdMs: number = SLOW_REQUEST_LOG_MS,
): boolean {
  if (LONG_POLL_METHODS.has(method)) return false
  return elapsedMs >= thresholdMs
}
