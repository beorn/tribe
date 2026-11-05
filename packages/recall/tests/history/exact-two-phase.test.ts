/**
 * @failure exact recall's ranked messages read built every match's content, snippet and duplicate_line before its
 *   LIMIT (D7/D8: p95 2.6 s on the live db); the two-phase cut must keep the same rows, order and tie-break
 * @level l2
 * @consumer @ag/recall/three-dark-search-paths
 * @testonly none
 *
 * CTO 1cfcaba5 condition 4. Requirement: phase B returns exactly phase A's ids in phase A's order, or a named error;
 * both read in one transaction; equal ranks across the overFetch boundary resolve by m.id, as the one-statement read
 * did. Gap: the existing collapse and recall tests never tie ranks across the boundary, never break phase B, and
 * never check that the reads share a transaction.
 */
import { Database } from "bun:sqlite"
import { describe, expect, test, vi } from "vitest"
import { initSchema } from "../../src/history/db-schema.ts"
import { ftsSearchWithSnippet, insertMessage, upsertSession } from "../../src/history/db-queries.ts"

const TOKEN = "twophasetie"

/** n identical messages (equal bm25), each with its own uuid so none collapse, in one session. */
function seedTies(n: number): { db: Database; ids: number[] } {
  const db = new Database(":memory:")
  db.exec("PRAGMA journal_mode = MEMORY")
  initSchema(db)
  const now = Date.now()
  upsertSession(db, "s1", "/test", "/tmp/s1.jsonl", now, now, 1, "s1")
  for (let i = 0; i < n; i++) {
    insertMessage(
      db,
      `u-${String(i)}`,
      "s1",
      "user",
      `${TOKEN} same words every time`,
      null,
      null,
      now + i,
      null,
      i + 1,
    )
  }
  const ids = (db.prepare("SELECT id FROM messages ORDER BY id").all() as { id: number }[]).map((r) => r.id)
  return { db, ids }
}

describe("exact messages read in two phases (CTO 1cfcaba5)", () => {
  test("equal ranks across the overFetch boundary resolve by m.id, with full hit rows and the raw total", () => {
    // limit 2 → overFetch 8: ids 9–12 tie with the 8 kept and are cut by m.id, as before.
    const { db, ids } = seedTies(12)
    const first = ftsSearchWithSnippet(db, TOKEN, { limit: 2 })
    expect(first.total).toBe(12)
    expect(first.results.map((r) => r.id)).toEqual(ids.slice(0, 2))
    expect(first.results[0]?.snippet).toContain(`>>>${TOKEN}<<<`)
    expect(first.results[0]).toHaveProperty("duplicate_line", null)
    expect(first.results[0]).toHaveProperty("project_path", "/test")
    // offset 6, limit 2 → overFetch 32 holds every row; the page is positions 6–7 in m.id order.
    expect(ftsSearchWithSnippet(db, TOKEN, { limit: 2, offset: 6 }).results.map((r) => r.id)).toEqual(ids.slice(6, 8))
    db.close()
  })

  test("both phases and the count read inside one transaction", () => {
    const { db } = seedTies(3)
    const seen: boolean[] = []
    const prepare = db.prepare.bind(db)
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      const stmt = prepare(sql)
      const wrap = (kind: "all" | "get") => {
        const run = stmt[kind].bind(stmt) as (...p: unknown[]) => unknown
        return (...params: unknown[]) => {
          seen.push(db.inTransaction)
          return run(...params)
        }
      }
      return Object.assign(Object.create(stmt), { all: wrap("all"), get: wrap("get") })
    }) as typeof db.prepare)
    ftsSearchWithSnippet(db, TOKEN, { limit: 2 })
    spy.mockRestore()
    expect(seen).toEqual([true, true, true])
    db.close()
  })

  test("a phase B that does not return exactly phase A's ids is a named error, never a shorter page", () => {
    const { db } = seedTies(5)
    const prepare = db.prepare.bind(db)
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      const stmt = prepare(sql)
      if (!sql.includes("json_each")) return stmt
      const all = stmt.all.bind(stmt) as (...p: unknown[]) => unknown[]
      return Object.assign(Object.create(stmt), { all: (...params: unknown[]) => all(...params).slice(0, -1) })
    }) as typeof db.prepare)
    expect(() => ftsSearchWithSnippet(db, TOKEN, { limit: 2 })).toThrow(
      /hit read \(phase B\) returned 4 rows for the 5 ranked ids \(phase A\).*first differing at position 4/,
    )
    spy.mockRestore()
    db.close()
  })
})
