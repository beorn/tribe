/**
 * synthesize.ts - LLM synthesis: sending search results to LLM for summarization,
 * racing multiple models, and extracting lessons from session transcripts.
 */

import * as fs from "fs"
import * as path from "path"
import { loadLlm, requireLlm, selectAvailableCheapModels, type LlmBackend, type LlmModel } from "../lib/llm-backend.ts"
import { log, SynthesisFailure, suggestRetryTimeoutMs } from "./recall-shared.ts"
import type {
  RecallSearchResult,
  SynthesisAttempt,
  SynthesisBatchAccounting,
  ExcludedProvider,
} from "./recall-shared.ts"

// ============================================================================
// Synthesis prompt
// ============================================================================

export const SYNTHESIS_PROMPT = `You are a knowledge retrieval assistant. Given search results from prior Claude Code sessions, synthesize the most useful information.

Extract and present:
- Decisions made and their rationale
- Approaches tried (including what failed and why)
- Key file paths and code patterns mentioned
- Warnings, caveats, or lessons learned
- Any unresolved issues or open questions

Rules:
- Be concise: 3-8 bullet points maximum
- Use plain text, no markdown headers
- Include specific file paths when mentioned
- If the results aren't relevant to the query, say "No relevant prior knowledge found."
- Do NOT invent information not present in the search results`

// ============================================================================
// LLM Race Infrastructure
// ============================================================================

export interface LlmRaceModelResult {
  model: string
  ms: number
  status: "ok" | "timeout" | "error"
  error?: string
  tokens?: { input: number; output: number }
  cost?: number // USD
}

export interface LlmRaceResult {
  winner: string | null
  text: string | null
  cost?: number
  timedOut: boolean
  totalMs: number
  perModel: LlmRaceModelResult[]
  totalCost: number // sum of ALL models called (winner + losers)
}

/**
 * Turn a raw failure into one actionable line via the SAME classifier /pro
 * uses for its own leg errors (bearly's formatLegDispatchError, bridged
 * through llm.formatProviderError) — so recall and /pro never give
 * conflicting advice for the same underlying failure (quota exhausted,
 * model renamed, timeout: none of these are "check your credentials").
 * Falls back to the raw message when the shared formatter isn't available
 * (older TRIBE_LLM_DIR, or a hand-built test backend).
 */
function formatAttemptError(llm: LlmBackend, model: LlmModel, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return llm.formatProviderError?.(model, error instanceof Error ? error : new Error(raw)) ?? raw
}

/**
 * Race multiple LLM models — first valid response wins.
 * Returns per-model timing diagnostics regardless of outcome.
 */
export async function raceLlmModels(
  context: string,
  systemPrompt: string,
  models: LlmModel[],
  timeoutMs: number,
  llmOverride?: LlmBackend,
): Promise<LlmRaceResult> {
  // Models in hand imply the backend already loaded — this resolves from cache.
  const llm = llmOverride ?? (await requireLlm("raceLlmModels"))
  const raceStart = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // Pair each model with its own result slot up front — avoids indexing
  // back into a parallel array (models[i] / modelResults[i]) later, which
  // TS can't prove in-bounds without a non-null assertion.
  const paired: { model: LlmModel; mr: LlmRaceModelResult }[] = models.map((model) => ({
    model,
    mr: { model: model.modelId, ms: 0, status: "timeout" },
  }))
  const modelResults: LlmRaceModelResult[] = paired.map(({ mr }) => mr)

  // Race all models
  const racePromises = paired.map(async ({ model, mr }) => {
    let result
    try {
      result = await llm.queryModel({
        question: context,
        model,
        systemPrompt,
        abortSignal: controller.signal,
      })
    } catch (error) {
      mr.ms = Date.now() - raceStart
      mr.status = "error"
      mr.error = formatAttemptError(llm, model, error)
      return null
    }

    mr.ms = Date.now() - raceStart

    // Track tokens + compute cost from actual usage
    const usage = result.response.usage
    if (usage) {
      mr.tokens = { input: usage.promptTokens, output: usage.completionTokens }
      mr.cost = llm.estimateCost(model, usage.promptTokens, usage.completionTokens)
    }

    // queryModel catches errors internally — check for abort/error
    if (controller.signal.aborted) {
      mr.status = "timeout"
      mr.error = formatAttemptError(llm, model, new Error(`timed out after ${mr.ms}ms (given ${timeoutMs}ms)`))
      return null
    }
    if (result.response.error) {
      mr.status = "error"
      mr.error = formatAttemptError(llm, model, result.response.error)
      return null
    }

    const content = result.response.content
    if (!content) {
      mr.status = "error"
      mr.error = "empty response"
      return null
    }

    mr.status = "ok"
    return {
      text: content,
      cost: mr.cost,
      model: model.modelId,
    }
  })

  try {
    const winner = await Promise.any(
      racePromises.map((p) =>
        p.then((r) => {
          if (!r) throw new Error("empty")
          clearTimeout(timer)
          controller.abort()
          return r
        }),
      ),
    )

    const totalCost = modelResults.reduce((s, m) => s + (m.cost ?? 0), 0)
    return {
      winner: winner.model,
      text: winner.text,
      cost: winner.cost,
      timedOut: false,
      totalMs: Date.now() - raceStart,
      perModel: modelResults,
      totalCost,
    }
  } catch {
    clearTimeout(timer)
    controller.abort()
    const totalMs = Date.now() - raceStart
    const totalCost = modelResults.reduce((s, m) => s + (m.cost ?? 0), 0)
    return {
      winner: null,
      text: null,
      timedOut: totalMs >= timeoutMs - 50,
      totalMs,
      perModel: modelResults,
      totalCost,
    }
  }
}

