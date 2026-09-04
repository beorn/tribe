/**
 * Tests for the recall query planner — pure JSON parsing + variant flattening.
 * (The LLM call path is tested via integration, not unit.)
 */

import { describe, test, expect, vi } from "vitest"
import { parsePlanResult, planQuery, planVariants, type QueryPlan } from "../../src/lib/plan"
import type { QueryContext } from "../../src/lib/context.ts"
import type { LlmBackend, LlmModel } from "../../src/lib/llm-backend.ts"

const emptyContext: QueryContext = {
  today: "2026-09-03",
  cwd: "/test",
  recentSessions: [],
  recentBeads: [],
  rareVocabulary: [],
  scopeEpics: [],
  recentCommits: [],
  sessionContext: null,
}

describe("parsePlanResult", () => {
  test("parses a well-formed JSON plan", () => {
    const raw = JSON.stringify({
      keywords: ["column", "layout"],
      phrases: ["column width"],
      concepts: ["flexbox"],
      paths: ["CardColumn.tsx"],
      errors: [],
      bead_ids: ["km-tui.columns"],
      time_hint: "1w",
      notes: "Found column-layout work in recent sessions.",
    })

    const { plan } = parsePlanResult(raw)
    expect(plan).not.toBeNull()
    expect(plan!.keywords).toEqual(["column", "layout"])
    expect(plan!.phrases).toEqual(["column width"])
    expect(plan!.paths).toEqual(["CardColumn.tsx"])
    expect(plan!.bead_ids).toEqual(["km-tui.columns"])
    expect(plan!.time_hint).toBe("1w")
    expect(plan!.notes).toBeDefined()
  })

  test("handles ```json fenced blocks", () => {
    const raw =
      '```json\n{"keywords": ["foo"], "phrases": [], "concepts": [], "paths": [], "errors": [], "bead_ids": [], "time_hint": null}\n```'
    const { plan } = parsePlanResult(raw)
    expect(plan).not.toBeNull()
    expect(plan!.keywords).toEqual(["foo"])
  })

  test("extracts JSON from prose wrapping", () => {
    const raw =
      'Here is the plan: {"keywords": ["bar"], "phrases": [], "concepts": [], "paths": [], "errors": [], "bead_ids": [], "time_hint": null} — hope this helps!'
    const { plan } = parsePlanResult(raw)
    expect(plan).not.toBeNull()
    expect(plan!.keywords).toEqual(["bar"])
  })

  test("normalizes missing/non-array fields to empty arrays", () => {
    const { plan } = parsePlanResult('{"keywords": "not-an-array", "phrases": ["ok"]}')
    expect(plan).not.toBeNull()
    expect(plan!.keywords).toEqual([])
    expect(plan!.phrases).toEqual(["ok"])
    expect(plan!.concepts).toEqual([])
    expect(plan!.time_hint).toBeNull()
  })

  test("filters empty and non-string entries from arrays", () => {
    const { plan } = parsePlanResult('{"keywords": ["foo", "", "   ", 42, null, "bar"]}')
    expect(plan).not.toBeNull()
    expect(plan!.keywords).toEqual(["foo", "bar"])
  })

  test("rejects a plan with zero usable variants", () => {
    const { plan } = parsePlanResult(
      '{"keywords": [], "phrases": [], "concepts": [], "paths": [], "errors": [], "bead_ids": []}',
    )
    expect(plan).toBeNull()
  })

  test("rejects non-JSON garbage", () => {
    expect(parsePlanResult("not json at all").plan).toBeNull()
    expect(parsePlanResult("").plan).toBeNull()
    expect(parsePlanResult("{").plan).toBeNull()
  })

  test("rejects a JSON array at top level", () => {
    expect(parsePlanResult("[1, 2, 3]").plan).toBeNull()
  })

  test("trims whitespace from string entries", () => {
    const { plan } = parsePlanResult('{"keywords": ["  foo  ", "\\tbar\\n"]}')
    expect(plan).not.toBeNull()
    expect(plan!.keywords).toEqual(["foo", "bar"])
  })
})

describe("planVariants", () => {
  test("flattens all buckets into unique variants", () => {
    const plan: QueryPlan = {
      keywords: ["foo", "bar"],
      phrases: ["multi word"],
      concepts: ["concept-a"],
      paths: ["File.ts"],
      errors: ["some error"],
      bead_ids: ["km-x.y"],
      time_hint: null,
    }
    const variants = planVariants(plan)
    expect(variants).toContain("foo")
    expect(variants).toContain("bar")
    expect(variants).toContain('"multi word"')
    expect(variants).toContain("concept-a")
    expect(variants).toContain("File.ts")
    expect(variants).toContain('"some error"')
    expect(variants).toContain("km-x.y")
  })

  test("quotes multi-word phrases but not single words", () => {
    const plan: QueryPlan = {
      keywords: [],
      phrases: ["solo", "two words", "three word phrase"],
      concepts: [],
      paths: [],
      errors: [],
      bead_ids: [],
      time_hint: null,
    }
    const variants = planVariants(plan)
    expect(variants).toContain("solo") // single word, no quotes
    expect(variants).toContain('"two words"')
    expect(variants).toContain('"three word phrase"')
  })

  test("dedupes across buckets", () => {
    const plan: QueryPlan = {
      keywords: ["column"],
      phrases: [],
      concepts: ["column"],
      paths: [],
      errors: [],
      bead_ids: [],
      time_hint: null,
    }
    expect(planVariants(plan)).toEqual(["column"])
  })

  test("skips entries shorter than 2 chars", () => {
    const plan: QueryPlan = {
      keywords: ["ok", "x", "  ", "foo"],
      phrases: [],
      concepts: [],
      paths: [],
      errors: [],
      bead_ids: [],
      time_hint: null,
    }
    const variants = planVariants(plan)
    expect(variants).toContain("ok")
    expect(variants).toContain("foo")
    expect(variants).not.toContain("x")
  })
})

