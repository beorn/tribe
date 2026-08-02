import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

process.env.RECALL_DB_PATH = ":memory:"

const mockAgent: {
  result: Awaited<typeof import("../../src/lib/agent")>["recallAgent"] | null
  options: unknown
} = { result: null, options: null }

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
      spawnCmd: async () => ({ exitCode: 0 }),
    }),
  }
})

const { cmdSearch, resolveProjectScope } = await import("../../src/lib/search")
const { closeDb, ftsSearchWithSnippet, getDb, setIndexMeta } = await import("../../src/history/db")

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

function zeroAgentResult(query: string) {
  return {
    query,
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

describe("recall search output", () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    closeDb()
    mockAgent.result = null
    mockAgent.options = null
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    errSpy.mockRestore()
    closeDb()
  })

  test("ranks prose above matching tool-call payloads", () => {
    const terms = "streaming chunk boundary markdown split list items transcript"
    seedRankedMessage("prose", `We fixed the ${terms} bug by carrying parser state across chunks.`, null)
    seedRankedMessage("tool", Array(8).fill(terms).join(" "), "Bash")

    const result = ftsSearchWithSnippet(getDb(), terms, { limit: 2 })

    expect(result.results.map((row) => row.session_id)).toEqual(["sess-prose", "sess-tool"])
  })

  test("normalizes repo and worktree names while preserving explicit narrowing", () => {
    expect(resolveProjectScope(undefined, "/repos/km")).toBe("km")
    expect(resolveProjectScope(undefined, "/repos/km-wt7")).toBe("km")
    expect(resolveProjectScope("*km-wt7*", "/repos/km-wt1")).toBe("km-wt7")
  })

  test("agent zero-results raw-probes literal tokens before printing authoritative no-results", async () => {
    seedMessage("The prior session mentioned barenode in the architecture notes.")
    mockAgent.result = async (query) => zeroAgentResult(query) as never

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

    mockAgent.result = async (query) => zeroAgentResult(query) as never

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

  test("empty results print without invoking auto-refresh when refresh is disabled", async () => {
    mockAgent.result = async (query) => zeroAgentResult(query) as never
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
    expect(output).toContain('No results found for "nohits"')
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
    mockAgent.result = async (query) => zeroAgentResult(query) as never

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
    expect(output).toContain('No results found for "nohits"')
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
