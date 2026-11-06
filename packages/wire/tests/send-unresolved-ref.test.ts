/**
 * @failure A mistyped correlation looks like a receipt; an unreadable lookup looks like a known missing ball.
 * @level l0
 * @consumer tribe-wire send's advisory for an existing --ref (31937).
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { refNamesOwnedOpenBall } from "../src/cli/send.ts"

const ref = "5a253b24-0000-0000-0000-000000000000"
const caller = "@dev/brain"

describe("existing reference settlement decision", () => {
  it("distinguishes an unknown ref from the sender's open ball", () => {
    expect(refNamesOwnedOpenBall(ref, caller, { events: [], settlement_unknown_ids: [ref] })).toBe(false)
    expect(
      refNamesOwnedOpenBall(ref, caller, {
        events: [{ id: ref, from: caller, settlement: "open" }],
      }),
    ).toBe(true)
  })

  it("keeps a holder's TAKING correlation silent, as well as a requester's", () => {
    expect(
      refNamesOwnedOpenBall(ref, caller, {
        events: [{ id: ref, from: "@chief", settlement: "open", owners: [caller] }],
      }),
    ).toBe(true)
  })

  it.each([
    { id: ref, from: "@chief", settlement: "open" },
    { id: ref, from: caller, settlement: "settled" },
    { id: ref, from: caller, settlement: "untracked" },
  ])("rejects a known row that is not the sender's open ball: %j", (event) => {
    expect(refNamesOwnedOpenBall(ref, caller, { events: [event] })).toBe(false)
  })

  it.each([
    { error: "tracker unavailable" },
    { events: [], settlement_lookup: { status: "unavailable", detail: "journal unreadable" } },
    { events: [], settlement_lookup: { status: "partial", detail: "budget exhausted" } },
    { events: [] },
    { events: [{ id: ref, from: caller }] },
    { events: [{ id: ref, from: caller, settlement: "undecided" }] },
    { events: [{ id: "another-id", from: caller, settlement: "open" }] },
  ])("does not turn an undecided lookup into a missing-ball claim: %j", (snapshot) => {
    expect(refNamesOwnedOpenBall(ref, caller, snapshot)).toBeUndefined()
  })
})
