/**
 * The identity-verifier seam (25074 3b, @cto 4a194bbf). Tribe declares the contract and never verifies a token
 * itself: the composing layer names a module on the daemon's launch line (`--identity-verifier <absolute path>`),
 * and the daemon SPAWNS it per call from its own runner (28921, @cto e87d593d) rather than importing it, so the
 * named path may be a promotion pointer the daemon follows without a restart. The module exports
 * `IDENTITY_VERIFIER_INTERFACE = 1` and `verifyIdentity(token)`; a missing file, a wrong interface number or a
 * missing function refuses startup naming the path. With no flag the daemon serves sessions on their claimed name only, and a one-shot caller that needs its
 * own session is refused by name (25074 3d-3: the launcher-minted bearer is gone).
 * With the flag, an explicit `@` persona with no token, a syntactically malformed token, or an absent verifier verdict
 * is refused before registration (26524). Bare and unnamed joins remain claimed; a verifier's unreadable verdict for
 * a syntactically readable token retains the claimed fallback during a broken signing-key incident.
 *
 * Authority is a facet of a session: verified or claimed. A claimed registration never displaces a live verified
 * holder (24767's refusal, the holder untouched); a verified registration displaces a holder that only claimed the
 * name.
 */

import { isAbsolute, join } from "node:path"
import { existsSync } from "node:fs"
import { createLogger } from "loggily"
import { runBoundedProcessCommand, type BoundedProcessCommandResult } from "../../../recall/src/lib/bounded-process.ts"

const log = createLogger("tribe:identity-verifier")

export const IDENTITY_VERIFIER_INTERFACE_VERSION = 1
/** The one marker a verifier child puts on its stderr, so the parent can tell a NAMED reason from a harness fault. */
export const CHILD_STDERR_MARKER = "identity-verifier-child: "

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
  /**
   * Whether this identity may act on this emitter. A module that authorizes in its own process (28921) answers with a
   * promise; a composing layer that still holds the policy in process answers with a boolean. Callers await it.
   */
  readonly authorize: (
    identity: Extract<IdentityVerdict, { result: "verified" }>,
    emitter: string,
    operation: IncidentOperation,
  ) => boolean | Promise<boolean>
}

/**
 * One fresh child's answer to an authorize request (28921 review): the verdict and the emitter list the module named
 * IN THAT SAME ANSWER. Membership is read from here, never from a snapshot, so a promotion that REMOVES an emitter
 * refuses the very next operation instead of granting it from cached bytes.
 */
export type LoadedIncidentAuthorization = {
  readonly allow: boolean
  readonly emitters: readonly string[]
}

/**
 * What the daemon's OWN `readIncidentPolicy()` hands back (28921 review): the composing module's policy, read through
 * the spawned child. `emitters` is cached data for a sync health getter and never decides a grant; `authorize` asks
 * the CURRENT module and answers with the list IT used, so one call decides membership and the verdict together.
 */
export type LoadedIncidentPolicy = {
  /** The list as of the last successful fresh call. Cached data: it may feed a sync health getter, never a grant. */
  readonly emitters: readonly string[]
  /** A policy fault seen when this policy was last read, carried as HEALTH data only (28921 review). */
  readonly fault?: string
  readonly authorize: (
    identity: Extract<IdentityVerdict, { result: "verified" }>,
    emitter: string,
    operation: IncidentOperation,
  ) => Promise<LoadedIncidentAuthorization>
}

export interface LoadedIdentityVerifier {
  readonly path: string
  readonly verify: IdentityVerifier
  /** Whether the module declares that its verified verdicts carry `gen`. */
  readonly suppliesGen: boolean
  /** Read and validate the host policy per operation; faults never prevent unrelated traffic. */
  readonly readIncidentPolicy?: () => LoadedIncidentPolicy
}

