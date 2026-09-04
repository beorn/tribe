/**
 * @failure Recall model selection can stop at an unavailable leader or omit why every candidate was rejected.
 * @level l0
 * @consumer Recall status, remember, and session/daily/weekly summaries
 */

import { describe, test, expect, vi } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  parseDeniedProviders,
  resolveAvailableCheapModel,
  selectAvailableCheapModels,
  withProviderDenyList,
  type LlmBackend,
  type LlmModel,
  type LlmProviderAvailabilityFact,
} from "../../src/lib/llm-backend"

// ============================================================================
// parseDeniedProviders
// ============================================================================

describe("parseDeniedProviders", () => {
  test("returns an empty set for undefined input", () => {
    expect(parseDeniedProviders(undefined).size).toBe(0)
  })

  test("returns an empty set for blank/whitespace input", () => {
    expect(parseDeniedProviders("").size).toBe(0)
    expect(parseDeniedProviders("   ").size).toBe(0)
  })

  test("splits a comma-separated list, trims, and lowercases", () => {
    const denied = parseDeniedProviders(" OpenAI , xai ,openai")
    expect([...denied].sort()).toEqual(["openai", "xai"])
  })

  test("drops empty entries from stray commas", () => {
    const denied = parseDeniedProviders("openai,,xai,")
    expect([...denied].sort()).toEqual(["openai", "xai"])
  })

  test("single provider", () => {
    expect([...parseDeniedProviders("openrouter")]).toEqual(["openrouter"])
  })
})

// ============================================================================
// withProviderDenyList
// ============================================================================

describe("withProviderDenyList", () => {
  test("returns the original function unchanged (identity) when the deny set is empty", () => {
    const raw = (provider: string) => provider === "openrouter"
    const wrapped = withProviderDenyList(raw, parseDeniedProviders(undefined))
    expect(wrapped).toBe(raw)
  })

  test("denied providers read as unavailable even when the raw check says available", () => {
    const raw = () => true // every provider "has a key"
    const wrapped = withProviderDenyList(raw, parseDeniedProviders("openai,xai"))
    expect(wrapped("openai")).toBe(false)
    expect(wrapped("xai")).toBe(false)
    expect(wrapped("openrouter")).toBe(true)
  })

  test("denial is case-insensitive on the provider argument", () => {
    const raw = () => true
    const wrapped = withProviderDenyList(raw, parseDeniedProviders("openai"))
    expect(wrapped("OpenAI")).toBe(false)
  })

  test("a non-denied provider still defers to the raw availability check (key presence)", () => {
    const raw = (provider: string) => provider === "openrouter"
    const wrapped = withProviderDenyList(raw, parseDeniedProviders("openai"))
    expect(wrapped("openrouter")).toBe(true)
    expect(wrapped("xai")).toBe(false) // not denied, but raw says no key either
  })
})

// ============================================================================
// selectAvailableCheapModels
// ============================================================================

function selectionBackend(opts: {
  preferred?: LlmModel
  candidates: LlmModel[]
  available: string[]
  reasons?: Record<string, string>
}): LlmBackend {
  const available = new Set(opts.available)
  return {
    queryModel: vi.fn(),
    getModel: vi.fn(),
    getCheapModel: vi.fn(() => opts.preferred),
    getCheapModels: vi.fn((max = 2) => opts.candidates.slice(0, max)),
    estimateCost: vi.fn(() => 0),
    isProviderAvailable: vi.fn((provider) => available.has(provider)),
    explainUnavailable: opts.reasons ? (provider) => opts.reasons?.[provider] ?? "unknown" : undefined,
  }
}

