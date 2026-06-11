/**
 * LLM backend — pluggable host dependency (19273 standalone boundary).
 *
 * Model selection + querying live in bearly's `plugins/llm` — a multi-provider
 * toolkit with a heavyweight dependency tree (@ai-sdk/*, openai, ai) that does
 * NOT ship with standalone tribe. Hosts that have it point `TRIBE_LLM_DIR` at
 * that plugin's `src` directory (e.g. `~/Code/bearly/plugins/llm/src`).
 *
 * Without it, every LLM-optional feature (synthesis, planner, session
 * summaries, race benchmarks) degrades to its documented no-LLM path and says
 * so loudly ONCE on stderr — an enabled-but-impossible feature is a
 * misconfiguration, never a silent no-op. Features that REQUIRE the backend
 * call `requireLlm()` and throw.
 *
 * The dynamic imports use variable specifiers on purpose: tsc must not try to
 * resolve into a repo that may not be checked out.
 */

export type LlmModel = { provider: string; modelId: string }

export type LlmUsage = {
  promptTokens: number
  completionTokens: number
  estimatedCost?: number
}

export type LlmQueryResult = {
  response: {
    content?: string
    error?: string
    usage?: LlmUsage
  }
}

export type LlmQueryOpts = {
  question: string
  model: LlmModel
  systemPrompt?: string
  stream?: boolean
  abortSignal?: AbortSignal
}

export type LlmBackend = {
  queryModel: (opts: LlmQueryOpts) => Promise<LlmQueryResult>
  getModel: (idOrName: string) => LlmModel | undefined
  getCheapModel: () => LlmModel | undefined
  getCheapModels: (max?: number) => LlmModel[]
  estimateCost: (model: LlmModel, inputTokens?: number, outputTokens?: number) => number
  isProviderAvailable: (provider: string) => boolean
}

let probe: Promise<LlmBackend | null> | undefined
let warned = false

/**
 * Load the LLM backend from TRIBE_LLM_DIR. Cached after the first call.
 * Returns null (with a one-time stderr warning) when the backend is absent
 * or fails to load — callers take their documented no-LLM degrade path.
 */
export async function loadLlm(): Promise<LlmBackend | null> {
  if (probe !== undefined) return probe
  probe = (async () => {
    const dir = process.env.TRIBE_LLM_DIR
    if (!dir) {
      warnOnce("TRIBE_LLM_DIR is unset")
      return null
    }
    try {
      const [types, research, providers] = await Promise.all([
        import(`${dir}/lib/types.ts`),
        import(`${dir}/lib/research.ts`),
        import(`${dir}/lib/providers.ts`),
      ])
      return {
        queryModel: research.queryModel,
        getModel: types.getModel,
        getCheapModel: types.getCheapModel,
        getCheapModels: types.getCheapModels,
        estimateCost: types.estimateCost,
        isProviderAvailable: providers.isProviderAvailable,
      } as LlmBackend
    } catch (err) {
      warnOnce(`backend FAILED to load from TRIBE_LLM_DIR=${dir}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  })()
  return probe
}

/**
 * Load the LLM backend or throw. For features where the LLM is the product
 * (planner, synthesis explicitly requested) — never for opportunistic
 * enrichment.
 */
export async function requireLlm(feature: string): Promise<LlmBackend> {
  const llm = await loadLlm()
  if (!llm) {
    throw new Error(
      `${feature} requires an LLM backend, but none is available. ` +
        `Point TRIBE_LLM_DIR at a directory exposing lib/types.ts, lib/research.ts, lib/providers.ts ` +
        `(e.g. bearly's plugins/llm/src).`,
    )
  }
  return llm
}

function warnOnce(reason: string): void {
  if (warned) return
  warned = true
  process.stderr.write(
    `[recall:llm-backend] LLM backend unavailable (${reason}) — LLM features degrade to no-LLM paths\n`,
  )
}

/**
 * Display formatting for USD costs. Copied verbatim from bearly
 * plugins/llm/src/lib/types.ts — pure display logic duplicated so that
 * sync formatting call sites don't need the async backend probe.
 */
export function formatCost(cost: number): string {
  if (cost < 0.01) return `$${(cost * 100).toFixed(2)}¢`
  if (cost < 1) return `$${cost.toFixed(3)}`
  return `$${cost.toFixed(2)}`
}

/** Test seam: reset the cached probe + warning latch (vitest only). */
export function _resetLlmBackendForTests(): void {
  probe = undefined
  warned = false
}
