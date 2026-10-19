/**
 * search.ts - FTS5 search logic: core search function, query building, result scoring
 */

import {
  getDb,
  closeDb,
  ftsSearchWithSnippet,
  searchAll,
  getAllSessionTitles,
  getSessionContext,
  toFts5Query,
  type MessageSearchOptions,
  type ContentSearchOptions,
  type HookMessageSearch,
} from "./db.ts"
import type { ContentType } from "./types.ts"
import { synthesizeResults } from "./synthesize.ts"
import {
  DEFAULT_SYNTHESIS_TIMEOUT_MS,
  log,
  ONE_HOUR_MS,
  ONE_DAY_MS,
  THIRTY_DAYS_MS,
  SynthesisFailure,
  rejectedQuerySkip,
} from "./recall-shared.ts"
import type {
  IndexProvenance,
  RecallOptions,
  RecallPhase,
  RecallResult,
  RecallSearchResult,
  RecallSkip,
  SynthesisDiagnostics,
} from "./recall-shared.ts"

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { Database } from "bun:sqlite"
import { assertSingleStatement } from "@bearly/sqlite"
import { searchVault, type VaultQuery } from "./vault-fts.ts"

// Re-export shared items so existing internal imports continue to work
export { setRecallLogging, log, ONE_HOUR_MS, ONE_DAY_MS, THIRTY_DAYS_MS } from "./recall-shared.ts"
export type {
  HookSearchSummary,
  IndexProvenance,
  RecallOptions,
  RecallPhase,
  RecallResult,
  RecallSearchResult,
  RecallSkip,
  SearchMode,
} from "./recall-shared.ts"
import { CLAUDE_SESSION_ID_ENV } from "tribe-wire/lib/session-identity-env"

// ============================================================================
// Time parsing
// ============================================================================

/**
 * Parse a relative time string to an absolute timestamp (ms since epoch).
 *
 * Supported formats:
 *   1h, 2h       - Hours ago
 *   1d, 7d       - Days ago
 *   1w, 2w       - Weeks ago
 *   today        - Since midnight today
 *   yesterday    - Since midnight yesterday
 *
 * Returns null for all (no lower bound), undefined if parsing fails.
 */
export function parseTimeToMs(timeStr: string): number | null | undefined {
  const now = Date.now()
  const str = timeStr.toLowerCase().trim()
  if (str === "all") return null

  // Absolute bounds must name a zone and cannot lose submillisecond precision.
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:z|[+-]\d{2}:\d{2})$/.test(str)) {
    const year = Number(str.slice(0, 4))
    const month = Number(str.slice(5, 7))
    const day = Number(str.slice(8, 10))
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    const timestamp = Date.parse(timeStr.trim())
    if (days === undefined || day < 1 || day > days || Number(str.slice(11, 13)) > 23 || !Number.isFinite(timestamp)) {
      return undefined
    }
    return timestamp
  }

  // Handle relative time formats: 1h, 2d, 3w
  const match = str.match(/^(\d+)([hdw])$/)
  if (match) {
    const amountText = match[1]
    if (amountText === undefined) return undefined
    const amount = parseInt(amountText, 10)
    const unit = match[2]
    switch (unit) {
      case "h":
        return now - amount * ONE_HOUR_MS
      case "d":
        return now - amount * ONE_DAY_MS
      case "w":
        return now - amount * 7 * ONE_DAY_MS
    }
  }

  // Handle special keywords
  switch (str) {
    case "today": {
      const midnight = new Date()
      midnight.setHours(0, 0, 0, 0)
      return midnight.getTime()
    }
    case "yesterday": {
      const midnight = new Date()
      midnight.setHours(0, 0, 0, 0)
      return midnight.getTime() - ONE_DAY_MS
    }
  }

  return undefined
}