// ============================================================================
// LLM synthesis (internal)
// ============================================================================

export interface SynthesisResult {
  text: string
  cost?: number
  aborted?: boolean
}

export async function synthesizeResults(
  query: string,
  results: RecallSearchResult[],
  timeoutMs: number,
  llmOverride?: LlmBackend,
): Promise<SynthesisResult> {
  const llm = llmOverride ?? (await loadLlm())
  if (!llm) {
    log(`no LLM backend (TRIBE_LLM_DIR) — synthesis skipped`)
    const summary = `No LLM backend configured (TRIBE_LLM_DIR unset). ${resultCountPhrase(results.length)}; rerun with --raw to see them without an LLM.`
    throw new SynthesisFailure(summary, {
      summary,
      totalBudgetMs: timeoutMs,
      attempts: [],
      batches: [],
      excludedProviders: [],
      consideredProviders: [],
    })
  }

  // Full candidate list BEFORE filtering — kept around so a failure report
  // can name every provider that was considered, not just the ones that
  // survived isProviderAvailable.
  const candidates = llm.getCheapModels(Number.MAX_SAFE_INTEGER)
  const models = candidates.filter((model) => llm.isProviderAvailable(model.provider))
  const excludedProviders: ExcludedProvider[] = candidates
    .filter((model) => !llm.isProviderAvailable(model.provider))
    .map((model) => ({
      provider: model.provider,
      modelId: model.modelId,
      reason: llm.explainUnavailable?.(model.provider) ?? "unavailable (this LLM backend gives no further detail)",
    }))

  if (models.length === 0) {
    log(`no LLM providers available for synthesis`)
    const summary = `No LLM provider is available (see Excluded below for why). ${resultCountPhrase(results.length)}; rerun with --raw to see them without an LLM.`
    throw new SynthesisFailure(summary, {
      summary,
      totalBudgetMs: timeoutMs,
      attempts: [],
      batches: [],
      excludedProviders,
      consideredProviders: [],
    })
  }

  const context = formatResultsForLlm(query, results)
  const deadline = Date.now() + timeoutMs
  const attempts: SynthesisAttempt[] = []
  const batches: SynthesisBatchAccounting[] = []
  let deadlineExceeded = false
  let totalCost = 0

  for (let offset = 0; offset < models.length; offset += 2) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      deadlineExceeded = true
      break
    }

    // Fair-share the remaining budget across the batches still ahead —
    // recomputed every iteration, not a fixed up-front split. A batch that
    // fails FAST (auth/quota errors return in milliseconds) hands its
    // unused time forward; a batch that fails SLOW (retries eating most of
    // the timeout) can no longer burn the entire remaining budget and
    // starve every batch after it. Previously a batch's own race used
    // `remainingMs` — the WHOLE rest of the deadline — as its timeout, so
    // two doomed providers racing first could spend 8s of a 10s budget and
    // leave the only live provider 1.7s, structurally unwinnable.
    const batchesRemaining = Math.ceil((models.length - offset) / 2)
    const batchTimeoutMs = Math.max(1, Math.floor(remainingMs / batchesRemaining))

    const batch = models.slice(offset, offset + 2)
    const modelNames = batch.map((model) => model.modelId).join(", ")
    log(
      `LLM synthesis: racing [${modelNames}] context=${context.length} chars timeout=${batchTimeoutMs}ms ` +
        `(${remainingMs}ms budget / ${batchesRemaining} batch${batchesRemaining === 1 ? "" : "es"} left)`,
    )
    const race = await raceLlmModels(context, SYNTHESIS_PROMPT, batch, batchTimeoutMs, llm)
    totalCost += race.totalCost

    batches.push({
      modelIds: batch.map((model) => model.modelId),
      budgetAtStartMs: remainingMs,
      allocatedMs: batchTimeoutMs,
      elapsedMs: race.totalMs,
      timedOut: race.timedOut,
    })
    for (const pm of race.perModel) {
      const model = batch.find((m) => m.modelId === pm.model)
      attempts.push({
        modelId: pm.model,
        provider: model?.provider ?? "unknown",
        status: pm.status,
        error: pm.error,
        elapsedMs: pm.ms,
        timeoutMs: batchTimeoutMs,
      })
    }

    if (race.winner && race.text) {
      log(`LLM winner: ${race.winner} in ${race.totalMs}ms`)
      return { text: race.text, cost: totalCost, aborted: false }
    }

    log(
      `LLM synthesis ${race.timedOut ? "hit its batch-share timeout" : "failed"} after ${race.totalMs}ms (models: [${modelNames}])`,
    )
    // Note: race.timedOut only means THIS batch used up its fair share, not
    // that the overall deadline is gone — the top-of-loop check above is
    // the sole authority on that, so we always fall through to the next
    // batch rather than breaking here.
  }

  const timedOut = deadlineExceeded || Date.now() >= deadline
  // One sentence: what happened (model named once), what the caller has
  // (result count), what to do next (one concrete command). Every other
  // fact — per-attempt errors, budget accounting, exclusions — lives in
  // SynthesisDiagnostics and is rendered separately, below this line; this
  // string is read once and acted on, not a log dump.
  const summary = buildFailureSummary({ resultCount: results.length, attempts, timeoutMs, timedOut })
  throw new SynthesisFailure(summary, {
    summary,
    totalBudgetMs: timeoutMs,
    attempts,
    batches,
    excludedProviders,
    consideredProviders: models.map((model) => model.provider),
  })
}

