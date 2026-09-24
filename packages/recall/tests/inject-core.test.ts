/**
 * Tests for the injection-framing protocol emitted by runInjectDelta.
 *
 * Covers:
 *   - The trailing context-protocol footer is present on every substantive
 *     prompt, regardless of whether recall found new snippets.
 *   - The <recall-memory> wrapper carries the typed directive attributes
 *     (authority, changes_goal, tool_trigger).
 *   - Imperative-mood snippets are rewritten to reported-speech framing.
 *   - Trivial prompts (empty, short, slash, ack phrases) still skip cleanly
 *     with no output.
 *
 * See km-bearly.injection-framing for the protocol design.
 */

import { describe, test, expect, beforeEach, vi } from "vitest"

const {
  CONTEXT_PROTOCOL_FOOTER,
  createMemorySeenStore,
  rewriteImperativeAsReported,
  runInjectDelta: runInjectDeltaImpl,
  VAULT_UNBOUND_NOTICE,
} = await import("../src/lib/inject-core.ts")

const recallMock = vi.fn()
const ensureProjectSourcesIndexedMock = vi.fn()

function runInjectDelta(
  prompt: Parameters<typeof runInjectDeltaImpl>[0],
  store: Parameters<typeof runInjectDeltaImpl>[1],
  opts: Parameters<typeof runInjectDeltaImpl>[2] = {},
): ReturnType<typeof runInjectDeltaImpl> {
  return runInjectDeltaImpl(prompt, store, {
    ...opts,
    deps: {
      recall: recallMock as unknown as typeof import("../src/history/search.ts").recall,
      ensureProjectSourcesIndexed: ensureProjectSourcesIndexedMock,
      findGlossaryAnchor: () => null,
      // A bound vault by default: the unbound notice has its own describe below.
      getVaultDbPath: () => "/fixture/vault/.km/state.db",
      ...opts.deps,
    },
  })
}

function mockRecall(
  results: Array<{
    sessionId: string
    sessionTitle?: string
    type: string
    snippet: string
    rank?: number
    timestamp?: number
  }>,
): void {
  // V2 gates require rank + timestamp on every result. Default to a strong
  // BM25-shape rank (-10 is well below MIN_RANK_THRESHOLD = -3) and a recent
  // timestamp so tests focused on dedup/emit don't trip the quality gates.
  recallMock.mockResolvedValue({
    results: results.map((r) => ({
      rank: -10,
      timestamp: Date.now(),
      ...r,
    })),
  })
}

