import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { CURRENT_SCHEMA_VERSION, initSchema, runMigrations } from "../../src/history/db-schema.ts"
import {
  ftsSearch,
  ftsSearchWithSnippet,
  getSession,
  insertMessage,
  upsertSession,
} from "../../src/history/db-queries.ts"
import { closeDb } from "../../src/history/db.ts"
import { rebuildIndex } from "../../src/history/indexer.ts"

describe("Change 1 Tier B1 Witness Tests (CTO Ruling 2026-09-22: B1)", () => {
  let tempDir: string
  let db: Database
  let dbPath: string
  let projectsDir: string
  let origClaudeDir: string | undefined
  let origDbPath: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "recall-b1-witness-"))
    origClaudeDir = process.env.CLAUDE_DIR
    origDbPath = process.env.RECALL_DB_PATH

    const isolatedClaude = join(tempDir, "claude")
    projectsDir = join(isolatedClaude, "projects")
    mkdirSync(projectsDir, { recursive: true })
    process.env.CLAUDE_DIR = isolatedClaude

    dbPath = join(tempDir, "test.db")
    process.env.RECALL_DB_PATH = dbPath
    db = new Database(dbPath)
    process.env.RECALL_SKIP_CODEX = "1"
  })

  afterEach(() => {
    closeDb()
    db.close()
    if (origClaudeDir !== undefined) {
      process.env.CLAUDE_DIR = origClaudeDir
    } else {
      delete process.env.CLAUDE_DIR
    }
    if (origDbPath !== undefined) {
      process.env.RECALL_DB_PATH = origDbPath
    } else {
      delete process.env.RECALL_DB_PATH
    }
    delete process.env.RECALL_SKIP_CODEX
    safeRemoveSync(tempDir, { within: tmpdir() })
  })

  // --------------------------------------------------------------------------
  // B1.1: Migration converts garage sessionId:uuid rows and clears stale-unreadable
  // --------------------------------------------------------------------------
  test("B1.1: migration v3 converts garage sessionId:uuid rows back to raw uuid and clears stale-unreadable", () => {
    // Construct old schema: version 2 with uuid TEXT UNIQUE on messages
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        project_path TEXT,
        jsonl_path TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        message_count INTEGER,
        title TEXT,
        status TEXT,
        size_bytes INTEGER,
        mtime_ms REAL,
        last_event_at_ms REAL,
        failure_reason TEXT,
        failure_time INTEGER,
        shrink_old_count INTEGER,
        shrink_new_count INTEGER,
        parent_session_id TEXT,
        agent_id TEXT
      );

      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        uuid TEXT UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        type TEXT NOT NULL,
        content TEXT,
        tool_name TEXT,
        file_paths TEXT,
        timestamp INTEGER NOT NULL,
        duplicate_of INTEGER,
        line INTEGER
      );

      CREATE VIRTUAL TABLE messages_fts USING fts5(
        content,
        tool_name,
        file_paths,
        content='messages',
        content_rowid='id'
      );

      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content, tool_name, file_paths)
        VALUES (new.id, new.content, new.tool_name, new.file_paths);
      END;

      CREATE TABLE content (
        id INTEGER PRIMARY KEY,
        content_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        project_path TEXT,
        title TEXT,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );

      PRAGMA user_version = 2;
    `)

    // Insert sessions: one normal, one stale-unreadable due to UNIQUE constraint
    upsertSession(db, "sess-garage-1", "/p1", "/p1/s1.jsonl", 100, 100, 1)
    upsertSession(db, "sess-garage-2", "/p2", "/p2/s2.jsonl", 100, 100, 1)
    upsertSession(db, "sess-parent", "/p", "/p/parent.jsonl", 100, 100, 1)
    upsertSession(db, "sess-fork", "/p", "/p/fork.jsonl", 100, 100, 1, null, {
      status: "stale-unreadable",
      failureReason: "UNIQUE constraint failed: messages.uuid",
      failureTime: 100,
      parentSessionId: "sess-parent",
    })

    // Insert garage rows where uuid has sessionId:uuid format
    db.prepare(`
      INSERT INTO messages (id, uuid, session_id, type, content, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(1, "sess-garage-1:uuid-alpha-123", "sess-garage-1", "user", "alpha message", 100)
    db.prepare(`
      INSERT INTO messages (id, uuid, session_id, type, content, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(2, "sess-garage-2:uuid-beta-456", "sess-garage-2", "user", "beta message", 200)
    db.prepare(`
      INSERT INTO messages (id, uuid, session_id, type, content, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(3, "sess-parent:uuid-shared-789", "sess-parent", "user", "shared message", 300)
    db.prepare(`
      INSERT INTO messages (id, uuid, session_id, type, content, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(4, "codex:sess-3:42", "sess-garage-1", "assistant", "codex line message", 400)

    const logs: string[] = []
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "))
    })

    try {
      // Run migrations to advance from v2 to v3
      runMigrations(db)

      const ver = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
      expect(ver).toBe(CURRENT_SCHEMA_VERSION)

      // Verified printed output
      const migrationLog = logs.find((l) => l.includes("[migration] Converted"))
      expect(migrationLog).toBeDefined()
      expect(migrationLog).toContain("4 garage sessionId:uuid row(s)")
      expect(migrationLog).toContain("cleared 1 stale-unreadable session(s)")

      // Verified rows converted back to raw uuid
      const m1 = db.prepare("SELECT uuid FROM messages WHERE id = 1").get() as { uuid: string }
      expect(m1.uuid).toBe("uuid-alpha-123")

      const m2 = db.prepare("SELECT uuid FROM messages WHERE id = 2").get() as { uuid: string }
      expect(m2.uuid).toBe("uuid-beta-456")

      const m3 = db.prepare("SELECT uuid FROM messages WHERE id = 3").get() as { uuid: string }
      expect(m3.uuid).toBe("uuid-shared-789")

      const m4 = db.prepare("SELECT uuid FROM messages WHERE id = 4").get() as { uuid: string }
      expect(m4.uuid).toBe("42")

      // Cross-session duplicate uuid can now be inserted without constraint violation!
      expect(() => {
        insertMessage(db, "uuid-shared-789", "sess-fork", "user", "shared message in fork", null, null, 350)
      }).not.toThrow()

      // Same-session duplicate uuid is rejected or updated by ON CONFLICT(session_id, uuid)
      const rowCountBefore = (db.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }).c
      insertMessage(db, "uuid-shared-789", "sess-fork", "user", "updated shared in fork", null, null, 360)
      const rowCountAfter = (db.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }).c
      expect(rowCountAfter).toBe(rowCountBefore) // updated existing row, no duplicate added

      // Stale-unreadable session status cleared
      const forkSession = getSession(db, "sess-fork")
      expect(forkSession?.status).toBeNull()
      expect(forkSession?.failure_reason).toBeNull()
    } finally {
      logSpy.mockRestore()
    }
  })

  // --------------------------------------------------------------------------
  // B1.2: Parent and fork sharing UUIDs reach complete, second run re-parses neither
  // --------------------------------------------------------------------------
  test("B1.2: parent and fork sharing UUIDs reach complete and second run re-parses neither", async () => {
    initSchema(db)

    const projDir = join(projectsDir, "proj-shared")
    mkdirSync(projDir, { recursive: true })

    const parentFile = join(projDir, "parent-session.jsonl")
    const forkFile = join(projDir, "fork-session.jsonl")

    const sharedUuid = "shared-msg-uuid-99"
    const now = Date.now()

    writeFileSync(
      parentFile,
      JSON.stringify({
        type: "user",
        sessionId: "parent-session",
        uuid: sharedUuid,
        timestamp: new Date(now - 10000).toISOString(),
        message: { content: [{ type: "text", text: "Fixing quantum state algorithm in solver.ts" }] },
      }) + "\n",
    )

    writeFileSync(
      forkFile,
      JSON.stringify({
        type: "user",
        sessionId: "fork-session",
        parentSessionId: "parent-session",
        uuid: sharedUuid,
        timestamp: new Date(now - 5000).toISOString(),
        message: { content: [{ type: "text", text: "Fixing quantum state algorithm in solver.ts" }] },
      }) +
        "\n" +
        JSON.stringify({
          type: "assistant",
          sessionId: "fork-session",
          parentSessionId: "parent-session",
          uuid: "fork-unique-msg-101",
          timestamp: new Date(now).toISOString(),
          message: { content: [{ type: "text", text: "Here is the localized fork patch for solver.ts" }] },
        }) +
        "\n",
    )

    // Run 1: Index both files
    const res1 = await rebuildIndex(db, { incremental: true })
    expect(res1.files).toBe(2)
    expect(res1.messages).toBe(3)

    // Both sessions reached complete
    const parent = getSession(db, "parent-session")
    expect(parent?.status).toBe("complete")

    const fork = getSession(db, "fork-session")
    expect(fork?.status).toBe("complete")
    expect(fork?.parent_session_id).toBe("parent-session")

    // Run 2: Incremental pass with no changes re-parses neither (claudeSkipped: 2, 0 messages)
    const res2 = await rebuildIndex(db, { incremental: true })
    expect(res2.claudeSkipped).toBe(2)
    expect(res2.messages).toBe(0)
  })

  // --------------------------------------------------------------------------
  // B1.3: Search for replayed message returns one hit naming the parent
  // --------------------------------------------------------------------------
  test("B1.3: search for replayed message collapses at query time, returning one hit naming parent", async () => {
    initSchema(db)

    const projDir = join(projectsDir, "proj-collapse")
    mkdirSync(projDir, { recursive: true })

    const parentFile = join(projDir, "session-root.jsonl")
    const forkFile = join(projDir, "session-child.jsonl")

    const sharedUuid = "shared-replayed-uuid-42"
    const now = Date.now()

    writeFileSync(
      parentFile,
      JSON.stringify({
        type: "user",
        sessionId: "session-root",
        uuid: sharedUuid,
        timestamp: new Date(now - 10000).toISOString(),
        message: { content: [{ type: "text", text: "recurrent deployment trigger anomaly detected" }] },
      }) + "\n",
    )

    writeFileSync(
      forkFile,
      JSON.stringify({
        type: "user",
        sessionId: "session-child",
        parentSessionId: "session-root",
        uuid: sharedUuid,
        timestamp: new Date(now - 5000).toISOString(),
        message: { content: [{ type: "text", text: "recurrent deployment trigger anomaly detected" }] },
      }) +
        "\n" +
        JSON.stringify({
          type: "assistant",
          sessionId: "session-child",
          parentSessionId: "session-root",
          uuid: "child-unique-uuid-99",
          timestamp: new Date(now).toISOString(),
          message: { content: [{ type: "text", text: "child investigation summary" }] },
        }) +
        "\n",
    )

    await rebuildIndex(db, { incremental: true })

    // Verify messages table has 2 rows for sharedUuid across the two sessions
    const sharedRows = db.prepare("SELECT * FROM messages WHERE uuid = ?").all(sharedUuid)
    expect(sharedRows.length).toBe(2)

    // ftsSearch for "anomaly"
    const search1 = ftsSearch(db, "anomaly")
    expect(search1.total).toBe(1)
    expect(search1.results.length).toBe(1)
    expect(search1.results[0]!.session_id).toBe("session-root")

    // ftsSearchWithSnippet for "recurrent deployment"
    const search2 = ftsSearchWithSnippet(db, "recurrent deployment")
    expect(search2.total).toBe(1)
    expect(search2.results.length).toBe(1)
    expect(search2.results[0]!.session_id).toBe("session-root")

    // Search for fork-only message returns child
    const searchChild = ftsSearchWithSnippet(db, "investigation")
    expect(searchChild.total).toBe(1)
    expect(searchChild.results[0]!.session_id).toBe("session-child")
  })

  // --------------------------------------------------------------------------
  // B1.4: 87 fork files reach complete in one run
  // --------------------------------------------------------------------------
  test("B1.4: 87 fork files sharing replayed UUIDs reach complete in one run", async () => {
    initSchema(db)

    const projDir = join(projectsDir, "proj-87")
    mkdirSync(projDir, { recursive: true })

    const parentFile = join(projDir, "parent-87.jsonl")
    const sharedUuid = "base-shared-uuid-87"
    const now = Date.now()

    writeFileSync(
      parentFile,
      JSON.stringify({
        type: "user",
        sessionId: "parent-87",
        uuid: sharedUuid,
        timestamp: new Date(now - 100000).toISOString(),
        message: { content: [{ type: "text", text: "Base parent instruction for fleet operations" }] },
      }) + "\n",
    )

    // Generate 86 subagent fork files (making 87 files total with parent)
    for (let i = 1; i <= 86; i++) {
      const subFile = join(projDir, `fork-subagent-${i}.jsonl`)
      writeFileSync(
        subFile,
        JSON.stringify({
          type: "user",
          sessionId: `fork-subagent-${i}`,
          parentSessionId: "parent-87",
          uuid: sharedUuid, // Replaying parent uuid
          timestamp: new Date(now - 100000 + i * 100).toISOString(),
          message: { content: [{ type: "text", text: "Base parent instruction for fleet operations" }] },
        }) +
          "\n" +
          JSON.stringify({
            type: "assistant",
            sessionId: `fork-subagent-${i}`,
            parentSessionId: "parent-87",
            uuid: `fork-specific-uuid-${i}`,
            timestamp: new Date(now - 100000 + i * 100 + 50).toISOString(),
            message: { content: [{ type: "text", text: `Subagent ${i} completed specific work task` }] },
          }) +
          "\n",
      )
    }

    const res = await rebuildIndex(db, { incremental: true })
    expect(res.files).toBe(87)

    // Verify all 87 sessions reached complete
    const sessions = db.prepare("SELECT id, status FROM sessions").all() as Array<{ id: string; status: string }>
    expect(sessions.length).toBe(87)
    for (const s of sessions) {
      expect(s.status).toBe("complete")
    }

    // Verify search for shared prompt returns exactly 1 hit naming parent-87
    const searchShared = ftsSearch(db, "operations")
    expect(searchShared.total).toBe(1)
    expect(searchShared.results[0]!.session_id).toBe("parent-87")

    // Second run re-parses 0 files (claudeSkipped: 87, 0 messages)
    const res2 = await rebuildIndex(db, { incremental: true })
    expect(res2.claudeSkipped).toBe(87)
    expect(res2.messages).toBe(0)
  })
})
