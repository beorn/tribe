import { describe, test, expect, beforeAll, afterAll } from "vitest"
import * as fs from "fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { parseTimeToMs, setRecallLogging, boostedRank, expandQueryVariants } from "../../src/history/recall"
import type { RecallResult } from "../../src/history/recall"
import { synthesizeResults } from "../../src/history/synthesize"
import { SynthesisFailure } from "../../src/history/recall-shared"
import type { LlmBackend, LlmModel } from "../../src/lib/llm-backend"
import { toFts5Query, closeDb, getDb } from "../../src/history/db"

// Suppress verbose [recall] logging during tests
beforeAll(() => {
  setRecallLogging(false)
})

// ============================================================================
// parseTimeToMs
// ============================================================================

describe("parseTimeToMs", () => {
  test("parses hours", () => {
    const result = parseTimeToMs("1h")
    expect(result).toBeDefined()
    const diff = Date.now() - result!
    const oneHour = 60 * 60 * 1000
    expect(diff).toBeGreaterThan(oneHour - 2000)
    expect(diff).toBeLessThan(oneHour + 2000)
  })

  test("parses multi-digit hours", () => {
    const result = parseTimeToMs("12h")
    expect(result).toBeDefined()
    const diff = Date.now() - result!
    const twelveHours = 12 * 60 * 60 * 1000
    expect(diff).toBeGreaterThan(twelveHours - 2000)
    expect(diff).toBeLessThan(twelveHours + 2000)
  })

  test("parses days", () => {
    const result = parseTimeToMs("2d")
    expect(result).toBeDefined()
    const diff = Date.now() - result!
    const twoDays = 2 * 24 * 60 * 60 * 1000
    expect(diff).toBeGreaterThan(twoDays - 2000)
    expect(diff).toBeLessThan(twoDays + 2000)
  })

  test("parses weeks", () => {
    const result = parseTimeToMs("1w")
    expect(result).toBeDefined()
    const diff = Date.now() - result!
    const oneWeek = 7 * 24 * 60 * 60 * 1000
    expect(diff).toBeGreaterThan(oneWeek - 2000)
    expect(diff).toBeLessThan(oneWeek + 2000)
  })

  test("parses multi-digit weeks", () => {
    const result = parseTimeToMs("3w")
    expect(result).toBeDefined()
    const diff = Date.now() - result!
    const threeWeeks = 3 * 7 * 24 * 60 * 60 * 1000
    expect(diff).toBeGreaterThan(threeWeeks - 2000)
    expect(diff).toBeLessThan(threeWeeks + 2000)
  })

  test("parses 'today' as midnight", () => {
    const result = parseTimeToMs("today")
    expect(result).toBeDefined()
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    expect(result).toBe(midnight.getTime())
  })

  test("parses 'yesterday' as midnight minus 24h", () => {
    const result = parseTimeToMs("yesterday")
    expect(result).toBeDefined()
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    expect(result).toBe(midnight.getTime() - 24 * 60 * 60 * 1000)
  })

  test("returns undefined for invalid input", () => {
    expect(parseTimeToMs("invalid")).toBeUndefined()
    expect(parseTimeToMs("abc")).toBeUndefined()
    expect(parseTimeToMs("1x")).toBeUndefined()
    expect(parseTimeToMs("h1")).toBeUndefined()
  })

  test("returns undefined for empty string", () => {
    expect(parseTimeToMs("")).toBeUndefined()
  })

  test("is case-insensitive for keywords", () => {
    const lower = parseTimeToMs("today")
    const upper = parseTimeToMs("TODAY")
    const mixed = parseTimeToMs("Today")
    expect(lower).toBeDefined()
    expect(upper).toBeDefined()
    expect(mixed).toBeDefined()
    // All should resolve to the same midnight timestamp
    expect(lower).toBe(upper)
    expect(lower).toBe(mixed)
  })

  test("trims whitespace", () => {
    const result = parseTimeToMs("  1h  ")
    expect(result).toBeDefined()
    const diff = Date.now() - result!
    const oneHour = 60 * 60 * 1000
    expect(diff).toBeGreaterThan(oneHour - 2000)
    expect(diff).toBeLessThan(oneHour + 2000)
  })

  test("returns undefined for negative numbers", () => {
    expect(parseTimeToMs("-1h")).toBeUndefined()
  })

  test("returns undefined for zero", () => {
    // "0h" matches the regex but produces a 0ms offset — still valid per implementation
    const result = parseTimeToMs("0h")
    expect(result).toBeDefined()
    const diff = Date.now() - result!
    expect(diff).toBeLessThan(2000)
  })
})

