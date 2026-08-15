import { Database } from "bun:sqlite"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CURRENT_SCHEMA_VERSION, openDatabase } from "./database.ts"

describe("session self-mailbox authority schema (migration v28)", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-self-mailbox-schema-"))
  })

  afterEach(() => {
    safeRemoveSync(tmpDir, { within: realpathSync(tmpdir()), allowMissing: true })
  })

  it("adds a unique nullable authority hash without losing the member row", () => {
    const dbPath = join(tmpDir, "tribe.db")
    const seedDb = new Database(dbPath, { create: true })
    seedDb.run("CREATE TABLE _schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    seedDb.run("INSERT INTO _schema_meta (key, value) VALUES ('version', '27')")
    seedDb.run(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
      domains TEXT NOT NULL DEFAULT '[]', pid INTEGER NOT NULL, cwd TEXT,
      project_id TEXT, claude_session_id TEXT, claude_session_name TEXT,
      identity_token TEXT, launch_id TEXT, launch_parent_pid INTEGER,
      started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      last_delivered_ts INTEGER, last_delivered_seq INTEGER NOT NULL DEFAULT 0,
      last_inbox_pull_seq INTEGER NOT NULL DEFAULT 0,
      filter_mode TEXT NOT NULL DEFAULT 'normal', filter_until INTEGER,
      filter_mute TEXT, delivery TEXT NOT NULL DEFAULT 'push', account TEXT,
      provider TEXT
    )`)
    seedDb.run(`INSERT INTO sessions
      (id, name, role, domains, pid, started_at, updated_at)
      VALUES ('member-a', '@agent/4', 'agent', '["ag"]', 1234, 10, 20)`)
    seedDb.close()

    const db = openDatabase(dbPath)
    try {
      const columns = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      )
      expect(columns).toContain("mailbox_authority_hash")
      expect(db.prepare("SELECT id, name, mailbox_authority_hash FROM sessions").get()).toEqual({
        id: "member-a",
        name: "@agent/4",
        mailbox_authority_hash: null,
      })
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_mailbox_authority'").get(),
      ).toEqual({ name: "idx_sessions_mailbox_authority" })

      db.run("UPDATE sessions SET mailbox_authority_hash = 'abc' WHERE id = 'member-a'")
      expect(() =>
        db.run(`INSERT INTO sessions
          (id, name, role, domains, pid, mailbox_authority_hash, started_at, updated_at)
          VALUES ('member-b', '@agent/5', 'agent', '[]', 5678, 'abc', 30, 40)`),
      ).toThrow()
      expect(db.prepare("SELECT value FROM _schema_meta WHERE key='version'").get()).toEqual({
        value: String(CURRENT_SCHEMA_VERSION),
      })
    } finally {
      db.close()
    }
  })
})
