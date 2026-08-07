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
  const launchId = `${normalizedProviderLaunchId}::${encodeURIComponent(normalizedPersona)}`
  return {
    persona: normalizedPersona,
    providerLaunchId: normalizedProviderLaunchId,
    launchId,
    writer: `${normalizedPersona}#${launchId}`,
  }
}
