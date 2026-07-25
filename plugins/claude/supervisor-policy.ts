/** Longer than the adapter's 60s fresh-daemon reconnect watchdog. */
export const ADAPTER_STABLE_MS = 90_000
const MAX_CONSECUTIVE_REEXECS = 5
const REEXEC_BACKOFF_BASE_MS = 250
const REEXEC_BACKOFF_MAX_MS = 4_000

export function evaluateAdapterReexec(
  previousConsecutiveReexecs: number,
  childRuntimeMs: number,
): { consecutiveReexecs: number; retry: boolean; retryDelayMs: number } {
  const prior = childRuntimeMs >= ADAPTER_STABLE_MS ? 0 : previousConsecutiveReexecs
  const consecutiveReexecs = prior + 1
  const retry = consecutiveReexecs <= MAX_CONSECUTIVE_REEXECS
  const retryDelayMs = retry
    ? Math.min(REEXEC_BACKOFF_BASE_MS * 2 ** (consecutiveReexecs - 1), REEXEC_BACKOFF_MAX_MS)
    : 0
  return { consecutiveReexecs, retry, retryDelayMs }
}
