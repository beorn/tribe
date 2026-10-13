/**
 * The identity-verifier seam (25074 3b, @cto 4a194bbf). Tribe declares the contract and never verifies a token
 * itself: the composing layer names a module on the daemon's launch line (`--identity-verifier <absolute path>`),
 * and the daemon loads it once at boot. The module exports `IDENTITY_VERIFIER_INTERFACE = 1` and
 * `verifyIdentity(token)`; a missing file, a wrong interface number or a missing function refuses startup naming
 * the path. With no flag the daemon serves sessions on their claimed name only, and a one-shot caller that needs its
 * own session is refused by name (25074 3d-3: the launcher-minted bearer is gone).
 * With the flag, an explicit `@` persona with no token, a syntactically malformed token, or an absent verifier verdict
 * is refused before registration (26524). Bare and unnamed joins remain claimed; a verifier's unreadable verdict for
 * a syntactically readable token retains the claimed fallback during a broken signing-key incident.
 *
 * Authority is a facet of a session: verified or claimed. A claimed registration never displaces a live verified
 * holder (24767's refusal, the holder untouched); a verified registration displaces a holder that only claimed the
 * name.
 */

import { isAbsolute } from "node:path"
import { accessSync, constants, existsSync, statSync } from "node:fs"

export const IDENTITY_VERIFIER_INTERFACE_VERSION = 1

/**
 * `gen` (25074 3c-2a, @cto aa2918fd) is optional and additive on interface 1: the token's instance generation. With it a
 * register that sends no launch id is keyed `<sid>@<gen>`; without it such a register refuses by name. A module that
 * fills it says so by exporting `IDENTITY_VERIFIER_SUPPLIES_GEN = true`, which the daemon reports in health.
 */
export type IdentityVerdict =
  | {
      readonly result: "verified"
      readonly actor: string
      readonly kind?: "service"
      readonly sid: string
      readonly gen?: number
    }
  | { readonly result: "absent" }
  | { readonly result: "unreadable"; readonly reason: string }
  | { readonly result: "contradicted"; readonly reason: string }
  /**
   * No verdict yet: the daemon's bounded wrapper synthesises this when a probe outlives the in-path
   * bound (28927). A module never returns it — checkedVerdict rejects it as outside the contract.
   */
  | { readonly result: "undecided"; readonly reason: string }

export type IdentityVerifier = (token: string) => Promise<IdentityVerdict>

export type IncidentOperation = "read" | "raise" | "clear"
export type IncidentPolicy = {
  readonly emitters: readonly string[]
  readonly authorize: (
    identity: Extract<IdentityVerdict, { result: "verified" }>,
    emitter: string,
    operation: IncidentOperation,
  ) => boolean
}

export interface LoadedIdentityVerifier {
  readonly path: string
  readonly verify: IdentityVerifier
  /** Whether the module declares that its verified verdicts carry `gen`. */
  readonly suppliesGen: boolean
  /** Read and validate the host policy per operation; faults never prevent unrelated traffic. */
  readonly readIncidentPolicy?: () => IncidentPolicy
}

export interface BoundedIdentityVerifierOptions {
  /** How long a verdict may be served from cache: tens of seconds (28927 pin 2). */
  readonly ttlMs?: number
  /** How long a call may wait on a probe before it is answered undecided: a few hundred ms (28927 pin 4). */
  readonly waitMs?: number
  /** Clock override for tests; the cache ages by this, the wait by real timers. */
  readonly now?: () => number
}

const VERDICT_TTL_MS = 30_000
const VERDICT_WAIT_MS = 250
const VERDICT_CACHE_MAX = 1_024

/**
 * The bounded verifier (28927, @cto f7046649): the daemon never waits on a raw liveness probe on the
 * dispatcher path. The probe spawn and its wait are asynchronous and scoped to the calling connection —
 * a slow probe for one seat delays that seat's call only, never the dispatch of another's. A per-seat
 * verdict cache (keyed by the token only its seat holds) serves fresh verdicts for a short TTL; at most
 * one probe is in flight per seat and concurrent calls share it. A call waits at most `waitMs` on a
 * probe: past that it is answered with the synthesised `undecided` verdict member at once while the
 * probe finishes in the background and lands its verdict in the
 * cache. Nothing is ever marked verified without a verdict: only a verdict the probe actually returned
 * — fresh or cached — is ever served as one, and a thrown probe is never cached.
 */
