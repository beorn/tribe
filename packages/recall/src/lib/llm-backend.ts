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

import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

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

const REQUIRED_BACKEND_FILES = ["lib/types.ts", "lib/research.ts", "lib/providers.ts"] as const

/**
 * Resolve the LLM backend directory. TRIBE_LLM_DIR is the explicit override;
 * when unset, host checkouts may provide bearly at the repo root
 * (`vendor/bearly/plugins/llm/src`) or as a sibling checkout
 * (`../bearly/plugins/llm/src`).
 */
function resolveLlmBackendDir(): string | null {
  const explicit = process.env.TRIBE_LLM_DIR
  if (explicit) return explicit
  for (const candidate of candidateLlmBackendDirs()) {
    if (backendDirExists(candidate)) return candidate
  }
  return null
}

/**
 * Load the LLM backend from TRIBE_LLM_DIR or a host-local bearly checkout.
 * Cached after the first call.
 * Returns null (with a one-time stderr warning) when the backend is absent
 * or fails to load — callers take their documented no-LLM degrade path.
 */
export async function loadLlm(): Promise<LlmBackend | null> {
  if (probe !== undefined) return probe
  probe = (async () => {
    const dir = resolveLlmBackendDir()
    if (!dir) {
      warnOnce("TRIBE_LLM_DIR is unset and no local bearly plugins/llm/src was found")
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
      const source = process.env.TRIBE_LLM_DIR ? `TRIBE_LLM_DIR=${dir}` : `auto-discovered ${dir}`
      warnOnce(`backend FAILED to load from ${source}: ${err instanceof Error ? err.message : String(err)}`)
      // silent-fallback-allow: loud-by-design — warnOnce() above logs the load
      // failure once per process; null is the documented no-LLM degrade mode.
      return null
    }
  })()
  return probe
}

function* candidateLlmBackendDirs(): Generator<string> {
  const seen = new Set<string>()
  const roots = [process.env.CLAUDE_PROJECT_DIR, process.cwd(), dirname(fileURLToPath(import.meta.url))]
  for (const root of roots) {
    if (!root) continue
    for (const parent of ancestorDirs(root)) {
      for (const candidate of [
        join(parent, "vendor", "bearly", "plugins", "llm", "src"),
        join(parent, "bearly", "plugins", "llm", "src"),
        join(parent, "plugins", "llm", "src"),
      ]) {
        const resolved = resolve(candidate)
        if (seen.has(resolved)) continue
        seen.add(resolved)
        yield resolved
      }
    }
  }
}

function ancestorDirs(start: string): string[] {
  const dirs: string[] = []
  let current = resolve(start)
  while (true) {
    dirs.push(current)
    const parent = dirname(current)
    if (parent === current) return dirs
    current = parent
  }
}

function backendDirExists(dir: string): boolean {
  return REQUIRED_BACKEND_FILES.every((file) => existsSync(join(dir, file)))
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
        `Place bearly at vendor/bearly or ../bearly, or point TRIBE_LLM_DIR at a directory exposing ` +
        `lib/types.ts, lib/research.ts, lib/providers.ts.`,
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
