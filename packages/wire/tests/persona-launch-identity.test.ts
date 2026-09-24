import { describe, expect, test } from "vitest"

import { deriveTribePersonaLaunchIdentity, providerLaunchIdOf } from "../src/lib/persona-launch-identity.ts"

describe("persona launch identity", () => {
  test("one provider launch derives distinct routable and writer identities per persona", () => {
    expect(deriveTribePersonaLaunchIdentity("@chief", "provider-launch")).toEqual({
      persona: "@chief",
      providerLaunchId: "provider-launch",
      launchId: "provider-launch::%40chief",
      writer: "@chief#provider-launch::%40chief",
    })
    expect(deriveTribePersonaLaunchIdentity("@cto", "provider-launch").launchId).toBe("provider-launch::%40cto")
  })

  // A daemon restarted with no identity verifier refused every verified seat as "another seat's identity": its
  // authority row was keyed "<sid>@<gen>", which this read as a different provider launch (2026-09-24 08:06 PDT).
  test("a persona launch id and a verified session key name the same provider launch", () => {
    const persona = deriveTribePersonaLaunchIdentity("@dev/3", "e8b19c27").launchId
    expect(providerLaunchIdOf(persona)).toBe("e8b19c27")
    expect(providerLaunchIdOf("e8b19c27@467")).toBe("e8b19c27")
    expect(providerLaunchIdOf("e8b19c27")).toBe("e8b19c27")
    expect(providerLaunchIdOf("e8b19c270@1")).not.toBe(providerLaunchIdOf(persona))
  })

  test.each(["", " ", "@chief#other"])("refuses an invalid persona %j", (persona) => {
    expect(() => deriveTribePersonaLaunchIdentity(persona, "provider-launch")).toThrow(/Tribe persona/u)
  })
})
