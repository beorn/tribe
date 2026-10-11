/**
 * @failure  `recall search`'s provenance and `recall status`'s isStale drift onto
 *           separate freshness windows again, so one `index_meta.last_rebuild`
 *           stamp reads "stale" (exit 3) in one instrument and "fresh" in the
 *           other, and neither names the window it judged.
 * @level    l1
 * @consumer @ag/recall/27930 — the one freshness verdict (src/lib/staleness.ts,
 *           read by src/lib/search.ts and src/history/scanner.ts)
 * @testonly none
 */
/**
 * ONE freshness verdict — @ag/recall/27930.
 *
 * `recall search` reported `provenance: "stale"` (exit 3) while `recall status`
 * reported `isStale: false` for the SAME `index_meta.last_rebuild` stamp: status
 * carried its own hard-coded 1h window while search used
 * `RECALL_STALE_THRESHOLD` (default 5m), so the two instruments gave two
 * verdicts about one index. These tests pin the single verdict both now read,
 * and that a stale answer names the root and the window it judged.
 */
import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

process.env.RECALL_DB_PATH = ":memory:"

const { closeDb, getDb, setIndexMeta } = await import("../src/history/db")
const {
  INDEX_FRESHNESS_ROOT,
  RECALL_INDEX_CADENCE,
  RECALL_INDEX_RUN_ALLOWANCE,
  RECALL_INDEX_RUN_SLACK,
  RECALL_INDEX_RUN_TIMEOUT_SEC,
  RECALL_STALE_THRESHOLD_DEFAULT,
  describeFreshness,
  getStaleThresholdMs,
  judgeIndexFreshness,
  parseThreshold,
} = await import("../src/lib/staleness")
const { readIndexFreshness, readIndexProvenance } = await import("../src/lib/search")
const { reviewMemorySystem } = await import("../src/history/scanner")

const originalThreshold = process.env.RECALL_STALE_THRESHOLD

/** Evaluate cadence+allowance from staleness.ts source, so a timeout mutation is visible. */
function evaluateStaleDefaultMs(source: string): number {
  const timeout = Number(/export const RECALL_INDEX_RUN_TIMEOUT_SEC = (\d+)/.exec(source)?.[1])
  const cadence = /export const RECALL_INDEX_CADENCE = "([^"]+)"/.exec(source)?.[1]
  if (!Number.isFinite(timeout) || cadence === undefined) {
    throw new Error("could not read cadence/timeout from staleness.ts")
  }
  const slack = /export const RECALL_INDEX_RUN_SLACK = "([^"]+)"/.exec(source)?.[1]
  const allowanceQuoted = /export const RECALL_INDEX_RUN_ALLOWANCE = "([^"]+)"/.exec(source)?.[1]
  const allowanceTemplate = /export const RECALL_INDEX_RUN_ALLOWANCE = `([^`]+)`/.exec(source)?.[1]
  let allowance: string
  if (allowanceTemplate !== undefined) {
    allowance = new Function(
      "RECALL_INDEX_RUN_TIMEOUT_SEC",
      "parseThreshold",
      "RECALL_INDEX_RUN_SLACK",
      `return \`${allowanceTemplate}\``,
    )(timeout, parseThreshold, slack) as string
  } else if (allowanceQuoted !== undefined) {
    allowance = allowanceQuoted
  } else {
    throw new Error("could not read RECALL_INDEX_RUN_ALLOWANCE initializer")
  }
  return parseThreshold(cadence) + parseThreshold(allowance)
}

