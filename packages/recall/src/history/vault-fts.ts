/**
 * Vault FTS adapter — searches the km tree db (`.km/state.db`).
 *
 * The recall search ground truth has been the Claude Code session
 * transcript index — but the highest-signal targets in this project live in
 * the vault (beads, design docs, CLAUDE.md, README.md, hub/* docs). Those
 * are indexed by km in `nodes_fts` keyed on `(name, title, content)`.
 *
 * Adapter is opt-in: when `KM_VAULT_DB` is set, or when `.km/state.db` is
 * found by walking up from CWD, the recall pipeline merges vault matches
 * into its result list. Vault matches get a typed pointer (path + title +
 * snippet) so the inject path can render a high-signal hint instead of
 * lexical noise from message FTS.
 */

import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { toFts5Query } from "./db-queries.ts"

let cachedDb: Database | null = null
let cachedPath: string | null = null
let resolveAttempted = false

function findVaultDb(): string | null {
  const fromEnv = process.env.KM_VAULT_DB
  if (fromEnv) {
    const configuredPath = resolve(fromEnv)
    if (!existsSync(configuredPath)) {
      throw vaultDbError(configuredPath, "does not exist")
    }
    return configuredPath
  }

  let dir = process.cwd()
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, ".km/state.db")
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export function getVaultDb(): Database | null {
  if (cachedDb) return cachedDb
  if (resolveAttempted) return null

  const path = findVaultDb()
  if (!path) {
    resolveAttempted = true
    return null
  }

  try {
    const db = new Database(path, { readonly: true })
    db.exec("PRAGMA query_only = ON")
    cachedDb = db
    cachedPath = path
    resolveAttempted = true
    return db
  } catch (error) {
    throw vaultDbError(path, `could not be opened read-only (${errorMessage(error)})`)
  }
}

export function getVaultDbPath(): string | null {
  if (!resolveAttempted) getVaultDb()
  return cachedPath
}

/**
 * Test-only: clear the module-level vault-DB resolution cache.
 *
 * `getVaultDb()` memoizes both the opened handle and the "already tried and
 * failed" state, so a single process can only ever resolve one vault. The
 * fail-closed guards need to re-run resolution against different fixtures
 * (a real read-only db, then no db at all), so they reset the cache between
 * cases. Additive hook — not part of the recall/injection API surface.
 */
export function resetVaultDbCacheForTests(): void {
  if (cachedDb) {
    try {
      cachedDb.close()
    } catch {
      // silent-fallback-allow: closing an already-invalid test handle is a no-op.
    }
  }
  cachedDb = null
  cachedPath = null
  resolveAttempted = false
}

export interface VaultMatch {
  id: string
  fsPath: string | null
  name: string | null
  title: string | null
  snippet: string
  rank: number
}

interface VaultRow {
  id: string
  parent_id: string | null
  fs_path: string | null
  name: string | null
  title: string | null
  snippet: string | null
  rank: number
}

interface VaultAncestor {
  id: string
  fs_path: string | null
  name: string | null
  title: string | null
}

// Common English / chat stopwords — words too generic to be salient
// project-vocab anchors. Kept conservative; project-specific terms (e.g.
// "test", "bead", "fix", "make") are NOT in this list since they're
// genuine signal in this codebase.
const PROBE_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "any",
  "can",
  "had",
  "was",
  "were",
  "this",
  "that",
  "with",
  "have",
  "from",
  "they",
  "what",
  "when",
  "where",
  "which",
  "while",
  "their",
  "there",
  "these",
  "those",
  "would",
  "could",
  "should",
  "about",
  "after",
  "again",
  "before",
  "being",
  "between",
  "during",
  "into",
  "just",
  "like",
  "more",
  "much",
  "only",
  "other",
  "over",
  "such",
  "than",
  "then",
  "things",
  "think",
  "very",
  "well",
  "your",
  "yours",
  "really",
  "still",
  "some",
  "also",
  "perhaps",
  "kind",
  "name",
  "now",
  "here",
  "much",
  "going",
  "doing",
  "done",
  "does",
  "did",
  "do",
  "is",
  "it",
  "of",
  "to",
  "in",
  "on",
  "at",
  "as",
  "be",
  "we",
  "i",
  "a",
  "an",
  "or",
  "if",
  "so",
  "yes",
  "no",
  "ok",
])

/**
 * Extract the salient tokens from a prompt for vault-probe purposes.
 *
 * The full-prompt FTS query AND-joins every word — a rare project term
 * like "termless" gets diluted by the dozens of common words around it.
 * For the salience probe we want OR-of-rare-tokens: any rare token that
 * resolves against the vault is itself signal.
 *
 * Returns up to `max` candidate tokens. Empty when nothing rare survives.
 */
export function extractProbeTokens(prompt: string, max = 6): string[] {
  const out = new Set<string>()
  // Split on non-word chars but keep camelCase intact via the / / lowercase
  // pass below; tokens like "createTestApp" survive as one chunk.
  const raw = prompt.split(/[^A-Za-z0-9_-]+/)
  for (const t of raw) {
    if (t.length < 4) continue
    const lower = t.toLowerCase()
    if (PROBE_STOPWORDS.has(lower)) continue
    if (/^\d+$/.test(t)) continue
    out.add(lower)
    if (out.size >= max) break
  }
  return [...out]
}

