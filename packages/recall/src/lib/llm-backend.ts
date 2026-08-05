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
   * `formatLegDispatchError`, the SAME formatter /pro uses for its own leg
   * failures. Turns a raw provider error (insufficient_quota, model
   * renamed, timeout, ...) into one actionable line. Routing recall's
   * per-attempt errors through this means /pro and recall never give
   * conflicting advice for the same underlying failure — recall no longer
   * has to hand-roll "check provider credentials" text that's wrong for a
   * timeout. Optional for the same reason as explainUnavailable above.
   */
  formatProviderError?: (model: LlmModel, error: unknown) => string
}

let probe: Promise<LlmBackend | null> | undefined
let warned = false

// Structural shapes for the three TRIBE_LLM_DIR modules — the import
// specifiers are runtime-variable (see the docstring above), so TS can't
// infer these; typing the destructure explicitly is what keeps the object
// literal below from going `any` end-to-end.
type TypesModule = Pick<LlmBackend, "getModel" | "getCheapModel" | "getCheapModels" | "estimateCost">
type ResearchModule = Pick<LlmBackend, "queryModel">
type ProvidersModule = {
  isProviderAvailable: (provider: string) => boolean
  getProviderEnvVar?: (provider: string) => string
}
type DispatchSafetyModule = {
  formatLegDispatchError?: (model: { modelId: string; provider: string; displayName: string }, error: unknown) => string
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
 * Wrap a raw `isProviderAvailable` so denied providers always read as
 * unavailable, regardless of key presence. A no-op wrapper (identity) when
 * the deny set is empty, so the common case pays no extra indirection.
 */
export function withProviderDenyList(
  isProviderAvailable: (provider: string) => boolean,
  denied: ReadonlySet<string>,
): (provider: string) => boolean {
  if (denied.size === 0) return isProviderAvailable
  return (provider: string) => !denied.has(provider.toLowerCase()) && isProviderAvailable(provider)
}

/**
 * Bridge bearly's `formatLegDispatchError` (shared with /pro) into recall's
 * `LlmModel` shape — `displayName` isn't part of recall's model type, but
 * `formatLegDispatchError` doesn't read it, so `modelId` is a safe stand-in.
 * Returns undefined when the dispatch-safety module didn't load (older
 * TRIBE_LLM_DIR, or the best-effort import failed) — callers fall back to
 * their own message.
 */
export function buildFormatProviderError(
  mod: {
    formatLegDispatchError?: (
      model: { modelId: string; provider: string; displayName: string },
      error: unknown,
    ) => string
  } | null,
): ((model: LlmModel, error: unknown) => string) | undefined {
  const format = mod?.formatLegDispatchError
  if (!format) return undefined
  return (model: LlmModel, error: unknown): string => format({ ...model, displayName: model.modelId }, error)
}

/**
 * Load the LLM backend from TRIBE_LLM_DIR. Cached after the first call.
 * Returns null (with a one-time stderr warning) when the backend is absent
 * or fails to load — callers take their documented no-LLM degrade path.
 *
 * `isProviderAvailable` from the underlying backend only checks key
 * presence, not whether the account actually works (quota-exhausted,
 * revoked, auth-broken keys all read as "available"). Recall has no live
 * health-probe to distinguish those cases, so `RECALL_LLM_DENY_PROVIDERS`
 * (comma-separated provider ids, e.g. "openai,xai") is an explicit,
 * host-set opt-out — every synthesis/plan/summarize model-selection path in
 * this package goes through this one `isProviderAvailable`, so setting it
 * once here fixes them all instead of each call site guessing.
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
      const [types, research, providers] = (await Promise.all([
        import(`${dir}/lib/types.ts`),
        import(`${dir}/lib/research.ts`),
        import(`${dir}/lib/providers.ts`),
      ])) as [TypesModule, ResearchModule, ProvidersModule]
      // Best-effort, separate from the Promise.all above — its absence must
      // degrade to no shared-voice formatting, never break the base backend.
      const dispatchSafety = (await import(`${dir}/lib/dispatch-safety.ts`).catch(
        () => null,
      )) as DispatchSafetyModule | null
      const denied = parseDeniedProviders(process.env.RECALL_LLM_DENY_PROVIDERS)
      if (denied.size > 0) {
        process.stderr.write(`[recall:llm-backend] RECALL_LLM_DENY_PROVIDERS excludes: ${[...denied].join(", ")}\n`)
      }
      return {
        queryModel: research.queryModel,
        getModel: types.getModel,
        getCheapModel: types.getCheapModel,
        getCheapModels: types.getCheapModels,
        estimateCost: types.estimateCost,
        isProviderAvailable: withProviderDenyList(providers.isProviderAvailable, denied),
        // `isProviderAvailable` is a two-state boolean over a three-state
        // reality (present-and-live / present-and-dead / absent) — the SAME
        // "cannot observe" collapsed into "no credential" defect class
        // documented in hub/ag/2026-08-01-accounts-plateau.md's P0 finding
        // (ag-accounts' isLoggedIn/deriveAuthState). That doc's fix
        // (a distinguishable "cannot determine" state, never conflated with
        // "absent") applies here too but is out of scope for this seam —
        // the deny list below is the interim: it doesn't make
        // isProviderAvailable three-state, it just lets a host say "I know
        // this one is dead" so recall stops trusting key-presence alone.
        // The real fix still belongs at vendor/bearly/plugins/llm/src/lib/providers.ts:129,
        // shared by every consumer (/pro, ask, deep, debate), not just recall.
        explainUnavailable: (provider: string): string => {
          const lower = provider.toLowerCase()
          if (denied.has(lower)) {
            return (
              `denied via RECALL_LLM_DENY_PROVIDERS=${[...denied].join(",")} ` +
              `(host override — the API key may be present, but this provider was flagged broken on this host)`
            )
          }
          const envVar = providers.getProviderEnvVar?.(provider)
          return envVar ? `no API key configured (${envVar} unset)` : `no API key configured for provider "${provider}"`
        },
        formatProviderError: buildFormatProviderError(dispatchSafety),
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

/** Synchronous display formatting for USD costs. */
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
