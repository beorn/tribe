/**
 * Optional `ask` on tribe request/query (26520 AC1, CTO 28c0764f).
 *
 * Stored as JSON TEXT. Old rows read back with no ask. Validation is the send
 * boundary: a pre-upgrade daemon that dropped unknown keys would still return
 * sent:true, so the client requires an echo of the accepted ask.
 */

export const ASK_OPTION_MIN = 1
export const ASK_OPTION_MAX = 8
export const ASK_LABEL_MAX_CHARS = 40
export const ASK_ALLOWED_TYPES = new Set(["request", "query"])

export type Ask = {
  options: string[]
  default?: string
}

export type AskParseOk = { ok: true; ask: Ask }
export type AskParseErr = { ok: false; error: string }
export type AskParseResult = AskParseOk | AskParseErr

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
}

/** Refuse unknown keys so a future field cannot be silently dropped. */
const ASK_KEYS = new Set(["options", "default"])

export function parseAsk(raw: unknown): AskParseResult {
  if (!isRecord(raw)) {
    return { ok: false, error: "tribe.send: invalid ask - must be an object {options, default?}" }
  }
  const unknown = Object.keys(raw).filter((key) => !ASK_KEYS.has(key))
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `tribe.send: invalid ask - unknown field${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}`,
    }
  }
  if (!Array.isArray(raw.options)) {
    return { ok: false, error: "tribe.send: invalid ask.options - must be an array of 1 to 8 unique non-empty labels" }
  }
  const options: string[] = []
  const seen = new Set<string>()
  for (const [index, label] of raw.options.entries()) {
    if (typeof label !== "string") {
      return {
        ok: false,
        error: `tribe.send: invalid ask.options[${index}] - each label must be a non-empty string of at most ${ASK_LABEL_MAX_CHARS} characters`,
      }
    }
    const trimmed = label.trim()
    if (trimmed.length === 0 || trimmed.length > ASK_LABEL_MAX_CHARS) {
      return {
        ok: false,
        error: `tribe.send: invalid ask.options[${index}] - each label must be a non-empty string of at most ${ASK_LABEL_MAX_CHARS} characters`,
      }
    }
    if (seen.has(trimmed)) {
      return { ok: false, error: "tribe.send: invalid ask.options - labels must be unique" }
    }
    seen.add(trimmed)
    options.push(trimmed)
  }
  if (options.length < ASK_OPTION_MIN || options.length > ASK_OPTION_MAX) {
    return { ok: false, error: "tribe.send: invalid ask.options - must be an array of 1 to 8 unique non-empty labels" }
  }
  let ask: Ask = { options }
  if (raw.default !== undefined) {
    if (typeof raw.default !== "string") {
      return { ok: false, error: "tribe.send: invalid ask.default - must be one of options and equal options[0]" }
    }
    const trimmed = raw.default.trim()
    if (!options.includes(trimmed)) {
      return { ok: false, error: "tribe.send: invalid ask.default - must be one of options and equal options[0]" }
    }
    if (trimmed !== options[0]) {
      return { ok: false, error: "tribe.send: invalid ask.default - when set, default must equal options[0]" }
    }
    ask = { options, default: trimmed }
  }
  return { ok: true, ask }
}

export function serializeAsk(ask: Ask): string {
  return JSON.stringify(ask.default === undefined ? { options: ask.options } : ask)
}

export function deserializeAsk(stored: string | null | undefined): Ask | null {
  if (stored === null || stored === undefined || stored.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch (error) {
    throw new Error(`tribe: stored ask is not JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  const result = parseAsk(parsed)
  if (!result.ok) {
    throw new Error(`tribe: stored ask is invalid - ${result.error}`)
  }
  return result.ask
}

export function asksEqual(left: Ask, right: Ask): boolean {
  if (left.options.length !== right.options.length) return false
  if (left.options.some((label, index) => label !== right.options[index])) return false
  return left.default === right.default
}
