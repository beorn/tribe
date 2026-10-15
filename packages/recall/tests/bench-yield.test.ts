/**
 * @failure  `recall status --bench` printed "Search quality is good" from result count, session spread and latency
 *           alone, measures that say nothing about relevance (@dev/5, 2026-10-15, scanner.ts:448)
 * @level    l1
 * @consumer history/scanner.ts reviewRecall's search benchmarks (@ag/recall/three-dark-search-paths acceptance 6)
 * @testonly none
 */
import { describe, expect, test } from "vitest"

const { benchmarkRecommendations } = await import("../src/history/scanner.ts")

const probe = (resultCount: number, uniqueSessions: number, latencyMs = 40) => ({
  query: "bug fix",
  resultCount,
  latencyMs,
  avgSnippetLength: 120,
  uniqueSessions,
  hasTitles: true,
})

describe("the canned probes report yield and latency, never search quality", () => {
  test("a fast cohort with many results across many sessions earns no quality line", () => {
    const lines = benchmarkRecommendations([probe(40, 9), probe(25, 6), probe(10, 3), probe(5, 2)])

    expect(lines).toEqual([])
    expect(lines.join(" ")).not.toMatch(/quality/i)
  })

  test("an empty cohort and a one-session cohort still say what they found", () => {
    expect(benchmarkRecommendations([probe(0, 0), probe(0, 0)])).toEqual([
      "All benchmark queries returned 0 results — index may be empty or corrupt",
    ])
    expect(benchmarkRecommendations([probe(4, 1), probe(2, 1)])).toEqual([
      "Results only from 1 session per query — index may be incomplete",
    ])
  })
})