// ============================================================================
// toFts5Query
// ============================================================================

describe("toFts5Query", () => {
  test("simple word is quoted", () => {
    expect(toFts5Query("hello")).toBe('"hello"')
  })

  test("multiple words each get quoted", () => {
    expect(toFts5Query("hello world")).toBe('"hello" "world"')
  })

  test("quoted phrases are preserved as FTS5 phrases", () => {
    expect(toFts5Query('"hello world"')).toBe('"hello world"')
  })

  test("negation with - prefix adds NOT", () => {
    expect(toFts5Query("-exclude")).toBe('NOT "exclude"')
  })

  test("mixed query: words, negation, and quoted phrases", () => {
    expect(toFts5Query('hello -bad "exact phrase"')).toBe('"hello" NOT "bad" "exact phrase"')
  })

  test("dots are quoted", () => {
    expect(toFts5Query("file.ts")).toBe('"file.ts"')
  })

  test("parentheses are quoted", () => {
    expect(toFts5Query("func()")).toBe('"func()"')
  })

  test("colons are quoted", () => {
    expect(toFts5Query("key:value")).toBe('"key:value"')
  })

  test("negation with special characters quotes the term", () => {
    expect(toFts5Query("-file.ts")).toBe('NOT "file.ts"')
  })

  test("empty string returns empty", () => {
    expect(toFts5Query("")).toBe("")
  })

  test("multiple spaces are collapsed", () => {
    expect(toFts5Query("hello   world")).toBe('"hello" "world"')
  })

  test("single quoted phrase only", () => {
    expect(toFts5Query('"inline edit"')).toBe('"inline edit"')
  })

  test("multiple quoted phrases", () => {
    expect(toFts5Query('"inline edit" "bug fix"')).toBe('"inline edit" "bug fix"')
  })

  test("word followed by quoted phrase", () => {
    expect(toFts5Query('search "inline edit"')).toBe('"search" "inline edit"')
  })

  test("trailing question marks are stripped", () => {
    expect(toFts5Query("what is this?")).toBe('"what" "is" "this"')
  })

  test("trailing exclamation marks are stripped", () => {
    expect(toFts5Query("fix this!")).toBe('"fix" "this"')
  })

  test("trailing commas are stripped", () => {
    expect(toFts5Query("hello, world")).toBe('"hello" "world"')
  })

  test("natural language question works", () => {
    expect(toFts5Query("how does inline edit work?")).toBe('"how" "does" "inline" "edit" "work"')
  })

  test("single quotes are safely quoted", () => {
    expect(toFts5Query("i'm getting errors")).toBe('"i\'m" "getting" "errors"')
  })

  test("angle brackets are safely quoted", () => {
    expect(toFts5Query("fix <error> handling")).toBe('"fix" "<error>" "handling"')
  })

  test("hyphens in tokens are safely quoted", () => {
    expect(toFts5Query("km-tui")).toBe('"km-tui"')
  })
})

// ============================================================================
// boostedRank
// ============================================================================

describe("boostedRank", () => {
  test("recent results get better (more negative) boosted rank", () => {
    const rank = -10
    const now = Date.now()
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000
    const recentBoosted = boostedRank(rank, now)
    const oldBoosted = boostedRank(rank, oneWeekAgo)
    // More negative = better, so recent should be more negative
    expect(recentBoosted).toBeLessThan(oldBoosted)
  })

  test("recency factor is ~0.5 at 1 week ago", () => {
    const rank = -10
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    const boosted = boostedRank(rank, oneWeekAgo)
    // recency_factor = 1 / (1 + 7/7) = 0.5, so boosted = -10 * 0.5 = -5
    expect(boosted).toBeCloseTo(-5, 0)
  })

  test("current timestamp gives full rank (no decay)", () => {
    const rank = -10
    const boosted = boostedRank(rank, Date.now())
    // recency_factor = 1 / (1 + 0/7) = 1, so boosted = -10
    expect(boosted).toBeCloseTo(-10, 0)
  })
})

// ============================================================================
// expandQueryVariants
// ============================================================================

