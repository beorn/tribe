/**
 * Tests for the injection-framing protocol emitted by runInjectDelta.
 *
 * Covers:
 *   - The trailing context-protocol footer is present on every substantive
 *     prompt, regardless of whether recall found new snippets.
 *   - The chokepoint's <injected_context> envelope carries the typed directive
 *     attributes (authority, changes_goal, tool_trigger).
 *   - Imperative-mood snippets are rewritten to reported-speech framing.
 *   - Trivial prompts (empty, short, slash, ack phrases) still skip cleanly
 *     with no output.
 *
 * See km-bearly.injection-framing for the protocol design.
 */

import { describe, test, expect, beforeEach, vi } from "vitest"
import { parseInjectedContext } from "../../injection-envelope/src/index.ts"

const {
  CONTEXT_PROTOCOL_FOOTER,
  createMemorySeenStore,
  rewriteImperativeAsReported,
  runInjectDelta: runInjectDeltaImpl,
  VAULT_UNBOUND_NOTICE,
} = await import("../src/lib/inject-core.ts")
const { RecallDeadlineError } = await import("../src/lib/recall-deadline.ts")

const recallMock = vi.fn()
const ensureProjectSourcesIndexedMock = vi.fn()
const FIXTURE_VAULT = "/fixture/vault/.km/state.db"

