/**
 * @failure This one public set drifts from the daemon's classification: adding `identity-contradicted` to it makes a
 *          fault in a connector's OWN identity read as another party's refusal, and publishing a SECOND set beside it
 *          invites the next reader to "reconcile" the two. agent-rig kept a copy of the foreign set, so nothing
 *          compared the sides at all (@cto's R3 blocking item 1 of 29686); @cto's R4 ruling then kept this module to
 *          the ONE set he approved.
 * @level l1
 * @consumer The daemon's `foreign_transport` projection, agent-rig's WATCH bridge classifier, and the stdio adapter's
 *           unretryable-refusal arm, which DERIVES its wider set from this one instead of importing a second one.
 * @testonly none
 */

import { describe, expect, test } from "vitest"
import { FOREIGN_REFUSAL_KINDS } from "../src/lib/foreign-refusal-kinds.ts"

const foreign: readonly string[] = FOREIGN_REFUSAL_KINDS

describe("29686 the register-refusal kind set has one owner and answers the daemon's question", () => {
  test("the foreign set is the daemon's classification, exactly as the roster publishes it", () => {
    expect([...FOREIGN_REFUSAL_KINDS]).toEqual(["foreign-identity-transport", "identity-name-mismatch"])
  })

  test("identity-contradicted MUST NOT be in the foreign set: a fault in this connector's own identity", () => {
    // A contradicted token is a fault in THIS connector's own identity, so a reader keyed on the foreign set would take
    // a self-refusal for another party's — the conflation @cto's R3 ruling separates by name. The wider, unretryable set
    // is derived in its only consumer (src/stdio-adapter.ts), and that kind is driven through the real adapter by the
    // contradicted-identity row in plugin-daemon-restart.test.ts (@cto's R5 fold-in): this module holds only the set he
    // approved, and nothing here claims what the adapter derives.
    expect(foreign).not.toContain("identity-contradicted")
  })
})