describe("expandQueryVariants", () => {
  test("returns null when no synonyms match", () => {
    expect(expandQueryVariants("hello world")).toBeNull()
  })

  test("expands a single synonym-matched term", () => {
    const variants = expandQueryVariants("auth")
    expect(variants).not.toBeNull()
    expect(variants!.length).toBeGreaterThan(0)
    // Each variant should replace "auth" with a synonym
    for (const v of variants!) {
      expect(v).not.toBe("auth")
    }
  })

  test("expands multiple synonym-matched terms", () => {
    const variants = expandQueryVariants("auth bug")
    expect(variants).not.toBeNull()
    // Should have variants for "auth" synonyms + "bug" synonyms
    expect(variants!.length).toBeGreaterThan(3)
    // Should include variants like "authentication bug" and "auth error"
    expect(variants!.some((v) => v.includes("authentication"))).toBe(true)
    expect(variants!.some((v) => v.includes("error"))).toBe(true)
  })

  test("preserves non-synonym terms in variants", () => {
    const variants = expandQueryVariants("auth handler")
    expect(variants).not.toBeNull()
    // All variants should keep "handler" intact
    for (const v of variants!) {
      expect(v).toContain("handler")
    }
  })

  test("skips negation terms", () => {
    const variants = expandQueryVariants("-auth bug")
    expect(variants).not.toBeNull()
    // Should only expand "bug", not "-auth"
    for (const v of variants!) {
      expect(v).toContain("-auth")
    }
  })
})

// ============================================================================
// recall() integration tests, against a seeded fixture DB
// ============================================================================

