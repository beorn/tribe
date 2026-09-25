/**
 * Reload pacing (25663): an adapter re-execs on a source change or a daemon generation change, and a whole fleet
 * receives that signal at once. Re-execing together took every seat's bridge down at 08:02 and 08:15 PDT on
 * 2026-09-24. Each adapter instead waits for its slot in a rolling restart: its rank among the sorted peer names
 * picks the slot, full jitter spreads it inside the slot, and it goes only once the daemon answers on the code the
 * adapter will re-exec into. Every adapter computes its own rank from the same list (the declared roster, then the live
 * adapters it does not name), so no coordinator is needed (@cto ce976914, bf0417a0).
 */

import { awaitReady, fullJitter, type RandomUnit } from "@bearly/pacing"

// Derivation (@cto ce976914). Whoever measures a larger rejoin recomputes these instead of guessing.
/** The slowest rejoin measured: 16 s, at the 08:02 and 08:15 PDT generation re-execs on 2026-09-24. */
export const RELOAD_REJOIN_MAX_MS = 16_000
/** At most this many adapters are absent at once. */
export const RELOAD_MAX_ABSENT = 5
/**
 * rejoinMax / N, rounded up to a whole second: 16 s / 5 = 3.2 s, so 4 s. It is a floor, not a guess: a 3.9 s slot
 * already lets a sixth adapter into a 16 s rejoin (simulated for 25663 r2), so a larger roster widens the window.
 */
export const RELOAD_SLOT_MS = Math.ceil(RELOAD_REJOIN_MAX_MS / RELOAD_MAX_ABSENT / 1_000) * 1_000
/**
 * The widest stagger the deadline holds (25663 r2, @cto 3b3c3d7a): 28 slots of 4 s. 25662's default bridge-lost grace
 * is derived from RELOAD_DEADLINE_MS (the deadline, one health tick and a margin), so widening this lengthens it.
 * A declared seat never shares a slot while the roster fits; see reloadCapacityRefusal.
 */
export const RELOAD_WINDOW_CAP_MS = 112_000
/** The most declared seats the window gives a slot each: 28. */
export const RELOAD_MAX_DECLARED = Math.floor(RELOAD_WINDOW_CAP_MS / RELOAD_SLOT_MS)
/** How long an adapter waits for the daemon to answer on the new code before it re-execs anyway, loudly. */
export const RELOAD_READY_TIMEOUT_MS = 30_000
/**
 * How long one cli_status read may take before it counts as unanswered. The readiness gate checks its timeout only
 * between probes, so a read that never settles (a daemon that accepts no connection) would hold the reload forever.
 */
export const RELOAD_PROBE_TIMEOUT_MS = 2_000
/**
 * The longest a paced reload can take: 146 s. That is the window cap and the ready timeout, plus one probe timeout for
 * the rank read and one for the gate's last probe, which may start just before the ready timeout. 25662's default
 * bridge-lost grace is this plus one tick plus a margin, and an explicit grace is validated against it.
 */
export const RELOAD_DEADLINE_MS = RELOAD_WINDOW_CAP_MS + RELOAD_READY_TIMEOUT_MS + 2 * RELOAD_PROBE_TIMEOUT_MS

/**
 * Why a declared roster cannot be paced: more declared seats than the window has slots, so the ones past the last slot
 * would share it on every reload. Null when every declared seat gets its own slot. The daemon logs it at startup and
 * each reloading adapter warns with it; neither clips silently.
 */
export function reloadCapacityRefusal(declaredCount: number): string | null {
  if (declaredCount <= RELOAD_MAX_DECLARED) return null
  return (
    `the declared roster names ${declaredCount} seats but the paced reload holds ${RELOAD_MAX_DECLARED} ` +
    `(${RELOAD_WINDOW_CAP_MS} ms window of ${RELOAD_SLOT_MS} ms slots inside the ${RELOAD_DEADLINE_MS} ms deadline); ` +
    `declared seats past slot ${RELOAD_MAX_DECLARED - 1} share it`
  )
}

/** The last slot a list of `peerCount` peers can use inside the cap; every rank past it shares it. */
export function reloadLastSlot(peerCount: number, slotMs: number, capMs: number): number {
  return Math.max(0, Math.min(peerCount, Math.floor(capMs / slotMs)) - 1)
}

/**
 * One adapter's delay before it re-execs: rank × slot, clipped so it stays inside the cap, plus full jitter inside
 * the slot. A null rank (the peer list could not be read) spreads uniformly over the whole cap. Both the live path
 * and the witness call this, so the witness measures the code that ships.
 */
export function planReloadDelay(
  rank: number | null,
  peerCount: number,
  slotMs: number,
  capMs: number,
  random?: RandomUnit,
): number {
  if (rank === null) return fullJitter(capMs, capMs, 0, random)
  return Math.min(rank, reloadLastSlot(peerCount, slotMs, capMs)) * slotMs + fullJitter(slotMs, slotMs, 0, random)
}

/**
 * cli_status `reload_peers` (25663 P3, @cto bf0417a0): the list every adapter ranks itself in. On a daemon
 * generation change each adapter reads cli_status just after its own re-register, so `sessions[]` holds only the
 * adapters that rejoined before it, and ranks read from it collide. The declared roster does not depend on when it is
 * read.
 */
