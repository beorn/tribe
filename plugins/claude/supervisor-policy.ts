import { decorrelatedJitter, type RandomUnit } from "@bearly/pacing"
import { isAbsolute, join } from "node:path"
import { HAB_ID_TOKEN_ENV, HAB_ID_TOKEN_FILE_ENV } from "tribe-wire/lib/hab-session-env"
import { TRIBE_PLUGIN_PROVIDER_PARENT_PID_ENV } from "tribe-wire/lib/session-identity-env"

/** Longer than the adapter's 60s fresh-daemon reconnect watchdog. */
export const ADAPTER_STABLE_MS = 90_000
export const REEXEC_BACKOFF_BASE_MS = 250
export const REEXEC_BACKOFF_MAX_MS = 30_000

/**
 * The window a COLD START waits for the daemon to publish the landing root it runs from (27531). It must cover a
 * daemon RESTART and stay shorter than the host's MCP startup timeout, because the host is waiting on this
 * supervisor for its MCP handshake and the adapter spawn plus handshake still have to fit inside what remains.
 *
 * Two measurements, deliberately apart. A cold `tribe-daemon --socket <tmp>` answers `cli_status` in 149-156 ms
 * (measured 2026-10-05, 3/3, /hh/var/@dev/luna6/27531/measure-daemon-cold-start.ts): that is the daemon's own boot,
 * and it is not what this window waits through. What it waits through is a restart: measured 2026-10-13 over 128
 * wire restarts (39 h of the daemon's own stdout, shutdown -> `tribe:socket Listening on`,
 * /hh/main.hab/run/sessions/wire/habcp.log), the gap is p50 4 s, p90 6 s, p99 8 s, max 8 s (28920). Two limits on
 * reading that. The pairs are second-resolution, so the three logged at 8 s span 8.0-8.9 s and the bucket to cover is
 * 9000, not 8000. And the gaps establish only that four intervals EXCEEDED the old 6000 ms — not that four cold
 * starts actually gave up, because a respawn between them is unbounded and start offsets vary. It is that give-up
 * that leaves a cursor seat dark, which is why this covers the whole measured range and not the top of it.
 *
 * The ceiling is harness-owned, and only one of the three hosts states it. Read 2026-10-13 from the installed hosts:
 * Claude Code 2.1.296 carries MCP_TIMEOUT (default 30) and CLAUDE_CODE_SYNC_PLUGINS_MCP_TIMEOUT_MS ?? 1e4 ms = 10 s
 * on its plugin-sync MCP path; codex exposes startup_timeout_sec / startup_timeout_ms on its MCP server config but
 * its default is not readable from the binary; cursor-agent 2026.10.01 declares none for the tribe server. So 10 s
 * is the smallest ceiling actually substantiated, and this window covers the measured 8 s maximum while staying 1 s
 * under it. What that 1 s has to hold is the adapter spawn and handshake AFTER the wait: 40/40 attempts answered,
 * p99 = max = 180 ms (/hh/var/@dev/luna6/28920/measure-adapter-handshake.ts, 28920) — measured in isolation with the
 * daemon already up, so the fleet-load tail of that path is NOT measured and this margin is its only cover. A respawn
 * is NOT bounded by this window at all: see evaluateCodeRootWait.
 */
export const SUPERVISOR_CODE_ROOT_WINDOW_MS = 9_000
export const CODE_ROOT_WAIT_BASE_MS = 250
export const CODE_ROOT_WAIT_MAX_MS = 2_000
/** Test/ops override for the cold-start window; an absent value falls back silently, a malformed one warns. */
export const PLUGIN_CODE_ROOT_WINDOW_ENV = "TRIBE_PLUGIN_CODE_ROOT_WINDOW_MS"

export function codeRootWaitWindowMs(env: Readonly<NodeJS.ProcessEnv>, warn?: (line: string) => void): number {
  const raw = env[PLUGIN_CODE_ROOT_WINDOW_ENV]?.trim()
  if (raw === undefined || raw === "") return SUPERVISOR_CODE_ROOT_WINDOW_MS
  const parsed = Number(raw)
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
  warn?.(
    `tribe plugin supervisor: ${PLUGIN_CODE_ROOT_WINDOW_ENV}=${JSON.stringify(raw)} is not a positive integer; using the default ${SUPERVISOR_CODE_ROOT_WINDOW_MS} ms`,
  )
  return SUPERVISOR_CODE_ROOT_WINDOW_MS
}

export interface CodeRootWaitDecision {
  readonly retry: boolean
  readonly giveUp: boolean
  readonly retryDelayMs: number
  readonly reason: string
}

/**
 * How long the supervisor waits for the daemon to answer with a landing root. A COLD START gives up after the
 * window, so the host gets a decided refusal instead of a hang; a RESPAWN never gives up, because the host's MCP
 * endpoint must survive a daemon that is merely restarting.
 */
export function evaluateCodeRootWait(
  input: { readonly firstSpawn: boolean; readonly waitedMs: number; readonly attempt: number },
  opts: { readonly windowMs: number; readonly random?: RandomUnit },
): CodeRootWaitDecision {
  if (input.firstSpawn && input.waitedMs >= opts.windowMs) {
    return {
      retry: false,
      giveUp: true,
      retryDelayMs: 0,
      reason: `the daemon published no code root within ${opts.windowMs} ms of the cold start`,
    }
  }
  const random = opts.random ?? Math.random
  const previous = Math.max(
    CODE_ROOT_WAIT_BASE_MS,
    Math.min(CODE_ROOT_WAIT_MAX_MS, input.attempt * CODE_ROOT_WAIT_BASE_MS),
  )
  const retryDelayMs = Math.round(decorrelatedJitter(CODE_ROOT_WAIT_BASE_MS, CODE_ROOT_WAIT_MAX_MS, previous, random))
  return {
    retry: true,
    giveUp: false,
    retryDelayMs,
    reason: input.firstSpawn
      ? `waiting ${input.waitedMs} ms of ${opts.windowMs} ms for the daemon's landing root`
      : `a respawn waits for the daemon's landing root (${input.waitedMs} ms so far)`,
  }
}