describe("recall integration", () => {
  // Every row reads a fixture DB seeded here (25501). Rows that read the operator's live history skipped in a seat
  // (no DB under the test HOME) and, where a DB existed, missed fixed budgets under load in guard 2's runs.
  let fixtureDir = ""
  let previousDbPath: string | undefined
  beforeAll(() => {
    previousDbPath = process.env.RECALL_DB_PATH
    fixtureDir = fs.mkdtempSync(join(tmpdir(), "recall-integration-"))
    closeDb()
    process.env.RECALL_DB_PATH = join(fixtureDir, "fixture.db")
    const db = getDb()
    const insertSession = db.prepare(
      `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    const insertMessage = db.prepare(
      "INSERT INTO messages (uuid, session_id, type, content, timestamp) VALUES (?, ?, ?, ?, ?)",
    )
    const now = Date.now()
    const hour = 60 * 60_000
    const sessions: ReadonlyArray<readonly [string, number, ReadonlyArray<readonly [string, string]>]> = [
      ["fresh", hour, [["user", "the test runner failed on the first test"]]],
      [
        "repeated",
        3 * hour,
        [
          ["user", "the test fixture is seeded twice in one session"],
          ["user", "the second test message in the same session"],
          ["assistant", "the function under test now passes"],
        ],
      ],
      ["older", 2 * 24 * hour, [["user", "a test of the function that returns early"]]],
      ["oldest", 10 * 24 * hour, [["assistant", "the function signature changed in this test"]]],
    ]
    for (const [id, ageMs, messages] of sessions) {
      const timestamp = now - ageMs
      insertSession.run(id, "/fixture", `/fixture/${id}.jsonl`, timestamp, timestamp, messages.length, id)
      messages.forEach(([type, content], index) => insertMessage.run(`${id}-${index}`, id, type, content, timestamp))
    }
  })
  afterAll(() => {
    closeDb()
    if (previousDbPath === undefined) delete process.env.RECALL_DB_PATH
    else process.env.RECALL_DB_PATH = previousDbPath
    safeRemoveSync(fixtureDir, { within: tmpdir(), allowMissing: true })
  })

  // Dynamic import to avoid module-level side effects when DB doesn't exist
  async function getRecall(): Promise<(query: string, options?: Record<string, unknown>) => Promise<RecallResult>> {
    const mod = await import("../../src/history/recall")
    return mod.recall
  }

  test("returns RecallResult shape in raw mode", async () => {
    const recall = await getRecall()
    const result = await recall("test", { raw: true, limit: 3 })

    expect(result).toHaveProperty("query", "test")
    expect(result).toHaveProperty("synthesis")
    expect(result).toHaveProperty("results")
    expect(result).toHaveProperty("durationMs")
    expect(Array.isArray(result.results)).toBe(true)

    // Raw mode should not have synthesis
    expect(result.synthesis).toBeNull()
  }, 15_000)

  test("respects limit option", async () => {
    const recall = await getRecall()
    const result = await recall("test", { raw: true, limit: 2 })
    expect(result.results.length).toBe(2)
  }, 15_000)

  test("returns fewer results for narrow time filter", async () => {
    const previousDbPath = process.env.RECALL_DB_PATH
    const fixtureDir = fs.mkdtempSync(join(tmpdir(), "recall-time-filter-"))
    closeDb()
    process.env.RECALL_DB_PATH = join(fixtureDir, "fixture.db")
    try {
      const db = getDb()
      const now = Date.now()
      const insertSession = db.prepare(
        `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      const insertMessage = db.prepare(
        "INSERT INTO messages (uuid, session_id, type, content, timestamp) VALUES (?, ?, ?, ?, ?)",
      )
      for (const [id, ageMs] of [
        ["recent", 30 * 60_000],
        ["older", 2 * 60 * 60_000],
      ] as const) {
        const timestamp = now - ageMs
        insertSession.run(id, "/fixture", `/fixture/${id}.jsonl`, timestamp, timestamp, 1, id)
        insertMessage.run(`message-${id}`, id, "user", "timewindowfixture", timestamp)
      }

      const recall = await getRecall()
      const wideResult = await recall("timewindowfixture", { raw: true, limit: 20 })
      const narrowResult = await recall("timewindowfixture", { raw: true, limit: 20, since: "1h" })
      expect(wideResult.results.map((result) => result.sessionId).sort()).toEqual(["older", "recent"])
      expect(narrowResult.results.map((result) => result.sessionId)).toEqual(["recent"])
    } finally {
      closeDb()
      if (previousDbPath === undefined) delete process.env.RECALL_DB_PATH
      else process.env.RECALL_DB_PATH = previousDbPath
      fs.rmSync(fixtureDir, { recursive: true, force: true })
    }
  }, 15_000)

  test("returns empty when since is invalid", async () => {
    const recall = await getRecall()
    // Invalid since should cause early return with empty results
    const result = await recall("test", { raw: true, since: "invalid" })
    expect(result.results).toHaveLength(0)
    expect(result.synthesis).toBeNull()
  }, 15_000)

  test("result items have correct shape", async () => {
    const recall = await getRecall()
    const result = await recall("function", { raw: true, limit: 1 })
    expect(result.results).toHaveLength(1)
    const item = result.results[0]!
    expect(item).toHaveProperty("type")
    expect(item).toHaveProperty("sessionId")
    expect(item).toHaveProperty("sessionTitle")
    expect(item).toHaveProperty("timestamp")
    expect(item).toHaveProperty("snippet")
    expect(item).toHaveProperty("rank")
    expect(typeof item.timestamp).toBe("number")
    expect(typeof item.rank).toBe("number")
    expect(typeof item.snippet).toBe("string")
    expect(typeof item.sessionId).toBe("string")
    // Full ContentType surface (history/types.ts): recall() searches messages,
    // session-scoped content, and project-scoped content (bead/session_memory/
    // project_memory/doc/claude_md/llm_research), plus vault FTS when a .km
    // tree is present — any of these can rank #1 for a broad query like "function".
    expect([
      "message",
      "plan",
      "summary",
      "todo",
      "first_prompt",
      "bead",
      "session_memory",
      "project_memory",
      "doc",
      "claude_md",
      "llm_research",
      "vault",
    ]).toContain(item.type)
  }, 15_000)

  test("deduplicates by session+type", async () => {
    const recall = await getRecall()
    const result = await recall("the", { raw: true, limit: 10 })
    // Each session+type combo should appear at most once
    const keys = result.results.map((r) => `${r.sessionId}:${r.type}`)
    expect(keys.filter((key) => key.startsWith("repeated:"))).not.toHaveLength(0)
    const uniqueKeys = new Set(keys)
    expect(keys.length).toBe(uniqueKeys.size)
  }, 30_000)

  test("results are sorted by recency-boosted rank", async () => {
    const recall = await getRecall()
    const result = await recall("test", { raw: true, limit: 10 })
    const sortEpsilon = 1e-7
    expect(result.results.length).toBeGreaterThan(1)
    for (let i = 1; i < result.results.length; i++) {
      const prev = result.results[i - 1]!
      const curr = result.results[i]!
      const prevScore = boostedRank(prev.rank, prev.timestamp)
      const currScore = boostedRank(curr.rank, curr.timestamp)
      expect(currScore).toBeGreaterThanOrEqual(prevScore - sortEpsilon)
    }
  }, 15_000)

  test("durationMs is a positive number", async () => {
    const recall = await getRecall()
    const result = await recall("test", { raw: true, limit: 1 })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(typeof result.durationMs).toBe("number")
  }, 15_000)
})

