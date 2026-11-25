/**
 * Query-time incremental transcript index (#37777 option (a), @cto a78c4127 via @chief).
 *
 * The 4 h timer leaves a query up to four hours behind the session that asked it. Before a search, read the
 * transcripts under the queried roots that the index does not already hold, in the foreground, and stop at a cap
 * rather than delay the answer. A stop is LOUD: the caller prints how many newer transcripts were NOT searched, so a
 * short answer is never mistaken for a complete one. No timer is added, no gate, and the scheduled pass keeps its own
 * work; this only fills the gap between two passes.
 *
 * The transcript walk and the per-file skip rule are the timer's own (`findSessionFiles` + `indexSessionFile` with
 * `incremental`), so a transcript this pass skips is exactly one the next pass would also skip.
 */
import type { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as path from "node:path"
import { matchProjectGlob } from "../lib/format.ts"
import { acquireIndexWriter, getSnapshotPath, IndexWriterBusyError } from "./db.ts"
import { currentProjectsDir, findSessionFiles, indexSessionFile, projectPathFromRelative } from "./indexer.ts"
import { profileRootsFromAg, claudeProjectDirs, type ProfileRoots } from "./profile-roots.ts"

/** @cto a78c4127: the foreground share a query may spend on indexing before it must answer from what it has. */
export const QUERY_REFRESH_CAP_MS = 10_000
/** Commit work as it lands, so a cap that stops the pass keeps everything indexed before it. */
const CHUNK_FILES = 20

export type QueryRefreshStop = "cap" | "busy" | "source-missing"

export interface QueryRefreshReceipt {
  /** Transcripts read and written in this pass. */
  indexed: number
  elapsedMs: number
  /** Transcripts newer than the index that this query did NOT search. */
  notSearched: number
  stoppedBy?: QueryRefreshStop
  /** Every claude root this pass walked, with what it found, so a thin answer names the roots it read. */
  roots?: QueryRefreshRoot[]
}

/** One claude transcript root the query walked: the stock home, and each ag profile home (#38420). */
export interface QueryRefreshRoot {
  root: string
  readable: boolean
  reason?: string
  /** Transcripts under this root the index did not already hold. */
  newer: number
}

/**
 * Index the transcripts under `projectRoot` that the index does not already hold, stopping at `capMs` from entry
 * (the transcript walk counts against the cap: it is work the query pays for).
 */
export async function refreshIndexForQuery(
  db: Database,
  options: { projectRoot?: string; capMs?: number; agBin?: string; profileRoots?: ProfileRoots } = {},
): Promise<QueryRefreshReceipt> {
  const began = Date.now()
  const capMs = options.capMs ?? QUERY_REFRESH_CAP_MS
  const receipt = (extra: Partial<QueryRefreshReceipt> = {}): QueryRefreshReceipt => ({
    indexed: 0,
    elapsedMs: Date.now() - began,
    notSearched: 0,
    ...extra,
  })
  // An in-memory database holds seeded rows and cannot be shared with another process: nothing to read, nothing to guard.
  if (db.filename === ":memory:") return receipt()
  // A snapshot is an immutable file: there is nothing to refresh, and a write to it must never be attempted.
  if (getSnapshotPath() !== null) return receipt()

  const rows = db
    .prepare("SELECT jsonl_path AS p, mtime_ms AS m, size_bytes AS s FROM sessions WHERE jsonl_path IS NOT NULL")
    .all() as Array<{ p: string; m: number | null; s: number | null }>
  const known = new Map<string, { m: number | null; s: number | null }>()
  for (const row of rows) known.set(row.p, { m: row.m, s: row.s })

  // A seat launched through ag runs under a provider profile home, so the stock ~/.claude is only one root (#38420).
  // ag owns that mapping; a root it cannot name is reported, never skipped quietly.
  const profileRoots = options.profileRoots ?? (await profileRootsFromAg(options.agBin))
  const roots = [...new Set([currentProjectsDir(), ...claudeProjectDirs(profileRoots)])]
  const walked: QueryRefreshRoot[] = []
  const candidates: Array<{ file: string; stats: fs.Stats; projectsDir: string }> = []
  for (const root of roots) {
    let readable = false
    let reason: string | undefined
    try {
      readable = fs.statSync(root).isDirectory()
      if (!readable) reason = "not a directory"
    } catch (error) {
      reason = fs.existsSync(root) ? `unreadable: ${(error as Error).message}` : "missing"
    }
    const entry: QueryRefreshRoot = { root, readable, reason, newer: 0 }
    walked.push(entry)
    if (!readable) continue
    try {
      for await (const file of findSessionFiles(root)) {
        let stats: fs.Stats
        try {
          stats = fs.statSync(file)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
          throw error
        }
        const relative = path.relative(root, file)
        if (options.projectRoot !== undefined) {
          if (!matchProjectGlob(projectPathFromRelative(relative), options.projectRoot)) continue
        }
        const held = known.get(file) ?? known.get(relative)
        if (held && held.m === stats.mtime.getTime() && held.s === stats.size) continue
        entry.newer++
        candidates.push({ file, stats, projectsDir: root })
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "ENOTDIR") {
        entry.readable = false
        entry.reason = `disappeared during the walk: ${(error as Error).message}`
        continue
      }
      throw error
    }
  }
  for (const failure of profileRoots.failures) {
    walked.push({
      root: failure.provider === "*" ? "every provider root" : `${failure.provider} profile root`,
      readable: false,
      reason: failure.reason,
      newer: 0,
    })
  }
  // A machine that never ran a seat through ag genuinely has no root: answer from what the index holds, and say so.
  if (!walked.some((entry) => entry.readable)) return receipt({ stoppedBy: "source-missing", roots: walked })
  if (candidates.length === 0) return receipt({ roots: walked })
  // Oldest first, so the transcripts most likely to be behind the question are the ones a cap still reaches.
  candidates.sort((a, b) => a.stats.mtimeMs - b.stats.mtimeMs)

  let lock: ReturnType<typeof acquireIndexWriter>
  try {
    lock = acquireIndexWriter(db)
  } catch (error) {
    const busy =
      error instanceof IndexWriterBusyError ||
      /exceeded the 10m refresh budget|already active/.test(error instanceof Error ? error.message : String(error))
    if (busy) return receipt({ stoppedBy: "busy", notSearched: candidates.length, roots: walked })
    throw error
  }

  let indexed = 0
  let next = 0
  try {
    while (next < candidates.length && Date.now() - began < capMs) {
      db.run("BEGIN IMMEDIATE")
      try {
        let inChunk = 0
        while (next < candidates.length && inChunk < CHUNK_FILES && Date.now() - began < capMs) {
          const candidate = candidates[next]
          if (!candidate) break
          const result = await indexSessionFile(db, candidate.file, { incremental: true }, candidate.stats)
          if (result.messages > 0) indexed++
          next++
          inChunk++
        }
        db.run("COMMIT")
      } catch (error) {
        db.run("ROLLBACK")
        throw error
      }
    }
  } catch (error) {
    if (/SQLITE_BUSY|database is locked/.test(error instanceof Error ? error.message : String(error))) {
      return { indexed, elapsedMs: Date.now() - began, notSearched: candidates.length - next, stoppedBy: "busy" }
    }
    throw error
  } finally {
    lock?.[Symbol.dispose]?.()
  }

  const notSearched = candidates.length - next
  if (notSearched > 0) return { indexed, elapsedMs: Date.now() - began, notSearched, stoppedBy: "cap", roots: walked }
  // A whole-root sweep is the only pass that may claim the index is current; a project-filtered one does not.
  if (options.projectRoot === undefined) {
    db.prepare("INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)").run(
      "last_rebuild",
      new Date().toISOString(),
    )
  }
  return { indexed, elapsedMs: Date.now() - began, notSearched: 0, roots: walked }
}

/** One stderr line for the pass, and a loud line for every transcript it left unread. */
export function reportQueryRefresh(receipt: QueryRefreshReceipt, capMs = QUERY_REFRESH_CAP_MS): void {
  if (receipt.stoppedBy === "source-missing") {
    const named = (receipt.roots ?? []).map((entry) => `${entry.root} (${entry.reason ?? "unreadable"})`).join("; ")
    process.stderr.write(
      `[recall] transcript source missing: no claude root readable (${named || currentProjectsDir()}); the index was not refreshed\n`,
    )
    return
  }
  if (receipt.indexed > 0) {
    process.stderr.write(`[recall] indexed ${receipt.indexed} new transcripts (${receipt.elapsedMs}ms)\n`)
  }
  // Name the roots whenever this pass had something to report: it indexed, left newer transcripts unsearched, or could
  // not read a root (@cto 96afab5d). A clean, quiet pass stays quiet; a zero-hit search names them at the result.
  const worthNaming =
    receipt.indexed > 0 ||
    receipt.notSearched > 0 ||
    (receipt.roots ?? []).some((entry) => !entry.readable || entry.newer > 0)
  if (worthNaming && receipt.roots !== undefined && receipt.roots.length > 0) {
    const parts = receipt.roots.map((entry) =>
      entry.readable ? `${entry.root} (${entry.newer} newer)` : `${entry.root} [${entry.reason ?? "unreadable"}]`,
    )
    process.stderr.write(`[recall] claude roots: ${parts.join(", ")}\n`)
  }
  if (receipt.notSearched === 0) return
  const plural = receipt.notSearched === 1 ? "transcript was" : "transcripts were"
  const why =
    receipt.stoppedBy === "busy"
      ? "another index writer is active"
      : `the refresh stopped at its ${Math.round(capMs / 1000)}s cap`
  process.stderr.write(
    `[recall] ${receipt.notSearched} newer ${plural} NOT searched (${why}) — rerun to include them; this answer may be missing them\n`,
  )
}
