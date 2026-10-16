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

export type LlmModel = { provider: string; modelId: string; typicalLatencyMs?: number }

export type LlmProviderAvailabilityFact = {
  provider: string
  status: "available" | "refusing" | "unknown"
  source: string
  reason: string
  kind?: "credential-missing" | "auth" | "quota" | "rate-limited" | "transport" | "server-error"
  observedAt?: number
  expiresAt?: number
  retryAt?: number
}

export type LlmModelSelectionResult = {
  candidates: LlmModel[]
  selected: LlmModel[]
  excluded: Array<{
    model: LlmModel
    provider: string
    status: "refusing" | "excluded"
    source: string
    reason: string
    kind?: LlmProviderAvailabilityFact["kind"]
    ageMs?: number
  }>
  evidence: LlmProviderAvailabilityFact[]
}

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
  /** Resolved provider facts loaded from Bearly's shared observation store. */
  providerFacts?: readonly LlmProviderAvailabilityFact[]
  /** Bearly's pure availability-then-latency selector. Paired with providerFacts. */
  selectModels?: (options: {
    candidates?: readonly LlmModel[]
    facts: readonly LlmProviderAvailabilityFact[]
    now: number
    exclude?: Iterable<string>
    distinctProviders?: boolean
    limit: number
  }) => LlmModelSelectionResult
  /**
   * Optional richer diagnostic for WHY `isProviderAvailable(provider)` is
   * false — "no API key" vs "key present but explicitly denied via
   * RECALL_LLM_DENY_PROVIDERS". Used by synthesize.ts to build a "considered
   * and excluded, here's why" report on failure (§ Fail Loud: what I
   * queried, where I looked, what I excluded). Optional because hand-built
   * test/mock backends don't need to implement it — callers must handle its
   * absence with a generic fallback message.
   */
  explainUnavailable?: (provider: string) => string
  /**
   * Optional shared error-classification voice — bearly's
   * `describeDispatchFailure`, the SAME structured owner /pro uses for its
   * own leg failures. Turns a raw provider error (insufficient_quota, model
   * renamed, timeout, ...) into one actionable line. Routing recall's
   * per-attempt errors through this means /pro and recall never give
   * conflicting advice for the same underlying failure — recall no longer
   * has to hand-roll "check provider credentials" text that's wrong for a
   * timeout. Optional for the same reason as explainUnavailable above.
   */
  formatProviderError?: (model: LlmModel, error: unknown) => string
  /**
   * The model ids for whichever budgeted call (planner or synthesis race) a hand-built backend exercises. Bearly's
   * backend never sets it, so recall uses that caller's entry in {@link BUDGETED_MODEL_IDS}; a test names its own
   * models to exercise the race and the fallback, the same reason explainUnavailable is optional.
   */
  budgetedModelIds?: readonly string[]
}

export type CheapModelSelectionOrder = "preferred" | "registry"

export type RejectedCheapModel = LlmModel & {
  reason: string
  status?: "refusing" | "excluded"
  kind?: LlmProviderAvailabilityFact["kind"]
  ageMs?: number
}

export type CheapModelSelection = {
  models: LlmModel[]
  rejected: RejectedCheapModel[]
  order: string
  failure: string | null
}

export type CheapModelResolution =
  | { backend: LlmBackend; model: LlmModel; failure: null }
  | { backend: null; model: null; failure: string }

/**
 * Select live cheap models without letting an unavailable leader hide later
 * candidates. Singular callers retain the existing getCheapModel() preference;
 * race callers retain getCheapModels() registry order. The result limit is
 * applied only after every registered candidate has been availability-checked.
 */
