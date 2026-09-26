/**
 * The launch's identity token (25074 3b). A managed launch carries it, and `register` forwards it as `idToken`; the
 * daemon's composing-layer verifier alone decides what it proves. A client reads its claims only unverified, to name
 * its own launch and actor (readUnverifiedTokenClaims below). An unset or empty variable is a launch without a token,
 * served on its bearer or its claimed name.
 */
export const HAB_ID_TOKEN_ENV = "HAB_ID_TOKEN"

export function readIdentityTokenFromEnvironment(env: Readonly<NodeJS.ProcessEnv>): string | null {
  const raw = env[HAB_ID_TOKEN_ENV]
  return raw === undefined || raw.length === 0 ? null : raw
}

/**
 * What a token names, read BEFORE anything verifies it (25074 3d-1, @cto 082a4259 (c)): its launch (`sid`) and its
 * actor (`act.sub`, with `act.kind` "service" for a hab service). Verification has one home, the daemon; this read
 * checks only presence and shape, so a malformed token fails here, by name, instead of as a daemon refusal nobody can
 * read.
 */
export type UnverifiedTokenClaims = Readonly<{ sid: string; actor: string; kind?: "service" }>

export function readUnverifiedTokenClaims(token: string): UnverifiedTokenClaims {
  const payload = token.split(".")[1]
  let claims: { readonly sid?: unknown; readonly act?: { readonly sub?: unknown; readonly kind?: unknown } }
  try {
    if (payload === undefined) throw new Error("it is not a three-part JWT")
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof claims
  } catch (error) {
    throw new Error(
      `${HAB_ID_TOKEN_ENV} is malformed: ${error instanceof Error ? error.message : String(error)}; relaunch the seat through hab`,
    )
  }
  const sid = claims.sid
  const actor = claims.act?.sub
  if (typeof sid !== "string" || sid.length === 0 || typeof actor !== "string" || actor.length === 0) {
    throw new Error(`${HAB_ID_TOKEN_ENV} is malformed: it names no sid or no act.sub; relaunch the seat through hab`)
  }
  return claims.act?.kind === "service" ? { sid, actor, kind: "service" } : { sid, actor }
}

/**
 * This process's own launch id: its identity token's sid (25074 3d-1). TRIBE_LAUNCH_ID is never read: for a hab seat
 * it held the same value, and after 3d-2 no launcher sets it. Null means no token, a process outside any hab launch.
 */
export function readLaunchIdFromToken(env: Readonly<NodeJS.ProcessEnv>): string | null {
  const token = readIdentityTokenFromEnvironment(env)
  return token === null ? null : readUnverifiedTokenClaims(token).sid
}

/**
 * The same read for a long-running process (the adapter, ag's controller and roster; review of 4c7f239adf, note 2). A
 * malformed token is returned as `malformedToken` rather than thrown: the process names it and runs on, the token still
 * decides nothing, and the daemon's verifier judges it when it is presented. A one-shot uses readLaunchIdFromToken and
 * fails by name instead.
 */
export function readTokenLaunch(
  env: Readonly<NodeJS.ProcessEnv>,
): Readonly<{ launchId: string | null; malformedToken: string | null }> {
  const token = readIdentityTokenFromEnvironment(env)
  if (token === null) return { launchId: null, malformedToken: null }
  try {
    return { launchId: readUnverifiedTokenClaims(token).sid, malformedToken: null }
  } catch (error) {
    return { launchId: null, malformedToken: error instanceof Error ? error.message : String(error) }
  }
}