export function boundedIdentityVerifier(
  loaded: LoadedIdentityVerifier,
  options: BoundedIdentityVerifierOptions = {},
): LoadedIdentityVerifier {
  const ttlMs = options.ttlMs ?? VERDICT_TTL_MS
  const waitMs = options.waitMs ?? VERDICT_WAIT_MS
  const now = options.now ?? Date.now
  const cache = new Map<string, { verdict: IdentityVerdict; at: number }>()
  const inFlight = new Map<string, Promise<IdentityVerdict>>()

  const fresh = (token: string): IdentityVerdict | undefined => {
    const held = cache.get(token)
    return held !== undefined && now() - held.at < ttlMs ? held.verdict : undefined
  }

  const probe = (token: string): Promise<IdentityVerdict> => {
    const existing = inFlight.get(token)
    if (existing !== undefined) return existing
    const started = (async (): Promise<IdentityVerdict> => {
      const verdict = await loaded.verify(token)
      if (cache.size >= VERDICT_CACHE_MAX) {
        for (const [key, held] of cache) {
          if (now() - held.at >= ttlMs) cache.delete(key)
        }
        if (cache.size >= VERDICT_CACHE_MAX) {
          const oldest = cache.keys().next().value
          if (oldest !== undefined) cache.delete(oldest)
        }
      }
      cache.delete(token)
      cache.set(token, { verdict, at: now() })
      return verdict
    })()
    inFlight.set(token, started)
    const settle = (): void => {
      if (inFlight.get(token) === started) inFlight.delete(token)
    }
    void started.then(settle, settle)
    return started
  }

  return {
    path: loaded.path,
    suppliesGen: loaded.suppliesGen,
    ...(loaded.readIncidentPolicy === undefined ? {} : { readIncidentPolicy: loaded.readIncidentPolicy }),
    verify: async (token: string): Promise<IdentityVerdict> => {
      const cached = fresh(token)
      if (cached !== undefined) return cached
      const pending = probe(token)
      let timer: ReturnType<typeof setTimeout> | undefined
      const outcome = await Promise.race([
        pending.then(
          (verdict) => ({ verdict }) as const,
          (error: unknown) => ({ error }) as const,
        ),
        new Promise<{ timeout: true }>((resolve) => {
          timer = setTimeout(() => resolve({ timeout: true }), waitMs)
        }),
      ])
      if (timer !== undefined) clearTimeout(timer)
      if ("verdict" in outcome) return outcome.verdict
      if ("error" in outcome) throw outcome.error
      // Past the bounded wait: a verdict that landed in the same instant still serves; otherwise the
      // call is answered undecided at once and the probe finishes in the background. The synthesised
      // undecided is returned, never cached: only a verdict the probe itself returns may be cached.
      const landed = fresh(token)
      if (landed !== undefined) return landed
      return { result: "undecided", reason: `no verdict within ${String(waitMs)}ms` }
    },
  }
}

export type SessionAuthority = "verified" | "claimed"

/** A session is verified when it registered with a verified identity token (its sid is recorded), else claimed. */
export function sessionAuthority(row: { readonly identity_sid: string | null }): SessionAuthority {
  return row.identity_sid !== null ? "verified" : "claimed"
}

/**
 * Whether a registration of `claimant` authority may displace a connected holder of `holder` authority (25074 3c,
 * @cto §10). A claimed registration never displaces a verified one; every other pairing is today's precedence. The
 * bearer's holder-liveness arm went with the bearer (25074 3d-3).
 */
export type DisplacementRule = "allowed" | "refused"

export function displacementRule(holder: SessionAuthority, claimant: SessionAuthority): DisplacementRule {
  if (claimant === "claimed" && holder !== "claimed") return "refused"
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
  const suppliesGen = module.IDENTITY_VERIFIER_SUPPLIES_GEN
  if (suppliesGen !== undefined && typeof suppliesGen !== "boolean") {
    refuse(`exports IDENTITY_VERIFIER_SUPPLIES_GEN ${JSON.stringify(suppliesGen)}, not a boolean`)
  }
  const loadedStat = statSync(path)
  const readIncidentPolicy = (): IncidentPolicy => {
    const fail = (reason: string): never => {
      throw new Error(`incident policy ${path}: ${reason}`)
    }
    try {
      accessSync(path, constants.R_OK)
      const current = statSync(path)
      if (
        current.ino !== loadedStat.ino ||
        current.mtimeMs !== loadedStat.mtimeMs ||
        current.size !== loadedStat.size
      ) {
        fail("module changed since load; adopt the current module through the daemon's supervisor")
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
    const policy = module.INCIDENT_POLICY as Partial<IncidentPolicy> | null | undefined
    if (
      !policy ||
      !Array.isArray(policy.emitters) ||
      policy.emitters.length === 0 ||
      policy.emitters.some(
        (emitter) => typeof emitter !== "string" || emitter.trim() !== emitter || emitter.length === 0,
      ) ||
      new Set(policy.emitters).size !== policy.emitters.length ||
      typeof policy.authorize !== "function"
    ) {
      return fail("INCIDENT_POLICY must declare distinct emitter names and an authorize function")
    }
    return policy as IncidentPolicy
  }
  return {
    path,
    verify: async (token) => checkedVerdict(await (verify as (token: string) => unknown)(token), path),
    suppliesGen: suppliesGen === true,
    readIncidentPolicy,
  }
}

/** A verdict outside the contract is the verifier's fault, surfaced like a throw — never read as "unreadable". */
function checkedVerdict(value: unknown, path: string): IdentityVerdict {
  const verdict = value as Record<string, unknown> | null
  const nonEmpty = (field: unknown): field is string => typeof field === "string" && field.length > 0
  switch (verdict?.result) {
    case "verified":
      if (nonEmpty(verdict.actor) && nonEmpty(verdict.sid)) {
        if (verdict.kind !== undefined && verdict.kind !== "service") break
        const kind = verdict.kind === "service" ? { kind: "service" as const } : {}
        if (verdict.gen === undefined) return { result: "verified", actor: verdict.actor, sid: verdict.sid, ...kind }
        if (typeof verdict.gen === "number" && Number.isSafeInteger(verdict.gen) && verdict.gen >= 0) {
          return { result: "verified", actor: verdict.actor, sid: verdict.sid, gen: verdict.gen, ...kind }
        }
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
