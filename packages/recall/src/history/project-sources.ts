/**
 * project-sources.ts - Project source indexing (beads, memory, docs, CLAUDE.md scanning)
 */

import { statSync } from "node:fs"
import { getDb, acquireIndexWriter, getIndexMeta, setIndexMeta } from "./db.ts"
import { indexProjectSources } from "./indexer.ts"
import { log } from "./recall-shared.ts"

/**
 * Explicit synchronous compatibility entry; never called from the search path.
 * A project-only update retains the prior session completion time on success.
 * Contention and failures propagate; failed writes leave provenance invalid.
 */
export function ensureProjectSourcesIndexed(): void {
  const projectRoot = process.env.CLAUDE_PROJECT_DIR
  if (!projectRoot) return

  const db = getDb()
  using lock = acquireIndexWriter(db)
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
  // Keep the shared DB connection open for callers, as this API has always done.
}
