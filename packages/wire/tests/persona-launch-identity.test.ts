import { describe, expect, test } from "vitest"

import {
  deriveTribePersonaLaunchIdentity,
  formatInstanceId,
  parseInstanceId,
  providerLaunchIdOf,
} from "../src/lib/persona-launch-identity.ts"

describe("persona launch identity", () => {
  test("one provider launch derives distinct routable and writer identities per persona", () => {
    expect(deriveTribePersonaLaunchIdentity("@chief", "provider-launch")).toEqual({
      persona: "@chief",
      providerLaunchId: "provider-launch",
      providerLaunchKey: "provider-launch::%40chief",
      writer: "@chief#provider-launch::%40chief",
    })
    expect(deriveTribePersonaLaunchIdentity("@cto", "provider-launch").providerLaunchKey).toBe(
      "provider-launch::%40cto",
    )
  })

  // A daemon restarted with no identity verifier refused every verified seat as "another seat's identity": its
  // authority row was keyed "<sid>@<gen>", which this read as a different provider launch (2026-09-24 08:06 PDT).
  test("a persona launch id and a verified session key name the same provider launch", () => {
    const persona = deriveTribePersonaLaunchIdentity("@dev/3", "e8b19c27").providerLaunchKey
    expect(providerLaunchIdOf(persona)).toBe("e8b19c27")
    expect(providerLaunchIdOf("e8b19c27@467")).toBe("e8b19c27")
    expect(providerLaunchIdOf("e8b19c27")).toBe("e8b19c27")
    expect(providerLaunchIdOf("e8b19c270@1")).not.toBe(providerLaunchIdOf(persona))
  })

  // review-adhoc5 P4 (60f1932f): a raw "@" opens a verified session's generation, so a provider launch id carrying
  // one would read as that generation's launch: "user@host" and "user@other" would merge in the foreign-identity check.
  test.each(["user@host", "@provider-launch"])("refuses a provider launch id %j carrying a raw @", (launchId) => {
    expect(() => deriveTribePersonaLaunchIdentity("@dev/3", launchId)).toThrow(/Tribe provider launch id .* @/u)
  })

  test.each(["", " ", "@chief#other"])("refuses an invalid persona %j", (persona) => {
    expect(() => deriveTribePersonaLaunchIdentity(persona, "provider-launch")).toThrow(/Tribe persona/u)
  })
})

describe("unit instance id (session@generation)", () => {
  test("formatInstanceId is the one join", () => {
    expect(formatInstanceId("e8b19c27-bea0-4cf9-a039-a08943ba9423", 476)).toBe(
      "e8b19c27-bea0-4cf9-a039-a08943ba9423@476",
    )
    expect(formatInstanceId("session", 0)).toBe("session@0")
  })

  test("formatInstanceId refuses an ambiguous join", () => {
    expect(() => formatInstanceId("user@host", 1)).toThrow(/must not contain @/u)
    expect(() => formatInstanceId("session", -1)).toThrow(/non-negative safe integer/u)
    expect(() => formatInstanceId("session", 1.5)).toThrow(/non-negative safe integer/u)
    expect(() => formatInstanceId("", 1)).toThrow(/Tribe instance session id/u)
  })

  test("parseInstanceId round-trips formatInstanceId and is the one split", () => {
    expect(parseInstanceId(formatInstanceId("e8b19c27-bea0-4cf9-a039-a08943ba9423", 476))).toEqual({
      sessionId: "e8b19c27-bea0-4cf9-a039-a08943ba9423",
      generation: 476,
    })
    expect(parseInstanceId("e8b19c27@8")).toEqual({ sessionId: "e8b19c27", generation: 8 })
  })

  test("parseInstanceId returns null for a value that is not instance-shaped", () => {
    expect(parseInstanceId("e8b19c27")).toBeNull()
    expect(parseInstanceId("provider-launch::%40chief")).toBeNull()
  })

  test("parseInstanceId throws on an instance-shaped but malformed value", () => {
    expect(() => parseInstanceId("e8b19c27@")).toThrow(/non-numeric generation/u)
    expect(() => parseInstanceId("e8b19c27@x")).toThrow(/non-numeric generation/u)
    expect(() => parseInstanceId("e8b19c27@467@1")).toThrow(/more than one @/u)
    expect(() => parseInstanceId("@467")).toThrow(/Tribe instance session id/u)
  })

  // Peer review 423bf323: the two helpers must agree on generations, and a generation that cannot name one exact
  // number must be refused rather than collapsed or exponent-stringified.
  test("both helpers accept the safe-integer range and refuse anything past it", () => {
    const max = Number.MAX_SAFE_INTEGER
    expect(parseInstanceId(formatInstanceId("session", max))).toEqual({ sessionId: "session", generation: max })
    for (const generation of [2 ** 53, 1e21, Number.POSITIVE_INFINITY, Number.NaN, 1.5, -1]) {
      expect(() => formatInstanceId("session", generation)).toThrow(/non-negative safe integer/u)
    }
  })

  test("parseInstanceId refuses a generation text that does not name one safe integer exactly", () => {
    // 9007199254740993 rounds to 9007199254740992; two distinct texts must never share one generation.
    expect(() => parseInstanceId("session@9007199254740993")).toThrow(/safe integer|round-trip/u)
    expect(() => parseInstanceId("session@9007199254740992")).toThrow(/safe integer|round-trip/u)
    expect(() => parseInstanceId("session@" + "9".repeat(400))).toThrow(/safe integer|round-trip/u)
  })

  test("parseInstanceId applies the same session rule as formatInstanceId", () => {
    for (const value of ["bad session@1", "bad#session@1"]) {
      expect(() => parseInstanceId(value)).toThrow(/Tribe instance session id/u)
      expect(() => formatInstanceId(value.slice(0, value.indexOf("@")), 1)).toThrow(/Tribe instance session id/u)
    }
  })
})
