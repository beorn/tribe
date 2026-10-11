/**
 * Pure staleness helpers — see @km/bearly/19216-recall-freshness-shrink-threshold.
 *
 * Split from search.ts so unit tests can import these without dragging the
 * search.ts transitive closure (`bun:sqlite`, indexer, llm/agent → zod) into
 * vitest's node runtime. search.ts re-exports these for the existing surface.
 */

import type { IndexProvenance } from "../history/recall-shared.ts"

/**
 * Covers the recall-index timer's 1h cadence plus a 1m rebuild allowance.
 * Timer declaration: tools/hh-cli/hab-projects.ts, rootServiceDefinitions["recall-index"].
 * Revisit this allowance when that cadence changes; slower runs still report stale.
 */
export const RECALL_STALE_THRESHOLD_DEFAULT = "61m"

/** Parse "5m" / "30s" / "1h" / "500ms" / bare number-as-minutes → ms. */
export function parseThreshold(s: string): number {
  const m = /^(\d+)\s*(ms|s|m|h)?$/.exec(s.trim())
  if (!m) {
    throw new Error(`parseThreshold: invalid duration "${s}" — accepts <n>[ms|s|m|h] (e.g. "5m", "30s", "1h", "500ms")`)
  }
  const value = m[1]
  if (value === undefined) {
    throw new Error(`parseThreshold: missing duration value for "${s}"`)
  }
  const n = parseInt(value, 10)
  switch (m[2]) {
    case "ms":
      return n
    case "s":
      return n * 1000
    case "h":
      return n * 60 * 60 * 1000
    case "m":
    case undefined:
    case "":
      return n * 60 * 1000
    default:
      throw new Error(`parseThreshold: unreachable unit "${m[2]}"`)
  }
}

/** Read the env-or-default stale threshold (ms). */
export function getStaleThresholdMs(): number {
  return parseThreshold(process.env.RECALL_STALE_THRESHOLD ?? RECALL_STALE_THRESHOLD_DEFAULT)
}

/** The one field `recall search` and `recall status` both read to judge index freshness. */
export const INDEX_FRESHNESS_ROOT = "index_meta.last_rebuild"

/**
 * ONE verdict about the FTS index's freshness.
 *
 * `recall search`'s `provenance` and `recall status`'s `isStale` are both derived
 * from this object, so the two instruments cannot disagree about one index. It
 * names the root it judged (`root`) and the window it judged over
 * (`windowMs`/`windowSource`), because a bare "stale" that does not say what it
 * compared is unreadable beside another instrument's "fresh" (@ag/recall/27930).
 */
export interface IndexFreshness {
  root: typeof INDEX_FRESHNESS_ROOT
  lastRebuild: string | null
  ageMs: number | null
  windowMs: number
  windowSource: string
  provenance: IndexProvenance
}

/**
 * ms → "45s" / "62m" / "3.0h", for a verdict's own label. Minutes hold to two hours: the default window is 61m, and
 * in tenths of an hour a 62m-old index against it read "1.0h old vs 1.0h window", a stale verdict naming two equal
 * numbers.
 */
export function describeMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 7_200_000) return `${Math.round(ms / 60_000)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

/** The root and window one verdict judged, as one readable clause. */
export function describeFreshness(f: IndexFreshness): string {
  const age = f.ageMs === null ? `no ${f.root} stamp` : `${describeMs(f.ageMs)} old`
  return `${age} vs ${describeMs(f.windowMs)} window (${f.windowSource}) on ${f.root}`
}

/**
 * Judge one rebuild stamp against the one freshness window. Pure: the caller owns
 * the DB read (`getIndexMeta(db, "last_rebuild")`), so `recall search`'s
 * provenance and `recall status`'s staleness reach the same verdict from the
 * same input instead of each carrying its own threshold.
 */
export function judgeIndexFreshness(lastRebuild: string | null, now: number = Date.now()): IndexFreshness {
  const windowMs = getStaleThresholdMs()
  const windowSource = process.env.RECALL_STALE_THRESHOLD ? "RECALL_STALE_THRESHOLD" : "default"
  const judged = { root: INDEX_FRESHNESS_ROOT, lastRebuild, windowMs, windowSource } as const
  if (!lastRebuild) return { ...judged, ageMs: null, provenance: "missing" }
  const rebuiltAt = new Date(lastRebuild).getTime()
  if (!Number.isFinite(rebuiltAt)) return { ...judged, ageMs: null, provenance: "unknown" }
  const ageMs = now - rebuiltAt
  return { ...judged, ageMs, provenance: ageMs <= windowMs ? "complete" : "stale" }
}

export type RefreshResult =
  | { refreshed: false; reason: "fresh" | "no-meta" | "opt-out" }
  | { refreshed: true; staleMs: number; refreshMs: number }
  | { refreshed: false; reason: "error"; error: string; staleMs: number }
