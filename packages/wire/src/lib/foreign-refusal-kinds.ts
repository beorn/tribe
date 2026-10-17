/**
 * Register-refusal kinds, and the TWO questions they answer. They live in the wire because two sides read them: the
 * daemon's transport projection and agent-rig's WATCH bridge classifier.
 *
 * This file exists because the two answers are NOT one question, and the estate had drifted into exactly the shape that
 * hides a difference: one set was copied between the sides (a copy drifts silently) while the other was written inline
 * where nobody would compare it (@cto's R3 blocking item 1 of 29686).
 */

/**
 * "This transport carried ANOTHER seat's identity" (24767) — the daemon's classification of a register refusal, and what
 * decides whether a record can be evidence about THIS row's own connector. Two daemon sites compose these: the
 * managed-inbox and launch-takeover refusals name the impersonation `foreign-identity-transport`, and the verifier's own
 * name mismatch keeps `identity-name-mismatch`, the kind that recorded the view against the presented name before 29686,
 * so dropping it from this set would silently stop a name mismatch publishing `foreign_transport`.
 *
 * Neither kind proves WHOSE connector was refused. A refusal lands on the row the presented name belongs to, with no
 * live-holder proof, so a seat's own relaunch presenting its name with a foreign token is refused on its own connector
 * (@cto's correction to his own 1fcb6a7a premise).
 */
export const FOREIGN_REFUSAL_KINDS = ["foreign-identity-transport", "identity-name-mismatch"] as const

/**
 * A different question with a different answer: the register refusals a RETRY cannot change, because the identity this
 * connector presented is itself what the daemon refused, so every tool call would be refused the same way.
 *
 * It adds `identity-contradicted` — the verifier contradicting the token it was shown — which FOREIGN_REFUSAL_KINDS must
 * NOT carry. That set answers whose identity was carried, and a contradicted token is a fault in this connector's OWN
 * identity, not another seat's; a verifier FAULT is in neither set, because it may clear and is worth retrying.
 */
export const UNRETRYABLE_REGISTER_REFUSAL_KINDS = [
  "foreign-identity-transport",
  "identity-contradicted",
  "identity-name-mismatch",
] as const
