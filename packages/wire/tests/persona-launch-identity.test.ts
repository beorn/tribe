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
    expect(deriveTribePersonaLaunchIdentity("@cto", "provider-launch").providerLaunchKey).toBe("provider-launch::%40cto")
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
    expect(() => formatInstanceId("session", -1)).toThrow(/non-negative integer/u)
    expect(() => formatInstanceId("session", 1.5)).toThrow(/non-negative integer/u)
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
    expect(() => parseInstanceId("@467")).toThrow(/no session id/u)
  })
})
