/**
 * @failure `recall index --migrate` builds the v7 covering index while another index writer runs, so that writer
 *   meets SQLITE_BUSY mid-build; or v7 is missing, so corroboration's INDEXED BY fails on a migrated database
 * @level l2
 * @consumer @ag/recall/three-dark-search-paths
 * @testonly none
 *
 * CTO 441e80f5 (C4c), Chief c7828842. Requirements: (1) a migrating open takes the index-writer admission before any
 * migration step runs, and a held admission refuses it with the database left at its old version; (2) migrating a
 * version-6 database adds idx_messages_id_session_ts on (id, session_id, timestamp) and changes no row.
 * Gaps: change1-witness covers the migrate command only with no competing writer; migration-versioning checks the
 * version number, not that this index exists on a database that predates it.
 */
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { CURRENT_SCHEMA_VERSION, initSchema } from "../../src/history/db-schema.ts"
import { IndexWriterBusyError, acquireIndexWriter, closeDb, getDb } from "../../src/history/db.ts"
import { insertMessage, upsertSession } from "../../src/history/db-queries.ts"

const INDEX = "idx_messages_id_session_ts"
const version = (db: Database) => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
const hasIndex = (db: Database) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(INDEX) !== null

/** A current-schema file taken back to version 6: the v7 index dropped, as on the live database before migration. */
function versionSixFile(dir: string): string {
  const file = join(dir, "v6.db")
  const db = new Database(file)
  db.exec("PRAGMA journal_mode = WAL")
  initSchema(db)
  upsertSession(db, "s1", "/p", "/tmp/s1.jsonl", 1, 2, 1, "s1")
  insertMessage(db, "u1", "s1", "user", "covering index fixture", null, null, 1_000, null, 1)
  db.exec("DROP INDEX IF EXISTS idx_messages_id_session_ts")
  db.exec("PRAGMA user_version = 6")
  db.close()
  return file
}

describe("v7 covering index and writer admission before migration (CTO 441e80f5)", () => {
  let dir: string
  let saved: string | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "recall-migrate-admission-"))
    saved = process.env.RECALL_DB_PATH
    closeDb()
  })
  afterEach(() => {
    closeDb()
    if (saved === undefined) delete process.env.RECALL_DB_PATH
    else process.env.RECALL_DB_PATH = saved
    safeRemoveSync(dir, { within: tmpdir() })
  })

  test("a held writer admission refuses the migrating open and leaves the file at version 6", () => {
    const file = versionSixFile(dir)
    process.env.RECALL_DB_PATH = file
    const holder = new Database(file)
    try {
      using _held = acquireIndexWriter(holder)
      expect(() => getDb({ allowMigration: true })).toThrow(IndexWriterBusyError)
    } finally {
      holder.close()
    }
    const check = new Database(file, { readonly: true })
    expect(version(check)).toBe(6)
    expect(hasIndex(check)).toBe(false)
    check.close()
  })

  test("migrating version 6 adds the covering index, keeps every row, and releases the admission on close", () => {
    const file = versionSixFile(dir)
    process.env.RECALL_DB_PATH = file
    const before = new Database(file, { readonly: true })
    const rows = before.prepare("SELECT * FROM messages").all()
    before.close()

    const db = getDb({ allowMigration: true })
    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(hasIndex(db)).toBe(true)
    const columns = db.prepare("PRAGMA index_info(idx_messages_id_session_ts)").all() as { name: string }[]
    expect(columns.map((c) => c.name)).toEqual(["id", "session_id", "timestamp"])
    expect(db.prepare("SELECT * FROM messages").all()).toEqual(rows)
    closeDb()

    const next = new Database(file)
    using lock = acquireIndexWriter(next)
    expect(lock).not.toBeNull()
    next.close()
  })
})
