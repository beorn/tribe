/**
 * Vault FTS adapter — searches the km tree db (`.km/state.db`).
 *
 * The recall search ground truth has been the Claude Code session
 * transcript index — but the highest-signal targets in this project live in
 * the vault (beads, design docs, CLAUDE.md, README.md, hub/* docs). Those
 * are indexed by km in `nodes_fts` keyed on `(name, title, content)`.
 *
 * Adapter is opt-in and explicit: the vault database is bound on the call
 * line (`--vault-db <path>`, via {@link bindVaultDb}) and nowhere else; no
 * environment variable binds it (25149 row 35). Recall never discovers a
 * vault from the cwd: a walk up could reach a real vault a caller never named,
 * or a stale copy (25149, @cto ruling Q1). With nothing bound, search and the
 * injection say so. Vault matches get a typed pointer (path + title + snippet)
 * so the inject path can render a high-signal hint instead of lexical noise
 * from message FTS.
 */

import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { ftsPhrase, toFts5Query } from "./db-queries.ts"
import { resolveVaultDbFlag } from "../lib/vault-db.ts"

let cachedDb: Database | null = null
let cachedPath: string | null = null
let boundVaultDb: string | null = null

/**
 * Bind the vault database from the call line (`--vault-db`), its only binding.
 * The path passes the one {@link resolveVaultDbFlag} rule: an
 * empty path (what a failed `$(…)` substitution passes) or a missing file
 * refuses, rather than reading as "unbound" and hiding that failure.
 */
export function bindVaultDb(path: string): void {
  const bound = resolveVaultDbFlag(path)
  if (bound === boundVaultDb) return
  resetVaultDbCache()
  boundVaultDb = bound
}

/**
 * The vault database at `path`, opened read-only and kept while the same path is asked for. recall() and the vault
 * anchor name their vault on each call (RecallOptions.vaultDb, @cto 456e6e77), so a thread the binding never reached
 * still searches it.
 */
export function openVaultDb(path: string): Database {
  if (cachedDb && cachedPath === path) return cachedDb
  if (!existsSync(path)) throw vaultDbError(path, "does not exist")
  resetVaultDbCache()
  try {
    const db = new Database(path, { readonly: true })
    db.run("PRAGMA query_only = ON")
    cachedDb = db
    cachedPath = path
    return db
  } catch (error) {
    throw vaultDbError(path, `could not be opened read-only (${errorMessage(error)})`)
  }
}

/**
 * The bound vault, for the one reader outside recall() that still reads the binding: the pre-compact hook (its own
 * later change, @ag/recall/three-dark-search-paths).
 */
export function getVaultDb(): Database | null {
  return boundVaultDb === null ? null : openVaultDb(boundVaultDb)
}

/** The path `--vault-db` bound, or null: what an entry point resolves into RecallOptions.vaultDb at its boundary. */
export function getVaultDbPath(): string | null {
  return boundVaultDb
}

/**
 * Close and drop the one kept vault handle: on a rebind, and before {@link openVaultDb} opens another path.
 */
function resetVaultDbCache(): void {
  if (cachedDb) {
    try {
      cachedDb.close()
    } catch {
      // silent-fallback-allow: closing an already-invalid test handle is a no-op.
    }
  }
  cachedDb = null
  cachedPath = null
}

export interface VaultMatch {
  id: string
  fsPath: string | null
  name: string | null
  title: string | null
  snippet: string
  rank: number
}

/** How searchVault built its query: the receipt the CLI's --json and the hook's log row carry (@ag/recall/29487). */
export interface VaultQuery {
  /**
   * `all`: the rows hold every term. `any`: the terms together matched nothing, so these rows hold some of them,
   * ranked by bm25. `as-written`: the query was FTS syntax (a quoted phrase or a `-term`) and ran as the caller wrote
   * it. `none`: the query has no term once the vault's stopwords go, so nothing was searched: not "found nothing".
   */
  form: "all" | "any" | "as-written" | "none"
  /** The query's words less the vault's stopwords, in order, each searched as an exact token: no prefix, no stem. */
  terms: string[]
  /** Terms no vault node holds. */
  unmatched: string[]
  /**
   * Nodes the form that ran matched, before the window and before nodes join by source: a count far above the window
   * says a generic term swamps it (silvery matched 11,891 vault nodes, @cto 03d64a82).
   */
  matched: number
}