describe("synthesizeResults", () => {
  test("uses the shared provider selector so explicit exclusions never reach the synthesis race", async () => {
    const models: LlmModel[] = [
      { provider: "openai", modelId: "openai-cheap" },
      { provider: "xai", modelId: "xai-cheap" },
      { provider: "openrouter", modelId: "openrouter-cheap" },
    ]
    const queried: string[] = []
    const providerFacts = models.map((model) => ({
      provider: model.provider,
      status: "unknown" as const,
      source: "test",
      reason: "never observed",
    }))
    const llm: LlmBackend = {
      queryModel: async ({ model }) => {
        queried.push(model.modelId)
        return { response: { content: `answer from ${model.modelId}` } }
      },
      getModel: (id) => models.find((model) => model.modelId === id),
      getCheapModel: () => models[0],
      getCheapModels: () => models,
      estimateCost: () => 0,
      // Compatibility meaning stays credential-presence only. The shared
      // selector is the authority for explicit policy exclusions.
      isProviderAvailable: () => true,
      providerFacts,
      selectModels: ({ candidates = models }) => ({
        candidates: [...candidates],
        selected: [models[2]!],
        excluded: models.slice(0, 2).map((model) => ({
          model,
          provider: model.provider,
          status: "excluded" as const,
          source: "caller-exclusion",
          reason: "excluded by caller",
        })),
        evidence: providerFacts,
      }),
    }

    const result = await synthesizeResults(
      "provider exclusion",
      [
        {
          type: "message",
          sessionId: "session-a",
          sessionTitle: "Session A",
          timestamp: Date.now(),
          snippet: "provider exclusion evidence",
          rank: 1,
        },
      ],
      1_000,
      llm,
    )

    expect(queried).toEqual(["openrouter-cheap"])
    expect(result.text).toBe("answer from openrouter-cheap")
  })

  test("filters provider availability before limiting the synthesis race", async () => {
    const models: LlmModel[] = [
      { provider: "openai", modelId: "openai-cheap" },
      { provider: "anthropic", modelId: "anthropic-cheap" },
      { provider: "xai", modelId: "xai-cheap" },
      { provider: "openrouter", modelId: "openrouter-cheap" },
    ]
    const queried: string[] = []
    let requestedMax = 0
    const llm: LlmBackend = {
      queryModel: async ({ model }) => {
        queried.push(model.modelId)
        return { response: { content: `answer from ${model.modelId}` } }
      },
      getModel: (id) => models.find((model) => model.modelId === id),
      getCheapModel: () => models[0],
      getCheapModels: (max = 2) => {
        requestedMax = max
        return models.slice(0, max)
      },
      estimateCost: () => 0,
      isProviderAvailable: (provider) => provider === "xai" || provider === "openrouter",
    }

    const result = await synthesizeResults(
      "provider selection",
      [
        {
          type: "message",
          sessionId: "session-a",
          sessionTitle: "Session A",
          timestamp: Date.now(),
          snippet: "provider selection evidence",
          rank: 1,
        },
      ],
      1_000,
      llm,
    )

    expect(requestedMax).toBeGreaterThan(2)
    expect(queried).toEqual(["xai-cheap", "openrouter-cheap"])
    expect(result.text).toMatch(/^answer from (xai|openrouter)-cheap$/)
  })

  test("reports provider errors when every synthesis model fails", async () => {
    const models: LlmModel[] = [
      { provider: "openai", modelId: "openai-cheap" },
      { provider: "xai", modelId: "xai-cheap" },
    ]
    const llm: LlmBackend = {
      queryModel: async ({ model }) => ({ response: { error: `${model.provider} quota exhausted` } }),
      getModel: (id) => models.find((model) => model.modelId === id),
      getCheapModel: () => models[0],
      getCheapModels: () => models,
      estimateCost: () => 0,
      isProviderAvailable: () => true,
    }

    // The one-sentence .message is deliberately tight now (no per-model
    // error text embedded — see synthesize.ts's buildFailureSummary); the
    // per-provider "openai-cheap: openai quota exhausted" / "xai-cheap: xai
    // quota exhausted" detail this test exists to catch now lives on
    // SynthesisFailure.diagnostics.attempts instead of the message.
    let caught: unknown
    try {
      await synthesizeResults(
        "provider failure",
        [
          {
            type: "message",
            sessionId: "session-a",
            sessionTitle: "Session A",
            timestamp: Date.now(),
            snippet: "provider failure evidence",
            rank: 1,
          },
        ],
        1_000,
        llm,
      )
      expect.unreachable("expected synthesizeResults to reject")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SynthesisFailure)
    const failure = caught as SynthesisFailure
    expect(failure.diagnostics.attempts.map((a) => `${a.modelId}: ${a.error}`)).toEqual([
      "openai-cheap: openai quota exhausted",
      "xai-cheap: xai quota exhausted",
    ])
  })

  test("tries the next available provider batch when the first race fails", async () => {
    const models: LlmModel[] = [
      { provider: "openai", modelId: "openai-cheap" },
      { provider: "xai", modelId: "xai-cheap" },
      { provider: "openrouter", modelId: "openrouter-cheap" },
    ]
    const queried: string[] = []
    const llm: LlmBackend = {
      queryModel: async ({ model }) => {
        queried.push(model.modelId)
        if (model.provider === "openrouter") return { response: { content: "fallback synthesis" } }
        return { response: { error: `${model.provider} unavailable` } }
      },
      getModel: (id) => models.find((model) => model.modelId === id),
      getCheapModel: () => models[0],
      getCheapModels: () => models,
      estimateCost: () => 0,
      isProviderAvailable: () => true,
    }

    const result = await synthesizeResults(
      "provider fallback",
      [
        {
          type: "message",
          sessionId: "session-a",
          sessionTitle: "Session A",
          timestamp: Date.now(),
          snippet: "provider fallback evidence",
          rank: 1,
        },
      ],
      1_000,
      llm,
    )

    expect(queried).toEqual(["openai-cheap", "xai-cheap", "openrouter-cheap"])
    expect(result.text).toBe("fallback synthesis")
  })

  test("fair-shares the timeout budget across batches so a hanging batch cannot starve a later one", async () => {
    // Regression for the real 2026-08-05 recall failure: two dead
    // providers (openai, xai) raced first, took 8.2s of a 10s budget to
    // fail, and left the one live provider (openrouter) 1.7s —
    // structurally unwinnable. Here "dead-1"/"dead-2" only settle when
    // aborted (like a real fetch() honoring AbortSignal on a hung
    // request), so this proves the batch timeout is a genuine per-batch
    // SHARE of the budget, not the whole remaining deadline handed to
    // whichever batch races first.
    const models: LlmModel[] = [
      { provider: "openai", modelId: "dead-1" },
      { provider: "xai", modelId: "dead-2" },
      { provider: "openrouter", modelId: "good" },
    ]
    const queried: string[] = []
    const llm: LlmBackend = {
      queryModel: async ({ model, abortSignal }) => {
        queried.push(model.modelId)
        if (model.modelId === "good") {
          await new Promise((resolve) => setTimeout(resolve, 20))
          return { response: { content: "fallback synthesis" } }
        }
        // Hangs until the race's AbortController fires — never resolves
        // on its own, exactly like a stalled real HTTP call.
        return new Promise((resolve) => {
          abortSignal?.addEventListener("abort", () => resolve({ response: { error: `${model.provider} aborted` } }), {
            once: true,
          })
        })
      },
      getModel: (id) => models.find((model) => model.modelId === id),
      getCheapModel: () => models[0],
      getCheapModels: () => models,
      estimateCost: () => 0,
      isProviderAvailable: () => true,
    }

    const result = await synthesizeResults(
      "budget fairness",
      [
        {
          type: "message",
          sessionId: "session-a",
          sessionTitle: "Session A",
          timestamp: Date.now(),
          snippet: "budget fairness evidence",
          rank: 1,
        },
      ],
      200,
      llm,
    )

    expect(queried).toEqual(["dead-1", "dead-2", "good"])
    expect(result.text).toBe("fallback synthesis")
  }, 2_000)
})
