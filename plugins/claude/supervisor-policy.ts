/** Longer than the adapter's 60s fresh-daemon reconnect watchdog. */
export const ADAPTER_STABLE_MS = 90_000
const REEXEC_BACKOFF_BASE_MS = 250
export const REEXEC_BACKOFF_MAX_MS = 30_000
const REEXEC_BACKOFF_MIN_JITTER_RATIO = 0.75

export function evaluateAdapterRestart(
  previousConsecutiveReexecs: number,
  childRuntimeMs: number,
  maxConsecutiveReexecs = Number.POSITIVE_INFINITY,
  randomUnit = Math.random(),
): { consecutiveReexecs: number; retry: boolean; retryDelayMs: number } {
  const prior = childRuntimeMs >= ADAPTER_STABLE_MS ? 0 : previousConsecutiveReexecs
  const consecutiveReexecs = Math.min(prior + 1, Number.MAX_SAFE_INTEGER)
  const retry = consecutiveReexecs <= maxConsecutiveReexecs
  if (!retry) return { consecutiveReexecs, retry, retryDelayMs: 0 }

  const cappedBackoffMs = Math.min(REEXEC_BACKOFF_BASE_MS * 2 ** (consecutiveReexecs - 1), REEXEC_BACKOFF_MAX_MS)
  const boundedRandomUnit = Math.min(1, Math.max(0, randomUnit))
  const jitterRatio = REEXEC_BACKOFF_MIN_JITTER_RATIO + (1 - REEXEC_BACKOFF_MIN_JITTER_RATIO) * boundedRandomUnit
  const retryDelayMs = Math.round(cappedBackoffMs * jitterRatio)
  return { consecutiveReexecs, retry, retryDelayMs }
}
