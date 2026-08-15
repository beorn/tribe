/**
 * Tribe persona-name shape — one grammar, shared by both gates that decide
 * whether a session is addressable.
 *
 * @ag/tribe/21768. Two independent predicates used to carry their own flat
 * character class `[a-z0-9_./-]`: the adapter's register-time pre-seed
 * (stdio-adapter.ts) and the daemon's `validateName`, which gates `tribe.join`
 * and `tribe.rename`. Neither class contained `@`, so a nested successor path
 * like `@chief/@ci/next` was rejected at the SECOND sigil. A seat launched
 * under that persona could neither be named at launch nor name itself from
 * inside — it registered as `unknown-<rand>` and every message addressed to its
 * persona was silently dropped. `$up @role/next` is a first-class launch
 * surface (`/up` § Successor Handoffs), so every successor rotation carried
 * that blind window by construction.
 *
 * A tribe name is a PATH of sigil-optional segments, not a bag of characters:
 *
 *     name    := segment ("/" segment)*
 *     segment := "@"? [a-z0-9] [a-z0-9_.-]*
 *
 * Anchoring the sigil to the start of each segment is what admits the nested
 * role path while still rejecting `@@chief` and `@ch@ief`. Making `/` a
 * separator rather than a body character additionally rejects the malformed
 * shapes the old class silently accepted (`@chief/`, `@chief//next`, `/chief`).
 */

/**
 * Longest accepted tribe name. Preserves the pre-21768 bound exactly: the old
 * regexes were `@` plus a 32-character body.
 */
export const MAX_TRIBE_NAME_LENGTH = 33

/** One path segment: optional leading sigil, body starting alphanumeric. */
const SEGMENT = /^@?[a-z0-9][a-z0-9_.-]*$/

/** Human-readable statement of the grammar, for loud failures. */
export const TRIBE_NAME_SHAPE_ERROR =
  `Name must be 1-${MAX_TRIBE_NAME_LENGTH} chars: ` +
  "slash-separated segments of lowercase letters, digits, hyphens, underscores and dots, " +
  "each segment optionally prefixed with `@` and starting with a letter or digit " +
  "(for example `@ci`, `@agent/7`, `@chief/@ci/next`)."

/**
 * Does `name` match the tribe name grammar? The leading sigil is optional here
 * because the daemon has always accepted bare names (`ci`, `agent/7`).
 */
export function isTribeNameShape(name: string): boolean {
  if (name.length === 0 || name.length > MAX_TRIBE_NAME_LENGTH) return false
  return name.split("/").every((segment) => SEGMENT.test(segment))
}

/**
 * Is `name` an explicit persona the fleet can address — a well-shaped name that
 * carries the leading sigil? Only these are seeded at register time; a bare
 * name is not a persona.
 */
export function isExplicitTribePersonaName(name: string): boolean {
  return name.startsWith("@") && isTribeNameShape(name)
}
