/**
 * @failure A launch-named adapter holding its launch's identity token registers under whatever TRIBE_LAUNCH_ID it
 *          inherited instead of the launch its token names, so a stale or foreign launch id keys the seat.
 * @level l1
 * @consumer the stdio adapter's register (stdio-adapter.ts LAUNCH_IDENTITY) and every reconnect that replays it
 * @testonly none
 *
 * Which launch an adapter registers under (21049, 25074 3d-1 and 3d-2, @cto 2bfc1935). The launch is the token's sid,
 * for a launch-named adapter and an unnamed child alike; for a hab seat that is the value TRIBE_LAUNCH_ID used to hold.
 * TRIBE_LAUNCH_ID is never read (3d-2): a tokenless process has no launch identity. A token whose claims cannot be read
 * is named, never decides the launch, and never stops a long-running adapter: the daemon's verifier judges the token.
 */

import { describe, expect, test } from "vitest"
import { adapterLaunchIdentity } from "../src/lib/adapter-launch-identity.ts"
import { deriveTribePersonaLaunchIdentity } from "../src/lib/persona-launch-identity.ts"
import { launchToken } from "./launch-token.ts"

const SEAT = "@dev/2"
const TOKEN_SID = "7b1c0d2e-token-sid"
const INHERITED = "37920dbf-inherited-launch"
const PARENT = 4242

const token = launchToken(TOKEN_SID, SEAT)
const resolveParentPid = () => PARENT

describe("adapterLaunchIdentity (25074 3d-1, 3d-2)", () => {
  test("a launch-named adapter with a token registers under the token's sid, not an inherited TRIBE_LAUNCH_ID", () => {
    expect(
      adapterLaunchIdentity({
        env: { HAB_ID_TOKEN: token, TRIBE_LAUNCH_ID: INHERITED },
        launchName: SEAT,
        resolveParentPid,
      }),
    ).toEqual({
      identity: { id: deriveTribePersonaLaunchIdentity(SEAT, TOKEN_SID).launchId, parentPid: PARENT },
      malformedToken: null,
    })
  })

  test("a tokenless process holding a TRIBE_LAUNCH_ID has no launch identity: the variable is never read (3d-2)", () => {
    expect(
      adapterLaunchIdentity({
        env: { TRIBE_LAUNCH_ID: INHERITED },
        launchName: SEAT,
        resolveParentPid: () => {
          throw new Error("resolved without an identity")
        },
      }),
    ).toEqual({ identity: null, malformedToken: null })
  })

  test("an unnamed child keys by the raw sid of the token it inherited, not an inherited TRIBE_LAUNCH_ID (3d-2)", () => {
    expect(
      adapterLaunchIdentity({
        env: { HAB_ID_TOKEN: token, TRIBE_LAUNCH_ID: INHERITED },
        launchName: undefined,
        resolveParentPid,
      }),
    ).toEqual({ identity: { id: TOKEN_SID, parentPid: PARENT }, malformedToken: null })
  })

  test("no token and no launch id is no launch identity, and the parent is never resolved", () => {
    expect(
      adapterLaunchIdentity({
        env: {},
        launchName: SEAT,
        resolveParentPid: () => {
          throw new Error("resolved without an identity")
        },
      }),
    ).toEqual({ identity: null, malformedToken: null })
  })

  test("a token whose claims cannot be read is named and does not decide the launch", () => {
    const read = adapterLaunchIdentity({
      env: { HAB_ID_TOKEN: "opaque-token", TRIBE_LAUNCH_ID: INHERITED },
      launchName: SEAT,
      resolveParentPid,
    })
    expect(read.identity).toBeNull()
    expect(read.malformedToken).toContain("HAB_ID_TOKEN is malformed")
  })
})
