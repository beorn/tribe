/**
 * The envelope's structural tag names — THE one home for every transcript-shape
 * tag an injection surface emits (28904).
 *
 * A sanitizer, a broadcast scrubber, a transcript highlighter and the parser all
 * need the same list. Before this module each of them re-listed the tags by
 * hand, so adding a wrapper tag (the chokepoint's `<injected_context>` /
 * `<item>`) left the scrubber blind to it: a seat quoting its injected context
 * into a broadcast would have passed the very tags the scrubber exists to
 * neutralise. Read the list from here and a new tag is neutralised everywhere by
 * construction.
 */

/** The outer wrapper every emitter opens. */
export const INJECTION_ENVELOPE_TAG = "injected_context"
/** One framed unit inside the envelope (a recall hit, a channel message, …). */
export const INJECTION_ITEM_TAG = "item"
/** The trailing protocol reminder appended after framed content. */
export const CONTEXT_PROTOCOL_TAG = "context-protocol"
/** The verbatim user text a UserPromptSubmit hook prepends ahead of the envelope. */
export const USER_PROMPT_TAG = "user_prompt"
/** The tribe channel wrapper a broadcast arrives inside. */
export const CHANNEL_TAG = "channel"
/** The harness system-reminder wrapper. */
export const SYSTEM_REMINDER_TAG = "system-reminder"

/**
 * Legacy recall wrapper/snippet tags the chokepoint replaced (recall's hook path
 * now emits `<injected_context>` / `<item>`). Kept in the neutralise set so a
 * pre-landing transcript, or a broadcast quoting one, is still scrubbed.
 */
export const LEGACY_INJECTION_TAGS: readonly string[] = ["session_memory", "recall-memory", "snippet"]

/**
 * Every tag any injection surface emits, plus the legacy tags it replaced. THE
 * list a scrubber, sanitizer or highlighter keys off.
 */
export const INJECTION_TAG_NAMES: readonly string[] = [
  INJECTION_ENVELOPE_TAG,
  INJECTION_ITEM_TAG,
  CONTEXT_PROTOCOL_TAG,
  USER_PROMPT_TAG,
  CHANNEL_TAG,
  SYSTEM_REMINDER_TAG,
  ...LEGACY_INJECTION_TAGS,
]

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * A regex alternation of {@link INJECTION_TAG_NAMES}, longest name first so a
 * shorter tag can never shadow a longer one (`recall-memory` before `memory`).
 * Build a scrubber/highlighter pattern from this, never from a hand-list.
 */
export function injectionTagAlternation(): string {
  return [...INJECTION_TAG_NAMES]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|")
}
