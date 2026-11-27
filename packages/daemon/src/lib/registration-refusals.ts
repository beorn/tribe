/**
 * 33946: registrations this daemon REFUSED, with when and why. Health must go red on these. On 2026-11-12 a reboot
 * left seats unable to re-register (80 NameConflict refusals in 3 min) while `tribe health` answered healthy: a
 * refused transport leaves no live session for the mailbox-authority check to read. Cleared by that transport's next
 * successful register; expired by TTL so a one-off refusal cannot hold the rail red for ever.
 *
 * #38997 (@cto ddc5f634 / c8ac5657): a token from ANOTHER habitat (verifier rule `aud-is-own-habitat`) is not this
 * habitat's member failing to register. It is kept apart from the member's own entry and names the foreign habitat,
 * so a fixture habitat dialling the live daemon never reads as "registration refused for habmod". `rule` is an open
 * string a verifier plugin defines; the daemon branches only on this one value, and a verdict without it keys by member.
 */

/** The one verifier rule the daemon reads: the token was minted by and for a different habitat. */
export const FOREIGN_HABITAT_RULE = "aud-is-own-habitat"

type Refusal = {
  readonly name: string
  readonly kind: string
  readonly at: number
  readonly pid: number
  readonly launchId: string | null
  readonly foreignReason: string | null
}

export type RegistrationRefusals = {
  note(
    name: string,
    kind: string,
    identity: { readonly pid: number; readonly launchId: string | null },
    detail?: { readonly rule?: string; readonly reason?: string },
  ): void
  /** A successful register under `name` clears that member's own refusal; another habitat's expires by TTL only. */
  registered(name: string): void
  unresolved(
    now: number,
    live: ReadonlyArray<{ readonly name: string; readonly pid: number; readonly launchId: string | null }>,
  ): string[]
}

export function createRegistrationRefusals(ttlMs: number): RegistrationRefusals {
  const refusals = new Map<string, Refusal>()
  return {
    note(name, kind, identity, detail) {
      if (!name || name.startsWith("pending-") || name === "(no name)") return
      const foreign = detail?.rule === FOREIGN_HABITAT_RULE
      refusals.set(foreign ? `foreign-habitat\u0000${name}` : name, {
        name,
        kind,
        at: Date.now(),
        pid: identity.pid,
        launchId: identity.launchId,
        foreignReason: foreign ? (detail?.reason ?? "no reason given") : null,
      })
    },
    registered(name) {
      refusals.delete(name)
    },
    /**
     * Refusals still unresolved because the REFUSED transport never got in. A live holder under the same name is
     * not resolution: in the 2026-11-12 incident the holder was each seat's own `ag code` process, so "some live
     * transport holds the name" was exactly the wedge. Resolution is the refused identity registering, or the TTL.
     */
    unresolved(now, live) {
      const issues: string[] = []
      for (const [key, refusal] of refusals) {
        const refusedTransportGotIn = live.some(
          (session) =>
            session.name === refusal.name &&
            (session.pid === refusal.pid || (refusal.launchId !== null && session.launchId === refusal.launchId)),
        )
        if (refusedTransportGotIn || now - refusal.at >= ttlMs) {
          refusals.delete(key)
          continue
        }
        const age = `${Math.max(1, Math.round((now - refusal.at) / 1000))}s ago`
        issues.push(
          refusal.foreignReason === null
            ? `registration refused for ${refusal.name} (${refusal.kind}) ${age}; the refused transport is still not registered`
            : `another habitat's token claiming ${refusal.name} was refused (${refusal.kind}) ${age}: ${refusal.foreignReason}; this habitat's ${refusal.name} is unaffected`,
        )
      }
      return issues.sort()
    },
  }
}