describe("rewriteImperativeAsReported", () => {
  test("prefixes common imperatives", () => {
    expect(rewriteImperativeAsReported("create a bead that captures X")).toMatch(/^\[historical/)
    expect(rewriteImperativeAsReported("fix the broken test")).toMatch(/^\[historical/)
    expect(rewriteImperativeAsReported("refactor the module")).toMatch(/^\[historical/)
  })

  test("is case-insensitive on the first word", () => {
    expect(rewriteImperativeAsReported("Create a bead")).toMatch(/^\[historical/)
    expect(rewriteImperativeAsReported("FIX this")).toMatch(/^\[historical/)
  })

  test("leaves descriptive snippets untouched", () => {
    const descriptive = "Checkpoint saved to km-silvery.reactive-pipeline."
    expect(rewriteImperativeAsReported(descriptive)).toBe(descriptive)
  })

  test("leaves questions untouched", () => {
    const q = "What should we do about the scroll region?"
    expect(rewriteImperativeAsReported(q)).toBe(q)
  })

  test("is idempotent — re-running does not double-prefix", () => {
    const once = rewriteImperativeAsReported("create a bead")
    expect(rewriteImperativeAsReported(once)).toBe(once)
  })

  test("handles empty and whitespace-only input", () => {
    expect(rewriteImperativeAsReported("")).toBe("")
    expect(rewriteImperativeAsReported("   ")).toBe("   ")
  })
})

describe("CONTEXT_PROTOCOL_FOOTER", () => {
  test("is wrapped in a <context-protocol> tag", () => {
    expect(CONTEXT_PROTOCOL_FOOTER.startsWith("<context-protocol>")).toBe(true)
    expect(CONTEXT_PROTOCOL_FOOTER.endsWith("</context-protocol>")).toBe(true)
  })

  test("directs the model to respond only to unframed text", () => {
    expect(CONTEXT_PROTOCOL_FOOTER).toMatch(/unframed/)
  })
})

describe("runInjectDelta — trivial prompts", () => {
  beforeEach(() => {
    recallMock.mockReset()
  })

  test("empty prompt is skipped with no output", async () => {
    const store = createMemorySeenStore()
    const result = await runInjectDelta("", store)
    expect(result.skipped).toBe(true)
    if (result.skipped) expect(result.reason).toBe("empty")
    expect(recallMock).not.toHaveBeenCalled()
  })

  test("short prompt is skipped", async () => {
    const result = await runInjectDelta("hi", createMemorySeenStore())
    expect(result.skipped).toBe(true)
    if (result.skipped) expect(result.reason).toBe("short")
  })

  test("short ack phrases are skipped via short-check", async () => {
    // All currently-listed TRIVIAL_PROMPTS are <15 chars so short-check fires
    // first; the "trivial" branch is a fail-safe for future relaxation. Both
    // skip reasons are functionally equivalent at the emit layer.
    const result = await runInjectDelta("looks good", createMemorySeenStore())
    expect(result.skipped).toBe(true)
    if (result.skipped) expect(result.reason).toBe("short")
  })

  test("slash commands are skipped", async () => {
    const result = await runInjectDelta("/help something", createMemorySeenStore())
    expect(result.skipped).toBe(true)
    if (result.skipped) expect(result.reason).toBe("slash_command")
  })
})

describe("runInjectDelta — emit only when there's content to frame", () => {
  beforeEach(() => {
    recallMock.mockReset()
  })

  test("no recall results — skips entirely (no footer-only emission)", async () => {
    // Behavior change: previously emitted the footer alone, but Claude Code
    // renders all hook additionalContext as user-role turns. An always-on
    // footer turned into mysterious "H:" scrollback. Now: no framed content
    // → no emission. See emit.ts CONTEXT_PROTOCOL_FOOTER docstring.
    mockRecall([])
    // Salient prompt (kebab-ID `km-storage-sync`) so V2 salience gate doesn't fire
    // before recall — we want to test the no-results branch specifically.
    const result = await runInjectDelta("what is the status of km-storage-sync right now?", createMemorySeenStore())
    expect(result.skipped).toBe(true)
    if (!result.skipped) return
    expect(result.reason).toBe("no_results")
  })

  test("all results deduped — skips entirely (no footer-only emission)", async () => {
    const store = createMemorySeenStore()
    mockRecall([
      {
        sessionId: "sess-00000001",
        sessionTitle: "prior",
        type: "message",
        snippet: "A reasonably long descriptive snippet about prior work on the project.",
      },
    ])
    // First call marks it as seen.
    await runInjectDelta("what did we last do on km-board-state for the kanban work?", store)
    // Second call with same prompt — dedup kicks in, snippet is all_seen.
    const result = await runInjectDelta("what did we last do on km-board-state for the kanban work?", store)
    expect(result.skipped).toBe(true)
    if (!result.skipped) return
    expect(result.reason).toBe("all_seen")
  })

  test("new snippets — emits recall block followed by footer", async () => {
    mockRecall([
      {
        sessionId: "sess-abcd1234",
        sessionTitle: "sess-title",
        type: "message",
        snippet: "A descriptive snippet that is plenty long enough to pass the minimum filter.",
      },
    ])
    const result = await runInjectDelta("what did we decide about km-storage-sync layering?", createMemorySeenStore())
    expect(result.skipped).toBe(false)
    if (result.skipped) return
    expect(result.footerOnly).toBeUndefined()
    // Structural: recall block precedes footer
    const recallIdx = result.additionalContext.indexOf("<recall-memory")
    const footerIdx = result.additionalContext.indexOf("<context-protocol>")
    expect(recallIdx).toBeGreaterThanOrEqual(0)
    expect(footerIdx).toBeGreaterThan(recallIdx)
    // Footer is present verbatim at the end
    expect(result.additionalContext.endsWith(CONTEXT_PROTOCOL_FOOTER)).toBe(true)
  })

  test("recall-memory block carries typed directive attributes", async () => {
    mockRecall([
      {
        sessionId: "sess-abcd1234",
        sessionTitle: "sess-title",
        type: "message",
        snippet: "A descriptive snippet that is plenty long enough to pass the minimum filter.",
      },
    ])
    const result = await runInjectDelta("what did we decide about km-storage-sync layering?", createMemorySeenStore())
    if (result.skipped) throw new Error("expected non-skipped result")
    expect(result.additionalContext).toContain('authority="reference"')
    expect(result.additionalContext).toContain('changes_goal="false"')
    expect(result.additionalContext).toContain('tool_trigger="forbidden"')
  })

  test("imperative snippets are rewritten as reported speech inside the recall block", async () => {
    mockRecall([
      {
        sessionId: "sess-abcd1234",
        sessionTitle: "sess-title",
        type: "message",
        snippet: "create a bead that captures all of this context about the board refactor work.",
      },
    ])
    const result = await runInjectDelta(
      "pick up where we left off on km-board-state the refactor",
      createMemorySeenStore(),
    )
    if (result.skipped) throw new Error("expected non-skipped result")
    expect(result.additionalContext).toContain("[historical")
    // The original imperative text remains, just prefixed.
    expect(result.additionalContext).toContain("create a bead that captures")
  })
})

describe("runInjectDelta — V2 gates", () => {
  beforeEach(() => {
    recallMock.mockReset()
  })

  test("low-salience meta-prompt (no IDs/paths/backticks) skips before recall fires", async () => {
    const result = await runInjectDelta("how should we improve things?", createMemorySeenStore())
    expect(result.skipped).toBe(true)
    if (!result.skipped) return
    expect(result.reason).toBe("low_salience")
    expect(recallMock).not.toHaveBeenCalled()
  })

  test("long substantive prompt bypasses salience gate even without IDs", async () => {
    mockRecall([
      {
        sessionId: "sess-longprompt",
        sessionTitle: "long",
        type: "message",
        snippet: "A descriptive snippet that is plenty long enough to pass the minimum filter.",
      },
    ])
    // 121 chars, no kebab IDs / paths / backticks — but length alone is enough
    // signal for FTS to find anchors. Salience gate must bypass.
    const longPrompt =
      "I would like a thorough explanation of how the rendering pipeline behaves when several large lists are mounted simultaneously."
    expect(longPrompt.length).toBeGreaterThanOrEqual(120)
    const result = await runInjectDelta(longPrompt, createMemorySeenStore())
    expect(result.skipped).toBe(false)
  })

  test("kebab-case identifier counts as salience even on a short prompt", async () => {
    mockRecall([
      {
        sessionId: "sess-kebab",
        sessionTitle: "kebab",
        type: "message",
        snippet: "A descriptive snippet that is plenty long enough to pass the minimum filter.",
      },
    ])
    const result = await runInjectDelta("how is km-tribe-recall-trigger going?", createMemorySeenStore())
    expect(result.skipped).toBe(false)
  })

  test("low FTS rank is filtered out (low_quality skip)", async () => {
    mockRecall([
      {
        sessionId: "sess-weak",
        sessionTitle: "weak match",
        type: "message",
        snippet: "Tangential content that happens to share a token but is otherwise unrelated.",
        rank: -1, // weaker than MIN_RANK_THRESHOLD = -3 → filtered
        timestamp: Date.now(),
      },
    ])
    const result = await runInjectDelta("what about km-board-state kanban?", createMemorySeenStore())
    expect(result.skipped).toBe(true)
    if (!result.skipped) return
    expect(result.reason).toBe("low_quality")
  })

  test("snippet body matching rejected-signal pattern is dropped", async () => {
    mockRecall([
      {
        sessionId: "sess-orthogonal",
        sessionTitle: "research",
        type: "llm_research",
        snippet: 'Earlier analysis: "verdict": "orthogonal", "why": "discusses unrelated framework".',
      },
    ])
    const result = await runInjectDelta(
      "what did we learn about km-storage-sync cognitive types?",
      createMemorySeenStore(),
    )
    // Filtered-out by content gate; was the only hit → all_seen path
    // (the rank gate passed, content gate didn't).
    expect(result.skipped).toBe(true)
    if (!result.skipped) return
    expect(result.reason).toBe("all_seen")
  })

  test("default limit is 1 — multi-hit recall emits only the best match", async () => {
    mockRecall([
      {
        sessionId: "sess-best",
        sessionTitle: "best",
        type: "message",
        snippet: "First match — strong, descriptive, clearly the best result for this query.",
      },
      {
        sessionId: "sess-okay",
        sessionTitle: "okay",
        type: "message",
        snippet: "Second match — also relevant but lower-priority among the FTS hits.",
      },
      {
        sessionId: "sess-third",
        sessionTitle: "third",
        type: "message",
        snippet: "Third match — should not appear when default limit is 1.",
      },
    ])
    const result = await runInjectDelta("tell me about km-board-state the refactor", createMemorySeenStore())
    if (result.skipped) throw new Error("expected non-skipped result")
    // Only the first session id appears in the framed output.
    expect(result.additionalContext).toContain("sess-bes")
    expect(result.additionalContext).not.toContain("sess-oka")
    expect(result.additionalContext).not.toContain("sess-thi")
    expect(result.newKeys).toEqual(["sess-best:message"])
  })

  test("dedup TTL is 100 turns — same chunk doesn't re-inject within a session", async () => {
    const store = createMemorySeenStore()
    mockRecall([
      {
        sessionId: "sess-ttl",
        sessionTitle: "ttl",
        type: "message",
        snippet: "A descriptive snippet that is plenty long enough to pass the minimum filter.",
      },
    ])
    // First emit
    const first = await runInjectDelta("status of km-tribe-recall-trigger please", store)
    if (first.skipped) throw new Error("expected first call to emit")
    // Simulate ~50 turns of unrelated activity (well under V2's TTL of 100)
    for (let i = 0; i < 50; i++) store.advanceTurn()
    // Same chunk would re-inject if TTL were 10 (V1); under V2 it must not
    const second = await runInjectDelta("status of km-tribe-recall-trigger please", store)
    expect(second.skipped).toBe(true)
    if (!second.skipped) return
    expect(second.reason).toBe("all_seen")
  })
})

describe("runInjectDelta — dedup tracking still works", () => {
  beforeEach(() => {
    recallMock.mockReset()
  })

  test("newKeys is recorded on the first surface, empty on the re-surface", async () => {
    const store = createMemorySeenStore()
    mockRecall([
      {
        sessionId: "sess-dedup001",
        sessionTitle: "dedup",
        type: "message",
        snippet: "A descriptive snippet that is plenty long enough to pass the minimum filter.",
      },
    ])
    const first = await runInjectDelta("tell me about km-board-state the refactor status please", store)
    if (first.skipped) throw new Error("expected non-skipped first call")
    expect(first.newKeys).toContain("sess-dedup001:message")

    const second = await runInjectDelta("tell me about km-board-state the refactor status please", store)
    // Second call dedup → all_seen → skipped (was footerOnly emit, now skip).
    expect(second.skipped).toBe(true)
    if (!second.skipped) return
    expect(second.reason).toBe("all_seen")
  })
})

describe("runInjectDelta — recall query bound (@ag/tribe/25071)", () => {
  beforeEach(() => {
    recallMock.mockReset()
    ensureProjectSourcesIndexedMock.mockReset()
  })

  test("an 8 KB salient prompt reaches recall with a query of at most MAX_RECALL_QUERY_CHARS", async () => {
    const { MAX_RECALL_QUERY_CHARS } = await import("../src/lib/prompt-filter.ts")
    mockRecall([])
    const head = "why does src/lib/inject-core.ts take thirty seconds on a pasted subagent result? "
    const prompt = (head + "the hook log shows the search phase dominating the whole budget again. ".repeat(120)).slice(
      0,
      8192,
    )
    expect(prompt.length).toBe(8192)

    await runInjectDelta(prompt, createMemorySeenStore())

    expect(recallMock).toHaveBeenCalled()
    const query = recallMock.mock.calls[0]![0] as string
    expect(query.length).toBeLessThanOrEqual(500)
    expect(prompt.startsWith(query)).toBe(true)
    expect(MAX_RECALL_QUERY_CHARS).toBe(500)
  })
})

// 25149 (@cto Q1, condition 4): recall binds a vault only explicitly, and an
// injection with nothing bound says so instead of reading as "no vault hits".
// The notice is framed like every injection: inside one <injected_context>
// envelope and followed by the protocol footer, never as bare user-role text.
describe("runInjectDelta — an unbound vault is said, once per session (25149)", () => {
  const unbound = { deps: { getVaultDbPath: () => null } }

  /** The envelope's inner text; throws if anything sits outside envelope + footer. */
  function framedInner(additionalContext: string, mode: string): string {
    const framed = new RegExp(
      `^<injected_context source="recall" mode="${mode}" trust="untrusted-reference"[^>]*tool_trigger="forbidden"[^>]*>\\n([\\s\\S]*)\\n</injected_context>\\n\\n`,
    ).exec(additionalContext)
    expect(framed, additionalContext).not.toBeNull()
    expect(additionalContext.slice(framed![0].length)).toBe(CONTEXT_PROTOCOL_FOOTER)
    return framed![1]!
  }

  beforeEach(() => {
    recallMock.mockReset()
  })

  test("the first injection of an unbound session carries the framed notice; the next does not", async () => {
    mockRecall([])
    const store = createMemorySeenStore()

    const first = await runInjectDelta("what is the status of km-storage-sync right now?", store, unbound)
    expect(first.skipped).toBe(false)
    if (first.skipped) return
    expect(framedInner(first.additionalContext, "notice")).toBe(`<vault-notice>${VAULT_UNBOUND_NOTICE}</vault-notice>`)
    expect(VAULT_UNBOUND_NOTICE).toContain("vault: not bound (pass --vault-db)")

    const second = await runInjectDelta("what is the status of km-storage-sync right now?", store, unbound)
    expect(second).toEqual({ skipped: true, reason: "no_results" })
  })

  // 25149 a1 re-cut over 25071 row 3: the notice replaces an empty injection, never the steps it skipped.
  test("an unbound first injection whose project-source step was skipped still names the skipped step", async () => {
    const { ProjectSourcesBusyError } = await import("../src/history/project-sources.ts")
    const busy = new ProjectSourcesBusyError("database is locked")
    ensureProjectSourcesIndexedMock.mockImplementation(() => {
      throw busy
    })
    try {
      mockRecall([])
      const first = await runInjectDelta("what is the status of km-storage-sync right now?", createMemorySeenStore(), unbound)
      expect(first.skipped).toBe(false)
      expect(first.skippedSteps).toEqual({ project_sources: busy.message })
    } finally {
      ensureProjectSourcesIndexedMock.mockReset()
    }
  })

  test("with snippets the notice sits inside the same envelope ahead of <recall-memory>; bound, it is absent", async () => {
    mockRecall([
      {
        sessionId: "sess-00000001",
        sessionTitle: "prior",
        type: "message",
        snippet: "A reasonably long descriptive snippet about prior work on the project.",
      },
    ])

    const unboundRun = await runInjectDelta("what did we last do on km-board-state?", createMemorySeenStore(), unbound)
    expect(unboundRun.skipped).toBe(false)
    if (unboundRun.skipped) return
    const inner = framedInner(unboundRun.additionalContext, "snippet")
    expect(inner.startsWith(`<vault-notice>${VAULT_UNBOUND_NOTICE}</vault-notice>\n<recall-memory>\n`)).toBe(true)

    const boundRun = await runInjectDelta("what did we last do on km-board-state?", createMemorySeenStore())
    expect(boundRun.skipped).toBe(false)
    if (boundRun.skipped) return
    expect(framedInner(boundRun.additionalContext, "snippet").startsWith("<recall-memory>\n")).toBe(true)
    expect(boundRun.additionalContext).not.toContain("not bound")
  })
})

describe("runInjectDelta — per-step durations (@ag/tribe/25071 row 1)", () => {
  beforeEach(() => {
    recallMock.mockReset()
    ensureProjectSourcesIndexedMock.mockReset()
  })

  const salientPrompt = "why does src/lib/inject-core.ts stall the prompt hook past thirty seconds tonight?"
  const busyWait = (ms: number): void => {
    const until = performance.now() + ms
    while (performance.now() < until) {
      // A synchronous step, like the SQLite writes it stands in for.
    }
  }

  test("each step records its own duration, so a slow run names its slow step", async () => {
    ensureProjectSourcesIndexedMock.mockImplementation(() => busyWait(60))
    recallMock.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ results: [] }), 40)))
    const steps: Record<string, number> = {}

    await runInjectDelta(salientPrompt, createMemorySeenStore(), { steps })

    expect(Object.keys(steps)).toEqual(
      expect.arrayContaining(["classify", "glossary", "project_sources", "advance_turn", "recall"]),
    )
    expect(steps.project_sources).toBeGreaterThanOrEqual(55)
    expect(steps.recall).toBeGreaterThanOrEqual(35)
    expect(steps.classify).toBeLessThan(55)
  })

  test("the glossary fallback is its own step, so a slow fallback is named apart from the first query", async () => {
    ensureProjectSourcesIndexedMock.mockImplementation(() => {})
    recallMock
      .mockImplementationOnce(() => Promise.resolve({ results: [] }))
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({ results: [] }), 40)))
    const steps: Record<string, number> = {}

    await runInjectDelta(salientPrompt, createMemorySeenStore(), { steps, deps: { findGlossaryAnchor: () => "tribe" } })

    expect(recallMock).toHaveBeenCalledTimes(2)
    expect(steps.recall_fallback).toBeGreaterThanOrEqual(35)
    expect(steps.recall).toBeLessThan(35)
  })

  test("three 0.4 ms steps under one name read 1 ms on the row, not 0: sums stay raw until roundSteps", async () => {
    const { roundSteps, timeStep, timeStepAsync } = await import("../src/lib/inject-core.ts")
    let now = 0
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now)
    try {
      const steps: Record<string, number> = {}
      for (let i = 0; i < 3; i++) {
        timeStep(steps, "classify", () => {
          now += 0.4
        })
        await timeStepAsync(steps, "recall", async () => {
          now += 0.4
        })
      }
      expect(roundSteps(steps)).toEqual({ classify: 1, recall: 1 })
    } finally {
      clock.mockRestore()
    }
  })

  test("a step that throws still records how long it ran before throwing", async () => {
    ensureProjectSourcesIndexedMock.mockImplementation(() => {
      busyWait(30)
      throw new Error("database is locked")
    })
    const steps: Record<string, number> = {}

    await expect(runInjectDelta(salientPrompt, createMemorySeenStore(), { steps })).rejects.toThrow(
      "database is locked",
    )

    expect(steps.project_sources).toBeGreaterThanOrEqual(25)
    expect(steps.recall).toBeUndefined()
  })
})

