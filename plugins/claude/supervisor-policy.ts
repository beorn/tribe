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

export const PROVIDER_PARENT_REMEDY =
  "tribe plugin wrapper requires valid provider-parent provenance from a complete live managed launch; restart the host session or reinstall the Tribe plugin."
export const LEGACY_PARENT_WARNING =
  "tribe plugin wrapper: managed launch supplied no provider-parent PID; falling back to the wrapper's real provider parent. Relaunch the host session to restore full launch provenance."

/**
 * The provider parent this wrapper reports as its launch owner. A managed launch names itself by TRIBE_LAUNCH_ID, or,
 * once it registered by the seat's token (25074 3c-2b, @cto def441bf), by HAB_ID_TOKEN alone: the launcher projects no
 * launch id then. An ABSENT parent PID is indistinguishable from a standalone install or a host launched before the
 * bootstrap started injecting it, so it falls back to the wrapper's real provider parent, loudly for a managed launch,
 * never silently. Rejecting it would strand every already-running seat: a host's env is fixed at launch, so the only
 * remedy is relaunching every seat. A SUPPLIED parent PID without a managed identity, or an invalid one, is a genuine
 * incomplete tuple and throws.
 */
export function resolveProviderParentPid(
  env: NodeJS.ProcessEnv,
  self: { readonly pid: number; readonly ppid: number },
  processExists: (pid: number) => boolean,
  warn: (line: string) => void,
): number {
  const raw = env.TRIBE_PLUGIN_PROVIDER_PARENT_PID?.trim() ?? ""
  const managed = (env.TRIBE_LAUNCH_ID?.trim() ?? "").length > 0 || (env.HAB_ID_TOKEN?.trim() ?? "").length > 0
  if (raw.length === 0) {
    if (managed) warn(LEGACY_PARENT_WARNING)
    return self.ppid
  }
  const pid = Number(raw)
  if (!managed || !/^[1-9]\d*$/u.test(raw) || !Number.isSafeInteger(pid) || pid === self.pid || !processExists(pid)) {
    throw new Error(PROVIDER_PARENT_REMEDY)
  }
  return pid
}
