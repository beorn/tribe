/**
 * Which launch an adapter registers under (21049, 25074 3d-1, @cto 2bfc1935).
 *
 * Adapters forward a complete launcher-given identity or nothing; they never mint one. A launch-named adapter that
 * holds its launch's identity token registers under the token's sid: for a hab seat that is the value TRIBE_LAUNCH_ID
 * carried, so a live seat keys exactly as before, and an inherited or stale TRIBE_LAUNCH_ID beside the token no longer
 * decides it. A tokenless launch (a standalone `ag code`) and an unnamed child still read TRIBE_LAUNCH_ID; 3d-2 stops
 * projecting it and deletes that fallback with it. The token is read unverified; the daemon verifies it.
 */

import { readTribeLaunchId } from "../launch-environment.ts"
import { readIdentityTokenFromEnvironment, readUnverifiedTokenClaims } from "./identity-token.ts"
import { deriveTribePersonaLaunchIdentity } from "./persona-launch-identity.ts"

export interface AdapterLaunchIdentity {
  readonly id: string
  readonly parentPid: number
}

export function adapterLaunchIdentity(input: {
  readonly env: Readonly<NodeJS.ProcessEnv>
  /** The name this adapter registers under as its launch's seat; undefined for an unnamed child. */
  readonly launchName: string | undefined
  /** The launch's parent pid, resolved only when there is an identity to key (a plugin child validates it). */
  readonly resolveParentPid: () => number
}): {
  readonly identity: AdapterLaunchIdentity | null
  /** Why the token's claims could not be read; the adapter says so, and the daemon's verifier still judges the token. */
  readonly malformedToken: string | null
} {
  const token = input.launchName === undefined ? null : readIdentityTokenFromEnvironment(input.env)
  let sid: string | undefined
  let malformedToken: string | null = null
  if (token !== null) {
    try {
      sid = readUnverifiedTokenClaims(token).sid
    } catch (error) {
      malformedToken = error instanceof Error ? error.message : String(error)
    }
  }
  const providerLaunchId = sid ?? readTribeLaunchId(input.env)
  if (providerLaunchId === undefined || providerLaunchId.length === 0) return { identity: null, malformedToken }
  return {
    identity: {
      id:
        input.launchName === undefined
          ? providerLaunchId
          : deriveTribePersonaLaunchIdentity(input.launchName, providerLaunchId).launchId,
      parentPid: input.resolveParentPid(),
    },
    malformedToken,
  }
}
