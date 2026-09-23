/* oxlint-disable typescript/no-deprecated */
/**
 * Database schema, migrations, initialization, and path constants.
 */

import { Database } from "bun:sqlite"
import * as path from "path"
import * as os from "os"

export const CLAUDE_DIR = path.join(os.homedir(), ".claude")
export const DB_PATH = process.env.RECALL_DB_PATH?.trim() || path.join(CLAUDE_DIR, "session-index.db")
export const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects")
export const PLANS_DIR = path.join(CLAUDE_DIR, "plans")
export const TODOS_DIR = path.join(CLAUDE_DIR, "todos")
export const MAX_CONTENT_SIZE = 1024 * 1024 // 1MB - store content for files smaller than this

// Schema includes:
// 1. Original writes table (backwards compatible)
// 2. New sessions table for session metadata
// 3. New messages table for all message types
// 4. FTS5 virtual table for fast full-text search
export const SCHEMA = `
-- Original writes table (backwards compatible)
CREATE TABLE IF NOT EXISTS writes (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  session_file TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_size INTEGER NOT NULL,
  content TEXT
);

CREATE INDEX IF NOT EXISTS idx_writes_path ON writes(file_path);
CREATE INDEX IF NOT EXISTS idx_writes_timestamp ON writes(timestamp);
CREATE INDEX IF NOT EXISTS idx_writes_session ON writes(session_id);
CREATE INDEX IF NOT EXISTS idx_writes_hash ON writes(content_hash);

-- Session metadata
CREATE TABLE IF NOT EXISTS sessions (
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

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);

-- All messages (user, assistant, tool_use, tool_result, etc.)
CREATE TABLE IF NOT EXISTS messages (
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

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_tool ON messages(tool_name);
CREATE INDEX IF NOT EXISTS idx_messages_uuid ON messages(uuid);

-- FTS5 virtual table for fast full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  tool_name,
  file_paths,
  content='messages',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content, tool_name, file_paths)
  VALUES (new.id, new.content, new.tool_name, new.file_paths);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content, tool_name, file_paths)
  VALUES ('delete', old.id, old.content, old.tool_name, old.file_paths);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content, tool_name, file_paths)
  VALUES ('delete', old.id, old.content, old.tool_name, old.file_paths);
  INSERT INTO messages_fts(rowid, content, tool_name, file_paths)
  VALUES (new.id, new.content, new.tool_name, new.file_paths);
END;

-- Metadata table
CREATE TABLE IF NOT EXISTS index_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Unified content table for searching everything
CREATE TABLE IF NOT EXISTS content (
  id INTEGER PRIMARY KEY,
  content_type TEXT NOT NULL,  -- message, plan, summary, todo
  source_id TEXT NOT NULL,     -- session_id, plan filename, todo filename
  project_path TEXT,
  title TEXT,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_content_type ON content(content_type);
CREATE INDEX IF NOT EXISTS idx_content_source ON content(source_id);
CREATE INDEX IF NOT EXISTS idx_content_project ON content(project_path);
CREATE INDEX IF NOT EXISTS idx_content_timestamp ON content(timestamp);

-- Unified FTS5 for searching all content
CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(
  title,
  content,
  content='content',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Triggers for content FTS
CREATE TRIGGER IF NOT EXISTS content_ai AFTER INSERT ON content BEGIN
  INSERT INTO content_fts(rowid, title, content)
  VALUES (new.id, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS content_ad AFTER DELETE ON content BEGIN
  INSERT INTO content_fts(content_fts, rowid, title, content)
  VALUES ('delete', old.id, old.title, old.content);
END;

-- Unique index for upsert support on content table
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_type_source ON content(content_type, source_id);
-- Update trigger for content FTS (needed for upsert)
CREATE TRIGGER IF NOT EXISTS content_au AFTER UPDATE ON content BEGIN
  INSERT INTO content_fts(content_fts, rowid, title, content)
  VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO content_fts(rowid, title, content)
  VALUES (new.id, new.title, new.content);
END;
`

export interface MigrationStep {
  version: number
  name: string
  up: (db: Database) => void
}

