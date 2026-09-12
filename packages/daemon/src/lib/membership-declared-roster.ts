/**
 * Declared-roster membership context (option B).
 *
 * Whether a departed durable launch is a live discrepancy, quiet-by-design
 * history, or nothing anybody was watching depends on whether hab's own
 * persona table expects the seat up — a fact only the composing layer
 * knows. `TRIBE_EXPECTED_MEMBERS` hands the daemon that declaration exactly
 * the way `TRIBE_DELIVERY_FALLBACKS` hands it a delivery-disposition table
 * (see delivery-resolution.ts): parsed once at daemon start, loud on
 * malformed input, silently absent when nobody supplies one (tests,
 * standalone daemons) — the membership projection then runs exactly as it
 * did before this module existed.
 *
 * The declaration is a plain per-name boolean, never a restart-policy
 * vocabulary: hab's own resolved restart default is not one exported value
 * (habd-runtime defaults an omitted restart to "never", the health
 * classifier defaults it to "on-failure"), so "is hab expecting this seat
 * up" is a declaration semantic hab must derive itself from whichever of
 * its own defaults applies. Tribe takes the yes/no answer, never the
 * reasoning behind it.
 *
 * @ag/tribe/tribe-membership-projection-counts-permanent-history-as-degraded
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

export interface DeclaredMember {
  readonly name: string
  readonly expected: boolean
}

export interface DeclaredRoster {
  /** Every declared name, keyed to hab's "is this seat expected up" answer. */
  readonly byName: ReadonlyMap<string, boolean>
  /** Declared names hab expects up (`expected: true`) — a settled departure
   *  here is a live discrepancy, never quiet history. */
  readonly expectedNames: ReadonlySet<string>
  /** Declared names hab does NOT expect up (`expected: false`) — a settled
   *  departure here is `finished` by design; anything else is `dormant`
   *  (down between uses), never a discrepancy. */
  readonly onDemandNames: ReadonlySet<string>
  /**
   * Unix-ms identity of the hab JSON this roster was loaded from (file mtime).
   * Absent when the roster came only from inherited env — do not stamp
   * Date.now() at parse; that manufactures freshness for a list older than
   * the config (24589 row 3 / 24591).
   */
  readonly loadedAt?: number
}

/**
 * Parse the declared-roster env var (`TRIBE_EXPECTED_MEMBERS`): a JSON array
 * of `{ name, expected }` rows — `name` a non-empty string, `expected` a
 * plain boolean answering "does hab expect this seat up". Never a
 * restart-policy vocabulary; the composing layer derives the boolean from
 * whatever its own restart-policy source says.
 *
 * Absent or blank means "no declaration" (`undefined`): every caller must
 * treat that as "run the pre-declaration projection", never as an empty
 * roster — an empty roster (`"[]"`) is a real declaration that happens to
 * name nobody, and reads every durable launch as undeclared/departed.
 */
export const TRIBE_EXPECTED_MEMBERS_FILE_ENV = "TRIBE_EXPECTED_MEMBERS_FILE"
/** Must match @hab/plugin-ag pin-expected-members. */
export const TRIBE_EXPECTED_MEMBERS_HABITAT_FILE = "tribe-expected-members.json"

function resolvedRosterFile(env: Readonly<NodeJS.ProcessEnv>): string | undefined {
  const explicit = env[TRIBE_EXPECTED_MEMBERS_FILE_ENV]?.trim()
  if (explicit !== undefined && explicit !== "") return explicit
  const root = env.HAB_SESSION_HABITAT_ROOT?.trim()
  if (root === undefined || root === "") return undefined
  const derived = join(root, TRIBE_EXPECTED_MEMBERS_HABITAT_FILE)
  return existsSync(derived) ? derived : undefined
}

