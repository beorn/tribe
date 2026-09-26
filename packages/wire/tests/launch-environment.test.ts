import { describe, expect, test } from "vitest"

import { tribeSessionIdentityEnvironmentNames, withTribeLaunchEnvironment } from "../src/launch-environment.ts"

// 25074 3d-2b (@cto 0c284929): a launch's id travels structurally between its launchers, and its adapter keys by the
// identity token's sid. The boundary projects nothing and clears the parent hint a certified registration projects.
describe("Tribe launch environment boundary", () => {
  test("clears stale parent provenance, and projects nothing", () => {
    expect(
      withTribeLaunchEnvironment({
        KEEP: "yes",
        TRIBE_LAUNCH_PARENT_PID: "123",
      }),
    ).toEqual({
      KEEP: "yes",
      TRIBE_LAUNCH_PARENT_PID: undefined,
    })
  })

  test("the session identity scrub clears the parent hint", () => {
    expect(tribeSessionIdentityEnvironmentNames()).toContain("TRIBE_LAUNCH_PARENT_PID")
  })
})
