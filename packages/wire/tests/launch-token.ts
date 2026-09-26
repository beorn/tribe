/**
 * A test process's launch identity (25074 3d-1). Tribe's managed CLI and a launch-named adapter read their launch from
 * the identity token's sid, never from TRIBE_LAUNCH_ID, so a fixture that means "this process belongs to launch X"
 * states it with a token for X. The token is JWT-shaped and unsigned: clients read it unverified; a daemon without an
 * identity verifier keys the launch id it is sent, and one with a verifier judges the token itself.
 */

export function launchToken(launchId: string, actor = "test-seat", kind?: "service"): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const act = kind === undefined ? { sub: actor } : { sub: actor, kind }
  return `${part({ alg: "EdDSA", typ: "hab-id+jwt" })}.${part({ sid: launchId, gen: 1, act })}.c2ln`
}

/**
 * The environment that makes a process launch `launchId`, or no launch at all for "". HAB_ID_TOKEN "" is read as no
 * token, so an inherited runner token never decides a fixture's launch. No launcher projects TRIBE_LAUNCH_ID since
 * 25074 3d-2b and nothing reads it, so a fixture carries only the token.
 */
export function launchEnvironment(launchId: string): { HAB_ID_TOKEN: string } {
  return { HAB_ID_TOKEN: launchId === "" ? "" : launchToken(launchId) }
}
