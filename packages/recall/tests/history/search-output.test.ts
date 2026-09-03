import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

process.env.RECALL_DB_PATH = ":memory:"

const mockAgent: {
  result: Awaited<typeof import("../../src/lib/agent")>["recallAgent"] | null
  options: unknown
} = { result: null, options: null }
let mockRefreshSpawnCalls = 0

vi.mock("../../src/lib/agent.ts", () => ({
  recallAgent: (query: string, options: unknown) => {
    if (!mockAgent.result) throw new Error("Test did not install a mock recallAgent")
    mockAgent.options = options
    return mockAgent.result(query, options as never)
  },
}))

// Regression seam for @i/20-search-and-memory/23189: search must never import
// this query-refresh capability. If it is wired back in, the stale-search test
// observes the attempted incremental-index spawn without touching the user's DB.
vi.mock("../../src/lib/refresh.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/lib/refresh.ts")>()
  return {
    ...orig,
    makeRefreshDeps: (getLastRebuild: () => string | null) => ({
      getLastRebuild,
      now: () => Date.now(),
      getThresholdMs: () => 5 * 60 * 1000,
      spawnCmd: async () => {
        mockRefreshSpawnCalls++
        return { exitCode: 0 }
      },
    }),
  }
})

const { cmdSearch, resolveProjectScope } = await import("../../src/lib/search")
const { closeDb, ftsSearchWithSnippet, getDb, setIndexMeta } = await import("../../src/history/db")
const { resetVaultDbCacheForTests } = await import("../../src/history/vault-fts.ts")
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

