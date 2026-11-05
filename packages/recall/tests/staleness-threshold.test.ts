/**
 * @failure  RECALL_STALE_THRESHOLD parsing accepts a bad duration or drifts from the 75m default, so the
 *           freshness verdict calls a fresh index stale or a stale one fresh (@km/bearly/19216-recall-freshness-shrink-threshold)
 * @level    l0
 * @consumer lib/staleness.ts getStaleThresholdMs, read by the recall freshness verdict
 * @testonly none
 *
 * The auto-refresh cases left with lib/refresh.ts (no production caller since 228a6a3a39a).
 */
import { describe, test, expect, afterEach } from "vitest"
import { parseThreshold, getStaleThresholdMs, RECALL_STALE_THRESHOLD_DEFAULT } from "../src/lib/staleness"

describe("parseThreshold", () => {
  test('accepts "5m" — 5 minutes', () => {
    expect(parseThreshold("5m")).toBe(5 * 60 * 1000)
  })

  test('accepts "1h" — 1 hour', () => {
    expect(parseThreshold("1h")).toBe(60 * 60 * 1000)
  })

  test('accepts "30s" — 30 seconds', () => {
    expect(parseThreshold("30s")).toBe(30 * 1000)
  })

  test('accepts "500ms" — milliseconds explicit', () => {
    expect(parseThreshold("500ms")).toBe(500)
  })

  test('bare "10" defaults to minutes (most-common-input optimization)', () => {
    expect(parseThreshold("10")).toBe(10 * 60 * 1000)
  })

  test("trims whitespace", () => {
    expect(parseThreshold("  5m  ")).toBe(5 * 60 * 1000)
  })

  test('throws on garbage "5y"', () => {
    expect(() => parseThreshold("5y")).toThrow(/invalid duration/)
  })

  test('throws on empty ""', () => {
    expect(() => parseThreshold("")).toThrow(/invalid duration/)
  })

  test('default RECALL_STALE_THRESHOLD_DEFAULT is "75m" — covers the scheduled rebuild', () => {
    expect(RECALL_STALE_THRESHOLD_DEFAULT).toBe("75m")
    expect(parseThreshold(RECALL_STALE_THRESHOLD_DEFAULT)).toBe(75 * 60 * 1000)
  })
})

describe("getStaleThresholdMs (env override)", () => {
  const originalEnv = process.env.RECALL_STALE_THRESHOLD

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.RECALL_STALE_THRESHOLD
    else process.env.RECALL_STALE_THRESHOLD = originalEnv
  })

  test("defaults to 75m when env unset", () => {
    delete process.env.RECALL_STALE_THRESHOLD
    expect(getStaleThresholdMs()).toBe(75 * 60 * 1000)
  })

  test('honors RECALL_STALE_THRESHOLD="10m"', () => {
    process.env.RECALL_STALE_THRESHOLD = "10m"
    expect(getStaleThresholdMs()).toBe(10 * 60 * 1000)
  })

  test('honors RECALL_STALE_THRESHOLD="1h"', () => {
    process.env.RECALL_STALE_THRESHOLD = "1h"
    expect(getStaleThresholdMs()).toBe(60 * 60 * 1000)
  })
})
