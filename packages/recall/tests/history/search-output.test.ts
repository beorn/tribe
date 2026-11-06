/**
 * @reach fs-walk <fixture-only: snapshot sidecar checks list only this test's mkdtempSync directory>
 */
import { assertSingleStatement } from "@bearly/sqlite"
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Database } from "bun:sqlite"
import { safeRemoveSync } from "removely"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { unavailableCostMethods } from "../helpers/llm-mock.ts"

process.env.RECALL_DB_PATH = ":memory:"

async function runRecallCli(argv: string[], env: NodeJS.ProcessEnv) {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../../src/cli.ts", import.meta.url)), ...argv], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, code }
}

const mockAgent: {
  result: Awaited<typeof import("../../src/lib/agent")>["recallAgent"] | null
  options: unknown
} = { result: null, options: null }

function makeAgentMock() {
  const exported = {
    recallAgent: (query: string, options: unknown) => {
      if (!mockAgent.result) throw new Error("Test did not install a mock recallAgent")
      mockAgent.options = options
      return mockAgent.result(query, options as never)
    },
  }
  return exported
}

vi.mock("../../src/lib/agent.ts", () => makeAgentMock())

// The vault semantic leg's model route (@ag/recall/three-dark-search-paths): counted, so a test proves a path never
// loads a model; no test here needs a real one.
const llamaLoads = vi.hoisted(() => ({ count: 0 }))
vi.mock("node-llama-cpp", () => ({
  getLlama: async () => {
    llamaLoads.count++
    throw new Error("search-output tests load no query model")
  },
}))

type SearchModule = typeof import("../../src/lib/search")
type DbModule = typeof import("../../src/history/db")
type VaultModule = typeof import("../../src/history/vault-fts.ts")

// Each test resolves a fresh module graph (vi.resetModules + dynamic import),
// so the db/vault/LLM-backend memos a prior test left behind cannot leak into
// this one — the module-scoped reset exports used to be the only way to get
// that, but a fresh graph IS the reset.
let cmdSearch: SearchModule["cmdSearch"]
let resolveProjectScope: SearchModule["resolveProjectScope"]
let closeDb: DbModule["closeDb"]
let ftsSearchWithSnippet: DbModule["ftsSearchWithSnippet"]
let getDb: DbModule["getDb"]
let setIndexMeta: DbModule["setIndexMeta"]
let bindVaultDb: VaultModule["bindVaultDb"]

async function loadModules(): Promise<void> {
  vi.resetModules()
  const search = await import("../../src/lib/search")
  // search.ts imports these, so the dynamic imports resolve the same instances.
  const db = await import("../../src/history/db")
  const vault = await import("../../src/history/vault-fts.ts")
  cmdSearch = search.cmdSearch
  resolveProjectScope = search.resolveProjectScope
  closeDb = db.closeDb
  ftsSearchWithSnippet = db.ftsSearchWithSnippet
  getDb = db.getDb
  setIndexMeta = db.setIndexMeta
  bindVaultDb = vault.bindVaultDb
}

