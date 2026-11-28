/**
 * Query-time incremental transcript refresh between scheduled index runs (#37777, #38515).
 *
 * Read changed Claude, Codex and Grok transcripts using the scheduled indexers and a shared foreground deadline.
 * The receipt records coverage gaps. The scheduled rebuild owns the global freshness watermark.
 */
import type { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as path from "node:path"
import { matchProjectGlob } from "../lib/format.ts"
import { parseThreshold, RECALL_INDEX_CADENCE } from "../lib/staleness.ts"
import { excludedTranscriptProviders, fetchCodexCatalog, indexCodexTranscripts, resolveAgBin } from "./codex-indexer.ts"
import { getIndexMeta } from "./db-queries.ts"
import { acquireIndexWriter, getSnapshotPath, IndexWriterBusyError } from "./db.ts"
import { currentProjectsDir, findSessionFiles, indexSessionFile, projectPathFromRelative } from "./indexer.ts"
import { profileRootsFromAg, claudeProjectDirs, canonicalRootPath, type ProfileRoots } from "./profile-roots.ts"

/** @cto a78c4127: the foreground share a query may spend on indexing before it must answer from what it has. */
export const QUERY_REFRESH_CAP_MS = 10_000
/** Commit work as it lands, so a cap that stops the pass keeps everything indexed before it. */
const CHUNK_FILES = 20
const PROVIDER_ACTIVITY_WINDOW_MS = parseThreshold(RECALL_INDEX_CADENCE)

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
  providerPartial?: { provider: "codex" | "grok"; reason: string }[]
}

/** One claude transcript root the query walked: the stock home, and each ag profile home (#38420). */
export interface QueryRefreshRoot {
  root: string
  readable: boolean
  reason?: string
  /** Transcripts under this root the index did not already hold. */
  newer: number
}

type QueryRefreshOptions = {
  projectRoot?: string
  session?: string
  capMs?: number
  agBin?: string
  profileRoots?: ProfileRoots
}

/**
 * Refresh changed transcripts before search, with Claude discovery narrowed by `projectRoot` when supplied.
 */
