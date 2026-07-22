// @failure a launch persona name the adapter cannot register is silently
//   downgraded to an unaddressable `unknown-<rand>` placeholder
// @level unit
// @consumer vendor/tribe/packages/wire/src/stdio-adapter.ts
//
// Live 2026-07-22: a seat launched `--name @chief/@ci/next` registered as
// `unknown-cmayz`. The shape check rejected the nested `@`, so the adapter
// registered without seeding its identity and the daemon minted a placeholder.
// Nothing addressed to the persona could reach it and nothing reported why.

import { describe, expect, test } from "vitest"
import { isExplicitTribePersonaName, launchPersonaNameRefusal } from "../src/lib/launch-persona-name.ts"

describe("isExplicitTribePersonaName", () => {
  test("accepts the plain and path-segmented personas", () => {
    for (const name of ["@chief", "@ci", "@fleet", "@cto", "@agent/5", "@agent/7", "@chief/next", "@ci/next"]) {
      expect(isExplicitTribePersonaName(name)).toBe(true)
    }
  })

  test("accepts rotation names carrying a nested sigil — the live regression", () => {
    // The sigil is part of node identity; it is legal inside the name, not
    // only at the front. These are the names that minted `unknown-*`.
    expect(isExplicitTribePersonaName("@chief/@ci/next")).toBe(true)
    expect(isExplicitTribePersonaName("@chief/@ci")).toBe(true)
  })

  test("still rejects non-persona shapes", () => {
    for (const name of ["chief", "", "@", "@Chief", "@chief name", "unknown-cmayz"]) {
      expect(isExplicitTribePersonaName(name)).toBe(false)
    }
  })

  test("still rejects an over-long name rather than truncating it", () => {
    expect(isExplicitTribePersonaName(`@${"a".repeat(64)}`)).toBe(false)
  })
})

describe("launchPersonaNameRefusal — a declared identity that cannot register is loud", () => {
  test("no name is not a refusal — that is the ad-hoc session path", () => {
    expect(launchPersonaNameRefusal(undefined)).toBeNull()
  })

  test("a registrable persona is not a refusal", () => {
    expect(launchPersonaNameRefusal("@chief/@ci/next")).toBeNull()
    expect(launchPersonaNameRefusal("@agent/5")).toBeNull()
  })

  test("a bare non-@ name is not a refusal — the model joins explicitly", () => {
    // The ad-hoc path. Nothing declared a hat, so nothing was promised.
    expect(launchPersonaNameRefusal("researcher")).toBeNull()
    expect(launchPersonaNameRefusal("chief")).toBeNull()
  })

  test("an @-name that declares a hat it cannot register names the name and the consequence", () => {
    const refusal = launchPersonaNameRefusal("@Chief Next")
    expect(refusal).not.toBeNull()
    expect(refusal).toContain("@Chief Next")
    expect(refusal).toContain("unknown-")
  })
})