export function selectAvailableCheapModels(
  llm: LlmBackend,
  opts: {
    limit?: number
    order?: CheapModelSelectionOrder
    candidates?: readonly LlmModel[]
    includeRegistryFallback?: boolean
  } = {},
): CheapModelSelection {
  const limit = opts.limit ?? 1
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`Cheap model selection limit must be a positive integer; received ${limit}`)
  }

  const selectionOrder = opts.order ?? "preferred"
  const includeRegistryFallback = opts.includeRegistryFallback ?? true
  const baseOrder =
    selectionOrder === "preferred"
      ? "getCheapModel() first, then remaining getCheapModels() registry order"
      : "getCheapModels() registry order"
  const order = opts.candidates
    ? includeRegistryFallback
      ? `caller candidates first, then ${baseOrder}`
      : "caller candidates only"
    : baseOrder
  const candidates: LlmModel[] = []
  const seenProviders = new Set<string>()
  const add = (model: LlmModel | undefined): void => {
    if (!model || seenProviders.has(model.provider)) return
    seenProviders.add(model.provider)
    candidates.push(model)
  }

  for (const model of opts.candidates ?? []) add(model)
  if (includeRegistryFallback) {
    if (selectionOrder === "preferred") add(llm.getCheapModel())
    for (const model of llm.getCheapModels(Number.MAX_SAFE_INTEGER)) add(model)
  }

  const hasSharedSelector = llm.selectModels !== undefined
  const hasSharedFacts = llm.providerFacts !== undefined
  if (hasSharedSelector !== hasSharedFacts) {
    throw new Error(
      `LLM backend provider-health surface is incomplete: selectModels=${String(hasSharedSelector)}, providerFacts=${String(hasSharedFacts)}`,
    )
  }
  if (llm.selectModels && llm.providerFacts) {
    const shared = llm.selectModels({
      candidates,
      facts: llm.providerFacts,
      now: Date.now(),
      distinctProviders: true,
      limit,
    })
    const models = shared.selected
    const rejected: RejectedCheapModel[] = shared.excluded.map((entry) => ({
      ...entry.model,
      reason: entry.reason,
      status: entry.status,
      ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
      ...(entry.ageMs !== undefined ? { ageMs: entry.ageMs } : {}),
    }))
    const sharedOrder = `${order}; shared facts rank available before unknown, then typicalLatencyMs`
    const failure =
      models.length > 0
        ? null
        : candidates.length === 0
          ? `No cheap LLM provider is available; no candidates were returned (queried in ${sharedOrder})`
          : `No cheap LLM provider is available; tried in ${sharedOrder}: ${rejected
              .map((model) => `${model.modelId} (${model.provider}): ${model.reason}`)
              .join("; ")}`
    return { models, rejected, order: sharedOrder, failure }
  }

  const models: LlmModel[] = []
  const rejected: RejectedCheapModel[] = []
  for (const model of candidates) {
    if (llm.isProviderAvailable(model.provider)) {
      if (models.length < limit) models.push(model)
      continue
    }
    rejected.push({
      ...model,
      reason: llm.explainUnavailable?.(model.provider) ?? "provider reported unavailable; backend supplied no reason",
    })
  }

  const failure =
    models.length > 0
      ? null
      : candidates.length === 0
        ? `No cheap LLM provider is available; no candidates were returned (queried in ${order})`
        : `No cheap LLM provider is available; tried in ${order}: ${rejected
            .map((model) => `${model.modelId} (${model.provider}): ${model.reason}`)
            .join("; ")}`

  return { models, rejected, order, failure }
}

/**
 * The models each of recall's budgeted LLM calls may use: the planner (DEFAULT_PLAN_TIMEOUT_MS per attempt) and the
 * synthesis race (DEFAULT_SYNTHESIS_TIMEOUT_MS). It declares membership only, edited by hand and never by a runtime
 * latency selector. The shared selector decides availability and order, and within one race batch order does not
 * matter, since raceLlmModels starts every model at once. If a caller ever declares a sequence of two or more, its order
 * is a question for the shared selector's owner; never re-sort here (@cto 5beb3255).
 *
 * The rule (@cto 967ea2db, ba46468c): a provider a budgeted call depends on, alone or tried in sequence, must answer
 * inside the budget at p95, because a slow one burns it. A second racer in the same batch as a measured primary cannot
 * delay the primary, so it qualifies instead on three measured facts: it adds no latency (same batch, the full budget,
 * the loser killed), its answer rate inside the budget at production load, and its call cost.
 * - deepseek-chat through OpenRouter (@ag/llm/29473): planned in 5.6 to 13.8 s over 20 calls, synthesized in 4.3 to
 *   11.4 s over 10 calls.
 * - gemini-2.5-flash through the agy one-shot, synthesis only (@ag/llm/29520's corrected receipt): 14 of 20 answered
 *   inside 20 s at host load 32 to 42, p95 20.3 s; when deepseek wins, the agy child is killed within 0.5 s. It answered
 *   0 of 20 planner calls inside 14 s, so the planner stays on deepseek alone.
 *
 * Synthesis holds exactly two. synthesizeResults races two per batch and splits the remaining budget across batches,
 * so a third entry would make a second batch and halve each batch's time. A second OpenRouter model is no second
 * route, since one 429 refuses every OpenRouter model for 10 minutes (@ag/llm/29495).
 */
