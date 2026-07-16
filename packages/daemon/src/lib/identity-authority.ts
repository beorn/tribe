/**
 * identity-authority — the server-side authority model for durable member
 * identity. Pure functions over the STORED, server-minted capability vs. the
 * capability a caller PRESENTS; the dispatcher maps a negative verdict to a
 * typed JSON-RPC error.
 *
 * ## Why this exists
 *
 * A named member persists across connections (durable identity). A reconnect
 * re-attaches to the detached durable row, reusing its `sessionId` — and thus
 * its recipient mailbox and pending balls. That reuse IS authority.
 *
 * ## The authenticator is a SERVER-MINTED opaque capability — nothing else
 *
 * Every credential a caller can CONSTRUCT from public or observable values is
 * forgeable and must NOT authorize anything:
 *   - the member name and the launch tuple (launch_id + launch_parent_pid) are
 *     projected through tribe members/debug and derivable from the process tree;
 *   - a deterministic identity_token = hash(claude_session_id | cwd | role) is
 *     derivable too — `ps eww` exposes another process's CLAUDE_SESSION_ID, and
 *     project + role are public. A peer can harvest the inputs and mint it.
 *
 * So authority is a random opaque `capability`:
 *   - MINTED by the daemon (crypto random, never derived) the first time a name
 *     with no stored capability and no live holder registers;
 *   - RETURNED to that client on its own authenticated register connection;
 *   - STORED server-side on the session row and NEVER projected (it must not
 *     appear in any members/status/debug output or broadcast);
 *   - PRESENTED back on every authority-bearing op (attach, fan-in, leave,
 *     drain) and compared CONSTANT-TIME against the stored value.
 *
 * `identity_token` and the launch tuple survive only as WEAK HINTS to LOCATE a
 * legacy row for reconnect — never as authority.
 *
 * ## Trust-on-first-use (legacy / unbound migration path + its residual risk)
 *
 * A row with no stored capability (legacy rows predating this scheme, or a
 * brand-new name) may be claimed by name ONLY when it has NO live holder; the
 * daemon then mints a capability and issues it to that first claimant. Everyone
 * after must present it. RESIDUAL RISK: on an unbound name, the FIRST registrant
 * wins (trust-on-first-use) — an attacker who registers an unclaimed legacy name
 * (e.g. @chief) before its legitimate owner becomes the holder. This is the
 * documented migration boundary; it is closed the moment a capability is minted.
 */

import { randomBytes, timingSafeEqual } from "node:crypto"

/** Application-range JSON-RPC error code for an unauthorized identity claim
 *  (attach/fan-in against a bound row, or an authority-bearing op from a
 *  non-holder / stale-epoch connection). Distinct from NameConflictError's
 *  -32000 so callers can branch on it. */
export const TRIBE_IDENTITY_UNAUTHORIZED = -32001

/** Mint a fresh opaque capability: 32 crypto-random bytes as hex. Not derived
 *  from any caller-observable value. */
export function mintCapability(): string {
  return randomBytes(32).toString("hex")
}

/** Stored fields read back from a durable `sessions` row. `capability` is the
 *  SOLE authenticator; the launch tuple + identity_token are legacy location
 *  hints only. */
export type StoredIdentity = {
  capability: string | null
  identity_token: string | null
  launch_id: string | null
  launch_parent_pid: number | null
}

/** Constant-time string equality. Guards the secret-bearing capability
 *  comparison against timing oracles. A length mismatch short-circuits —
 *  acceptable, since capability length is fixed and not secret. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * True iff the row carries a stored server-minted capability. A row with none
 * is legacy/unbound and follows the trust-on-first-use migration path.
 */
export function rowHasStoredCredential(row: StoredIdentity): boolean {
  return row.capability != null
}

/**
 * Does the presented capability match the row's stored capability? Never true
 * for a row with no stored capability — callers gate that via
 * `rowHasStoredCredential`.
 */
export function capabilityMatches(row: StoredIdentity, presentedCapability: string | null): boolean {
  return presentedCapability != null && row.capability != null && constantTimeEqual(presentedCapability, row.capability)
}

/**
 * Attach/claim authority: may a claimant take over this detached durable row's
 * identity (its sessionId, mailbox, pending balls)? An UNBOUND row (no stored
 * capability) is claimable by name — the trust-on-first-use migration path; the
 * caller then mints and is issued a capability. A capability-BOUND row requires
 * presenting the matching capability. NAME, THE LAUNCH TUPLE, AND ANY DERIVED
 * TOKEN ARE NEVER AUTHORITY.
 */
export function mayClaimDurableRow(row: StoredIdentity, presentedCapability: string | null): boolean {
  if (!rowHasStoredCredential(row)) return true
  return capabilityMatches(row, presentedCapability)
}
