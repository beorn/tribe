/**
 * inbox-wait-transport - the ONE owner of the retry-vs-fail boundary for a
 * transient `cli_inbox_wait` transport gap (27397 Change 2, #27416).
 *
 * `inbox-wait-errors.ts` owns WHICH failures are a classified daemon-socket gap
 * (a promotion restart: the socket is gone, or an established connection closed
 * mid-read). This module owns the other half every caller used to re-implement:
 * the retry BUDGET and the fail-loud boundary. A consumer passes its probe; a
 * classified gap is retried under one declared bound, each gap is declared
 * through `onGap` (never silent), and a gap that outlives the bound is raised
 * as a named `InboxWaitTransportError` instead of ending a wait on a bare error.
 *
 * Node-free by contract: pure timing/classification over an injected probe.
 * `setTimeout` is the only ambient used and it is injectable for tests.
 */
import { inboxWaitErrorKind, type InboxWaitErrorKind } from "./inbox-wait-errors.ts"

/** Declared bound on how long a classified socket gap may be retried, ms (27397). */
export const INBOX_WAIT_TRANSPORT_BUDGET_MS = 30_000

/** Delay between classified-gap retries, ms (27397). */
export const INBOX_WAIT_TRANSPORT_RETRY_MS = 250

/** A classified daemon socket gap that the declared retry budget could not outlive. */
export class InboxWaitTransportError extends Error {
  readonly kind: Exclude<InboxWaitErrorKind, null>
  readonly attempts: number
  readonly budgetMs: number

  constructor(kind: Exclude<InboxWaitErrorKind, null>, attempts: number, budgetMs: number) {
    super(
      `inbox wait transport gap (${kind}) persisted past the ${budgetMs}ms declared budget after ${attempts} attempts; the daemon did not return before the bound`,
    )
    this.name = "InboxWaitTransportError"
    this.kind = kind
    this.attempts = attempts
    this.budgetMs = budgetMs
  }
}

export type InboxWaitTransportOpts = {
  /** Override the declared gap budget (ms). Production uses INBOX_WAIT_TRANSPORT_BUDGET_MS. */
  budgetMs?: number
  /** Override the delay between retries (ms). Production uses INBOX_WAIT_TRANSPORT_RETRY_MS. */
  retryMs?: number
  /**
   * Called once per classified gap, before the next retry. The caller records
   * its declared decision row here, so a gap is observable and never silent
   * (NO SILENT ERRORS). Absent still bounds and names the gap; only the log is
   * the caller's.
   */
  onGap?: (kind: Exclude<InboxWaitErrorKind, null>, attempt: number) => void
  /** @internal test seam: monotonic clock. */
  now?: () => number
  /** @internal test seam: sleep. */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Run `probe` under the single retry-vs-fail boundary for `cli_inbox_wait`.
 *
 * Returns the probe's value. A classified transport gap is declared and retried
 * while the elapsed time stays within `budgetMs`; any other failure is surfaced
 * immediately, unchanged. A classified gap still failing once the next retry
 * would cross the budget is raised as `InboxWaitTransportError`.
 */
export async function withInboxWaitTransportRetry<T>(
  probe: () => Promise<T>,
  opts?: InboxWaitTransportOpts,
): Promise<T> {
  const budgetMs = opts?.budgetMs ?? INBOX_WAIT_TRANSPORT_BUDGET_MS
  const retryMs = opts?.retryMs ?? INBOX_WAIT_TRANSPORT_RETRY_MS
  const now = opts?.now ?? (() => Date.now())
  const sleep = opts?.sleep ?? defaultSleep
  const startedAt = now()
  let attempts = 0

  for (;;) {
    attempts += 1
    try {
      return await probe()
    } catch (error) {
      const kind = inboxWaitErrorKind(error)
      if (kind === null) throw error
      opts?.onGap?.(kind, attempts)
      if (now() - startedAt + retryMs > budgetMs) {
        throw new InboxWaitTransportError(kind, attempts, budgetMs)
      }
      await sleep(retryMs)
    }
  }
}
