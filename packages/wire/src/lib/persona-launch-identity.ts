/**
 * Canonical seat identity derived from a provider launch and its persona.
 *
 * A provider launch may host more than one named seat. The provider launch id
 * remains the unguessable launch authority; the persona makes that authority
 * routable per seat. Every consumer that needs a durable writer or wire key
 * must use this derivation instead of composing the tuple independently.
 */
export interface TribePersonaLaunchIdentity {
  readonly persona: string
  readonly providerLaunchId: string
  readonly launchId: string
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
  const launchId = `${normalizedProviderLaunchId}::${encodeURIComponent(normalizedPersona)}`
  return {
    persona: normalizedPersona,
    providerLaunchId: normalizedProviderLaunchId,
    launchId,
    writer: `${normalizedPersona}#${launchId}`,
  }
}

/**
 * The provider launch a stored launch id belongs to, whether it carries a persona (`<launch>::<persona>`) or is a
 * verified session's key (`<sid>@<gen>`, whose sid IS the provider launch id). A persona is URI-encoded, so a raw `@`
 * only ever opens a generation.
 */
export function providerLaunchIdOf(launchId: string): string {
  const persona = launchId.indexOf("::")
  const generation = launchId.indexOf("@")
  const cut = [persona, generation].filter((index) => index !== -1)
  return cut.length === 0 ? launchId : launchId.slice(0, Math.min(...cut))
}