function seedMessage(content: string, id = "a", projectPath = "/test/km"): void {
  const db = getDb()
  const now = Date.now()
  db.prepare(
    `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title, cwd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`sess-${id}`, projectPath, `/tmp/sess-${id}.jsonl`, now - 60_000, now, 1, `Session ${id}`, projectPath)
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
    `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title, cwd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`sess-${id}`, "/test/km", `/tmp/sess-${id}.jsonl`, now - 60_000, now, 1, `Session ${id}`, "/test/km")
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
  for (const sql of [
    `
    CREATE TABLE nodes (
      rowid INTEGER PRIMARY KEY,
      id TEXT,
      parent_id TEXT,
      fs_path TEXT,
      name TEXT,
      title TEXT,
      content TEXT
    );`,
    `    CREATE VIRTUAL TABLE nodes_fts USING fts5(
      id, name, title, content,
      content='nodes',
      content_rowid='rowid',
      prefix='2,3,4',
      tokenize='unicode61 tokenchars ''@#+~'''
    );`,
    `    CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
      INSERT INTO nodes_fts(rowid, id, name, title, content)
      VALUES (new.rowid, new.id, new.name, new.title, new.content);
    END;`,
  ]) {
    db.exec(assertSingleStatement(sql))
  }
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

function zeroAgentResult(
  query: string,
  options?: Pick<import("../../src/history/recall-shared").RecallOptions, "provenance">,
) {
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
  options?: Pick<import("../../src/history/recall-shared.ts").RecallOptions, "provenance">,
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

function jsonStdout<T>(spy: ReturnType<typeof vi.spyOn>): T {
  // Consumers parse all stdout; selecting the last call hid human prefaces.
  return JSON.parse(callsText(spy)) as T
}

describe("recall search output", () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let errSpy: ReturnType<typeof vi.spyOn>
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    await loadModules()
    mockAgent.result = null
    mockAgent.options = null
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  })

  afterEach(() => {
    logSpy.mockRestore()
    errSpy.mockRestore()
    stderrWriteSpy.mockRestore()
    closeDb()
  })

  // The CLI must distinguish a rejected window from a complete empty search.
  // Pure parser tests and the raw-only refusal missed synthesis mode's silent zero.
  test("the CLI rejects invalid since windows and preserves a valid window's hits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-since-"))
    const dbPath = join(dir, "index.db")
    try {
      seedMessage("sincewindowneedle")
      setIndexMeta(getDb(), "last_rebuild", new Date().toISOString())
      getDb().prepare("VACUUM INTO ?").run(dbPath)
      const run = (since: string, flags: string[]) =>
        runRecallCli(["sincewindowneedle", "--since", since, "--json", ...flags], {
          ...process.env,
          RECALL_DB_PATH: dbPath,
          RECALL_AGENT: "0",
        })
      for (const since of ["2026-10-17T00:00:00", "2days", ""]) {
        for (const flags of [[], ["--raw"], ["--agent"]]) {
          const result = await run(since, flags)
          expect(result.code, JSON.stringify({ since, flags, ...result })).not.toBe(0)
          expect(result.stdout).toBe("")
          expect(result.stderr).toContain(JSON.stringify(since))
          expect(result.stderr).toMatch(/Nh.*Nd.*Nw.*today.*yesterday/)
        }
      }
      const valid = await run("1d", ["--raw"])
      expect(valid.code, valid.stderr).toBe(0)
      expect(JSON.parse(valid.stdout)).toMatchObject({ total: 1, results: [{ sourceId: "sess-a" }] })
    } finally {
      safeRemoveSync(dir, { within: tmpdir() })
    }
  }, 15_000)

  // 27899: real argument parsing must preserve precise bounds and name unsupported sources.
  test("until CLI applies an inclusive indexed window and names invalid or unsupported bounds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-until-"))
    const dbPath = join(dir, "fixture.db")
    const until = Date.parse("2026-10-07T04:42:57.113Z")
    try {
      seedMessage("untilneedle eligible")
      seedRankedMessage("post-bound", "untilneedle excluded", null)
      getDb()
        .prepare("UPDATE messages SET timestamp = CASE WHEN session_id = 'sess-a' THEN ? ELSE ? END")
        .run(until, until + 1)
      setIndexMeta(getDb(), "last_rebuild", new Date().toISOString())
      getDb().prepare("VACUUM INTO ?").run(dbPath)
      const run = (args: string[]) => runRecallCli(args, { ...process.env, RECALL_DB_PATH: dbPath, RECALL_AGENT: "0" })
      const flags = [
        "--raw",
        "--json",
        "-i",
        "m",
        "--since",
        "2026-10-07T04:42:57.112Z",
        "--until",
        "2026-10-07T04:42:57.113Z",
      ]
      const valid = await run(["untilneedle", ...flags])
      expect(valid.code, valid.stderr).toBe(0)
      expect(JSON.parse(valid.stdout)).toMatchObject({ total: 1, results: [{ sourceId: "sess-a", timestamp: until }] })
      for (const instant of [
        "2026-10-07T04:42:57.113",
        "2026-10-07T04:42:57.113395Z",
        "all",
        "-1",
        "2026-02-30T04:42:57Z",
      ]) {
        const rejected = await run(["untilneedle", "--raw", "--until", instant])
        expect(rejected.code).not.toBe(0)
        expect(rejected.stderr).toContain("--until")
        expect(rejected.stderr).toContain(instant)
      }
      const reversed = await run([
        "untilneedle",
        "--raw",
        "--since",
        "2026-10-07T04:42:57.114Z",
        "--until",
        "2026-10-07T04:42:57.113Z",
      ])
      expect(reversed.code).not.toBe(0)
      expect(reversed.stderr).toMatch(/--since.*(after|later).*--until/)
      for (const mode of [[], ["--raw"], ["--grep"], ["--agent"], ["--debug-plan"]]) {
        const rejected = await run(["untilneedle", ...mode, "--since", "all", "--until", "2026-10-07T04:42:57.113Z"])
        expect(rejected.code).not.toBe(0)
        expect(rejected.stderr).toMatch(/--until.*(raw|indexed|grep|agent|synth)/i)
      }
    } finally {
      safeRemoveSync(dir, { within: tmpdir() })
    }
  }, 30_000)

  // Accepted absolute bounds include epoch zero. FTS/parser coverage cannot catch the separate no-query SQL path.
  test("raw recent search applies an epoch-zero lower bound and its upper bound", async () => {
    seedMessage("epoch eligible")
    seedRankedMessage("before-epoch", "before excluded", null)
    seedRankedMessage("after-bound", "after excluded", null)
    getDb()
      .prepare(
        "UPDATE messages SET timestamp = CASE session_id WHEN 'sess-a' THEN 0 WHEN 'sess-before-epoch' THEN -1 ELSE 1001 END",
      )
      .run()
    setIndexMeta(getDb(), "last_rebuild", new Date().toISOString())
    await cmdSearch(undefined, {
      raw: true,
      json: true,
      include: "m",
      since: "1970-01-01T00:00:00Z",
      until: "1970-01-01T00:00:01Z",
    })
    expect(jsonStdout(logSpy)).toMatchObject({ total: 1, results: [{ sourceId: "sess-a", timestamp: 0 }] })
  })

  // Snapshot custody is a real CLI/file contract. Existing live-memory and freshness
  // cases cannot detect WAL sidecars, migrations, live enrichment, or an ignored selector.
  test("snapshot CLI searches only the immutable file, with explicit all window and provenance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-snapshot-"))
    const indexDir = join(dir, "snapshot")
    mkdirSync(indexDir)
    const snapshot = join(indexDir, "index # one.db")
    try {
      seedMessage("snapshotneedle recent -literalneedle --snapshot", "recent")
      seedMessage("snapshotneedle old", "old")
      getDb()
        .prepare("UPDATE messages SET timestamp = ? WHERE uuid = ?")
        .run(Date.now() - 90 * 86400_000, "msg-old")
      setIndexMeta(getDb(), "last_rebuild", "2020-01-01T00:00:00.000Z")
      getDb().prepare("VACUUM INTO ?").run(snapshot)
      const writer = new Database(snapshot)
      writer.run("PRAGMA journal_mode = WAL")
      writer.close()
      const before = readFileSync(snapshot)
      const entries = readdirSync(indexDir)
      expect(entries).toEqual(["index # one.db"])
      const env = { ...process.env, RECALL_DB_PATH: join(dir, "unused", "live.db"), RECALL_AGENT: "1" }
      const run = (args: string[], file = snapshot) => runRecallCli(["--snapshot", file, ...args], env)
      const args = ["search", "snapshotneedle", "--raw", "--json", "-i", "m", "--since", "all"]
      const first = await run(args)
      const second = await run(args)
      expect(first.code, first.stderr).toBe(0)
      expect(second.code, second.stderr).toBe(0)
      const result = JSON.parse(first.stdout) as {
        provenanceDetail: Record<string, unknown>
        results: Array<{ sourceId: string }>
      }
      expect(result).toMatchObject({
        provenance: "snapshot",
        total: 2,
        provenanceDetail: {
          provenance: "snapshot",
          path: snapshot,
          root: "index_meta.last_rebuild",
          lastRebuild: "2020-01-01T00:00:00.000Z",
        },
      })
      expect(result.provenanceDetail).not.toHaveProperty("windowMs")
      expect(result.results.map((hit: { sourceId: string }) => hit.sourceId).sort()).toEqual([
        "sess-old",
        "sess-recent",
      ])
      expect(JSON.parse(second.stdout)).toMatchObject({ results: result.results })
      const defaultWindow = await run(["snapshotneedle", "--raw", "--json", "-i", "m"])
      expect(defaultWindow.code, defaultWindow.stderr).toBe(0)
      expect(JSON.parse(defaultWindow.stdout)).toMatchObject({ total: 1, results: [{ sourceId: "sess-recent" }] })
      const empty = await run(["absentneedle", "--json", "-i", "m", "--since", "all", "--no-refresh"])
      expect(empty.code, empty.stderr).toBe(0)
      expect(JSON.parse(empty.stdout)).toMatchObject({ provenance: "snapshot", total: 0, results: [] })

      // Prove the live source exists and would contribute to ordinary human raw output.
      const liveHome = join(dir, "live-home")
      const liveDir = join(liveHome, ".claude", "projects", process.cwd().replaceAll("/", "-"))
      mkdirSync(liveDir, { recursive: true })
      writeFileSync(
        join(liveDir, "live-fixture.jsonl"),
        JSON.stringify({
          type: "human",
          timestamp: new Date().toISOString(),
          message: { content: "liveonlyneedle should stay outside snapshot" },
        }) + "\n",
      )
      const liveControl = join(dir, "live-control.db")
      writeFileSync(liveControl, before)
      const liveEnv = { ...env, HOME: liveHome, CLAUDE_SESSION_ID: "live-fixture", RECALL_DB_PATH: liveControl }
      const control = await runRecallCli(["liveonlyneedle", "--raw", "-i", "m"], liveEnv)
      expect(control.stdout).toContain("should stay outside snapshot")
      const human = await runRecallCli(["--snapshot", snapshot, "liveonlyneedle", "--raw", "-i", "m"], liveEnv)
      expect(human.code, human.stderr).toBe(0)
      expect(human.stdout).toContain(`snapshot ${snapshot}`)
      expect(human.stdout).not.toContain("should stay outside snapshot")
      expect(human.stdout).not.toContain("UNPROVEN")

      for (const command of [
        "index",
        "migrate",
        "remember",
        "summarize",
        "weekly",
        "export",
        "sessions",
        "files",
        "status",
        "show",
        "current-brief",
      ]) {
        const refused = await run([command])
        expect(refused.code, command).toBe(2)
        expect(refused.stderr).toContain("raw indexed search only")
        expect(refused.stdout).toBe("")
      }
      for (const mode of [[], ["--grep"], ["--agent"], ["--raw", "--debug-plan"]]) {
        const refused = await run(["snapshotneedle", ...mode])
        expect(refused.code, JSON.stringify(mode)).not.toBe(0)
        expect(refused.stderr).toContain("raw indexed search only")
      }
      const mixed = await runRecallCli(["--snapshot", snapshot, "--vault-db", snapshot, ...args], env)
      expect(mixed.code).toBe(2)
      expect(mixed.stderr).toContain("cannot combine")
      const absent = await run(args, join(dir, "absent", "index.db"))
      expect(absent.code).not.toBe(0)
      expect(absent.stderr).toContain("index.db")
      expect(readdirSync(dir)).not.toContain("absent")
      expect(readdirSync(dir)).not.toContain("unused")
      expect(readFileSync(snapshot)).toEqual(before)
      expect(readdirSync(indexDir)).toEqual(entries)

      // Inspect the actual selected connection while open, including SQLite's own readonly enforcement.
      closeDb()
      const { bindSnapshot } = await import("../../src/history/db.ts")
      bindSnapshot(snapshot)
      const reader = getDb()
      expect(() => reader.run("DELETE FROM messages")).toThrow(/readonly/i)
      expect(readFileSync(snapshot)).toEqual(before)
      expect(readdirSync(indexDir)).toEqual(entries)
      closeDb()

      // Immutable SQLite would ignore either unfinished transaction sidecar.
      for (const suffix of ["-wal", "-journal"]) {
        const unsafe = join(dir, `unsafe${suffix}.db`)
        writeFileSync(unsafe, before)
        const sidecar = `${unsafe}${suffix}`
        writeFileSync(sidecar, "unfinished transaction sentinel")
        const refused = await run(args, unsafe)
        expect(refused.code).not.toBe(0)
        expect(refused.stderr).toContain(sidecar)
        expect(readFileSync(sidecar, "utf8")).toBe("unfinished transaction sentinel")
        expect(readFileSync(unsafe)).toEqual(before)
      }
      const { CURRENT_SCHEMA_VERSION } = await import("../../src/history/db-schema.ts")
      for (const version of [CURRENT_SCHEMA_VERSION - 1, CURRENT_SCHEMA_VERSION + 1]) {
        const wrong = join(dir, `schema-${version}.db`)
        writeFileSync(wrong, before)
        const edit = new Database(wrong)
        edit.run(assertSingleStatement(`PRAGMA user_version = ${version}`))
        edit.close()
        const wrongBefore = readFileSync(wrong)
        const refused = await run(args, wrong)
        expect(refused.code).not.toBe(0)
        expect(refused.stderr).toContain(`schema version ${version}`)
        expect(refused.stderr).toContain(`expected ${CURRENT_SCHEMA_VERSION}`)
        expect(readFileSync(wrong)).toEqual(wrongBefore)
      }
      // Existing FTS grammar quotes a literal leading-dash term; -- ends CLI options only.
      const literal = await run(["search", "--raw", "--json", "-i", "m", "--since", "all", "--", '"-literalneedle"'])
      expect(literal.code, literal.stderr).toBe(0)
      expect(JSON.parse(literal.stdout)).toMatchObject({ total: 1, results: [{ sourceId: "sess-recent" }] })
    } finally {
      closeDb()
      safeRemoveSync(dir, { within: tmpdir() })
    }
  }, 30_000)

  // Receipt creation is covered by real SQLite fanout/agent tests. This is the
  // distinct CLI transport boundary, including its early synthesis-failure path.
  // A cap is a useful approximation; only query rejection degrades the search.
  // Existing receipt-only assertions incorrectly required exit 3 for both.
  test.each([
    { json: false, failedSynthesis: false, rejected: false },
    { json: true, failedSynthesis: false, rejected: false },
    { json: false, failedSynthesis: false, rejected: true },
    { json: true, failedSynthesis: false, rejected: true },
    { json: false, failedSynthesis: true, rejected: false },
  ])(
    "agent output keeps cap/rejection receipts with their exit status ($json JSON, rejected $rejected, synthesis failed $failedSynthesis)",
    async ({ json, failedSynthesis, rejected }) => {
      setIndexMeta(getDb(), "last_rebuild", new Date().toISOString())
      const previousExitCode = process.exitCode
      const skipped = [
        {
          phase: "messages",
          anchor: "receiptneedle",
          kind: rejected ? "query-rejected" : "candidate-cap",
          message: rejected
            ? 'recall messages query "receiptneedle" skipped: fts5: syntax error near "-"'
            : "recall messages capped for receiptneedle: prose held 1000, tools held 0; overflow",
        },
      ]
      mockAgent.result = async (query) =>
        ({
          ...(failedSynthesis
            ? synthesisFailureAgentResult(query)
            : zeroAgentResult(query, { provenance: "complete" })),
          skipped,
        }) as never
      try {
        process.exitCode = 0
        await cmdSearch("receiptneedle", { agent: true, json, project: "*", round2: "off" })
        if (json) {
          expect(jsonStdout<{ skipped: unknown }>(logSpy).skipped).toEqual(skipped)
        } else {
          expect(callsText(logSpy)).toContain(skipped[0]!.message)
          expect(callsText(logSpy)).not.toContain("No results found")
        }
        expect(process.exitCode).toBe(failedSynthesis || rejected ? 3 : 0)
      } finally {
        process.exitCode = previousExitCode
      }
    },
  )

  test("reports a loud tool-broken failure — with the lexical hits, clearly labeled, never silently dropped — when default synthesis is unavailable", async () => {
    const previousLlmDir = process.env.TRIBE_LLM_DIR
    const previousExitCode = process.exitCode
    delete process.env.TRIBE_LLM_DIR
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
    expect(output).toContain("TRIBE_LLM_DIR is unset")
    expect(output).toContain("TRIBE_LLM_DIR")
    expect(output).toContain("--raw")
    expect(output).toContain("RECALL_LLM_DENY_PROVIDERS in the current environment")
    expect(output).not.toContain(".envrc.local")
    // Distinct exit code — degraded-but-has-results is neither a clean 0
    // nor the generic 1 a hard crash would use.
    expect(process.exitCode).toBe(3)

    process.exitCode = previousExitCode
  })

  test("preserves global default scope when no project filter is supplied and supports explicit narrowing", () => {
    expect(resolveProjectScope(undefined, "/repos/km")).toBeUndefined()
    expect(resolveProjectScope(undefined, "/repos/km-wt7")).toBeUndefined()
    expect(resolveProjectScope(undefined, "/hh")).toBeUndefined()
    expect(resolveProjectScope(undefined, "/hh/dev")).toBeUndefined()
    expect(resolveProjectScope("*km-wt7*", "/repos/km-wt1")).toBe("km-wt7")
    expect(resolveProjectScope("km", "/hh")).toBe("km")
    expect(resolveProjectScope("dev", "/hh")).toBe("dev")
    expect(resolveProjectScope("*", "/hh/dev")).toBeUndefined()
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
    try {
      seedVaultDb(dbPath, "vaultrawneedle only lives in the km vault, never in a session transcript")
      bindVaultDb(dbPath)

      await cmdSearch("vaultrawneedle", { raw: true, project: "*" })

      const output = callsText(logSpy)
      expect(output).toContain("Searching:")
      expect(output).toContain("Vault")
      expect(output).toContain("Vault raw-mode fixture")
      expect(output).toContain("vaultrawneedle")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // 25149: recall binds a vault only explicitly, so an unbound search says so
  // instead of reading as "no vault hits"; the CLI's leading --vault-db binds it
  // through bindVaultDb (the CLI half is witnessed in cli-vault-db.test.ts).
  test("an unbound search says the vault is not bound; a bound vault is searched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-vault-bound-"))
    const dbPath = join(dir, "state.db")
    try {
      seedVaultDb(dbPath, "vaultboundneedle only lives in the km vault")

      await cmdSearch("vaultboundneedle", { raw: true, project: "*" })
      expect(callsText(errSpy)).toContain("vault: not bound (pass --vault-db)")
      expect(callsText(logSpy)).not.toContain("vaultboundneedle only lives")

      errSpy.mockClear()
      logSpy.mockClear()
      bindVaultDb(dbPath)
      await cmdSearch("vaultboundneedle", { raw: true, project: "*" })
      expect(callsText(errSpy)).not.toContain("vault: not bound")
      expect(callsText(logSpy)).toContain("vaultboundneedle")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // CTO 0edff0e3 fixes 2 and 9: a bound normal search with no query model keeps its lexical vault hits, names the
  // degradation, exits 3, and ends the process after printing; raw search makes no receipt and loads no model.
  test("a bound normal search without RECALL_EMBED_MODEL keeps the vault hits, exits 3 and ends the process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-vault-semantic-unset-"))
    const dbPath = join(dir, "state.db")
    const savedModel = process.env.RECALL_EMBED_MODEL
    const previousExitCode = process.exitCode
    const previousLlmDir = process.env.TRIBE_LLM_DIR
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    // The process ends only after both streams flush, so the stubbed stderr acknowledges its writes.
    stderrWriteSpy.mockImplementation(((_chunk: unknown, done?: unknown) => {
      if (typeof done === "function") done()
      return true
    }) as never)
    delete process.env.RECALL_EMBED_MODEL
    delete process.env.TRIBE_LLM_DIR
    try {
      seedVaultDb(dbPath, "vaultsemanticneedle only lives in the km vault")
      bindVaultDb(dbPath)
      setIndexMeta(getDb(), "last_rebuild", new Date().toISOString())

      await cmdSearch("vaultsemanticneedle", { refresh: false, project: "*" })

      const output = callsText(logSpy)
      expect(output).toContain("vault semantic leg degraded, lexical vault hits kept")
      expect(output).toContain("RECALL_EMBED_MODEL is not set")
      expect(output).toContain("vaultsemanticneedle")
      expect(process.exitCode).toBe(3)
      expect(exitSpy).toHaveBeenCalledTimes(1)
      expect(llamaLoads.count).toBe(0)
    } finally {
      exitSpy.mockRestore()
      process.exitCode = previousExitCode
      if (savedModel === undefined) delete process.env.RECALL_EMBED_MODEL
      else process.env.RECALL_EMBED_MODEL = savedModel
      if (previousLlmDir === undefined) delete process.env.TRIBE_LLM_DIR
      else process.env.TRIBE_LLM_DIR = previousLlmDir
      safeRemoveSync(dir, { within: tmpdir() })
    }
  })

  test("a bound raw search makes no vault semantic receipt and loads no model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-vault-semantic-raw-"))
    const dbPath = join(dir, "state.db")
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    try {
      seedVaultDb(dbPath, "vaultsemanticrawneedle only lives in the km vault")
      bindVaultDb(dbPath)

      await cmdSearch("vaultsemanticrawneedle", { raw: true, json: true, project: "*" })

      const payload = jsonStdout<{ vaultSemantic?: unknown; results: unknown[] | null }>(logSpy)
      expect(payload.vaultSemantic).toBeUndefined()
      expect(payload.results).not.toBeNull()
      expect(callsText(errSpy)).not.toContain("vault semantic")
      expect(exitSpy).not.toHaveBeenCalled()
      expect(llamaLoads.count).toBe(0)
    } finally {
      exitSpy.mockRestore()
      safeRemoveSync(dir, { within: tmpdir() })
    }
  })

  test('raw mode JSON includes vault matches with contentType "vault"', async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-raw-vault-json-"))
    const dbPath = join(dir, "state.db")
    try {
      seedVaultDb(dbPath, "vaultrawjsonneedle only lives in the km vault")
      bindVaultDb(dbPath)

      await cmdSearch("vaultrawjsonneedle", { raw: true, json: true, project: "*" })

      const payload = jsonStdout<{ results: Array<{ contentType: string; snippet: string }> | null }>(logSpy)
      expect(callsText(errSpy)).toContain('Searching: "vaultrawjsonneedle"')
      expect(payload.results).not.toBeNull()
      const vaultRow = payload.results!.find((r) => r.contentType === "vault")
      expect(vaultRow).toBeDefined()
      expect(vaultRow!.snippet).toContain("vaultrawjsonneedle")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("raw mode applies limit to vault results", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-raw-vault-limit-"))
    const dbPath = join(dir, "state.db")
    try {
      seedVaultDb(dbPath, "vaultlimitneedle first", "vaultlimitneedle second")
      bindVaultDb(dbPath)

      await cmdSearch("vaultlimitneedle", { raw: true, json: true, limit: "1", project: "*" })

      const payload = jsonStdout<{ results: Array<{ contentType: string }> | null }>(logSpy)
      expect(payload.results?.filter((result) => result.contentType === "vault")).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test.each([
    ["--question", { question: true }],
    ["--response", { response: true }],
    ["--tool", { tool: "Read" }],
    ["--session", { session: "sess-a" }],
    ["--include messages", { include: "messages" }],
  ])("raw mode excludes unfilterable vault rows with %s", async (_label, filter) => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-raw-vault-filter-"))
    const dbPath = join(dir, "state.db")
    try {
      seedVaultDb(dbPath, "vaultfilterneedle only lives in the km vault")
      bindVaultDb(dbPath)
      if ("session" in filter) seedMessage("vaultfilterneedle selected session")

      await cmdSearch("vaultfilterneedle", { raw: true, json: true, project: "*", ...filter })

      const payload = jsonStdout<{ results: Array<{ contentType: string }> | null }>(logSpy)
      expect(payload.results?.some((result) => result.contentType === "vault") ?? false).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // A session filter must constrain every source, including plain output's live supplement.
  // The vault-only filter case cannot catch unrelated indexed research or a live-session hit.
  test("keeps a raw session query inside the requested session and reports misses loudly", async () => {
    const previousExitCode = process.exitCode
    const previousDbPath = process.env.RECALL_DB_PATH
    const dir = mkdtempSync(join(tmpdir(), "recall-session-scope-"))
    process.env.RECALL_DB_PATH = join(dir, "index.db")
    const history = await import("../../src/history/search")
    const live = vi.spyOn(history, "searchLiveSession").mockReturnValue([
      {
        type: "message",
        sessionId: "foreign-live-session",
        sessionTitle: "foreign live session",
        timestamp: Date.now(),
        snippet: "foreign live session scopefilterneedle",
        rank: -100,
      },
    ])
    try {
      seedMessage("scopefilterneedle selected session")
      seedMessage("scopefilterneedle unrelated session", "other")
      seedMessage("scopefilterneedle ".repeat(20) + "childonlyscope", "child")
      const db = getDb()
      db.prepare("UPDATE sessions SET parent_session_id = ? WHERE id = ?").run("sess-a", "sess-child")
      setIndexMeta(db, "last_rebuild", new Date().toISOString())
      db.prepare(
        `INSERT INTO content (content_type, source_id, project_path, title, content, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("llm_research", "unrelated-research", "/test/km", "unrelated research", "scopefilterneedle", Date.now())

      process.exitCode = 0
      await cmdSearch("scopefilterneedle", { session: "sess-a", json: true, limit: "1" })
      const payload = jsonStdout<{ total: number; results: Array<{ contentType: string; sourceId: string }> }>(logSpy)
      expect(payload.results.map(({ contentType, sourceId }) => ({ contentType, sourceId }))).toEqual([
        { contentType: "message", sourceId: "sess-a" },
      ])
      expect(payload.total).toBe(1)
      expect(process.exitCode ?? 0).toBe(0)

      logSpy.mockClear()
      await cmdSearch("scopefilterneedle", { session: "sess-a" })
      expect(callsText(logSpy)).toContain("selected session")
      expect(callsText(logSpy)).not.toContain("unrelated")
      expect(callsText(logSpy)).not.toContain("foreign live session")

      for (const [session, query] of [
        ["absent-session", "scopefilterneedle"],
        ["sess-a", "missing-session-token"],
        ["sess-a", "childonlyscope"],
      ]) {
        logSpy.mockClear()
        errSpy.mockClear()
        process.exitCode = 0
        await cmdSearch(query, { session, json: true })
        expect(process.exitCode).toBe(1)
        expect(callsText(errSpy)).toContain(session)
        expect(callsText(errSpy)).toContain(join(dir, "index.db"))
        expect(callsText(errSpy)).toContain(query)
        expect(callsText(logSpy)).toBe("")
      }
    } finally {
      live.mockRestore()
      closeDb()
      process.env.RECALL_DB_PATH = previousDbPath
      safeRemoveSync(dir, { within: tmpdir(), allowMissing: true })
      process.exitCode = previousExitCode
    }
  })

  test.each([
    ["--question", { question: true }, ["message:user"]],
    ["--response", { response: true }, ["message:assistant"]],
    ["both roles", { question: true, response: true }, ["message:assistant", "message:user"]],
    ["no role filter", {}, ["llm_research", "message:assistant", "message:user", "project_memory", "vault"]],
  ])("raw role filters select messages across source types: %s", async (_label, filter, expected) => {
    // The existing vault-only cases cannot catch research or memory rows
    // leaking into a query labeled "questions only" (23189).
    const dir = mkdtempSync(join(tmpdir(), "tribe-raw-role-filter-"))
    const dbPath = join(dir, "state.db")
    try {
      seedMessage("rolefilterneedle user question")
      seedRankedMessage("reply", "rolefilterneedle assistant response", null)
      const db = getDb()
      setIndexMeta(db, "last_rebuild", new Date().toISOString())
      for (const type of ["project_memory", "llm_research"]) {
        db.prepare(
          `INSERT INTO content (content_type, source_id, project_path, title, content, timestamp)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(type, type, "/test/km", type, "rolefilterneedle project knowledge", Date.now())
      }
      seedVaultDb(dbPath, "rolefilterneedle vault knowledge")
      bindVaultDb(dbPath)

      await cmdSearch("rolefilterneedle", { raw: true, json: true, project: "*", ...filter })

      const payload = jsonStdout<{ results: Array<{ contentType: string; type?: string }> | null }>(logSpy)
      expect(
        payload.results?.map((row) => (row.type ? `${row.contentType}:${row.type}` : row.contentType)).sort(),
      ).toEqual(expected)
    } finally {
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

      expect(callsText(errSpy)).not.toContain("auto-refresh")
      // The stale answer names the root and window it judged (@ag/recall/27930);
      // this row failed while status carried its own 1h window on the same stamp.
      expect(callsText(logSpy)).toMatch(
        /0 results — UNPROVEN \(stale index: 2\.0h old vs \d+m window \(\w+\) on index_meta\.last_rebuild\) for "nohits-a"/,
      )
      expect(callsText(logSpy)).toMatch(
        /0 results — UNPROVEN \(stale index: 2\.0h old vs \d+m window \(\w+\) on index_meta\.last_rebuild\) for "nohits-b"/,
      )
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

      const payload = jsonStdout<{
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

  // @failure Raw JSON omits message UUIDs, making message-level matches unidentifiable.
  // @level l1
  // @consumer cmdSearch raw JSON for Claude and Codex message hits
  test("raw JSON preserves Claude UUID and Codex line identity", async () => {
    const db = getDb()
    const now = Date.now()
    const identities = [
      { sourceId: "claude-session", uuid: "claude-message-uuid", line: 17 },
      { sourceId: "codex:session", uuid: null, line: 29 },
    ]
    for (const row of identities) {
      db.prepare(
        "INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(row.sourceId, "/test/km", `/fixture/${row.sourceId}.jsonl`, now, now, 1, row.sourceId)
      db.prepare(
        "INSERT INTO messages (uuid, session_id, type, content, timestamp, line) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(row.uuid, row.sourceId, "user", "messageidentityneedle", now, row.line)
    }
    setIndexMeta(db, "last_rebuild", new Date().toISOString())
    const previousExitCode = process.exitCode
    try {
      process.exitCode = 0
      await cmdSearch("messageidentityneedle", { raw: true, json: true, project: "*", since: "1d" })
      const payload = jsonStdout<{ total: number; results: { sourceId: string; uuid: string | null; line: number }[] }>(
        logSpy,
      )
      expect(process.exitCode).toBe(0)
      expect(payload.total).toBe(2)
      expect(
        payload.results
          .map(({ sourceId, uuid, line }) => ({ sourceId, uuid, line }))
          .sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
      ).toEqual(identities)
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

      const payload = jsonStdout<{ provenance?: string; total: number | null; results: unknown[] | null }>(logSpy)
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

      const payload = jsonStdout<{ provenance?: string; results: unknown[] | null }>(logSpy)
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

      const payload = jsonStdout<{ provenance?: string; results: unknown[] | null }>(logSpy)
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
  // Existing cases pin hits/exits but never supply a financial receipt. The
  // shared formatter's arithmetic is covered by the root real-export journey;
  // this seam pins delegation of the ORIGINAL result on these early returns.
  test.each([
    { path: "failure", json: false },
    { path: "raw", json: false },
    { path: "failure", json: true },
  ])("agent terminal paths retain the original financial projection ($path, JSON $json)", async ({ path, json }) => {
    seedMessage("receiptneedle preserves the literal match")
    setIndexMeta(getDb(), "last_rebuild", new Date().toISOString())
    const financial = {
      cost_usd: 0.125,
      list_equivalent_usd: 0.002,
      list_equivalent_basis: [
        { rateSource: "litellm" as const, rateDate: "2026-10-20", matchedModelId: "actual-priced-model" },
      ],
    }
    const result = {
      ...(path === "failure"
        ? synthesisFailureAgentResult("receiptneedle")
        : zeroAgentResult("receiptneedle", { provenance: "complete" })),
      ...financial,
    }
    mockAgent.result = async () => result as never
    const decoded = {
      charged: { usd: 0.125 },
      listEquivalent: { usd: 0.002 },
      listEquivalentBasis: financial.list_equivalent_basis,
    }
    const deserialize = vi.fn(() => decoded)
    // Opaque projection: the mock does not implement the monetary behavior.
    const format = vi.fn(() => "original-financial-projection")
    const query = vi.fn(async () => {
      throw new Error("display must not dispatch a provider")
    })
    const backend = await import("../../src/lib/llm-backend.ts")
    const requireBackend = vi.spyOn(backend, "requireLlm").mockResolvedValue({
      ...unavailableCostMethods,
      deserializeCost: deserialize,
      formatCostColumns: format,
      queryModel: query,
      getModel: () => undefined,
      getCheapModel: () => undefined,
      getCheapModels: () => [],
      isProviderAvailable: () => false,
    })
    const previousExitCode = process.exitCode
    process.exitCode = 0
    try {
      await cmdSearch("receiptneedle", { agent: true, json, project: "*", round2: "off" })
      expect(process.exitCode).toBe(path === "failure" ? 3 : 0)
      if (json) {
        expect(jsonStdout(logSpy)).toMatchObject(financial)
        expect(requireBackend).not.toHaveBeenCalled()
      } else {
        const output = callsText(logSpy)
        expect(output).toContain(
          path === "failure" ? "RECALL SYNTHESIS FAILED" : "agent variants missed literal raw matches",
        )
        expect(deserialize).toHaveBeenCalledExactlyOnceWith(result)
        expect(format).toHaveBeenCalledExactlyOnceWith(decoded)
        expect(output.match(/original-financial-projection/g)).toHaveLength(1)
      }
      expect(query).not.toHaveBeenCalled()
    } finally {
      process.exitCode = previousExitCode
      requireBackend.mockRestore()
    }
  })

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

      const payload = jsonStdout<{ results: unknown[] | null }>(logSpy)
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

      const payload = jsonStdout<{ provenance?: string; total: number | null; results: unknown[] | null }>(logSpy)
      expect(process.exitCode).toBe(0)
      expect(payload.provenance).toBe("complete")
      expect(payload.total).toBe(0)
      expect(payload.results).toEqual([])
    } finally {
      process.exitCode = previousExitCode
    }
  })

  // @ag/recall/three-dark-search-paths (pair-042): a planner that fails falls through to the default recall. With no
  // fall-through hits there is no synthesis to fail, so agent mode exited 0 with provenance complete — read by every
  // caller as "searched, found nothing" (live: plannerError no-planner-model-available, 2026-10-14).
  test("agent mode exits 3 when its planner failed, even when the fall-through search found nothing", async () => {
    setIndexMeta(getDb(), "last_rebuild", new Date().toISOString())
    const previousExitCode = process.exitCode
    const fellThrough = (query: string, fell: boolean) => ({
      ...zeroAgentResult(query, { provenance: "complete" }),
      trace: {
        rounds: [
          {
            round: 1,
            mode: "off",
            planner: { model: "mock", elapsedMs: 1, error: "no-planner-model-available" },
            plan: null,
            variants: [],
            stats: { totalQueries: 0, rawHits: 0, uniqueDocs: 0, topCoverage: 0, medianCoverage: 0, msTotal: 0 },
          },
        ],
        decision: { round2Mode: "off", reason: "test" },
        contextChars: 0,
      },
      fellThrough: fell,
    })

    try {
      // Control: the same empty result from a planned search is a clean, authoritative empty answer.
      process.exitCode = 0
      mockAgent.result = async (query) => fellThrough(query, false) as never
      await cmdSearch("calleelocals frame", { agent: true, json: true, project: "*", round2: "off" })
      expect(process.exitCode).toBe(0)

      process.exitCode = 0
      logSpy.mockClear()
      mockAgent.result = async (query) => fellThrough(query, true) as never
      await cmdSearch("calleelocals frame", { agent: true, json: true, project: "*", round2: "off" })
      expect(jsonStdout<{ fellThrough?: boolean; results: unknown[] }>(logSpy)).toMatchObject({
        fellThrough: true,
        results: [],
      })
      expect(process.exitCode).toBe(3)
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
      // Unbound on purpose, so stderr is exactly the one line an unbound search owes (25149).
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
    expect(errors).toBe("vault: not bound (pass --vault-db)")
    expect(output).toContain('0 results — UNPROVEN (unknown index) for "nohits"')
  })

  test("defaults search to global project scope when no explicit -p is supplied", async () => {
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
    expect((mockAgent.options as { projectFilter?: string } | null)?.projectFilter).toBeUndefined()
    expect(errors).not.toContain("sibling worktree project dir(s) detected")
    expect(output).toContain('0 results — UNPROVEN (unknown index) for "nohits"')
  })

  test("gives synthesis a 20 second default budget while preserving an explicit timeout", async () => {
    // Accepted requirement: the default covers the measured live-provider
    // latency. Existing synthesis tests pass explicit budgets, so they cannot
    // detect the CLI continuing to inject its old 10 second value.
    mockAgent.result = async (query, options) => zeroAgentResult(query, options) as never

    await cmdSearch("defaultbudget", { agent: true, project: "*", refresh: false })
    expect(mockAgent.options).toMatchObject({ timeout: 20_000 })

    await cmdSearch("explicitbudget", { agent: true, project: "*", refresh: false, timeout: "45000" })
    expect(mockAgent.options).toMatchObject({ timeout: 45_000 })
  })

  test("default raw search uses global project scope finding transcripts across project origins", async () => {
    const prevCwd = process.cwd()
    const parent = mkdtempSync(join(tmpdir(), "recall-projects-"))
    const project = join(parent, "km-wt1")
    mkdirSync(project)
    process.chdir(project)
    seedMessage("familyscope marker", "sibling", "/hh/dev-wt7")
    seedMessage("familyscope marker", "origin", "/hh")

    try {
      // Default query without -p finds transcripts from both /hh and /hh/dev origins
      await cmdSearch("familyscope", { raw: true, refresh: false })
      const output = callsText(logSpy)
      expect(output).toContain("Found 2 matches")
      expect(output).toContain("/hh/dev-wt7")
      expect(output).toContain("/hh")
    } finally {
      process.chdir(prevCwd)
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test("explicit -p narrows raw search to matching session project path", async () => {
    const prevCwd = process.cwd()
    const parent = mkdtempSync(join(tmpdir(), "recall-projects-"))
    const project = join(parent, "km-wt1")
    mkdirSync(project)
    process.chdir(project)
    seedMessage("familyscope marker", "sibling", "/hh/dev-wt7")
    seedMessage("familyscope marker", "origin", "/hh")

    try {
      await cmdSearch("familyscope", { raw: true, refresh: false, project: "dev" })
      const narrowedOutput = callsText(logSpy)
      expect(narrowedOutput).toContain("Found 1 matches")
      expect(narrowedOutput).toContain("/hh/dev-wt7")
      expect(narrowedOutput).not.toContain("/hh (")
    } finally {
      process.chdir(prevCwd)
      rmSync(parent, { recursive: true, force: true })
    }
  })

  // ==========================================================================
  // S1 refactor guards (/hh/var/@adhoc4/ac8-s1s2-design.md § S1 "Behaviour to preserve"): pins that must be green
  // at HEAD before rawSearch/cmdGrep share a renderer or rawSearch loses its own recent-rows SQL.
  // ==========================================================================
  describe("S1 golden pins", () => {
    const NOW = Date.parse("2026-10-20T12:00:00.000Z")
    const HOUR = 60 * 60 * 1000
    const HEAVY = "━".repeat(60)
    const LIGHT = "─".repeat(60)
    const hl = (text: string) => `\x1b[1m\x1b[33m${text}\x1b[0m`
    let savedSessionId: string | undefined
    let savedHome: string | undefined
    let savedExitCode: typeof process.exitCode
    let nowSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      savedSessionId = process.env.CLAUDE_SESSION_ID
      savedHome = process.env.HOME
      savedExitCode = process.exitCode
      process.exitCode = 0
      // No ambient live-session supplement: golden output must not depend on the runner's own transcript.
      delete process.env.CLAUDE_SESSION_ID
      // A fixed clock makes "Nh ago", "(3d ago)" and "in 0ms" exact.
      nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW)
    })

    afterEach(() => {
      nowSpy.mockRestore()
      if (savedSessionId === undefined) delete process.env.CLAUDE_SESSION_ID
      else process.env.CLAUDE_SESSION_ID = savedSessionId
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
      process.exitCode = savedExitCode
    })

    const stdoutLines = () => logSpy.mock.calls.map((args: unknown[]) => args.join(" "))
    const stderrLines = () => errSpy.mock.calls.map((args: unknown[]) => args.join(" "))

    function seedGoldenSession(
      id: string,
      cwd: string | null,
      rows: Array<{ type: string; content: string; ageMs: number; line: number; tool?: string }>,
      updatedAt = NOW,
    ): void {
      const db = getDb()
      db.prepare(
        `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title, cwd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, "-test-golden-b", `/tmp/${id}.jsonl`, NOW - 10 * HOUR, updatedAt, rows.length, null, cwd)
      rows.forEach((row, i) => {
        db.prepare(
          `INSERT INTO messages (uuid, session_id, type, content, tool_name, timestamp, line)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(`${id}-m${i}`, id, row.type, row.content, row.tool ?? null, NOW - row.ageMs, row.line)
      })
    }

    function seedGoldenContent(content: string): void {
      getDb()
        .prepare(
          `INSERT INTO content (content_type, source_id, project_path, title, content, timestamp)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("doc", "golden-doc", "/test/golden", "Golden doc", content, NOW - 3 * 24 * HOUR)
    }

    function seedGoldenFixture(): void {
      seedGoldenSession("golden-a-1111", "/test/golden", [
        { type: "user", content: "goldenneedle first question", ageMs: 2 * HOUR, line: 11 },
        { type: "assistant", content: "goldenneedle second answer", ageMs: 2 * HOUR + 1000, line: 12 },
        { type: "user", content: "goldenneedle third question", ageMs: 2 * HOUR + 2000, line: 13 },
        { type: "assistant", content: "goldenneedle fourth answer", ageMs: 2 * HOUR + 3000, line: 14 },
      ])
      seedGoldenSession("golden-b-2222", null, [
        { type: "user", content: "goldenneedle from b one", ageMs: 5 * HOUR, line: 3 },
        { type: "user", content: "goldenneedle from b two", ageMs: 5 * HOUR + 1000, line: 4 },
      ])
      seedGoldenContent("goldenneedle lives in a doc")
      setIndexMeta(getDb(), "last_rebuild", new Date(NOW).toISOString())
    }

    // Pins: raw human layout — per-session header line, "... and N more matches in this session", the
    // "Other Content" and "Vault" sections, "(showing X of Y" and the >>>/<<< and «» highlight ANSI codes
    // (S1 refactor guard; search-output.test.ts otherwise asserts only "Searching:" / "Found N matches" / contains).
    test("raw human output renders the exact grouped layout for a small fixture", async () => {
      const dir = mkdtempSync(join(tmpdir(), "recall-s1-golden-"))
      try {
        seedGoldenFixture()
        const vaultPath = join(dir, "state.db")
        seedVaultDb(vaultPath, "goldenneedle vault body")
        bindVaultDb(vaultPath)

        await cmdSearch("goldenneedle", { raw: true, limit: "5", project: "*" })

        const { formatTime } = await import("../../src/lib/format")
        const at = (ageMs: number) => formatTime(NOW - ageMs)
        expect(stdoutLines()).toEqual([
          `\x1b[2mSearching: "goldenneedle" last 30d\x1b[0m\n`,
          `Found 8 matches for "goldenneedle" in 0ms:\n`,
          HEAVY,
          "\u{1F4C1} golden-a...  |  /test/golden  |  2h ago",
          HEAVY,
          `\n\u{1F464} User (${at(2 * HOUR)}, L11):`,
          LIGHT,
          `${hl("goldenneedle")} first question`,
          `\n\u{1F916} Assistant (${at(2 * HOUR + 1000)}, L12):`,
          LIGHT,
          `${hl("goldenneedle")} second answer`,
          `\n\u{1F464} User (${at(2 * HOUR + 2000)}, L13):`,
          LIGHT,
          `${hl("goldenneedle")} third question`,
          "\n  ... and 1 more matches in this session",
          "",
          HEAVY,
          "\u{1F4C1} golden-b...  |  /test/golden/b  |  5h ago",
          HEAVY,
          `\n\u{1F464} User (${at(5 * HOUR)}, L3):`,
          LIGHT,
          `${hl("goldenneedle")} from b one`,
          "",
          `\n${LIGHT}`,
          "\x1b[1mOther Content\x1b[0m\n",
          "\u{1F4D6} \x1b[36m[doc]\x1b[0m \x1b[1mGolden doc\x1b[0m \x1b[2m/test/golden\x1b[0m \x1b[2m(3d ago)\x1b[0m",
          `   ${hl("goldenneedle")} lives in a doc`,
          "",
          `\n${LIGHT}`,
          "\x1b[1mVault\x1b[0m\n",
          "\u{1F4D6} \x1b[1mVault raw-mode fixture\x1b[0m \x1b[2mhub/vault-raw-fixture.md\x1b[0m",
          `   ${hl("goldenneedle")} vault body`,
          "",
          "\x1b[2m(showing 7 of 8 matches, use -n/--limit <num> to see more)\x1b[0m",
        ])
      } finally {
        safeRemoveSync(dir, { within: tmpdir() })
      }
    })

    // Pins: the raw human CURRENT SESSION block (live, not-yet-indexed transcript) printed before the indexed
    // groups, its 3-entry cut and "... and N more matches in current session" (S1 refactor guard; the only other
    // live-session test mocks the supplement away and asserts its absence).
    test("raw human output renders the CURRENT SESSION block from the live transcript", async () => {
      const home = mkdtempSync(join(tmpdir(), "recall-s1-live-"))
      try {
        const liveId = "live-golden-session"
        const liveDir = join(home, ".claude", "projects", process.cwd().replaceAll("/", "-"))
        mkdirSync(liveDir, { recursive: true })
        writeFileSync(
          join(liveDir, `${liveId}.jsonl`),
          ["one", "two", "three", "four"]
            .map((word, i) =>
              JSON.stringify({
                type: i % 2 === 0 ? "human" : "assistant",
                timestamp: NOW - (4 - i) * 1000,
                message: { content: `livegoldenneedle live ${word}` },
              }),
            )
            .join("\n") + "\n",
        )
        process.env.HOME = home
        process.env.CLAUDE_SESSION_ID = liveId
        seedGoldenSession("golden-a-1111", "/test/golden", [
          { type: "user", content: "livegoldenneedle indexed row", ageMs: 2 * HOUR, line: 7 },
        ])
        setIndexMeta(getDb(), "last_rebuild", new Date(NOW).toISOString())

        await cmdSearch("livegoldenneedle", { raw: true, limit: "10", project: "*" })

        const { formatTime } = await import("../../src/lib/format")
        expect(stdoutLines()).toEqual([
          `\x1b[2mSearching: "livegoldenneedle" last 30d\x1b[0m\n`,
          `Found 5 matches for "livegoldenneedle" in 0ms:\n`,
          HEAVY,
          "\u{1F534} CURRENT SESSION  |  4 matches",
          HEAVY,
          "\n\u{1F4AC} livegoldenneedle live four",
          LIGHT,
          "\n\u{1F4AC} livegoldenneedle live three",
          LIGHT,
          "\n\u{1F4AC} livegoldenneedle live two",
          LIGHT,
          "  ... and 1 more matches in current session",
          "",
          HEAVY,
          "\u{1F4C1} golden-a...  |  /test/golden  |  2h ago",
          HEAVY,
          `\n\u{1F464} User (${formatTime(NOW - 2 * HOUR)}, L7):`,
          LIGHT,
          `${hl("livegoldenneedle")} indexed row`,
          "",
        ])
      } finally {
        safeRemoveSync(home, { within: tmpdir() })
      }
    })

    // Pins: regex-mode (--grep) human output — the grouped header "Session: <12>... | Project: ... | <iso>", the
    // 5-per-session cut and its "... and N more matches in this session" line (S1 refactor guard; grep-scope.test.ts
    // asserts only which session ids appear, the JSON envelope and the refusal). Runs the real CLI under a temp HOME:
    // the Project field derives from the module-load PROJECTS_DIR ($HOME/.claude/projects), which Bun fixes per
    // process, so an in-process CLAUDE_DIR outside $HOME would print "..".
    test("regex mode renders the exact grouped human layout with a 5-per-session cut", async () => {
      const home = mkdtempSync(join(tmpdir(), "recall-s1-grep-"))
      try {
        const token = "golden_grep_7c1"
        const session = "7c1a2b3d-4444-4c2d-8e3f-888888888888"
        const dir = join(home, ".claude", "projects", "proj-gold")
        mkdirSync(dir, { recursive: true })
        const stamps = Array.from({ length: 7 }, (_, i) => `2026-10-09T19:00:0${i}.000Z`)
        writeFileSync(
          join(dir, `${session}.jsonl`),
          stamps
            .map((timestamp, i) =>
              JSON.stringify({
                type: i % 2 === 0 ? "user" : "assistant",
                timestamp,
                message: { role: i % 2 === 0 ? "user" : "assistant", content: `${token} row ${i}` },
              }),
            )
            .join("\n") + "\n",
        )
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, RECALL_DB_PATH: ":memory:", RECALL_AGENT: "0" }
        delete env.CLAUDE_DIR

        const result = await runRecallCli([token, "--grep"], env)

        expect(result.code, result.stderr).toBe(0)
        const time = (iso: string) => new Date(iso).toLocaleTimeString()
        const entries = stamps
          .slice(0, 5)
          .flatMap((iso, i) => [
            `\n${i % 2 === 0 ? "\u{1F464} User" : "\u{1F916} Assistant"} (${time(iso)}):`,
            LIGHT,
            `${hl(token)} row ${i}`,
          ])
        expect(result.stdout).toBe(
          [
            `Searching for "${token}" in session content...\n`,
            "Found 7 matches in 1 files:\n",
            HEAVY,
            `\u{1F4C1} Session: ${session.slice(0, 12)}...  |  Project: proj/gold  |  2026-10-09 19:00:00Z`,
            HEAVY,
            ...entries,
            "\n  ... and 2 more matches in this session",
            "",
          ].join("\n") + "\n",
        )
      } finally {
        safeRemoveSync(home, { within: tmpdir() })
      }
    }, 15_000)

    // Pins: an ambiguous --session prefix refuses with exit code 1 and names every candidate id, newest first
    // (S1 refactor guard; the session-scope test covers only the missing-session and empty-session refusals).
    test("an ambiguous --session refuses with exit 1 and lists the provider-qualified candidates", async () => {
      seedGoldenSession(
        "grok:ambig1-older",
        null,
        [{ type: "user", content: "ambigneedle", ageMs: HOUR, line: 1 }],
        NOW - HOUR,
      )
      seedGoldenSession("codex:ambig1-newer", null, [{ type: "user", content: "ambigneedle", ageMs: HOUR, line: 1 }])
      setIndexMeta(getDb(), "last_rebuild", new Date(NOW).toISOString())
      const filename = getDb().filename

      await cmdSearch("ambigneedle", { session: "ambig1" })

      expect(process.exitCode).toBe(1)
      expect(stderrLines()).toContain(
        `recall: ambiguous --session ambig1 in ${filename} (matching "ambigneedle" last 30d session ambig1...); ` +
          "pass the required <provider>:<uuid> form: codex:ambig1-newer, grok:ambig1-older",
      )
      expect(stdoutLines()).toEqual([`\x1b[2mSearching: "ambigneedle" last 30d session ambig1...\x1b[0m\n`])
    })

    // Pins: invalid --include types refuse with process.exit(1) and both the "Invalid include types" and
    // "Valid types:" messages, before any search (S1 refactor guard; no existing test drives a bad --include).
    test("invalid --include types refuse with exit 1 and name the valid types", async () => {
      seedGoldenFixture()
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${String(code)})`)
      }) as never)
      try {
        await expect(cmdSearch("goldenneedle", { raw: true, include: "zzz" })).rejects.toThrow("process.exit(1)")
      } finally {
        exitSpy.mockRestore()
      }
      expect(stderrLines()).toEqual(
        expect.arrayContaining([
          "Invalid include types: zzz",
          "Valid types: m,b,e,d,c or messages,beads,session_memory,project_memory,docs,claude_md,llm_research",
        ]),
      )
      expect(stdoutLines()).toEqual([])
    })

    // Pins: a query-less raw search (filters only) returns recent messages newest-first with snippet '' and rank 0,
    // and opens no project-content leg and no vault leg even when matching content and a bound vault exist
    // (S1 refactor guard; the epoch-zero test pins only the window bounds with include=m, which already cuts both legs).
    test.each([
      ["--since only", { since: "1d" }, ["golden-a-1111", "golden-b-2222", "golden-a-1111", "golden-b-2222"]],
      ["--tool", { tool: "Bash" }, ["golden-a-1111", "golden-b-2222"]],
    ])(
      "an empty raw query (%s) returns recent messages only, newest first, without content or vault legs",
      async (_label, filter, expectedSources) => {
        const dir = mkdtempSync(join(tmpdir(), "recall-s1-empty-"))
        const history = await import("../../src/history/search")
        const candidates = vi.spyOn(history, "retrieveCandidates")
        try {
          seedGoldenSession("golden-a-1111", "/test/golden", [
            { type: "user", content: "recent alpha", ageMs: 1 * HOUR, line: 1, tool: "Bash" },
            { type: "assistant", content: "recent beta", ageMs: 3 * HOUR, line: 2 },
          ])
          seedGoldenSession("golden-b-2222", null, [
            { type: "user", content: "recent gamma", ageMs: 2 * HOUR, line: 1 },
            { type: "user", content: "recent delta", ageMs: 4 * HOUR, line: 2, tool: "Bash" },
          ])
          // Rows the query-less path must not surface: project content and a bound vault, both "matching" anything.
          seedGoldenContent("recent alpha beta gamma delta")
          getDb()
            .prepare("UPDATE content SET timestamp = ?")
            .run(NOW - HOUR / 2)
          setIndexMeta(getDb(), "last_rebuild", new Date(NOW).toISOString())
          const vaultPath = join(dir, "state.db")
          seedVaultDb(vaultPath, "recent alpha beta gamma delta")
          bindVaultDb(vaultPath)

          await cmdSearch(undefined, { raw: true, json: true, project: "*", ...filter })

          const payload = jsonStdout<{
            query?: string
            total: number
            results: Array<{ contentType: string; sourceId: string; snippet: string; rank: number; timestamp: number }>
          }>(logSpy)
          expect(payload.results.map((row) => row.sourceId)).toEqual(expectedSources)
          expect(payload.results.every((row) => row.contentType === "message")).toBe(true)
          expect(payload.results.every((row) => row.snippet === "" && row.rank === 0)).toBe(true)
          const stamps = payload.results.map((row) => row.timestamp)
          expect(stamps).toEqual([...stamps].sort((a, b) => b - a))
          expect(payload.total).toBe(payload.results.length)
          // Candidate reads happened, but none opened a content or vault leg (a recent-messages leg would be allowed).
          expect(candidates).toHaveBeenCalled()
          for (const [request] of candidates.mock.calls) {
            expect(request.query).toBe("")
            expect(request).not.toHaveProperty("projectContent")
            expect(request).not.toHaveProperty("vault")
          }
          const legs = candidates.mock.results.flatMap((r) => (r.value as { legs: string[] }).legs)
          expect(legs).not.toContain("project_content")
          expect(legs).not.toContain("vault")
        } finally {
          candidates.mockRestore()
          safeRemoveSync(dir, { within: tmpdir() })
        }
      },
    )
  })
})