export const BUDGETED_MODEL_IDS: Readonly<Record<"planner" | "synthesis", readonly string[]>> = {
  planner: ["deepseek/deepseek-chat"],
  synthesis: ["deepseek/deepseek-chat", "gemini-2.5-flash"],
}

/** {@link selectAvailableCheapModels} over one caller's {@link BUDGETED_MODEL_IDS} only: no registry fallback adds a model. */
export function selectBudgetedModels(llm: LlmBackend, caller: keyof typeof BUDGETED_MODEL_IDS): CheapModelSelection {
  const candidates = (llm.budgetedModelIds ?? BUDGETED_MODEL_IDS[caller]).map((id) => {
    const model = llm.getModel(id)
    if (!model) throw new Error(`recall's budgeted model ${id} is not in the LLM registry (@ag/llm/29473)`)
    return model
  })
  return selectAvailableCheapModels(llm, {
    candidates,
    includeRegistryFallback: false,
    limit: Number.MAX_SAFE_INTEGER,
    order: "registry",
  })
}

/** Single-model projection shared by session, daily, and weekly summaries. */
export function resolveAvailableCheapModel(llm: LlmBackend | null): CheapModelResolution {
  if (!llm) {
    return {
      backend: null,
      model: null,
      failure: "No LLM backend is configured (TRIBE_LLM_DIR unset or failed to load)",
    }
  }
  const selection = selectAvailableCheapModels(llm)
  const model = selection.models[0]
  if (model) return { backend: llm, model, failure: null }
  if (!selection.failure) {
    throw new Error("Cheap model selection returned no model without an exhaustive failure report")
  }
  return { backend: null, model: null, failure: selection.failure }
}

let probe: Promise<LlmBackend | null> | undefined
let warned = false

// Structural shape for @bearly/llm's public barrel. The import specifier is
// runtime-variable (see the docstring above), so TS cannot infer it.
type LlmBarrelModule = Pick<
  LlmBackend,
  "queryModel" | "getModel" | "getCheapModel" | "getCheapModels" | "estimateCost"
> & {
  isProviderAvailable: (provider: string) => boolean
  createProviderObservationStore: () => unknown
  readProviderAvailability: (
    provider: string,
    options: { store: unknown; now: number; env?: Readonly<Record<string, string | undefined>> },
  ) => Promise<LlmProviderAvailabilityFact>
  selectModels: NonNullable<LlmBackend["selectModels"]>
  describeDispatchFailure: (
    error: unknown,
    target: { modelId: string; provider: string; displayName: string },
  ) => { message: string }
}

const REQUIRED_LLM_BARREL_FUNCTIONS = [
  "queryModel",
  "getModel",
  "getCheapModel",
  "getCheapModels",
  "estimateCost",
  "isProviderAvailable",
  "createProviderObservationStore",
  "readProviderAvailability",
  "selectModels",
  "describeDispatchFailure",
] as const

function assertLlmBarrel(module: unknown): asserts module is LlmBarrelModule {
  const record = module && typeof module === "object" ? (module as Record<string, unknown>) : {}
  const missing = REQUIRED_LLM_BARREL_FUNCTIONS.filter((name) => typeof record[name] !== "function")
  if (missing.length > 0) {
    throw new Error(`@bearly/llm public barrel is missing required function exports: ${missing.join(", ")}`)
  }
}

/**
 * Split a comma-separated provider list into a lowercase set. Empty/unset
 * input yields the shared empty set (no allocation on the common path).
 */
export function parseDeniedProviders(raw: string | undefined): ReadonlySet<string> {
  if (!raw?.trim()) return EMPTY_DENY_SET
  const set = new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  )
  return set.size > 0 ? set : EMPTY_DENY_SET
}

const EMPTY_DENY_SET: ReadonlySet<string> = new Set()

