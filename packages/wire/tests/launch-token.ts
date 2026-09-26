import { writeFileSync } from "node:fs"

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

/**
 * Write a test identity verifier module that verifies any token by its own claims, as launchToken writes them (25074
 * 3d-3). A one-shot self-read and a session's mailbox read capability need a verified token since the launcher-minted
 * bearer went, so a fixture that means "this is a managed seat" boots its daemon with `--identity-verifier <path>` and
 * gives the seat launchToken(launchId, seatName). `gen: false` omits the verdict's gen, so the daemon keys the session
 * by the launch id its client sent rather than `<sid>@<gen>`, and a fixture's launch ids read as they did before.
 */
export function writeClaimsVerifier(verifierPath: string, opts: { gen: boolean } = { gen: true }): void {
  const gen = opts.gen ? ", gen: claims.gen" : ""
  writeFileSync(
    verifierPath,
    `export const IDENTITY_VERIFIER_INTERFACE = 1
export async function verifyIdentity(token) {
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"))
  return { result: "verified", actor: claims.act.sub, sid: claims.sid${gen} }
}
`,
  )
}