export const MIGRATION_STEPS: MigrationStep[] = [
  {
    version: 1,
    name: "baseline-columns-and-indexes",
    up: (db: Database) => {
      const getColumns = (table: string): Set<string> => {
        const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
        return new Set(rows.map((r) => r.name))
      }

      const sessionCols = getColumns("sessions")
      if (sessionCols.size > 0) {
        if (!sessionCols.has("title")) db.exec("ALTER TABLE sessions ADD COLUMN title TEXT")
        if (!sessionCols.has("status")) db.exec("ALTER TABLE sessions ADD COLUMN status TEXT")
        if (!sessionCols.has("size_bytes")) db.exec("ALTER TABLE sessions ADD COLUMN size_bytes INTEGER")
        if (!sessionCols.has("mtime_ms")) db.exec("ALTER TABLE sessions ADD COLUMN mtime_ms REAL")
        if (!sessionCols.has("last_event_at_ms")) db.exec("ALTER TABLE sessions ADD COLUMN last_event_at_ms REAL")
        if (!sessionCols.has("failure_reason")) db.exec("ALTER TABLE sessions ADD COLUMN failure_reason TEXT")
        if (!sessionCols.has("failure_time")) db.exec("ALTER TABLE sessions ADD COLUMN failure_time INTEGER")
        if (!sessionCols.has("shrink_old_count")) db.exec("ALTER TABLE sessions ADD COLUMN shrink_old_count INTEGER")
        if (!sessionCols.has("shrink_new_count")) db.exec("ALTER TABLE sessions ADD COLUMN shrink_new_count INTEGER")
        if (!sessionCols.has("parent_session_id")) db.exec("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT")
        if (!sessionCols.has("agent_id")) db.exec("ALTER TABLE sessions ADD COLUMN agent_id TEXT")
      }

      const messageCols = getColumns("messages")
      if (messageCols.size > 0) {
        if (!messageCols.has("duplicate_of")) db.exec("ALTER TABLE messages ADD COLUMN duplicate_of INTEGER")
        if (!messageCols.has("line")) db.exec("ALTER TABLE messages ADD COLUMN line INTEGER")
      }

      db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)")
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_content_type_source ON content(content_type, source_id)")
      db.exec(`CREATE TRIGGER IF NOT EXISTS content_au AFTER UPDATE ON content BEGIN
        INSERT INTO content_fts(content_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
        INSERT INTO content_fts(rowid, title, content)
        VALUES (new.id, new.title, new.content);
      END`)
    },
  },
  {
    version: 2,
    name: "subagent-clobber-cleanup",
    up: (db: Database) => {
      const clobbered = db
        .prepare("SELECT id FROM sessions WHERE jsonl_path LIKE '%/subagents/%' AND agent_id IS NULL")
        .all() as { id: string }[]
      if (clobbered.length > 0) {
        const ids = clobbered.map((s) => s.id)
        const placeholders = ids.map(() => "?").join(",")
        const msgDel = db.prepare(`DELETE FROM messages WHERE session_id IN (${placeholders})`).run(...ids)
        const wrDel = db.prepare(`DELETE FROM writes WHERE session_id IN (${placeholders})`).run(...ids)
        const sessDel = db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids)
        console.log(
          `[migration] Cleaned ${sessDel.changes} clobbered subagent session(s), ${msgDel.changes} message(s), ${wrDel.changes} write(s); will re-index cleanly.`,
        )
      }
    },
  },
  {
    version: 3,
    name: "message-uuid-scoping-and-dedup",
    up: (db: Database) => {
      // 1. Check if messages table has old uuid UNIQUE constraint (single-column unique on uuid)
      let needsTableRecreation = false
      const indexList = db.prepare("PRAGMA index_list('messages')").all() as Array<{
        name: string
        unique: number
      }>
      for (const idx of indexList) {
        if (idx.unique) {
          const cols = db.prepare(`PRAGMA index_info('${idx.name}')`).all() as Array<{ name: string }>
          if (cols.length === 1 && cols[0]?.name === "uuid") {
            needsTableRecreation = true
            break
          }
        }
      }

      if (needsTableRecreation) {
        db.exec(`
          DROP TRIGGER IF EXISTS messages_ai;
          DROP TRIGGER IF EXISTS messages_ad;
          DROP TRIGGER IF EXISTS messages_au;
          CREATE TABLE messages_new (
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
          INSERT OR IGNORE INTO messages_new (id, uuid, session_id, type, content, tool_name, file_paths, timestamp, duplicate_of, line)
          SELECT id, uuid, session_id, type, content, tool_name, file_paths, timestamp, duplicate_of, line
          FROM messages;
          DROP TABLE messages;
          ALTER TABLE messages_new RENAME TO messages;
          CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
          CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
          CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
          CREATE INDEX IF NOT EXISTS idx_messages_tool ON messages(tool_name);
          CREATE INDEX IF NOT EXISTS idx_messages_uuid ON messages(uuid);

          CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, content, tool_name, file_paths)
            VALUES (new.id, new.content, new.tool_name, new.file_paths);
          END;
          CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content, tool_name, file_paths)
            VALUES ('delete', old.id, old.content, old.tool_name, old.file_paths);
          END;
          CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content, tool_name, file_paths)
            VALUES ('delete', old.id, old.content, old.tool_name, old.file_paths);
            INSERT INTO messages_fts(rowid, content, tool_name, file_paths)
            VALUES (new.id, new.content, new.tool_name, new.file_paths);
          END;
        `)
      } else {
        db.exec("CREATE INDEX IF NOT EXISTS idx_messages_uuid ON messages(uuid)")
      }

      // 2. Convert colon uuid rows: set codex rows to NULL, convert garage sessionId:uuid rows back to raw uuid
      let garageConvertedCount = 0
      let codexConvertedCount = 0
      const unconvertibleRowIds: number[] = []

      // Direct SQL update for codex rows avoids loading millions of rows into JavaScript heap
      const codexCountRes = db.prepare("SELECT COUNT(*) as c FROM messages WHERE uuid LIKE 'codex:%'").get() as {
        c: number
      }
      if (codexCountRes.c > 0) {
        db.exec("UPDATE messages SET uuid = NULL WHERE uuid LIKE 'codex:%'")
        codexConvertedCount = codexCountRes.c
      }

      // Remaining colon rows are garage sessionId:uuid rows
      const garageRows = db.prepare("SELECT id, session_id, uuid FROM messages WHERE uuid LIKE '%:%'").all() as Array<{
        id: number
        session_id: string
        uuid: string
      }>

      if (garageRows.length > 0) {
        const updateStmt = db.prepare("UPDATE OR IGNORE messages SET uuid = ? WHERE id = ?")
        for (const row of garageRows) {
          const rawUuid = row.uuid.slice(row.uuid.lastIndexOf(":") + 1)
          const res = updateStmt.run(rawUuid, row.id)
          if (res.changes > 0) {
            garageConvertedCount++
          } else {
            unconvertibleRowIds.push(row.id)
          }
        }
      }

      // 3. Clear stale-unreadable status of sessions whose recorded error was uuid UNIQUE
      const result = db
        .prepare(
          `UPDATE sessions
           SET status = NULL, failure_reason = NULL, failure_time = NULL
           WHERE status = 'stale-unreadable'
             AND failure_reason = 'UNIQUE constraint failed: messages.uuid'`,
        )
        .run()
      const clearedCount = result.changes

      if (garageConvertedCount > 0 || codexConvertedCount > 0 || clearedCount > 0 || unconvertibleRowIds.length > 0) {
        const parts: string[] = []
        if (garageConvertedCount > 0 || unconvertibleRowIds.length > 0) {
          parts.push(`Converted ${garageConvertedCount} garage sessionId:uuid row(s) back to raw uuid`)
        }
        if (codexConvertedCount > 0) {
          parts.push(`reset ${codexConvertedCount} legacy codex row(s) to NULL uuid`)
        }
        if (clearedCount > 0) {
          parts.push(`cleared ${clearedCount} stale-unreadable session(s)`)
        }
        if (unconvertibleRowIds.length > 0) {
          const sampleIds =
            unconvertibleRowIds.length > 5
              ? `${unconvertibleRowIds.slice(0, 5).join(", ")}...`
              : unconvertibleRowIds.join(", ")
          parts.push(
            `warning: ${unconvertibleRowIds.length} colliding row(s) could not be converted (id: ${sampleIds})`,
          )
        }
        console.log(`[migration] ${parts.join("; ")}.`)
      }
    },
  },
]