export function parseExpectedMembers(raw: string | undefined, loadedAt?: number): DeclaredRoster | undefined {
  if (raw === undefined || raw.trim() === "") return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`TRIBE_EXPECTED_MEMBERS must be JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(parsed)) throw new Error("TRIBE_EXPECTED_MEMBERS must be a JSON array")

  const byName = new Map<string, boolean>()
  parsed.forEach((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`TRIBE_EXPECTED_MEMBERS[${index}] must be an object`)
    }
    const row = value as Record<string, unknown>
    const extra = Object.keys(row).filter((key) => key !== "name" && key !== "expected")
    if (extra.length > 0) {
      throw new Error(`TRIBE_EXPECTED_MEMBERS[${index}] has unknown keys: ${extra.join(", ")}`)
    }
    if (typeof row.name !== "string" || row.name.trim() === "") {
      throw new Error(`TRIBE_EXPECTED_MEMBERS[${index}].name must be a non-empty string`)
    }
    if (typeof row.expected !== "boolean") {
      throw new Error(`TRIBE_EXPECTED_MEMBERS[${index}].expected must be a boolean`)
    }
    const name = row.name.trim()
    if (byName.has(name)) {
      throw new Error(`TRIBE_EXPECTED_MEMBERS[${index}] duplicates declared name: ${name}`)
    }
    byName.set(name, row.expected)
  })

  const expectedNames = new Set<string>()
  const onDemandNames = new Set<string>()
  for (const [name, expected] of byName) {
    if (expected) expectedNames.add(name)
    else onDemandNames.add(name)
  }
  return loadedAt === undefined ? { byName, expectedNames, onDemandNames } : { byName, expectedNames, onDemandNames, loadedAt }
}

function rosterDisagreement(hab: DeclaredRoster, inherited: DeclaredRoster): string | undefined {
  if (hab.expectedNames.size !== inherited.expectedNames.size || hab.onDemandNames.size !== inherited.onDemandNames.size) {
    return (
      `TRIBE_EXPECTED_MEMBERS disagrees with hab JSON: expected_count hab=${hab.expectedNames.size} inherited=${inherited.expectedNames.size}; ` +
      `onDemand hab=${hab.onDemandNames.size} inherited=${inherited.onDemandNames.size}`
    )
  }
  for (const name of hab.onDemandNames) {
    if (!inherited.onDemandNames.has(name)) {
      return `TRIBE_EXPECTED_MEMBERS disagrees with hab JSON: onDemand ${name} is in hab JSON, not in inherited env`
    }
  }
  for (const name of inherited.onDemandNames) {
    if (!hab.onDemandNames.has(name)) {
      return `TRIBE_EXPECTED_MEMBERS disagrees with hab JSON: onDemand ${name} is in inherited env, not in hab JSON`
    }
  }
  for (const name of hab.expectedNames) {
    if (!inherited.expectedNames.has(name)) {
      return `TRIBE_EXPECTED_MEMBERS disagrees with hab JSON: expected ${name} is in hab JSON, not in inherited env`
    }
  }
  return undefined
}

/**
 * Load the declared roster at daemon start (24589 row 3 / 24591).
 *
 * Hab JSON on disk (`TRIBE_EXPECTED_MEMBERS_FILE`) is the source of truth.
 * Inherited `TRIBE_EXPECTED_MEMBERS` is asserted against it and never stamped
 * as fresh. File mtime is the config identity, not parse time.
 */
export function loadDeclaredRosterFromEnv(env: Readonly<NodeJS.ProcessEnv>): DeclaredRoster | undefined {
  const filePath = resolvedRosterFile(env)
  const envRaw = env.TRIBE_EXPECTED_MEMBERS
  if (filePath !== undefined) {
    let raw: string
    try {
      raw = readFileSync(filePath, "utf8")
    } catch (error) {
      throw new Error(
        `${TRIBE_EXPECTED_MEMBERS_FILE_ENV} ${filePath} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const loadedAt = Math.trunc(statSync(filePath).mtimeMs)
    const fromFile = parseExpectedMembers(raw, loadedAt)
    if (fromFile === undefined) {
      throw new Error(`${TRIBE_EXPECTED_MEMBERS_FILE_ENV} ${filePath} is empty`)
    }
    if (envRaw !== undefined && envRaw.trim() !== "") {
      const fromEnv = parseExpectedMembers(envRaw)
      if (fromEnv === undefined) {
        throw new Error("TRIBE_EXPECTED_MEMBERS is empty while TRIBE_EXPECTED_MEMBERS_FILE is set")
      }
      const disagreement = rosterDisagreement(fromFile, fromEnv)
      if (disagreement !== undefined) throw new Error(disagreement)
    }
    return fromFile
  }
  return parseExpectedMembers(envRaw)
}

/**
 * 24588 row 4: a ball whose recipient AND sender are both declared
 * `expected: false` cannot be answered by anyone alive, so it must not
 * accrue. Names absent from the roster (machine emitters such as hab-page)
 * are not "unrun seats" — only an explicit false declaration counts.
 * No roster means the pre-declaration projection: never auto-retire.
 */
export function bothDeclaredUnrun(
  roster: DeclaredRoster | undefined,
  sender: string,
  recipient: string,
): boolean {
  if (roster === undefined) return false
  return roster.onDemandNames.has(sender) && roster.onDemandNames.has(recipient)
}
