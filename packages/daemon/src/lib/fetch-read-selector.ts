/**
 * 28402 — one owner for "does this fetch read have an EFFECTIVE selector".
 *
 * The snapshot-only CLI/RPC read (`cli_session_fetch_read_v1`,
 * `invalidFetchReadFilter`) must refuse a caller who supplied no selector that
 * can select anything. A PRESENT but EMPTY selector is neither an absent one nor
 * a selector: `topics: []`, `ids: []`, `from: ""`, `to: ""` and `with: ""`
 * select nothing, and reading one as absent widened a history lookup into the
 * canonical DEFAULT drain — the mailbox cursor advanced and the attention-read
 * stamp was touched, so a fresh unread verdict vanished from the caller's unread
 * view (the 21757 hazard).
 *
 * The refusal belongs HERE, at the snapshot-only boundary, and NOT inside the
 * canonical `handleFetch`: a registered seat's own model read may legitimately
 * carry an empty unused field — `{topics: []}` is the ordinary default read, and
 * `{since: 0, topics: []}` is a valid read-only history call — so refusing those
 * would be a broader MCP contract change (review 2026-10-09, @dev/6). A present
 * non-empty sibling selector makes the read a snapshot on its own, so an empty
 * field beside one is inert and is left alone. `since: 0` counts as effective:
 * it is a real row-id base, unlike an absent `since`.
 */
export const FETCH_READ_SELECTOR_KEYS = ["ids", "topics", "since", "with", "from", "to"] as const

/** Whether a PRESENT selector value can select anything; `since: 0` is effective. */
function isEffectiveSelectorValue(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "number") return Number.isFinite(value) && value >= 0
  return false
}

/** The first PRESENT-but-not-effective selector key, or undefined when none is empty. */
export function emptyFetchReadSelectorKey(
  params: Record<string, unknown>,
): (typeof FETCH_READ_SELECTOR_KEYS)[number] | undefined {
  for (const key of FETCH_READ_SELECTOR_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(params, key)) continue
    if (!isEffectiveSelectorValue(params[key])) return key
  }
  return undefined
}

/** True when at least one PRESENT selector can select something. */
export function hasEffectiveFetchReadSelector(params: Record<string, unknown>): boolean {
  return FETCH_READ_SELECTOR_KEYS.some(
    (key) => Object.prototype.hasOwnProperty.call(params, key) && isEffectiveSelectorValue(params[key]),
  )
}

/**
 * The refusal for a request that supplied only empty selectors, or undefined
 * when the request supplied an effective one. It names the empty field, so a
 * script that sent `topics: []` is told which value to fix rather than guessing.
 * A request with NO selector key at all returns undefined here: the boundary's
 * existing "requires a snapshot selector" sentence owns that shape.
 */
export function emptyFetchReadSelectorRefusal(params: Record<string, unknown>): string | undefined {
  if (hasEffectiveFetchReadSelector(params)) return undefined
  const key = emptyFetchReadSelectorKey(params)
  if (key === undefined) return undefined
  const shape = Array.isArray(params[key]) ? "an empty list" : "an empty string"
  return (
    `Authenticated fetch read filter '${key}' is ${shape}; an empty selector selects nothing (28402). ` +
    `Give it a value, or pass a non-empty selector. The live read is tribe inbox.`
  )
}
