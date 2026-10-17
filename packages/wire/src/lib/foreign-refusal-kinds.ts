/**
 * Register-refusal kinds, and the ONE question this module answers: which refusal kinds the daemon FILES as foreign
 * (24767) — the kinds a daemon record may carry when the refusal the record holds is a foreign-identity refusal.
 *
 * Membership is a classification OF THE KIND, never a statement about whose connector was refused. The same kind is
 * filed by writers that refuse a foreign claimant and by writers that refuse a seat's OWN connector presenting a stale
 * or duplicated instance of itself, so neither a kind nor membership in this set tells a reader whose identity was
 * carried.
 *
 * They live in the wire because two consumers read them, and each uses membership for one thing — whether a stored
 * refusal on this row can be evidence about THIS row's own connector: the daemon's transport projection
 * (`session-transport-state.ts`, which derives the `foreign_transport` field from the record) and agent-rig's WATCH
 * bridge classifier (`classifyCoordinationBridge`).
 *
 * This file exists because the estate had drifted into exactly the shape that hides a difference: the set was copied
 * between the consumers (a copy drifts silently) while the other question — which refusals a RETRY cannot change — was
 * written inline where nobody would compare it.
 *
 * This module owns the ONE set. The unretryable set is NOT here: it is derived in its only consumer, the wire's stdio
 * adapter (`UNRETRYABLE_REGISTER_REFUSAL_KINDS`), from this one plus the single kind that concerns the connector's own
 * identity.
 */

/**
 * The kinds the daemon files as foreign, and the writers that file them, BY SYMBOL. The managed inbox calls the one
 * store writer, `recordRegisterRefusal`, directly, and records `foreign-identity-transport` on the row the presented
 * launch id resolves to among the rows `hasLaunchAuthority` holds for. Every other writer reaches the store through
 * `refuseRegister`: `precedenceRefusal`'s generation FENCE arm records that same kind for the SAME session's own
 * instance when the generation is stale or duplicated, on the holder's row; its PRECEDENCE arm records it for a
 * lower-authority claimant, also on the holder's row; and that one function runs from BOTH the explicit-takeover path
 * and the token-displacement path. The verifier's own name mismatch keeps `identity-name-mismatch`, the kind that
 * recorded the view against the presented name before 29686, filed on `newestDurableRowId(presented)` — so dropping it
 * from this set would silently stop a name mismatch publishing `foreign_transport`.
 *
 * Neither kind proves WHOSE connector was refused, and there is no per-writer split to lean on: the writers do NOT
 * share one row rule. The managed inbox resolves its target among the rows `hasLaunchAuthority` holds for, true of ANY
 * agent row, while the fence and precedence arms file on the live holder and the name-mismatch writer files on
 * `newestDurableRowId(presented)`, the row the PRESENTED name belongs to. So the name-mismatch writer can land on the
 * live holder's row exactly as the other three do, and a seat's own relaunch presenting its name with a foreign token
 * can be refused on its OWN connector.
 */
export const FOREIGN_REFUSAL_KINDS = ["foreign-identity-transport", "identity-name-mismatch"] as const
