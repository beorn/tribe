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
      readonly status: "invalid" | "unresolved"
      readonly reason: string
    }

export interface DirectDeliveryResolutionInput {
  readonly recipient: string
  readonly activeNames: ReadonlySet<string>
}

export type DirectDeliveryResolver = (input: DirectDeliveryResolutionInput) => DirectDeliveryResolution

export interface PrefixDeliveryFallback {
  readonly prefix: string
  readonly to: string
}

/**
 * Parse one generic prefix-fallback table from an environment/config string.
 *
 * Concrete rows belong to the composing layer. Declared order wins; there is
 * no wildcard grammar or inferred hierarchy.
 */
export function prefixFallbackDeliveryResolver(raw: string | undefined): DirectDeliveryResolver | undefined {
  if (raw === undefined || raw.trim() === "") return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`TRIBE_DELIVERY_FALLBACKS must be JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(parsed)) throw new Error("TRIBE_DELIVERY_FALLBACKS must be a JSON array")

  const rows = parsed.map((value, index): PrefixDeliveryFallback => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`TRIBE_DELIVERY_FALLBACKS[${index}] must be an object`)
    }
    const row = value as Record<string, unknown>
    const extra = Object.keys(row).filter((key) => key !== "prefix" && key !== "to")
    if (extra.length > 0) {
      throw new Error(`TRIBE_DELIVERY_FALLBACKS[${index}] has unknown keys: ${extra.join(", ")}`)
    }
    if (typeof row.prefix !== "string" || row.prefix.trim() === "") {
      throw new Error(`TRIBE_DELIVERY_FALLBACKS[${index}].prefix must be a non-empty string`)
    }
    if (typeof row.to !== "string" || row.to.trim() === "") {
      throw new Error(`TRIBE_DELIVERY_FALLBACKS[${index}].to must be a non-empty string`)
    }
    return { prefix: row.prefix, to: row.to }
  })
  const duplicates = rows
    .filter((row, index) => rows.findIndex((candidate) => candidate.prefix === row.prefix) !== index)
    .map((row) => row.prefix)
  if (duplicates.length > 0) {
    throw new Error(`TRIBE_DELIVERY_FALLBACKS has duplicate prefixes: ${[...new Set(duplicates)].join(", ")}`)
  }

  return ({ recipient, activeNames }) => {
    if (activeNames.has(recipient)) return { status: "accepted", state: "online" }
    const fallback = rows.find((row) => recipient.startsWith(row.prefix))
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
      reason: `no live transport for ${recipient}; matched prefix ${fallback.prefix}`,
    }
  }
}
