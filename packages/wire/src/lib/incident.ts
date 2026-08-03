/**
 * One ball per incident — the obligation identity for ambient emitters.
 *
 * Stage 2(d) of the habwire roadmap (operator ruling 2026-08-02, "ONE ball per
 * incident"). A watcher that notices a live condition must hold ONE standing
 * obligation for as long as that condition holds, not one per tick: the open
 * pile becomes a projection of current conditions rather than an append-only
 * log of observations. A flapping condition holds one ball, not 46.
 *
 * The identity is `emitter : subject : condition` and deliberately EXCLUDES
 * message UUID, evidence text, generation, and the WATCH episodeKey. Those
 * four dimensions are precisely why repeated observations of one condition
 * survived as separate obligations.
 *
 * Severity is deliberately absent and must not be added here. A severity-gated
 * ball-vs-notify decision was designed and then explicitly scope-cut by the
 * operator; the reason to keep it out is not merely scope but correctness. A
 * severity table is a separable enabling value, so an empty or uniformly
 * WARNING table would silence the fleet while the mechanism still read green
 * to any reviewer. With no gate, every incident mints exactly one ball — an
 * over-obligated fleet is visible and annoying, an under-obligated one is
 * silent.
 *
 * This module owns identity only. It opens and closes nothing: the ball
 * lifecycle stays with `pending_request` and its existing statements, so there
 * is exactly one settlement owner.
 */

/**
 * Separator between identity parts. A part may not contain it — otherwise
 * `a:b:c:d` would parse two ways and two distinct conditions could collide
 * onto one obligation (or one condition split into two).
 */
export const INCIDENT_KEY_SEPARATOR = ":"

const INCIDENT_KEY_PART_COUNT = 3

/** The three-part identity of a live condition. */
export type IncidentIdentity = {
  /** The watcher that observed the condition, e.g. `health-monitor`. */
  readonly emitter: string
  /** What the condition is about, e.g. `@dev/5` or a bay id. */
  readonly subject: string
  /** Which condition holds, e.g. `transport-wedged`. */
  readonly condition: string
}

function assertPart(field: keyof IncidentIdentity, value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new Error(
      `incident identity requires a non-empty ${field}; an incident missing part of its identity would collide with every other incident sharing the remaining parts`,
    )
  }
  if (trimmed.includes(INCIDENT_KEY_SEPARATOR)) {
    throw new Error(
      `incident ${field} may not contain ${JSON.stringify(INCIDENT_KEY_SEPARATOR)} (got ${JSON.stringify(trimmed)}); the identity would parse ambiguously and merge or split obligations`,
    )
  }
  return trimmed
}

/**
 * Canonical dedupe key for one live condition. Repeated emissions for the same
 * identity produce the same key, which is what makes the ball upsert instead
 * of accumulate.
 *
 * Throws on a malformed identity rather than degrading to a partial key: a
 * silently-truncated identity is how one condition would swallow another.
 */
export function incidentKey(identity: IncidentIdentity): string {
  return [
    assertPart("emitter", identity.emitter),
    assertPart("subject", identity.subject),
    assertPart("condition", identity.condition),
  ].join(INCIDENT_KEY_SEPARATOR)
}

/**
 * Recover the identity from a key, or null when `key` is not a well-formed
 * incident key. Callers use this to tell an incident-keyed obligation from an
 * ordinary message-id-keyed one without a second column.
 */
export function parseIncidentKey(key: string): IncidentIdentity | null {
  const parts = key.split(INCIDENT_KEY_SEPARATOR)
  if (parts.length !== INCIDENT_KEY_PART_COUNT) return null
  const [emitter, subject, condition] = parts as [string, string, string]
  if (emitter.length === 0 || subject.length === 0 || condition.length === 0) return null
  return { emitter, subject, condition }
}

/** Whether `key` is a well-formed incident identity key. */
export function isIncidentKey(key: string): boolean {
  return parseIncidentKey(key) !== null
}
