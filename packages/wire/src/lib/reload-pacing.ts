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
/** The longest a paced reload can take: 120 s. 25662's bridge-lost grace must exceed this plus one tick. */
export const RELOAD_DEADLINE_MS = RELOAD_WINDOW_CAP_MS + RELOAD_READY_TIMEOUT_MS

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
export function reloadRank(self: string, liveNames: readonly string[]): { rank: number; liveCount: number; found: boolean } {
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
  /** One cli_status read. Throws when the daemon cannot be read. */
  readonly readDaemon: () => Promise<ReloadDaemonView>
  /** The commit on disk the adapter will re-exec into. */
  readonly onDiskCert: () => string | null
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly warn: (message: string) => void
  readonly reexec: (reason: string) => void
  readonly random?: RandomUnit
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Wait for this adapter's slot, then for a daemon running the code on disk, then re-exec. Nothing here fails
 * silently. A failed list read spreads over the cap and warns. A missing self goes last and warns. A daemon that reports no code identity is
 * judged on liveness alone, as is an adapter whose own disk commit is unresolved, warned once and named for 25670. A daemon never ready re-execs anyway at the timeout,
 * with a warning naming the last probe error.
 */
export async function pacedReexec(deps: PacedReexecDeps, reason: string): Promise<void> {
  let rank: number | null = null
  let liveCount = 0
  try {
    const view = await deps.readDaemon()
    const ranked = reloadRank(deps.self, view.liveNames)
    rank = ranked.rank
    liveCount = ranked.liveCount
    if (!ranked.found) {
      deps.warn(`reload pacing: ${deps.self} is not in cli_status sessions[].name; taking the last slot (${rank})`)
    }
  } catch (error) {
    deps.warn(`reload pacing: cli_status read failed (${errorText(error)}); spreading over the ${RELOAD_WINDOW_CAP_MS} ms cap`)
  }
  await deps.sleep(planReloadDelay(rank, liveCount, RELOAD_SLOT_MS, RELOAD_WINDOW_CAP_MS, deps.random))

  let identityGapWarned = false
  const outcome = await awaitReady(
    async () => {
      const view = await deps.readDaemon()
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