// Minimal km vault db (`.km/state.db` shape) — mirrors
// vault-fts-fail-closed.test.ts's seedKmVaultDb. A single titled/pathed
// node is enough to prove rawSearch() reaches the vault at all.
function seedVaultDb(dbPath: string, content: string, secondContent?: string): void {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE nodes (
      rowid INTEGER PRIMARY KEY,
      id TEXT,
      parent_id TEXT,
      fs_path TEXT,
      name TEXT,
      title TEXT,
      content TEXT
    );
    CREATE VIRTUAL TABLE nodes_fts USING fts5(
      id, name, title, content,
      content='nodes',
      content_rowid='rowid',
      prefix='2,3,4',
      tokenize='unicode61 tokenchars ''@#+~'''
    );
    CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
      INSERT INTO nodes_fts(rowid, id, name, title, content)
      VALUES (new.rowid, new.id, new.name, new.title, new.content);
    END;
  `)
  const insert = db.prepare("INSERT INTO nodes (id, fs_path, name, title, content) VALUES (?, ?, ?, ?, ?)")
  insert.run("@i/vault-raw-fixture", "hub/vault-raw-fixture.md", "vault-raw-fixture", "Vault raw-mode fixture", content)
  if (secondContent !== undefined) {
    insert.run(
      "@i/vault-raw-fixture-2",
      "hub/vault-raw-fixture-2.md",
      "vault-raw-fixture-2",
      "Vault raw-mode fixture two",
      secondContent,
    )
  }
  db.close()
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

// Same shape as zeroAgentResult, but with a real lexical hit and a populated
// synthesisFailure — the "search succeeded, synthesis didn't" case that used
// to reach requireSynthesizedAnswer() directly and throw uncaught, discarding
// the result and exiting 1 instead of the documented 3. provenance defaults
// to "complete" so a passing test proves the fix, not a coincidental exit-3
// from cmdSearch's separate top-of-function provenance check.
// @i/20-search-and-memory/agent-mode-skips-exit-3
function synthesisFailureAgentResult(
  query: string,
  options?: { provenance?: "complete" | "stale" | "missing" | "unknown" },
) {
  return {
    query,
    provenance: options?.provenance ?? "complete",
    synthesis: null,
    results: [
      {
        type: "message" as const,
        sessionId: "sess-agentfail",
        sessionTitle: "Agent synthesis-failure fixture",
        timestamp: Date.now(),
        snippet: "agentsynthneedle must survive a failed synthesis, not be discarded",
        rank: -1,
      },
    ],
    durationMs: 42,
    synthesisFailure: {
      summary:
        "No LLM provider is available (see Excluded below for why). 1 lexical result found; rerun with --raw to see them without an LLM.",
      totalBudgetMs: 10000,
      attempts: [],
      batches: [],
      excludedProviders: [],
      consideredProviders: [],
    },
    trace: {
      rounds: [
        {
          round: 1,
          mode: "off",
          planner: { model: "mock", elapsedMs: 1 },
          plan: { keywords: ["agentsynthneedle"], phrases: [], concepts: [], paths: [], errors: [], bead_ids: [] },
          variants: ["agentsynthneedle"],
          stats: { totalQueries: 1, rawHits: 1, uniqueDocs: 1, topCoverage: 1, medianCoverage: 1, msTotal: 1 },
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
    mockRefreshSpawnCalls = 0
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

  // Regression for @i/20-search-and-memory/23189/recall-bay-scope-empty:
  // rawSearch() (the `--raw` path) predates vault search and never called
  // searchVault() — a --raw query silently never saw beads/docs/CLAUDE.md
  // even though the default synthesis path does. This is the exact shape
  // the operator's repro used: `bun recall "..." --raw --since 120d`.
  test("raw mode includes vault matches (beads/docs), not just transcript hits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-raw-vault-"))
    const dbPath = join(dir, "state.db")
    const previousVaultDb = process.env.KM_VAULT_DB
    try {
      seedVaultDb(dbPath, "vaultrawneedle only lives in the km vault, never in a session transcript")
      process.env.KM_VAULT_DB = dbPath
      resetVaultDbCacheForTests()

      await cmdSearch("vaultrawneedle", { raw: true, project: "*" })

      const output = callsText(logSpy)
      expect(output).toContain("Vault")
      expect(output).toContain("Vault raw-mode fixture")
      expect(output).toContain("vaultrawneedle")
    } finally {
      resetVaultDbCacheForTests()
      if (previousVaultDb === undefined) delete process.env.KM_VAULT_DB
      else process.env.KM_VAULT_DB = previousVaultDb
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('raw mode JSON includes vault matches with contentType "vault"', async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-raw-vault-json-"))
    const dbPath = join(dir, "state.db")
    const previousVaultDb = process.env.KM_VAULT_DB
    try {
      seedVaultDb(dbPath, "vaultrawjsonneedle only lives in the km vault")
      process.env.KM_VAULT_DB = dbPath
      resetVaultDbCacheForTests()

      await cmdSearch("vaultrawjsonneedle", { raw: true, json: true, project: "*" })

      const payload = lastJsonLog<{ results: Array<{ contentType: string; snippet: string }> | null }>(logSpy)
      expect(payload.results).not.toBeNull()
      const vaultRow = payload.results!.find((r) => r.contentType === "vault")
      expect(vaultRow).toBeDefined()
      expect(vaultRow!.snippet).toContain("vaultrawjsonneedle")
    } finally {
      resetVaultDbCacheForTests()
      if (previousVaultDb === undefined) delete process.env.KM_VAULT_DB
      else process.env.KM_VAULT_DB = previousVaultDb
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("raw mode applies limit to vault results", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-raw-vault-limit-"))
    const dbPath = join(dir, "state.db")
    const previousVaultDb = process.env.KM_VAULT_DB
    try {
      seedVaultDb(dbPath, "vaultlimitneedle first", "vaultlimitneedle second")
      process.env.KM_VAULT_DB = dbPath
      resetVaultDbCacheForTests()

      await cmdSearch("vaultlimitneedle", { raw: true, json: true, limit: "1", project: "*" })

      const payload = lastJsonLog<{ results: Array<{ contentType: string }> | null }>(logSpy)
      expect(payload.results?.filter((result) => result.contentType === "vault")).toHaveLength(1)
    } finally {
      resetVaultDbCacheForTests()
      if (previousVaultDb === undefined) delete process.env.KM_VAULT_DB
      else process.env.KM_VAULT_DB = previousVaultDb
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test.each([
    ["--question", { question: true }],
    ["--response", { response: true }],
    ["--tool", { tool: "Read" }],
    ["--session", { session: "session-filter" }],
    ["--include messages", { include: "messages" }],
  ])("raw mode excludes unfilterable vault rows with %s", async (_label, filter) => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-raw-vault-filter-"))
    const dbPath = join(dir, "state.db")
    const previousVaultDb = process.env.KM_VAULT_DB
    try {
      seedVaultDb(dbPath, "vaultfilterneedle only lives in the km vault")
      process.env.KM_VAULT_DB = dbPath
      resetVaultDbCacheForTests()

      await cmdSearch("vaultfilterneedle", { raw: true, json: true, project: "*", ...filter })

      const payload = lastJsonLog<{ results: Array<{ contentType: string }> | null }>(logSpy)
      expect(payload.results?.some((result) => result.contentType === "vault") ?? false).toBe(false)
    } finally {
      resetVaultDbCacheForTests()
      if (previousVaultDb === undefined) delete process.env.KM_VAULT_DB
      else process.env.KM_VAULT_DB = previousVaultDb
      rmSync(dir, { recursive: true, force: true })
    }
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

  test("concurrent stale searches report unproven without starting index refreshes", async () => {
    setIndexMeta(getDb(), "last_rebuild", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())

    mockAgent.result = async (query, options) => zeroAgentResult(query, options) as never
    const previousExitCode = process.exitCode
    process.exitCode = 0

    try {
      await Promise.all(
        ["nohits-a", "nohits-b"].map((query) =>
          cmdSearch(query, {
            agent: true,
            limit: "5",
            round2: "off",
          }),
        ),
      )

      expect(mockRefreshSpawnCalls).toBe(0)
      expect(callsText(errSpy)).not.toContain("auto-refresh")
      expect(callsText(logSpy)).toContain('0 results — UNPROVEN (stale index) for "nohits-a"')
      expect(callsText(logSpy)).toContain('0 results — UNPROVEN (stale index) for "nohits-b"')
      expect(process.exitCode).toBe(3)
    } finally {
      process.exitCode = previousExitCode
    }
  })

  test("a stale index cannot produce authoritative empty JSON", async () => {
    setIndexMeta(getDb(), "last_rebuild", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
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

  // Regression for @i/20-search-and-memory/agent-mode-skips-exit-3: agent
  // mode used to call requireSynthesizedAnswer() directly and let it throw
  // uncaught on a search-succeeded-synthesis-failed result, discarding the
  // lexical hits and exiting 1 (generic crash) instead of 3
  // (degraded-but-useful). Mirrors the non-agent "reports a loud
  // tool-broken failure" test above.
  test("agent mode preserves lexical results and exits 3 on synthesis failure, instead of discarding them and exiting 1", async () => {
    mockAgent.result = async (query, options) => synthesisFailureAgentResult(query, options) as never
    const previousExitCode = process.exitCode
    process.exitCode = 0

    try {
      // Must NOT throw — see the non-agent test above for why.
      await expect(cmdSearch("agentsynthneedle", { agent: true, project: "*", round2: "off" })).resolves.toBeUndefined()

      const output = callsText(logSpy)
      expect(output).toContain("RECALL SYNTHESIS FAILED")
      expect(output).toContain("THE TOOL IS BROKEN, NOT EMPTY")
      expect(output).toContain("agentsynthneedle must survive a failed synthesis")
      expect(output).toContain("Lexical search: OK")
      // Distinct exit code — degraded-but-has-results is neither a clean 0
      // nor the generic 1 an uncaught throw used to produce.
      expect(process.exitCode).toBe(3)
    } finally {
      process.exitCode = previousExitCode
    }
  })

  test("agent mode JSON preserves lexical results on synthesis failure instead of throwing uncaught", async () => {
    mockAgent.result = async (query, options) => synthesisFailureAgentResult(query, options) as never
    const previousExitCode = process.exitCode
    process.exitCode = 0

    try {
      await expect(
        cmdSearch("agentsynthneedle", { agent: true, json: true, project: "*", round2: "off" }),
      ).resolves.toBeUndefined()

      const payload = lastJsonLog<{ results: unknown[] | null }>(logSpy)
      expect(process.exitCode).toBe(3)
      expect(payload.results).toHaveLength(1)
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

  test("a fresh index marks empty JSON as complete and authoritative", async () => {
    setIndexMeta(getDb(), "last_rebuild", new Date().toISOString())
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

  test("the no-refresh compatibility flag preserves unknown provenance", async () => {
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
