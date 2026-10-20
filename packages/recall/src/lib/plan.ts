/**
 * plan.ts — LLM-driven query planner.
 *
 * Given a user query + rich project context, emits 10–20 FTS query variants
 * bucketed by kind (keywords, phrases, concepts, paths, errors, bead_ids).
 *
 * Round 2 re-runs the planner with round-1 results attached, in one of two
 * modes:
 *   - wider:  weak round-1 coverage → ask for broader / alt phrasings
 *   - deeper: strong round-1 cluster → mine entities from top snippets
 */

import {
  loadLlm,
  llmCostCall,
  selectBudgetedModels,
  type LlmBackend,
  type LlmModel,
  type LlmCostCall,
  type LlmCostFields,
} from "./llm-backend.ts"
import type { RecallSearchResult } from "../history/recall-shared.ts"
import { DEFAULT_PLAN_TIMEOUT_MS, log } from "../history/recall-shared.ts"
import type { QueryContext } from "./context.ts"
import { renderContextPrompt } from "./context.ts"

// ============================================================================
// Plan shape
// ============================================================================

export interface QueryPlan {
  /** Single technical tokens (FTS terms). */
  keywords: string[]
  /** Multi-word phrases (will be quoted for FTS). */
  phrases: string[]
  /** Broader concepts / domain terms — single or compound words. */
  concepts: string[]
  /** File paths, filenames, directory names. */
  paths: string[]
  /** Error messages / exception text / stack-trace markers. */
  errors: string[]
  /** Bead IDs mentioned or likely relevant. */
  bead_ids: string[]
  /** Short relative time hint ("1h"|"1d"|"1w"|"30d") or null. */
  time_hint: string | null
  /** Optional planner rationale for --debug-plan / trace. */
  notes?: string
}

export interface PlanCall extends Partial<LlmCostFields> {
  plan: QueryPlan | null
  model?: string
  elapsedMs: number
  calls: LlmCostCall[]
  rawResponse?: string
  error?: string
}

// ============================================================================
// Prompts
// ============================================================================

const PLAN_BUCKET_KEYS = ["keywords", "phrases", "concepts", "paths", "errors", "bead_ids"] as const
const PLAN_SHAPE = JSON.stringify({
  ...Object.fromEntries(PLAN_BUCKET_KEYS.map((key) => [key, []])),
  time_hint: null,
  notes: "",
})

const SYSTEM_PROMPT_ROUND1 = `You are a FTS5 query planner for a Claude Code session-history search engine.
Your job is to turn a vague user query into 10-20 FTS5-friendly search variants that will actually hit the indexed corpus.

KEY PRINCIPLE: Creativity comes from mining the project context for distinctive keywords.
The corpus is small and specific — generic synonyms ("authentication" for "login") rarely help.
What DOES help: the exact terminology this project uses. Pull candidate tokens from the
"Distinctive corpus tokens" list, recent session prompts, bead titles, and commit messages.
Prefer specific file/component names, bead IDs, and jargon you see in the context over
dictionary-level alternatives.

RULES:
- Output ONLY a single JSON object (no markdown, no prose, no code fences).
- Shape: ${PLAN_SHAPE}
- Across all buckets: aim for 10-20 variants total, not per bucket.
- keywords: single technical tokens — camelCase, kebab-case, or domain nouns.
- phrases: 2-4 word exact phrases likely to appear verbatim in transcripts.
- concepts: broader domain terms (flexbox, virtual-list, CRDT) when intent is abstract.
- paths: file basenames or directory names seen in the context (with extension if known).
- errors: exception or error-message fragments, if the query hints at a bug.
- bead_ids: bead IDs from the context that plausibly match the intent.
- time_hint: one of "1h", "1d", "1w", "30d" or null. Infer from phrases like "today", "last week", "recently".
- notes: ONE sentence on why you chose these variants. Cite context evidence if possible.

DO NOT invent tokens that aren't plausible given the context. When uncertain, omit.`

