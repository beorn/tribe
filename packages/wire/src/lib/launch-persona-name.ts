/**
 * Launch-persona name shape — the check that decides whether an adapter seeds
 * its configured identity at register time or lets the daemon mint an
 * `unknown-<rand>` placeholder.
 *
 * A placeholder is unaddressable: nothing sent to `@chief/@ci/next` reaches a
 * session registered as `unknown-cmayz`. So the shape rule and the "a supplied
 * name that fails the rule is an ERROR, not a downgrade" rule live here
 * together, in a pure module both the adapter and its tests can import without
 * running the adapter's env-reading top level.
 */

/**
 * Personas are `@`-prefixed and may be path-segmented. Rotation names segment
 * with a nested sigil (`@chief/@ci/next`) — the sigil is part of node identity,
 * so it is legal INSIDE the name, not only at the front.
 */
const LAUNCH_PERSONA_NAME = /^@[a-z0-9][a-z0-9_.@/-]{0,31}$/u

/** True when `name` is an explicit persona the adapter may register under. */
export function isExplicitTribePersonaName(name: string): boolean {
  return LAUNCH_PERSONA_NAME.test(name)
}

/**
 * The refusal for a launch name that DECLARES a hat and cannot register, or
 * null when there is nothing to complain about.
 *
 * The `@` sigil is the declaration: a launcher passing `@…` has named a hat it
 * expects to be addressable. If the shape check then rejects it, the old
 * behavior was to register anyway under an `unknown-<rand>` placeholder — the
 * session comes up unaddressable and nothing reports why. Same silent-mute
 * class as a refused channel registration: the seat looks alive and cannot be
 * reached.
 *
 * Two things stay legal, because neither promised a hat:
 * - no name at all — the unidentified-session path the placeholder exists for;
 * - a bare non-`@` name — the ad-hoc path where the model is expected to call
 *   `tribe.join` itself.
 */
export function launchPersonaNameRefusal(name: string | undefined): string | null {
  if (name === undefined) return null
  if (!name.startsWith("@")) return null
  if (isExplicitTribePersonaName(name)) return null
  return (
    `tribe: launch persona name ${JSON.stringify(name)} declares a hat but is not a registrable persona shape ` +
    `(expected ${String(LAUNCH_PERSONA_NAME)}); registering would mint an unaddressable ` +
    "unknown-<rand> placeholder and nothing addressed to that persona would arrive. " +
    "Fix the name at the launcher, or launch without a name for an ad-hoc session."
  )
}