describe("runInjectDelta — a busy project-source step is skipped, never waited on (@ag/tribe/25071)", () => {
  beforeEach(() => {
    recallMock.mockReset()
    ensureProjectSourcesIndexedMock.mockReset()
  })

  const salientPrompt = "why does src/lib/inject-core.ts stall the prompt hook past thirty seconds tonight?"

  test.each([
    [
      "the index writer is held by a run",
      async () => new (await import("../src/history/db.ts")).IndexWriterBusyError("Recall index already active"),
    ],
    [
      "another connection holds SQLite's write lock",
      async () => new (await import("../src/history/project-sources.ts")).ProjectSourcesBusyError("database is locked"),
    ],
  ])("%s: recall still runs, and the result names the skipped step and why", async (_case, busy) => {
    const error = await busy()
    ensureProjectSourcesIndexedMock.mockImplementation(() => {
      throw error
    })
    mockRecall([])

    // No caller-supplied record: the daemon passes none, so the skip must travel in the result (25071 row 3 review).
    const result = await runInjectDelta(salientPrompt, createMemorySeenStore())

    expect(recallMock).toHaveBeenCalled()
    expect(result).toEqual({ skipped: true, reason: "no_results", skippedSteps: { project_sources: error.message } })
  })

  test.each([
    [
      "the index writer is held by a run",
      async () => new (await import("../src/history/db.ts")).IndexWriterBusyError("busy"),
    ],
    [
      "another connection holds SQLite's write lock",
      async () => new (await import("../src/history/project-sources.ts")).ProjectSourcesBusyError("database is locked"),
    ],
  ])("%s, and recall finds a hit: the injected result names the skipped step too", async (_case, busy) => {
    const error = await busy()
    ensureProjectSourcesIndexedMock.mockImplementation(() => {
      throw error
    })
    mockRecall([
      {
        sessionId: "sess-abcd1234",
        sessionTitle: "sess-title",
        type: "message",
        snippet: "A descriptive snippet that is plenty long enough to pass the minimum filter.",
      },
    ])

    // The common path (25071 row 3 review, round 2): a successful injection carries the skip as well.
    const result = await runInjectDelta("what did we decide about km-storage-sync layering?", createMemorySeenStore())

    expect(result.skipped).toBe(false)
    expect(result.skippedSteps).toEqual({ project_sources: error.message })
  })

  test("any other project-source failure still fails the hook", async () => {
    ensureProjectSourcesIndexedMock.mockImplementation(() => {
      throw new Error("disk I/O error")
    })
    await expect(runInjectDelta(salientPrompt, createMemorySeenStore())).rejects.toThrow("disk I/O error")
    expect(recallMock).not.toHaveBeenCalled()
  })
})