describe("selectAvailableCheapModels", () => {
  test("uses shared provider facts and selector output instead of the legacy boolean when both are available", () => {
    const openai = { modelId: "gpt-cheap", provider: "openai" }
    const openrouter = { modelId: "deepseek-cheap", provider: "openrouter" }
    const providerFacts: LlmProviderAvailabilityFact[] = [
      {
        provider: "openai",
        status: "refusing" as const,
        kind: "quota",
        source: "dispatch",
        reason: "quota exhausted",
        observedAt: 1,
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
      {
        provider: "openrouter",
        status: "available" as const,
        source: "dispatch",
        reason: "successful completion",
        observedAt: 2,
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
    ]
    const selectModels: NonNullable<LlmBackend["selectModels"]> = vi.fn(() => ({
      candidates: [openai, openrouter],
      selected: [openrouter],
      evidence: providerFacts,
      excluded: [
        {
          model: openai,
          provider: "openai",
          status: "refusing" as const,
          kind: "quota" as const,
          source: "dispatch",
          reason: "quota exhausted",
          ageMs: 99,
        },
      ],
    }))
    const llm: LlmBackend = {
      ...selectionBackend({ candidates: [openai, openrouter], available: [] }),
      isProviderAvailable: vi.fn(() => {
        throw new Error("legacy boolean must not run")
      }),
      providerFacts,
      selectModels,
    }

    const selection = selectAvailableCheapModels(llm, { limit: 2, order: "registry" })

    expect(selection.models).toEqual([openrouter])
    expect(selection.rejected).toEqual([
      { ...openai, reason: "quota exhausted", status: "refusing", kind: "quota", ageMs: 99 },
    ])
    expect(selectModels).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [openai, openrouter],
        facts: providerFacts,
        distinctProviders: true,
        limit: 2,
      }),
    )
  })

  test("advances from an unavailable preferred model to the next live provider", () => {
    const openai = { modelId: "gpt-cheap", provider: "openai" }
    const anthropic = { modelId: "claude-cheap", provider: "anthropic" }
    const llm = selectionBackend({
      preferred: openai,
      candidates: [openai, anthropic],
      available: ["anthropic"],
      reasons: { openai: "OPENAI_API_KEY unset" },
    })

    const selection = selectAvailableCheapModels(llm)

    expect(selection.models).toEqual([anthropic])
    expect(selection.rejected).toEqual([{ modelId: "gpt-cheap", provider: "openai", reason: "OPENAI_API_KEY unset" }])
    expect(selection.failure).toBeNull()
  })

  test("applies the result limit after filtering the complete registry order", () => {
    const candidates = [
      { modelId: "dead-a", provider: "a" },
      { modelId: "dead-b", provider: "b" },
      { modelId: "live-c", provider: "c" },
      { modelId: "live-d", provider: "d" },
      { modelId: "live-e", provider: "e" },
    ]
    const llm = selectionBackend({ candidates, available: ["c", "d", "e"] })

    const selection = selectAvailableCheapModels(llm, { limit: 2, order: "registry" })

    expect(selection.models).toEqual(candidates.slice(2, 4))
    expect(llm.getCheapModels).toHaveBeenCalledWith(Number.MAX_SAFE_INTEGER)
  })

  test("reports every rejected candidate and reason in deterministic order", () => {
    const llm = selectionBackend({
      candidates: [
        { modelId: "dead-a", provider: "a" },
        { modelId: "dead-b", provider: "b" },
      ],
      available: [],
      reasons: { a: "A_TOKEN unset", b: "denied by host" },
    })

    const selection = selectAvailableCheapModels(llm, { order: "registry" })

    expect(selection.models).toEqual([])
    expect(selection.rejected).toEqual([
      { modelId: "dead-a", provider: "a", reason: "A_TOKEN unset" },
      { modelId: "dead-b", provider: "b", reason: "denied by host" },
    ])
    expect(selection.failure).toBe(
      "No cheap LLM provider is available; tried in getCheapModels() registry order: dead-a (a): A_TOKEN unset; dead-b (b): denied by host",
    )
  })

  test("keeps the preferred model first and deduplicates its provider", () => {
    const preferred = { modelId: "preferred-openai", provider: "openai" }
    const anthropic = { modelId: "claude-cheap", provider: "anthropic" }
    const google = { modelId: "gemini-cheap", provider: "google" }
    const llm = selectionBackend({
      preferred,
      candidates: [anthropic, { modelId: "registry-openai", provider: "openai" }, google],
      available: ["openai", "anthropic", "google"],
    })

    const selection = selectAvailableCheapModels(llm, { limit: 3 })

    expect(selection.models).toEqual([preferred, anthropic, google])
    expect(selection.order).toBe("getCheapModel() first, then remaining getCheapModels() registry order")
  })

  test("can restrict selection to caller candidates for model-specific features", () => {
    const haiku = { modelId: "claude-haiku", provider: "anthropic" }
    const unrelated = { modelId: "gpt-cheap", provider: "openai" }
    const llm = selectionBackend({
      preferred: unrelated,
      candidates: [unrelated, haiku],
      available: ["openai"],
      reasons: { anthropic: "fresh auth refusal" },
    })

    const selection = selectAvailableCheapModels(llm, {
      candidates: [haiku],
      includeRegistryFallback: false,
      limit: 1,
      order: "registry",
    })

    expect(selection.models).toEqual([])
    expect(selection.rejected).toEqual([{ ...haiku, reason: "fresh auth refusal" }])
    expect(selection.order).toBe("caller candidates only")
  })

  test("projects the selected backend and exhaustive failure for single-model callers", () => {
    const preferred = { modelId: "dead-openai", provider: "openai" }
    const fallback = { modelId: "live-anthropic", provider: "anthropic" }
    const liveBackend = selectionBackend({
      preferred,
      candidates: [preferred, fallback],
      available: ["anthropic"],
      reasons: { openai: "OPENAI_API_KEY unset" },
    })

    expect(resolveAvailableCheapModel(liveBackend)).toEqual({
      backend: liveBackend,
      model: fallback,
      failure: null,
    })

    const deadBackend = selectionBackend({
      preferred,
      candidates: [preferred, fallback],
      available: [],
      reasons: { openai: "OPENAI_API_KEY unset", anthropic: "ANTHROPIC_API_KEY unset" },
    })
    expect(resolveAvailableCheapModel(deadBackend)).toEqual({
      backend: null,
      model: null,
      failure:
        "No cheap LLM provider is available; tried in getCheapModel() first, then remaining getCheapModels() registry order: dead-openai (openai): OPENAI_API_KEY unset; live-anthropic (anthropic): ANTHROPIC_API_KEY unset",
    })
  })
})

