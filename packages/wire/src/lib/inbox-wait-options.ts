export const DEFAULT_INBOX_WAIT_SESSION = "@chief"
export const DEFAULT_INBOX_WAIT_TIMEOUT_MS = 30_000

/**
 * 20703 — socket-timeout derivation for an inbox-wait long-poll.
 *
 * The wire client caps every RPC at a per-call timeout; for a long-poll that
 * cap must EXCEED the wait it is polling or the socket fires before the daemon
 * can answer (the 10s-vs-30s bug). Size the per-call socket timeout from the
 * requested wait: cap the wait at `MAX_INBOX_WAIT_TIMEOUT_MS`, add a fixed
 * margin so the daemon's own timeout returns a clean `timed_out` result first,
 * and never drop below the historical 10s floor. This mirrors the CLI's
 * `Math.max(10_000, timeout + 5_000)` (cli/read.ts) so CLI and MCP long-polls
 * share ONE derivation instead of the parallel one that left MCP broken.
 */
export const INBOX_WAIT_CALL_TIMEOUT_FLOOR_MS = 10_000
export const INBOX_WAIT_CALL_TIMEOUT_MARGIN_MS = 5_000
export const MAX_INBOX_WAIT_TIMEOUT_MS = 30 * 60 * 1000

export function deriveInboxWaitCallTimeoutMs(requestedMs: number | undefined): number {
  const requested = typeof requestedMs === "number" && Number.isFinite(requestedMs) ? Math.max(0, requestedMs) : 0
  const capped = Math.min(requested, MAX_INBOX_WAIT_TIMEOUT_MS)
  return Math.max(INBOX_WAIT_CALL_TIMEOUT_FLOOR_MS, capped + INBOX_WAIT_CALL_TIMEOUT_MARGIN_MS)
}

export type InboxWaitOptionSource = {
  readonly session?: unknown
  readonly timeout_ms?: unknown
  readonly timeoutMs?: unknown
}

export type InboxWaitOptions = {
  readonly session: string
  readonly timeoutMs: number
}

export function parseInboxWaitTimeoutMs(raw: unknown, fallback = DEFAULT_INBOX_WAIT_TIMEOUT_MS): number {
  const timeoutMs = Number(raw)
  return Number.isFinite(timeoutMs) ? timeoutMs : fallback
}

export function resolveInboxWaitOptions(
  source: InboxWaitOptionSource,
  opts: { readonly defaultSession?: string } = {},
): InboxWaitOptions {
  const session = typeof source.session === "string" && source.session.length > 0 ? source.session : opts.defaultSession
  const timeoutRaw = source.timeout_ms ?? source.timeoutMs
  return {
    session: session ?? DEFAULT_INBOX_WAIT_SESSION,
    timeoutMs: parseInboxWaitTimeoutMs(timeoutRaw),
  }
}