function runInjectDelta(
  prompt: Parameters<typeof runInjectDeltaImpl>[0],
  store: Parameters<typeof runInjectDeltaImpl>[1],
  opts: Partial<Parameters<typeof runInjectDeltaImpl>[2]> = {},
): ReturnType<typeof runInjectDeltaImpl> {
  return runInjectDeltaImpl(prompt, store, {
    // A bound vault by default: the unbound notice has its own describe below.
    vaultDb: FIXTURE_VAULT,
    ...opts,
    deps: {
      recall: recallMock as unknown as typeof import("../src/history/search.ts").recall,
      ensureProjectSourcesIndexed: ensureProjectSourcesIndexedMock,
      // No anchor by default, so only call B runs: the two-call rows name their anchor.
      deriveVaultAnchor: () => null,
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
  skipped?: Array<{ phase: string; anchor: string; message: string }>,
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
    ...(skipped ? { skipped } : {}),
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

  // @failure A substantive prompt whose recall found nothing injected nothing, so "searched, found nothing" and
  // "never searched" read the same (@ag/recall/three-dark-search-paths Phase 3: say what was searched, how long).
  test("no recall results — one framed line names what was searched and how long it took", async () => {
    mockRecall([])
    const result = await runInjectDelta("what is the status of km-storage-sync right now?", createMemorySeenStore())
    if (result.skipped) throw new Error("expected the searched-nothing line")
    expect(result.emptyRecallReason).toBe("no_results")
    const items = parseInjectedContext(result.additionalContext)[0]?.items ?? []
    expect(items.map((i) => i.body)).toEqual([
      expect.stringMatching(
        /^recall: nothing found; searched messages, session_content and titles for the prompt in \d+ ms \(25071\)$/,
      ),
    ])
  })

  test("all results deduped — the line says each result was already shown", async () => {
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
    if (result.skipped) throw new Error("expected the all-seen line")
    expect(result.emptyRecallReason).toBe("all_seen")
    expect(result.newKeys).toEqual([])
    expect(result.additionalContext).toMatch(/recall: 1 result, each already shown this session or filtered as noise;/)
  })

  test("new snippets — emits the chokepoint envelope followed by the footer", async () => {
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
    // Structural: the chokepoint's envelope (with its framed items) precedes the footer
    const envelopeIdx = result.additionalContext.indexOf('<injected_context source="recall"')
    const itemIdx = result.additionalContext.indexOf("  <item")
    const footerIdx = result.additionalContext.indexOf("<context-protocol>")
    expect(envelopeIdx).toBeGreaterThanOrEqual(0)
    expect(itemIdx).toBeGreaterThan(envelopeIdx)
    expect(footerIdx).toBeGreaterThan(itemIdx)
    // Footer is present verbatim at the end
    expect(result.additionalContext.endsWith(CONTEXT_PROTOCOL_FOOTER)).toBe(true)
  })

  test("the chokepoint envelope carries typed directive attributes", async () => {
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

  test("a custom snippetChars above the chokepoint default is forwarded, not re-capped at 300", async () => {
    const body = "x".repeat(500)
    mockRecall([{ sessionId: "sess-longchars", sessionTitle: "long body", type: "message", snippet: body }])
    const result = await runInjectDelta("what is the status of km-storage-sync right now?", createMemorySeenStore(), {
      snippetChars: 500,
    })
    if (result.skipped) throw new Error("expected non-skipped result")
    // recall's public snippetChars option must reach the chokepoint: dropping it
    // silently re-caps the item body at the chokepoint's own 300 default (28904).
    const item = parseInjectedContext(result.additionalContext)[0]?.items[0]
    expect(item?.body).toBeDefined()
    expect(item!.body.length).toBeGreaterThan(300)
  })

  test("a vault hit carries its full fs_path as `path`, never a truncated session", async () => {
    // A vault locator is a path, not an opaque session UUID — emitting it as
    // `sessionId` would make the envelope render an 8-char `session` and the
    // chat row prefer that over the full path (the 28904 review MUST). This
    // pins the LIVE runInjectDelta output, read back through the shared parser.
    mockRecall([
      {
        sessionId: "/pm/infra/docs/long-vault-path.md",
        sessionTitle: "infra notes",
        type: "vault",
        snippet: "A descriptive vault snippet that is plenty long enough to pass the minimum filter.",
      },
    ])
    const result = await runInjectDelta("what did we decide about km-storage-sync layering?", createMemorySeenStore())
    if (result.skipped) throw new Error("expected non-skipped result")
    const item = parseInjectedContext(result.additionalContext)[0]?.items.find((i) => i.type === "vault")
    expect(item?.path).toBe("/pm/infra/docs/long-vault-path.md")
    expect(item?.session).toBeUndefined()
    // No truncated 8-char session attribute leaked into the envelope.
    expect(result.additionalContext).not.toContain('session="/pm/infr"')
  })
})

describe("runInjectDelta — V2 gates", () => {
  beforeEach(() => {
    recallMock.mockReset()
  })

  test("a short statement with no identifier skips before recall fires", async () => {
    const result = await runInjectDelta("improve things a little more", createMemorySeenStore())
    expect(result).toEqual({ skipped: true, reason: "low_salience" })
    expect(recallMock).not.toHaveBeenCalled()
  })

  // @failure The operator's 51-character quota question (2026-10-14 22:42 PDT) was skipped low_salience in 51 ms with
  // no search at all, while the vault held the answer (pair-041; @cto 7f55e4f2: the cure is to search).
  test("a question is never skipped for lacking an identifier: it reaches recall", async () => {
    mockRecall([])
    const result = await runInjectDelta("what did we decide about ag status quota reporting?", createMemorySeenStore())
    expect(recallMock).toHaveBeenCalled()
    expect(result.skipped).toBe(false)
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

  test("low FTS rank is filtered out, and the line says none was strong enough", async () => {
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
    if (result.skipped) throw new Error("expected the low-quality line")
    expect(result.emptyRecallReason).toBe("low_quality")
    expect(result.additionalContext).toMatch(/recall: 1 result, none strong enough to show; searched /)
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
    if (result.skipped) throw new Error("expected the all-seen line")
    expect(result.emptyRecallReason).toBe("all_seen")
    expect(result.additionalContext).not.toContain("orthogonal")
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
    if (second.skipped) throw new Error("expected the all-seen line")
    expect(second.emptyRecallReason).toBe("all_seen")
    expect(second.newKeys).toEqual([])
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
    // Second call dedup → all_seen: the line, and no new key.
    if (second.skipped) throw new Error("expected the all-seen line")
    expect(second.emptyRecallReason).toBe("all_seen")
    expect(second.newKeys).toEqual([])
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
  const unbound = { vaultDb: null }

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
    const inner = framedInner(first.additionalContext, "snippet")
    expect(inner).toContain('title="vault notice"')
    expect(inner).toContain(VAULT_UNBOUND_NOTICE)
    expect(VAULT_UNBOUND_NOTICE).toContain("vault: not bound (pass --vault-db)")

    const second = await runInjectDelta("what is the status of km-storage-sync right now?", store, unbound)
    if (second.skipped) throw new Error("expected the searched-nothing line")
    expect(second.emptyRecallReason).toBe("no_results")
    expect(second.additionalContext).not.toContain("not bound")
  })

  // 25149 a1 re-cut over 25071 row 3: the notice replaces an empty injection, never the steps it skipped.
  test("an unbound first injection whose recall step had skipped phases still names the skipped step", async () => {
    mockRecall([], [{ phase: "messages", anchor: "test", message: "capped" }])
    const first = await runInjectDelta(
      "what is the status of km-storage-sync right now?",
      createMemorySeenStore(),
      unbound,
    )
    expect(first.skipped).toBe(false)
    expect(first.skippedSteps).toEqual({ "recall.messages": "capped" })
  })

  test("with snippets the notice rides as the first framed item; bound, it is absent", async () => {
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
    const noticeIdx = inner.indexOf('title="vault notice"')
    const recallItemIdx = inner.indexOf('title="prior"')
    expect(noticeIdx).toBeGreaterThanOrEqual(0)
    expect(recallItemIdx).toBeGreaterThan(noticeIdx)

    const boundRun = await runInjectDelta("what did we last do on km-board-state?", createMemorySeenStore())
    expect(boundRun.skipped).toBe(false)
    if (boundRun.skipped) return
    const boundInner = framedInner(boundRun.additionalContext, "snippet")
    expect(boundInner).toContain('title="prior"')
    expect(boundInner).not.toContain("vault notice")
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
    const store = createMemorySeenStore()
    vi.spyOn(store, "advanceTurn").mockImplementation(() => {
      busyWait(60)
      return 1
    })
    recallMock.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ results: [] }), 40)))
    const steps: Record<string, number> = {}

    await runInjectDelta(salientPrompt, store, { steps })

    expect(Object.keys(steps)).toEqual(expect.arrayContaining(["classify", "anchor", "advance_turn", "recall"]))
    expect(steps.advance_turn).toBeGreaterThanOrEqual(55)
    expect(steps.recall).toBeGreaterThanOrEqual(35)
    expect(steps.classify).toBeLessThan(55)
  })

  test("call A is its own step, recall_vault, so a slow vault call is named apart from call B", async () => {
    recallMock
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({ results: [] }), 40)))
      .mockImplementationOnce(() => Promise.resolve({ results: [] }))
    const steps: Record<string, number> = {}
    const anchor = { query: "inject-core.ts stall", identifier: "inject-core.ts" }

    await runInjectDelta(salientPrompt, createMemorySeenStore(), { steps, deps: { deriveVaultAnchor: () => anchor } })

    expect(recallMock).toHaveBeenCalledTimes(2)
    expect(steps.recall_vault).toBeGreaterThanOrEqual(35)
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
    const store = createMemorySeenStore()
    vi.spyOn(store, "advanceTurn").mockImplementation(() => {
      busyWait(30)
      throw new Error("store failed")
    })
    const steps: Record<string, number> = {}

    await expect(runInjectDelta(salientPrompt, store, { steps })).rejects.toThrow("store failed")

    expect(steps.advance_turn).toBeGreaterThanOrEqual(25)
    expect(steps.recall).toBeUndefined()
  })
})

