/**
 * Reload pacing (25663): an adapter re-execs on a source change or a daemon generation change, and a whole fleet
 * receives that signal at once. Re-execing together took every seat's bridge down at 08:02 and 08:15 PDT on
 * 2026-09-24. Each adapter instead waits for its slot in a rolling restart: its rank among the live adapters' sorted
 * names picks the slot, full jitter spreads it inside the slot, and it goes only once the daemon answers on the code
 * the adapter will re-exec into. Every adapter computes its own rank from the same list, so no coordinator is needed
 * (@cto ce976914).
 */

import { awaitReady, fullJitter, type RandomUnit } from "@bearly/pacing"

// Derivation (@cto ce976914). Whoever measures a larger rejoin recomputes these instead of guessing.
/** The slowest rejoin measured: 16 s, at the 08:02 and 08:15 PDT generation re-execs on 2026-09-24. */
export const RELOAD_REJOIN_MAX_MS = 16_000
/** At most this many adapters are absent at once. */
export const RELOAD_MAX_ABSENT = 5
/** rejoinMax / N, rounded up to a whole second: 16 s / 5 = 3.2 s, so 4 s. */
export const RELOAD_SLOT_MS = Math.ceil(RELOAD_REJOIN_MAX_MS / RELOAD_MAX_ABSENT / 1_000) * 1_000
/** 20 adapters × 4 s = 80 s, plus headroom; a larger fleet shares the last slot. */
export const RELOAD_WINDOW_CAP_MS = 90_000
/** How long an adapter waits for the daemon to answer on the new code before it re-execs anyway, loudly. */
export const RELOAD_READY_TIMEOUT_MS = 30_000
/**
 * How long one cli_status read may take before it counts as unanswered. The readiness gate checks its timeout only
 * between probes, so a read that never settles (a daemon that accepts no connection) would hold the reload forever.
 */
export const RELOAD_PROBE_TIMEOUT_MS = 2_000
/**
 * The longest a paced reload can take: 124 s. That is the window cap and the ready timeout, plus one probe timeout for
 * the rank read and one for the gate's last probe, which may start just before the ready timeout. 25662's bridge-lost
 * grace must exceed this plus one tick.
 */
export const RELOAD_DEADLINE_MS = RELOAD_WINDOW_CAP_MS + RELOAD_READY_TIMEOUT_MS + 2 * RELOAD_PROBE_TIMEOUT_MS

/**
 * One adapter's delay before it re-execs: rank × slot, clipped so it stays inside the cap, plus full jitter inside
 * the slot. A null rank (the live list could not be read) spreads uniformly over the whole cap. Both the live path
 * and the witness call this, so the witness measures the code that ships.
 */
export function planReloadDelay(
  rank: number | null,
  liveCount: number,
  slotMs: number,
  capMs: number,
  random?: RandomUnit,
): number {
  if (rank === null) return fullJitter(capMs, capMs, 0, random)
  const lastSlot = Math.max(0, Math.min(liveCount, Math.floor(capMs / slotMs)) - 1)
  return Math.min(rank, lastSlot) * slotMs + fullJitter(slotMs, slotMs, 0, random)
}

/** `self`'s rank among the live names, sorted. An adapter missing from the list goes LAST, never first. */
export function reloadRank(
  self: string,
  liveNames: readonly string[],
): { rank: number; liveCount: number; found: boolean } {
  const names = [...new Set(liveNames)].sort()
  const index = names.indexOf(self)
  return index === -1
    ? { rank: names.length, liveCount: names.length + 1, found: false }
    : { rank: index, liveCount: names.length, found: true }
}

/** What the daemon's cli_status tells a reloading adapter: who is live, and which code the daemon runs. */
export interface ReloadDaemonView {
  /** cli_status `sessions[].name`. */
  readonly liveNames: readonly string[]
  /** cli_status `daemon.code_identity.cert`: the commit the daemon is running, or null when it reports none. */
  readonly runningCert: string | null
}

export interface PacedReexecDeps {
  readonly self: string
  /** One cli_status read. Throws when the daemon cannot be read; pacedReexec bounds it with `timeout`. */
  readonly readDaemon: () => Promise<ReloadDaemonView>
  /** Resolves after `ms` on a timer of its own, apart from `sleep`: the bound on each cli_status read. */
  readonly timeout: (ms: number) => Promise<void>
  /** The commit on disk the adapter will re-exec into. */
  readonly onDiskCert: () => string | null
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly warn: (message: string) => void
  readonly reexec: (reason: string) => void
  readonly random?: RandomUnit
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** One cli_status read that fails, loudly, once RELOAD_PROBE_TIMEOUT_MS passes without an answer. */
function boundedRead(deps: PacedReexecDeps): Promise<ReloadDaemonView> {
  return Promise.race([
    deps.readDaemon(),
    deps.timeout(RELOAD_PROBE_TIMEOUT_MS).then((): never => {
      throw new Error(`cli_status did not answer within ${RELOAD_PROBE_TIMEOUT_MS} ms`)
    }),
  ])
}

/**
 * Wait for this adapter's slot, then for a daemon running the code on disk, then re-exec, within RELOAD_DEADLINE_MS.
 * Nothing here fails silently:
 * - a failed or unanswered list read spreads over the cap and warns;
 * - a missing self goes last and warns;
 * - a daemon that reports no code identity, or an adapter whose own disk commit is unresolved, is judged on liveness
 *   alone, warned once and named for 25670;
 * - a daemon never ready re-execs anyway at the timeout, with a warning naming the last probe error.
 */
export async function pacedReexec(deps: PacedReexecDeps, reason: string): Promise<void> {
  let rank: number | null = null
  let liveCount = 0
  try {
    const view = await boundedRead(deps)
    const ranked = reloadRank(deps.self, view.liveNames)
    rank = ranked.rank
    liveCount = ranked.liveCount
    if (!ranked.found) {
      deps.warn(`reload pacing: ${deps.self} is not in cli_status sessions[].name; taking the last slot (${rank})`)
    }
  } catch (error) {
    deps.warn(
      `reload pacing: cli_status read failed (${errorText(error)}); spreading over the ${RELOAD_WINDOW_CAP_MS} ms cap`,
    )
  }
  await deps.sleep(planReloadDelay(rank, liveCount, RELOAD_SLOT_MS, RELOAD_WINDOW_CAP_MS, deps.random))

  let identityGapWarned = false
  const outcome = await awaitReady(
    async () => {
      const view = await boundedRead(deps)
      const onDisk = deps.onDiskCert()
      if (view.runningCert === null || onDisk === null) {
        if (!identityGapWarned) {
          identityGapWarned = true
          deps.warn(
            `reload pacing: no code identity to compare (daemon ${view.runningCert ?? "reports none"}, disk ${onDisk ?? "unresolved"}); readiness is liveness alone until 25670`,
          )
        }
        return true
      }
      return view.runningCert === onDisk
    },
    { timeoutMs: RELOAD_READY_TIMEOUT_MS, retryMs: 500, now: deps.now, sleep: deps.sleep, random: deps.random },
  )
  if (!outcome.ready) {
    const why = "lastError" in outcome ? errorText(outcome.lastError) : "the daemon runs other code than the disk"
    deps.warn(`reload pacing: daemon not ready after ${outcome.waitedMs} ms (${why}); re-execing anyway`)
  }
  deps.reexec(reason)
}
