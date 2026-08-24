import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

process.env.RECALL_DB_PATH = ":memory:"

const mockAgent: {
  result: Awaited<typeof import("../../src/lib/agent")>["recallAgent"] | null
  options: unknown
} = { result: null, options: null }
let mockRefreshSpawnError: string | null = null

vi.mock("../../src/lib/agent.ts", () => ({
  recallAgent: (query: string, options: unknown) => {
    if (!mockAgent.result) throw new Error("Test did not install a mock recallAgent")
    mockAgent.options = options
    return mockAgent.result(query, options as never)
  },
}))

// Stale-index auto-refresh shells out to `bun recall index --incremental` as a
// real subprocess. In-process tests must NOT spawn it — it indexes the user's
// actual recall DB and hangs the test (10s timeout). Replace only the spawn
// dep with an instant no-op; the real staleness-decision logic in
// `refreshIndexIfStaleWithDeps` still runs (so the stale → refreshed note path
// is exercised). The subprocess itself is covered by refresh.ts's own
// dep-injected unit tests.
vi.mock("../../src/lib/refresh.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/lib/refresh.ts")>()
  return {
    ...orig,
    makeRefreshDeps: (getLastRebuild: () => string | null) => ({
      getLastRebuild,
      now: () => Date.now(),
      getThresholdMs: () => 5 * 60 * 1000,
      spawnCmd: async () => {
        if (mockRefreshSpawnError) throw new Error(mockRefreshSpawnError)
        return { exitCode: 0 }
      },
    }),
  }
})

const { cmdSearch, resolveProjectScope } = await import("../../src/lib/search")
const { closeDb, ftsSearchWithSnippet, getDb, setIndexMeta } = await import("../../src/history/db")
const { _resetLlmBackendForTests } = await import("../../src/lib/llm-backend")