const SYSTEM_PROMPT_ROUND2_WIDER = `You are a FTS5 query planner running ROUND 2 in WIDER mode.

Round 1 returned weak coverage — few docs matched, or matched shallowly. Your job now
is to widen the net: propose variants that round 1 missed. Look for:
- Alternate phrasings the user might have used (they described it imperfectly).
- Adjacent concepts (if query is about "columns", try "layout", "grid", "kanban").
- Broader technical terms from the context vocabulary list.
- Common misspellings or abbreviations.

Avoid duplicating round-1 variants. Output fresh angles.

Shape: ${PLAN_SHAPE}
Budget: 10-20 variants total. Output ONLY the JSON object.`

const SYSTEM_PROMPT_ROUND2_DEEPER = `You are a FTS5 query planner running ROUND 2 in DEEPER mode.

Round 1 found a strong cluster of relevant docs. Your job now is to drill in: mine the
round-1 top snippets for SPECIFIC entities and search for those exact things.

Extract from the round-1 top snippets:
- File paths and filenames (put in "paths").
- Bead IDs (put in "bead_ids").
- Session IDs if shown.
- Distinctive technical identifiers (function names, component names, config keys) — "keywords".
- Exact phrases seen repeatedly — "phrases".
- Error strings — "errors".

Avoid duplicating round-1 variants. Focus on precision over breadth.

Shape: ${PLAN_SHAPE}
Budget: up to 15 variants. Output ONLY the JSON object.`

// ============================================================================
// Public API
// ============================================================================

export interface PlanOptions {
  round: 1 | 2
  mode?: "wider" | "deeper"
  priorPlan?: QueryPlan
  priorResults?: RecallSearchResult[]
  priorVariants?: string[]
  /** One attempt's deadline; no attempt starts after {@link PLANNER_ATTEMPT_CAP} times it (@cto 19102a36). */
  timeoutMs?: number
  /** Use a caller-selected planner model instead of the backend default. */
  model?: LlmModel
  /** Test/host seam; defaults to loading TRIBE_LLM_DIR. */
  llm?: LlmBackend
}

/** The planner's total cap: at most this many attempts, and none starts after this many attempt deadlines (@cto 19102a36, 57df9250). */
export const PLANNER_ATTEMPT_CAP = 2

/**
 * Run the planner. A failed or over-deadline attempt falls through to the next
 * available provider, each with its own deadline, until the total cap. Returns
 * `plan: null` only when all candidates fail, so callers can fall back to
 * lexical recall.
 */
