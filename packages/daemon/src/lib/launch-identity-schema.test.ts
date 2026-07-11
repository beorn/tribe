/**
 * 21049 — launch-scoped MCP fan-in schema compatibility.
 *
 * A daemon upgrade must add launch identity to an existing v18 sessions
 * table without losing the durable member row used for reconnect adoption.
 */

import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { openDatabase } from "./database.ts"

describe("session launch identity schema (migration v19)", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-launch-schema-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("adds launch identity to a v18 database without losing the member row", () => {
    const dbPath = join(tmpDir, "tribe.db")
    const seedDb = new Database(dbPath, { create: true })
    seedDb.run("CREATE TABLE _schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    seedDb.run("INSERT INTO _schema_meta (key, value) VALUES ('version', '18')")
    seedDb.run(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      domains TEXT NOT NULL DEFAULT '[]',
      pid INTEGER NOT NULL,
      cwd TEXT,
      project_id TEXT,
      claude_session_id TEXT,
      claude_session_name TEXT,
      identity_token TEXT,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_delivered_ts INTEGER,
      last_delivered_seq INTEGER NOT NULL DEFAULT 0,
      last_inbox_pull_seq INTEGER NOT NULL DEFAULT 0,
      filter_mode TEXT NOT NULL DEFAULT 'normal',
      filter_until INTEGER,
      filter_mute TEXT,
      delivery TEXT NOT NULL DEFAULT 'push',
      account TEXT,
      provider TEXT
    )`)
    seedDb.run(`INSERT INTO sessions
      (id, name, role, domains, pid, cwd, started_at, updated_at)
      VALUES ('member-a', '@agent/4', 'agent', '["ag"]', 1234, '/tmp/hh', 10, 20)`)
    seedDb.close()

    const db = openDatabase(dbPath)
    try {
      const columns = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      )
      expect(columns).toEqual(expect.arrayContaining(["launch_id", "launch_parent_pid"]))
      expect(db.prepare("SELECT id, name FROM sessions").get()).toEqual({ id: "member-a", name: "@agent/4" })
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_launch_identity'").get(),
      ).toEqual({ name: "idx_sessions_launch_identity" })
      expect(db.prepare("SELECT value FROM _schema_meta WHERE key='version'").get()).toEqual({ value: "19" })
    } finally {
      db.close()
    }
  })
})