describe("runInjectDelta — 25158 B3: project sources are off the prompt hook", () => {
  beforeEach(() => {
    recallMock.mockReset()
    ensureProjectSourcesIndexedMock.mockReset()
  })

  const salientPrompt = "why does src/lib/inject-core.ts stall the prompt hook past thirty seconds tonight?"

  test("prompt submit never calls ensureProjectSourcesIndexed", async () => {
    mockRecall([])
    await runInjectDelta(salientPrompt, createMemorySeenStore())
    expect(ensureProjectSourcesIndexedMock).not.toHaveBeenCalled()
  })

  test("prompt submit succeeds even when index writer is locked elsewhere", async () => {
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
    expect(ensureProjectSourcesIndexedMock).not.toHaveBeenCalled()
  })
})

// 25071: the harness wraps what it hands a session in envelopes (Monitor events, tribe channel
// messages, reminders). They are not the operator's words, yet their boilerplate picked the glossary
// anchor "tribe", whose recall_fallback ran 3.1 s at p50 and 29.6 s at worst, against the 30 s kill.
describe("25071: harness envelopes never reach salience, the vault anchor or recall", () => {
  beforeEach(() => {
    recallMock.mockReset()
    ensureProjectSourcesIndexedMock.mockReset()
  })

  // The return reuses "low_salience" (no user text is salient): InjectSkipReason is public API. The
  // injection debug record names it "harness_envelope".
  test("a prompt that is only harness envelopes skips without salience, the anchor or recall", async () => {
    const anchor = vi.fn(() => ({ query: "tribe", identifier: "tribe" }))
    for (const prompt of [
      '<task-notification>\n<task-id>b1</task-id>\n<summary>Monitor event: "@dev/11 queue"</summary>\n<event>QUEUE: task/dev11-25229-agy-trust-home pending</event>\n</task-notification>',
      '<channel source="plugin:tribe:tribe" from="@chief" type="request" message_id="m1">\nplease look at km-storage-sync\n</channel>',
      "<system-reminder>\nwhat did we decide about km-board-state?\n</system-reminder>",
      '<agent-message from="a8e4e5faade7d267e">\n25186 evidence: km-storage-sync is green\n</agent-message>',
    ]) {
      const result = await runInjectDelta(prompt, createMemorySeenStore(), { deps: { deriveVaultAnchor: anchor } })
      expect(result, prompt.slice(0, 40)).toMatchObject({ skipped: true, reason: "low_salience" })
    }
    expect(anchor).not.toHaveBeenCalled()
    expect(recallMock).not.toHaveBeenCalled()
  })

  test("typed text beside an envelope is all that salience and the anchor see", async () => {
    const anchor = vi.fn(() => null)
    mockRecall([])
    const typed = "what did we decide about km-storage-sync layering?"
    await runInjectDelta(
      `<system-reminder>\nthe tribe hook said tribe\n</system-reminder>\n${typed}\n<task-notification>\n<event>x</event>\n</task-notification>`,
      createMemorySeenStore(),
      { deps: { deriveVaultAnchor: anchor } },
    )
    expect(anchor).toHaveBeenCalledWith(typed, FIXTURE_VAULT)
    expect(recallMock.mock.calls[0]?.[0]).toBe(typed)
  })
})

