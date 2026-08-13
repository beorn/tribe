/**
 * Half-open upper bound for a prefix match, so prefix queries stay index-usable.
 *
 * A prefix test written as `substr(col, 1, length($p)) = $p` — or as
 * `LIKE $p || '%'` — applies a function to the indexed column, which forces
 * SQLite to evaluate it row by row over the whole table. The equivalent range
 * `$p <= col < upper($p)` touches exactly the same rows while remaining a
 * range scan an index on `col` can serve.
 *
 * The bound is the prefix with its last code point incremented: every string
 * beginning with the prefix sorts at or after the prefix and strictly before
 * that successor under BINARY collation, which is SQLite's default and the
 * collation these columns use.
 */

/**
 * Returns the exclusive upper bound for `prefix`, or null when no bound exists
 * (an empty prefix matches everything, so a range cannot narrow it, and the
 * caller must not silently turn that into a query matching nothing).
 */
export function derivedLaunchPrefixUpperBound(prefix: string): string | null {
  if (prefix.length === 0) return null
  const codePoints = [...prefix]
  const last = codePoints[codePoints.length - 1]
  if (last === undefined) return null
  const lastCode = last.codePointAt(0)
  if (lastCode === undefined) return null
  // U+10FFFF is the highest code point, so it has no in-range successor. Step
  // up to the next representable string instead by appending, which still
  // bounds the prefix from above.
  if (lastCode >= 0x10ffff) return `${prefix}\u{10FFFF}`
  return codePoints.slice(0, -1).join("") + String.fromCodePoint(lastCode + 1)
}