function resultCountPhrase(resultCount: number): string {
  return `Your ${resultCount} search result${resultCount === 1 ? "" : "s"} ${resultCount === 1 ? "is" : "are"} below`
}

function buildFailureSummary(opts: {
  resultCount: number
  attempts: SynthesisAttempt[]
  timeoutMs: number
  timedOut: boolean
}): string {
  const { resultCount, attempts, timeoutMs, timedOut } = opts
  const budgetS = Math.round(timeoutMs / 1000)
  const allTimedOut = attempts.length > 0 && attempts.every((a) => a.status === "timeout")

  if (timedOut && allTimedOut) {
    const suggested = suggestRetryTimeoutMs(timeoutMs, attempts)
    const firstAttempt = attempts[0]
    const who =
      attempts.length === 1 && firstAttempt ? firstAttempt.modelId : `every provider tried (${attempts.length})`
    return (
      `Synthesis timed out — ${who} needed more than the ${budgetS}s budget. ` +
      `${resultCountPhrase(resultCount)}; rerun with --timeout ${suggested} to summarize them.`
    )
  }
  if (attempts.length > 0) {
    return (
      `Synthesis failed — see the attempts below for why. ` +
      `${resultCountPhrase(resultCount)}; rerun with --raw to see them without an LLM.`
    )
  }
  return (
    `Synthesis ${timedOut ? "timed out" : "failed"} before any provider could run. ` +
    `${resultCountPhrase(resultCount)}; rerun with --raw to see them without an LLM.`
  )
}

export function formatResultsForLlm(query: string, results: RecallSearchResult[]): string {
  const lines: string[] = [`Query: "${query}"`, "", `Found ${results.length} relevant results from prior sessions:`, ""]

  results.forEach((r, i) => {
    const date = new Date(r.timestamp).toISOString().split("T")[0]
    const sessionLabel = r.sessionTitle ? `${r.sessionTitle} (${r.sessionId.slice(0, 8)})` : r.sessionId.slice(0, 8)

    lines.push(`--- Result ${i + 1} [${r.type}] ${date} - ${sessionLabel} ---`)

    // Clean snippet markers
    const cleanSnippet = r.snippet.replace(/>>>/g, "").replace(/<<</g, "").trim()
    lines.push(cleanSnippet)
    lines.push("")
  })

  lines.push("---")
  lines.push("Synthesize the above results into concise, actionable bullet points relevant to the query.")

  return lines.join("\n")
}

