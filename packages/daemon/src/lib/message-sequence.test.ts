/**
 * @failure  Retention empties the hot message journal and SQLite reuses an
 *           implicit rowid, stranding new mail below durable delivery/mailbox
 *           cursors and Hab's monotonic await event cursor.
 * @level    l1 - real temporary SQLite file, no daemon process or sockets.
 * @consumer @km/all/21576-seat-stall-undead-meta S2 shadow delivery cursor.
 */
import { mkdtempSync, realpathSync } from "node:fs"
import { safeRemoveSync } from "removely"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"

import { afterEach, describe, expect, test } from "vitest"

import { openDatabase } from "./database.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) safeRemoveSync(root, { within: realpathSync(tmpdir()), allowMissing: true })
})

function insertMessage(db: ReturnType<typeof openDatabase>, id: string, ts: number): number {
  db.prepare(
    `INSERT INTO messages (id, type, sender, recipient, kind, content, ts)
     VALUES (?, 'request', '@sender', '@receiver', 'direct', ?, ?)`,
  ).run(id, id, ts)
  const row = db.prepare("SELECT rowid FROM messages WHERE id = ?").get(id) as { rowid: number }
  return row.rowid
}

describe("durable message sequence", () => {
  test("never reuses a delivery cursor after retention empties the hot journal", () => {
    const root = mkdtempSync(join(tmpdir(), "tribe-message-sequence-"))
    roots.push(root)
    const db = openDatabase(join(root, "tribe.db"))
    try {
      const first = insertMessage(db, "message-a", 1)
      const retainedCursor = insertMessage(db, "message-b", 2)
      expect(retainedCursor).toBeGreaterThan(first)

      db.run("DELETE FROM messages")
      const afterRetention = insertMessage(db, "message-c", 3)

      expect(afterRetention).toBeGreaterThan(retainedCursor)
    } finally {
      db.close()
    }
  })

  test("migrates an implicit-rowid journal without changing ids or reusing its high-water mark", () => {
    const root = mkdtempSync(join(tmpdir(), "tribe-message-sequence-migrate-"))
    roots.push(root)
    const path = join(root, "tribe.db")
    const legacy = new Database(path, { create: true })
    legacy.run("CREATE TABLE _schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    legacy.run("INSERT INTO _schema_meta VALUES ('version', '21')")
    legacy.run(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'direct', content TEXT NOT NULL, bead_id TEXT, ref TEXT,
      ts INTEGER NOT NULL, delivery TEXT NOT NULL DEFAULT 'push', topic TEXT, room_id TEXT,
      request TEXT, reply TEXT, summary TEXT
    )`)
    legacy.run(
      `INSERT INTO messages (rowid, id, type, sender, recipient, kind, content, ts)
       VALUES (40, 'legacy-message', 'response', '@sender', '@receiver', 'direct', 'legacy', 1)`,
    )
    legacy.close()

    const db = openDatabase(path)
    try {
      expect(db.prepare("SELECT rowid, id, attention_required FROM messages").get()).toEqual({
        rowid: 40,
        id: "legacy-message",
        attention_required: 0,
      })
      db.run("DELETE FROM messages")
      expect(insertMessage(db, "new-message", 2)).toBeGreaterThan(40)
    } finally {
      db.close()
    }
  })

  test("recovers the sequence ceiling when retention emptied the legacy journal before migration", () => {
    const root = mkdtempSync(join(tmpdir(), "tribe-message-sequence-empty-migrate-"))
    roots.push(root)
    const path = join(root, "tribe.db")
    const legacy = new Database(path, { create: true })
    legacy.run("CREATE TABLE _schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    legacy.run("INSERT INTO _schema_meta VALUES ('version', '21')")
    legacy.run(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'direct', content TEXT NOT NULL, bead_id TEXT, ref TEXT,
      ts INTEGER NOT NULL, delivery TEXT NOT NULL DEFAULT 'push', topic TEXT, room_id TEXT,
      request TEXT, reply TEXT, summary TEXT
    )`)
    legacy.run(`CREATE TABLE messages_archive (
      seq INTEGER NOT NULL, id TEXT PRIMARY KEY, type TEXT NOT NULL, sender TEXT NOT NULL,
      recipient TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, bead_id TEXT,
      ref TEXT, ts INTEGER NOT NULL, delivery TEXT NOT NULL, topic TEXT, room_id TEXT,
      request TEXT, reply TEXT, summary TEXT
    )`)
    legacy.run(`INSERT INTO messages_archive
      (seq, id, type, sender, recipient, kind, content, ts, delivery)
      VALUES (80, 'archived-message', 'request', '@sender', '@receiver', 'direct', 'archived', 1, 'push')`)
    legacy.run(`CREATE TABLE mailbox_cursors (
      recipient TEXT PRIMARY KEY, last_actionable_seq INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    )`)
    legacy.run("INSERT INTO mailbox_cursors VALUES ('@receiver', 91, 1)")
    legacy.close()

    const db = openDatabase(path)
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 0 })
      expect(insertMessage(db, "new-message", 2)).toBeGreaterThan(91)
    } finally {
      db.close()
    }
  })
})
