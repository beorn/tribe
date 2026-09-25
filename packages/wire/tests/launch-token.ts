/**
 * A test process's launch identity (25074 3d-1). Tribe's managed CLI and a launch-named adapter read their launch from
 * the identity token's sid, never from TRIBE_LAUNCH_ID, so a fixture that means "this process belongs to launch X"
 * states it with a token for X. The token is JWT-shaped and unsigned: clients read it unverified; a daemon without an
 * identity verifier keys the launch id it is sent, and one with a verifier judges the token itself.
 */

export function launchToken(launchId: string, actor = "test-seat"): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${part({ alg: "EdDSA", typ: "hab-id+jwt" })}.${part({ sid: launchId, gen: 1, act: { sub: actor } })}.c2ln`
}

/**
 * The environment names that make a process launch `launchId`, or no launch at all for "". TRIBE_LAUNCH_ID stays
 * beside the token for the adapter's tokenless path until 3d-2 stops projecting it; HAB_ID_TOKEN "" is read as no token,
 * so an inherited runner token never decides a fixture's launch.
 */
export function launchEnvironment(launchId: string): { TRIBE_LAUNCH_ID: string; HAB_ID_TOKEN: string } {
  return { TRIBE_LAUNCH_ID: launchId, HAB_ID_TOKEN: launchId === "" ? "" : launchToken(launchId) }
}
