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
 * @ag/tribe/tribe-membership-projection-counts-permanent-history-as-degraded
 */

export type MemberRestartPolicy = "always" | "on-failure" | "never"

export interface DeclaredMember {
  readonly name: string
  readonly restart: MemberRestartPolicy
}

export interface DeclaredRoster {
  /** Every declared name, keyed to hab's resolved restart policy for it. */
  readonly byName: ReadonlyMap<string, MemberRestartPolicy>
  /** Declared names hab remounts on a harness exit (`always` / `on-failure`)
   *  — a settled departure here is a live discrepancy, never quiet history. */
  readonly expectedNames: ReadonlySet<string>
  /** Declared names hab pages once and never remounts (`restart: "never"`)
   *  — a settled departure here is `finished` by design; anything else is
   *  `dormant` (down between uses), never a discrepancy. */
  readonly onDemandNames: ReadonlySet<string>
}

/**
 * Parse the declared-roster env var (`TRIBE_EXPECTED_MEMBERS`): a JSON array
 * of `{ name, restart }` rows, `restart` one of `"always"`, `"on-failure"`,
 * or `"never"` — hab's own RESOLVED restart policy per persona, never
 * re-derived here.
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

  const byName = new Map<string, MemberRestartPolicy>()
  parsed.forEach((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`TRIBE_EXPECTED_MEMBERS[${index}] must be an object`)
    }
    const row = value as Record<string, unknown>
    const extra = Object.keys(row).filter((key) => key !== "name" && key !== "restart")
    if (extra.length > 0) {
      throw new Error(`TRIBE_EXPECTED_MEMBERS[${index}] has unknown keys: ${extra.join(", ")}`)
    }
    if (typeof row.name !== "string" || row.name.trim() === "") {
      throw new Error(`TRIBE_EXPECTED_MEMBERS[${index}].name must be a non-empty string`)
    }
    if (row.restart !== "always" && row.restart !== "on-failure" && row.restart !== "never") {
      throw new Error(`TRIBE_EXPECTED_MEMBERS[${index}].restart must be 'always', 'on-failure', or 'never'`)
    }
    const name = row.name.trim()
    if (byName.has(name)) {
      throw new Error(`TRIBE_EXPECTED_MEMBERS[${index}] duplicates declared name: ${name}`)
    }
    byName.set(name, row.restart)
  })

  const expectedNames = new Set<string>()
  const onDemandNames = new Set<string>()
  for (const [name, restart] of byName) {
    if (restart === "never") onDemandNames.add(name)
    else expectedNames.add(name)
  }
  return { byName, expectedNames, onDemandNames }
}
