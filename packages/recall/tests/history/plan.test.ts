/**
 * Tests for the recall query planner — pure JSON parsing + variant flattening.
 * (The LLM call path is tested via integration, not unit.)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest"
import { addWriter, setSuppressConsole, type LogEvent } from "loggily"
import { setRecallLogging } from "../../src/history/recall-shared.ts"
import { parsePlanResult, PLANNER_ATTEMPT_CAP, planQuery, planVariants, type QueryPlan } from "../../src/lib/plan"
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
  let logEvents: LogEvent[] = []
  let unsubLog: (() => void) | undefined

  beforeEach(() => {
    logEvents = []
    // The root vitest setup pins LOG_LEVEL=warn; these failure lines are info (25392), so the rows name their level.
    vi.stubEnv("LOG_LEVEL", "info")
    setSuppressConsole(true)
    setRecallLogging(true)
    unsubLog = addWriter({ ns: "recall*" }, (_f, _l, _ns, ev) => {
      if (ev.kind === "log") logEvents.push(ev)
    })
  })

  afterEach(() => {
    unsubLog?.()
    setRecallLogging(false)
    setSuppressConsole(false)
    vi.unstubAllEnvs()
  })

  test("uses the shared provider selector before dispatching a default planner model", async () => {
    const denied: LlmModel = { provider: "google", modelId: "gemini-2.0-flash-lite" }
    const selected: LlmModel = { provider: "openrouter", modelId: "deepseek/deepseek-chat" }
    const calls: string[] = []
    const providerFacts = [
      { provider: denied.provider, status: "unknown" as const, source: "test", reason: "never observed" },
      { provider: selected.provider, status: "available" as const, source: "test", reason: "dispatch succeeded" },
    ]
    const llm = {
      queryModel: async ({ model }) => {
        calls.push(model.modelId)
        return {
          response: {
            content: JSON.stringify({
              keywords: ["selectedworked"],
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
      getModel: (id) => [denied, selected].find((m) => m.modelId === id),
      budgetedModelIds: [denied.modelId, selected.modelId],
      getCheapModel: () => denied,
      getCheapModels: () => [denied, selected],
      estimateCost: () => 0,
      isProviderAvailable: () => true,
      providerFacts,
      selectModels: ({ candidates = [denied, selected] }) => ({
        candidates: [...candidates],
        selected: [selected],
        excluded: [
          {
            model: denied,
            provider: denied.provider,
            status: "excluded" as const,
            source: "caller-exclusion",
            reason: "excluded by caller",
          },
        ],
        evidence: providerFacts,
      }),
    } satisfies LlmBackend

    const result = await planQuery("find prior work", emptyContext, { round: 1, llm })

    expect(result.plan?.keywords).toEqual(["selectedworked"])
    expect(result.model).toBe(selected.modelId)
    expect(calls).toEqual([selected.modelId])
  })

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
      getModel: (id) => [gemini, fallback].find((m) => m.modelId === id),
      budgetedModelIds: [gemini.modelId, fallback.modelId],
      getCheapModel: () => anotherGemini,
      getCheapModels: () => [anotherGemini, fallback],
      estimateCost: () => 0,
      isProviderAvailable: () => true,
    } satisfies LlmBackend

    const result = await planQuery("find prior work", emptyContext, { round: 1, llm })

    expect(result.plan?.keywords).toEqual(["fallbackworked"])
    expect(result.model).toBe(fallback.modelId)
    expect(calls).toEqual([gemini.modelId, fallback.modelId])
    expect(logEvents).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining(`${gemini.modelId} failed`) }),
    )
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
      getModel: (id) => [gemini, fallback].find((m) => m.modelId === id),
      budgetedModelIds: [gemini.modelId, fallback.modelId],
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
    expect(logEvents.filter((ev) => ev.message.includes("failed"))).toHaveLength(2)
  })

  // @failure One deadline was shared by every model, so a slow first model (Google through the agy one-shot) ate it
  // and the loop broke before the working fallback ran (@ag/llm/29473, @cto 19102a36).
  test("an attempt over its own deadline moves to the next model, which still answers", async () => {
    vi.useFakeTimers()
    const slow: LlmModel = { provider: "google", modelId: "gemini-2.0-flash-lite" }
    const fallback: LlmModel = { provider: "openrouter", modelId: "deepseek/deepseek-chat" }
    const calls: string[] = []
    const llm = {
      queryModel: async ({ model, abortSignal }) => {
        calls.push(model.modelId)
        if (!abortSignal) throw new Error("planner did not pass its deadline signal")
        if (model === fallback) {
          return { response: { content: JSON.stringify({ keywords: ["fallbackanswered"], phrases: [] }) } }
        }
        await new Promise<void>((resolve) => abortSignal.addEventListener("abort", () => resolve(), { once: true }))
        return { response: { error: "attempt deadline reached" } }
      },
      getModel: (id) => [slow, fallback].find((m) => m.modelId === id),
      budgetedModelIds: [slow.modelId, fallback.modelId],
      getCheapModel: () => fallback,
      getCheapModels: () => [fallback],
      estimateCost: () => 0,
      isProviderAvailable: () => true,
    } satisfies LlmBackend

    try {
      const pending = planQuery("find prior work", emptyContext, { round: 1, llm, timeoutMs: 25 })
      await vi.advanceTimersByTimeAsync(25)
      const result = await pending

      expect(result.plan?.keywords).toEqual(["fallbackanswered"])
      expect(result.model).toBe(fallback.modelId)
      expect(calls).toEqual([slow.modelId, fallback.modelId])
    } finally {
      vi.useRealTimers()
    }
  })

  test("the total cap ends the loop: no model starts after two attempt deadlines", async () => {
    vi.useFakeTimers()
    const models: LlmModel[] = [
      { provider: "google", modelId: "slow-1" },
      { provider: "openrouter", modelId: "slow-2" },
      { provider: "xai", modelId: "never-started" },
    ]
    const calls: string[] = []
    const llm = {
      queryModel: async ({ model, abortSignal }) => {
        calls.push(model.modelId)
        if (!abortSignal) throw new Error("planner did not pass its deadline signal")
        await new Promise<void>((resolve) => abortSignal.addEventListener("abort", () => resolve(), { once: true }))
        return { response: { error: "attempt deadline reached" } }
      },
      getModel: (id) => models.find((m) => m.modelId === id),
      budgetedModelIds: models.map((m) => m.modelId),
      getCheapModel: () => models[0],
      getCheapModels: () => models,
      estimateCost: () => 0,
      isProviderAvailable: () => true,
    } satisfies LlmBackend

    try {
      const pending = planQuery("find prior work", emptyContext, { round: 1, llm, timeoutMs: 25 })
      await vi.advanceTimersByTimeAsync(25 * PLANNER_ATTEMPT_CAP)
      const result = await pending

      expect(result.plan).toBeNull()
      expect(calls).toEqual(["slow-1", "slow-2"])
      expect(result.error).toBe("slow-1: attempt deadline reached; slow-2: attempt deadline reached")
    } finally {
      vi.useRealTimers()
    }
  })

  // @failure The daemon's plan-only call names no deadline, so it took planQuery's own 2500 ms default: under a
  // third of deepseek-chat's measured p50 of 9.4 s, so that path could almost never plan (@ag/llm/29473).
  test("with no deadline named, an attempt answering at deepseek-chat's measured p95 still plans", async () => {
    vi.useFakeTimers()
    const deepseek: LlmModel = { provider: "openrouter", modelId: "deepseek/deepseek-chat" }
    const llm = {
      queryModel: async ({ abortSignal }) => {
        const answered = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(true), 13_800)
          abortSignal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer)
              resolve(false)
            },
            { once: true },
          )
        })
        if (!answered) return { response: { error: "attempt deadline reached" } }
        return { response: { content: JSON.stringify({ keywords: ["p95answered"], phrases: [] }) } }
      },
      getModel: (id) => (id === deepseek.modelId ? deepseek : undefined),
      budgetedModelIds: [deepseek.modelId],
      getCheapModel: () => deepseek,
      getCheapModels: () => [deepseek],
      estimateCost: () => 0,
      isProviderAvailable: () => true,
    } satisfies LlmBackend

    try {
      const pending = planQuery("find prior work", emptyContext, { round: 1, llm })
      await vi.advanceTimersByTimeAsync(13_800)
      const result = await pending

      expect(result.error).toBeUndefined()
      expect(result.plan?.keywords).toEqual(["p95answered"])
    } finally {
      vi.useRealTimers()
    }
  })

  // @failure The planner tried Google first, served through the agy one-shot (2 to 4 s to start, 3.6 to 28 s to
  // answer), under the one 8 s deadline every later model shares; it aborted and the working fallback never ran, so
  // every planner call failed for two hours on 2026-10-15 (@ag/llm/29473, @cto 967ea2db).
  test("the default list plans with deepseek-chat only: a Google model the registry leads with is never asked", async () => {
    const gemini: LlmModel = { provider: "google", modelId: "gemini-2.0-flash-lite" }
    const deepseek: LlmModel = { provider: "openrouter", modelId: "deepseek/deepseek-chat" }
    const calls: string[] = []
    const llm = {
      queryModel: async ({ model }) => {
        calls.push(model.modelId)
        return {
          response: {
            content: JSON.stringify({
              keywords: ["budgeted"],
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
      getModel: (id) => [gemini, deepseek].find((m) => m.modelId === id),
      getCheapModel: () => gemini,
      getCheapModels: () => [gemini, deepseek],
      estimateCost: () => 0,
      isProviderAvailable: () => true,
    } satisfies LlmBackend

    const result = await planQuery("find prior work", emptyContext, { round: 1, llm })

    expect(result.model).toBe(deepseek.modelId)
    expect(calls).toEqual([deepseek.modelId])
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
    expect(logEvents).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining(`${selected.modelId} failed`) }),
    )
  })
})
