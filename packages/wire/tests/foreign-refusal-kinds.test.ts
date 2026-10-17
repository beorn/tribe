/**
 * @failure Two sets of register-refusal kinds that answer DIFFERENT questions drift into looking like one, and the next
 *          reader "reconciles" them: adding `identity-contradicted` to the foreign set makes a fault in a connector's
 *          OWN identity read as another party's refusal. agent-rig kept a copy of the foreign set, so nothing compared
 *          the two sides at all (@cto's R3 blocking item 1 of 29686).
 * @level l1
 * @consumer The daemon's `foreign_transport` projection, agent-rig's WATCH bridge classifier, and the stdio adapter's
 *           unretryable-refusal arm.
 * @testonly none
 */

import { describe, expect, test } from "vitest"
import { FOREIGN_REFUSAL_KINDS, UNRETRYABLE_REGISTER_REFUSAL_KINDS } from "../src/lib/foreign-refusal-kinds.ts"

const foreign: readonly string[] = FOREIGN_REFUSAL_KINDS
const unretryable: readonly string[] = UNRETRYABLE_REGISTER_REFUSAL_KINDS

describe("29686 the register-refusal kind sets answer two different questions", () => {
  test("the foreign set is the daemon's classification, exactly as the roster publishes it", () => {
    expect([...FOREIGN_REFUSAL_KINDS]).toEqual(["foreign-identity-transport", "identity-name-mismatch"])
  })

  test("the unretryable set is a wider question: it adds identity-contradicted and never loses a foreign kind", () => {
    expect([...UNRETRYABLE_REGISTER_REFUSAL_KINDS]).toEqual([
      "foreign-identity-transport",
      "identity-contradicted",
      "identity-name-mismatch",
    ])
    for (const kind of foreign) expect(unretryable).toContain(kind)
  })

  test("identity-contradicted is in the unretryable set and MUST NOT be in the foreign set", () => {
    expect(unretryable).toContain("identity-contradicted")
    // A contradicted token is a fault in THIS connector's own identity, so a reader keyed on the foreign set would take
    // a self-refusal for another party's — the conflation @cto's R3 ruling separates by name.
    expect(foreign).not.toContain("identity-contradicted")
  })
})
