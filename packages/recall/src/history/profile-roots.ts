/**
 * The transcript roots ag resolves, asked of ag rather than written down here (#38420).
 *
 * A seat launched through ag runs with a provider profile home — `CLAUDE_CONFIG_DIR` for claude,
 * `CODEX_HOME` for codex — under `~/.config/ag/profiles/<provider>/<account>` (or the root override
 * `CLAUDE_PROFILE_ROOT` and friends). Recall's stock `~/.claude` therefore saw nothing from a hosted
 * seat, and every claude profile homes's transcripts were missing from the index while codex's were
 * not. The mapping belongs to ag (`@ag/accounts-core` provider profiles), so this asks
 * `ag transcript roots --json` and never holds a path of its own.
 */
import { spawn } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import * as path from "node:path"
import { HAB_SESSION_HABITAT_ROOT_ENV } from "tribe-wire/lib/hab-session-env"

export interface ProfileHome {
  name: string
  dir: string
  authenticated: boolean
}

export interface ProviderRoot {
  provider: string
  root: string
  exists: boolean
  profiles: ProfileHome[]
}

export interface ProfileRoots {
  roots: ProviderRoot[]
  /** Providers whose root could not be asked about, named so a caller reports them instead of skipping silently. */
  failures: Array<{ provider: string; reason: string }>
}

/** Ask ag for every provider root it resolves. A missing or unreadable answer is a failure to name, not an empty list. */
export async function readProfileRoots(agBin: string): Promise<ProfileRoots> {
  return new Promise<ProfileRoots>((resolve) => {
    const child = spawn(agBin, ["transcript", "roots", "--json"], { stdio: ["ignore", "pipe", "pipe"] })
    const roots: ProviderRoot[] = []
    const failures: Array<{ provider: string; reason: string }> = []
    let stderr = ""
    let buffer = ""
    let settled = false
    const settle = (answer: ProfileRoots): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(answer)
    }
    // A reader asking before every search must not hang on a slow or wedged ag: say it did not answer, and index the
    // roots already known. The timeout is short because the answer is a directory list, not a scan.
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM")
      } catch {
        // silent-fallback-allow: the child may already be gone; the timeout answer stands either way.
      }
      settle({
        roots,
        failures: [
          ...failures,
          { provider: "*", reason: `ag transcript roots did not answer in ${String(ROOT_QUERY_TIMEOUT_MS)} ms` },
        ],
      })
    }, ROOT_QUERY_TIMEOUT_MS)

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", (err) => {
      settle({ roots: [], failures: [{ provider: "*", reason: `could not run ag transcript roots: ${err.message}` }] })
    })
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at).trim()
        buffer = buffer.slice(at + 1)
        if (line === "") continue
        let record: Record<string, unknown>
        try {
          record = JSON.parse(line) as Record<string, unknown>
        } catch {
          failures.push({
            provider: "*",
            reason: `ag transcript roots sent a line that is not JSON: ${line.slice(0, 120)}`,
          })
          continue
        }
        if (record.kind !== "root") continue
        const provider = typeof record.provider === "string" ? record.provider : ""
        const root = typeof record.root === "string" ? record.root : ""
        if (provider === "" || root === "") {
          failures.push({ provider: "*", reason: "ag transcript roots sent a root line with no provider or root" })
          continue
        }
        const profiles = Array.isArray(record.profiles) ? record.profiles : []
        roots.push({
          provider,
          root,
          exists: record.exists === true,
          profiles: profiles.flatMap((profile) => {
            const one = profile as Record<string, unknown>
            if (typeof one.name !== "string" || typeof one.dir !== "string") return []
            return [{ name: one.name, dir: one.dir, authenticated: one.authenticated === true }]
          }),
        })
      }
    })
    child.on("close", (code) => {
      if (code !== 0) {
        failures.push({
          provider: "*",
          reason: `ag transcript roots exited ${String(code)}${stderr.trim() === "" ? "" : `: ${stderr.trim().split("\n")[0]}`}`,
        })
      } else if (roots.length === 0) {
        failures.push({ provider: "*", reason: "ag transcript roots named no provider root" })
      }
      settle({ roots, failures })
    })
  })
}

/** Long enough for a directory listing on a loaded host, short enough that a wedged ag costs a search one second. */
export const ROOT_QUERY_TIMEOUT_MS = 2_000

let cached: Promise<ProfileRoots> | undefined

/**
 * The same answer, once per process: a search asks the roots question at most once, and an index run reuses it.
 * A caller that needs a fresh answer (a host restart changed the profiles) clears the cache with `forgetProfileRoots`.
 */
export function cachedProfileRoots(agBin: string): Promise<ProfileRoots> {
  cached ??= readProfileRoots(agBin)
  return cached
}

export function forgetProfileRoots(): void {
  cached = undefined
}

/**
 * The roots ag names, with every way of not getting an answer turned into a named failure instead of a throw: a
 * machine without ag still answers from the stock home, and says which roots it never asked about.
 * `RECALL_PROFILE_ROOTS=off` is the one explicit opt-out (tests and bespoke harnesses), and it is loud in the list.
 */
export async function profileRootsFromAg(agBin?: string, env: NodeJS.ProcessEnv = process.env): Promise<ProfileRoots> {
  if ((env.RECALL_PROFILE_ROOTS ?? "").trim() === "off") {
    return { roots: [], failures: [{ provider: "*", reason: "RECALL_PROFILE_ROOTS=off: ag profile roots not asked" }] }
  }
  try {
    const { resolveAgBin } = await import("./codex-indexer.ts")
    return await cachedProfileRoots(resolveAgBin(agBin))
  } catch (error) {
    return { roots: [], failures: [{ provider: "*", reason: `ag binary not resolvable: ${(error as Error).message}` }] }
  }
}

