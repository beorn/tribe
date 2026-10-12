/**
 * Canonical seat identity derived from a provider launch and its persona.
 *
 * A provider launch may host more than one named seat. The provider launch id
 * remains the unguessable launch authority; the persona makes that authority
 * routable per seat. Every consumer that needs a durable writer or wire key
 * must use this derivation instead of composing the tuple independently.
 *
 * `providerLaunchKey` is a provider fact, NOT an instance id: a unit instance id
 * is `session@generation` alone (CONTEXT.md § Unit instance id). Consumers that
 * mean one live process must use {@link formatInstanceId}, never this.
 */
export interface TribePersonaLaunchIdentity {
  readonly persona: string
  readonly providerLaunchId: string
  readonly providerLaunchKey: string
  readonly writer: string
}

function requireIdentityPart(label: string, value: string): string {
  const normalized = value.trim()
  if (normalized.length === 0 || /[\s#]/u.test(normalized)) {
    throw new TypeError(`${label} must be a non-empty string without whitespace or #`)
  }
  return normalized
}

export function deriveTribePersonaLaunchIdentity(
  persona: string,
  providerLaunchId: string,
): TribePersonaLaunchIdentity {
  const normalizedPersona = requireIdentityPart("Tribe persona", persona)
  const normalizedProviderLaunchId = requireIdentityPart("Tribe provider launch id", providerLaunchId)
  // A raw "@" opens a verified session's generation (providerLaunchIdOf), so one inside a provider launch id would
  // read as another launch's generation; the persona is URI-encoded and carries none.
  if (normalizedProviderLaunchId.includes("@")) {
    throw new TypeError(`Tribe provider launch id ${normalizedProviderLaunchId} must not contain @`)
  }
  const providerLaunchKey = `${normalizedProviderLaunchId}::${encodeURIComponent(normalizedPersona)}`
  return {
    persona: normalizedPersona,
    providerLaunchId: normalizedProviderLaunchId,
    providerLaunchKey,
    writer: `${normalizedPersona}#${providerLaunchKey}`,
  }
}

/**
 * The provider launch a stored wire `launch_id` belongs to — the legacy wire/storage spelling of instanceId — whether it
 * carries a persona (`<launch>::<persona>`, a {@link TribePersonaLaunchIdentity.providerLaunchKey}) or is a verified
 * session's key (`<sid>@<gen>`, an {@link formatInstanceId} value whose sid IS the provider launch id). A persona is
 * URI-encoded, so a raw `@` only ever opens a generation. This and {@link parseInstanceId} are the only readers of the
 * legacy spelling.
 */
export function providerLaunchIdOf(launchId: string): string {
  const persona = launchId.indexOf("::")
  const generation = launchId.indexOf("@")
  const cut = [persona, generation].filter((index) => index !== -1)
  return cut.length === 0 ? launchId : launchId.slice(0, Math.min(...cut))
}

/** A unit instance id: its unit session id plus the generation that fences it. */
export interface TribeInstanceId {
  readonly sessionId: string
  readonly generation: number
}

const GENERATION_TEXT = /^(?:0|[1-9][0-9]*)$/u

/**
 * The one name for a unit instance, `session@generation` (CONTEXT.md § Unit instance id). This is the only place that
 * joins the two; nothing else may compose an `@`.
 */
export function formatInstanceId(sessionId: string, generation: number): string {
  const session = requireIdentityPart("Tribe instance session id", sessionId)
  if (session.includes("@")) {
    throw new TypeError(`Tribe instance session id ${session} must not contain @`)
  }
  if (!Number.isInteger(generation) || generation < 0) {
    throw new TypeError(`Tribe instance generation ${generation} must be a non-negative integer`)
  }
  return `${session}@${generation}`
}

/**
 * The reverse of formatInstanceId, and the only place that splits one. Returns null when the value is not
 * instance-shaped at all — a bare provider launch, or the launch-keyed `<launch>::<persona>` form, whose persona is
 * URI-encoded and so carries no raw `@`. Throws when the value IS instance-shaped but malformed, so a bad generation is
 * never silently read as absent.
 */
export function parseInstanceId(value: string): TribeInstanceId | null {
  const at = value.indexOf("@")
  if (at === -1) return null
  if (value.indexOf("@", at + 1) !== -1) {
    throw new TypeError(`Tribe instance id ${value} carries more than one @`)
  }
  const sessionId = value.slice(0, at)
  const generationText = value.slice(at + 1)
  if (sessionId.length === 0) {
    throw new TypeError(`Tribe instance id ${value} has no session id before @`)
  }
  if (!GENERATION_TEXT.test(generationText)) {
    throw new TypeError(`Tribe instance id ${value} has a non-numeric generation ${JSON.stringify(generationText)}`)
  }
  return { sessionId, generation: Number(generationText) }
}
