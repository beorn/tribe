/**
 * Claude Session database management
 *
 * SQLite database with FTS5 for fast full-text search across Claude Code sessions.
 *
 * Barrel module: re-exports schema and queries. Owns DB lifecycle (open/close).
 */

import { Database } from "bun:sqlite"
import { tryAcquireFlock } from "@bearly/flock"
import * as path from "path"
import * as fs from "fs"
import { DB_PATH, initSchema } from "./db-schema.ts"

// Re-export constants from schema
export { CLAUDE_DIR, DB_PATH, PROJECTS_DIR, PLANS_DIR, TODOS_DIR, MAX_CONTENT_SIZE } from "./db-schema.ts"

let dbInstance: Database | null = null

function currentDbPath(): string {
  return process.env.RECALL_DB_PATH?.trim() || DB_PATH
}

export function getDb(): Database {
  if (dbInstance) return dbInstance

  const dbPath = currentDbPath()

  // Ensure .claude directory exists
  const claudeDir = path.dirname(dbPath)
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true })
  }

  dbInstance = new Database(dbPath)

  // Enable WAL mode for concurrent access (multiple Claude sessions)
  // WAL allows readers to not block writers and vice versa
  dbInstance.run("PRAGMA journal_mode = WAL")
  dbInstance.run("PRAGMA busy_timeout = 5000") // Wait 5s if locked

  initSchema(dbInstance)
  return dbInstance
}

/** Internal writer admission shared by the CLI and synchronous compatibility helper. */
export class IndexWriterBusyError extends Error {}

export function acquireIndexWriter(db: Database) {
  // SQLite's actual file identity includes RECALL_DB_PATH and symlink aliases.
  // In-memory databases cannot be shared by competing CLI processes.
  if (db.filename === ":memory:") return undefined
  const lockPath = `${fs.realpathSync(db.filename)}.rebuild.lock`
  const lock = tryAcquireFlock(lockPath, { body: JSON.stringify({ startedAt: Date.now() }) })
  if (lock !== null) return lock

  // Read diagnostic age only after the kernel proves another owner. Match
  // the host's 10m budget so reports cannot hide a stuck lifecycle/manual run.
  let owner: unknown
  try {
    owner = JSON.parse(fs.readFileSync(lockPath, "utf8"))
  } catch (error) {
    throw new Error(`Recall active index writer has unreadable start evidence: ${lockPath}`, { cause: error })
  }
  if (
    typeof owner !== "object" ||
    owner === null ||
    !("startedAt" in owner) ||
    typeof owner.startedAt !== "number" ||
    !Number.isFinite(owner.startedAt)
  ) {
    throw new Error(`Recall active index writer has invalid start evidence: ${lockPath}`)
  }
  if (Date.now() - owner.startedAt > 10 * 60_000) {
    throw new Error(
      `Recall index writer exceeded the 10m refresh budget for ${db.filename}; inspect the active run before retrying.`,
    )
  }
  throw new IndexWriterBusyError(
    `Recall index already active for ${db.filename}; this request did not rebuild the index. Retry after the active run finishes.`,
  )
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
  }
}

// Re-export schema
export { SCHEMA, MIGRATIONS, runMigrations, initSchema } from "./db-schema.ts"

// Re-export all queries
export {
  // Session operations
  upsertSession,
  updateSessionTitle,
  getSession,
  getSessionByPath,
  // Message operations
  insertMessage,
  getMessageCount,
  // Write operations
  insertWrite,
  // FTS operations
  toFts5Query,
  ftsSearch,
  ftsSearchWithSnippet,
  // Activity queries
  getActiveSessionsInWindow,
  getActivitySummary,
  // Similar query detection
  findSimilarQueries,
  // Index metadata
  setIndexMeta,
  getIndexMeta,
  // Clear tables
  clearTables,
  // Session titles
  findSessionsIndexFiles,
  readSessionTitles,
  getAllSessionTitles,
  refreshSessionTitles,
  getSessionTitle,
  // Unified content
  insertContent,
  upsertContent,
  clearContent,
  clearContentByType,
  searchAll,
  // Session context
  getSessionContext,
  // Session entries
  getAllSessionEntries,
  // File discovery
  findPlanFiles,
  findTodoFiles,
} from "./db-queries.ts"

// Re-export types
export type { MessageSearchOptions, ContentSearchOptions } from "./db-queries.ts"
