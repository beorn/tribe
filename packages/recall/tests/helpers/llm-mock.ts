/**
 * llm-mock.ts — Test-only LLM mock helpers.
 *
 * Copied from bearly plugins/llm/src/lib/mock.ts when the recall engine moved
 * into the tribe repo (19273): the llm plugin stays in bearly behind the
 * TRIBE_LLM_DIR seam, so its test helpers can't be imported from here. Typed
 * against recall's structural `llm-backend` types instead of llm's own.
 *
 * Purpose: unit-test code paths that call queryModel() / isProviderAvailable()
 * without burning API credits or requiring network access.
 *
 * NOT imported from source code — tests only. Keep it dependency-light.
 */

import type { LlmModel } from "../../src/lib/llm-backend.ts"

// ============================================================================
// Scenario-based mock for queryModel
// ============================================================================

export interface MockScenario {
  /** If set, this scenario matches when the system prompt OR question contains it. */
  match?: string | RegExp
  /** The content the mock response returns. */
  content: string
  /** Optional simulated duration (ms); default 10ms. */
  durationMs?: number
  /** Optional simulated error — when set, content is ignored. */
  error?: string
  /** Optional usage tokens for cost-estimation tests. */
  usage?: { promptTokens: number; completionTokens: number; totalTokens?: number }
}

export interface MockCall {
  question: string
  systemPrompt?: string
  modelId: string
  aborted: boolean
}

type MockResponse = {
  response: {
    model: LlmModel
    content: string
    durationMs: number
    error?: string
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  }
}

/**
 * Build a stub `queryModel` that matches the caller's question/systemPrompt
 * against the scenarios in order and returns the first match's content.
 * A scenario without `match` is treated as a default (fallback).
 *
 * Also exposes `.calls` on the returned function so tests can assert call
 * counts, inspect system prompts, etc.
 */
export function buildMockQueryModel(scenarios: MockScenario[]) {
  const calls: MockCall[] = []

  const mock = async (opts: {
    question: string
    model: LlmModel
    systemPrompt?: string
    abortSignal?: AbortSignal
  }): Promise<MockResponse> => {
    calls.push({
      question: opts.question,
      systemPrompt: opts.systemPrompt,
      modelId: opts.model.modelId,
      aborted: opts.abortSignal?.aborted ?? false,
    })

    // If aborted already, short-circuit to a timeout-like response
    if (opts.abortSignal?.aborted) {
      return {
        response: {
          model: opts.model,
          content: "",
          durationMs: 0,
          error: "aborted",
        },
      }
    }

    // Find the first matching scenario
    const haystack = `${opts.systemPrompt ?? ""}\n${opts.question}`
    const scenario =
      scenarios.find((s) => s.match && matches(s.match, haystack)) ?? scenarios.find((s) => !s.match) ?? null

    if (!scenario) {
      return {
        response: {
          model: opts.model,
          content: "",
          durationMs: 1,
          error: "no mock scenario matched (add a default scenario to buildMockQueryModel)",
        },
      }
    }

    const duration = scenario.durationMs ?? 10
    // Simulate a tiny async gap so race logic / timeouts behave realistically
    await new Promise((r) => setTimeout(r, duration))

    if (scenario.error) {
      return {
        response: {
          model: opts.model,
          content: "",
          durationMs: duration,
          error: scenario.error,
        },
      }
    }

    const baseUsage = scenario.usage ?? { promptTokens: 100, completionTokens: 50 }
    const usage = {
      promptTokens: baseUsage.promptTokens,
      completionTokens: baseUsage.completionTokens,
      totalTokens: baseUsage.totalTokens ?? baseUsage.promptTokens + baseUsage.completionTokens,
    }
    return {
      response: {
        model: opts.model,
        content: scenario.content,
        durationMs: duration,
        usage,
      },
    }
  }

  ;(mock as unknown as { calls: MockCall[] }).calls = calls
  return mock
}

/**
 * Helper: the mock above treats `match` as a regex OR a substring match.
 */
function matches(pattern: string | RegExp, text: string): boolean {
  if (typeof pattern === "string") return text.includes(pattern)
  return pattern.test(text)
}

// ============================================================================
// Provider availability stubs
// ============================================================================

/** Replace `isProviderAvailable` with this to make every provider available. */
export function alwaysAvailable(): boolean {
  return true
}

/** Replace `isProviderAvailable` with this to make every provider unavailable. */
export function neverAvailable(): boolean {
  return false
}

/** Make only named providers available. */
export function onlyAvailable(providers: string[]): (p: string) => boolean {
  const set = new Set(providers)
  return (p: string) => set.has(p)
}

// ============================================================================
// Plan scenario helpers (common patterns)
// ============================================================================

/**
 * Build a canned planner JSON response matching the QueryPlan shape.
 * Accepts partial input; fills in empty arrays / nulls for the rest.
 */
export function buildPlanJson(
  partial: Partial<{
    keywords: string[]
    phrases: string[]
    concepts: string[]
    paths: string[]
    errors: string[]
    bead_ids: string[]
    time_hint: string | null
    notes: string
  }>,
): string {
  return JSON.stringify({
    keywords: partial.keywords ?? [],
    phrases: partial.phrases ?? [],
    concepts: partial.concepts ?? [],
    paths: partial.paths ?? [],
    errors: partial.errors ?? [],
    bead_ids: partial.bead_ids ?? [],
    time_hint: partial.time_hint ?? null,
    notes: partial.notes ?? undefined,
  })
}