describe("planQuery provider fallback", () => {
  test("tries the next available provider when the preferred provider rejects its credential", async () => {
    const gemini: LlmModel = { provider: "google", modelId: "gemini-2.0-flash-lite" }
    const anotherGemini: LlmModel = { provider: "google", modelId: "gemini-2.5-flash" }
    const fallback: LlmModel = { provider: "openrouter", modelId: "deepseek/deepseek-chat" }
    const calls: string[] = []
    const llm = {
      queryModel: async ({ model }) => {
        calls.push(model.modelId)
        if (model.provider === "google") {
          return { response: { error: "API key not valid. Please pass a valid API key." } }
        }
        return {
          response: {
            content: JSON.stringify({
              keywords: ["fallbackworked"],
              phrases: [],
              concepts: [],
              paths: [],
              errors: [],
              bead_ids: [],
              time_hint: null,
            }),
          },
        }
      },
      getModel: (id) => (id === gemini.modelId ? gemini : undefined),
      getCheapModel: () => anotherGemini,
      getCheapModels: () => [anotherGemini, fallback],
      estimateCost: () => 0,
      isProviderAvailable: () => true,
    } satisfies LlmBackend

    const result = await planQuery("find prior work", emptyContext, { round: 1, llm })

    expect(result.plan?.keywords).toEqual(["fallbackworked"])
    expect(result.model).toBe(fallback.modelId)
    expect(calls).toEqual([gemini.modelId, fallback.modelId])
  })

  test("reports every provider failure and accounts for billed failed responses", async () => {
    const gemini: LlmModel = { provider: "google", modelId: "gemini-2.0-flash-lite" }
    const fallback: LlmModel = { provider: "openrouter", modelId: "deepseek/deepseek-chat" }
    const llm = {
      queryModel: async ({ model }) => ({
        response: {
          error: `${model.provider} failed`,
          ...(model.provider === "google" ? { usage: { promptTokens: 1, completionTokens: 1 } } : {}),
        },
      }),
      getModel: (id) => (id === gemini.modelId ? gemini : undefined),
      getCheapModel: () => fallback,
      getCheapModels: () => [fallback],
      estimateCost: () => 0.25,
      isProviderAvailable: () => true,
    } satisfies LlmBackend

    const result = await planQuery("find prior work", emptyContext, { round: 1, llm })

    expect(result.plan).toBeNull()
    expect(result.error).toContain(`${gemini.modelId}: google failed`)
    expect(result.error).toContain(`${fallback.modelId}: openrouter failed`)
    expect(result.cost).toBe(0.25)
  })

  test("does not start another provider after the shared planner deadline aborts", async () => {
    vi.useFakeTimers()
    const gemini: LlmModel = { provider: "google", modelId: "gemini-2.0-flash-lite" }
    const fallback: LlmModel = { provider: "openrouter", modelId: "deepseek/deepseek-chat" }
    const calls: string[] = []
    const llm = {
      queryModel: async ({ model, abortSignal }) => {
        calls.push(model.modelId)
        if (!abortSignal) throw new Error("planner did not pass its deadline signal")
        await new Promise<void>((resolve) => abortSignal.addEventListener("abort", () => resolve(), { once: true }))
        return { response: { error: "planner deadline reached" } }
      },
      getModel: (id) => (id === gemini.modelId ? gemini : undefined),
      getCheapModel: () => fallback,
      getCheapModels: () => [fallback],
      estimateCost: () => 0,
      isProviderAvailable: () => true,
    } satisfies LlmBackend

    try {
      const pending = planQuery("find prior work", emptyContext, { round: 1, llm, timeoutMs: 25 })
      await vi.advanceTimersByTimeAsync(25)
      const result = await pending

      expect(result.plan).toBeNull()
      expect(result.error).toBe("planner deadline reached")
      expect(calls).toEqual([gemini.modelId])
    } finally {
      vi.useRealTimers()
    }
  })

  test("keeps an explicitly selected planner model single-shot", async () => {
    const selected: LlmModel = { provider: "google", modelId: "gemini-explicit" }
    const fallback: LlmModel = { provider: "openrouter", modelId: "deepseek/deepseek-chat" }
    const calls: string[] = []
    const llm = {
      queryModel: async ({ model }) => {
        calls.push(model.modelId)
        return { response: { error: "selected model failed" } }
      },
      getModel: () => undefined,
      getCheapModel: () => fallback,
      getCheapModels: () => [fallback],
      estimateCost: () => 0,
      isProviderAvailable: () => true,
    } satisfies LlmBackend

    const result = await planQuery("find prior work", emptyContext, { round: 1, llm, model: selected })

    expect(result.plan).toBeNull()
    expect(result.error).toBe("selected model failed")
    expect(calls).toEqual([selected.modelId])
  })
})
