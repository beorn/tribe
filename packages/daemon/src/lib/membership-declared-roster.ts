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
export function parseExpectedMembers(raw: string | undefined): DeclaredRoster | undefined {
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
  return { byName, expectedNames, onDemandNames }
}