export interface ReloadPeers {
  /** Every name in hab's declared roster, live or not. Empty when the daemon has no roster. */
  readonly declared: readonly string[]
  /** Live adapters the roster does not name. */
  readonly liveUndeclared: readonly string[]
}

/**
 * `self`'s rank among the peers: the declared names sorted, then the live undeclared names sorted after them. An
 * adapter missing from both goes LAST, never first.
 *
 * - The declared half is identical for every adapter only because the roster is one file on one host, read by one
 *   daemon. A roster that differs per adapter (another host, a stale copy) brings the collision back; one adapter
 *   cannot see that, and the warning on a shared last slot is the only local detector.
 * - Undeclared live adapters do not all take one last slot, which would collide them. They follow the declared set in
 *   name order, which is deterministic once they are all live. An undeclared adapter that has not rejoined yet is
 *   invisible to the others' reads, so an undeclared rank can still collide: pacedReexec warns, and the adapter
 *   takes its sorted place at the next reload.
 */
export function reloadRank(
  self: string,
  peers: ReloadPeers,
): { rank: number; peerCount: number; found: boolean; declared: boolean } {
  const declared = [...new Set(peers.declared)].sort()
  const declaredSet = new Set(declared)
  const undeclared = [...new Set(peers.liveUndeclared)].filter((name) => !declaredSet.has(name)).sort()
  const names = [...declared, ...undeclared]
  const index = names.indexOf(self)
  return index === -1
    ? { rank: names.length, peerCount: names.length + 1, found: false, declared: false }
    : { rank: index, peerCount: names.length, found: true, declared: declaredSet.has(self) }
}

/** What the daemon's cli_status tells a reloading adapter: who is live, and which code the daemon runs. */
export interface ReloadDaemonView {
  /** cli_status `sessions[].name`: the rank's fallback when the daemon predates `reload_peers`. */
  readonly liveNames: readonly string[]
  /** cli_status `reload_peers`, or null from a daemon that predates it. */
  readonly peers: ReloadPeers | null
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
  /** The rank and slot each reload takes, so an operator (and the journey witness) can see who shared a slot. */
  readonly info: (message: string) => void
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
 * - a daemon without reload_peers or without a roster ranks on the live list and warns;
 * - a missing self goes last and warns; an undeclared self, or one clipped into a shared last slot, warns;
 * - a declared roster larger than the window warns with the count and the cap (reloadCapacityRefusal);
 * - a daemon that reports no code identity, or an adapter whose own disk commit is unresolved, is judged on liveness
 *   alone, warned once and named for 25670;
 * - a daemon never ready re-execs anyway at the timeout, with a warning naming the last probe error.
 */
export async function pacedReexec(deps: PacedReexecDeps, reason: string): Promise<void> {
  let rank: number | null = null
  let peerCount = 0
  try {
    const view = await boundedRead(deps)
    let peers = view.peers
    if (peers === null) {
      deps.warn(
        "reload pacing: cli_status carries no reload_peers (a daemon older than 25663 r1); ranking on sessions[].name, where adapters that rejoined at different moments can share a slot",
      )
      peers = { declared: [], liveUndeclared: view.liveNames }
    } else if (peers.declared.length === 0) {
      deps.warn(
        "reload pacing: the daemon has no declared roster; ranking on the live adapters alone, where adapters that rejoined at different moments can share a slot",
      )
    } else {
      const refusal = reloadCapacityRefusal(new Set(peers.declared).size)
      if (refusal !== null) deps.warn(`reload pacing: ${refusal}`)
    }
    const ranked = reloadRank(deps.self, peers)
    rank = ranked.rank
    peerCount = ranked.peerCount
    const lastSlot = reloadLastSlot(peerCount, RELOAD_SLOT_MS, RELOAD_WINDOW_CAP_MS)
    if (!ranked.found) {
      deps.warn(`reload pacing: ${deps.self} is not in cli_status reload_peers; taking the last slot (${rank})`)
    } else if (!ranked.declared && peers.declared.length > 0) {
      deps.warn(
        `reload pacing: ${deps.self} is not in the declared roster; ranked ${rank} after it among the live adapters this read saw, so an undeclared adapter not yet rejoined can share the slot`,
      )
    }
    if (rank >= lastSlot && peerCount - 1 > lastSlot) {
      deps.warn(
        `reload pacing: rank ${rank} of ${peerCount} peers shares the last slot (${lastSlot}) inside the ${RELOAD_WINDOW_CAP_MS} ms cap`,
      )
    }
  } catch (error) {
    deps.warn(
      `reload pacing: cli_status read failed (${errorText(error)}); spreading over the ${RELOAD_WINDOW_CAP_MS} ms cap`,
    )
  }
  const delay = planReloadDelay(rank, peerCount, RELOAD_SLOT_MS, RELOAD_WINDOW_CAP_MS, deps.random)
  if (rank !== null) {
    const slot = Math.min(rank, reloadLastSlot(peerCount, RELOAD_SLOT_MS, RELOAD_WINDOW_CAP_MS))
    deps.info(
      `reload pacing: ${deps.self} rank ${rank} of ${peerCount} peers, slot ${slot}; waiting ${Math.round(delay)} ms`,
    )
  }
  await deps.sleep(delay)

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
