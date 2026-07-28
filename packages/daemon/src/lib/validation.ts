/**
 * Tribe input validation — name format and message sanitization.
 */

import { isTribeNameShape, TRIBE_NAME_SHAPE_ERROR } from "tribe-wire/lib/persona-name"

// ---------------------------------------------------------------------------
// Surrogate-safe string helpers
// ---------------------------------------------------------------------------

/**
 * Matches a *lone* UTF-16 surrogate code unit — a high surrogate not followed
 * by a low surrogate, or a low surrogate not preceded by a high surrogate.
 *
 * Lone surrogates are legal in JavaScript strings but illegal in transmitted
 * JSON. When the Claude Code harness `JSON.stringify`s a conversation that
 * contains one, the Anthropic API rejects the request body with
 * `400 ... no low surrogate in string`. A single poisoned tribe channel
 * message therefore hard-blocks the receiving agent for the rest of its
 * session. This regex is the safety net: strip lone surrogates at the
 * tribe boundary so no truncation bug anywhere can poison an agent.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/**
 * Replace any lone UTF-16 surrogate with U+FFFD (REPLACEMENT CHARACTER).
 * Well-formed surrogate pairs (emoji, astral-plane characters) pass through
 * untouched.
 */
export function stripLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE, "�")
}

/**
 * Truncate `text` to at most `maxCodeUnits` UTF-16 code units **without ever
 * splitting a surrogate pair**. A naive `str.slice(0, n)` can cut between the
 * two halves of a surrogate pair (e.g. an emoji), leaving a lone high
 * surrogate at the end of the result — which then breaks JSON serialization
 * downstream. If the slice would land mid-pair, the trailing lone high
 * surrogate is dropped so the result stays well-formed.
 */
export function truncateSurrogateSafe(text: string, maxCodeUnits: number): string {
  if (text.length <= maxCodeUnits) return text
  let sliced = text.slice(0, maxCodeUnits)
  // If the last code unit is a high surrogate, the slice cut a pair in half.
  const lastUnit = sliced.charCodeAt(sliced.length - 1)
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    sliced = sliced.slice(0, -1)
  }
  return sliced
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export function validateName(name: string): string | null {
  // Sigil-prefixed agent names (e.g. `@agent/2`) match slot-bead lease IDs.
  // 21768 — this shares ONE grammar with the adapter's register-time pre-seed:
  // when the two disagreed, a successor persona the adapter refused to seed was
  // also refused here, so the seat could not even rename itself into being
  // addressable. The `@` is per-segment, so nested role paths like
  // `@chief/@ci/next` resolve; `/` is a separator, not a body character.
  if (!isTribeNameShape(name)) return TRIBE_NAME_SHAPE_ERROR
  return null
}

/** Hard cap on a tribe message, in UTF-16 code units. Content past it is cut. */
export const MESSAGE_MAX_LENGTH = 4096

/** Appended to a message the cap cut, so the recipient can see it is partial. */
const TRUNCATION_MARKER = "..."

/**
 * A sanitized message plus the fact of whether sanitizing dropped content.
 *
 * The `truncated` flag exists because the cut used to be invisible: the daemon
 * returned a bare string, so `tribe.send` reported `sent: true` on a mutilated
 * message and the sender had no way to learn the tail was gone
 * (@ag/tribe/22497). Carrying the fact in the return type is what makes it
 * impossible to drop by accident — docs/principles.md § "Fail Loud, Fail Now".
 */
export type SanitizedMessage = {
  /** Sanitized content: control chars stripped, capped, surrogate-safe. */
  readonly content: string
  /** True iff the cap dropped characters — `content` is a prefix, not the whole message. */
  readonly truncated: boolean
  /**
   * The length the cap was measured against: the input after control-char
   * stripping, before capping. This is the number directly comparable to
   * `MESSAGE_MAX_LENGTH`, so `originalLength - MESSAGE_MAX_LENGTH` is how much
   * a truncated send lost. It is not the raw argument's length when the input
   * carried control characters, which are removed before the cap applies.
   */
  readonly originalLength: number
}

/**
 * Sanitize `content` **and report whether the cap cut it**.
 *
 * There is deliberately no string-returning variant: the truncation fact has
 * exactly one way out of this module, so no caller can drop it by writing the
 * shorter call. A surface that says "sent" while silently discarding the tail
 * of the message is the defect this function exists to close.
 */
export function sanitizeMessageWithReport(content: string): SanitizedMessage {
  // Strip control chars except newlines
  const cleaned = content.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, "")
  const originalLength = cleaned.length
  const truncated = originalLength > MESSAGE_MAX_LENGTH
  // Cap — surrogate-safe so the cut never lands mid-pair. The marker occupies
  // the tail of the budget, so a capped message is exactly MESSAGE_MAX_LENGTH
  // code units (one fewer when the cut dropped a half-pair).
  const capped = truncated
    ? truncateSurrogateSafe(cleaned, MESSAGE_MAX_LENGTH - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
    : cleaned
  // Defensive net: replace any lone surrogate (from this or any upstream
  // truncation, or malformed input) with U+FFFD so the message can never
  // poison a downstream JSON serialization.
  return { content: stripLoneSurrogates(capped), truncated, originalLength }
}
