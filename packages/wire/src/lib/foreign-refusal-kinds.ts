/**
 * Register-refusal kinds, and the ONE question this module answers: which refusals mean "this transport carried ANOTHER
 * seat's identity". They live in the wire because two sides read them: the daemon's transport projection and
 * agent-rig's WATCH bridge classifier.
 *
 * This file exists because the estate had drifted into exactly the shape that hides a difference: the set was copied
 * between the sides (a copy drifts silently) while the other question — which refusals a RETRY cannot change — was
 * written inline where nobody would compare it (@cto's R3 blocking item 1 of 29686).
 *
 * @cto's R4 ruling on that item keeps this module to the ONE set he approved. The unretryable set is NOT here: it is
 * derived in its only consumer, the wire's stdio adapter, from this one plus the single kind that concerns the
 * connector's own identity.
 */

/**
 * "This transport carried ANOTHER seat's identity" (24767) — the daemon's classification of a register refusal, and what
 * decides whether a record can be evidence about THIS row's own connector. Two daemon sites compose these: the
 * managed-inbox and launch-takeover refusals name the impersonation `foreign-identity-transport`, and the verifier's own
 * name mismatch keeps `identity-name-mismatch`, the kind that recorded the view against the presented name before 29686,
 * so dropping it from this set would silently stop a name mismatch publishing `foreign_transport`.
 *
 * Neither kind proves WHOSE connector was refused. "No live-holder proof" holds for the name-mismatch writer, which
 * files the record on the row the presented name belongs to; the managed-inbox writer records
 * `foreign-identity-transport` on the row whose LAUNCH id was presented, and the fence and precedence writers target the
 * live holder. So a seat's own relaunch presenting its name with a foreign token can be refused on its OWN connector
 * (@cto's correction to his own 1fcb6a7a premise; the per-writer split is his R4 item 2).
 */
export const FOREIGN_REFUSAL_KINDS = ["foreign-identity-transport", "identity-name-mismatch"] as const
