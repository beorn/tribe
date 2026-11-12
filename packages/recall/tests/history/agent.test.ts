/**
 * Tests for recallAgent orchestration — short-circuit, speculative, empty-plan,
 * fallthrough, time-hint. Mocks queryModel via vitest module mocking so tests
 * run with no API keys and no network.
 *
 * Note: fanoutSearch hits a real (in-memory) SQLite DB, so each test sets up
 * a tiny corpus to make coverage stats deterministic.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildMockQueryModel, buildPlanJson, alwaysAvailable, unavailableCostMethods } from "../helpers/llm-mock.ts"
import { makeKmVault } from "../helpers/km-vault.ts"
import type { LlmBackend } from "../../src/lib/llm-backend.ts"

process.env.RECALL_DB_PATH = ":memory:"

const mockHolder: {
  fn: ReturnType<typeof buildMockQueryModel> | null
} = { fn: null }

const fakeModel = (id: string) => ({ provider: "mock", modelId: id })
const llm = {
  queryModel: (opts: Parameters<NonNullable<typeof mockHolder.fn>>[0]) => {
    if (!mockHolder.fn) throw new Error("Test did not install a mock queryModel")
    return mockHolder.fn(opts)
  },
  getModel: (id: string) => fakeModel(id),
  getCheapModel: () => fakeModel("mock-cheap"),
  getCheapModels: (max = 2) => [fakeModel("mock-cheap"), fakeModel("mock-cheap-2")].slice(0, Math.max(0, max)),
  ...unavailableCostMethods,
  isProviderAvailable: alwaysAvailable,
} satisfies LlmBackend

// Disable context-build side effects that aren't relevant to agent orchestration
vi.mock("../../src/lib/context", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/lib/context")>()
  return {
    ...orig,
    buildQueryContext: () => ({
      today: "2026-04-17",
      cwd: "/tmp/test",
      recentSessions: [],
      recentBeads: [],
      rareVocabulary: [],
      scopeEpics: [],
      recentCommits: [],
      sessionContext: null,
    }),
    renderContextPrompt: () => "TEST CONTEXT",
  }
})

// ──────────────────────────────────────────────────────────────────────
// Imports AFTER vi.mock declarations so the DB + LLM seams are isolated.
// ──────────────────────────────────────────────────────────────────────

const { recallAgent: recallAgentImpl } = await import("../../src/lib/agent")
const { setRecallLogging } = await import("../../src/history/recall-shared")
const { getDb, closeDb } = await import("../../src/history/db")

function recallAgent(
  query: Parameters<typeof recallAgentImpl>[0],
  options: Parameters<typeof recallAgentImpl>[1] = {},
): ReturnType<typeof recallAgentImpl> {
  return recallAgentImpl(query, { ...options, deps: { ...options.deps, llm } })
}

// ──────────────────────────────────────────────────────────────────────
// Fixture helpers
// ──────────────────────────────────────────────────────────────────────

function seedCorpus(opts: {
  sessions: Array<{ id: string; title: string; messages: string[] }>
  beads?: Array<{ id: string; title: string; content: string }>
}) {
  const db = getDb()
  const now = Date.now()

  for (const s of opts.sessions) {
    db.prepare(
      `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(s.id, "/test", `/tmp/${s.id}.jsonl`, now - 60_000, now, s.messages.length, s.title)

    for (let i = 0; i < s.messages.length; i++) {
      db.prepare(`INSERT INTO messages (uuid, session_id, type, content, timestamp) VALUES (?, ?, ?, ?, ?)`).run(
        `${s.id}-${i}`,
        s.id,
        "user",
        s.messages[i]!,
        now - i * 1000,
      )
    }
  }

  for (const b of opts.beads ?? []) {
    db.prepare(
      `INSERT INTO content (content_type, source_id, project_path, title, content, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("bead", b.id, "/test", b.title, b.content, now)
  }
}

// ──────────────────────────────────────────────────────────────────────
// Lifecycle
// ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  setRecallLogging(false)
  // Ensure we start each test with a fresh in-memory DB (closeDb resets the
  // db.ts singleton so the next getDb() opens a new :memory: DB).
  closeDb()
})

afterEach(() => {
  closeDb()
  mockHolder.fn = null
})

// ──────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────

describe("recallAgent — short-circuit", () => {
  test("skips round 2 when top-coverage absolute threshold hit (low fraction)", async () => {
    // 24 variants planned; session only matches 8 of them →
    //   fraction = 8/24 = 0.33 (below 0.35 threshold)
    //   absolute = 8 (meets ≥6 threshold)
    // Confirms the absolute-coverage path triggers independently.
    const keywords: string[] = []
    for (let i = 0; i < 24; i++) keywords.push(`tok${i}`)

    mockHolder.fn = buildMockQueryModel([
      { match: /query planner/i, content: buildPlanJson({ keywords }) },
      { content: "synthesized" },
    ])

    // Session content matches only tok0..tok7 (8 variants)
    seedCorpus({
      sessions: [{ id: "sess-a", title: "A", messages: ["tok0 tok1 tok2 tok3 tok4 tok5 tok6 tok7"] }],
    })

    const result = await recallAgent("test query", { limit: 1 })

    expect(result.trace.decision.round2Mode).toBe("off")
    expect(result.trace.decision.reason).toMatch(/short-circuit/)
    expect(result.trace.decision.reason).toMatch(/absolute=8/)
    expect(result.trace.rounds).toHaveLength(1)
    expect(result.trace.synthPath).toBe("single-pass")
    expect(result.trace.synthCallsUsed).toBe(1)
  })

  test("skips round 2 when fraction threshold hit", async () => {
    // 4 variants, all match → fraction = 4/4 = 1.0 ≥ 0.35
    mockHolder.fn = buildMockQueryModel([
      { match: /query planner/i, content: buildPlanJson({ keywords: ["alpha", "beta", "gamma", "delta"] }) },
      { content: "synthesized" },
    ])

    seedCorpus({
      sessions: [{ id: "sess-a", title: "A", messages: ["alpha beta gamma delta"] }],
    })

    const result = await recallAgent("q", { limit: 1 })

    expect(result.trace.decision.round2Mode).toBe("off")
    expect(result.trace.decision.reason).toMatch(/fraction=1\.00/)
  })
})

describe("recallAgent — speculative synth", () => {
  test("preserves lexical results and diagnostics when speculative synthesis fails", async () => {
    const plan = buildPlanJson({ keywords: ["alpha"] })
    mockHolder.fn = async (opts) => {
      if (opts.systemPrompt?.toLowerCase().includes("query planner")) {
        return {
          response: {
            model: opts.model,
            content: plan,
            durationMs: 10,
          },
        }
      }
      return {
        response: {
          model: opts.model,
          content: "",
          durationMs: 10,
          error: "synthesis provider failed",
        },
      }
    }
    seedCorpus({
      sessions: [{ id: "sess-a", title: "A", messages: ["alpha content"] }],
    })

    const result = await recallAgent("q", { limit: 3, round2: "off" })

    expect(result.synthesis).toBeNull()
    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.snippet).toContain("alpha")
    expect(result.results[0]?.snippet).toContain("content")
    expect(result.synthesisFailure?.summary).toMatch(/Synthesis failed/)
    expect(result.synthesisFailure?.attempts.some((a) => a.error?.includes("synthesis provider failed"))).toBe(true)
  })

  test("uses speculative round-1 when round 2 adds no new top-K docs", async () => {
    // Round 1 plan with few variants so short-circuit doesn't fire
    const round1Plan = buildPlanJson({ keywords: ["alpha"], phrases: [] })
    // Round 2 plan with variants that won't match anything in the corpus
    const round2Plan = buildPlanJson({ keywords: ["nonexistent-term-xyz"], phrases: [] })

    let planCallCount = 0
    mockHolder.fn = async (opts) => {
      if (opts.systemPrompt?.toLowerCase().includes("query planner")) {
        planCallCount++
        return {
          response: {
            model: opts.model,
            content: planCallCount === 1 ? round1Plan : round2Plan,
            durationMs: 10,
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          },
        }
      }
      // synth call
      return {
        response: {
          model: opts.model,
          content: "synthesized answer",
          durationMs: 10,
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        },
      }
    }

    seedCorpus({
      sessions: [{ id: "sess-a", title: "A", messages: ["alpha content"] }],
    })

    const result = await recallAgent("fuzzy query", { limit: 3, round2: "deeper" })

    // Round 2 fired and found nothing → speculative round-1 answer used
    expect(result.trace.rounds.length).toBeGreaterThanOrEqual(1)
    expect(result.trace.synthPath).toBe("speculative-round1")
    expect(result.trace.synthCallsUsed).toBe(1)
    expect(result.trace.round1ShortCircuited).toBe(true)
    expect(result.synthesis).toContain("synthesized")
  })

  test("can be disabled via speculativeSynth: false", async () => {
    const plan = buildPlanJson({ keywords: ["alpha"] })
    mockHolder.fn = buildMockQueryModel([{ match: /query planner/i, content: plan }, { content: "answer" }])

    seedCorpus({
      sessions: [{ id: "sess-a", title: "A", messages: ["alpha content"] }],
    })

    const result = await recallAgent("q", {
      limit: 3,
      round2: "off",
      speculativeSynth: false,
    })

    // No speculative promise fired; single-pass synth on round-1 results
    expect(result.trace.synthPath).toBe("single-pass")
    expect(result.trace.synthCallsUsed).toBe(1)
    expect(result.trace.round1ShortCircuited).toBe(false)
  })
})

describe("recallAgent — empty plan handling", () => {
  test("fallthrough when round-1 planner returns malformed JSON", async () => {
    mockHolder.fn = buildMockQueryModel([{ content: "not valid json at all" }])

    seedCorpus({
      sessions: [{ id: "sess-a", title: "A", messages: ["content"] }],
    })

    // This test exercises planner fallthrough, not synthesis. Raw mode keeps
    // the fallback hermetic when a developer's live session or vault happens
    // to contain the deliberately broad query.
    const result = await recallAgent("q", { limit: 3, raw: true })

    expect(result.fellThrough).toBe(true)
    expect(result.trace.rounds[0]!.planner.error).toMatch(/parse-failed/)
  })

  test("round-2 empty-plan keeps round-1 results (not an error)", async () => {
    let planCallCount = 0
    mockHolder.fn = async (opts) => {
      if (opts.systemPrompt?.toLowerCase().includes("query planner")) {
        planCallCount++
        const content =
          planCallCount === 1
            ? buildPlanJson({ keywords: ["alpha"] })
            : // Round 2 returns a structurally-valid empty plan
              JSON.stringify({ keywords: [], phrases: [], concepts: [], paths: [], errors: [], bead_ids: [] })
        return {
          response: {
            model: opts.model,
            content,
            durationMs: 10,
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          },
        }
      }
      return {
        response: {
          model: opts.model,
          content: "answer",
          durationMs: 10,
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        },
      }
    }

    seedCorpus({
      sessions: [{ id: "sess-a", title: "A", messages: ["alpha"] }],
    })

    const result = await recallAgent("q", { limit: 3, round2: "deeper" })

    // Agent kept round-1 results; round 2's planner entry reflects empty-plan
    expect(result.fellThrough).toBeFalsy()
    const round2Trace = result.trace.rounds[1]
    expect(round2Trace?.planner.error).toBe("empty-plan")
  })
})

describe("recallAgent — time-hint application", () => {
  // Existing trace-only assertions cannot detect the planner silently widening the actual result set.
  test.each([
    { since: undefined, expected: ["recent-window"] },
    { since: "all", expected: ["old-window", "recent-window"] },
  ])("only the caller can remove the time window ($since)", async ({ since, expected }) => {
    mockHolder.fn = buildMockQueryModel([
      { match: /query planner/i, content: buildPlanJson({ keywords: ["windowneedle"], time_hint: "all" }) },
      { content: "answer" },
    ])
    seedCorpus({
      sessions: [
        { id: "recent-window", title: "Recent", messages: ["windowneedle"] },
        { id: "old-window", title: "Old", messages: ["windowneedle"] },
      ],
    })
    getDb()
      .prepare("UPDATE messages SET timestamp = ? WHERE session_id = ?")
      .run(Date.now() - 90 * 86400_000, "old-window")
    const result = await recallAgent("windowneedle", { limit: 3, since, round2: "off" })
    expect(result.fellThrough).toBeFalsy()
    expect(result.results.map((hit) => hit.sessionId).sort()).toEqual(expected)
  })

  test("planner time_hint overrides default sinceTime when --since not set", async () => {
    const plan = buildPlanJson({ keywords: ["alpha"], time_hint: "1h" })
    mockHolder.fn = buildMockQueryModel([{ match: /query planner/i, content: plan }, { content: "answer" }])

    seedCorpus({
      sessions: [{ id: "sess-a", title: "A", messages: ["alpha"] }],
    })

    const result = await recallAgent("q", { limit: 3, round2: "off" })

    // Hard to observe sinceTime directly, but the plan's time_hint should
    // be preserved in the round-1 plan payload (not clobbered)
    const round1Plan = result.trace.rounds[0]!.plan as { time_hint: string | null }
    expect(round1Plan.time_hint).toBe("1h")
  })

  test("caller's --since wins over planner's time_hint", async () => {
    const plan = buildPlanJson({ keywords: ["alpha"], time_hint: "30d" })
    mockHolder.fn = buildMockQueryModel([{ match: /query planner/i, content: plan }, { content: "answer" }])

    seedCorpus({
      sessions: [{ id: "sess-a", title: "A", messages: ["alpha"] }],
    })

    // Caller explicitly passes a 1-week filter; planner's 30d should not apply
    const result = await recallAgent("q", { limit: 3, since: "1w", round2: "off" })

    // Planner's time_hint is still in the plan, but the agent should not
    // have reapplied it (we can't directly observe sinceTime, but we can
    // confirm no crash and the plan structure is intact).
    expect(result.fellThrough).toBeFalsy()
    const round1Plan = result.trace.rounds[0]!.plan as { time_hint: string | null }
    expect(round1Plan.time_hint).toBe("30d") // planner said so; caller overrode in agent internals
  })
})

describe("recallAgent — fallthrough", () => {
  test("falls through cleanly when round-1 planner returns zero variants", async () => {
    // Plan parses but has no entries → parsePlanResult returns empty-plan
    mockHolder.fn = buildMockQueryModel([
      { content: JSON.stringify({ keywords: [], phrases: [], concepts: [], paths: [], errors: [], bead_ids: [] }) },
    ])

    seedCorpus({
      sessions: [{ id: "sess-a", title: "A", messages: ["alpha"] }],
    })

    const result = await recallAgent("q", { limit: 3, raw: true })

    expect(result.fellThrough).toBe(true)
    expect(result.trace.rounds[0]!.planner.error).toBe("empty-plan")
  })
})

// Fanout owns creating receipts; this checks the separate orchestration risk:
// real SQLite cuts/rejections in both rounds must survive final merge and trace.
// @failure round-2 search receipts disappear when the agent merges its results
// @level l2
// @consumer recallAgent callers and optional CLI round traces
test("agent carries both rounds' bounded-search receipts in its result and trace", async () => {
  let plannerCalls = 0
  const plans = [
    buildPlanJson({ keywords: ["zebracorn", "-badsyntax"] }),
    buildPlanJson({ keywords: ["roundtwocap", "-roundtwobadsyntax"] }),
  ]
  const synth = buildMockQueryModel([{ content: "A bounded answer" }])
  mockHolder.fn = async (opts) => {
    if (!opts.systemPrompt?.match(/query planner/i)) return synth(opts)
    const content = plans[plannerCalls++]
    if (!content) throw new Error("Unexpected extra planner call")
    return buildMockQueryModel([{ content }])(opts)
  }
  seedCorpus({
    sessions: [
      { id: "dense-receipt", title: "Dense", messages: Array.from({ length: 1003 }, () => "zebracorn roundtwocap") },
    ],
  })
  const result = await recallAgent("zebracorn", { limit: 1, raw: true, round2: "deeper" })
  const firstRound = [
    expect.objectContaining({ phase: "messages", anchor: "zebracorn", message: expect.stringMatching(/cap|cut/) }),
    expect.objectContaining({
      phase: "messages",
      anchor: "-badsyntax",
      message: expect.stringMatching(/syntax error/i),
    }),
    expect.objectContaining({
      phase: "project_content",
      anchor: "-badsyntax",
      message: expect.stringMatching(/syntax error/i),
    }),
  ]
  const secondRound = [
    expect.objectContaining({ phase: "messages", anchor: "roundtwocap", message: expect.stringMatching(/cap|cut/) }),
    expect.objectContaining({
      phase: "messages",
      anchor: "-roundtwobadsyntax",
      message: expect.stringMatching(/syntax error/i),
    }),
    expect.objectContaining({
      phase: "project_content",
      anchor: "-roundtwobadsyntax",
      message: expect.stringMatching(/syntax error/i),
    }),
  ]
  expect(plannerCalls).toBe(2)
  expect(result.trace.rounds).toHaveLength(2)
  expect(result.skipped).toEqual([...firstRound, ...secondRound])
  expect(result.trace.rounds[0]?.skipped).toEqual(firstRound)
  expect(result.trace.rounds[1]?.skipped).toEqual(secondRound)
  expect(result.trace.rounds[0]?.variants).toEqual(["zebracorn"])
  expect(result.trace.rounds[1]?.variants).toEqual(["roundtwocap"])
  expect(result.results[0]?.sessionId).toBe("dense-receipt")
})

// Pins: agent results (the rows `recall --agent --json` serialises) carry only the base fields — no `line`, no
// duplicateLine and no collapsed-copy fields — even when the indexed rows have line numbers and uuid-NULL copies
// (S1/S2 refactor guard, the "29981" omissions in lib/fanout.ts; agent tests assert only order, receipts and trace).
test("agent results carry no line or collapsed-copy fields", async () => {
  mockHolder.fn = buildMockQueryModel([
    { match: /query planner/i, content: buildPlanJson({ keywords: ["linefieldneedle"] }) },
    { content: "synthesized" },
  ])
  seedCorpus({
    sessions: [
      { id: "line-a", title: "A", messages: ["linefieldneedle first row", "linefieldneedle second row"] },
      { id: "line-b", title: "B", messages: [] },
    ],
    beads: [{ id: "line-bead", title: "Bead", content: "linefieldneedle in a bead" }],
  })
  const db = getDb()
  db.prepare("UPDATE messages SET line = 40 + id").run()
  // uuid-NULL copies of one text at one line: the shape the exact path collapses and annotates (29981).
  for (const session of ["line-a", "line-b"]) {
    db.prepare(
      `INSERT INTO messages (uuid, session_id, type, content, timestamp, line) VALUES (NULL, ?, 'user', ?, ?, 9)`,
    ).run(session, "linefieldneedle forked copy", Date.now())
  }

  const result = await recallAgent("linefieldneedle", { limit: 10, round2: "off" })

  // line-b's only row is a uuid-NULL copy, so it may fold into line-a's survivor; both kinds of row must be present.
  expect(result.results.map((r) => `${r.type}:${r.sessionId}`)).toEqual(
    expect.arrayContaining(["bead:line-bead", "message:line-a"]),
  )
  for (const row of result.results) {
    expect(Object.keys(row).sort()).toEqual(["rank", "sessionId", "sessionTitle", "snippet", "timestamp", "type"])
  }
  expect(JSON.stringify(result.results)).not.toMatch(/"(line|duplicateLine|collapsedCopy\w*)"/)
})

// ──────────────────────────────────────────────────────────────────────
// Required issue ids — 28593, both measured shapes
// ──────────────────────────────────────────────────────────────────────

function makeIssueVault(nodes: Array<{ id: string; fsPath: string; title: string; content: string }>): {
  dir: string
  db: string
} {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "recall-required-ids-"))
  return { dir, db: makeKmVault(dir, nodes) }
}

describe("recallAgent — required issue id", () => {
  test("searches the id the question names even when the planner drops it (27398 shape)", async () => {
    const vault = makeIssueVault([
      {
        id: "27398-ops-plan-mouse-tracking-leak",
        fsPath: "@ag/code/27398-ops-plan-mouse-tracking-leak.md",
        title: "mouse tracking leak after reattach",
        content: "mouse leak reattach",
      },
    ])
    try {
      // The measured plan: unrelated keywords, and two substituted ids the question never named.
      mockHolder.fn = buildMockQueryModel([
        {
          match: /query planner/i,
          content: buildPlanJson({ keywords: ["controller", "memory", "resize"], bead_ids: ["28503", "28586"] }),
        },
        { content: "synthesized" },
      ])
      seedCorpus({
        sessions: [
          { id: "sess-intended", title: "intended", messages: ["27398 mouse leak after reattach"] },
          { id: "sess-noise", title: "noise", messages: ["controller memory resize notes"] },
        ],
      })

      const result = await recallAgent("27398 ops-plan resize operator confirmation of mouse leak after reattach", {
        limit: 5,
        vaultDb: vault.db,
      })

      expect(result.trace.requiredIds).toEqual(["27398"])
      // The id was searched although no planner bucket held it.
      expect(result.trace.rounds[0]?.variants).toContain("27398")
      // The substituted ids never reached the corpus.
      expect(result.trace.rounds[0]?.variants).not.toContain("28503")
      expect(result.trace.rounds[0]?.variants).not.toContain("28586")
      expect(result.trace.plannerInjectedIssueIds).toEqual(["bead_ids:28503", "bead_ids:28586"])
      // The id's own document is in the answer's result set.
      expect(result.results.some((r) => r.snippet.includes("27398"))).toBe(true)
    } finally {
      rmSync(vault.dir, { recursive: true, force: true })
    }
  })

  test("refuses the short-circuit while the named id is unmatched (32289 shape)", async () => {
    const vault = makeIssueVault([
      {
        id: "32289-move-platform-specific-code",
        fsPath: "@ag/hab/cross-platform-posture/32289-move-platform-specific-code.md",
        title: "move platform-specific code",
        content: "HostMetricsProvider platform posture",
      },
    ])
    try {
      mockHolder.fn = buildMockQueryModel([
        { match: /ROUND 2/i, content: buildPlanJson({ keywords: ["posture"] }) },
        {
          match: /query planner/i,
          content: buildPlanJson({
            keywords: [
              "platform",
              "HostMetricsProvider",
              "terminfo",
              "libvterm",
              "VT100",
              "Kitty",
              "osc7",
              "probeHash",
            ],
            bead_ids: ["32289", "32309", "32310", "32312"],
          }),
        },
        { content: "synthesized" },
      ])
      // Generic coverage that would short-circuit (8/8 variants on one doc) with no 32289 anywhere.
      seedCorpus({
        sessions: [
          {
            id: "sess-noise",
            title: "noise",
            messages: ["platform HostMetricsProvider terminfo libvterm VT100 Kitty osc7 probeHash"],
          },
        ],
      })

      const result = await recallAgent("32289 platform HostMetricsProvider", { limit: 1, vaultDb: vault.db })

      expect(result.trace.requiredIds).toEqual(["32289"])
      expect(result.trace.unmatchedRequiredIds).toEqual(["32289"])
      expect(result.trace.decision.round2Mode).not.toBe("off")
      expect(result.trace.decision.reason).not.toMatch(/short-circuit/)
      // The siblings the planner injected from context are gone; the named id stayed.
      const firstRound = result.trace.rounds[0]?.variants ?? []
      expect(firstRound).toContain("32289")
      for (const injected of ["32309", "32310", "32312"]) expect(firstRound).not.toContain(injected)
      expect(result.trace.plannerInjectedIssueIds).toEqual(
        expect.arrayContaining(["bead_ids:32309", "bead_ids:32310", "bead_ids:32312"]),
      )
      // Round 2 actually ran instead of answering from the noise.
      expect(result.trace.rounds.map((round) => round.round)).toEqual([1, 2])
    } finally {
      rmSync(vault.dir, { recursive: true, force: true })
    }
  })

  test("still short-circuits when the named id is in the top results", async () => {
    const vault = makeIssueVault([
      {
        id: "32289-move-platform-specific-code",
        fsPath: "@ag/hab/cross-platform-posture/32289-move-platform-specific-code.md",
        title: "move platform-specific code",
        content: "HostMetricsProvider platform posture",
      },
    ])
    try {
      mockHolder.fn = buildMockQueryModel([
        {
          match: /query planner/i,
          content: buildPlanJson({
            keywords: [
              "platform",
              "HostMetricsProvider",
              "terminfo",
              "libvterm",
              "VT100",
              "Kitty",
              "osc7",
              "probeHash",
            ],
          }),
        },
        { content: "synthesized" },
      ])
      seedCorpus({
        sessions: [
          {
            id: "sess-hit",
            title: "hit",
            messages: ["32289 platform HostMetricsProvider terminfo libvterm VT100 Kitty osc7 probeHash"],
          },
        ],
      })

      const result = await recallAgent("32289 platform HostMetricsProvider", { limit: 1, vaultDb: vault.db })

      expect(result.trace.requiredIds).toEqual(["32289"])
      expect(result.trace.unmatchedRequiredIds).toEqual([])
      expect(result.trace.decision.round2Mode).toBe("off")
      expect(result.trace.decision.reason).toMatch(/short-circuit/)
    } finally {
      rmSync(vault.dir, { recursive: true, force: true })
    }
  })
})
