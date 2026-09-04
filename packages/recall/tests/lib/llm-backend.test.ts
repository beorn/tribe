/**
 * @failure Recall model selection can stop at an unavailable leader or omit why every candidate was rejected.
 * @level l0
 * @consumer Recall status, remember, and session/daily/weekly summaries
 */

import { describe, test, expect, vi } from "vitest"
import {
  parseDeniedProviders,
  resolveAvailableCheapModel,
  selectAvailableCheapModels,
  withProviderDenyList,
  type LlmBackend,
  type LlmModel,
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
