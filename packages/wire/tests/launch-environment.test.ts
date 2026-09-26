import { describe, expect, test } from "vitest"

import { tribeSessionIdentityEnvironmentNames, withTribeLaunchEnvironment } from "../src/launch-environment.ts"

// 25074 3d-2b (@cto 0c284929): a launch's id travels structurally between its launchers, and its adapter keys by the
// identity token's sid. The boundary projects nothing and clears what an older launcher may still export.
describe("Tribe launch environment boundary", () => {
  test("clears an inherited launch id and stale parent provenance, and projects nothing", () => {
    expect(
      withTribeLaunchEnvironment({
        KEEP: "yes",
        TRIBE_LAUNCH_ID: "parent-launch",
        TRIBE_LAUNCH_PARENT_PID: "123",
      }),
    ).toEqual({
      KEEP: "yes",
      TRIBE_LAUNCH_ID: undefined,
      TRIBE_LAUNCH_PARENT_PID: undefined,
    })
  })

  test("the session identity scrub keeps both names through the rollover (deletion row: 3d-3)", () => {
    expect(tribeSessionIdentityEnvironmentNames()).toEqual(
      expect.arrayContaining(["TRIBE_LAUNCH_ID", "TRIBE_LAUNCH_PARENT_PID"]),
    )
  })
})
