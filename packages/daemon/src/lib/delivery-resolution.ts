/**
 * Generic direct-message delivery resolution.
 *
 * Tribe owns the disposition vocabulary and persistence mechanics. A host or
 * project layer injects concrete routing policy; the daemon never infers
 * parentage from recipient spelling.
 */

export type AcceptedDeliveryState = "online" | "offline" | "parked"

export type DirectDeliveryResolution =
  | {
      readonly status: "accepted"
      readonly state: AcceptedDeliveryState
    }
  | {
      readonly status: "accepted"
      readonly state: "bounced"
      readonly to: string
      readonly reason: string
    }
  | {
      readonly status: "invalid" | "refused" | "unresolved"
      readonly reason: string
    }

export interface DirectDeliveryResolutionInput {
  readonly recipient: string
  /** Names with an answer-capable transport in this admission snapshot. */
  readonly answerableNames: ReadonlySet<string>
}

export type DirectDeliveryResolver = (input: DirectDeliveryResolutionInput) => DirectDeliveryResolution

export type DeliveryFallback = {
  readonly to: string
  readonly action?: "bounce" | "refuse"
} & ({ readonly name: string; readonly prefix?: never } | { readonly prefix: string; readonly name?: never })

export interface DeliveryFallbackPolicy {
  readonly resolveDelivery: DirectDeliveryResolver
  /** Exact identities made terminal by an explicit `action: "refuse"` row. */
  readonly retiredNames: ReadonlySet<string>
}

/**
 * Parse one generic exact-name/prefix delivery-disposition table from environment/config.
 *
 * Rows bounce by default. `action: "refuse"` makes an exact retired identity
 * terminal before transport liveness or explicit-pull handling, while `to`
 * names the successor in the refusal. Concrete rows belong to the composing
 * layer. Declared order wins; there is no wildcard grammar or inferred hierarchy.
 */
export function parseDeliveryFallbackPolicy(raw: string | undefined): DeliveryFallbackPolicy | undefined {
  if (raw === undefined || raw.trim() === "") return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`TRIBE_DELIVERY_FALLBACKS must be JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(parsed)) throw new Error("TRIBE_DELIVERY_FALLBACKS must be a JSON array")

  const rows = parsed.map((value, index): DeliveryFallback => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`TRIBE_DELIVERY_FALLBACKS[${index}] must be an object`)
    }
    const row = value as Record<string, unknown>
    const extra = Object.keys(row).filter(
      (key) => key !== "name" && key !== "prefix" && key !== "to" && key !== "action",
    )
    if (extra.length > 0) {
      throw new Error(`TRIBE_DELIVERY_FALLBACKS[${index}] has unknown keys: ${extra.join(", ")}`)
    }
    const hasName = Object.hasOwn(row, "name")
    const hasPrefix = Object.hasOwn(row, "prefix")
    if (hasName === hasPrefix) {
      throw new Error(`TRIBE_DELIVERY_FALLBACKS[${index}] must have exactly one non-empty name or prefix`)
    }
    const matcher = hasName ? row.name : row.prefix
    if (typeof matcher !== "string" || matcher.trim() === "") {
      throw new Error(`TRIBE_DELIVERY_FALLBACKS[${index}].${hasName ? "name" : "prefix"} must be a non-empty string`)
    }
    if (typeof row.to !== "string" || row.to.trim() === "") {
      throw new Error(`TRIBE_DELIVERY_FALLBACKS[${index}].to must be a non-empty string`)
    }
    if (row.action !== undefined && row.action !== "bounce" && row.action !== "refuse") {
      throw new Error(`TRIBE_DELIVERY_FALLBACKS[${index}].action must be 'bounce' or 'refuse'`)
    }
    if (row.action === "refuse" && !hasName) {
      throw new Error(`TRIBE_DELIVERY_FALLBACKS[${index}] refuse action requires an exact name matcher`)
    }
    return hasName
      ? { name: (matcher as string).trim(), to: row.to.trim(), action: row.action }
      : { prefix: (matcher as string).trim(), to: row.to.trim(), action: row.action }
  })
  const matcherKey = (row: DeliveryFallback): string => ("name" in row ? `name:${row.name}` : `prefix:${row.prefix}`)
  const duplicates = rows
    .filter((row, index) => rows.findIndex((candidate) => matcherKey(candidate) === matcherKey(row)) !== index)
    .map(matcherKey)
  if (duplicates.length > 0) {
    throw new Error(`TRIBE_DELIVERY_FALLBACKS has duplicate matchers: ${[...new Set(duplicates)].join(", ")}`)
  }

  const resolveDelivery: DirectDeliveryResolver = ({ recipient, answerableNames }) => {
    const fallback = rows.find((row) => ("name" in row ? recipient === row.name : recipient.startsWith(row.prefix)))
    if (fallback?.action === "refuse") {
      return {
        status: "refused",
        reason: `${JSON.stringify(recipient)} is retired; send to successor ${JSON.stringify(fallback.to)}`,
      }
    }
    if (answerableNames.has(recipient)) return { status: "accepted", state: "online" }
    if (fallback === undefined) return { status: "accepted", state: "offline" }
    if (fallback.to === recipient) {
      return {
        status: "invalid",
        reason: `delivery fallback for ${JSON.stringify(recipient)} resolves to itself`,
      }
    }
    return {
      status: "accepted",
      state: "bounced",
      to: fallback.to,
      reason:
        `no answer-capable transport observed for ${recipient}; matched ` +
        ("name" in fallback ? `exact name ${fallback.name}` : `prefix ${fallback.prefix}`),
    }
  }
  const retiredNames = new Set<string>()
  for (const row of rows) {
    if ("name" in row && row.name !== undefined && row.action === "refuse") retiredNames.add(row.name)
  }
  return { resolveDelivery, retiredNames }
}

/** Backward-compatible resolver-only projection for callers without health state. */
export function prefixFallbackDeliveryResolver(raw: string | undefined): DirectDeliveryResolver | undefined {
  return parseDeliveryFallbackPolicy(raw)?.resolveDelivery
}