export async function refreshIndexForQuery(
  db: Database,
  options: QueryRefreshOptions = {},
): Promise<QueryRefreshReceipt> {
  const began = Date.now()
  const capMs = options.capMs ?? QUERY_REFRESH_CAP_MS
  if (db.filename === ":memory:" || getSnapshotPath() !== null) {
    return { indexed: 0, elapsedMs: Date.now() - began, notSearched: 0 }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), capMs)
  const excluded = excludedTranscriptProviders()
  const providers = (["codex", "grok"] as const).filter((provider) => !excluded.has(provider))
  const refreshProviders = async () => {
    const lastRebuild = Date.parse(getIndexMeta(db, "last_rebuild") ?? "")
    const recent = began - PROVIDER_ACTIVITY_WINDOW_MS
    const changedSince = new Date(Number.isFinite(lastRebuild) ? Math.min(lastRebuild, recent) : recent).toISOString()
    const agBin = resolveAgBin(options.agBin)
    const catalog = await fetchCodexCatalog(agBin, { changedSince, signal: controller.signal })
    return { agBin, catalog } as const
  }
  const discovery =
    providers.length > 0
      ? refreshProviders().then(
          (discovered) => ({ discovered }),
          (error: unknown) => ({ error }),
        )
      : undefined

  try {
    const claude = await refreshClaudeForQuery(db, options, began, capMs)
    if (discovery === undefined) return claude
    const partial = new Map<(typeof providers)[number], string>()
    const providerPartial = () => Array.from(partial, ([provider, reason]) => ({ provider, reason }))
    let indexed = claude.indexed
    let pendingProviders = providers
    try {
      const result = await discovery
      if (Date.now() - began >= capMs) controller.abort()
      controller.signal.throwIfAborted()
      if ("error" in result) throw result.error
      const { agBin, catalog } = result.discovered
      for (const provider of providers) {
        if (catalog.failedProviders?.includes(provider)) {
          partial.set(provider, "Ag reported unreadable transcript sources")
        }
      }
      pendingProviders = providers.filter((provider) =>
        catalog.sessions.some((session) => session.provider === provider),
      )

      using _writer = acquireIndexWriter(db)
      const heldByPath = db.prepare("SELECT id FROM sessions WHERE jsonl_path = ?")
      const heldAliases = db.prepare("SELECT id FROM sessions WHERE id >= ? AND id < ?")
      const sessions = catalog.sessions.filter((session) => {
        if (session.provider === "agy" || excluded.has(session.provider)) return false
        const nativeKey = `${session.provider}:${session.nativeId}`
        const copies =
          session.status === "ambiguous"
            ? session.copies.map((copy) => ({ path: copy.path, key: copy.key }))
            : [
                {
                  path: session.canonicalPath ?? session.copies[0]?.path,
                  key: session.key ?? session.sessionKey ?? nativeKey,
                },
              ]
        const keys = new Set(copies.map((copy) => copy.key))
        // Ambiguous keys start with nativeKey + "@". This range uses the session primary key.
        const remapped = (heldAliases.all(`${nativeKey}@`, `${nativeKey}A`) as { id: string }[]).some(
          (row) => !keys.has(row.id),
        )
        const incompleteScope = catalog.failedProviders?.includes(session.provider)
        const safe =
          !remapped &&
          copies.every((copy) => {
            if (!copy.path) return false
            const held = heldByPath.get(copy.path) as { id: string } | null
            return held ? held.id === copy.key || (!incompleteScope && held.id === nativeKey) : !incompleteScope
          })
        if (!safe && !incompleteScope) partial.set(session.provider, "a transcript copy group needs reconciliation")
        return safe
      })
      if (sessions.length > 0) {
        const requested = (session: (typeof sessions)[number]) =>
          options.session === session.nativeId ||
          options.session === session.key ||
          session.copies.some((copy) => options.session === copy.key)
        const activity = (session: (typeof sessions)[number]) =>
          session.copies.reduce((latest, copy) => Math.max(latest, copy.mtimeMs), 0)
        sessions.sort((a, b) => Number(requested(b)) - Number(requested(a)) || activity(b) - activity(a))
        const result = await indexCodexTranscripts(
          db,
          {
            agBin,
            incremental: true,
            catalog: { ...catalog, sessions, failures: [] },
            signal: controller.signal,
            onProgress: ({ sessionsProcessed }) => {
              indexed = claude.indexed + sessionsProcessed
            },
          },
          excluded,
        )
        indexed = claude.indexed + result.sessions
        if (result.errors > 0 || result.unreadable > 0) {
          for (const { provider } of sessions) {
            if (provider !== "agy") partial.set(provider, Object.keys(result.reasonCounts).join(", "))
          }
        }
      }
    } catch (error) {
      const reason = controller.signal.aborted
        ? `the refresh reached its ${capMs / 1000}s cap`
        : error instanceof Error
          ? error.message
          : String(error)
      for (const provider of pendingProviders) {
        if (!partial.has(provider)) partial.set(provider, reason)
      }
    }
    return { ...claude, indexed, providerPartial: providerPartial(), elapsedMs: Date.now() - began }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

async function refreshClaudeForQuery(
  db: Database,
  options: QueryRefreshOptions,
  began: number,
  capMs: number,
): Promise<QueryRefreshReceipt> {
  const receipt = (extra: Partial<QueryRefreshReceipt> = {}): QueryRefreshReceipt => ({
    indexed: 0,
    elapsedMs: Date.now() - began,
    notSearched: 0,
    ...extra,
  })

  const rows = db
    .prepare("SELECT jsonl_path AS p, mtime_ms AS m, size_bytes AS s FROM sessions WHERE jsonl_path IS NOT NULL")
    .all() as Array<{ p: string; m: number | null; s: number | null }>
  const known = new Map<string, { m: number | null; s: number | null }>()
  for (const row of rows) known.set(row.p, { m: row.m, s: row.s })

  // A seat launched through ag runs under a provider profile home, so the stock ~/.claude is only one root (#38420).
  // ag owns that mapping; a root it cannot name is reported, never skipped quietly.
  const profileRoots = options.profileRoots ?? (await profileRootsFromAg(options.agBin))
  // #38420: profile homes link their `projects/` at one store, so dedupe on the canonical path, never the name.
  const roots = [canonicalRootPath(currentProjectsDir()), ...claudeProjectDirs(profileRoots)].filter(
    (dir, at, all) => all.indexOf(dir) === at,
  )
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
  return { indexed, elapsedMs: Date.now() - began, notSearched: 0, roots: walked }
}

/** One stderr line for the pass, and a loud line for every transcript it left unread. */
export function reportQueryRefresh(receipt: QueryRefreshReceipt, capMs = QUERY_REFRESH_CAP_MS): void {
  if (receipt.indexed > 0) {
    process.stderr.write(`[recall] indexed ${receipt.indexed} new transcripts (${receipt.elapsedMs}ms)\n`)
  }
  for (const { provider, reason } of receipt.providerPartial ?? []) {
    process.stderr.write(
      `[recall] ${provider} transcript refresh partial (${reason}). Run recall index --incremental to refresh the full scope.\n`,
    )
  }
  if (receipt.stoppedBy === "source-missing") {
    const named = (receipt.roots ?? []).map((entry) => `${entry.root} (${entry.reason ?? "unreadable"})`).join("; ")
    process.stderr.write(
      `[recall] transcript source missing: no claude root readable (${named || currentProjectsDir()}); the Claude index was not refreshed\n`,
    )
    return
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
