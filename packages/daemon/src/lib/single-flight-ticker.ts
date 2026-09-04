/**
 * Single-flight periodic runner — a poller that never overlaps itself.
 *
 * `setInterval(() => void poll(), ms)` starts a run every tick regardless of
 * whether the previous run finished. That is safe only while every run is
 * reliably faster than the interval, and the daemon's pollers are not: the
 * health sampler alone spawns `iostat -d -c 2 -w 1` (>=2s by construction),
 * a full `ps -axo` dump, a `hab sysmon snapshot` walk over
 * the habitat journal, and a network `gh api rate_limit` — each spawned with
 * no deadline and slurped whole into memory. When one run outlasts the
 * interval the runs overlap, and every subsequent tick adds another concurrent
 * run for as long as the slowness persists. Nothing drains that pile, so
 * in-flight work grows with uptime instead of settling, which is the measured
 * daemon wedge: sustained CPU with no client load, thread growth, every RPC
 * past the client's fixed 10s deadline, and an instant cure from a restart
 * because the pile lives entirely in process memory.
 *
 * A run that overruns is a real signal, so it is never dropped quietly: each
 * skipped tick is counted and reported with the runner's name, the consecutive
 * skip count and how long the blocking run has been going. The daemon that
 * wedges next says which poller did it, rather than needing a stack walk that
 * `ptrace_scope` will refuse.
 *
 * `accountlyPlugin` already avoids overlap by chaining `setTimeout` from the
 * end of each run. This is the same guarantee for pollers that want a fixed
 * cadence, with the accounting added.
 */

export type SingleFlightStats = {
  /** Runs actually begun (ticks that found the runner idle). */
  readonly started: number
  readonly completed: number
  readonly failed: number
  /** Ticks dropped because a run was still in flight. */
  readonly skipped: number
  /** Skips since the last run that actually started. */
  readonly consecutiveSkips: number
  readonly maxObservedRunMs: number
  readonly inFlight: boolean
}

export type SingleFlightLog = {
  warn?: (message: string) => void
  error?: (message: string) => void
}

export type SingleFlightRunner = {
  /** Run now if idle; otherwise record and report a dropped tick. */
  tick: () => void
  /** Resolves when the in-flight run (if any) has settled. Never rejects. */
  settled: () => Promise<void>
  stats: () => SingleFlightStats
}

export function createSingleFlightRunner(opts: {
  name: string
  intervalMs: number
  run: () => Promise<void>
  now?: () => number
  log?: SingleFlightLog
}): SingleFlightRunner {
  const now = opts.now ?? Date.now
  const log = opts.log

  let inFlight: Promise<void> | null = null
  let startedAt = 0
  let started = 0
  let completed = 0
  let failed = 0
  let skipped = 0
  let consecutiveSkips = 0
  let maxObservedRunMs = 0

  function stats(): SingleFlightStats {
    return { started, completed, failed, skipped, consecutiveSkips, maxObservedRunMs, inFlight: inFlight !== null }
  }

  function tick(): void {
    if (inFlight !== null) {
      skipped++
      consecutiveSkips++
      const blockedForMs = now() - startedAt
      // Every dropped tick is reported. At a fixed poll cadence this is
      // bounded by the tick rate, and a sustained overrun SHOULD be loud —
      // it is the daemon telling us which poller is eating the event loop.
      log?.warn?.(
        `${opts.name}: skipped tick — previous run still in flight after ${blockedForMs}ms ` +
          `(${consecutiveSkips} consecutive skip${consecutiveSkips === 1 ? "" : "s"}, ${skipped} total)`,
      )
      return
    }

    consecutiveSkips = 0
    started++
    startedAt = now()
    const runStartedAt = startedAt

    // The slot is claimed BEFORE `run()` can execute, and the claim is a
    // promise this function resolves itself rather than the one the async body
    // returns. Assigning `inFlight = (async () => { ... })()` looks equivalent
    // and is not: the body runs synchronously up to its first `await`, so a
    // run that throws SYNCHRONOUSLY reaches the `finally` — and its
    // `inFlight = null` — while the outer assignment still hasn't happened.
    // The assignment then lands afterwards and overwrites null with an
    // already-settled promise, so every later tick sees an occupied slot and
    // is skipped forever, and `settled()` below spins on a resolved promise:
    // an unkillable microtask loop, which is the exact failure this module
    // exists to prevent, reproduced inside the fix for it.
    let releaseSlot!: () => void
    inFlight = new Promise<void>((resolve) => {
      releaseSlot = resolve
    })

    void (async () => {
      try {
        await opts.run()
        completed++
      } catch (error) {
        failed++
        log?.error?.(`${opts.name}: run failed — ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        // Always released: a failing run must not convert a transient child
        // process error into a permanently dead poller, which is the silent
        // mirror image of the pile-up this module exists to prevent.
        const elapsed = now() - runStartedAt
        if (elapsed > maxObservedRunMs) maxObservedRunMs = elapsed
        inFlight = null
        releaseSlot()
        if (elapsed > opts.intervalMs) {
          log?.warn?.(`${opts.name}: run overran its ${opts.intervalMs}ms interval — took ${elapsed}ms`)
        }
      }
    })()
  }

  async function settled(): Promise<void> {
    // Loop: a run may have been started by a tick issued while awaiting.
    while (inFlight !== null) await inFlight
  }

  return { tick, settled, stats }
}

/**
 * Wire a single-flight runner to a fixed cadence. `timers` is the daemon's
 * scope-bound timer factory, so disposal stops the ticker with everything else.
 */
export function startSingleFlightTicker(opts: {
  name: string
  intervalMs: number
  run: () => Promise<void>
  timers: { setInterval: (fn: () => void, ms: number) => unknown }
  now?: () => number
  log?: SingleFlightLog
}): SingleFlightRunner {
  const runner = createSingleFlightRunner(opts)
  opts.timers.setInterval(() => runner.tick(), opts.intervalMs)
  return runner
}
