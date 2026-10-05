/**
 * inbox-wait-gap - the ONE owner of the retry-vs-fail BOUNDARY for a transient
 * `cli_inbox_wait` transport gap (27397 Change 2, #27416).
 *
 * `inbox-wait-errors.ts` owns WHICH failures are a classified daemon-socket gap.
 * This module owns the other half: the retry backoff, the gap-age bookkeeping and
 * the bound checks (deadline, gap budget, pre-first-success grace). Those were
 * re-implemented per caller — the tribe CLI's `waitForInboxWithReconnect` and the
 * seat's `withBoundedGapTolerance` — and drifted.
 *
 * It is a PURE state machine: no callbacks, no logging, no latch. A consumer
 * keeps its own loop and its own terminal shape (the CLI returns a logical
 * timeout on deadline and hides the gap; the seat poisons a latch and names a
 * source error). Because the classifier catch lives entirely inside `afterError`
 * — which THROWS the raw error on a non-retryable classification — a consumer's
 * decision-log or latch throw can never re-enter it and be re-classified as a
 * retryable gap (the 27397 boundary).
 *
 * Node-free by contract: the clock is injected and never `Date.now`.
 */
import { inboxWaitErrorKind, type InboxWaitErrorKind } from "./inbox-wait-errors.ts"

/** The classified non-null shape of a retryable inbox-wait gap. */
export type InboxWaitGapKind = Exclude<InboxWaitErrorKind, null>

/**
 * How the retry delay grows between classified gaps. The CLI uses exponential
 * (250ms doubling to a 5s cap); the seat uses a fixed interval (250ms).
 */
export type InboxWaitBackoffPolicy =
  | { readonly kind: "exponential"; readonly initialMs: number; readonly capMs: number }
  | { readonly kind: "fixed"; readonly intervalMs: number }

export interface InboxWaitGapControllerOptions {
  /** Absolute deadline on the SAME clock as `monotonicNow`. */
  readonly deadlineMs: number
  /** The monotonic elapsed source; `deadlineMs` must be expressed in its units. */
  readonly monotonicNow: () => number
  readonly backoff: InboxWaitBackoffPolicy
  /** Total retryable-gap age bound in ms (seat); absent leaves the gap unbounded by age. */
  readonly gapBudgetMs?: number
  /** Pre-first-success `daemon-unavailable` grace in ms (CLI); absent disables the grace. */
  readonly unavailableGraceMs?: number
  /** How far before the deadline a retry must stop; 0 stops only once past it. */
  readonly deadlineSlackMs?: number
}

export type InboxWaitGapTerminalReason = "deadline" | "gap-budget" | "unavailable-grace"

/**
 * The decision for one classified error: retry after `ms` (0 means retry at
 * once), or stop and let the consumer apply its own terminal shape.
 */
export type InboxWaitGapAction =
  | { readonly action: "sleep"; readonly ms: number; readonly kind: InboxWaitGapKind }
  | {
      readonly action: "terminal"
      readonly reason: InboxWaitGapTerminalReason
      readonly kind: InboxWaitGapKind
      readonly lastError: unknown
      readonly gapAgeMs: number
      readonly attempts: number
    }

export interface InboxWaitGapRecovery {
  readonly recovered: boolean
  /** Elapsed age of the gap this success closed, in `monotonicNow()` units; 0 when no gap was open. */
  readonly gapAgeMs: number
}

/**
 * One retry-vs-fail boundary, driven by the consumer's loop. Call `beforeCall`
 * before each attempt, `afterSuccess` on a healthy reply, and `afterError` on a
 * caught failure. `afterError` throws a non-classified error unchanged — that
 * error is terminal and never slept on.
 */
export class InboxWaitGapController {
  private readonly deadlineMs: number
  private readonly monotonicNow: () => number
  private readonly backoff: InboxWaitBackoffPolicy
  private readonly gapBudgetMs: number | undefined
  private readonly unavailableGraceMs: number | undefined
  private readonly deadlineSlackMs: number
  private attempted = false
  private hasEverSucceeded = false
  private gapStartedAtMs: number | null = null
  private unavailableSinceMs: number | null = null
  private consecutiveRetryableErrors = 0