// 25071: the harness wraps what it hands a session in envelopes (Monitor events, tribe channel
// messages, reminders). They are not the operator's words, yet their boilerplate picked the glossary
// anchor "tribe", whose recall_fallback ran 3.1 s at p50 and 29.6 s at worst, against the 30 s kill.
describe("25071: harness envelopes never reach salience, the glossary or recall", () => {
  beforeEach(() => {
    recallMock.mockReset()
    ensureProjectSourcesIndexedMock.mockReset()
  })

  // The return reuses "low_salience" (no user text is salient): InjectSkipReason is public API. The
  // injection debug record names it "harness_envelope".
  test("a prompt that is only harness envelopes skips without salience, glossary or recall", async () => {
    const glossary = vi.fn(() => "tribe")
    for (const prompt of [
      '<task-notification>\n<task-id>b1</task-id>\n<summary>Monitor event: "@dev/11 queue"</summary>\n<event>QUEUE: task/dev11-25229-agy-trust-home pending</event>\n</task-notification>',
      '<channel source="plugin:tribe:tribe" from="@chief" type="request" message_id="m1">\nplease look at km-storage-sync\n</channel>',
      "<system-reminder>\nwhat did we decide about km-board-state?\n</system-reminder>",
      '<agent-message from="a8e4e5faade7d267e">\n25186 evidence: km-storage-sync is green\n</agent-message>',
    ]) {
      const result = await runInjectDelta(prompt, createMemorySeenStore(), { deps: { findGlossaryAnchor: glossary } })
      expect(result, prompt.slice(0, 40)).toMatchObject({ skipped: true, reason: "low_salience" })
    }
    expect(glossary).not.toHaveBeenCalled()
    expect(recallMock).not.toHaveBeenCalled()
  })

  test("typed text beside an envelope is all that salience and the glossary see", async () => {
    const glossary = vi.fn(() => null)
    mockRecall([])
    const typed = "what did we decide about km-storage-sync layering?"
    await runInjectDelta(
      `<system-reminder>\nthe tribe hook said tribe\n</system-reminder>\n${typed}\n<task-notification>\n<event>x</event>\n</task-notification>`,
      createMemorySeenStore(),
      { deps: { findGlossaryAnchor: glossary } },
    )
    expect(glossary).toHaveBeenCalledWith(typed)
    expect(recallMock.mock.calls[0]?.[0]).toBe(typed)
  })
})