export async function planQuery(query: string, context: QueryContext, options: PlanOptions): Promise<PlanCall> {
  const { round, mode, priorPlan, priorResults = [], priorVariants = [], timeoutMs = DEFAULT_PLAN_TIMEOUT_MS } = options
  const startedAt = Date.now()

  const llm = options.llm ?? (await loadLlm())
  if (!llm) {
    return {
      plan: null,
      calls: [],
      elapsedMs: Date.now() - startedAt,
      error: "no-llm-backend-available",
    }
  }
  const models = options.model ? [options.model] : plannerModels(llm)
  if (models.length === 0) {
    return {
      plan: null,
      calls: [],
      elapsedMs: Date.now() - startedAt,
      error: "no-planner-model-available",
    }
  }

  const systemPrompt =
    round === 1 ? SYSTEM_PROMPT_ROUND1 : mode === "deeper" ? SYSTEM_PROMPT_ROUND2_DEEPER : SYSTEM_PROMPT_ROUND2_WIDER

  const userPrompt = buildUserPrompt(query, context, { round, mode, priorPlan, priorResults, priorVariants })

  // Each attempt has its own deadline, and only the total cap ends the loop: one shared deadline let a slow first
  // model starve every later one (@cto 19102a36, @ag/llm/29473).
  const deadline = startedAt + timeoutMs * PLANNER_ATTEMPT_CAP
  let rawResponse = ""
  const calls: LlmCostCall[] = []
  const costFields = (): LlmCostFields =>
    llm.serializeCost(llm.aggregateCosts(calls.map((call) => llm.resolveResponseCost(call))))
  let lastModel: LlmModel | undefined
  const failures: Array<{ modelId: string; error: string }> = []

  for (const model of models.slice(0, PLANNER_ATTEMPT_CAP)) {
    const left = deadline - Date.now()
    if (left <= 0) break
    lastModel = model

    const attempt = new AbortController()
    const budgetMs = Math.min(timeoutMs, left)
    const timer = setTimeout(() => attempt.abort(), budgetMs)
    let result
    try {
      result = await llm.queryModel({
        question: userPrompt,
        model,
        systemPrompt,
        abortSignal: attempt.signal,
      })
    } catch (error) {
      const message = attemptFailure(llm, model, error, attempt.signal, budgetMs)
      log(`planner: ${model.modelId} failed (${message})`)
      failures.push({ modelId: model.modelId, error: message })
      calls.push(llmCostCall(model, { error: error instanceof Error ? error.message : String(error) }))
      continue
    } finally {
      clearTimeout(timer)
    }

    calls.push(llmCostCall(model, result.response))
    if (result.response.error) {
      const message = attemptFailure(llm, model, result.response.error, attempt.signal, budgetMs)
      log(`planner: ${model.modelId} failed (${message})`)
      failures.push({ modelId: model.modelId, error: message })
      continue
    }

    rawResponse = result.response.content ?? ""

    const parsed = parsePlanResult(rawResponse)
    if (parsed.plan) {
      return {
        plan: parsed.plan,
        model: model.modelId,
        elapsedMs: Date.now() - startedAt,
        calls,
        ...costFields(),
        rawResponse,
      }
    }
    const error = parsed.error ?? parsed.reason
    log(`planner: ${model.modelId} returned no usable plan (${error})`)
    failures.push({ modelId: model.modelId, error })
  }

  return {
    plan: null,
    model: lastModel?.modelId,
    elapsedMs: Date.now() - startedAt,
    calls,
    ...costFields(),
    rawResponse,
    error:
      failures.length === 1
        ? failures[0]?.error
        : failures.length > 1
          ? failures.map((failure) => `${failure.modelId}: ${failure.error}`).join("; ")
          : "planner-timeout",
  }
}

/**
 * Flatten a plan into a deduped, normalized list of FTS queries.
 * Phrases get wrapped in quotes so FTS5 treats them as exact matches.
 * Bead IDs are emitted verbatim (toFts5Query already handles them).
 */
export function planVariants(plan: QueryPlan): string[] {
  const out = new Set<string>()
  const add = (v: string) => {
    const trimmed = v.trim()
    if (trimmed.length >= 2) out.add(trimmed)
  }

  for (const k of plan.keywords) add(k)
  for (const p of plan.phrases) {
    // Wrap multi-word phrases in quotes; leave single-word through as-is
    if (/\s/.test(p.trim())) add(`"${p.trim()}"`)
    else add(p)
  }
  for (const c of plan.concepts) add(c)
  for (const p of plan.paths) add(p)
  for (const e of plan.errors) {
    // Exact error strings benefit from phrase quoting
    if (/\s/.test(e.trim())) add(`"${e.trim()}"`)
    else add(e)
  }
  for (const b of plan.bead_ids) add(b)

  return [...out]
}

// ============================================================================
// Internals
// ============================================================================

// The planner runs only the planner models BUDGETED_MODEL_IDS declares (@cto 967ea2db, ba46468c): a slow first model
// shares the one deadline with every later one, so a Google call through the agy one-shot starved the fallback.
function plannerModels(llm: LlmBackend): LlmModel[] {
  return selectBudgetedModels(llm, "planner").models
}

/**
 * One failed attempt's cause. When the planner's own deadline aborted it, that is the cause, whatever words the
 * provider wrapped around the abort ("dispatch failed … matched none of the known failure classes", 29473 receipt).
 */
function attemptFailure(
  llm: LlmBackend,
  model: LlmModel,
  error: unknown,
  signal: AbortSignal,
  budgetMs: number,
): string {
  if (signal.aborted) return `no answer within its ${budgetMs} ms attempt deadline`
  return providerError(llm, model, error)
}

function providerError(llm: LlmBackend, model: LlmModel, error: unknown): string {
  return llm.formatProviderError?.(model, error) ?? (error instanceof Error ? error.message : String(error))
}