/**
 * Bridge Bearly's public structured failure describer into Recall's model
 * shape. `displayName` is not part of Recall's model type, so modelId is a
 * safe stand-in for the compatibility renderer.
 */
export function buildFormatProviderError(
  mod: {
    describeDispatchFailure?: (
      error: unknown,
      model: { modelId: string; provider: string; displayName: string },
    ) => { message: string }
  } | null,
): ((model: LlmModel, error: unknown) => string) | undefined {
  const describe = mod?.describeDispatchFailure
  if (!describe) return undefined
  return (model: LlmModel, error: unknown): string => describe(error, { ...model, displayName: model.modelId }).message
}

/**
 * Load the LLM backend from TRIBE_LLM_DIR. Cached after the first call.
 * Returns null (with a one-time stderr warning) when the backend is absent
 * or fails to load — callers take their documented no-LLM degrade path.
 *
 * Provider facts are loaded from Bearly's public barrel and shared
 * observation store. `RECALL_LLM_DENY_PROVIDERS` remains a temporary host
 * policy input, but is passed to the selector as an explicit exclusion set;
 * it no longer falsifies the source-compatible credential-presence boolean.
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
      const bearly: unknown = await import(`${dir}/index.ts`)
      assertLlmBarrel(bearly)
      const denied = parseDeniedProviders(process.env.RECALL_LLM_DENY_PROVIDERS)
      if (denied.size > 0) {
        process.stderr.write(`[recall:llm-backend] RECALL_LLM_DENY_PROVIDERS excludes: ${[...denied].join(", ")}\n`)
      }
      const candidates = bearly.getCheapModels(Number.MAX_SAFE_INTEGER)
      const providers = [...new Set(candidates.map((model) => model.provider))]
      const observationStore = bearly.createProviderObservationStore()
      const providerFacts = await Promise.all(
        providers.map((provider) =>
          bearly.readProviderAvailability(provider, {
            store: observationStore,
            now: Date.now(),
          }),
        ),
      )
      const refreshProviderFact = async (provider: string): Promise<void> => {
        const fact = await bearly.readProviderAvailability(provider, {
          store: observationStore,
          now: Date.now(),
        })
        const index = providerFacts.findIndex((candidate) => candidate.provider === provider)
        if (index === -1) providerFacts.push(fact)
        else providerFacts[index] = fact
      }
      return {
        queryModel: async (options) => {
          const result = await bearly.queryModel(options)
          await refreshProviderFact(options.model.provider)
          return result
        },
        getModel: bearly.getModel,
        getCheapModel: bearly.getCheapModel,
        getCheapModels: bearly.getCheapModels,
        estimateCost: bearly.estimateCost,
        isProviderAvailable: bearly.isProviderAvailable,
        providerFacts,
        selectModels: (options) =>
          bearly.selectModels({
            ...options,
            exclude: new Set([...(options.exclude ?? []), ...denied]),
          }),
        // Legacy compatibility only. Shared selection reads providerFacts;
        // this explanation keeps older injected backends loud.
        explainUnavailable: (provider: string): string => {
          const lower = provider.toLowerCase()
          if (denied.has(lower)) {
            return (
              `denied via RECALL_LLM_DENY_PROVIDERS=${[...denied].join(",")} ` +
              `(host override — the API key may be present, but this provider was flagged broken on this host)`
            )
          }
          const fact = providerFacts.find((candidate) => candidate.provider === provider)
          return fact?.reason ?? `no provider fact available for "${provider}"`
        },
        formatProviderError: buildFormatProviderError(bearly),
      } as LlmBackend
    } catch (err) {
      warnOnce(`backend FAILED to load from TRIBE_LLM_DIR=${dir}: ${err instanceof Error ? err.message : String(err)}`)
      // silent-fallback-allow: loud-by-design — warnOnce() above logs the load
      // failure once per process; null is the documented no-LLM degrade mode.
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
        `Point TRIBE_LLM_DIR at @bearly/llm's src directory exposing its public index.ts barrel ` +
        `(queryModel, provider facts/store, selectModels, and describeDispatchFailure).`,
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

/** Synchronous display formatting for USD costs. */
export function formatCost(cost: number): string {
  if (cost < 0.01) return `$${(cost * 100).toFixed(2)}¢`
  if (cost < 1) return `$${cost.toFixed(3)}`
  return `$${cost.toFixed(2)}`
}
