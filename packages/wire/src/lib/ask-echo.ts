/**
 * Old-reader hazard (26520, CTO 28c0764f): a pre-upgrade daemon drops unknown
 * `ask` and still returns sent:true. The client that passed ask must fail loud
 * unless the result echoes the accepted ask.
 */

export const ASK_ECHO_MISSING =
  "tribe.send: ask dropped - daemon did not echo the accepted ask (a pre-upgrade daemon would silently drop it)"

export type AskEcho = {
  options: string[]
  default?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
}

export function parseAskEcho(raw: unknown): AskEcho | null {
  if (!isRecord(raw) || !Array.isArray(raw.options)) return null
  const options = raw.options.filter((label): label is string => typeof label === "string")
  if (options.length !== raw.options.length || options.length === 0) return null
  const echoed: AskEcho = { options }
  if (typeof raw.default === "string") echoed.default = raw.default
  return echoed
}

export function askEchoMatches(sent: AskEcho, echoed: unknown): boolean {
  const got = parseAskEcho(echoed)
  if (got === null) return false
  if (sent.options.length !== got.options.length) return false
  if (sent.options.some((label, index) => label !== got.options[index])) return false
  return sent.default === got.default
}

/** Return the loud refusal, or null when the echo is present and matches. */
export function missingAskEchoError(sent: AskEcho | undefined, result: unknown): string | null {
  if (sent === undefined) return null
  if (!isRecord(result)) return ASK_ECHO_MISSING
  if (typeof result.error === "string" && result.error.length > 0) return null
  if (!askEchoMatches(sent, result.ask)) return ASK_ECHO_MISSING
  return null
}
