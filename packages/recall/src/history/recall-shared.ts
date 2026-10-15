/**
 * recall-shared.ts - Shared logging, constants, and types used across recall modules
 */

import { createLogger } from "loggily"
import type { ContentType } from "./types.ts"
import type { IndexFreshness } from "../lib/staleness.ts"
import type { VaultQuery } from "./vault-fts.ts"

// ============================================================================
// Logging
// ============================================================================

const recallLog = createLogger("recall")

let _logEnabled = process.env.TRIBE_LOG === "1"
export function setRecallLogging(enabled: boolean): void {
  _logEnabled = enabled
}
export function log(msg: string): void {
  if (_logEnabled) recallLog.info?.(msg)
}

// ============================================================================
// Time constants
// ============================================================================

export const ONE_HOUR_MS = 60 * 60 * 1000
export const ONE_DAY_MS = 24 * ONE_HOUR_MS
export const THIRTY_DAYS_MS = 30 * ONE_DAY_MS
export const DEFAULT_SYNTHESIS_TIMEOUT_MS = 20_000
/**
 * One planner attempt's deadline: deepseek-chat's measured p95, rounded up (@ag/llm/29473: 20 calls on the first 10
 * recall-eval corpus queries, 2026-10-15, host load 11-18: p50 8.5 s, p95 13.5 s, max 13.8 s). The planner stops at
 * PLANNER_ATTEMPT_CAP attempts.
 */
export const DEFAULT_PLAN_TIMEOUT_MS = 14_000

// ============================================================================
// Types
// ============================================================================

/** Whether the FTS index can support an authoritative absence claim. */
export type IndexProvenance = "complete" | "stale" | "missing" | "unknown"

export interface RecallOptions {
  limit?: number // Max results to include (default 10)
  raw?: boolean // Return raw results without LLM synthesis
  since?: string // Time filter (1h, 1d, 1w, etc.)
  json?: boolean // Return structured JSON
  timeout?: number // Total timeout in ms (default DEFAULT_SYNTHESIS_TIMEOUT_MS)
  snippetTokens?: number // Snippet window size (default 200)
  projectFilter?: string // Project filter
  excludeCurrentSession?: boolean // Drop matches from CLAUDE_SESSION_ID (default false)
  /** Index state established by the caller; direct library calls default to unknown. */
  provenance?: IndexProvenance
  /**
   * The root, window and age behind `provenance`, when the caller classified the
   * index (the CLI does) — echoed onto RecallResult so a stale answer names what
   * it judged (@ag/recall/27930).
   */
  provenanceDetail?: IndexFreshness
  /**
   * "exact" (the default, and the CLI's) ranks every match and counts totals. "hook" ranks the time window's matches,
   * at most HOOK_CANDIDATE_LIMIT of them with a loud cap line, inside the prompt hook's budget and counts nothing
   * (@ag/tribe/25071 row 2); see recall-budget.ts.
   */
  mode?: SearchMode
  /**
   * The search phases this call runs; absent, every one runs. A phase outside the list is neither run nor timed.
   * Corroboration, the live session, the merge and proximity are assembly, run over what the phases collected
   * (@ag/recall/three-dark-search-paths Phase 3, @cto 7f55e4f2).
   */
  phases?: readonly RecallPhase[]
  /**
   * The vault database this call searches: recall()'s only vault binding (@cto 456e6e77). Absent or null, no vault
   * is searched, and the entry point says so. Each entry point resolves `--vault-db` into it at its boundary, so a
   * Worker the binding never reached (the prompt hook's) still searches the vault.
   */
  vaultDb?: string | null
}

/** A search phase one recall call may run (Phase 3). */
export type RecallPhase = "vault" | "messages" | "session_content" | "titles"

/** How a search reaches FTS: every match ranked and counted, or the window's matches ranked under a cap (@ag/tribe/25071 row 2). */
export type SearchMode = "exact" | "hook"

/** A phase recall skipped rather than ran, said out loud (@ag/tribe/25071 row 2). */
export interface RecallSkip {
  /** The phase: "messages" when hook mode capped its window. */
  phase: string
  /** The query the phase would have searched. */
  anchor: string
  /** The line the hook prints. */
  message: string
}

/** How hook mode's message search went (@ag/tribe/25071 row 2). */
export interface HookSearchSummary {
  /** The cap on ranked window matches: HOOK_CANDIDATE_LIMIT. */
  candidateLimit: number
  /** Window matches ranked, at most candidateLimit. */
  survivors: number
}

