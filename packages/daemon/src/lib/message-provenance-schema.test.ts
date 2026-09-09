/**
 * Migration v26 — message provenance, and the archive-carry bug it fixes.
 *
 * Two things are pinned here, and the second is the one that bit us:
 *
 * 1. `session_id` exists on BOTH `messages` and `messages_archive`, so a row
 *    can be traced to the connection that wrote it.
 * 2. Archiving CARRIES the columns rather than dropping them. `archiveExpiredMessages`
 *    uses explicit column lists on both sides, so a column added to `messages`
 *    and not to that statement is silently lost on archival with no error.
 *    That is exactly what happened to `attention_required` between v24 and v26:
 *    it was live on `messages` for two migrations while every archived row
 *    reverted to 0. There was no test crossing this boundary, which is why
 *    nobody noticed.
 */
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, realpathSync } from "node:fs"
import { safeRemoveSync } from "removely"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CURRENT_SCHEMA_VERSION, createStatements, openDatabase } from "./database.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) safeRemoveSync(dir, { within: realpathSync(tmpdir()), allowMissing: true })
})

function freshDb(label: string): { path: string; db: Database } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `msg-provenance-${label}-`)))
  dirs.push(dir)
  const path = join(dir, "tribe.db")
  return { path, db: openDatabase(path) }
}

function seedV30(label: string): string {
  const { path, db } = freshDb(label)
  db.close()
  const seeded = new Database(path)
  seeded.run("UPDATE _schema_meta SET value = '30' WHERE key = 'version'")
  seeded.run("ALTER TABLE messages ADD COLUMN room_id TEXT")
  seeded.run("ALTER TABLE messages_archive ADD COLUMN room_id TEXT")
  seeded.run(
    "INSERT INTO messages (id, type, sender, recipient, content, ts) VALUES ('seed-live', 'notify', '@a', '@b', 'live', 1)",
  )
  seeded.run(
    "INSERT INTO messages_archive (seq, id, type, sender, recipient, content, ts, archived_at) VALUES (2, 'seed-archive', 'notify', '@a', '@b', 'archive', 2, 3)",
  )
  seeded.close()
  return path
}

const columnsOf = (db: Database, table: string) =>
  new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name))

