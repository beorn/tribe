/**
 * `inbox-wait` — reusable long-poll primitive for the tribe daemon.
 *
 * Blocks until an ACTIONABLE inbox event arrives for a named session, or until
 * a timeout elapses, or until a termination signal is received. Built so @ci
 * and agent idle/backoff loops can WAIT for work instead of busy-looping a
 * journal read in a hot `while (true)`.
 *
 * Design (pure core, injected effects):
 *
 *   - The wait loop here takes its effects as parameters — a `pollActionable`
 *     probe (returns the count + oldest-ts of UNDRAINED actionable events for
 *     the session), a `sleep(ms)` between polls, a `now()` clock, and an
 *     optional `wakeup` accelerator that resolves early when the daemon pushes
 *     a `wakeup` notification. This makes the loop deterministic under test:
 *     inject a fake clock + a synchronous fake poll, assert exit + poll-count
 *     bounds with NO real timers.
 *
 *   - ACTIONABLE is NOT re-defined here. The probe is expected to wrap the
 *     daemon's canonical actionable-DM predicate — the `getUnreadDms` SQL
 *     (`kind = 'direct' AND type IN ('request','query','verdict','assign')`,
 *     `database.ts`) exposed via the `cli_inbox_status` RPC and already
 *     consumed by the chief-silent watchdog + health-monitor. The CLI command
 *     in `cli/read.ts` supplies that probe. Reusing the shipped predicate
 *     avoids a second, drifting definition.
 *
 *   - Zero-CPU-idle by construction: the loop AWAITS `sleep` (or a pushed
 *     `wakeup`) between probes — it never re-queries in a tight spin. The
 *     `wakeup` accelerator only breaks the sleep early; the authoritative
 *     decision is always the actionable probe, so ambient/broadcast wakeups
 *     do NOT cause a false return.
 *
 * Bead: `@km/bearly/20352-inbox-wait`.
 */

// ---------------------------------------------------------------------------
// Outcome + exit-code contract
// ---------------------------------------------------------------------------

/**
 * Distinct, documented exit codes so watchdog/loop callers can branch on the
 * reason and apply backoff rather than spin:
 *
 *   - `0`  (EXIT_ACTIONABLE) — an actionable event arrived; the caller should
 *          drain it (e.g. via `tribe.fetch`) and act.
 *   - `64` (EXIT_TIMEOUT)    — no actionable event within `--timeout`; the
 *          caller should back off and re-arm. Chosen >2 to avoid colliding
 *          with Commander's arg-parse exit 2 and the daemon-unreachable exit 1.
 *   - `0`  (EXIT_SIGNAL)     — a termination signal (SIGINT/SIGTERM) ended the
 *          wait cleanly; treated as a graceful stop, not an error.
 *
 * (Daemon-unreachable surfaces as exit 1 from the shared `callDaemon` helper,
 * which is upstream of this loop.)
 */
export const EXIT_ACTIONABLE = 0
export const EXIT_TIMEOUT = 64
export const EXIT_SIGNAL = 0

/** Why the wait ended. */
export type InboxWaitReason = "actionable" | "timeout" | "signal"

/** Snapshot of the actionable inbox state for the waited-on session. */
export interface ActionableSnapshot {
  /** Count of UNDRAINED actionable events (rowid > the session's pull cursor). */
  readonly count: number
  /** Wall-clock ms of the oldest undrained actionable event, or 0 when none. */
  readonly oldestTs: number
}

/** Structured result of a single `runInboxWait` call. */
export interface InboxWaitResult {
  readonly reason: InboxWaitReason
  readonly exitCode: number
  /** The actionable snapshot at the moment the wait resolved (for `reason:"actionable"`). */
  readonly snapshot: ActionableSnapshot | null
  /** Number of times `pollActionable` was invoked — bounded by construction. */
  readonly polls: number
}

