/**
 * The identity-verifier seam (25074 3b, @cto 4a194bbf). Tribe declares the contract and never verifies a token
 * itself: the composing layer names a module on the daemon's launch line (`--identity-verifier <absolute path>`),
 * and the daemon loads it once at boot. The module exports `IDENTITY_VERIFIER_INTERFACE = 1` and
 * `verifyIdentity(token)`; a missing file, a wrong interface number or a missing function refuses startup naming
 * the path. With no flag the daemon runs as before: sessions are served on their bearer or their claimed name.
 *
 * Authority is a facet of a session: verified, bearer or claimed. A claimed registration never displaces a live
 * managed holder (24767's refusal, the holder untouched); a verified registration displaces a holder that only
 * claimed the name.
 */

import { isAbsolute } from "node:path"
import { existsSync } from "node:fs"

export const IDENTITY_VERIFIER_INTERFACE_VERSION = 1

export type IdentityVerdict =
  | { readonly result: "verified"; readonly actor: string; readonly sid: string }
  | { readonly result: "absent" }
  | { readonly result: "unreadable"; readonly reason: string }
  | { readonly result: "contradicted"; readonly reason: string }

export type IdentityVerifier = (token: string) => Promise<IdentityVerdict>

export interface LoadedIdentityVerifier {
  readonly path: string
  readonly verify: IdentityVerifier
}

export type SessionAuthority = "verified" | "bearer" | "claimed"

export function sessionAuthority(row: {
  readonly identity_sid: string | null
  readonly mailbox_authority_hash: string | null
}): SessionAuthority {
  if (row.identity_sid !== null) return "verified"
  return row.mailbox_authority_hash !== null ? "bearer" : "claimed"
}

/**
 * Whether a registration of `claimant` authority may displace a connected holder of `holder` authority (25074 3c,
 * @cto §10). A claimed registration never displaces a managed one. A bearer registration displaces a verified holder
 * only when that holder's instance is gone: its liveness decides, asked by re-verifying the token it registered with
 * (a live holder refuses, a dead or superseded one is displaced and told, an undecided one refuses as a fault the
 * claimant retries). A bearer registration arrives from a managed launch whose bootstrap fell back after a verifier
 * fault, so a relaunch against its own dead predecessor still proceeds. Every other pairing is today's precedence.
 */
export type DisplacementRule = "allowed" | "refused" | "holder-liveness"

export function displacementRule(holder: SessionAuthority, claimant: SessionAuthority): DisplacementRule {
  if (claimant === "claimed" && holder !== "claimed") return "refused"
  if (claimant === "bearer" && holder === "verified") return "holder-liveness"
  return "allowed"
}

/** Refuses loudly, naming the path, for every way the named module can fail the contract. */
export async function loadIdentityVerifier(path: string): Promise<LoadedIdentityVerifier> {
  const refuse = (why: string): never => {
    throw new Error(`--identity-verifier ${path}: ${why}`)
  }
  if (!isAbsolute(path)) refuse("must be an absolute path")
  if (!existsSync(path)) refuse("does not exist")
  let module: Record<string, unknown>
  try {
    module = (await import(path)) as Record<string, unknown>
  } catch (error) {
    return refuse(`failed to load: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (module.IDENTITY_VERIFIER_INTERFACE !== IDENTITY_VERIFIER_INTERFACE_VERSION) {
    refuse(
      `exports IDENTITY_VERIFIER_INTERFACE ${JSON.stringify(module.IDENTITY_VERIFIER_INTERFACE)}, ` +
        `this daemon speaks ${IDENTITY_VERIFIER_INTERFACE_VERSION}`,
    )
  }
  const verify = module.verifyIdentity
  if (typeof verify !== "function") return refuse("exports no verifyIdentity function")
  return {
    path,
    verify: async (token) => checkedVerdict(await (verify as (token: string) => unknown)(token), path),
  }
}

/** A verdict outside the contract is the verifier's fault, surfaced like a throw — never read as "unreadable". */
function checkedVerdict(value: unknown, path: string): IdentityVerdict {
  const verdict = value as Record<string, unknown> | null
  const nonEmpty = (field: unknown): field is string => typeof field === "string" && field.length > 0
  switch (verdict?.result) {
    case "verified":
      if (nonEmpty(verdict.actor) && nonEmpty(verdict.sid)) {
        return { result: "verified", actor: verdict.actor, sid: verdict.sid }
      }
      break
    case "absent":
      return { result: "absent" }
    case "unreadable":
    case "contradicted":
      if (nonEmpty(verdict.reason)) return { result: verdict.result, reason: verdict.reason }
      break
  }
  throw new Error(`identity verifier ${path} returned a verdict outside the contract: ${JSON.stringify(value)}`)
}