  constructor(opts: InboxWaitGapControllerOptions) {
    this.deadlineMs = opts.deadlineMs
    this.monotonicNow = opts.monotonicNow
    this.backoff = opts.backoff
    this.gapBudgetMs = opts.gapBudgetMs
    this.unavailableGraceMs = opts.unavailableGraceMs
    this.deadlineSlackMs = opts.deadlineSlackMs ?? 0
  }

  /** Read-only: whether a classified gap is currently open (since the last success). */
  get gapOpen(): boolean {
    return this.gapStartedAtMs !== null
  }

  /**
   * The pre-call deadline gate. The first call always proceeds, even with no
   * time left, so a caller never skips its one authoritative attempt.
   */
  beforeCall(): { proceed: true; remainingMs: number } | { proceed: false; reason: "deadline" } {
    const remainingMs = Math.max(0, this.deadlineMs - this.monotonicNow())
    if (this.attempted && remainingMs <= this.deadlineSlackMs) return { proceed: false, reason: "deadline" }
    this.attempted = true
    return { proceed: true, remainingMs }
  }

  /** Mark a healthy reply: close any open gap, reset backoff, remember the success. */
  afterSuccess(): InboxWaitGapRecovery {
    const now = this.monotonicNow()
    const gapStartedAtMs = this.gapStartedAtMs
    const recovered = gapStartedAtMs !== null
    const gapAgeMs = recovered ? now - gapStartedAtMs : 0
    this.gapStartedAtMs = null
    this.unavailableSinceMs = null
    this.consecutiveRetryableErrors = 0
    this.hasEverSucceeded = true
    return { recovered, gapAgeMs }
  }

  /**
   * Classify a caught failure and advance the gap state. A non-retryable error
   * is THROWN unchanged (terminal, never slept on); a retryable error returns
   * either a retry delay or a terminal bound.
   */
  afterError(err: unknown): InboxWaitGapAction {
    const kind = inboxWaitErrorKind(err)
    if (kind === null) throw err

    const now = this.monotonicNow()
    if (this.gapStartedAtMs === null) this.gapStartedAtMs = now
    const backoffMs = this.backoffMs()
    this.consecutiveRetryableErrors += 1
    const attempts = this.consecutiveRetryableErrors
    const gapAgeMs = now - this.gapStartedAtMs

    if (this.unavailableGraceMs !== undefined) {
      if (kind === "daemon-unavailable") {
        // The absence grace begins at this outage and is consumed only before
        // any authoritative chunk; a restart's socket gap must not be measured
        // against the logical wait's full age.
        this.unavailableSinceMs ??= now
        if (!this.hasEverSucceeded && now - this.unavailableSinceMs >= this.unavailableGraceMs) {
          return this.terminal("unavailable-grace", kind, err, gapAgeMs, attempts)
        }
      } else {
        // A non-daemon-unavailable gap clears the absence grace, as before.
        this.unavailableSinceMs = null
      }
    }

    const remainingMs = Math.max(0, this.deadlineMs - now)
    if (remainingMs <= this.deadlineSlackMs) return this.terminal("deadline", kind, err, gapAgeMs, attempts)
    if (this.gapBudgetMs !== undefined && gapAgeMs >= this.gapBudgetMs) {
      return this.terminal("gap-budget", kind, err, gapAgeMs, attempts)
    }

    return { action: "sleep", ms: Math.min(backoffMs, remainingMs), kind }
  }

  private terminal(
    reason: InboxWaitGapTerminalReason,
    kind: InboxWaitGapKind,
    lastError: unknown,
    gapAgeMs: number,
    attempts: number,
  ): InboxWaitGapAction {
    return { action: "terminal", reason, kind, lastError, gapAgeMs, attempts }
  }

  private backoffMs(): number {
    if (this.backoff.kind === "fixed") return Math.max(0, this.backoff.intervalMs)
    const initialMs = Math.max(0, this.backoff.initialMs)
    const capMs = Math.max(0, this.backoff.capMs)
    return Math.min(capMs, initialMs * 2 ** Math.min(this.consecutiveRetryableErrors, 30))
  }
}