function exitCodeFor(reason: InboxWaitReason): number {
  switch (reason) {
    case "actionable":
      return EXIT_ACTIONABLE
    case "timeout":
      return EXIT_TIMEOUT
    case "signal":
      return EXIT_SIGNAL
  }
}

// ---------------------------------------------------------------------------
// Pure wait loop
// ---------------------------------------------------------------------------

export interface RunInboxWaitOpts {
  /**
   * Probe the daemon for UNDRAINED actionable events for the target session.
   * MUST wrap the daemon's canonical actionable predicate (see module docs) —
   * do not re-derive actionability here.
   */
  readonly pollActionable: () => Promise<ActionableSnapshot>
  /**
   * Total budget in ms. When the elapsed time (per `now()`) reaches this, the
   * loop resolves with `reason:"timeout"`. `Infinity` means wait forever (until
   * an actionable event or a signal).
   */
  readonly timeoutMs: number
  /**
   * Sleep between polls. The loop AWAITS this — it is the zero-spin guarantee.
   * Real callers pass a timer; tests pass a fake-clock advance. Resolving
   * `sleep` early (the `wakeup` accelerator wires it to a race) is allowed and
   * just triggers an earlier re-poll; correctness still rests on the probe.
   */
  readonly sleep: (ms: number) => Promise<void>
  /**
   * Bounded poll interval in ms (the cap on a single `sleep`). The actual sleep
   * is `min(pollIntervalMs, remaining-budget)` so the loop never overshoots the
   * deadline. Default 1000ms.
   */
  readonly pollIntervalMs?: number
  /** Monotonic-ish clock. Defaults to `Date.now`. Inject a fake clock in tests. */
  readonly now?: () => number
  /**
   * Resolves when a termination signal is observed → the loop returns
   * `reason:"signal"` on the next checkpoint. Never rejects; a no-signal caller
   * passes a never-resolving promise (the default).
   */
  readonly signal?: Promise<void>
}

const NEVER: Promise<never> = new Promise<never>(() => {})

/**
 * Run the long-poll wait loop. Returns when an actionable event is observed,
 * the timeout budget is exhausted, or a termination signal fires.
 *
 * The loop probes ONCE up front (so an already-pending actionable event returns
 * ~instantly without sleeping), then alternates sleep → probe until one of the
 * three terminal conditions holds. `polls` in the result lets tests assert the
 * loop did not busy-spin (a delayed-message window produces a small, bounded
 * poll count, not thousands).
 */
export async function runInboxWait(opts: RunInboxWaitOpts): Promise<InboxWaitResult> {
  const now = opts.now ?? Date.now
  const pollIntervalMs = opts.pollIntervalMs ?? 1000
  const signalPromise = opts.signal ?? NEVER
  const start = now()

  let signalled = false
  void signalPromise.then(() => {
    signalled = true
    return undefined
  })

  let polls = 0
  for (;;) {
    if (signalled) return { reason: "signal", exitCode: exitCodeFor("signal"), snapshot: null, polls }

    polls++
    const snapshot = await opts.pollActionable()
    if (snapshot.count > 0) {
      return { reason: "actionable", exitCode: exitCodeFor("actionable"), snapshot, polls }
    }

    if (signalled) return { reason: "signal", exitCode: exitCodeFor("signal"), snapshot: null, polls }

    const elapsed = now() - start
    const remaining = opts.timeoutMs - elapsed
    if (remaining <= 0) {
      return { reason: "timeout", exitCode: exitCodeFor("timeout"), snapshot: null, polls }
    }

    // Sleep the smaller of the poll interval and the remaining budget so the
    // loop never overshoots the deadline, and race it against the signal so a
    // SIGINT/SIGTERM breaks the sleep promptly. The sleep itself is what makes
    // this zero-spin — there is no path that re-polls without first awaiting.
    const nap = Math.min(pollIntervalMs, remaining)
    await Promise.race([opts.sleep(nap), signalPromise])
  }
}