describe("message provenance (migration v26)", () => {
  it("accepts a peer's completed v31 upgrade before acquiring its migration lock", () => {
    const path = seedV30("overlapping-upgrade")
    // Both openers can read v30 before either takes the migration lock. Run
    // the peer at that boundary, using real SQLite and no timing-dependent race.
    const run = Database.prototype.run
    let peerCompleted = false
    const boundary = vi.spyOn(Database.prototype, "run").mockImplementation(function (this: Database, ...args) {
      if (this.filename === path && args[0] === "BEGIN IMMEDIATE" && !peerCompleted) {
        peerCompleted = true
        openDatabase(path).close()
      }
      return run.apply(this, args)
    })
    try {
      const db = openDatabase(path)
      try {
        expect(peerCompleted).toBe(true)
        expect(columnsOf(db, "messages").has("room_id")).toBe(false)
        expect(columnsOf(db, "messages_archive").has("room_id")).toBe(false)
        expect(db.prepare("SELECT value FROM _schema_meta WHERE key = 'version'").get()).toEqual({ value: "31" })
        expect(db.prepare("SELECT id, content FROM messages").all()).toEqual([{ id: "seed-live", content: "live" }])
        expect(db.prepare("SELECT id, content FROM messages_archive").all()).toEqual([
          { id: "seed-archive", content: "archive" },
        ])
      } finally {
        db.close()
      }
    } finally {
      boundary.mockRestore()
    }
  })

  it.each([
    { label: "messages", drop: "messages", surviving: "messages_archive", row: { seq: 2, id: "seed-archive" } },
    { label: "messages_archive", drop: "messages_archive", surviving: "messages", row: { rowid: 1, id: "seed-live" } },
  ])("refuses v30 upgrade when $label table is missing before stamping", ({ drop, surviving, row }) => {
    const path = seedV30(`missing-table-${drop}`)
    const seeded = new Database(path)
    seeded.run(`DROP TABLE ${drop}`)
    seeded.close()

    expect(() => openDatabase(path)).toThrow(new RegExp(`${drop} table is missing$`, "i"))
    const db = new Database(path)
    try {
      expect(db.prepare("SELECT value FROM _schema_meta WHERE key = 'version'").get()).toEqual({ value: "30" })
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(drop)).toEqual(null)
      expect(
        db.prepare(`SELECT ${surviving === "messages" ? "rowid, id" : "seq, id"} FROM ${surviving}`).get(),
      ).toEqual(row)
    } finally {
      db.close()
    }
  })

  it.each([
    { table: "messages", other: "messages_archive" },
    { table: "messages_archive", other: "messages" },
  ])("refuses v30 upgrade when $table.room_id is missing before stamping", ({ table, other }) => {
    const path = seedV30(`missing-column-${table}`)
    const seeded = new Database(path)
    seeded.run(`ALTER TABLE ${table} DROP COLUMN room_id`)
    seeded.close()

    expect(() => openDatabase(path)).toThrow(new RegExp(`${table}\\.room_id column is missing$`, "i"))
    const db = new Database(path)
    try {
      expect(db.prepare("SELECT value FROM _schema_meta WHERE key = 'version'").get()).toEqual({ value: "30" })
      expect(columnsOf(db, table).has("room_id")).toBe(false)
      expect(columnsOf(db, other).has("room_id")).toBe(true)
      expect(db.prepare("SELECT id, content FROM messages").all()).toEqual([{ id: "seed-live", content: "live" }])
      expect(db.prepare("SELECT id, content FROM messages_archive").all()).toEqual([
        { id: "seed-archive", content: "archive" },
      ])
    } finally {
      db.close()
    }
  })

  it("refuses v30 upgrade when both message tables are missing before stamping", () => {
    const path = seedV30("missing-both-tables")
    const seeded = new Database(path)
    seeded.run("DROP TABLE messages")
    seeded.run("DROP TABLE messages_archive")
    seeded.close()
    expect(() => openDatabase(path)).toThrow(/messages table is missing$/i)
    const db = new Database(path)
    try {
      expect(db.prepare("SELECT value FROM _schema_meta WHERE key = 'version'").get()).toEqual({ value: "30" })
    } finally {
      db.close()
    }
  })

  it("refuses a non-empty transient archive during a fresh upgrade", () => {
    const { path, db: initial } = freshDb("fresh-archive-data")
    initial.close()
    const seeded = new Database(path)
    seeded.run("DELETE FROM _schema_meta WHERE key = 'version'")
    seeded.run("DROP TABLE messages")
    seeded.run("ALTER TABLE messages_archive ADD COLUMN room_id TEXT")
    seeded.run(
      "INSERT INTO messages_archive (seq, id, type, sender, recipient, content, ts, room_id, archived_at) VALUES (9, 'fresh-archive', 'notify', '@a', '@b', 'must keep', 9, 'room:unknown', 10)",
    )
    seeded.close()

    expect(() => openDatabase(path)).toThrow(/messages_archive\.room_id contains 1 non-null row/i)
    const db = new Database(path)
    try {
      expect(db.prepare("SELECT id, content, room_id FROM messages_archive").all()).toEqual([
        { id: "fresh-archive", content: "must keep", room_id: "room:unknown" },
      ])
    } finally {
      db.close()
    }
  })

  // A failed version write must not leave removed columns behind: the next
  // startup would otherwise see an incomplete v30 database and refuse it.
  it.each(["v30", "unversioned"] as const)("rolls back %s schema removal when its version write fails", (version) => {
    const path = seedV30(`version-write-${version}`)
    const seeded = new Database(path)
    if (version === "unversioned") {
      seeded.run("DELETE FROM _schema_meta WHERE key = 'version'")
      seeded.run("DROP TABLE messages")
    }
    seeded.run(`CREATE TRIGGER refuse_v31 BEFORE INSERT ON _schema_meta
      WHEN NEW.key = 'version' AND NEW.value = '31'
      BEGIN SELECT RAISE(ABORT, 'fixture refuses version 31'); END`)
    const beforeColumns = [...columnsOf(seeded, "messages_archive")]
    const beforeRows = seeded.prepare("SELECT * FROM messages_archive").all()
    const beforeVersion = seeded.prepare("SELECT value FROM _schema_meta WHERE key = 'version'").get()
    seeded.close()

    expect(() => openDatabase(path)).toThrow("fixture refuses version 31")
    const db = new Database(path)
    try {
      expect([...columnsOf(db, "messages_archive")]).toEqual(beforeColumns)
      expect(db.prepare("SELECT * FROM messages_archive").all()).toEqual(beforeRows)
      expect(db.prepare("SELECT value FROM _schema_meta WHERE key = 'version'").get()).toEqual(beforeVersion)
      if (version === "v30") expect(columnsOf(db, "messages").has("room_id")).toBe(true)
    } finally {
      db.close()
    }
  })

  it("puts session_id on both the live table and the archive", () => {
    const { db } = freshDb("cols")
    try {
      expect(columnsOf(db, "messages").has("session_id")).toBe(true)
      expect(columnsOf(db, "messages_archive").has("session_id")).toBe(true)
      // v24 added this to `messages` only; the archive half was missing until v26.
      expect(columnsOf(db, "messages_archive").has("attention_required")).toBe(true)
      expect(columnsOf(db, "messages").has("room_id")).toBe(false)
      expect(columnsOf(db, "messages_archive").has("room_id")).toBe(false)
      expect(db.prepare("SELECT value FROM _schema_meta WHERE key='version'").get()).toEqual({
        value: String(CURRENT_SCHEMA_VERSION),
      })
    } finally {
      db.close()
    }
  })

  it.each([
    {
      table: "messages",
      id: "hot",
      sql: "INSERT INTO messages (id, type, sender, recipient, content, ts, room_id) VALUES ('hot', 'request', '@a', '@b', 'hot', 1, 'room:legacy')",
    },
    {
      table: "messages_archive",
      id: "arch",
      sql: "INSERT INTO messages_archive (seq, id, type, sender, recipient, content, ts, room_id, archived_at) VALUES (7, 'arch', 'request', '@a', '@b', 'arch', 1, 'room:legacy', 2)",
    },
  ])("refuses a legacy room_id value in $table before changing either table", ({ table, id, sql }) => {
    const { path, db: initial } = freshDb("refuse")
    initial.close()
    const seeded = new Database(path)
    seeded.run("UPDATE _schema_meta SET value = '30' WHERE key = 'version'")
    seeded.run("ALTER TABLE messages ADD COLUMN room_id TEXT")
    seeded.run("ALTER TABLE messages_archive ADD COLUMN room_id TEXT")
    seeded.run("CREATE INDEX idx_messages_room_ts ON messages(room_id, ts)")
    seeded.run(sql)
    seeded.close()

    let failure: unknown
    try {
      openDatabase(path)
    } catch (error) {
      failure = error
    }
    expect(String(failure)).toContain(path)
    expect(String(failure)).toContain(`${table}.room_id contains 1`)
    const db = new Database(path)
    try {
      expect(columnsOf(db, "messages").has("room_id")).toBe(true)
      expect(columnsOf(db, "messages_archive").has("room_id")).toBe(true)
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_room_ts'").get(),
      ).toEqual({ name: "idx_messages_room_ts" })
      expect(db.prepare("SELECT value FROM _schema_meta WHERE key = 'version'").get()).toEqual({ value: "30" })
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`).get(id)).toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })

  it("migrates null room ids while preserving journal, cursor, pending, and room rows", () => {
    const { path, db: initial } = freshDb("migrate")
    initial.close()
    const seeded = new Database(path)
    seeded.run("UPDATE _schema_meta SET value = '30' WHERE key = 'version'")
    seeded.run("ALTER TABLE messages ADD COLUMN room_id TEXT")
    seeded.run("ALTER TABLE messages_archive ADD COLUMN room_id TEXT")
    seeded.run("CREATE INDEX idx_messages_room_ts ON messages(room_id, ts)")
    seeded.run(
      "INSERT INTO messages (rowid, id, type, sender, recipient, content, ts) VALUES (41, 'hot', 'request', '@a', '@b', 'hot', 1)",
    )
    seeded.run(
      "INSERT INTO messages_archive (seq, id, type, sender, recipient, content, ts, archived_at) VALUES (42, 'arch', 'request', '@a', '@b', 'arch', 1, 2)",
    )
    seeded.run(
      "INSERT INTO sessions (id, name, role, pid, started_at, updated_at, last_delivered_seq, last_inbox_pull_seq) VALUES ('s', '@b', 'member', 1, 1, 1, 37, 38)",
    )
    seeded.run("INSERT INTO rooms (id, name, created_at) VALUES ('room:legacy', 'legacy', 1)")
    seeded.run("INSERT INTO room_members (room_id, session_id, joined_at) VALUES ('room:legacy', 's', 1)")
    seeded.run(
      "INSERT INTO pending_request (request_id, recipient, sender, opened_at, message_id) VALUES ('req', '@b', '@a', 1, 'hot')",
    )
    seeded.close()

    const db = openDatabase(path)
    try {
      expect(columnsOf(db, "messages").has("room_id")).toBe(false)
      expect(columnsOf(db, "messages_archive").has("room_id")).toBe(false)
      expect(db.prepare("SELECT rowid, id, content FROM messages").get()).toEqual({
        rowid: 41,
        id: "hot",
        content: "hot",
      })
      expect(db.prepare("SELECT seq, id, content FROM messages_archive").get()).toEqual({
        seq: 42,
        id: "arch",
        content: "arch",
      })
      expect(db.prepare("SELECT last_delivered_seq, last_inbox_pull_seq FROM sessions WHERE id = 's'").get()).toEqual({
        last_delivered_seq: 37,
        last_inbox_pull_seq: 38,
      })
      expect(db.prepare("SELECT COUNT(*) AS n FROM pending_request").get()).toEqual({ n: 1 })
      expect(db.prepare("SELECT id, project_id, name, created_at, creator_id, metadata FROM rooms").all()).toEqual([
        { id: "room:legacy", project_id: null, name: "legacy", created_at: 1, creator_id: null, metadata: null },
      ])
      expect(db.prepare("SELECT room_id, session_id, joined_at, role FROM room_members").all()).toEqual([
        { room_id: "room:legacy", session_id: "s", joined_at: 1, role: "member" },
      ])
      expect(db.prepare("SELECT value FROM _schema_meta WHERE key = 'version'").get()).toEqual({ value: "31" })
    } finally {
      db.close()
    }
  })

  it("carries session_id and attention_required across archival instead of dropping them", () => {
    const { db } = freshDb("archive")
    try {
      const stmts = createStatements(db)
      const old = Date.now() - 30 * 24 * 60 * 60 * 1000
      stmts.insertMessage.run({
        $id: "msg-old",
        $type: "request",
        $sender: "@chief",
        $recipient: "@dev/1",
        $kind: "direct",
        $content: "please do the thing",
        $bead_id: null,
        $ref: null,
        $ts: old,
        $delivery: "push",
        $topic: null,
        $request: "msg-old",
        $reply: null,
        $correlated_reply_requester: null,
        $summary: null,
        $session_id: "sess-chief-42",
        $attention_required: 1,
      })

      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
      stmts.archiveExpiredMessages.run({ $cutoff: cutoff, $archived_at: Date.now() })
      stmts.deleteExpiredMessages.run({ $cutoff: cutoff })

      expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE id='msg-old'").get()).toEqual({ n: 0 })
      // The whole point: both values survive the move. Before v26 the archived
      // row read back attention_required = 0, silently.
      expect(
        db.prepare("SELECT session_id, attention_required FROM messages_archive WHERE id='msg-old'").get(),
      ).toEqual({ session_id: "sess-chief-42", attention_required: 1 })
    } finally {
      db.close()
    }
  })
})