function buildUserPrompt(
  query: string,
  context: QueryContext,
  opts: {
    round: 1 | 2
    mode?: "wider" | "deeper"
    priorPlan?: QueryPlan
    priorResults: RecallSearchResult[]
    priorVariants: string[]
  },
): string {
  const { round, mode, priorPlan, priorResults, priorVariants } = opts
  const parts: string[] = []

  parts.push(`USER QUERY: ${query}`)
  parts.push("")
  parts.push("PROJECT CONTEXT:")
  parts.push(renderContextPrompt(context))

  if (round === 2) {
    parts.push("")
    parts.push(`ROUND 2 (${mode ?? "wider"})`)
    parts.push("")

    if (priorVariants.length > 0) {
      parts.push("Round 1 variants already tried (do NOT repeat these):")
      for (const v of priorVariants) parts.push(`  ${v}`)
      parts.push("")
    }

    if (priorResults.length > 0) {
      parts.push("Round 1 top results (mine these for new keywords):")
      for (const r of priorResults.slice(0, 5)) {
        const sess = r.sessionTitle ? `${r.sessionTitle}` : r.sessionId.slice(0, 8)
        const snippet = r.snippet.replace(/>>>/g, "").replace(/<<</g, "").replace(/\s+/g, " ").trim().slice(0, 400)
        parts.push(`  [${r.type}] ${sess}: ${snippet}`)
      }
      parts.push("")
    } else {
      parts.push("Round 1 returned ZERO results. Round 2 must cast wider — try fundamentally different angles.")
      parts.push("")
    }

    if (priorPlan?.notes) {
      parts.push(`Round 1 notes: ${priorPlan.notes}`)
      parts.push("")
    }
  }

  parts.push("")
  parts.push("Return ONLY the JSON object described in the system prompt.")
  return parts.join("\n")
}

export type PlanParseReason = "empty-input" | "parse-failed" | "empty-plan"

/**
 * Parse the planner response with a typed failure reason. Distinguishes:
 *  - `parse-failed`: JSON malformed, missing or without recognized buckets → planner output was broken
 *  - `empty-plan`: JSON parsed fine but all buckets were empty → planner had
 *    nothing new to add (legitimate in round 2 when everything useful was
 *    already tried in round 1)
 */
export function parsePlanResult(
  raw: string,
): { plan: QueryPlan } | { plan: null; reason: PlanParseReason; error?: string } {
  if (!raw) return { plan: null, reason: "empty-input" }

  // Strip code fences
  let text = raw.trim()
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")

  // Find first JSON object
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return { plan: null, reason: "parse-failed" }
  const jsonStr = text.slice(start, end + 1)

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    return { plan: null, reason: "parse-failed" }
  }

  if (!parsed || typeof parsed !== "object") return { plan: null, reason: "parse-failed" }
  const obj = parsed as Record<string, unknown>
  if (!PLAN_BUCKET_KEYS.some((key) => Object.hasOwn(obj, key))) {
    return {
      plan: null,
      reason: "parse-failed",
      error: `parse-failed: planner response shape miss; expected bucket keys ${PLAN_BUCKET_KEYS.join(", ")}; saw keys: ${Object.keys(obj).join(", ") || "(none)"}`,
    }
  }

  const asStringArray = (v: unknown): string[] => {
    if (!Array.isArray(v)) return []
    return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim())
  }

  const plan: QueryPlan = {
    keywords: asStringArray(obj.keywords),
    phrases: asStringArray(obj.phrases),
    concepts: asStringArray(obj.concepts),
    paths: asStringArray(obj.paths),
    errors: asStringArray(obj.errors),
    bead_ids: asStringArray(obj.bead_ids),
    time_hint: typeof obj.time_hint === "string" && obj.time_hint.trim().length > 0 ? obj.time_hint.trim() : null,
    notes: typeof obj.notes === "string" ? obj.notes.trim() : undefined,
  }

  // Well-formed but empty — legitimate in round-2 when the planner has no
  // new angle to suggest. Distinct from a parse failure.
  const total =
    plan.keywords.length +
    plan.phrases.length +
    plan.concepts.length +
    plan.paths.length +
    plan.errors.length +
    plan.bead_ids.length
  if (total === 0) return { plan: null, reason: "empty-plan" }

  return { plan }
}
