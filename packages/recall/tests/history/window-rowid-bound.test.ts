/**
 * @failure a --since window bound on the FTS rowid (C2) or a reordered message filter (C1) drops an in-window match,
 *   keeps an out-of-window one, or moves rank, order or total: catch-up rows with old timestamps and high ids, and
 *   in-window rows interleaved below older ids, are where an id-tracks-time assumption would break
 * @level l2
 * @consumer @ag/recall/three-dark-search-paths
 * @testonly none
 *
 * CTO e6b99892 condition 1 (fixture test first). Requirement: with sinceTime set, exact and hook reads return exactly
 * the no-window read filtered to timestamp >= since, in the same order with the same ranks, and the same total.
 * Gap: no existing test seeds ids out of time order or a uuid twin whose canonical copy is outside the window.
 */
import { Database } from "bun:sqlite"
import { describe, expect, test } from "vitest"
import { initSchema } from "../../src/history/db-schema.ts"
import { ftsSearchWithSnippet, insertMessage, upsertSession } from "../../src/history/db-queries.ts"

const TOKEN = "windowbound"
const DAY = 86_400_000

/** Rows in id order, with timestamps deliberately out of id order. */
function seed(): { db: Database; since: number } {
  const db = new Database(":memory:")
  db.exec("PRAGMA journal_mode = MEMORY")
  initSchema(db)
  const now = 1_800_000_000_000
  const since = now - 30 * DAY
  upsertSession(db, "a", "/test", "/tmp/a.jsonl", now - 90 * DAY, now, 1, "a")
  upsertSession(db, "b", "/test", "/tmp/b.jsonl", now - 90 * DAY, now, 1, "b")
  const rows: [string | null, string, number, string][] = [
    ["u-old-1", "a", now - 60 * DAY, `${TOKEN} old first`], // pruned by the bound
    ["u-twin", "a", now - 50 * DAY, `${TOKEN} twin canonical outside the window`],
    ["u-in-1", "a", now - 10 * DAY, `${TOKEN} ${TOKEN} in window early id`], // the window's MIN(id)
    ["u-old-2", "a", now - 40 * DAY, `${TOKEN} old between in-window ids`],
    [null, "a", now - 5 * DAY, `${TOKEN} null uuid in window`],
    ["u-twin", "b", now - 2 * DAY, `${TOKEN} twin copy inside the window`], // not canonical: excluded either way
    ["u-catchup", "b", now - 70 * DAY, `${TOKEN} catch-up row old timestamp high id`],
    ["u-in-2", "b", now - 1 * DAY, `${TOKEN} in window late id ${TOKEN} ${TOKEN}`],
  ]
  rows.forEach(([uuid, session, ts, content], i) => {
    insertMessage(db, uuid, session, "user", content, null, null, ts, null, i + 1)
  })
  return { db, since }
}

const view = (rows: { id: number; rank?: number; timestamp?: number }[]) =>
  rows.map((r) => ({ id: r.id, rank: r.rank, timestamp: r.timestamp }))

describe("--since window bound on the FTS rowid (CTO e6b99892 C1, C2)", () => {
  test("exact read equals the unwindowed read filtered to the window: rows, order, rank and total", () => {
    const { db, since } = seed()
    const all = ftsSearchWithSnippet(db, TOKEN, { limit: 100 })
    const windowed = ftsSearchWithSnippet(db, TOKEN, { limit: 100, sinceTime: since })
    const expected = all.results.filter((r) => (r.timestamp ?? 0) >= since)
    expect(view(windowed.results)).toEqual(view(expected))
    expect(windowed.results.map((r) => r.content)).toEqual([
      `${TOKEN} in window late id ${TOKEN} ${TOKEN}`,
      `${TOKEN} ${TOKEN} in window early id`,
      `${TOKEN} null uuid in window`,
    ])
    expect(windowed.total).toBe(3)
    db.close()
  })

  test("hook read equals the unwindowed hook read filtered to the window", () => {
    const { db, since } = seed()
    const all = ftsSearchWithSnippet(db, TOKEN, { mode: "hook", limit: 100, withTotal: true })
    const windowed = ftsSearchWithSnippet(db, TOKEN, { mode: "hook", limit: 100, withTotal: true, sinceTime: since })
    expect(view(windowed.results)).toEqual(view(all.results.filter((r) => (r.timestamp ?? 0) >= since)))
    expect(windowed.total).toBe(3)
    db.close()
  })

  test("a window holding no rows returns nothing rather than every match", () => {
    const { db } = seed()
    const future = ftsSearchWithSnippet(db, TOKEN, { limit: 100, sinceTime: 1_900_000_000_000 })
    expect(future.results).toEqual([])
    expect(future.total).toBe(0)
    db.close()
  })
})