export interface VaultSearch extends VaultQuery {
  matches: VaultMatch[]
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

import { isStopword } from "./recall-shared.ts"
export { isStopword }

export interface PromptWord {
  token: string
  /** A capital that opens a sentence is no proper noun. */
  opensSentence: boolean
}

/**
 * The vault's tokenizer: a prompt's words, split at anything but letters, digits and `_@/.-`, edge dots, slashes and
 * dashes trimmed, so an @ref, a path or a kebab-case name stays one word. The anchor (vault-glossary.ts) and the
 * vault query read their words here.
 */
export function promptWords(prompt: string): PromptWord[] {
  const words: PromptWord[] = []
  for (const sentence of prompt.split(/[.!?]+(?:\s+|$)|\n+/u)) {
    const tokens = sentence
      .split(/[^A-Za-z0-9_@/.-]+/u)
      .map((t) => t.replace(/^[./-]+|[./-]+$/gu, ""))
      .filter((t) => t.length > 0)
    tokens.forEach((token, i) => words.push({ token, opensSentence: i === 0 }))
  }
  return words
}

/**
 * Whether a prompt token is a content word: four characters or more, not a stopword, not a bare number. The vault
 * anchor (vault-glossary.ts deriveVaultAnchor) builds its query from these when the prompt names no identifier.
 */
export function isContentWord(token: string): boolean {
  return token.length >= 4 && !isStopword(token) && !/^\d+$/.test(token)
}

/**
 * The vault query's terms: the query's words less the vault's stopwords, each once, in order. Short words stay (an
 * identifier such as `Jev`, `yrd` or a bead number is short), so the anchor's own words survive whole; the content-word
 * length cut is the anchor's, not this one's (@cto 7c3f702c).
 */
export function vaultTerms(query: string): string[] {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const { token } of promptWords(query)) {
    const key = token.toLowerCase()
    if (isStopword(token) || seen.has(key)) continue
    seen.add(key)
    terms.push(token)
  }
  return terms
}

/** A quoted phrase or a `-term` at a word's start: the caller wrote FTS syntax, and it runs as written. */
const FTS_SYNTAX = /"|(?:^|\s)-\S/u

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
 * The query is its terms (vaultTerms), each an exact token: all of them together first, and when that matches no
 * row, any of them ranked by bm25, so a question whose words no single paragraph holds still finds the nodes that
 * hold its rare words (@ag/recall/29487, @cto 7c3f702c). The receipt names the form that ran, the terms, and the terms
 * no node holds. A query in FTS syntax runs as written.
 *
 * `vaultDb` is the vault this search reads, named by the caller; null searches nothing, and the caller says so.
 */
export function searchVault(query: string, limit: number, vaultDb: string | null): VaultSearch {
  const asWritten = FTS_SYNTAX.test(query)
  const terms = asWritten ? [] : vaultTerms(query)
  const form = asWritten ? "as-written" : terms.length === 0 ? "none" : "all"
  const none: VaultSearch = { form, terms, unmatched: [], matched: 0, matches: [] }
  if (limit <= 0 || vaultDb === null) return none
  const db = openVaultDb(vaultDb)

  try {
    if (asWritten) {
      const ftsQuery = toFts5Query(query)
      return ftsQuery ? { ...none, ...matchVault(db, ftsQuery, limit) } : none
    }
    if (terms.length === 0) return none
    const phrases = terms.map(ftsPhrase)
    const all = matchVault(db, phrases.join(" "), limit)
    if (all.matched > 0) return { ...none, ...all }
    const unmatched = terms.filter((_, i) => !holds(db, phrases[i] ?? ""))
    if (terms.length === 1) return { ...none, unmatched }
    return { form: "any", terms, unmatched, ...matchVault(db, phrases.join(" OR "), limit) }
  } catch (error) {
    throw vaultDbError(vaultDb, `FTS query failed (${errorMessage(error)})`)
  }
}

/** Whether any vault node holds this FTS phrase. */
function holds(db: Database, phrase: string): boolean {
  return db.prepare("SELECT 1 FROM nodes_fts WHERE nodes_fts MATCH ? LIMIT 1").get(phrase) !== null
}

/**
 * One FTS query's matches, attributed to their nearest file-backed source, best rank per source, best first, with the
 * count of rows the query matched before its window. The count is its own statement: FTS5 refuses bm25() and snippet()
 * beside a window function, and the count reads no rank or snippet.
 */
function matchVault(db: Database, ftsQuery: string, limit: number): { matches: VaultMatch[]; matched: number } {
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
  const matches = [...bestBySource.values()].sort((a, b) => a.rank - b.rank).slice(0, limit)
  const matched =
    rows.length === 0
      ? 0
      : (db.prepare("SELECT count(*) AS n FROM nodes_fts WHERE nodes_fts MATCH ?").get(ftsQuery) as { n: number }).n
  return { matches, matched }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function vaultDbError(path: string, reason: string): Error {
  return new Error(
    `Vault index ${path} (bound by --vault-db) ${reason}. ` +
      `Run 'km sync' in the vault root to repair it, or drop the binding to disable vault search.`,
  )
}
