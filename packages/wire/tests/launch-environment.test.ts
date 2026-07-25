import { describe, expect, test } from "vitest"

import {
  projectTribeLaunchEnvironment,
  readTribeLaunchId,
  tribeLaunchEnvironmentNames,
  withTribeLaunchEnvironment,
} from "../src/launch-environment.ts"

describe("Tribe launch environment boundary", () => {
  test("owns the adapter-private carrier behind a neutral launchId API", () => {
    const projected = projectTribeLaunchEnvironment("provider-launch-a")

    expect(projected).toEqual({ TRIBE_LAUNCH_ID: "provider-launch-a" })
    expect(readTribeLaunchId(projected)).toBe("provider-launch-a")
    expect(tribeLaunchEnvironmentNames()).toEqual(["TRIBE_LAUNCH_ID"])
  })

  test("overwrites inherited identity and removes stale parent provenance", () => {
    expect(
      withTribeLaunchEnvironment(
        {
          KEEP: "yes",
          TRIBE_LAUNCH_ID: "parent-launch",
          TRIBE_LAUNCH_PARENT_PID: "123",
        },
        "child-launch",
      ),
    ).toEqual({
      KEEP: "yes",
      TRIBE_LAUNCH_ID: "child-launch",
      TRIBE_LAUNCH_PARENT_PID: undefined,
    })
  })

  test("omits absent launch identity and normalizes blank reads", () => {
    expect(projectTribeLaunchEnvironment(undefined)).toEqual({})
    expect(readTribeLaunchId({ TRIBE_LAUNCH_ID: "   " })).toBeUndefined()
    expect(withTribeLaunchEnvironment({ TRIBE_LAUNCH_ID: "inherited" }, undefined)).toEqual({
      TRIBE_LAUNCH_ID: undefined,
      TRIBE_LAUNCH_PARENT_PID: undefined,
    })
  })
})