// ============================================================================
// Remember: extract lessons from session transcript
// ============================================================================

export interface RememberOptions {
  transcriptPath: string
  sessionId: string
  memoryDir: string
}

export interface RememberResult {
  skipped: boolean
  reason?: string
  memoryFile?: string
  lessonsCount?: number
}

const REMEMBER_PROMPT = `Extract key lessons, decisions, bugs found, patterns learned, and warnings from this Claude Code session transcript. Output as concise bullet points. Skip routine operations (file reads, test runs, linting). Focus on:
- Decisions made and WHY
- Bugs found and their root causes
- Approaches that failed and why
- Architectural patterns or conventions discovered
- Warnings for future sessions

If nothing noteworthy was learned, respond with just: NONE`

/**
 * Extract lessons from a session transcript and append to a dated memory file.
 * Throws on actual errors (fail loud).
 */
export async function remember(options: RememberOptions): Promise<RememberResult> {
  const { transcriptPath, sessionId, memoryDir } = options
  const startTime = Date.now()

  log(`remember session=${sessionId.slice(0, 8)} transcript=${transcriptPath}`)

  if (!fs.existsSync(transcriptPath)) {
    log(`transcript not found: ${transcriptPath}`)
    return { skipped: true, reason: "transcript_not_found" }
  }

  // Extract last user+assistant messages from JSONL transcript
  const extractStart = Date.now()
  const { extractTranscriptMessages } = await import("./scanner")
  const messages = extractTranscriptMessages(transcriptPath)
  if (!messages) {
    log(`no user/assistant messages found in transcript (${Date.now() - extractStart}ms)`)
    return { skipped: true, reason: "no_messages" }
  }
  log(`extracted ${messages.length} chars from transcript (${Date.now() - extractStart}ms)`)

  // Check LLM availability
  const llm = await loadLlm()
  if (!llm) {
    log(`no LLM backend (TRIBE_LLM_DIR) — remember skipped`)
    return { skipped: true, reason: "no_llm_provider" }
  }
  const selection = selectAvailableCheapModels(llm)
  const model = selection.models[0]
  if (!model) {
    if (!selection.failure) {
      throw new Error("Remember model selection returned no model without an exhaustive failure report")
    }
    process.stderr.write(`[recall:remember] ${selection.failure}\n`)
    return { skipped: true, reason: "no_llm_provider" }
  }

  // Synthesize lessons
  const fullPrompt = `${REMEMBER_PROMPT}\n\nSession transcript (last messages):\n${messages}`
  log(`LLM synthesis: model=${model.modelId} provider=${model.provider} prompt=${fullPrompt.length} chars`)
  const llmStart = Date.now()
  const result = await llm.queryModel({ question: fullPrompt, model })
  const synthesis = result.response.content
  log(`LLM responded in ${Date.now() - llmStart}ms`)

  if (!synthesis || synthesis.trim().length === 0) {
    log(`empty synthesis from LLM`)
    return { skipped: true, reason: "empty_synthesis" }
  }

  if (/^NONE$/im.test(synthesis.trim())) {
    log(`LLM says nothing noteworthy (${Date.now() - startTime}ms total)`)
    return { skipped: true, reason: "nothing_noteworthy" }
  }

  // Ensure memory dir exists
  fs.mkdirSync(memoryDir, { recursive: true })

  // Append to dated memory file
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  const memoryFile = path.join(memoryDir, `${today}.md`)
  const time = new Date().toTimeString().slice(0, 5)
  const entry = `\n## Session ${sessionId.slice(0, 8)} (${time})\n\n${synthesis}\n`

  fs.appendFileSync(memoryFile, entry)

  const lessonsCount = (synthesis.match(/^[-*]/gm) || []).length
  log(`saved ${lessonsCount} lessons (${synthesis.length} chars) to ${memoryFile} (${Date.now() - startTime}ms total)`)

  return {
    skipped: false,
    memoryFile,
    lessonsCount,
  }
}
