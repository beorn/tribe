/**
 * 28402 — one owner for "is this fetch read filter EMPTY".
 *
 * `tribe.fetch` (the MCP tool, `handleFetch`) and the authenticated snapshot RPC
 * (`cli_session_fetch_read_v1`, `invalidFetchReadFilter`) must agree, or the two
 * drift and one transport reaches a branch the other refuses.
 *
 * An empty selector is NOT an absent selector. `topics: []`, `ids: []`,
 * `from: ""`, `to: ""`, `with: ""` are PRESENT keys whose value selects nothing;
 * treating them as absent silently WIDENS a history lookup into the default
 * acknowledging drain — the mailbox cursor advances and the attention-read stamp
 * is touched, so a fresh unread verdict disappears from the seat's unread view
 * (the 21757 hazard). An empty selector is meaningless as a filter, so it is
 * refused by name rather than widened.
 */
export const FETCH_READ_SELECTOR_KEYS = ["ids", "topics", "since", "with", "from", "to"] as const

/** The first PRESENT-but-EMPTY selector key, or undefined when none is empty. */
export function emptyFetchReadSelectorKey(
  params: Record<string, unknown>,
): (typeof FETCH_READ_SELECTOR_KEYS)[number] | undefined {
  for (const key of FETCH_READ_SELECTOR_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(params, key)) continue
    const value = params[key]
    const empty = (typeof value === "string" && value.length === 0) || (Array.isArray(value) && value.length === 0)
    if (empty) return key
  }
  return undefined
}

/**
 * The refusal sentence both owners return verbatim, so the tool path and the RPC
 * boundary can never say different things about the same shape.
 */
export function emptyFetchReadSelectorError(params: Record<string, unknown>): string | undefined {
  const key = emptyFetchReadSelectorKey(params)
  if (key === undefined) return undefined
  const shape = Array.isArray(params[key]) ? "an empty list" : "an empty string"
  return (
    `fetch read filter '${key}' is ${shape}; an empty selector selects nothing (28402). ` +
    `Omit it for the default drain ('tribe inbox'), or give it a value.`
  )
}
