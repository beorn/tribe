/**
 * Which launch an adapter registers under (21049, 25074 3d-1 and 3d-2, @cto 2bfc1935).
 *
 * Adapters forward a complete launcher-given identity or nothing; they never mint one. The launch is the identity
 * token's sid, for a launch-named adapter and an unnamed child alike: for a hab seat that is the value TRIBE_LAUNCH_ID
 * used to carry, so a live seat and its children key exactly as before. TRIBE_LAUNCH_ID is never read (3d-2): a
 * tokenless process has no launch identity, and registers as its bare name. Reading the sid presents nothing; only
 * a launch-named adapter presents the token (stdio-adapter), and the daemon verifies it.
 */

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
  const token = readIdentityTokenFromEnvironment(input.env)
  let sid: string | undefined
  let malformedToken: string | null = null
  if (token !== null) {
    try {
      sid = readUnverifiedTokenClaims(token).sid
    } catch (error) {
      malformedToken = error instanceof Error ? error.message : String(error)
    }
  }
  const providerLaunchId = sid
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