describe("25071 row 2: the hook's recall runs in hook mode, inside the wall's budget", () => {
  const salientPrompt = "why does src/lib/inject-core.ts stall the prompt hook past thirty seconds tonight?"

  beforeEach(() => {
    recallMock.mockReset()
    ensureProjectSourcesIndexedMock.mockReset()
  })

  test("recall is asked for hook mode, with the wall's deadline", async () => {
    const { RECALL_WALL_MS } = await import("../src/history/recall-budget.ts")
    recallMock.mockResolvedValue({ results: [] })
    const before = Date.now()

    await runInjectDelta(salientPrompt, createMemorySeenStore())

    const options = recallMock.mock.calls[0]?.[1] as { mode?: string; deadlineAt?: number }
    expect(options.mode).toBe("hook")
    expect(options.deadlineAt).toBeGreaterThanOrEqual(before + RECALL_WALL_MS)
    expect(options.deadlineAt).toBeLessThanOrEqual(Date.now() + RECALL_WALL_MS)
  })

  test("the glossary fallback is skipped when the budget left cannot cover a candidate pass, and says so", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      recallMock.mockImplementationOnce(() => {
        vi.setSystemTime(Date.now() + 1200)
        return Promise.resolve({ results: [] })
      })

      const result = await runInjectDelta(salientPrompt, createMemorySeenStore(), {
        deps: { findGlossaryAnchor: () => "tribe" },
      })

      expect(recallMock).toHaveBeenCalledTimes(1)
      expect(result.skippedSteps).toEqual({ recall_fallback: 'recall_fallback skipped: anchor "tribe", 300 ms left (25071)' })
    } finally {
      vi.useRealTimers()
    }
  })

  test("recall's per-phase times join the steps, and a phase recall skipped is said in skippedSteps", async () => {
    recallMock.mockResolvedValue({
      results: [],
      timing: { searchMs: 20, phases: { messages: 12, corroboration: 3 } },
      skipped: [{ phase: "messages", anchor: "tribe", message: "recall messages skipped: (fixture)" }],
    })
    const steps: Record<string, number> = {}

    const result = await runInjectDelta(salientPrompt, createMemorySeenStore(), { steps })

    expect(steps["recall.messages"]).toBe(12)
    expect(steps["recall.corroboration"]).toBe(3)
    expect(result.skippedSteps).toEqual({ "recall.messages": "recall messages skipped: (fixture)" })
  })
})