export const CURRENT_SCHEMA_VERSION = MIGRATION_STEPS.at(-1)?.version ?? 1

// Backward compatibility export for legacy callers
export const MIGRATIONS: string[] = MIGRATION_STEPS.map((s) => s.name)

export function runMigrations(db: Database): void {
  const initialVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
  const latestVersion = MIGRATION_STEPS.at(-1)?.version ?? 1
  if (initialVersion >= latestVersion) {
    return
  }
  for (const step of MIGRATION_STEPS) {
    if (initialVersion >= step.version) {
      continue
    }
    try {
      db.exec("BEGIN IMMEDIATE")
      const currentVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
      if (currentVersion < step.version) {
        step.up(db)
        db.exec(`PRAGMA user_version = ${step.version}`)
      }
      db.exec("COMMIT")
    } catch (err) {
      try {
        db.exec("ROLLBACK")
      } catch {
        // Ignore if transaction was already aborted/rolled back by SQLite error
      }
      throw new Error(`[migration v${step.version}] ${step.name} failed: ${(err as Error).message}`, {
        cause: err,
      })
    }
  }
}

export interface InitSchemaOptions {
  allowMigration?: boolean
}

export function initSchema(db: Database, options?: InitSchemaOptions): void {
  const versionBefore = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
  db.exec(SCHEMA)

  const latestVersion = MIGRATION_STEPS.at(-1)?.version ?? 1
  if (versionBefore > 0 && versionBefore < latestVersion) {
    if (!options?.allowMigration && process.env.RECALL_ALLOW_MIGRATE !== "1") {
      throw new Error(
        `Database schema version ${versionBefore} requires migration to ${latestVersion}. Run 'recall index --migrate' to migrate the database.`,
      )
    }
  }

  runMigrations(db)
}
