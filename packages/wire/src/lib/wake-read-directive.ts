/**
 * The read directive's ONE spelling, shared by the two repositories that must
 * agree on it byte for byte.
 *
 * A wake re-presents a message, so the directive names that message and
 * nothing else: `read your tribe inbox now: <message uuid>`.
 *
 *   - the wire FORMS it for every row that opens a ball, so a pane receives a
 *     pointer, never a body whose owed-ness the transport cannot keep current
 *     (29327, @cto 1eb4c66c);
 *   - ag RECOGNIZES it: the presentation gate re-offers a queued channel event
 *     as a directive (ag-chat/src/prompt/channel-presentation.ts) and the pane
 *     primitive refuses a directive-shaped line that names no message
 *     (tools/agent-rig/skills/tent/scripts/herdr.ts).
 *
 * Dependency direction: ag -> tribe-wire. @ag/harness already imports this
 * package's leaf modules (persona-name, ag-host-env, launch-environment), so
 * the fact lives here instead of in ag — where the presentation gate would
 * then have to be the authority for a line the wire produces — or in
 * tribe-injection-envelope, which would have cost the wire a new dependency.
 *
 * `WAKE_READ_DIRECTIVE_MESSAGE_ID` is the FULL line on purpose. An id is
 * nameable exactly when the line it would form is a directive a pane accepts,
 * so a caller holding only an id derives that answer by forming the line —
 * never by testing a second, narrower pattern that can disagree about the
 * prefix, the separator or the casing rule.
 */
export const WAKE_READ_DIRECTIVE_PREFIX = "read your tribe inbox now"
export const WAKE_READ_DIRECTIVE_MESSAGE_ID =
  /^read your tribe inbox now: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/** The sanctioned read directive, naming the message it re-presents. */
export function wakeReadDirective(id: string): string {
  return `${WAKE_READ_DIRECTIVE_PREFIX}: ${id}`
}

/** True when this id can be named in a directive a pane accepts. */
export function isWakeReadDirectiveId(id: string): boolean {
  const trimmed = id.trim()
  return trimmed.length > 0 && WAKE_READ_DIRECTIVE_MESSAGE_ID.test(wakeReadDirective(trimmed))
}

/**
 * The row kinds that OPEN A BALL for their recipient (29327, @cto 1eb4c66c).
 */
export const BALL_OPENING_TYPES: ReadonlySet<string> = new Set(["request", "query", "assign"])

/**
 * What the pane is handed for one row. A ball-opening row becomes the read
 * directive naming its message and carries NO body: the line is byte-identical
 * to the one the pane primitive accepts, so it cannot be refused as
 * directive-shaped-without-a-message. Every other row keeps its body.
 *
 * `unnameable` is reported rather than hidden: an id that cannot form a
 * directive keeps today's body (losing a real obligation silently would be
 * worse than a stale body) and the caller says so on the adapter log.
 */
export function composeForwardedRowContent(row: { id?: string; type?: string; content?: string }): {
  content: string
  directive: boolean
  unnameable: boolean
} {
  const kind = String(row.type ?? "notify")
  const rowId = row.id === undefined ? undefined : String(row.id)
  if (!BALL_OPENING_TYPES.has(kind) || rowId === undefined) {
    return { content: String(row.content ?? ""), directive: false, unnameable: false }
  }
  if (!isWakeReadDirectiveId(rowId)) {
    return { content: String(row.content ?? ""), directive: false, unnameable: true }
  }
  return { content: wakeReadDirective(rowId), directive: true, unnameable: false }
}
