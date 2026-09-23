/**
 * project-sources.ts - Project source indexing (beads, memory, docs, CLAUDE.md scanning)
 */

import { statSync } from "node:fs"
import { getDb, acquireIndexWriter, getIndexMeta, setIndexMeta, DB_BUSY_TIMEOUT_MS } from "./db.ts"
import { indexProjectSources } from "./indexer.ts"
import { log } from "./recall-shared.ts"

/** Another connection holds SQLite's write lock, so this project-source refresh did not run (@ag/tribe/25071). */
export class ProjectSourcesBusyError extends Error {}

/**
 * Explicit synchronous compatibility entry; never called from the search path.
 * A project-only update retains the prior session completion time on success.
 *
 * It never waits on another connection (@ag/tribe/25071). The prompt hook calls it, and each of its writes used
 * to autocommit on its own, so under another writer every write could wait out the connection's busy timeout
 * (5 s), and the hook died past Claude Code's 30 s limit. It now takes SQLite's write lock once, up front and
 * without waiting: if another connection holds it, it throws ProjectSourcesBusyError before writing anything.
 * All its writes then run in that one transaction, so a failure rolls them back together, and readers never see
 * the blanked completion time in between. The index writer's own contention still throws IndexWriterBusyError.
 */
export function ensureProjectSourcesIndexed(): void {
  const projectRoot = process.env.CLAUDE_PROJECT_DIR
  if (!projectRoot) return

  const db = getDb()
  using _lock = acquireIndexWriter(db)
  db.run("PRAGMA busy_timeout = 0")
  try {
    db.run("BEGIN IMMEDIATE")
  } catch (error) {
    if (error instanceof Error && /database is locked|SQLITE_BUSY/.test(error.message)) {
      throw new ProjectSourcesBusyError(
        `Recall project sources skipped: another connection holds the write lock (${error.message})`,
        { cause: error },
      )
    }
    throw error
  } finally {
    db.run(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`)
  }
  try {
    refreshProjectSources(db, projectRoot)
    db.run("COMMIT")
  } catch (error) {
    db.run("ROLLBACK")
    throw error
  }
  // Keep the shared DB connection open for callers, as this API has always done.
}

function refreshProjectSources(db: ReturnType<typeof getDb>, projectRoot: string): void {
  const previousCompletion = getIndexMeta(db, "last_rebuild") ?? ""
  setIndexMeta(db, "last_rebuild", "")
  if (!statSync(projectRoot).isDirectory()) {
    throw new Error(`Recall project source is not a directory: ${projectRoot}`)
  }
  const startTime = Date.now()
  const result = indexProjectSources(db, projectRoot)
  const total =
    result.beads + result.sessionMemory + result.projectMemory + result.docs + result.claudeMd + result.research
  if (total > 0) {
    log(
      `indexed ${total} project sources (${Date.now() - startTime}ms): beads=${result.beads} memory=${result.sessionMemory} project=${result.projectMemory} docs=${result.docs} claude=${result.claudeMd} research=${result.research}`,
    )
  }
  // This did not refresh sessions: restore their original age, never a new one.
  setIndexMeta(db, "last_rebuild", previousCompletion)
}
