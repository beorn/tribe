/**
 * #30968 (@cto fe467bec item 2): an adapter started with a participant's token file but no launch name never presents
 * that token (stdio-adapter registers its launch token only under a launch name), so it would run unverified as
 * unknown-<rand>. Refuse to start instead, naming the fix. Only a participant's (`@ext/...`) token is held to this:
 * a Hab seat always carries its TRIBE_NAME, and other callers keep their current behaviour.
 */
import { HAB_ID_TOKEN_FILE_ENV } from "./hab-session-env.ts"
import { readIdentityTokenFromEnvironment, readUnverifiedTokenClaims } from "./identity-token.ts"

export function participantLaunchNameRefusal(
  env: Readonly<NodeJS.ProcessEnv>,
  launchName: string | undefined,
): string | null {
  if (launchName !== undefined) return null
  const file = env[HAB_ID_TOKEN_FILE_ENV]
  if (file === undefined || file.length === 0) return null
  const token = readIdentityTokenFromEnvironment(env)
  if (token === null) return null
  const actor = readUnverifiedTokenClaims(token).actor
  if (!actor.startsWith("@ext/")) return null
  return (
    `tribe stdio adapter refused to start: ${HAB_ID_TOKEN_FILE_ENV} holds participant ${actor}'s token but no ` +
    `--name was given, so the token would never be presented and this session would run unverified as unknown-<rand>. ` +
    `Start it with --name ${actor} (#30968).`
  )
}