/** A `last_rebuild` stamp as it is stored, aged by `ms`. */
function stampAgedBy(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

beforeEach(() => {
  delete process.env.RECALL_STALE_THRESHOLD
  closeDb()
  setIndexMeta(getDb(), "last_rebuild", stampAgedBy(60_000))
})

afterEach(() => {
  if (originalThreshold === undefined) delete process.env.RECALL_STALE_THRESHOLD
  else process.env.RECALL_STALE_THRESHOLD = originalThreshold
  closeDb()
})

describe("the one freshness verdict", () => {
  test("judges the documented window and names itself the default", () => {
    const fresh = judgeIndexFreshness(stampAgedBy(60_000))
    expect(RECALL_INDEX_CADENCE).toBe("1h")
    expect(RECALL_STALE_THRESHOLD_DEFAULT).toBe("75m")
    expect(parseThreshold(RECALL_STALE_THRESHOLD_DEFAULT)).toBe(
      parseThreshold(RECALL_INDEX_CADENCE) + parseThreshold(RECALL_INDEX_RUN_ALLOWANCE),
    )
    expect(fresh.windowMs).toBe(getStaleThresholdMs())
    expect(fresh.windowMs).toBe(75 * 60 * 1000)
    expect(fresh.windowSource).toBe("default")
    expect(fresh.root).toBe(INDEX_FRESHNESS_ROOT)
    expect(fresh.provenance).toBe("complete")
  })

  /**
   * @failure The reader window stays 75m when the recall-index timeout doubles,
   *          because allowance is a second literal instead of timeout plus slack.
   * @level l1
   * @consumer @i/1-instruments/28594/28600/28613 AC3 — window derived from cadence plus run time
   * @testonly none
   */
  test("allowance is timeout plus slack, so a timeout mutation changes the window", () => {
    const src = readFileSync(new URL("../src/lib/staleness.ts", import.meta.url), "utf8")
    expect(evaluateStaleDefaultMs(src)).toBe(75 * 60 * 1000)
    const mutated = src.replace(
      /export const RECALL_INDEX_RUN_TIMEOUT_SEC = 600/,
      "export const RECALL_INDEX_RUN_TIMEOUT_SEC = 1200",
    )
    expect(evaluateStaleDefaultMs(mutated)).toBe(85 * 60 * 1000)
    expect(RECALL_INDEX_RUN_TIMEOUT_SEC).toBe(600)
    expect(parseThreshold(RECALL_INDEX_RUN_ALLOWANCE)).toBe(
      parseThreshold(`${RECALL_INDEX_RUN_TIMEOUT_SEC}s`) + parseThreshold(RECALL_INDEX_RUN_SLACK),
    )
  })

  test("a stamp past the window is stale, and the verdict carries the age it judged", () => {
    const stale = judgeIndexFreshness(stampAgedBy(80 * 60 * 1000))
    expect(stale.provenance).toBe("stale")
    expect(stale.ageMs).toBeGreaterThanOrEqual(80 * 60 * 1000)
    expect(stale.lastRebuild).toBeTruthy()
  })

  test("an env override IS the window, and the verdict says which source judged", () => {
    process.env.RECALL_STALE_THRESHOLD = "1h"
    const thirtyMinutes = judgeIndexFreshness(stampAgedBy(30 * 60 * 1000))
    expect(thirtyMinutes.windowMs).toBe(60 * 60 * 1000)
    expect(thirtyMinutes.windowSource).toBe("RECALL_STALE_THRESHOLD")
    expect(thirtyMinutes.provenance).toBe("complete")
  })

  test("no stamp is missing; an unreadable stamp is unknown", () => {
    expect(judgeIndexFreshness(null).provenance).toBe("missing")
    expect(judgeIndexFreshness(null).ageMs).toBeNull()
    expect(judgeIndexFreshness("not-a-date").provenance).toBe("unknown")
  })

  test("a stale answer names the root and the window it judged", () => {
    const named = describeFreshness(judgeIndexFreshness(stampAgedBy(80 * 60 * 1000)))
    expect(named).toContain(INDEX_FRESHNESS_ROOT)
    expect(named).toContain("window")
    expect(named).toContain("old")
    expect(named).toContain("80m old vs 75m window (default)")
  })

  /**
   * @failure Normal 1h timer cycles are rejected by a shorter reader allowance.
   * @level l1
   * @consumer recall search/status using the recall-index timer's completed stamp
   * @testonly none
   */
  test.each([
    [30 * 60_000, "complete"],
    [75 * 60_000, "complete"],
    [75 * 60_000 + 1, "stale"],
    [80 * 60_000, "stale"],
  ] as const)("judges scheduled-cycle age %dms as %s", (ageMs, provenance) => {
    const now = Date.now()
    const verdict = judgeIndexFreshness(new Date(now - ageMs).toISOString(), now)
    expect(verdict.provenance).toBe(provenance)
    expect(verdict.ageMs).toBe(ageMs)
  })
})

describe("search and status cannot disagree about one stamp", () => {
  test("a stamp inside the window reads complete and not stale, in both instruments", async () => {
    setIndexMeta(getDb(), "last_rebuild", stampAgedBy(60_000))
    const search = readIndexProvenance({})
    const review = await reviewMemorySystem(process.cwd(), { skipLlm: true, skipSearchBenchmarks: true })
    expect(search).toBe("complete")
    expect(review.indexHealth.freshness.provenance).toBe(search)
    expect(review.indexHealth.isStale).toBe(false)
  })

  test("a stamp past the window reads stale and IS stale, in both instruments", async () => {
    setIndexMeta(getDb(), "last_rebuild", stampAgedBy(80 * 60 * 1000))
    const search = readIndexProvenance({})
    const review = await reviewMemorySystem(process.cwd(), { skipLlm: true, skipSearchBenchmarks: true })
    // The defect @ag/recall/27930 was this pair reading "stale" beside
    // isStale:false, because status judged a 1h window while search judged 5m.
    expect(search).toBe("stale")
    expect(review.indexHealth.isStale).toBe(true)
    expect(review.indexHealth.freshness.provenance).toBe(search)
    expect(review.indexHealth.freshness).toMatchObject({
      root: INDEX_FRESHNESS_ROOT,
      windowMs: 75 * 60 * 1000,
    })
  })

  test("the search answer itself carries the root and window it judged", () => {
    setIndexMeta(getDb(), "last_rebuild", stampAgedBy(80 * 60 * 1000))
    const freshness = readIndexFreshness({})
    expect(freshness.provenance).toBe("stale")
    expect(freshness.root).toBe(INDEX_FRESHNESS_ROOT)
    expect(freshness.windowMs).toBe(75 * 60 * 1000)
  })
})