/** Resolve the caller's indexed window using Recall's one time parser. */
export function resolveSearchWindow(
  since?: string,
  until?: string,
): { sinceTime: number | undefined; untilTime: number | undefined } {
  const sinceTime = since === undefined ? Date.now() - THIRTY_DAYS_MS : parseTimeToMs(since)
  if (sinceTime === undefined && since !== undefined) {
    throw new Error(
      `Invalid --since ${JSON.stringify(since)}; expected Nh, Nd, Nw, today, yesterday, or all; absolute inputs require an explicit zone and at most millisecond precision`,
    )
  }
  const untilTime = until === undefined ? undefined : parseTimeToMs(until)
  if (until !== undefined && (untilTime === undefined || untilTime === null)) {
    throw new Error(
      `Invalid --until ${JSON.stringify(until)}; expected Nh, Nd, Nw, today, yesterday, or an explicit-zone ISO instant with at most millisecond precision`,
    )
  }
  if (sinceTime != null && untilTime != null && sinceTime > untilTime) throw new Error("--since is after --until")
  return { sinceTime: sinceTime ?? undefined, untilTime: untilTime ?? undefined }
}

// ============================================================================
// Query expansion (static synonym map)
// ============================================================================

/** Static synonym map for common dev terms. Keys are normalized to lowercase. */
const SYNONYMS: Record<string, string[]> = {
  auth: ["authentication", "login", "signin", "sign-in", "oauth", "jwt"],
  bug: ["error", "issue", "fix", "defect", "broken"],
  test: ["spec", "vitest", "assertion", "expect", "describe"],
  refactor: ["restructure", "reorganize", "cleanup", "clean-up"],
  perf: ["performance", "speed", "latency", "benchmark", "slow", "fast"],
  ui: ["interface", "component", "render", "display", "layout"],
  tui: ["terminal", "ink", "@silvery/ag-term", "console"],
  db: ["database", "sqlite", "sql", "query"],
  dep: ["dependency", "package", "module", "import"],
  config: ["configuration", "settings", "options", "preferences"],
  err: ["error", "exception", "throw", "catch", "failure"],
  log: ["logging", "debug", "trace", "console"],
  nav: ["navigation", "navigate", "route", "routing"],
  sync: ["synchronize", "synchronization", "bidirectional", "replicate"],
  cmd: ["command", "keybinding", "shortcut", "hotkey"],
  doc: ["documentation", "readme", "docs"],
  lint: ["eslint", "prettier", "format", "formatting"],
  ci: ["pipeline", "github-actions", "workflow", "continuous-integration"],
  api: ["endpoint", "rest", "request", "response"],
  crash: ["segfault", "panic", "abort", "fatal"],
}

/**
 * Expand a query with synonyms.
 * For each word that matches a synonym key, returns additional queries
 * with synonyms substituted (one synonym per variant).
 *
 * FTS5 doesn't support grouped OR, so we generate variant queries.
 * Example: "auth bug" → ["authentication bug", "login bug", "auth error", "auth issue"]
 *
 * Returns null if no synonyms match.
 */
export function expandQueryVariants(query: string): string[] | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)

  // Find which words have synonyms
  const expansions: { wordIdx: number; synonyms: string[] }[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (word === undefined) continue
    if (word.startsWith("-") || word.startsWith('"')) continue
    const cleaned = word.replace(/[?!.,;]+$/, "")
    const syns = SYNONYMS[cleaned]
    if (syns && syns.length > 0) {
      expansions.push({ wordIdx: i, synonyms: syns.slice(0, 3) })
    }
  }

  if (expansions.length === 0) return null

  // Generate variant queries: substitute one synonym at a time
  const variants: string[] = []
  for (const { wordIdx, synonyms } of expansions) {
    for (const syn of synonyms) {
      const variant = [...words]
      variant[wordIdx] = syn
      variants.push(variant.join(" "))
    }
  }

  return variants
}

// ============================================================================
// Recency boost
// ============================================================================

/**
 * Compute a combined score from FTS5 rank and recency.
 * BM25 rank is negative (more negative = better match).
 * Recency factor: 1 / (1 + days_ago / 7), half-life ~1 week.
 * Combined: rank / recency_factor (dividing a negative number by a value <1 makes it more negative = better)
 */