/**
 * FTS search over the vault. Returns matches biased toward titled,
 * file-backed content (beads, docs) over body-only nodes.
 *
 * Rank shape mirrors the existing message FTS — bm25 negative numbers,
 * smaller is better. Body nodes inherit source metadata from their nearest
 * ancestors, then results are boosted, sorted, and deduplicated by source.
 * This keeps nested markdown searchable without emitting opaque node IDs.
 * @i/20-search-and-memory/23189
 *
 * `mode` controls how the prompt is converted to an FTS query:
 *  - `"phrase"` (default): existing behavior — AND-join every token via
 *    toFts5Query. Best when the prompt is a tight question.
 *  - `"any-of-anchors"`: OR-join the rare tokens (extractProbeTokens).
 *    Best for salience probing — finds rare project vocab buried inside
 *    long sentences.
 */
export function searchVault(query: string, limit: number, mode: "phrase" | "any-of-anchors" = "phrase"): VaultMatch[] {
  if (limit <= 0) return []
  const db = getVaultDb()
  if (!db) return []

  let ftsQuery: string
  if (mode === "any-of-anchors") {
    const tokens = extractProbeTokens(query)
    if (tokens.length === 0) return []
    // Restrict to the `name` and `title` columns — body matches dilute
    // every prompt to a "fires" verdict. Anchor-only matching catches
    // prompts that name a real bead/path/alias and rejects prompts that
    // merely happen to share a body token with the vault.
    ftsQuery = `{name title} : (${tokens.map((t) => `${t}*`).join(" OR ")})`
  } else {
    ftsQuery = toFts5Query(query)
  }
  if (!ftsQuery) return []

  try {
    const rows = db
      .prepare(
        `SELECT n.id,
                n.parent_id,
                n.fs_path,
                n.name,
                n.title,
                snippet(nodes_fts, 3, '«', '»', '…', 24) AS snippet,
                bm25(nodes_fts, 8.0, 4.0, 1.0) AS rank
           FROM nodes_fts
           JOIN nodes n ON nodes_fts.id = n.id
          WHERE nodes_fts MATCH ?
          ORDER BY rank
          LIMIT ?`,
      )
      .all(ftsQuery, limit * 4) as VaultRow[]

    const ancestorsFor = db.prepare(
      `WITH RECURSIVE ancestors(id, parent_id, fs_path, name, title, depth, path) AS (
         SELECT id, parent_id, fs_path, name, title, 0, char(31) || id || char(31)
           FROM nodes
          WHERE id = ?
         UNION ALL
         SELECT parent.id,
                parent.parent_id,
                parent.fs_path,
                parent.name,
                parent.title,
                ancestors.depth + 1,
                ancestors.path || parent.id || char(31)
           FROM ancestors
           JOIN nodes parent ON parent.id = ancestors.parent_id
          WHERE ancestors.depth < 1000
            AND instr(ancestors.path, char(31) || parent.id || char(31)) = 0
       )
       SELECT id, fs_path, name, title
         FROM ancestors
        ORDER BY depth`,
    )

    const bestBySource = new Map<string, VaultMatch>()
    for (const r of rows) {
      const ancestors = ancestorsFor.all(r.id) as VaultAncestor[]
      const pathSource = ancestors.find((ancestor) => ancestor.fs_path !== null)
      const titleSource = ancestors.find((ancestor) => ancestor.title !== null)
      const nameSource = ancestors.find((ancestor) => ancestor.name !== null)
      const fsPath = r.fs_path ?? pathSource?.fs_path ?? null
      const title = r.title ?? titleSource?.title ?? null
      const name = r.name ?? nameSource?.name ?? null
      const sourceKey = fsPath ?? titleSource?.id ?? nameSource?.id ?? r.id
      const titleBoost = title ? 1.4 : 1.0
      const pathBoost = fsPath ? 1.2 : 1.0
      const match: VaultMatch = {
        id: r.id,
        fsPath,
        name,
        title,
        // FTS5 snippet() can return null when the matched column is empty
        // (e.g. a node titled but with no body). Fall back to title or
        // path so downstream cleanSnippet/render get a non-null string.
        snippet: r.snippet ?? title ?? fsPath ?? "",
        rank: r.rank * titleBoost * pathBoost,
      }
      const current = bestBySource.get(sourceKey)
      if (!current || match.rank < current.rank) bestBySource.set(sourceKey, match)
    }
    return [...bestBySource.values()].sort((a, b) => a.rank - b.rank).slice(0, limit)
  } catch (error) {
    throw vaultDbError(getVaultDbPath() ?? "unknown", `FTS query failed (${errorMessage(error)})`)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function vaultDbError(path: string, reason: string): Error {
  return new Error(
    `Vault index KM_VAULT_DB=${path} ${reason}. ` +
      `Run 'km sync' in the vault root to repair it, or unset KM_VAULT_DB to disable vault search.`,
  )
}
