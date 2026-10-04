/**
 * inbox-wait-errors - the ONE owner of the retryable transport-error classifier
 * for `cli_inbox_wait` callers.
 *
 * Both the tribe CLI (`src/cli/read.ts`, in-package) and the seat-side long wait
 * (`tools/agent-rig/skills/tent/scripts/seat-await.ts`, a different repository
 * importing `tribe-wire/lib/inbox-wait-errors`) must decide identically whether a
 * failed inbox-wait call is a transient socket gap (a daemon restart) or a real
 * failure. This module is that single owner, so there is no second implementation
 * (27397).
 *
 * Node-free by contract: the parameter is `unknown` and the code is duck-typed,
 * so a consumer that does not run Node can import this without dragging in
 * `node:*` types or modules.
 */

/** The classified shape of an inbox-wait failure: a transient gap, or `null` for a real failure. */
export type InboxWaitErrorKind = "transport-close" | "daemon-unavailable" | null

/**
 * Classify a failed `cli_inbox_wait` call. `daemon-unavailable` is the socket
 * being absent/refusing (a restart has closed it and the new one has not bound);
 * `transport-close` is an established connection closing mid-read. Anything else
 * is `null` - a real failure the caller must surface, never retry.
 */
export function inboxWaitErrorKind(err: unknown): InboxWaitErrorKind {
  const code = (err as { readonly code?: unknown } | undefined)?.code
  if (code === "ENOENT" || code === "ECONNREFUSED") return "daemon-unavailable"
  if (code === "ECONNRESET" || code === "EPIPE") return "transport-close"
  const message = err instanceof Error ? err.message : String(err)
  return /connection closed|socket closed|socket hang up|closed before response|request cli_inbox_wait timed out/i.test(
    message,
  )
    ? "transport-close"
    : null
}

/** True when a failed inbox-wait call is a classified transient socket gap. */
export function isRetryableInboxWaitError(err: unknown): boolean {
  return inboxWaitErrorKind(err) !== null
}
