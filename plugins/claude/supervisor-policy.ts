/** Longer than the adapter's 60s fresh-daemon reconnect watchdog. */
export const ADAPTER_STABLE_MS = 90_000

export function evaluateAdapterReexec(
  previousConsecutiveReexecs: number,
  childRuntimeMs: number,
): { consecutiveReexecs: number; retry: boolean } {
  const prior = childRuntimeMs >= ADAPTER_STABLE_MS ? 0 : previousConsecutiveReexecs
  const consecutiveReexecs = prior + 1
  return { consecutiveReexecs, retry: consecutiveReexecs <= 1 }
}
