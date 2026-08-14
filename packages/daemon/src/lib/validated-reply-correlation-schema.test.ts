import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, realpathSync } from "node:fs"
import { safeRemoveSync } from "removely"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CURRENT_SCHEMA_VERSION, openDatabase } from "./database.ts"

const cleanupDirs: string[] = []

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) safeRemoveSync(dir, { within: realpathSync(tmpdir()), allowMissing: true })
})

describe("validated reply correlation schema (migration v25)", () => {
  it("adds the durable requester column without losing live or archived rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-reply-correlation-schema-"))
    cleanupDirs.push(dir)
    const path = join(dir, "tribe.sqlite")
    const legacy = new Database(path, { create: true })
    legacy.run("CREATE TABLE _schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    legacy.run("INSERT INTO _schema_meta VALUES ('version', '24')")
    legacy.run(`CREATE TABLE messages (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
      sender TEXT NOT NULL, recipient TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'direct',
      content TEXT NOT NULL, bead_id TEXT, ref TEXT, ts INTEGER NOT NULL,
      delivery TEXT NOT NULL DEFAULT 'push', topic TEXT, room_id TEXT,
      request TEXT, reply TEXT, summary TEXT, attention_required INTEGER NOT NULL DEFAULT 0
    )`)
    legacy.run(`CREATE TABLE messages_archive (
      seq INTEGER NOT NULL, id TEXT PRIMARY KEY, type TEXT NOT NULL, sender TEXT NOT NULL,
      recipient TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'direct', content TEXT NOT NULL,
      bead_id TEXT, ref TEXT, ts INTEGER NOT NULL, delivery TEXT NOT NULL DEFAULT 'push',
      topic TEXT, room_id TEXT, archived_at INTEGER NOT NULL, request TEXT, reply TEXT, summary TEXT
    )`)
    legacy.run(
      "INSERT INTO messages (id,type,sender,recipient,kind,content,ts) VALUES ('live','response','@b','@a','direct','live',1)",
    )
    legacy.run(
      "INSERT INTO messages_archive (seq,id,type,sender,recipient,kind,content,ts,archived_at) VALUES (1,'old','response','@b','@a','direct','old',1,2)",
    )
    legacy.close()

    const db = openDatabase(path)
    try {
      for (const table of ["messages", "messages_archive"]) {
        const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
          (row) => row.name,
        )
        expect(columns).toContain("correlated_reply_requester")
      }
      expect(db.prepare("SELECT id, correlated_reply_requester FROM messages").get()).toEqual({
        id: "live",
        correlated_reply_requester: null,
      })
      expect(db.prepare("SELECT id, correlated_reply_requester FROM messages_archive").get()).toEqual({
        id: "old",
        correlated_reply_requester: null,
      })
      expect(db.prepare("SELECT value FROM _schema_meta WHERE key='version'").get()).toEqual({ value: String(CURRENT_SCHEMA_VERSION) })
    } finally {
      db.close()
    }
  })
})
