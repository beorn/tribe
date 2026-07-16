/**
 * identity-authority — the pure authority model that decides who may inherit a
 * detached durable member's identity. The private identity_token is the sole
 * authenticator; name and the PUBLIC launch tuple are locators, never authority.
 */
import { describe, expect, it } from "vitest"
import {
  constantTimeEqual,
  mayClaimDurableRow,
  presentedMatchesStored,
  rowHasStoredCredential,
  type StoredIdentity,
} from "./identity-authority.ts"

const unbound: StoredIdentity = { identity_token: null, launch_id: null, launch_parent_pid: null }
const tokenBound: StoredIdentity = { identity_token: "tok-abc", launch_id: null, launch_parent_pid: null }
const dualBound: StoredIdentity = { identity_token: "tok-abc", launch_id: "launch-xyz", launch_parent_pid: 4242 }
// A row carrying only the PUBLIC launch tuple and no private token is NOT
// authenticator-bound — the tuple is forgeable, so it cannot gate a claim.
const launchOnly: StoredIdentity = { identity_token: null, launch_id: "launch-xyz", launch_parent_pid: 4242 }

describe("constantTimeEqual", () => {
  it("is true only for identical strings", () => {
    expect(constantTimeEqual("secret", "secret")).toBe(true)
    expect(constantTimeEqual("secret", "secreT")).toBe(false)
    expect(constantTimeEqual("secret", "secret-longer")).toBe(false)
    expect(constantTimeEqual("", "")).toBe(true)
  })
})

describe("rowHasStoredCredential", () => {
  it("counts only a stored identity_token as binding (launch tuple is a public locator)", () => {
    expect(rowHasStoredCredential(unbound)).toBe(false)
    expect(rowHasStoredCredential(tokenBound)).toBe(true)
    expect(rowHasStoredCredential(dualBound)).toBe(true)
    expect(rowHasStoredCredential(launchOnly)).toBe(false)
  })
})

describe("presentedMatchesStored", () => {
  it("matches a presented token against the stored token", () => {
    expect(presentedMatchesStored(tokenBound, { identityToken: "tok-abc" })).toBe(true)
    expect(presentedMatchesStored(dualBound, { identityToken: "tok-abc" })).toBe(true)
    expect(presentedMatchesStored(tokenBound, { identityToken: "tok-WRONG" })).toBe(false)
    expect(presentedMatchesStored(tokenBound, { identityToken: null })).toBe(false)
  })

  it("never matches against a row with no stored token", () => {
    expect(presentedMatchesStored(unbound, { identityToken: "anything" })).toBe(false)
    expect(presentedMatchesStored(launchOnly, { identityToken: "anything" })).toBe(false)
  })
})

describe("mayClaimDurableRow", () => {
  it("allows any claim on an unbound (legacy/pure-CLI) row — the migration path", () => {
    expect(mayClaimDurableRow(unbound, { identityToken: null })).toBe(true)
    // A launch-only row carries no authenticator, so it is claimable by name too.
    expect(mayClaimDurableRow(launchOnly, { identityToken: null })).toBe(true)
  })

  it("denies a token-less / unmatched claim on a token-bound row", () => {
    expect(mayClaimDurableRow(tokenBound, { identityToken: null })).toBe(false)
    expect(mayClaimDurableRow(tokenBound, { identityToken: "tok-WRONG" })).toBe(false)
    expect(mayClaimDurableRow(dualBound, { identityToken: null })).toBe(false)
  })

  it("allows a matching-token claim on a token-bound row", () => {
    expect(mayClaimDurableRow(tokenBound, { identityToken: "tok-abc" })).toBe(true)
    expect(mayClaimDurableRow(dualBound, { identityToken: "tok-abc" })).toBe(true)
  })
})