describe("25071 row 2: the hook's recall runs in hook mode, inside the wall's budget", () => {
  const salientPrompt = "why does src/lib/inject-core.ts stall the prompt hook past thirty seconds tonight?"

  beforeEach(() => {
    recallMock.mockReset()
    ensureProjectSourcesIndexedMock.mockReset()
  })

  test("recall is asked for hook mode, naming the bound vault on every call", async () => {
    recallMock.mockResolvedValue({ results: [] })

    await runInjectDelta(salientPrompt, createMemorySeenStore())

    const options = recallMock.mock.calls[0]?.[1] as { mode?: string; vaultDb?: string; deadlineAt?: number }
    expect(options.mode).toBe("hook")
    expect(options.vaultDb).toBe(FIXTURE_VAULT)
    expect(options.deadlineAt).toBeUndefined()
  })

  // @failure The hook's recall runs in a Worker its --vault-db never reached, so from tribe e1ecf2f0 (2026-09-23) it
  // searched no vault; the vault now rides each call (@cto 456e6e77).
  test("every recall call carries the vault named on the injection; unbound, it carries null", async () => {
    recallMock.mockResolvedValue({ results: [] })

    await runInjectDelta(salientPrompt, createMemorySeenStore())
    await runInjectDelta(salientPrompt, createMemorySeenStore(), { vaultDb: null })

    expect(recallMock.mock.calls.map((call) => (call[1] as { vaultDb?: string | null }).vaultDb)).toEqual([
      FIXTURE_VAULT,
      null,
    ])
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

  /** @failure Several skipped synonym variants share one phase key, so only the last anchor was named (25397). */
  test("several skips of one phase are all said, each with its own anchor", async () => {
    recallMock.mockResolvedValue({
      results: [],
      timing: { searchMs: 20, phases: {} },
      skipped: [
        { phase: "synonym", anchor: "tribe", message: 'recall synonym skipped: anchor "tribe"' },
        { phase: "synonym", anchor: "wire", message: 'recall synonym skipped: anchor "wire"' },
      ],
    })

    const result = await runInjectDelta(salientPrompt, createMemorySeenStore(), { steps: {} })

    expect(result.skippedSteps).toEqual({
      "recall.synonym": 'recall synonym skipped: anchor "tribe"; recall synonym skipped: anchor "wire"',
    })
  })
})

describe("Phase 3: call A searches the vault on the anchor, call B the rest on the prompt (@cto 7f55e4f2)", () => {
  const JEV = "how does the Jev memory system and smarter linting work?"
  const anchor = { query: "Jev memory system", identifier: "Jev" }
  const vaultHit = {
    sessionId: "@i/20-search-and-memory/27897-memory-system.md",
    sessionTitle: "Jev memory system",
    type: "vault",
    snippet: "The memory system bead: classifier map-reduce, smarter linting, and the Jev notes.",
    rank: -4,
    timestamp: Date.now(),
  }
  const messageHit = {
    sessionId: "sess-linting",
    sessionTitle: "linting",
    type: "message",
    snippet: "A long descriptive message about smarter linting rules and how they were measured.",
    rank: -9,
    timestamp: Date.now(),
  }

  beforeEach(() => {
    recallMock.mockReset()
  })

  test("A is the anchor on the vault alone; B is the prompt on messages, session_content and titles", async () => {
    recallMock.mockResolvedValue({ results: [] })

    await runInjectDelta(JEV, createMemorySeenStore(), { deps: { deriveVaultAnchor: () => anchor } })

    expect(recallMock.mock.calls.map(([query, options]) => [query, (options as { phases?: string[] }).phases])).toEqual(
      [
        ["Jev memory system", ["vault"]],
        [JEV, ["messages", "session_content", "titles"]],
      ],
    )
  })

  test("with no vault bound, call A does not run", async () => {
    recallMock.mockResolvedValue({ results: [] })

    await runInjectDelta(JEV, createMemorySeenStore(), {
      vaultDb: null,
      deps: { deriveVaultAnchor: () => anchor },
    })

    expect(recallMock.mock.calls.map(([query]) => query)).toEqual([JEV])
  })

  test("the join never re-ranks: a vault hit whose boosted rank is worse than a message hit lands below it", async () => {
    recallMock.mockResolvedValueOnce({ results: [vaultHit] }).mockResolvedValueOnce({ results: [messageHit] })

    const result = await runInjectDelta(JEV, createMemorySeenStore(), {
      limit: 5,
      deps: { deriveVaultAnchor: () => anchor },
    })

    if (result.skipped) throw new Error("expected both hits injected")
    expect(result.newKeys).toEqual(["sess-linting:message", `${vaultHit.sessionId}:vault`])
  })

  test("B over the wall: A's hits are injected with one line naming A's time and B's unfinished phases", async () => {
    recallMock.mockResolvedValueOnce({ results: [vaultHit] }).mockRejectedValueOnce(new RecallDeadlineError(1500))

    const result = await runInjectDelta(JEV, createMemorySeenStore(), { deps: { deriveVaultAnchor: () => anchor } })

    if (result.skipped) throw new Error("expected A's answer")
    const line =
      /^recall partial: vault answered in \d+ ms; messages, session_content and titles did not finish inside the 1\.5 s wall \(25071\)$/
    expect(result.skippedSteps?.recall).toMatch(line)
    const items = parseInjectedContext(result.additionalContext)[0]?.items ?? []
    expect(items.map((i) => i.body)).toEqual([expect.stringMatching(line), vaultHit.snippet])
  })

  test("A over the wall: nothing answered, and the hook says so as it always has", async () => {
    recallMock.mockRejectedValueOnce(new RecallDeadlineError(1500))

    const result = await runInjectDelta(JEV, createMemorySeenStore(), { deps: { deriveVaultAnchor: () => anchor } })

    expect(recallMock).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      skipped: false,
      additionalContext: "recall skipped: over the 1.5 s wall (25071)",
      skippedSteps: { recall_vault: "recall skipped: over the 1.5 s wall (25071)" },
    })
  })

  test("nothing found names the vault anchor and both calls' times", async () => {
    recallMock.mockResolvedValue({ results: [] })

    const result = await runInjectDelta(JEV, createMemorySeenStore(), { deps: { deriveVaultAnchor: () => anchor } })

    if (result.skipped) throw new Error("expected the searched-nothing line")
    expect(parseInjectedContext(result.additionalContext)[0]?.items[0]?.body).toMatch(
      /^recall: nothing found; searched the vault for "Jev memory system" in \d+ ms, and messages, session_content and titles for the prompt in \d+ ms \(25071\)$/,
    )
  })
})