/** The claude transcript directories to index: each readable profile home's `projects/`, plus the stock home. */
export function claudeProjectDirs(roots: ProfileRoots): string[] {
  const dirs: string[] = []
  for (const one of roots.roots) {
    if (one.provider !== "claude") continue
    for (const profile of one.profiles) dirs.push(path.join(profile.dir, "projects"))
  }
  return dirs
}

/** A seat the habitat's published plan declares, with the provider and account its launch argv names. */
export interface DeclaredSeat {
  name: string
  provider?: string
  account?: string
}

export interface DeclaredSeatRead {
  seats: DeclaredSeat[]
  /** The plan file the seats came from; null when no habitat plan was found where recall looks. */
  source: string | null
  /** Present when a plan was found and could not be used: a wrong answer is named, never turned into "no seats". */
  failure?: string
}

/**
 * Where a habitat's published plan may sit, most explicit first. `RECALL_HAB_PLAN` names one file (or `off`);
 * `HAB_SESSION_HABITAT_ROOT` is what hab gives a managed seat; `HAB_DIR` and `/hh/main.hab` are the house's own
 * habitat, the same ladder the recall-index overrides reader walks.
 */
function planCandidates(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = []
  const explicit = (env.RECALL_HAB_PLAN ?? "").trim()
  if (explicit !== "" && explicit !== "off") out.push(path.resolve(explicit))
  for (const root of [env[HAB_SESSION_HABITAT_ROOT_ENV], env.HAB_DIR, "/hh/main.hab"]) {
    if (root === undefined || root === "") continue
    out.push(path.resolve(root, "run", "habplan.json"))
  }
  return out.filter((one, at, all) => all.indexOf(one) === at)
}

/** The seats a published plan declares: habitant argv carrying `--name`, with its `--harness` and `--account`. */
function seatsFromPlan(raw: unknown): DeclaredSeat[] {
  const habitants = (raw as { habitants?: unknown }).habitants
  if (!Array.isArray(habitants)) throw new Error("the plan has no habitants array")
  const seats: DeclaredSeat[] = []
  for (const entry of habitants) {
    const argv = (entry as { argv?: unknown }).argv
    if (!Array.isArray(argv)) continue
    const items: unknown[] = argv
    const flag = (name: string): string | undefined => {
      const at = items.indexOf(name)
      const value = at >= 0 ? items[at + 1] : undefined
      return typeof value === "string" && value !== "" ? value : undefined
    }
    const name = flag("--name")
    if (name === undefined) continue
    const provider = flag("--harness")
    const account = flag("--account")
    seats.push({
      name,
      ...(provider === undefined ? {} : { provider }),
      ...(account === undefined ? {} : { account }),
    })
  }
  return seats
}

/**
 * The seats declared by the habitat's published plan. No plan found is an empty answer (a machine without a
 * habitat); a plan that exists but cannot be read is a named failure.
 */
export function readDeclaredSeats(env: NodeJS.ProcessEnv = process.env): DeclaredSeatRead {
  if ((env.RECALL_HAB_PLAN ?? "").trim() === "off") return { seats: [], source: null }
  for (const planPath of planCandidates(env)) {
    if (!existsSync(planPath)) continue
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(planPath, "utf8"))
    } catch (error) {
      return { seats: [], source: planPath, failure: `not readable JSON: ${(error as Error).message}` }
    }
    try {
      return { seats: seatsFromPlan(raw), source: planPath }
    } catch (error) {
      return { seats: [], source: planPath, failure: (error as Error).message }
    }
  }
  return { seats: [], source: null }
}

/** One declared seat whose profile recall cannot read, named with the reason it cannot. */
export interface SeatWithoutProfile {
  seat: string
  provider: string
  account: string
  reason: string
}

export interface DeclaredSeatCheck {
  /** Seats whose provider ag gives a profile root, so a profile could be missing; the rest have nothing to check. */
  checked: number
  unreadable: SeatWithoutProfile[]
}

/**
 * Which declared seats have no readable profile under the root ag named. Only providers ag reports a profile root
 * for are checked: an agy or hermes seat keeps no profile home to be missing, so calling it unreadable would be
 * noise about a provider recall does not index.
 */
export function checkDeclaredSeats(seats: readonly DeclaredSeat[], roots: ProfileRoots): DeclaredSeatCheck {
  const unreadable: SeatWithoutProfile[] = []
  let checked = 0
  for (const seat of seats) {
    const provider = seat.provider
    const account = seat.account
    if (provider === undefined || account === undefined || account === "auto") continue
    const root = roots.roots.find((one) => one.provider === provider)
    if (root === undefined) continue
    checked++
    if (!root.exists) {
      unreadable.push({ seat: seat.name, provider, account, reason: `provider root ${root.root} is missing` })
      continue
    }
    const profile = root.profiles.find((one) => one.name === account)
    if (profile === undefined) {
      unreadable.push({ seat: seat.name, provider, account, reason: `no profile named ${account} under ${root.root}` })
      continue
    }
    try {
      if (!statSync(profile.dir).isDirectory()) {
        unreadable.push({ seat: seat.name, provider, account, reason: `${profile.dir} is not a directory` })
      }
    } catch (error) {
      unreadable.push({
        seat: seat.name,
        provider,
        account,
        reason: `${profile.dir} is not readable: ${(error as Error).message}`,
      })
    }
  }
  return { checked, unreadable }
}
