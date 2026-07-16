/**
 * identity-authority — the pure authority model that decides who may inherit a
 * detached durable member's identity. Name is a locator, not an authenticator:
 * a bound row requires a matching stored credential; an unbound row is the
 * documented migration path.
 */
import { describe, expect, it } from "vitest"
import {
  constantTimeEqual,
  mayClaimDurableRow,
  parsePresentedIdentity,
  presentedMatchesStored,
  rowHasStoredCredential,
  type StoredIdentity,
} from "./identity-authority.ts"

const unbound: StoredIdentity = { identity_token: null, launch_id: null, launch_parent_pid: null }
const tokenBound: StoredIdentity = { identity_token: "tok-abc", launch_id: null, launch_parent_pid: null }
const launchBound: StoredIdentity = { identity_token: null, launch_id: "launch-xyz", launch_parent_pid: 4242 }

describe("constantTimeEqual", () => {
  it("is true only for identical strings", () => {
    expect(constantTimeEqual("secret", "secret")).toBe(true)
    expect(constantTimeEqual("secret", "secreT")).toBe(false)
    expect(constantTimeEqual("secret", "secret-longer")).toBe(false)
    expect(constantTimeEqual("", "")).toBe(true)
  })
})

describe("rowHasStoredCredential", () => {
  it("classifies unbound vs bound rows", () => {
    expect(rowHasStoredCredential(unbound)).toBe(false)
    expect(rowHasStoredCredential(tokenBound)).toBe(true)
    expect(rowHasStoredCredential(launchBound)).toBe(true)
  })
})

describe("presentedMatchesStored", () => {
  it("matches a token against the stored token", () => {
    expect(presentedMatchesStored(tokenBound, { identityToken: "tok-abc", launchIdentity: null })).toBe(true)
    expect(presentedMatchesStored(tokenBound, { identityToken: "tok-WRONG", launchIdentity: null })).toBe(false)
    expect(presentedMatchesStored(tokenBound, { identityToken: null, launchIdentity: null })).toBe(false)
  })

  it("matches a launch identity against the stored id + parent-pid binding", () => {
    expect(
      presentedMatchesStored(launchBound, { identityToken: null, launchIdentity: { id: "launch-xyz", parentPid: 4242 } }),
    ).toBe(true)
    // Same id, wrong parent pid → no match (lineage must match).
    expect(
      presentedMatchesStored(launchBound, { identityToken: null, launchIdentity: { id: "launch-xyz", parentPid: 9999 } }),
    ).toBe(false)
    // Wrong id → no match.
    expect(
      presentedMatchesStored(launchBound, { identityToken: null, launchIdentity: { id: "launch-OTHER", parentPid: 4242 } }),
    ).toBe(false)
  })

  it("never matches against an unbound row (nothing to compare)", () => {
    expect(presentedMatchesStored(unbound, { identityToken: "anything", launchIdentity: { id: "x", parentPid: 1 } })).toBe(
      false,
    )
  })
})

describe("mayClaimDurableRow", () => {
  it("allows any claim on an unbound (legacy/pure-CLI) row — the migration path", () => {
    expect(mayClaimDurableRow(unbound, { identityToken: null, launchIdentity: null })).toBe(true)
  })

  it("denies a token-less / unmatched claim on a bound row", () => {
    // The core r1 hole: name-only claim on a launch-bound row.
    expect(mayClaimDurableRow(launchBound, { identityToken: null, launchIdentity: null })).toBe(false)
    expect(mayClaimDurableRow(tokenBound, { identityToken: null, launchIdentity: null })).toBe(false)
    expect(mayClaimDurableRow(tokenBound, { identityToken: "tok-WRONG", launchIdentity: null })).toBe(false)
  })

  it("allows a matching-credential claim on a bound row", () => {
    expect(mayClaimDurableRow(tokenBound, { identityToken: "tok-abc", launchIdentity: null })).toBe(true)
    expect(
      mayClaimDurableRow(launchBound, { identityToken: null, launchIdentity: { id: "launch-xyz", parentPid: 4242 } }),
    ).toBe(true)
  })
})

describe("parsePresentedIdentity", () => {
  it("extracts a token and a valid launch pair", () => {
    expect(parsePresentedIdentity({ identityToken: "tok", launchId: "L", launchParentPid: 7 })).toEqual({
      identityToken: "tok",
      launchIdentity: { id: "L", parentPid: 7 },
    })
  })

  it("yields null launch identity for a partial or invalid pair (lenient read side)", () => {
    expect(parsePresentedIdentity({ launchId: "L" }).launchIdentity).toBeNull()
    expect(parsePresentedIdentity({ launchParentPid: 7 }).launchIdentity).toBeNull()
    expect(parsePresentedIdentity({ launchId: " ", launchParentPid: 0 }).launchIdentity).toBeNull()
    expect(parsePresentedIdentity({ launchId: "L", launchParentPid: -3 }).launchIdentity).toBeNull()
  })

  it("treats an empty-string token as absent", () => {
    expect(parsePresentedIdentity({ identityToken: "" }).identityToken).toBeNull()
    expect(parsePresentedIdentity({}).identityToken).toBeNull()
  })
})
