/**
 * recall-shared.ts - Shared logging, constants, and types used across recall modules
 */

import type { ContentType } from "./types.ts"

// ============================================================================
// Logging
// ============================================================================

let _logEnabled = true
export function setRecallLogging(enabled: boolean): void {
  _logEnabled = enabled
}
export function log(msg: string): void {
  if (_logEnabled) console.error(`[recall] ${msg}`)
}

// ============================================================================
// Time constants
// ============================================================================

export const ONE_HOUR_MS = 60 * 60 * 1000
export const ONE_DAY_MS = 24 * ONE_HOUR_MS
export const THIRTY_DAYS_MS = 30 * ONE_DAY_MS

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
  timeout?: number // Total timeout in ms (default 4000)
  snippetTokens?: number // Snippet window size (default 200)
  projectFilter?: string // Project filter
  excludeCurrentSession?: boolean // Drop matches from CLAUDE_SESSION_ID (default false)
  /** Index state established by the caller; direct library calls default to unknown. */
  provenance?: IndexProvenance
}

export interface RecallResult {
  query: string
  provenance: IndexProvenance
  synthesis: string | null // LLM synthesis (null if raw mode, no results, or synthesis failed)
  results: RecallSearchResult[]
  durationMs: number
  llmCost?: number
  timing?: {
    searchMs: number
    llmMs?: number
  }
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
  sessionTitle: string | null
  timestamp: number
  snippet: string
  rank: number
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