describe("loadLlm shared provider-health surface", () => {
  test("rejects an incomplete public barrel with every missing capability named", () => {
    const fixture = mkdtempSync(join(tmpdir(), "recall-llm-incomplete-"))
    const backendModule = pathToFileURL(resolve(import.meta.dirname, "../../src/lib/llm-backend.ts")).href
    writeFileSync(join(fixture, "index.ts"), "export const getCheapModels = () => []\n")
    const childScript = `
      const { loadLlm } = await import(process.env.LLM_BACKEND_MODULE)
      const llm = await loadLlm()
      console.log(JSON.stringify({ loaded: llm !== null }))
    `

    try {
      const child = spawnSync("bun", ["-e", childScript], {
        encoding: "utf8",
        env: {
          ...process.env,
          LLM_BACKEND_MODULE: backendModule,
          TRIBE_LLM_DIR: fixture,
        },
      })
      expect(child.status, child.stderr).toBe(0)
      expect(JSON.parse(child.stdout)).toEqual({ loaded: false })
      expect(child.stderr).toContain("public barrel is missing required function exports")
      expect(child.stderr).toContain("createProviderObservationStore")
      expect(child.stderr).toContain("selectModels")
      expect(child.stderr).toContain("describeDispatchFailure")
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  test("loads Bearly through its public barrel and turns the host deny list into selector exclusions", () => {
    const home = mkdtempSync(join(tmpdir(), "recall-llm-health-"))
    const backendModule = pathToFileURL(resolve(import.meta.dirname, "../../src/lib/llm-backend.ts")).href
    const bearlyDir = resolve(import.meta.dirname, "../../../../../bearly/plugins/llm/src")
    const childScript = `
      const { loadLlm, selectAvailableCheapModels } = await import(process.env.LLM_BACKEND_MODULE)
      const llm = await loadLlm()
      if (!llm) throw new Error("loadLlm returned null")
      const selection = selectAvailableCheapModels(llm, { limit: 6, order: "registry" })
      console.log(JSON.stringify({
        hasFacts: Array.isArray(llm.providerFacts),
        hasSelector: typeof llm.selectModels === "function",
        legacyOpenAI: llm.isProviderAvailable("openai"),
        rejected: selection.rejected,
      }))
    `

    try {
      const child = spawnSync("bun", ["-e", childScript], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          LLM_BACKEND_MODULE: backendModule,
          TRIBE_LLM_DIR: bearlyDir,
          OPENAI_API_KEY: "configured-for-test",
          RECALL_LLM_DENY_PROVIDERS: "openai",
        },
      })
      expect(child.status, child.stderr).toBe(0)
      expect(child.stderr).toContain("RECALL_LLM_DENY_PROVIDERS excludes: openai")
      const result = JSON.parse(child.stdout) as {
        hasFacts: boolean
        hasSelector: boolean
        legacyOpenAI: boolean
        rejected: Array<{ provider: string; status?: string; reason: string }>
      }
      expect(result).toMatchObject({ hasFacts: true, hasSelector: true, legacyOpenAI: true })
      expect(result.rejected).toContainEqual(
        expect.objectContaining({ provider: "openai", status: "excluded", reason: "excluded by caller" }),
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