export interface BoundedIdentityVerifierOptions {
  /** How long a verdict may be served from cache: tens of seconds (28927 pin 2). */
  readonly ttlMs?: number
  /** How long a call may wait on a probe before it is answered undecided (28927 pin 4; 28947). */
  readonly waitMs?: number
  /** Clock override for tests; the cache ages by this, the wait by real timers. */
  readonly now?: () => number
  /**
   * Told when a probe that outlived some caller's wait lands its verdict in the cache, with its
   * eventual duration and verdict kind (28947, @cto must): the cold tail actually observed is what
   * the next revision of the wait bound is set from. A thrown probe lands nothing and is not told.
   */
  readonly onOutlivedProbe?: (landed: {
    readonly elapsedMs: number
    readonly result: IdentityVerdict["result"]
  }) => void
}

const VERDICT_TTL_MS = 30_000
// 28947: 250 ms was set against a steady-state probe (p50 2 ms); the measured cold tail — generation
// starts, register waves, the supervisor-socket leg under load — runs past it, and every refusal in
// the daemon log clustered there. 1000 ms stays five times under the socket's 5 s ack budget, and
// the wait is scoped to the calling connection, so only the cold call itself pays.
const VERDICT_WAIT_MS = 1_000
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
  // Each probe's start and whether some caller already stopped waiting on it, keyed by the probe
  // promise itself: when an outlived probe lands, the composition is told how long it took (28947).
  const probes = new Map<Promise<IdentityVerdict>, { startedAt: number; outlived: boolean }>()

  const fresh = (token: string): IdentityVerdict | undefined => {
    const held = cache.get(token)
    return held !== undefined && now() - held.at < ttlMs ? held.verdict : undefined
  }

  const probe = (token: string): Promise<IdentityVerdict> => {
    const existing = inFlight.get(token)
    if (existing !== undefined) return existing
    const startedAt = now()
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
    probes.set(started, { startedAt, outlived: false })
    const settle = (): void => {
      if (inFlight.get(token) === started) inFlight.delete(token)
    }
    void (async () => {
      try {
        const verdict = await started
        const seen = probes.get(started)
        probes.delete(started)
        if (seen?.outlived === true) {
          options.onOutlivedProbe?.({ elapsedMs: now() - seen.startedAt, result: verdict.result })
        }
      } catch {
        probes.delete(started)
      } finally {
        settle()
      }
    })()
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
      const seen = probes.get(pending)
      if (seen !== undefined) seen.outlived = true
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

/** What the process that IMPORTS the composing module hands back (28921): the module itself is never in this one. */
export interface LoadedVerifierModule {
  readonly path: string
  readonly verify: IdentityVerifier
  readonly suppliesGen: boolean
  readonly readIncidentPolicy: () => IncidentPolicy
}

/**
 * The module-side contract, checked WHERE THE MODULE LOADS (28921, @cto e87d593d): the spawned child runs this, so
 * every way a composing module can fail the contract is refused by name in the process that actually saw it, and the
 * daemon's own process holds none of the module's bytes.
 *
 * The "module changed since load" check is gone with the in-process import it guarded: a module imported by a fresh
 * process on every call cannot be stale, so there is nothing left to compare against a boot-time stat.
 */
export async function loadVerifierModule(path: string): Promise<LoadedVerifierModule> {
  const refuse = (why: string): never => {
    throw new Error(why)
  }
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
  const readIncidentPolicy = (): IncidentPolicy => {
    const fail = (reason: string): never => {
      throw new Error(`incident policy ${path}: ${reason}`)
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

/**
 * The daemon side of the seam (28921, @cto e87d593d): the composing module is SPAWNED per call, never imported.
 *
 * Why: imported in process, the verifier was pinned to the daemon's own landing, so a promotion that changed it was
 * invisible to the controller — the restart was skipped as equivalent and the fleet verified against abandoned code.
 * It is also the SECOND undeclared dependency the 28691 comment names ("its argv-named verifier"), which is why
 * wire's `ag` pin was load-bearing: importing the module imported ag. Spawning it per call is the 28657 shape the
 * per-call `hab` lookup already uses — resolution happens when the call is made, so the named path may be a promotion
 * pointer and the daemon still follows it without a restart.
 *
 * The runner is Tribe's own code, inside the daemon's digest; only the composing module leaves this process.
 */
const CHILD_TIMEOUT_MS = 6_000
const CHILD_KILL_GRACE_MS = 500
const CHILD_REAP_GRACE_MS = 1_000
const CHILD_DRAIN_GRACE_MS = 500
const CHILD_MAX_OUTPUT_BYTES = 64 * 1024

export type VerifierChildRequest =
  | { readonly op: "hello" }
  | { readonly op: "verify"; readonly token: string }
  | {
      readonly op: "authorize"
      readonly identity: Extract<IdentityVerdict, { result: "verified" }>
      readonly emitter: string
      readonly operation: IncidentOperation
    }

type HelloAnswer = {
  readonly interface?: unknown
  readonly suppliesGen?: unknown
  readonly emitters?: unknown
  readonly policyFault?: unknown
}
type AuthorizeAnswer = { readonly allow?: unknown; readonly emitters?: unknown }

/** Exactly one JSON value on stdout, or undefined: a chatty or truncated child is a fault, never a verdict. */
function exactlyOneJsonValue(stdout: string): unknown | undefined {
  const trimmed = stdout.trim()
  if (trimmed === "") return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    // Not a verdict, and never a default: verifierChild refuses this loudly by name ("answered no readable JSON
    // on stdout"), so nobody reads undefined as a decision here.
    return undefined // silent-fallback-allow: the caller refuses it by name; this is "no verdict", not a fallback value
  }
}

function firstStderrLine(stderr: string): string {
  const line = stderr.split("\n").find((candidate) => candidate.trim() !== "")
  return line === undefined ? "(no stderr)" : line.trim()
}

function childEmitters(answer: { readonly emitters?: unknown }): readonly string[] | null {
  const emitters = answer.emitters
  if (!Array.isArray(emitters) || emitters.length === 0) return null
  const named = emitters.filter((emitter): emitter is string => typeof emitter === "string" && emitter !== "")
  return named.length === emitters.length ? named : null
}

/**
 * The fault a policy answer NAMES, or an unusable policy, ALWAYS naming the path; null when the policy is usable
 * (28921 review). The message is used verbatim by whichever operation reads the current module, so it is not
 * re-prefixed — the path appears exactly once.
 */
function policyFaultOf(
  answer: { readonly emitters?: unknown; readonly policyFault?: unknown },
  path: string,
): string | null {
  if (typeof answer.policyFault === "string" && answer.policyFault !== "") return answer.policyFault
  return childEmitters(answer) === null
    ? `incident policy ${path}: the module declares no usable INCIDENT_POLICY`
    : null
}

/** One bounded, captured child call. The request travels on stdin so a token never reaches the process table. */
async function verifierChild(path: string, request: VerifierChildRequest): Promise<unknown> {
  if (process.versions.bun === undefined) {
    throw new Error(
      `cannot spawn a verifier child: this daemon is not running under bun (execPath ${process.execPath})`,
    )
  }
  const runner = join(import.meta.dirname, "identity-verifier-child.ts")
  let result: BoundedProcessCommandResult
  try {
    result = await runBoundedProcessCommand(
      [process.execPath, runner, "--module", path],
      {
        timeoutMs: CHILD_TIMEOUT_MS,
        killGraceMs: CHILD_KILL_GRACE_MS,
        reapGraceMs: CHILD_REAP_GRACE_MS,
        drainGraceMs: CHILD_DRAIN_GRACE_MS,
        maxOutputBytes: CHILD_MAX_OUTPUT_BYTES,
      },
      // The composing module reads its habitat from the process environment (HAB_SESSION_HABITAT_ROOT/NAME), exactly
      // as it did while it was imported, and Bun.spawn only carries the environment this process started with unless
      // it is handed one (measured 2026-10-14). So the child gets the daemon's CURRENT environment.
      { stdin: JSON.stringify(request), env: { ...process.env } },
    )
  } catch (error) {
    throw new Error(`its child did not settle: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (result.exitCode !== 0) {
    const named = firstStderrLine(result.stderr)
    // A reason the child NAMED is reported verbatim: the operator-visible line for a module that breaks the contract
    // stays exactly what it was when the module was imported (`--identity-verifier <path>: <reason>`).
    const reason = named.startsWith(CHILD_STDERR_MARKER) ? named.slice(CHILD_STDERR_MARKER.length) : null
    throw new Error(reason ?? `its child exited ${result.exitCode}: ${named}`)
  }
  const answer = exactlyOneJsonValue(result.stdout)
  if (answer === undefined) {
    throw new Error(`its child answered no readable JSON on stdout (${result.stdout.trim().slice(0, 120) || "empty"})`)
  }
  return answer
}

/** Refuses loudly, naming the path, for every way the named verifier can fail: the hello probe IS the boot check. */
export async function loadIdentityVerifier(path: string): Promise<LoadedIdentityVerifier> {
  function refuse(why: string): never {
    throw new Error(`--identity-verifier ${path}: ${why}`)
  }
  if (!isAbsolute(path)) refuse("must be an absolute path")
  if (!existsSync(path)) refuse("does not exist")
  let hello: HelloAnswer
  try {
    hello = (await verifierChild(path, { op: "hello" })) as HelloAnswer
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error))
  }
  if (hello.interface !== IDENTITY_VERIFIER_INTERFACE_VERSION) {
    refuse(
      `answers interface ${JSON.stringify(hello.interface)}, this daemon speaks ${IDENTITY_VERIFIER_INTERFACE_VERSION}`,
    )
  }
  const bootEmitters = childEmitters(hello)
  // A broken incident policy is NOT a boot refusal: identity verification stays available and the policy fault is
  // named where it is used (28044 AC1). The child reported it in the same hello.
  const bootPolicyFault = policyFaultOf(hello, path)
  // The emitter LIST is cached data (it feeds a sync health getter); a grant is always decided by ONE fresh child,
  // and that answer carries the list it used. Both are refreshed by ANY successful fresh call, and the fault clears
  // with them, so a repaired policy stops being reported as broken (28921 review).
  let emitters = bootEmitters ?? []
  let policyFault = bootPolicyFault
  const call = async (request: VerifierChildRequest): Promise<unknown> => {
    try {
      return await verifierChild(path, request)
    } catch (error) {
      throw new Error(`identity verifier ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    path,
    suppliesGen: hello.suppliesGen === true,
    verify: async (token) => checkedVerdict(await call({ op: "verify", token }), path),
    readIncidentPolicy: (): LoadedIncidentPolicy => {
      // Never throws (28921 review): a boot-time fault is carried as health data, and the operation path re-reads
      // the CURRENT module, so a repaired policy is adopted on the next call instead of refused forever.
      return {
        // Getters, not copied values: a caller that holds this policy across calls sees what the LAST fresh child
        // reported, never the boot snapshot (28921 review).
        get emitters() {
          return emitters
        },
        get fault() {
          return policyFault ?? undefined
        },
        authorize: async (
          identity,
          emitter: string,
          operation: IncidentOperation,
        ): Promise<LoadedIncidentAuthorization> => {
          const answer = (await call({ op: "authorize", identity, emitter, operation })) as AuthorizeAnswer
          const reported = childEmitters(answer)
          // The verdict and the list come from THIS answer (28921 review): an answer with no usable list cannot
          // decide membership, so it is refused by name rather than granted from the boot snapshot.
          if (reported === null) {
            throw new Error(`identity verifier ${path}: the authorize answer carried no emitter list`)
          }
          if (reported.length !== emitters.length || reported.some((n, i) => n !== emitters[i])) {
            log.warn?.(
              `identity verifier ${path}: its incident policy now names ${reported.join(", ")} where this daemon ` +
                `cached ${emitters.join(", ")} at boot; this verdict came from the current module, and the health ` +
                `line's membership check follows at the next daemon start`,
            )
            emitters = reported
          }
          // A fresh verdict proves the CURRENT policy is usable, so a boot-time fault must stop being reported.
          policyFault = null
          return { allow: answer.allow === true, emitters: reported }
        },
      }
    },
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
