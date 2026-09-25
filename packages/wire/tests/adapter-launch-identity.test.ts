/**
 * @failure A launch-named adapter holding its launch's identity token registers under whatever TRIBE_LAUNCH_ID it
 *          inherited instead of the launch its token names, so a stale or foreign launch id keys the seat.
 * @level l1
 * @consumer the stdio adapter's register (stdio-adapter.ts LAUNCH_IDENTITY) and every reconnect that replays it
 * @testonly none
 *
 * Which launch an adapter registers under (21049, 25074 3d-1, @cto 2bfc1935). A launch-named adapter with a token
 * takes the token's sid, which for a hab seat is the value TRIBE_LAUNCH_ID held. Tokenless launches (a standalone
 * `ag code`) and unnamed children keep reading TRIBE_LAUNCH_ID until 3d-2 stops projecting it; that fallback and its
 * row are 3d-2's deletion. A token whose claims cannot be read is named, never decides the launch, and never stops a
 * long-running adapter: the daemon's verifier judges the token itself.
 */

import { describe, expect, test } from "vitest"
import { adapterLaunchIdentity } from "../src/lib/adapter-launch-identity.ts"
import { deriveTribePersonaLaunchIdentity } from "../src/lib/persona-launch-identity.ts"

const SEAT = "@dev/2"
const TOKEN_SID = "7b1c0d2e-token-sid"
const INHERITED = "37920dbf-inherited-launch"
const PARENT = 4242

function identityToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${part({ alg: "EdDSA" })}.${part(claims)}.c2ln`
}

const token = identityToken({ sid: TOKEN_SID, gen: 3, act: { sub: SEAT } })
const resolveParentPid = () => PARENT

describe("adapterLaunchIdentity (25074 3d-1)", () => {
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

  test("a tokenless launch keeps its projected TRIBE_LAUNCH_ID until 3d-2 removes the projection", () => {
    expect(adapterLaunchIdentity({ env: { TRIBE_LAUNCH_ID: INHERITED }, launchName: SEAT, resolveParentPid })).toEqual({
      identity: { id: deriveTribePersonaLaunchIdentity(SEAT, INHERITED).launchId, parentPid: PARENT },
      malformedToken: null,
    })
  })

  test("an unnamed child is unchanged: it forwards the raw TRIBE_LAUNCH_ID and never presents the token", () => {
    expect(
      adapterLaunchIdentity({
        env: { HAB_ID_TOKEN: token, TRIBE_LAUNCH_ID: INHERITED },
        launchName: undefined,
        resolveParentPid,
      }),
    ).toEqual({ identity: { id: INHERITED, parentPid: PARENT }, malformedToken: null })
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
    expect(read.identity).toEqual({ id: deriveTribePersonaLaunchIdentity(SEAT, INHERITED).launchId, parentPid: PARENT })
    expect(read.malformedToken).toContain("HAB_ID_TOKEN is malformed")
  })
})
