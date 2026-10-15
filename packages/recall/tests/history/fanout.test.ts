/**
 * Tests for fanout: parallel-ish FTS + coverage rerank.
 *
 * Builds an in-memory SQLite with the real schema, inserts a handful of
 * messages + content rows, runs fanoutSearch with crafted variants, and
 * verifies that coverage reranking actually elevates multi-variant hits
 * above single-variant hits with better raw BM25.
 */

import { describe, test, expect, beforeEach, vi } from "vitest"
import { Database } from "bun:sqlite"
import { initSchema } from "../../src/history/db-schema"
import { fanoutSearch, mergeFanouts } from "../../src/lib/fanout"

// ============================================================================
// Test DB setup
// ============================================================================

function makeDb(): Database {
  const db = new Database(":memory:")
  db.exec("PRAGMA journal_mode = MEMORY")
  initSchema(db)
  return db
}

function insertSession(db: Database, id: string, title: string, now: number): void {
  db.prepare(
    `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, "/test", `/tmp/${id}.jsonl`, now - 60_000, now, 5, title)
}

function insertMessage(db: Database, sessionId: string, content: string, timestamp: number): void {
  db.prepare(`INSERT INTO messages (uuid, session_id, type, content, timestamp) VALUES (?, ?, ?, ?, ?)`).run(
    `${sessionId}-${timestamp}`,
    sessionId,
    "user",
    content,
    timestamp,
  )
}

function insertContent(
  db: Database,
  type: string,
  sourceId: string,
  title: string,
  body: string,
  timestamp: number,
): void {
  db.prepare(
    `INSERT INTO content (content_type, source_id, project_path, title, content, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(type, sourceId, "/test", title, body, timestamp)
}

// ============================================================================
// Tests
// ============================================================================

describe("fanoutSearch", () => {
  let db: Database

  beforeEach(() => {
    db = makeDb()
  })

  test("coverage rerank elevates docs hit by multiple variants", () => {
    const now = Date.now()

    // Session A: content mentions "column" AND "layout" AND "cardcolumn"
    // Session B: content mentions "column" only, but very densely (higher BM25)
    insertSession(db, "sess-a", "Column fixes", now - 2 * 3600_000)
    insertSession(db, "sess-b", "Layout rework", now - 3600_000)

    // Session A messages hit ALL three variants
    insertMessage(db, "sess-a", "Fixed the CardColumn layout issue in the kanban column rendering", now - 2 * 3600_000)

    // Session B: very strong single-variant match (repeats "column" many times)
    insertMessage(db, "sess-b", "column column column column column column column column column", now - 3600_000)

    const result = fanoutSearch(db, ["column", "layout", "CardColumn"], {
      limit: 10,
      sinceTime: 0,
    })

    expect(result.results.length).toBeGreaterThan(0)

    // Session A should rank first because it's hit by 3 variants
    // (even though Session B has higher raw BM25 on "column" alone).
    expect(result.results[0]!.sessionId).toBe("sess-a")

    // Verify hitCounts reflects multi-variant coverage
    expect(result.hitCounts.get("message:sess-a")).toBe(3)
    expect(result.hitCounts.get("message:sess-b")).toBe(1)

    // Stats sanity
    expect(result.stats.topCoverage).toBe(3)
    expect(result.stats.uniqueDocs).toBeGreaterThanOrEqual(2)
  })

  test("fanout across message + content tables finds hits in both", () => {
    const now = Date.now()

    insertSession(db, "sess-1", "Recall design", now)
    insertMessage(db, "sess-1", "discussion about recall agents", now)

    // A bead in content table
    insertContent(
      db,
      "bead",
      "km-bearly.recall-llm-agent",
      "Recall: LLM-driven multi-query search agent",
      "Make the recall CLI use a fast LLM to plan FTS queries",
      now - 3600_000,
    )

    const result = fanoutSearch(db, ["recall"], { limit: 10, sinceTime: 0 })
    const types = new Set(result.results.map((r) => r.type))
    expect(types.has("message")).toBe(true)
    expect(types.has("bead")).toBe(true)
  })

  test("survives FTS5-hostile queries without crashing", () => {
    const now = Date.now()
    insertSession(db, "sess-1", "t", now)
    insertMessage(db, "sess-1", "normal text", now)

    // Unbalanced quotes + special chars — these historically trip FTS5
    const badVariants = ['"unclosed', "*@#$%", "", "   "]
    const result = fanoutSearch(db, badVariants, { limit: 10, sinceTime: 0 })
    // Should not throw; may return empty results
    expect(result.variants).toEqual(['"unclosed', "*@#$%"])
    expect(Array.isArray(result.results)).toBe(true)
  })

  test("records per-variant hit sets", () => {
    const now = Date.now()
    insertSession(db, "sess-1", "foo", now)
    insertSession(db, "sess-2", "bar", now)
    insertMessage(db, "sess-1", "apple banana cherry", now)
    insertMessage(db, "sess-2", "apple durian elderberry", now)

    const result = fanoutSearch(db, ["apple", "banana"], { limit: 10, sinceTime: 0 })

    expect(result.variantHits.has("apple")).toBe(true)
    expect(result.variantHits.has("banana")).toBe(true)

    const appleHits = result.variantHits.get("apple")!
    expect(appleHits.length).toBeGreaterThanOrEqual(2) // both sessions

    const bananaHits = result.variantHits.get("banana")!
    expect(bananaHits.length).toBe(1) // only sess-1
  })

  // The small coverage fixtures never cut a candidate set or expose the unused
  // exact message COUNT. Exercise the real SQLite boundary, not a mocked receipt.
  test("bounded message fanout avoids counts and preserves cut receipts across rounds", () => {
    const now = Date.now()
    insertSession(db, "dense", "Dense matching session", now)
    db.transaction(() => {
      for (let i = 0; i < 1003; i++) insertMessage(db, "dense", "zebracorn boundedneedle", now - i)
    })()
    const prepare = vi.spyOn(db, "prepare")
    try {
      const first = fanoutSearch(db, ["zebracorn"], { limit: 5, sinceTime: 0 })
      const second = fanoutSearch(db, ["boundedneedle"], { limit: 5, sinceTime: 0 })
      const merged = mergeFanouts(first, second, 5)
      expect(first.skipped).toEqual([
        expect.objectContaining({ phase: "messages", anchor: "zebracorn", message: expect.stringMatching(/cap|cut/) }),
      ])
      expect(merged.skipped).toEqual([...(first.skipped ?? []), ...(second.skipped ?? [])])
      expect(merged.variants).toEqual(["zebracorn", "boundedneedle"])
      expect(merged.hitCounts.get("message:dense")).toBe(2)
      const countedMessageQueries = prepare.mock.calls
        .map(([sql]) => String(sql))
        .filter((sql) => /messages_fts/.test(sql) && /\bCOUNT\s*\(/i.test(sql))
      expect(countedMessageQueries).toEqual([])
    } finally {
      prepare.mockRestore()
    }
  })

  test("invalid FTS queries carry their phase, query and actual cause; database failure still throws", () => {
    const result = fanoutSearch(db, [""], { limit: 5 })
    expect(result.variants).toEqual([])
    expect(result.skipped).toEqual([
      expect.objectContaining({ phase: "messages", anchor: "", message: expect.stringMatching(/fts5.*syntax error/i) }),
      expect.objectContaining({
        phase: "session_content",
        anchor: "",
        message: expect.stringMatching(/fts5.*syntax error/i),
      }),
      expect.objectContaining({
        phase: "project_content",
        anchor: "",
        message: expect.stringMatching(/fts5.*syntax error/i),
      }),
    ])
    db.close()
    expect(() => fanoutSearch(db, ["needle"], { limit: 5 })).toThrow()
  })
})

describe("mergeFanouts", () => {
  test("merges coverage counts across rounds and reranks", () => {
    const db = makeDb()
    const now = Date.now()

    insertSession(db, "sess-a", "A", now)
    insertSession(db, "sess-b", "B", now)
    insertMessage(db, "sess-a", "alpha beta gamma", now)
    insertMessage(db, "sess-b", "alpha", now)

    const r1 = fanoutSearch(db, ["alpha"], { limit: 10, sinceTime: 0 })
    const r2 = fanoutSearch(db, ["beta", "gamma"], { limit: 10, sinceTime: 0 })

    const merged = mergeFanouts(r1, r2, 10)

    // Session A should lead because it's hit by variants from BOTH rounds (3 total)
    expect(merged.results[0]!.sessionId).toBe("sess-a")
    expect(merged.hitCounts.get("message:sess-a")).toBe(3)
    expect(merged.hitCounts.get("message:sess-b")).toBe(1)

    expect(merged.variants).toContain("alpha")
    expect(merged.variants).toContain("beta")
    expect(merged.variants).toContain("gamma")

    expect(merged.stats.uniqueDocs).toBeGreaterThanOrEqual(2)
  })
})
