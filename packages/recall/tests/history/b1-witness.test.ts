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
  test("B1.1: migration v3 converts garage sessionId:uuid rows back to raw uuid, resets codex to NULL, and clears stale-unreadable", () => {
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

    // Insert garage rows where uuid has sessionId:uuid format and one legacy codex row
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
      expect(migrationLog).toContain("3 garage sessionId:uuid row(s)")
      expect(migrationLog).toContain("reset 1 legacy codex row(s) to NULL uuid")
      expect(migrationLog).toContain("cleared 1 stale-unreadable session(s)")

      // Verified rows converted back to raw uuid
      const m1 = db.prepare("SELECT uuid FROM messages WHERE id = 1").get() as { uuid: string }
      expect(m1.uuid).toBe("uuid-alpha-123")

      const m2 = db.prepare("SELECT uuid FROM messages WHERE id = 2").get() as { uuid: string }
      expect(m2.uuid).toBe("uuid-beta-456")

      const m3 = db.prepare("SELECT uuid FROM messages WHERE id = 3").get() as { uuid: string }
      expect(m3.uuid).toBe("uuid-shared-789")

      // Codex row has uuid reset to null
      const m4 = db.prepare("SELECT uuid FROM messages WHERE id = 4").get() as { uuid: string | null }
      expect(m4.uuid).toBeNull()

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
  // (Uses real <proj>/<parent>/subagents/agent-*.jsonl directory shape)
  // --------------------------------------------------------------------------
  test("B1.2: parent and fork sharing UUIDs reach complete and second run re-parses neither", async () => {
    initSchema(db)

    const projDir = join(projectsDir, "proj-shared")
    mkdirSync(projDir, { recursive: true })

    const parentFile = join(projDir, "parent-session.jsonl")
    const subagentsDir = join(projDir, "parent-session", "subagents")
    mkdirSync(subagentsDir, { recursive: true })
    const forkFile = join(subagentsDir, "agent-fork-1.jsonl")

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
        sessionId: "parent-session", // In real transcripts, subagent carries parent's sessionId
        uuid: sharedUuid,
        timestamp: new Date(now - 5000).toISOString(),
        message: { content: [{ type: "text", text: "Fixing quantum state algorithm in solver.ts" }] },
      }) +
        "\n" +
        JSON.stringify({
          type: "assistant",
          sessionId: "parent-session",
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

    const forkKey = "parent-session:agent-fork-1"
    const fork = getSession(db, forkKey)
    expect(fork?.status).toBe("complete")
    expect(fork?.parent_session_id).toBe("parent-session")
    expect(fork?.agent_id).toBe("agent-fork-1")

    // Run 2: Incremental pass with no changes re-parses neither (claudeSkipped: 2, 0 messages)
    const res2 = await rebuildIndex(db, { incremental: true })
    expect(res2.claudeSkipped).toBe(2)
    expect(res2.messages).toBe(0)
  })

  // --------------------------------------------------------------------------
  // B1.3: Search for replayed message returns one hit naming the parent
  // (Uses real <proj>/<parent>/subagents/agent-*.jsonl directory shape)
  // --------------------------------------------------------------------------
  test("B1.3: search for replayed message collapses at query time, returning one hit naming parent", async () => {
    initSchema(db)

    const projDir = join(projectsDir, "proj-collapse")
    mkdirSync(projDir, { recursive: true })

    const parentFile = join(projDir, "session-root.jsonl")
    const subagentsDir = join(projDir, "session-root", "subagents")
    mkdirSync(subagentsDir, { recursive: true })
    const forkFile = join(subagentsDir, "agent-child.jsonl")

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
        sessionId: "session-root",
        uuid: sharedUuid,
        timestamp: new Date(now - 5000).toISOString(),
        message: { content: [{ type: "text", text: "recurrent deployment trigger anomaly detected" }] },
      }) +
        "\n" +
        JSON.stringify({
          type: "assistant",
          sessionId: "session-root",
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
    expect(searchChild.results[0]!.session_id).toBe("session-root:agent-child")
  })

  // --------------------------------------------------------------------------
  // B1.4: 87 fork files reach complete in one run
  // (Uses real <proj>/<parent>/subagents/agent-*.jsonl directory shape)
  // --------------------------------------------------------------------------
  test("B1.4: 87 fork files sharing replayed UUIDs reach complete in one run", async () => {
    initSchema(db)

    const projDir = join(projectsDir, "proj-87")
    mkdirSync(projDir, { recursive: true })

    const parentFile = join(projDir, "parent-87.jsonl")
    const subagentsDir = join(projDir, "parent-87", "subagents")
    mkdirSync(subagentsDir, { recursive: true })

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
      const subFile = join(subagentsDir, `agent-fork-subagent-${i}.jsonl`)
      writeFileSync(
        subFile,
        JSON.stringify({
          type: "user",
          sessionId: "parent-87",
          uuid: sharedUuid, // Replaying parent uuid
          timestamp: new Date(now - 100000 + i * 100).toISOString(),
          message: { content: [{ type: "text", text: "Base parent instruction for fleet operations" }] },
        }) +
          "\n" +
          JSON.stringify({
            type: "assistant",
            sessionId: "parent-87",
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

  // --------------------------------------------------------------------------
  // B1.5: Item 1 Codex Search Loss Witness (Probe P1 shape)
  // --------------------------------------------------------------------------
  test("B1.5 (Item 1): Codex search loss - unrelated sessions with same line numbers are both searchable", () => {
    initSchema(db)

    upsertSession(db, "codex:A", "/p", "/codex/A.jsonl", 100, 100, 1)
    upsertSession(db, "codex:B", "/p", "/codex/B.jsonl", 200, 200, 1)
    // Codex messages store uuid = null
    insertMessage(db, null, "codex:A", "user", "alpha zebra", null, null, 100, null, 1)
    insertMessage(db, null, "codex:B", "user", "bravo zebra", null, null, 200, null, 1)

    // Searching for term unique to session B must find session B (total = 1)
    const searchBravo = ftsSearch(db, "bravo")
    expect(searchBravo.total).toBe(1)
    expect(searchBravo.results[0]!.session_id).toBe("codex:B")

    // Searching for term in both must find both sessions (total = 2)
    const searchZebra = ftsSearch(db, "zebra")
    expect(searchZebra.total).toBe(2)
    const sessions = searchZebra.results.map((r) => r.session_id).sort()
    expect(sessions).toEqual(["codex:A", "codex:B"])

    // ftsSearchWithSnippet also finds session B
    const snippetBravo = ftsSearchWithSnippet(db, "bravo")
    expect(snippetBravo.total).toBe(1)
    expect(snippetBravo.results[0]!.session_id).toBe("codex:B")
  })

  // --------------------------------------------------------------------------
  // B1.6: Item 1 & Item 2 Migration of legacy Codex rows (Probe P2 shape)
  // --------------------------------------------------------------------------
  test("B1.6 (Item 1): Migration v3 converts main-written Codex rows to NULL uuid, preserving full search", () => {
    initSchema(db)
    db.exec("PRAGMA user_version = 2")

    upsertSession(db, "codex:A", "/p", "/codex/A.jsonl", 100, 100, 1)
    upsertSession(db, "codex:B", "/p", "/codex/B.jsonl", 200, 200, 1)
    // Main's writer stored "codex:A:1" and "codex:B:1"
    insertMessage(db, "codex:A:1", "codex:A", "user", "alpha zebra", null, null, 100, null, 1)
    insertMessage(db, "codex:B:1", "codex:B", "user", "bravo zebra", null, null, 200, null, 1)

    // Run migration v3
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      runMigrations(db)
    } finally {
      logSpy.mockRestore()
    }

    const ver = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
    expect(ver).toBe(CURRENT_SCHEMA_VERSION)

    // Verify uuids converted to NULL
    const rows = db.prepare("SELECT session_id, uuid FROM messages ORDER BY id").all() as Array<{
      session_id: string
      uuid: string | null
    }>
    expect(rows[0]!.uuid).toBeNull()
    expect(rows[1]!.uuid).toBeNull()

    // Both sessions remain searchable
    const searchBravo = ftsSearch(db, "bravo")
    expect(searchBravo.total).toBe(1)
    expect(searchBravo.results[0]!.session_id).toBe("codex:B")

    const searchZebra = ftsSearch(db, "zebra")
    expect(searchZebra.total).toBe(2)
  })

  // --------------------------------------------------------------------------
  // B1.7: Item 2 Atomic Migration Runner Rollback (Probe P3 shape)
  // --------------------------------------------------------------------------
  test("B1.7 (Item 2): Migration step failure aborts and rolls back, leaving user_version unchanged", () => {
    initSchema(db)
    db.exec("PRAGMA user_version = 2")

    upsertSession(db, "sess-x", "/p", "/p/x.jsonl", 100, 100, 1)
    insertMessage(db, "sess-x:u-1", "sess-x", "user", "garage row", null, null, 100)

    // Trigger that forces update failure inside step 3
    db.exec(
      "CREATE TRIGGER probe_fail BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'probe: forced update failure'); END;",
    )

    expect(() => {
      runMigrations(db)
    }).toThrow("[migration v3] message-uuid-scoping-and-dedup failed: probe: forced update failure")

    // user_version must remain 2
    const ver = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
    expect(ver).toBe(2)

    // Row uuid must be rolled back to original un-migrated value
    const row = db.prepare("SELECT uuid FROM messages WHERE session_id = 'sess-x'").get() as { uuid: string }
    expect(row.uuid).toBe("sess-x:u-1")
  })

  // --------------------------------------------------------------------------
  // B1.8: Item 2 Migration Collision Accurate Reporting (Probe P4 shape)
  // --------------------------------------------------------------------------
  test("B1.8 (Item 2): Migration v3 reports true count on collision and names unconvertible rows", () => {
    initSchema(db)
    db.exec("PRAGMA user_version = 2")

    upsertSession(db, "sess-y", "/p", "/p/y.jsonl", 100, 100, 1)
    insertMessage(db, "u-2", "sess-y", "user", "raw row", null, null, 100)
    insertMessage(db, "sess-y:u-2", "sess-y", "user", "garage row", null, null, 101)

    const logs: string[] = []
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "))
    })

    try {
      runMigrations(db)

      const migrationLog = logs.find((l) => l.includes("[migration]"))
      expect(migrationLog).toBeDefined()
      // Must report true converted count (0), NOT 1
      expect(migrationLog).toContain("Converted 0 garage sessionId:uuid row(s)")
      // Must warn about colliding row and name its id
      expect(migrationLog).toContain("warning: 1 colliding row(s) could not be converted (id: 2)")

      // The colliding row remains with colon uuid
      const left = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE uuid LIKE '%:%'").get() as { c: number }
      expect(left.c).toBe(1)
    } finally {
      logSpy.mockRestore()
    }
  })

  // --------------------------------------------------------------------------
  // B1.9 (Chief Directive 2): Migration v3 from live index actual half-migrated state
  // (user_version 2, messages already has UNIQUE(session_id, uuid) and idx_messages_uuid,
  // main's codex:<key>:<line> uuids, and garage sessionId:uuid rows)
  // --------------------------------------------------------------------------
  test("B1.9 (Chief Directive 2): Migration v3 from live index actual half-applied state", () => {
    // Construct exact live index state as found at /home/hh/.claude/session-index.db:
    // Schema has user_version = 2, messages table has UNIQUE(session_id, uuid)
    db.exec(`
      PRAGMA user_version = 2;
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        jsonl_path TEXT UNIQUE NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        message_count INTEGER DEFAULT 0,
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
        uuid TEXT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        type TEXT NOT NULL,
        content TEXT,
        tool_name TEXT,
        file_paths TEXT,
        timestamp INTEGER NOT NULL,
        duplicate_of INTEGER,
        line INTEGER,
        UNIQUE(session_id, uuid)
      );
      CREATE INDEX idx_messages_session ON messages(session_id);
      CREATE INDEX idx_messages_type ON messages(type);
      CREATE INDEX idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX idx_messages_tool ON messages(tool_name);
      CREATE INDEX idx_messages_uuid ON messages(uuid);

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
      CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, tool_name, file_paths)
        VALUES ('delete', old.id, old.content, old.tool_name, old.file_paths);
      END;
      CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, tool_name, file_paths)
        VALUES ('delete', old.id, old.content, old.tool_name, old.file_paths);
        INSERT INTO messages_fts(rowid, content, tool_name, file_paths)
        VALUES (new.id, new.content, new.tool_name, new.file_paths);
      END;
    `)

    // Pre-populate with:
    // 1. Garage sessionId:uuid rows
    upsertSession(db, "sess-garage", "/proj", "/proj/garage.jsonl", 100, 100, 2)
    insertMessage(db, "sess-garage:raw-uuid-1", "sess-garage", "user", "garage search text", null, null, 100)
    insertMessage(db, "sess-garage:raw-uuid-2", "sess-garage", "assistant", "garage answer", null, null, 200)

    // 2. Main's codex:<key>:<line> uuids
    upsertSession(db, "codex:sess-c1", "/proj", "/proj/codex1.jsonl", 100, 100, 1)
    upsertSession(db, "codex:sess-c2", "/proj", "/proj/codex2.jsonl", 100, 100, 1)
    insertMessage(db, "codex:sess-c1:1", "codex:sess-c1", "user", "codex search text alpha", null, null, 100, null, 1)
    insertMessage(db, "codex:sess-c2:1", "codex:sess-c2", "user", "codex search text bravo", null, null, 200, null, 1)

    // 3. Stale-unreadable session with recorded UNIQUE failure
    upsertSession(db, "sess-stale", "/proj", "/proj/stale.jsonl", 100, 100, 0, null, {
      status: "stale-unreadable",
      failureReason: "UNIQUE constraint failed: messages.uuid",
      failureTime: 100,
    })

    const logs: string[] = []
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "))
    })

    try {
      // Execute migrations
      runMigrations(db)

      const ver = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
      expect(ver).toBe(CURRENT_SCHEMA_VERSION)

      // Verified garage rows converted
      const g1 = db.prepare("SELECT uuid FROM messages WHERE id = 1").get() as { uuid: string }
      expect(g1.uuid).toBe("raw-uuid-1")
      const g2 = db.prepare("SELECT uuid FROM messages WHERE id = 2").get() as { uuid: string }
      expect(g2.uuid).toBe("raw-uuid-2")

      // Verified codex rows reset to NULL uuid
      const c1 = db.prepare("SELECT uuid FROM messages WHERE id = 3").get() as { uuid: string | null }
      expect(c1.uuid).toBeNull()
      const c2 = db.prepare("SELECT uuid FROM messages WHERE id = 4").get() as { uuid: string | null }
      expect(c2.uuid).toBeNull()

      // Stale session cleared
      const staleSess = getSession(db, "sess-stale")
      expect(staleSess?.status).toBeNull()
      expect(staleSess?.failure_reason).toBeNull()

      // Both codex sessions remain searchable
      const searchAlpha = ftsSearch(db, "alpha")
      expect(searchAlpha.total).toBe(1)
      expect(searchAlpha.results[0]!.session_id).toBe("codex:sess-c1")

      const searchBravo = ftsSearch(db, "bravo")
      expect(searchBravo.total).toBe(1)
      expect(searchBravo.results[0]!.session_id).toBe("codex:sess-c2")

      // Cross-session duplicate uuid insertion works cleanly under UNIQUE(session_id, uuid)
      expect(() => {
        insertMessage(db, "raw-uuid-1", "codex:sess-c1", "user", "duplicate uuid cross session", null, null, 300)
      }).not.toThrow()
    } finally {
      logSpy.mockRestore()
    }
  })
})
