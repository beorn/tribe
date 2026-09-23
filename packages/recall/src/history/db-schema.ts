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

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_tool ON messages(tool_name);

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

export const CURRENT_SCHEMA_VERSION = 2

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
        try {
          const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
          return new Set(rows.map((r) => r.name))
        } catch {
          return new Set()
        }
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
]

// Backward compatibility export for legacy callers
export const MIGRATIONS: string[] = []

export function runMigrations(db: Database): void {
  const currentVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
  for (const step of MIGRATION_STEPS) {
    if (currentVersion < step.version) {
      try {
        step.up(db)
        db.exec(`PRAGMA user_version = ${step.version}`)
      } catch (err) {
        throw new Error(`[migration v${step.version}] ${step.name} failed: ${(err as Error).message}`, {
          cause: err,
        })
      }
    }
  }
}

export function initSchema(db: Database): void {
  db.exec(SCHEMA)
  runMigrations(db)
}