export function boostedRank(rank: number, timestamp: number): number {
  // Defensive: rows with missing/non-numeric timestamps fall back to no recency boost.
  // Previously NaN would propagate through sort comparators and produce undefined ordering.
  if (!Number.isFinite(timestamp)) return rank
  const daysAgo = (Date.now() - timestamp) / ONE_DAY_MS
  const recencyFactor = 1 / (1 + daysAgo / 7)
  // rank is negative (bm25), so multiplying by recencyFactor (0..1) makes recent items more negative = better
  return rank * recencyFactor
}

/**
 * Recall's one merge: sort by recency-boosted rank (lower is better), keep the best result per session and type, and
 * cut at `limit`. recall() merges its phases with it, and the prompt hook joins its two calls with it, so the join
 * never re-ranks (@ag/recall/three-dark-search-paths Phase 3, @cto 7f55e4f2).
 */
export function mergeRecallResults(results: readonly RecallSearchResult[], limit: number): RecallSearchResult[] {
  const sorted = [...results].sort((a, b) => boostedRank(a.rank, a.timestamp) - boostedRank(b.rank, b.timestamp))
  const seen = new Set<string>()
  const merged: RecallSearchResult[] = []
  for (const result of sorted) {
    const key = `${result.sessionId}:${result.type}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(result)
    if (merged.length >= limit) break
  }
  return merged
}

// ============================================================================
// Live session search — grep current session's JSONL (not yet indexed)
// ============================================================================

export function searchLiveSession(query: string, limit: number): RecallSearchResult[] {
  const sessionId = process.env[CLAUDE_SESSION_ID_ENV]
  if (!sessionId) return []

  // Find the live JSONL — Claude Code stores sessions at ~/.claude/projects/{slug}/{id}.jsonl
  // The slug is the CWD with / replaced by - (e.g., /Users/beorn/Code → -Users-beorn-Code)
  const home = process.env.HOME ?? ""
  const cwd = process.cwd()
  const projectSlug = cwd.replaceAll("/", "-")
  const projectDir = resolve(home, ".claude/projects", projectSlug)
  const jsonlPath = resolve(projectDir, `${sessionId}.jsonl`)
  if (!existsSync(jsonlPath)) return []

  try {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2)
    if (terms.length === 0) return []

    // Use grep for fast pre-filtering — much faster than reading 40MB into memory
    const grepPattern = terms[0]
    if (grepPattern === undefined) return []
    const proc = Bun.spawnSync(["grep", "-i", "-n", grepPattern, jsonlPath], {
      stdout: "pipe",
      stderr: "ignore",
    })
    if (!proc.stdout) return []

    const grepOutput = proc.stdout.toString()
    const matchingLines = grepOutput.split("\n").filter(Boolean)
    const results: RecallSearchResult[] = []

    // Process from end (most recent matches first)
    for (let i = matchingLines.length - 1; i >= 0 && results.length < limit; i--) {
      const line = matchingLines[i]
      if (line === undefined) continue
      const colonIdx = line.indexOf(":")
      if (colonIdx < 0) continue
      const jsonStr = line.slice(colonIdx + 1)

      try {
        // JSONL timestamps are ISO date strings ("2026-04-26T..."); accept
        // either a string (parse to ms) or a number (already ms).
        const msg = JSON.parse(jsonStr) as {
          type?: string
          timestamp?: number | string
          message?: { content?: unknown }
        }
        if (msg.type !== "human" && msg.type !== "assistant") continue

        const text =
          typeof msg.message?.content === "string"
            ? msg.message.content
            : Array.isArray(msg.message?.content)
              ? (msg.message.content as Array<{ type: string; text: string }>)
                  .filter((c) => c.type === "text")
                  .map((c) => c.text)
                  .join(" ")
              : ""
        if (!text) continue

        const lower = text.toLowerCase()
        const matchCount = terms.filter((t) => lower.includes(t)).length
        if (matchCount < Math.ceil(terms.length / 2)) continue

        // Extract snippet around first match
        const firstIdx = Math.min(...terms.map((t) => lower.indexOf(t)).filter((idx) => idx >= 0))
        const start = Math.max(0, firstIdx - 100)
        const snippet = text.slice(start, start + 500)

        const tsNumeric =
          typeof msg.timestamp === "number"
            ? msg.timestamp
            : typeof msg.timestamp === "string"
              ? Date.parse(msg.timestamp)
              : Date.now()
        results.push({
          type: "message",
          sessionId,
          sessionTitle: "(current session)",
          timestamp: Number.isFinite(tsNumeric) ? tsNumeric : Date.now(),
          snippet: `[CURRENT SESSION] ${snippet}`,
          rank: -100 - matchCount,
        })
      } catch {
        /* skip malformed */
      }
    }

    return results
  } catch {
    // silent-fallback-allow: current-session transcript scan is opportunistic recall enrichment.
    return []
  }
}

// ============================================================================
// Synthesis-failure helpers — keep recall()'s catch block flat
// ============================================================================

function describeSynthesisError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Build the diagnostics attached to RecallResult.synthesisFailure. A
 * SynthesisFailure carries a full structured report; any other thrown
 * value (unexpected — synthesizeResults is documented to only throw
 * SynthesisFailure) still gets a minimal, honest one rather than being
 * silently dropped.
 */
export function synthesisDiagnosticsFromError(err: unknown, timeoutMs: number): SynthesisDiagnostics {
  if (err instanceof SynthesisFailure) {
    return { ...err.diagnostics, rawStack: err.stack }
  }
  return {
    summary: describeSynthesisError(err),
    totalBudgetMs: timeoutMs,
    attempts: [],
    batches: [],
    excludedProviders: [],
    consideredProviders: [],
    rawStack: err instanceof Error ? err.stack : undefined,
  }
}

/** The indexed and vault sources behind one lexical candidate request. */
export type CandidateLeg = "messages" | "project_content" | "vault" | "titles"

export interface CandidateRequest {
  db: Database
  query: string
  messages?: MessageSearchOptions
  projectContent?: ContentSearchOptions
  vault?: { limit: number; dbPath: string | null }
  titles?: boolean
  /** Retain the caller's phase accounting without a second query path. */
  measure?: <T>(leg: CandidateLeg, run: () => T) => T
}

/** One read-only query boundary for Recall's normal, raw and planned variants. */
export function retrieveCandidates(request: CandidateRequest) {
  const legs: CandidateLeg[] = []
  const run = <T>(leg: CandidateLeg, query: () => T): T => {
    legs.push(leg)
    return request.measure ? request.measure(leg, query) : query()
  }
  const messageOptions = request.messages
  const contentOptions = request.projectContent
  const vaultOptions = request.vault
  const messages = messageOptions
    ? run("messages", () => ftsSearchWithSnippet(request.db, request.query, messageOptions))
    : { results: [], total: null }
  const projectContent = contentOptions
    ? run("project_content", () => searchAll(request.db, request.query, contentOptions))
    : { results: [], total: null }
  const vault = vaultOptions
    ? run("vault", () => searchVault(request.query, vaultOptions.limit, vaultOptions.dbPath))
    : null
  const titles = request.titles ? run("titles", getAllSessionTitles) : new Map<string, string>()
  return { messages, projectContent, vault, titles, legs }
}

export type CandidateSet = ReturnType<typeof retrieveCandidates>

// ============================================================================
// Core recall function
// ============================================================================

/**
 * Search session history and optionally synthesize results via cheap LLM.
 *
 * Searches both the messages FTS table and the unified content table
 * (project knowledge), merges results by rank, deduplicates by session,
 * and optionally passes them through a cheap LLM for synthesis.
 */
export async function recall(query: string, options: RecallOptions = {}): Promise<RecallResult> {
  if (options.until !== undefined) {
    if (!options.raw) throw new Error("--until supports indexed raw Recall, not synthesis")
    if (options.vaultDb != null) throw new Error("--until cannot search vault rows without timestamps")
    if (!options.excludeCurrentSession) {
      throw new Error("--until cannot enrich from the live session; set excludeCurrentSession for indexed raw Recall")
    }
  }
  const { sinceTime, untilTime } = resolveSearchWindow(options.since, options.until)
  const {
    limit = 10,
    raw = false,
    since,
    timeout = DEFAULT_SYNTHESIS_TIMEOUT_MS,
    snippetTokens = 200,
    projectFilter,
    excludeCurrentSession = false,
    mode = "exact",
  } = options
  const provenance: IndexProvenance = options.provenance ?? "unknown"
  const currentSessionId = excludeCurrentSession ? process.env[CLAUDE_SESSION_ID_ENV] : undefined

  const startTime = Date.now()
  const sinceLabel = since ?? "30d"
  log(
    `search query="${query.slice(0, 80)}" limit=${limit} since=${sinceLabel} raw=${raw} timeout=${timeout}ms mode=${mode}`,
  )

  // Hook mode (@ag/tribe/25071 row 2): the window's matches ranked under a cap instead of every match, no counts, and
  // neither the project content nor the synonym variants (@ag/recall/three-dark-search-paths Phase 3).
  const hook = mode === "hook"
  // A phase outside `options.phases` is neither run nor timed; absent, every phase runs (Phase 3, @cto 7f55e4f2).
  const runs = (name: RecallPhase): boolean => options.phases === undefined || options.phases.includes(name)
  const skipped: RecallSkip[] = []
  const phases: Record<string, number> = {}
  const phase = <T>(name: string, run: () => T): T => {
    const began = performance.now()
    try {
      return run()
    } finally {
      phases[name] = (phases[name] ?? 0) + performance.now() - began
    }
  }
  let hookSearch: HookMessageSearch | undefined
  let vaultQuery: VaultQuery | undefined
  const said = (): Pick<RecallResult, "hookSearch" | "skipped" | "vaultQuery"> => ({
    ...(hookSearch === undefined
      ? {}
      : {
          hookSearch: {
            candidateLimit: hookSearch.candidateLimit,
            survivors: hookSearch.survivors,
          },
        }),
    ...(skipped.length === 0 ? {} : { skipped }),
    ...(vaultQuery === undefined ? {} : { vaultQuery }),
  })

  const db = getDb()

  try {
    // Search messages table with FTS5
    const messageOpts: MessageSearchOptions = {
      limit: limit * 2, // Fetch extra for dedup
      sinceTime,
      untilTime,
      projectFilter,
      snippetTokens,
      mode,
    }

    // Project knowledge is searched by normal mode. The hook's vault phase
    // answers for beads and docs inside its wall.
    const projectContentOpts: ContentSearchOptions = {
      limit: limit * 2,
      untilTime,
      projectFilter,
      snippetTokens,
      types: ["bead", "session_memory", "project_memory", "doc", "claude_md", "llm_research"] as ContentType[],
      mode,
    }
    const vaultDb = options.vaultDb ?? null
    const searchStart = Date.now()
    const candidates = retrieveCandidates({
      db,
      query,
      ...(runs("messages") ? { messages: messageOpts } : {}),
      ...(!hook && options.phases === undefined ? { projectContent: projectContentOpts } : {}),
      ...(runs("vault") ? { vault: { limit: limit * 2, dbPath: vaultDb } } : {}),
      measure: phase,
    })
    const messageResults = candidates.messages
    const projectContentResults = candidates.projectContent
    const vault = candidates.vault
    const vaultMatches = vault?.matches ?? []
    const msgMs = phases.messages ?? 0
    hookSearch = messageResults.hook
    if (hookSearch?.capped) skipped.push(hookSearch.capped)
    else if (messageResults.capped) skipped.push(messageResults.capped)
    if (!runs("messages")) {
      log(`FTS5 messages: not run (phases ${String(options.phases?.join(","))})`)
    } else if (hookSearch) {
      log(
        `FTS5 messages: total: not counted (hook mode), ${messageResults.results.length} returned (${msgMs}ms) ` +
          `[window matches ranked ${hookSearch.survivors}, cap ${hookSearch.candidateLimit}]`,
      )
    } else {
      log(
        `FTS5 messages: ${String(messageResults.total)} total (raw, before null-uuid copy collapse), ` +
          `${messageResults.results.length} returned (${msgMs}ms)`,
      )
    }

    // Vault FTS — opt-in: searches the km tree db (.km/state.db) the call names (options.vaultDb, its only binding:
    // @cto 456e6e77). Beads, design docs, CLAUDE.md, and hub/* docs are higher signal than
    // transcript fragments, so we boost vault hits with a strong negative
    // rank (more negative = better).
    const projectMs = phases.project_content ?? 0
    const vaultMs = phases.vault ?? 0
    if (vault !== null && vaultDb !== null) {
      vaultQuery = { form: vault.form, terms: vault.terms, unmatched: vault.unmatched, matched: vault.matched }
      log(
        `vault FTS: ${vaultMatches.length} of ${vault.matched} matched, ${vault.form} of [${vault.terms.join(", ")}]${vault.unmatched.length > 0 ? `, unmatched [${vault.unmatched.join(", ")}]` : ""} (${vaultMs}ms) [${vaultDb}]`,
      )
    }

    // Query expansion: search with synonym variants for broader recall. Not in hook mode (Phase 3).
    const SYNONYM_RANK_PENALTY = 5 // Penalize synonym matches to rank below exact matches
    const queryVariants = hook ? null : expandQueryVariants(query)
    let synonymMsgCount = 0
    let synonymContentCount = 0

    if (queryVariants && options.phases === undefined) {
      log(`query expansion: "${query}" → ${queryVariants.length} variants`)
      // Collect IDs already found to avoid duplicates
      const seenMsgIds = new Set(messageResults.results.map((r) => r.id))
      const seenContentIds = new Set(projectContentResults.results.map((r) => r.id))

      for (const variant of queryVariants.slice(0, 4)) {
        const began = performance.now()
        try {
          try {
            const varMsgs = retrieveCandidates({ db, query: variant, messages: { ...messageOpts, limit } }).messages
            for (const r of varMsgs.results) {
              if (!seenMsgIds.has(r.id)) {
                seenMsgIds.add(r.id)
                r.rank += SYNONYM_RANK_PENALTY
                messageResults.results.push(r)
                synonymMsgCount++
              }
            }
          } catch (error) {
            skipped.push(rejectedQuerySkip("synonym_messages", variant, error))
            continue
          }

          // Keep messages already found if the content leg rejects this variant.
          try {
            const varProject = retrieveCandidates({
              db,
              query: variant,
              projectContent: { ...projectContentOpts, limit },
            }).projectContent
            for (const r of varProject.results) {
              if (!seenContentIds.has(r.id)) {
                seenContentIds.add(r.id)
                r.rank += SYNONYM_RANK_PENALTY
                projectContentResults.results.push(r)
                synonymContentCount++
              }
            }
          } catch (error) {
            skipped.push(rejectedQuerySkip("synonym_project_content", variant, error))
          }
        } finally {
          phases.synonyms = (phases.synonyms ?? 0) + performance.now() - began
        }
      }

      if (synonymMsgCount > 0 || synonymContentCount > 0) {
        log(`query expansion: added ${synonymMsgCount} messages + ${synonymContentCount} content from synonyms`)
      }
    }

    const searchMs = Date.now() - searchStart
    log(`FTS5 search: ${searchMs}ms (messages=${msgMs}ms project=${projectMs}ms)`)

    // Title enrichment follows the lexical and synonym reads, as before.
    const sessionTitles = retrieveCandidates({ db, query: "", titles: runs("titles"), measure: phase }).titles

    // Session depth corroboration: sessions with more matching messages are more relevant.
    // A session with 10 messages about the topic is more authoritative than one with 1 passing mention.
    // Hook mode reads each session's depth from its candidate set, since this GROUP BY scans every all-time match
    // (14.5 s on tribe*); that depth is within the candidates, not all-time (@cto 9665a0ec). Hook mode never runs
    // the scan, even when its messages phase did not run and left no candidate set (Phase 3).
    const corroborationStart = Date.now()
    const corroborationBegan = performance.now()
    const ftsQuery = toFts5Query(query)
    const sessionDepths = hookSearch ? new Map(hookSearch.sessionDepths) : new Map<string, number>()
    if (!hook && runs("messages")) {
      try {
        const depthRows = db
          .prepare(
            assertSingleStatement(`SELECT m.session_id, COUNT(*) as depth
           FROM messages_fts f
           JOIN messages m ON f.rowid = m.id
           WHERE messages_fts MATCH ?
           ${untilTime === undefined ? "" : "AND m.timestamp <= ?"}
           GROUP BY m.session_id
           ORDER BY depth DESC
           LIMIT 100`),
          )
          .all(...(untilTime === undefined ? [ftsQuery] : [ftsQuery, untilTime])) as {
          session_id: string
          depth: number
        }[]
        for (const r of depthRows) {
          sessionDepths.set(r.session_id, r.depth)
        }
      } catch (error) {
        skipped.push(rejectedQuerySkip("corroboration", query, error))
      }
    }
    phases.corroboration = performance.now() - corroborationBegan
    const corroborationMs = Date.now() - corroborationStart
    if (sessionDepths.size > 0) {
      const maxDepth = Math.max(...sessionDepths.values())
      log(`corroboration: ${sessionDepths.size} sessions, max depth=${maxDepth} (${corroborationMs}ms)`)
    }

    // Search current (live) session — not yet indexed.
    // Skipped when excludeCurrentSession is set (the inject path uses this to
    // break the autocatalytic loop where current-session transcript fragments
    // get re-emitted as if they were prior memory).
    const liveStart = Date.now()
    const liveResults = phase("live_session", () => (excludeCurrentSession ? [] : searchLiveSession(query, limit)))
    const liveMs = Date.now() - liveStart
    if (liveResults.length > 0) {
      log(`live session: ${liveResults.length} matches (${liveMs}ms)`)
    } else if (excludeCurrentSession) {
      log(`live session: skipped (excludeCurrentSession=true)`)
    }

    // Merge results into a unified list
    const merged: RecallSearchResult[] = []

    // Live session results get top priority (rank = -100, very negative = best)
    for (const r of liveResults) {
      merged.push(r)
    }

    let droppedCurrent = 0
    for (const r of messageResults.results) {
      if (currentSessionId && (r.session_id === currentSessionId || r.parent_session_id === currentSessionId)) {
        droppedCurrent++
        continue
      }
      // Apply corroboration boost: divide BM25 rank by log2(depth+1)
      // BM25 is negative (more negative = better), so dividing by >1 makes it more negative = better
      const depth = sessionDepths.get(r.session_id) ?? 1
      const corroborationBoost = depth > 1 ? Math.log2(depth + 1) : 1

      merged.push({
        type: "message",
        sessionId: r.session_id,
        sessionTitle: sessionTitles.get(r.session_id) ?? null,
        timestamp: Number(r.timestamp),
        snippet: r.snippet || (r.content?.slice(0, 500) ?? ""),
        rank: r.rank / corroborationBoost,
        line: r.line ?? null,
        duplicateLine: (r as { duplicate_line?: number | null }).duplicate_line ?? null,
        collapsedCopyCount: r.collapsedCopyLocations?.length ?? r.collapsedCopyCount ?? null,
        collapsedCopyLocations: r.collapsedCopyLocations ?? null,
        parentSessionId: r.parent_session_id ?? null,
        agentId: r.agent_id ?? null,
      })
    }

    for (const r of projectContentResults.results) {
      merged.push({
        type: r.content_type as RecallSearchResult["type"],
        sessionId: r.source_id,
        sessionTitle: r.title ?? sessionTitles.get(r.source_id) ?? null,
        timestamp: Number(r.timestamp),
        snippet: r.snippet || r.content.slice(0, 500),
        rank: r.rank,
      })
    }

    // Vault matches — typed as "vault" so the inject path can render a
    // pointer (path + title + snippet) instead of a transcript fragment.
    // sessionId here is the node fs_path so dedup-by-session works naturally
    // and titles are vault-relative paths.
    for (const v of vaultMatches) {
      merged.push({
        type: "vault",
        sessionId: v.fsPath ?? v.id,
        sessionTitle: v.title ?? v.fsPath ?? v.name ?? null,
        timestamp: Date.now(),
        snippet: v.snippet,
        rank: v.rank,
      })
    }

    const deduped = mergeRecallResults(merged, limit)

    const uniqueSessions = new Set(deduped.map((r) => r.sessionId)).size
    const dropMsg = droppedCurrent > 0 ? ` [dropped ${droppedCurrent} current-session]` : ""
    log(
      `merged: ${merged.length} raw → ${deduped.length} deduped from ${uniqueSessions} sessions${dropMsg} (${Date.now() - searchStart}ms total search)`,
    )

    // Session proximity: expand top message results with neighboring context
    const proximityStart = Date.now()
    const proximityBegan = performance.now()
    const TOP_N = Math.min(5, deduped.length)
    let contextExpanded = 0
    for (let i = 0; i < TOP_N; i++) {
      const result = deduped[i]
      if (result === undefined) continue
      if (result.type !== "message") continue

      const neighbors = getSessionContext(db, result.sessionId, result.timestamp, 5)
      if (neighbors.length > 1) {
        // Build expanded snippet from neighboring messages
        const contextParts: string[] = []
        for (const n of neighbors) {
          if (!n.content) continue
          const role = n.type === "user" ? "[User]" : n.type === "assistant" ? "[Assistant]" : `[${n.type}]`
          const text = n.content.slice(0, 200)
          contextParts.push(`${role} ${text}`)
        }
        if (contextParts.length > 0) {
          const expandedSnippet = contextParts.join("\n---\n")
          // Replace snippet with expanded context (keeping original at front)
          result.snippet = expandedSnippet.slice(0, 1500)
          contextExpanded++
        }
      }
    }
    phases.proximity = performance.now() - proximityBegan
    if (contextExpanded > 0) {
      log(
        `session proximity: expanded ${contextExpanded} results with neighboring context (${Date.now() - proximityStart}ms)`,
      )
    }

    // No results — return early
    if (deduped.length === 0) {
      log(`no results found (${Date.now() - startTime}ms total)`)
      return {
        query,
        provenance,
        synthesis: null,
        results: [],
        durationMs: Date.now() - startTime,
        timing: { searchMs, phases },
        ...said(),
      }
    }

    // Raw mode — return results as-is without LLM
    if (raw) {
      log(`raw mode — returning ${deduped.length} results without synthesis (${Date.now() - startTime}ms total)`)
      return {
        query,
        provenance,
        synthesis: null,
        results: deduped,
        durationMs: Date.now() - startTime,
        timing: { searchMs, phases },
        ...said(),
      }
    }

    // Attempt LLM synthesis with AbortController for clean timeout. A
    // failure here must NOT throw the lexical results away — the search
    // already succeeded (deduped.length > 0, checked above); losing that on
    // a downstream LLM failure is exactly the "tool is broken" reading as
    // "nothing found" defect. Catch, keep the lexical results, and attach a
    // full diagnostic report so the formatter can say so loudly.
    const llmStart = Date.now()
    let synthesis
    try {
      synthesis = await synthesizeResults(query, deduped, timeout)
    } catch (err) {
      const llmMs = Date.now() - llmStart
      const totalMs = Date.now() - startTime
      log(
        `synthesis FAILED after ${llmMs}ms — keeping ${deduped.length} lexical results: ${describeSynthesisError(err)}`,
      )
      return {
        query,
        provenance,
        synthesis: null,
        results: deduped,
        durationMs: totalMs,
        timing: { searchMs, llmMs, phases },
        synthesisFailure: synthesisDiagnosticsFromError(err, timeout),
        ...said(),
      }
    }
    const llmMs = Date.now() - llmStart

    const totalMs = Date.now() - startTime
    log(
      `synthesis OK: ${synthesis.text.length} chars, cost=$${(synthesis.cost ?? 0).toFixed(4)} (${totalMs}ms total, search=${searchMs}ms llm=${llmMs}ms${synthesis.aborted ? " ABORTED" : ""})`,
    )

    return {
      query,
      provenance,
      synthesis: synthesis.text,
      results: deduped,
      durationMs: totalMs,
      llmCost: synthesis.cost,
      timing: { searchMs, llmMs, phases },
      ...said(),
    }
  } finally {
    closeDb()
  }
}
