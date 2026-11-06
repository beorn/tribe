/**
 * @failure a hit's duplicate_line walks every row of its session, so a first run of a search takes 13 s on the live
 *   store (D16)
 * @level l2
 * @consumer @ag/recall/three-dark-search-paths
 * @testonly none
 *
 * CTO fdd015bd, 101b77c2. Requirement: the 5 s first-run bar, with duplicate_line's answers unchanged.
 * Gap: existing tests pass on the slow plan, and none reads the plan under the live store's statistics, where
 * sqlite_stat1 has rows for the other indexes and none for a freshly built one.
 */
import { assertSingleStatement } from "@bearly/sqlite"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { closeDb, getDb } from "../../src/history/db.ts"
import { CURRENT_SCHEMA_VERSION, initSchema } from "../../src/history/db-schema.ts"
import { ftsSearchWithSnippet, insertMessage, upsertSession } from "../../src/history/db-queries.ts"

const TOKEN = "duplicatelookup"
const INDEX = "idx_messages_duplicate"

/** n distinct-uuid matches in one session at lines 1..n, then `copies` more matches marked duplicates of lines 1.. */
function seed(n: number, copies = 0): Database {
  const db = new Database(":memory:")
  db.exec("PRAGMA journal_mode = MEMORY")
  initSchema(db)
  const now = Date.now()
  upsertSession(db, "s1", "/test", "/tmp/s1.jsonl", now, now, 1, "s1")
  for (let i = 1; i <= n + copies; i++) {
    insertMessage(db, `u-${String(i)}`, "s1", "user", `${TOKEN} words`, null, null, now + i, null, i)
  }
  for (let i = 1; i <= copies; i++) {
    db.prepare("UPDATE messages SET duplicate_of = ? WHERE line = ?").run(i, n + i)
  }
  return db
}

/** The live store's statistics at v7: the planner sees no row for an index built after the last ANALYZE. */
function installLiveStatistics(db: Database): void {
  db.exec("ANALYZE")
  db.exec("DELETE FROM sqlite_stat1")
  const row = db.prepare("INSERT INTO sqlite_stat1(tbl, idx, stat) VALUES ('messages', ?, ?)")
  row.run("idx_messages_id_session_ts", "6576142 1 1 1")
  row.run("idx_messages_uuid", "6576142 2")
  row.run("idx_messages_tool", "6576142 2001")
  row.run("idx_messages_timestamp", "6576142 2")
  row.run("idx_messages_type", "6576142 2001")
  row.run("idx_messages_session", "6576142 667")
  row.run("sqlite_autoindex_messages_1", "6576142 667 1")
  db.exec("ANALYZE sqlite_schema")
}

/** The plan of the real phase B statement, taken from a real search rather than a copy of its text. */
function phaseBPlan(db: Database): string {
  const spy = vi.spyOn(db, "prepare")
  ftsSearchWithSnippet(db, TOKEN, { limit: 2 })
  const sql = spy.mock.calls.map(([text]) => String(text)).find((text) => text.includes("json_each"))
  spy.mockRestore()
  if (sql === undefined) throw new Error("no phase B statement was prepared")
  const rows = db.prepare(assertSingleStatement(`EXPLAIN QUERY PLAN ${sql}`)).all() as { detail: string }[]
  return rows.map((row) => row.detail).join("\n")
}

describe("duplicate_line lookup (CTO fdd015bd)", () => {
  test("uses the covering index under the live statistics, and walked the session without it", () => {
    const migrated = seed(6, 2)
    installLiveStatistics(migrated)
    expect(phaseBPlan(migrated)).toContain(`SEARCH d USING COVERING INDEX ${INDEX}`)
    migrated.close()

    const before = seed(6, 2)
    before.exec(assertSingleStatement(`DROP INDEX ${INDEX}`))
    installLiveStatistics(before)
    expect(phaseBPlan(before)).toContain("SEARCH d USING INDEX idx_messages_session")
    before.close()
  })

  test("answers the same with the index as without, a hit and a no-duplicate control", () => {
    const db = seed(6, 1)
    const lines = () =>
      ftsSearchWithSnippet(db, TOKEN, { limit: 10 }).results.map((hit) => [hit.line, hit.duplicate_line ?? null])
    const withIndex = lines()
    expect(withIndex).toContainEqual([1, 7])
    expect(withIndex).toContainEqual([2, null])
    db.exec(assertSingleStatement(`DROP INDEX ${INDEX}`))
    expect(lines()).toEqual(withIndex)
    db.close()
  })
})

describe("migration to v8", () => {
  let dir: string
  let saved: string | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "recall-v8-"))
    saved = process.env.RECALL_DB_PATH
    closeDb()
  })
  afterEach(() => {
    closeDb()
    if (saved === undefined) delete process.env.RECALL_DB_PATH
    else process.env.RECALL_DB_PATH = saved
    safeRemoveSync(dir, { within: tmpdir() })
  })

  test("a reader refuses a v7 file by name; a migrating open adds the partial index and keeps every row", () => {
    const file = join(dir, "v7.db")
    const db = new Database(file)
    db.exec("PRAGMA journal_mode = WAL")
    initSchema(db)
    upsertSession(db, "s1", "/p", "/tmp/s1.jsonl", 1, 2, 1, "s1")
    insertMessage(db, "u1", "s1", "user", "fixture", null, null, 1_000, null, 1)
    db.exec(assertSingleStatement(`DROP INDEX ${INDEX}`))
    db.exec("PRAGMA user_version = 7")
    const rows = db.prepare("SELECT * FROM messages").all()
    db.close()
    process.env.RECALL_DB_PATH = file

    expect(() => getDb()).toThrow(
      new RegExp(`schema version 7 requires migration to ${String(CURRENT_SCHEMA_VERSION)}`),
    )

    const migrated = getDb({ allowMigration: true })
    const index = migrated.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(INDEX) as { sql: string }
    expect(index.sql).toContain("WHERE duplicate_of IS NOT NULL")
    const columns = migrated.prepare(assertSingleStatement(`PRAGMA index_info(${INDEX})`)).all() as { name: string }[]
    expect(columns.map((column) => column.name)).toEqual(["session_id", "duplicate_of", "line"])
    expect(migrated.prepare("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION })
    expect(migrated.prepare("SELECT * FROM messages").all()).toEqual(rows)
  })
})
