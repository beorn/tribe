import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

import * as wire from "../src/index.ts"

import {
  projectTribeLaunchEnvironment,
  readTribeLaunchId,
  tribeFixtureExcludedEnvironmentNames,
  tribeLaunchEnvironmentNames,
  tribeSessionIdentityEnvironmentNames,
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

/**
 * 24644 bullet 3 (@cto amendment 2026-09-23): a disposable fixture declares its
 * own world and inherits none of the seat-scoped environment tribe reads. This
 * list is tribe's single statement of those names; fixtures delete it instead
 * of hand-rolling their own.
 */
describe("the names a disposable fixture must not inherit", () => {
  const packagesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

  test("are every session identity name, the roster pair, and the seat state tribe reads, and never PATH or HOME", () => {
    const names = tribeFixtureExcludedEnvironmentNames()
    expect(names).toEqual(expect.arrayContaining([...tribeSessionIdentityEnvironmentNames()]))
    expect(names).toEqual(
      expect.arrayContaining([
        "TRIBE_EXPECTED_MEMBERS",
        "TRIBE_EXPECTED_MEMBERS_FILE",
        "CLAUDE_SESSION_ID",
        "CLAUDE_SESSION_NAME",
        "BD_ACTOR",
        "TRIBE_DELIVERY_FALLBACKS",
        "HAB_SESSION_HABITAT_ROOT",
      ]),
    )
    expect(names).not.toContain("PATH")
    expect(names).not.toContain("HOME")
    expect(new Set(names).size).toBe(names.length)
  })

  test("are exported from the package entry", () => {
    expect(wire.tribeFixtureExcludedEnvironmentNames()).toEqual(tribeFixtureExcludedEnvironmentNames())
  })

  test("are deleted through the helper, never by a hand-rolled delete in a tribe test", () => {
    const names = tribeFixtureExcludedEnvironmentNames()
    const handRolled: string[] = []
    for (const pkg of readdirSync(packagesDir)) {
      let files: string[]
      try {
        files = readdirSync(join(packagesDir, pkg, "tests"), { recursive: true }) as string[]
      } catch {
        continue
      }
      for (const file of files.filter((name) => /\.test\.tsx?$/u.test(name))) {
        const source = readFileSync(join(packagesDir, pkg, "tests", file), "utf8")
        for (const name of names) {
          if (new RegExp(`delete \\w+(?:\\.${name}\\b|\\[["']${name}["']\\])`, "u").test(source)) {
            handRolled.push(`${pkg}/tests/${file}: ${name}`)
          }
        }
      }
    }
    expect(handRolled).toEqual([])
  })
})
