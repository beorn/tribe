/**
 * 28909 — the ONE definition of the fetch read's row bound, shared by the daemon
 * that enforces it and the wire CLI that refuses an out-of-range value before it
 * connects.
 *
 * It used to live in two copies: `handleFetch` silently clamped anything outside
 * 1..500 to 50, so `--limit 1000` returned exactly the 50 rows of `--limit 50`
 * and every MCP caller got the same silent truncation (the measured complaint of
 * @ag/tribe/28909). Now the daemon refuses an out-of-range limit BY NAME, the
 * CLI refuses the same range before opening a socket, and both read the bound
 * from here.
 */

/** The smallest useful fetch read. */
export const TRIBE_FETCH_MIN_LIMIT = 1

/** The largest fetch read the daemon will run; above it, the read is refused by name. */
export const TRIBE_FETCH_MAX_LIMIT = 500

/** The bound an absent limit gets. */
export const TRIBE_FETCH_DEFAULT_LIMIT = 50

/**
 * The window a `--topics` read scans before it filters. A topics snapshot reads
 * this many rows and then filters them in memory, so it can return fewer rows
 * than `limit` while more matching rows exist — which is why the CLI names this
 * window instead of reading as exhaustive. Shared so the CLI's scope line cannot
 * drift from what the daemon actually scans.
 */
export const TRIBE_FETCH_TOPICS_WINDOW = 500

/**
 * The refusal for a fetch `limit` outside [MIN, MAX], or undefined when the value
 * is absent or in range. Both the daemon and the CLI call this, so a caller who
 * asked for too many rows is told the supported range instead of silently
 * receiving the default.
 */
export function fetchLimitOutOfRangeMessage(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < TRIBE_FETCH_MIN_LIMIT ||
    value > TRIBE_FETCH_MAX_LIMIT
  ) {
    return (
      `limit ${JSON.stringify(value)} is out of range; pass an integer between ` +
      `${TRIBE_FETCH_MIN_LIMIT} and ${TRIBE_FETCH_MAX_LIMIT}.`
    )
  }
  return undefined
}
