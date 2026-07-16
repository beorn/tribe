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
 * to detach, request that name, and inherit its mailbox/pending authority. This
 * module closes that hole.
 *
 * ## Authority model (who may claim a detached durable row)
 *
 * A durable row is *bound* iff it carries an unforgeable stored credential:
 *   - `identity_token` — issued by the agent proxy/harness as a deterministic
 *     hash of (claude_session_id | cwd | role); re-sent on every register, so a
 *     reconnecting session re-presents the same token it first stored.
 *   - `launch_id` + `launch_parent_pid` — a daemon/supervisor-issued launch
 *     lineage minted when a managed backend is spawned; the managed relaunch
 *     re-presents the exact pair.
 *
 * A claimant may take over a bound row iff it PRESENTS a matching credential
 * (token equal to the stored token, OR launch id+parent-pid equal to the stored
 * launch binding). Server-side comparison against the stored fields — the
 * claimed name is never trusted on its own.
 *
 * A row with NO stored credential (legacy / pure-CLI sessions that registered
 * without a token or launch identity) may be attached by name. This is the
 * documented migration path: pre-existing durable rows predate credential
 * capture, so name-only attach stays available for them. New managed launches
 * always carry a launch identity, so their rows are bound from birth.
 */

import { timingSafeEqual } from "node:crypto"

/** Application-range JSON-RPC error code for an unauthorized identity claim
 *  (attach/leave/inbox-drain against a bound row without matching authority).
 *  Distinct from NameConflictError's -32000 so callers can branch on it. */
export const TRIBE_IDENTITY_UNAUTHORIZED = -32001

/** Stored credential fields read back from a durable `sessions` row. */
export type StoredIdentity = {
  identity_token: string | null
  launch_id: string | null
  launch_parent_pid: number | null
}

/** Credentials a registering/claiming connection presents. */
export type PresentedIdentity = {
  identityToken: string | null
  launchIdentity: { id: string; parentPid: number } | null
}

/** Constant-time string equality. Guards the secret-bearing comparisons
 *  (identity token, launch id) against timing oracles. A length mismatch
 *  short-circuits — acceptable, since credential lengths are not secret. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * True iff the row carries any unforgeable stored credential. A row with none
 * is legacy/pure-CLI and may be attached by name (the migration path).
 */
export function rowHasStoredCredential(row: StoredIdentity): boolean {
  return row.identity_token != null || row.launch_id != null
}

/**
 * Does the presented identity match the row's stored credential? Matches when
 * the presented token equals the stored token, OR the presented launch identity
 * (id + parent-pid lineage) equals the stored launch binding. Never true for a
 * row with no stored credential — callers gate that via `rowHasStoredCredential`.
 */
export function presentedMatchesStored(row: StoredIdentity, presented: PresentedIdentity): boolean {
  if (
    presented.identityToken != null &&
    row.identity_token != null &&
    constantTimeEqual(presented.identityToken, row.identity_token)
  ) {
    return true
  }
  if (
    presented.launchIdentity != null &&
    row.launch_id != null &&
    row.launch_parent_pid != null &&
    presented.launchIdentity.parentPid === row.launch_parent_pid &&
    constantTimeEqual(presented.launchIdentity.id, row.launch_id)
  ) {
    return true
  }
  return false
}

/**
 * Attach/claim authority: may a claimant take over this detached durable row's
 * identity (its sessionId, mailbox, pending balls)? Unbound rows are claimable
 * by name (migration path); bound rows require a matching stored credential.
 * NAME ALONE IS NEVER AUTHORITY.
 */
export function mayClaimDurableRow(row: StoredIdentity, presented: PresentedIdentity): boolean {
  if (!rowHasStoredCredential(row)) return true
  return presentedMatchesStored(row, presented)
}

/**
 * Extract the presented credentials from raw JSON-RPC params for an AUTHORITY
 * comparison (read side — cli_inbox_drain). Lenient by design: a partial or
 * invalid launch pair simply yields `launchIdentity: null` (no launch match).
 * This is NOT the register path's validation — register still rejects partial
 * launch pairs loudly; here we only compare against stored fields.
 */
export function parsePresentedIdentity(p: Record<string, unknown>): PresentedIdentity {
  const identityToken = typeof p.identityToken === "string" && p.identityToken.length > 0 ? p.identityToken : null
  const launchIdRaw = typeof p.launchId === "string" ? p.launchId.trim() : ""
  const launchParentPid = Number(p.launchParentPid ?? 0)
  const launchIdentity =
    launchIdRaw.length > 0 && Number.isSafeInteger(launchParentPid) && launchParentPid > 0
      ? { id: launchIdRaw, parentPid: launchParentPid }
      : null
  return { identityToken, launchIdentity }
}
