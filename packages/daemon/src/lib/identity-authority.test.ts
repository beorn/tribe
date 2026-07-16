/**
 * identity-authority — the pure authority model. The SOLE authenticator is the
 * server-minted opaque capability; name, the public launch tuple, and any
 * caller-derivable token are locators/hints, never authority.
 */
import { describe, expect, it } from "vitest"
import {
  capabilityMatches,
  constantTimeEqual,
  mayClaimDurableRow,
  mintCapability,
  rowHasStoredCredential,
  type StoredIdentity,
} from "./identity-authority.ts"

// A row with no stored capability is unbound (legacy / trust-on-first-use) even
// if it carries hint fields (identity_token / launch tuple) — those are forgeable
// and never authority.
const unbound: StoredIdentity = { capability: null, identity_token: null, launch_id: null, launch_parent_pid: null }
const unboundWithHints: StoredIdentity = {
  capability: null,
  identity_token: "derived-token",
  launch_id: "launch-xyz",
  launch_parent_pid: 4242,
}
const bound: StoredIdentity = {
  capability: "cap-secret-abc",
  identity_token: "derived-token",
  launch_id: "launch-xyz",
  launch_parent_pid: 4242,
}

describe("mintCapability", () => {
  it("mints a 64-hex-char opaque secret, unique per call", () => {
    const a = mintCapability()
    const b = mintCapability()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(b).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
})

describe("constantTimeEqual", () => {
  it("is true only for identical strings", () => {
    expect(constantTimeEqual("secret", "secret")).toBe(true)
    expect(constantTimeEqual("secret", "secreT")).toBe(false)
    expect(constantTimeEqual("secret", "secret-longer")).toBe(false)
    expect(constantTimeEqual("", "")).toBe(true)
  })
})

describe("rowHasStoredCredential", () => {
  it("counts ONLY a stored capability as binding (hint fields do not bind)", () => {
    expect(rowHasStoredCredential(unbound)).toBe(false)
    expect(rowHasStoredCredential(unboundWithHints)).toBe(false)
    expect(rowHasStoredCredential(bound)).toBe(true)
  })
})

describe("capabilityMatches", () => {
  it("matches the presented capability against the stored capability", () => {
    expect(capabilityMatches(bound, "cap-secret-abc")).toBe(true)
    expect(capabilityMatches(bound, "cap-WRONG")).toBe(false)
    expect(capabilityMatches(bound, null)).toBe(false)
  })

  it("never matches against a row with no stored capability", () => {
    expect(capabilityMatches(unbound, "anything")).toBe(false)
    expect(capabilityMatches(unboundWithHints, "derived-token")).toBe(false)
    expect(capabilityMatches(unboundWithHints, "launch-xyz")).toBe(false)
  })
})

describe("mayClaimDurableRow", () => {
  it("allows any claim on an unbound row — trust-on-first-use (even with hints present)", () => {
    expect(mayClaimDurableRow(unbound, null)).toBe(true)
    expect(mayClaimDurableRow(unboundWithHints, null)).toBe(true)
    // A forged/harvested hint value confers nothing — the row is still claimable
    // by TOFU, and the daemon will mint a fresh capability for the first claimant.
    expect(mayClaimDurableRow(unboundWithHints, "derived-token")).toBe(true)
  })

  it("denies a capability-less / unmatched claim on a bound row", () => {
    expect(mayClaimDurableRow(bound, null)).toBe(false)
    expect(mayClaimDurableRow(bound, "cap-WRONG")).toBe(false)
    // The forgeable hints do NOT authorize a bound row.
    expect(mayClaimDurableRow(bound, "derived-token")).toBe(false)
    expect(mayClaimDurableRow(bound, "launch-xyz")).toBe(false)
  })

  it("allows a matching-capability claim on a bound row", () => {
    expect(mayClaimDurableRow(bound, "cap-secret-abc")).toBe(true)
  })
})