export interface RecallResult {
  query: string
  provenance: IndexProvenance
  /**
   * The root, window and age behind `provenance` — attached on the CLI's own
   * results so a stale answer names what it judged (@ag/recall/27930).
   */
  provenanceDetail?: IndexFreshness
  synthesis: string | null // LLM synthesis (null if raw mode, no results, or synthesis failed)
  results: RecallSearchResult[]
  durationMs: number
  llmCost?: number
  timing?: {
    searchMs: number
    llmMs?: number
    /** Each search phase's wall time in ms, so a slow run names the slow phase (@ag/tribe/25071). */
    phases?: Record<string, number>
  }
  /** Hook mode only: how the candidate search went. */
  hookSearch?: HookSearchSummary
  /** How the vault was searched, when it was: the form that ran, its terms, and the terms no node holds (29487). */
  vaultQuery?: VaultQuery
  /** Each phase skipped rather than run, or cut short (the hook's capped window); absent when none was. */
  skipped?: RecallSkip[]
  /**
   * Set when the lexical search succeeded (results is non-empty) but LLM
   * synthesis failed — the tool is BROKEN, not "no prior knowledge found".
   * The formatter must render this as a loud failure, not silently fall
   * through to printing an empty/null synthesis.
   */
  synthesisFailure?: SynthesisDiagnostics
}

export interface RecallSearchResult {
  type: ContentType
  sessionId: string
  parentSessionId?: string | null
  agentId?: string | null
  sessionTitle: string | null
  timestamp: number
  snippet: string
  rank: number
  line?: number | null
  duplicateLine?: number | null
}

// ============================================================================
// Synthesis failure diagnostics
// ============================================================================
//
// Defined here (not in synthesize.ts) so both synthesize.ts and its callers
// (history/search.ts's recall(), lib/search.ts's formatter) can import them
// without a synthesize.ts <-> recall-shared.ts import cycle.

/** One model actually queried during synthesis, and what happened to it. */
export interface SynthesisAttempt {
  modelId: string
  provider: string
  status: "ok" | "timeout" | "error"
  error?: string
  elapsedMs: number
  /** The budget THIS attempt's batch was given — its fair share, not the total. */
  timeoutMs: number
}

/** Budget accounting for one race batch (up to 2 models racing together). */
export interface SynthesisBatchAccounting {
  modelIds: string[]
  /** Remaining budget when this batch started. */
  budgetAtStartMs: number
  /** This batch's fair share of that remaining budget. */
  allocatedMs: number
  /** Actual wall-clock time the batch took. */
  elapsedMs: number
  timedOut: boolean
}

/** A candidate model that was considered but never queried, and why. */
export interface ExcludedProvider {
  provider: string
  modelId: string
  reason: string
}

/**
 * Full "what happened" record for a failed synthesis — everything a caller
 * needs to diagnose the failure without a second run. § Fail Loud: what I
 * queried, where I looked, what I excluded.
 */
export interface SynthesisDiagnostics {
  /**
   * One-line human summary of what went wrong — the SAME text as the
   * thrown error's `.message`. Some failure modes (e.g. no LLM backend
   * configured at all) have nothing structured to report beyond this, so
   * the formatter must always print it, not just the structured fields.
   */
  summary: string
  totalBudgetMs: number
  attempts: SynthesisAttempt[]
  batches: SynthesisBatchAccounting[]
  excludedProviders: ExcludedProvider[]
  /** Providers whose model DID get raced (whether or not it won). */
  consideredProviders: string[]
  /**
   * The raw JS stack trace of the failure, kept for debugging but never the
   * primary signal — the formatter must print the structured fields above
   * first and this last, de-emphasized.
   */
  rawStack?: string
}

/**
 * Thrown when synthesis cannot produce an answer. Carries `.diagnostics` so
 * a caller with lexical results in hand (recall()) can report "the tool is
 * broken, here's exactly what happened" instead of just `.message`.
 */
export class SynthesisFailure extends Error {
  readonly diagnostics: SynthesisDiagnostics
  constructor(message: string, diagnostics: SynthesisDiagnostics) {
    super(message)
    this.name = "SynthesisFailure"
    this.diagnostics = diagnostics
  }
}

/**
 * A `--timeout` value worth suggesting to a caller retrying after a
 * failure — double the original budget, or 5s past the slowest attempt
 * actually seen, whichever is larger. Shared by the one-sentence summary
 * (synthesize.ts) and the "Next steps" detail (lib/search.ts) so the two
 * never quote different numbers for the same failure.
 */
export function suggestRetryTimeoutMs(totalBudgetMs: number, attempts: SynthesisAttempt[]): number {
  const slowestMs = attempts.reduce((max, a) => Math.max(max, a.elapsedMs), 0)
  return Math.max(totalBudgetMs * 2, slowestMs + 5000)
}