function seedMessage(content: string, id = "a", projectPath = "/test/km"): void {
  const db = getDb()
  const now = Date.now()
  db.prepare(
    `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(`sess-${id}`, projectPath, `/tmp/sess-${id}.jsonl`, now - 60_000, now, 1, `Session ${id}`)
  db.prepare(`INSERT INTO messages (uuid, session_id, type, content, timestamp) VALUES (?, ?, ?, ?, ?)`).run(
    `msg-${id}`,
    `sess-${id}`,
    "user",
    content,
    now,
  )
}

function seedRankedMessage(id: string, content: string, toolName: string | null): void {
  const db = getDb()
  const now = Date.now()
  db.prepare(
    `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(`sess-${id}`, "/test/km", `/tmp/sess-${id}.jsonl`, now - 60_000, now, 1, `Session ${id}`)
  db.prepare(
    `INSERT INTO messages (uuid, session_id, type, content, tool_name, file_paths, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(`msg-${id}`, `sess-${id}`, "assistant", content, toolName, null, now)
}

function zeroAgentResult(query: string, options?: { provenance?: "complete" | "stale" | "missing" | "unknown" }) {
  return {
    query,
    provenance: options?.provenance ?? "unknown",
    synthesis: null,
    results: [],
    durationMs: 12,
    trace: {
      rounds: [
        {
          round: 1,
          mode: "off",
          planner: { model: "mock", elapsedMs: 1 },
          plan: { keywords: ["missed-token"], phrases: [], concepts: [], paths: [], errors: [], bead_ids: [] },
          variants: ["missed-token"],
          stats: { totalQueries: 1, rawHits: 0, uniqueDocs: 0, topCoverage: 0, medianCoverage: 0, msTotal: 1 },
        },
      ],
      decision: { round2Mode: "off", reason: "test" },
      synthPath: "none",
      synthCallsUsed: 0,
      round1ShortCircuited: false,
    },
    fellThrough: false,
  }
}

function callsText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((args: unknown[]) => args.join(" ")).join("\n")
}

function lastJsonLog<T>(spy: ReturnType<typeof vi.spyOn>): T {
  const jsonOutput = spy.mock.calls.at(-1)?.[0]
  expect(jsonOutput).toBeTypeOf("string")
  return JSON.parse(String(jsonOutput)) as T
}

describe("recall search output", () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let errSpy: ReturnType<typeof vi.spyOn>
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    closeDb()
    mockAgent.result = null
    mockAgent.options = null
    mockRefreshSpawnError = null
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  })

  afterEach(() => {
    _resetLlmBackendForTests()
    logSpy.mockRestore()
    errSpy.mockRestore()
    stderrWriteSpy.mockRestore()
    closeDb()
  })

  test("reports a loud tool-broken failure — with the lexical hits, clearly labeled, never silently dropped — when default synthesis is unavailable", async () => {
    const previousLlmDir = process.env.TRIBE_LLM_DIR
    const previousExitCode = process.exitCode
    delete process.env.TRIBE_LLM_DIR
    _resetLlmBackendForTests()
    seedMessage("synthesisneedle fixture must show up labeled as a lexical hit, never as a synthesized answer")

    try {
      // Must NOT throw — a synthesis failure with real lexical results in
      // hand is a distinct, reportable outcome, not a crash. Throwing here
      // is exactly the defect this test used to encode: it discards the
      // results recall() already found.
      await expect(cmdSearch("synthesisneedle", { refresh: false, project: "*" })).resolves.toBeUndefined()
    } finally {
      if (previousLlmDir === undefined) delete process.env.TRIBE_LLM_DIR
      else process.env.TRIBE_LLM_DIR = previousLlmDir
    }

    const output = callsText(logSpy)
    // Unmistakable banner — must not read as "no prior work exists".
    expect(output).toContain("RECALL SYNTHESIS FAILED")
    expect(output).toContain("THE TOOL IS BROKEN, NOT EMPTY")
    // The lexical hit is present, but labeled — never masquerading as a
    // synthesized answer (it's under "Lexical search: OK", not printed as
    // if it were `result.synthesis`). The matched term is ANSI-highlighted
    // inline, so assert on the unhighlighted tail of the snippet.
    expect(output).toContain("fixture must show up labeled as a lexical hit")
    expect(output).toContain("Lexical search: OK")
    // Concrete diagnostics: this failure mode (no LLM backend configured at
    // all) has no per-provider exclusions to list — there's nothing to
    // evaluate providers against — so the summary line carries the "why",
    // and it must say so, not silently print an empty report.
    expect(output).toContain("No LLM backend configured")
    expect(output).toContain("TRIBE_LLM_DIR")
    expect(output).toContain("--raw")
    // Distinct exit code — degraded-but-has-results is neither a clean 0
    // nor the generic 1 a hard crash would use.
    expect(process.exitCode).toBe(3)

    process.exitCode = previousExitCode
  })

  test("normalizes repo and worktree names while preserving explicit narrowing", () => {
    expect(resolveProjectScope(undefined, "/repos/km")).toBe("km")
    expect(resolveProjectScope(undefined, "/repos/km-wt7")).toBe("km")
    expect(resolveProjectScope("*km-wt7*", "/repos/km-wt1")).toBe("km-wt7")
  })

  test("ranks prose above matching tool-call payloads", () => {
    const terms = "streaming chunk boundary markdown split list items transcript"
    seedRankedMessage("prose", `We fixed the ${terms} bug by carrying parser state across chunks.`, null)
    seedRankedMessage("tool", Array(8).fill(terms).join(" "), "Bash")

    const result = ftsSearchWithSnippet(getDb(), terms, { limit: 2 })

    expect(result.results.map((row) => row.session_id)).toEqual(["sess-prose", "sess-tool"])
  })

  test("agent zero-results raw-probes literal tokens before printing authoritative no-results", async () => {
    seedMessage("The prior session mentioned barenode in the architecture notes.")
    mockAgent.result = async (query, options) => zeroAgentResult(query, options) as never

    await cmdSearch("how should we debug barenode", {
      agent: true,
      project: "km",
      limit: "5",
      round2: "off",
      refresh: false,
    })

    const output = callsText(logSpy)
    expect(output).toContain("agent variants missed literal raw matches")
    expect(output).toContain("1 results")
    expect(output).toContain("barenode")
    expect(output).not.toContain('No results found for "how should we debug barenode"')
  })

  test("stale index auto-refreshes before empty results", async () => {
    setIndexMeta(getDb(), "last_rebuild", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())

    mockAgent.result = async (query, options) => zeroAgentResult(query, options) as never

    await cmdSearch("nohits", {
      agent: true,
      limit: "5",
      round2: "off",
    })

    const errors = callsText(errSpy)
    const output = callsText(logSpy)
    // A ~2h-stale index triggers the auto-refresh note (the prior warn-only
    // "FTS5 index last rebuilt" behavior was superseded by auto-refresh —
    // search.ts emitRefreshNote). It prints BEFORE the empty-results answer.
    expect(errors).toContain("stale — refreshed")
    expect(output).toContain('No results found for "nohits"')
  })

  test("a bounded refresh timeout cannot produce authoritative empty JSON", async () => {
    setIndexMeta(getDb(), "last_rebuild", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
    mockRefreshSpawnError =
      '"bun" "recall" "index" "--incremental" exceeded 5000ms; sent SIGTERM then SIGKILL after 2000ms'
    const previousExitCode = process.exitCode
    process.exitCode = 0

    try {
      await cmdSearch("nohits", { raw: true, json: true, project: "*", limit: "5" })

      const payload = lastJsonLog<{
        provenance?: string
        total: number | null
        results: unknown[] | null
      }>(logSpy)
      expect(process.exitCode).toBe(3)
      expect(payload.provenance).toBe("stale")
      expect(payload.total).toBeNull()
      expect(payload.results).toBeNull()
    } finally {
      process.exitCode = previousExitCode
    }
  })

  test("degraded index provenance preserves useful positive JSON hits", async () => {
    seedMessage("stalepositive evidence remains useful even when freshness is degraded")
    setIndexMeta(getDb(), "last_rebuild", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
    mockRefreshSpawnError =
      '"bun" "recall" "index" "--incremental" exceeded 5000ms; sent SIGTERM then SIGKILL after 2000ms'
    const previousExitCode = process.exitCode
    process.exitCode = 0

    try {
      await cmdSearch("stalepositive", { raw: true, json: true, project: "*", limit: "5" })

      const payload = lastJsonLog<{ provenance?: string; total: number | null; results: unknown[] | null }>(logSpy)
      expect(process.exitCode).toBe(3)
      expect(payload.provenance).toBe("stale")
      expect(payload.total).toBe(1)
      expect(payload.results).toHaveLength(1)
    } finally {
      process.exitCode = previousExitCode
    }
  })

  test("degraded default JSON discriminates an unproven empty result", async () => {
    setIndexMeta(getDb(), "last_rebuild", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
    mockRefreshSpawnError =
      '"bun" "recall" "index" "--incremental" exceeded 5000ms; sent SIGTERM then SIGKILL after 2000ms'
    const previousExitCode = process.exitCode
    process.exitCode = 0

    try {
      await cmdSearch("nohits", { json: true, project: "*", limit: "5" })

      const payload = lastJsonLog<{ provenance?: string; results: unknown[] | null }>(logSpy)
      expect(process.exitCode).toBe(3)
      expect(payload.provenance).toBe("stale")
      expect(payload.results).toBeNull()
    } finally {
      process.exitCode = previousExitCode
    }
  })

  test("degraded agent JSON discriminates an unproven empty result", async () => {
    setIndexMeta(getDb(), "last_rebuild", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
    mockRefreshSpawnError =
      '"bun" "recall" "index" "--incremental" exceeded 5000ms; sent SIGTERM then SIGKILL after 2000ms'
    mockAgent.result = async (query, options) => zeroAgentResult(query, options) as never
    const previousExitCode = process.exitCode
    process.exitCode = 0

    try {
      await cmdSearch("nohits", { agent: true, json: true, project: "*", limit: "5", round2: "off" })

      const payload = lastJsonLog<{ provenance?: string; results: unknown[] | null }>(logSpy)
      expect(process.exitCode).toBe(3)
      expect(payload.provenance).toBe("stale")
      expect(payload.results).toBeNull()
    } finally {
      process.exitCode = previousExitCode
    }
  })

  test("no-refresh cannot launder unknown index provenance", async () => {
    const previousExitCode = process.exitCode
    process.exitCode = 0

    try {
      await cmdSearch("nohits", { raw: true, refresh: false, project: "*", limit: "5" })

      expect(process.exitCode).toBe(3)
      expect(callsText(logSpy)).toContain('0 matches — UNPROVEN (unknown index) for "nohits"')
    } finally {
      process.exitCode = previousExitCode
    }
  })

  test("successful refresh marks empty JSON as complete and authoritative", async () => {
    setIndexMeta(getDb(), "last_rebuild", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
    const previousExitCode = process.exitCode
    process.exitCode = 0

    try {
      await cmdSearch("nohits", { raw: true, json: true, project: "*", limit: "5" })

      const payload = lastJsonLog<{ provenance?: string; total: number | null; results: unknown[] | null }>(logSpy)
      expect(process.exitCode).toBe(0)
      expect(payload.provenance).toBe("complete")
      expect(payload.total).toBe(0)
      expect(payload.results).toEqual([])
    } finally {
      process.exitCode = previousExitCode
    }
  })

  test("empty results print without invoking auto-refresh when refresh is disabled", async () => {
    mockAgent.result = async (query, options) => zeroAgentResult(query, options) as never
    const prevHome = process.env.HOME
    const home = mkdtempSync(join(tmpdir(), "recall-home-"))

    try {
      process.env.HOME = home
      await cmdSearch("nohits", {
        agent: true,
        limit: "5",
        round2: "off",
        refresh: false,
      })
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      rmSync(home, { recursive: true, force: true })
    }

    const errors = callsText(errSpy)
    const output = callsText(logSpy)
    expect(errors).toBe("")
    expect(output).toContain('0 results — UNPROVEN (unknown index) for "nohits"')
  })

  test("defaults search to the current repo family across sibling worktrees", async () => {
    const prevHome = process.env.HOME
    const prevCwd = process.cwd()
    const home = mkdtempSync(join(tmpdir(), "recall-home-"))
    const parent = mkdtempSync(join(tmpdir(), "recall-projects-"))
    const project = join(parent, "km-wt1")
    mkdirSync(project)
    process.env.HOME = home
    process.chdir(project)
    mockAgent.result = async (query, options) => zeroAgentResult(query, options) as never

    try {
      await cmdSearch("nohits", {
        agent: true,
        limit: "5",
        round2: "off",
        refresh: false,
      })
    } finally {
      process.chdir(prevCwd)
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      rmSync(home, { recursive: true, force: true })
      rmSync(parent, { recursive: true, force: true })
    }

    const errors = callsText(errSpy)
    const output = callsText(logSpy)
    expect(mockAgent.options).toMatchObject({ projectFilter: "km" })
    expect(errors).not.toContain("sibling worktree project dir(s) detected")
    expect(output).toContain('0 results — UNPROVEN (unknown index) for "nohits"')
  })

  test("default raw search includes sibling worktrees but excludes unrelated repos", async () => {
    const prevCwd = process.cwd()
    const parent = mkdtempSync(join(tmpdir(), "recall-projects-"))
    const project = join(parent, "km-wt1")
    mkdirSync(project)
    process.chdir(project)
    seedMessage("familyscope marker", "sibling", "/repos/km-wt7")
    seedMessage("familyscope marker", "unrelated", "/repos/elsewhere")

    try {
      await cmdSearch("familyscope", { raw: true, refresh: false })
    } finally {
      process.chdir(prevCwd)
      rmSync(parent, { recursive: true, force: true })
    }

    const output = callsText(logSpy)
    expect(output).toContain("Found 1 matches")
    expect(output).toContain("/repos/km/wt7")
    expect(output).not.toContain("elsewhere")
  })
})
