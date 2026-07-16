/**
 * identity-authority — the server-side authority model for durable member
 * identity. Pure functions over STORED row credentials vs. PRESENTED
 * registration credentials; the dispatcher maps a negative verdict to a typed
 * JSON-RPC error.
 *
 * ## Why this exists
 *
 * A named member persists across connections (durable identity). A reconnect
 * re-attaches to the detached durable row, reusing its `sessionId` — and
 * therefore its recipient mailbox and pending balls. That reuse is authority:
 * whoever attaches inherits the member's inbox and ownership.
 *
 * The r1 attach path authenticated by EXACT NAME ONLY. Name is a locator, not
 * an authenticator: a token-less connection could wait for a managed `@agent/N`
 * to detach, request that name, and inherit its mailbox/pending authority.
 *
 * ## What is (and is NOT) an authenticator
 *
 * Authority is DAEMON- / SUPERVISOR-ROOTED: issued when a session registers or
 * a managed backend launches, and verified server-side against the STORED
 * fields — never against a value the claimant merely echoes back.
 *
 * - `identity_token` — THE authenticator. The agent proxy/harness derives it
 *   from a PRIVATE runtime proof (CLAUDE_SESSION_ID / CODEX_THREAD_ID) hashed
 *   with project + role, and re-sends it on every register. It is never exposed
 *   through Tribe's member / status / debug projections, so a peer agent cannot
 *   learn it. A reconnecting session re-presents the same token it first stored.
 *
 * - launch tuple (`launch_id` + `launch_parent_pid`) — a PUBLIC LOCATOR, NOT an
 *   authenticator. It is projected through `tribe.debug` (and derivable from the
 *   OS process tree), so any peer can read and replay it. It groups the
 *   transports of one managed launch for fan-in; it does not, on its own,
 *   authorize a claim. Treating a matching launch tuple as authority was the
 *   forgeable-tuple hole this model closes.
 *
 * A durable row is *bound* iff it carries a stored `identity_token`. A claim on
 * a bound row is authorized only by presenting a token that matches the stored
 * one (constant-time comparison). A row with NO stored token (legacy / pure-CLI
 * sessions that predate token capture) may be attached by name — the documented
 * migration path. New managed launches always carry a token, so their rows are
 * bound from birth.
 */

import { timingSafeEqual } from "node:crypto"

/** Application-range JSON-RPC error code for an unauthorized identity claim
 *  (attach against a bound row, or an authority-bearing op from a non-holder /
 *  stale-epoch connection). Distinct from NameConflictError's -32000 so callers
 *  can branch on it. */
export const TRIBE_IDENTITY_UNAUTHORIZED = -32001

/** Stored credential fields read back from a durable `sessions` row. The launch
 *  fields are retained for transport grouping/fan-in; only `identity_token`
 *  authenticates a claim. */
export type StoredIdentity = {
  identity_token: string | null
  launch_id: string | null
  launch_parent_pid: number | null
}

/** The credential a registering/claiming connection presents for
 *  authentication. Only the private token authenticates; the launch tuple is a
 *  public locator handled separately by the fan-in path. */
export type PresentedIdentity = {
  identityToken: string | null
}

/** Constant-time string equality. Guards the secret-bearing token comparison
 *  against timing oracles. A length mismatch short-circuits — acceptable, since
 *  token lengths are not secret. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * True iff the row carries a stored authenticator (identity_token). A row with
 * none is legacy/pure-CLI and may be attached by name (the migration path). A
 * launch binding alone does NOT make a row bound — the launch tuple is public
 * and forgeable, so it is not an authenticator.
 */
export function rowHasStoredCredential(row: StoredIdentity): boolean {
  return row.identity_token != null
}

/**
 * Does the presented token match the row's stored token? Never true for a row
 * with no stored token — callers gate that via `rowHasStoredCredential`.
 */
export function presentedMatchesStored(row: StoredIdentity, presented: PresentedIdentity): boolean {
  return (
    presented.identityToken != null &&
    row.identity_token != null &&
    constantTimeEqual(presented.identityToken, row.identity_token)
  )
}

/**
 * Attach/claim authority: may a claimant take over this detached durable row's
 * identity (its sessionId, mailbox, pending balls)? Unbound rows are claimable
 * by name (migration path); bound rows require a matching stored token. NAME AND
 * THE PUBLIC LAUNCH TUPLE ARE NEVER AUTHORITY.
 */
export function mayClaimDurableRow(row: StoredIdentity, presented: PresentedIdentity): boolean {
  if (!rowHasStoredCredential(row)) return true
  return presentedMatchesStored(row, presented)
}
