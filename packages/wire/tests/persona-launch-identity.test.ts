import { describe, expect, test } from "vitest"

import { deriveTribePersonaLaunchIdentity } from "../src/lib/persona-launch-identity.ts"

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

  test.each(["", " ", "@chief#other"])("refuses an invalid persona %j", (persona) => {
    expect(() => deriveTribePersonaLaunchIdentity(persona, "provider-launch")).toThrow(/Tribe persona/u)
  })
})