/**
 * Where the supervisor spawns its adapter child: the landing root the DAEMON runs from, learned from the daemon.
 * Never the supervisor's own tree (shared main or a stale landing) and never a guessed root.
 */
export function adapterEntryForRoot(root: string | null): string {
  if (root === null || root.trim() === "" || !isAbsolute(root)) {
    throw new Error(
      "tribe plugin supervisor: refusing to spawn the adapter from a guessed root; " +
        `the daemon published no landing root (${root === null ? "absent" : `"${root}"`})`,
    )
  }
  return join(root, "plugins", "claude", "server.ts")
}

/**
 * Whether the wrapper restarts its adapter, and after how long. The delay is decorrelated jitter (25663, @cto
 * 348b005d) from the previous delay: never below the base, so no zero-delay hot loop, and never above the cap. A
 * genuinely stable lifetime resets both the count and the delay to the base.
 */
export function evaluateAdapterRestart(
  previousConsecutiveReexecs: number,
  previousRetryDelayMs: number,
  childRuntimeMs: number,
  maxConsecutiveReexecs = Number.POSITIVE_INFINITY,
  random: RandomUnit = Math.random,
): { consecutiveReexecs: number; retry: boolean; retryDelayMs: number } {
  const stable = childRuntimeMs >= ADAPTER_STABLE_MS
  const prior = stable ? 0 : previousConsecutiveReexecs
  const consecutiveReexecs = Math.min(prior + 1, Number.MAX_SAFE_INTEGER)
  const retry = consecutiveReexecs <= maxConsecutiveReexecs
  if (!retry) return { consecutiveReexecs, retry, retryDelayMs: 0 }

  const previous = stable ? REEXEC_BACKOFF_BASE_MS : Math.max(REEXEC_BACKOFF_BASE_MS, previousRetryDelayMs)
  const retryDelayMs = Math.round(
    decorrelatedJitter(
      REEXEC_BACKOFF_BASE_MS,
      REEXEC_BACKOFF_MAX_MS,
      Math.min(previous, REEXEC_BACKOFF_MAX_MS),
      random,
    ),
  )
  return { consecutiveReexecs, retry, retryDelayMs }
}

export const PROVIDER_PARENT_REMEDY =
  "tribe plugin wrapper requires valid provider-parent provenance from a complete live managed launch; restart the host session or reinstall the Tribe plugin."
export const LEGACY_PARENT_WARNING =
  "tribe plugin wrapper: managed launch supplied no provider-parent PID; falling back to the wrapper's real provider parent. Relaunch the host session to restore full launch provenance."

export type SeatAncestry =
  | { readonly kind: "seat" }
  | { readonly kind: "unmeasured"; readonly warning: string }
  | { readonly kind: "nested"; readonly reason: string }

/**
 * Whether this supervisor is the one its launch started (29567, @cto 42880a68, 4dc25c38). A managed launch declares
 * its harness PID, the harness starts the provider, and the provider starts this supervisor: the declared PID is the
 * provider's parent, exactly, on all 48 live supervisors of claude, codex and muse (census 2026-10-15), and an exec'ing
 * wrapper in between (every cmux wrapper, cursor-agent's launcher) keeps it so. A provider run INSIDE the seat, such as
 * an agy one-shot from bearly, inherits the declaration one or more processes deeper; its supervisor used to take the
 * seat's claim and make the seat's own supervisor yield, darkening the seat. A launch with no declared harness is
 * unchanged, and a provider whose parent cannot be read fails open with a named warning, as it behaved before.
 */
export function judgeSeatAncestry(
  declaredHarnessPid: number | null,
  providerPid: number,
  parentOf: (pid: number) => number | null,
): SeatAncestry {
  if (declaredHarnessPid === null) return { kind: "seat" }
  const providerParent = parentOf(providerPid)
  if (providerParent === null) {
    return {
      kind: "unmeasured",
      warning:
        `tribe plugin supervisor: could not read the parent of provider ${providerPid}; acting as this launch's ` +
        "supervisor without the nested-host check (29567)",
    }
  }
  if (providerParent === declaredHarnessPid) return { kind: "seat" }
  return {
    kind: "nested",
    reason:
      `refused to act as this seat's supervisor: its provider ${providerPid} is not a direct child of the seat's ` +
      `harness ${declaredHarnessPid}; the provider's parent is ${providerParent} (29567)`,
  }
}

/**
 * The provider parent this wrapper reports as its launch owner. A managed launch names itself by its HAB_ID_TOKEN
 * alone (25074 3c-2b, @cto def441bf; 3d-2: TRIBE_LAUNCH_ID is never read). An ABSENT parent PID is indistinguishable
 * from a standalone install or a host launched before the bootstrap started injecting it, so it falls back to the
 * wrapper's real provider parent, loudly for a managed launch,
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
  const raw = env[TRIBE_PLUGIN_PROVIDER_PARENT_PID_ENV]?.trim() ?? ""
  // Presence of EITHER name means a managed launch (27314 B1): after the producer cutover only the file path rides.
  const managed =
    (env[HAB_ID_TOKEN_ENV]?.trim() ?? "").length > 0 || (env[HAB_ID_TOKEN_FILE_ENV]?.trim() ?? "").length > 0
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
