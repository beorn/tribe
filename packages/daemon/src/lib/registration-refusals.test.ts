/**
 * @failure A refusal of another habitat's token pages as this habitat's member refused (#38997).
 * @level l1 — the daemon's registration-refusal ledger, pure over time and the live roster
 * @consumer `tribe health` registration_issues, which Hab pages as wire-registration-refused
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { createRegistrationRefusals } from "./registration-refusals.ts"

const TTL = 10 * 60_000
const FOREIGN_REASON =
  'token claims to be from "hab:software-factory" for "hab:software-factory" (unverified); this habitat is hab:/hh/main.hab'

describe("registration refusals (33946, #38997)", () => {
  it("a refusal stays an issue under the member's name until the refused transport registers", () => {
    const ledger = createRegistrationRefusals(TTL)
    ledger.note("habmod", "name-conflict", { pid: 7, launchId: null })
    expect(ledger.unresolved(1_000 + Date.now(), [])).toEqual([
      expect.stringMatching(/^registration refused for habmod \(name-conflict\) \d+s ago; the refused transport/),
    ])
    expect(ledger.unresolved(Date.now(), [{ name: "habmod", pid: 7, launchId: null }])).toEqual([])
  })

  it("a successful register clears the member's own refusal, never another habitat's", () => {
    const ledger = createRegistrationRefusals(TTL)
    ledger.note("habmod", "name-conflict", { pid: 7, launchId: null })
    ledger.note(
      "habmod",
      "identity-contradicted",
      { pid: 9, launchId: null },
      { rule: "aud-is-own-habitat", reason: FOREIGN_REASON },
    )
    ledger.registered("habmod")
    expect(ledger.unresolved(Date.now(), [])).toEqual([
      expect.stringContaining("another habitat's token claiming habmod"),
    ])
  })

  it("a v1 verifier verdict that names no rule still keys the refusal by member", () => {
    const ledger = createRegistrationRefusals(TTL)
    ledger.note("habmod", "identity-contradicted", { pid: 7, launchId: null }, { reason: "instance is not live" })
    expect(ledger.unresolved(Date.now(), [])).toEqual([
      expect.stringMatching(/^registration refused for habmod \(identity-contradicted\)/),
    ])
  })

  it("another habitat's token leaves this habitat's member untouched and names the foreign habitat", () => {
    const ledger = createRegistrationRefusals(TTL)
    ledger.note(
      "habmod",
      "identity-contradicted",
      { pid: 7, launchId: null },
      { rule: "aud-is-own-habitat", reason: FOREIGN_REASON },
    )
    const issues = ledger.unresolved(Date.now(), [])
    expect(issues.some((issue) => issue.startsWith("registration refused for habmod"))).toBe(false)
    expect(issues).toEqual([expect.stringContaining('"hab:software-factory"')])
    expect(issues[0]).toContain("habmod")
    expect(issues[0]).toContain("this habitat's habmod is unaffected")
    // Our own habmod's refusal still keys by member, beside the foreign one.
    ledger.note("habmod", "name-conflict", { pid: 8, launchId: null })
    expect(
      ledger.unresolved(Date.now(), []).filter((issue) => issue.startsWith("registration refused for habmod")),
    ).toHaveLength(1)
  })

  it("a foreign-habitat refusal expires by TTL: the foreign transport never registers here", () => {
    const ledger = createRegistrationRefusals(TTL)
    const at = Date.now()
    ledger.note(
      "habmod",
      "identity-contradicted",
      { pid: 7, launchId: null },
      { rule: "aud-is-own-habitat", reason: FOREIGN_REASON },
    )
    expect(ledger.unresolved(at + TTL - 1, [])).toHaveLength(1)
    expect(ledger.unresolved(at + TTL + 1, [])).toEqual([])
  })
})
