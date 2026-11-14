import { assertSingleStatement } from "@bearly/sqlite"
/**
 * bounded-status — `recall status` must return prompt index/hook diagnostics
 * without blocking on LLM round-trips during chief recovery (km-bead
 * @km/bearly/19925). The default path passes `skipLlm: true`, which must skip
 * BOTH the live synthesis test and the multi-model race benchmark.
 *
 * Driven through the CLI as a subprocess so it is hermetic (HOME → temp dir, so
 * an empty session index is auto-created) and so the diagnostic `log()` output
 * stays in the child rather than tripping the console-clean test gate.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { Database } from "bun:sqlite"
import { join } from "node:path"
import { tmpdir } from "node:os"

const CLI = join(import.meta.dirname, "..", "src", "cli.ts")

let home: string

function runStatus(
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string; elapsedMs: number } {
  const start = Date.now()
  const res = spawnSync(process.execPath, [CLI, "status", ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, HOME: home, TRIBE_LLM_DIR: "", ...extraEnv },
  })
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", elapsedMs: Date.now() - start }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "recall-status-"))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe("recall status (bounded by default)", () => {
  // 33909 / CTO d7ecb647: exercise the real CLI and benchmark paths against
  // a host that records EVERY dispatch and deliberately has no consent guard.
  // The opted-in control proves the same corpus actually reaches model calls.
  test("--bench needs explicit metered consent before dispatching", () => {
    const dbPath = join(home, "session-index.db")
    const fixture = join(home, "llm-host")
    const callsPath = join(home, "dispatches.jsonl")
    mkdirSync(fixture)
    const fixtureEnv = {
      RECALL_DB_PATH: dbPath,
      TRIBE_LLM_DIR: fixture,
      RECALL_LLM_DENY_PROVIDERS: "",
      CONSENT_CALLS: callsPath,
    }
    writeFileSync(
      join(fixture, "index.ts"),
      `
      import { appendFileSync } from "node:fs"
      const models = [
        { provider: "openrouter", modelId: "deepseek/deepseek-chat" },
        { provider: "google", modelId: "gemini-2.5-flash" },
      ]
      export const queryModel = async (options) => {
        appendFileSync(process.env.CONSENT_CALLS, JSON.stringify({ model: options.model.modelId, consent: options.allowMetered }) + "\\n")
        return { response: { model: options.model, content: "Fixture synthesis retains the indexed inline edit evidence without any provider request." } }
      }
      export const resolveQueryRoute = () => ({ kind: "metered" })
      export const getModel = (id) => models.find(model => model.modelId === id)
      export const getCheapModel = () => models[0]
      export const getCheapModels = () => models
      export const isProviderAvailable = () => true
      export const createProviderObservationStore = () => ({})
      export const readProviderAvailability = async (provider) => ({ provider, status: "unknown", source: "fixture", reason: "no stored observation" })
      export const selectModels = ({ candidates, limit }) => ({ candidates, selected: candidates.slice(0, limit), excluded: [], evidence: [] })
      const cost = { charged: { usd: 0 }, listEquivalent: { usd: 0 }, listEquivalentBasis: [] }
      export const resolveResponseCost = () => cost
      export const aggregateCosts = () => cost
      export const averageCost = () => cost
      export const formatCostColumns = () => "fixture cost"
      export const serializeCost = () => ({ cost_usd: 0, list_equivalent_usd: 0, list_equivalent_basis: [] })
      export const deserializeCost = () => cost
      export const describeDispatchFailure = (error) => ({ message: String(error) })
    `,
    )
    expect(runStatus(["--json"], fixtureEnv).status).toBe(0)
    const db = new Database(dbPath)
    try {
      const now = Date.now()
      db.prepare(
        "INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title, cwd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("consent-session", "/fixture", "/fixture/transcript.jsonl", now, now, 1, "inline edit", "/fixture")
      db.prepare("INSERT INTO messages (uuid, session_id, type, content, timestamp) VALUES (?, ?, ?, ?, ?)").run(
        "consent-message",
        "consent-session",
        "user",
        "inline edit bug fix test project knowledge",
        now,
      )
    } finally {
      db.close()
    }
    const ordinary = runStatus(["--json", "--bench"], fixtureEnv)
    expect(ordinary.status, ordinary.stderr).toBe(0)
    expect(existsSync(callsPath)).toBe(false)
    const ordinaryReview = JSON.parse(ordinary.stdout) as { recommendations: string[] }
    expect(ordinaryReview.recommendations.join(" ")).toContain("no unpaid route for deepseek/deepseek-chat")
    const optedIn = runStatus(["--json", "--bench", "--allow-metered"], fixtureEnv)
    expect(optedIn.status, optedIn.stderr).toBe(0)
    const calls = readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { model: string; consent: boolean })
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((call) => call.consent === true)).toBe(true)
  })

  test("default JSON omits both LLM stages and flags bounded mode", () => {
    const { status, stdout } = runStatus(["--json"])
    expect(status).toBe(0)

    const review = JSON.parse(stdout) as {
      llmRaceBenchmark: unknown
      recallTest: unknown
      recommendations: string[]
    }
    expect(review.llmRaceBenchmark).toBeNull()
    expect(review.recallTest).toBeNull()
    expect(review.recommendations.join(" ")).toMatch(/bounded status/i)
  })

  test("default JSON pins status to no searches (search benchmarks skipped by default)", () => {
    const { status, stdout } = runStatus(["--json"])
    expect(status).toBe(0)

    const review = JSON.parse(stdout) as {
      searchBenchmarks: unknown[]
      recommendations: string[]
    }
    expect(review.searchBenchmarks).toEqual([])
    expect(review.recommendations.join(" ")).toMatch(/search benchmarks skipped \(bounded mode\)/i)
  })

  test("status reports blocked rebuild when recall-index schedule is held", () => {
    const fakeHabDir = join(home, "main.hab", "state", "units", "recall-index")
    mkdirSync(fakeHabDir, { recursive: true })
    const overridesPath = join(fakeHabDir, "overrides.json")
    writeFileSync(
      overridesPath,
      JSON.stringify({
        schemaVersion: 1,
        unit: "recall-index",
        deltas: [
          {
            field: "runLevel",
            value: "stopped",
            actor: "@chief",
            reason: "@chief: held pending investigation",
            at: "2026-10-06T14:02:04.045Z",
          },
        ],
      }),
    )

    const res = spawnSync(process.execPath, [CLI, "status", "--json"], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, HOME: home, TRIBE_LLM_DIR: "", HAB_DIR: join(home, "main.hab") },
    })
    expect(res.status).toBe(0)
    const review = JSON.parse(res.stdout) as {
      indexHealth: { isStale: boolean; blockedRebuild?: { actor: string; reason: string } | null }
      recommendations: string[]
    }
    expect(review.indexHealth.isStale).toBe(true)
    expect(review.indexHealth.blockedRebuild?.actor).toBe("@chief")
    expect(review.recommendations.join(" ")).toMatch(/rebuild is blocked by @chief/i)
  })

  test("--bench opts back into search benchmarks and LLM stages", () => {
    const { status, stdout } = runStatus(["--json", "--bench"])
    expect(status).toBe(0)
    const review = JSON.parse(stdout) as {
      searchBenchmarks: Array<{ query: string; resultCount: number }>
      recommendations: string[]
    }
    // With --bench the bounded-skip notices must NOT be emitted and searches must run
    expect(review.recommendations.join(" ")).not.toMatch(/search benchmarks skipped/i)
    expect(review.recommendations.join(" ")).not.toMatch(/bounded status: llm checks skipped/i)
    expect(review.searchBenchmarks).toHaveLength(4)
  })

  // @km/bearly/19943 — the JSON status must be machine-safe AND carry the
  // session-discovery diagnostics, so a "refreshed index but found nothing"
  // recovery is diagnosable (which roots were searched, how many candidates,
  // freshness, and which configured providers recall cannot read).
  test("default JSON includes index age + active-session discovery diagnostics", () => {
    const { status, stdout } = runStatus(["--json"])
    expect(status).toBe(0)
    const review = JSON.parse(stdout) as {
      indexHealth: { isStale: boolean; lastRebuild: string | null }
      sessionDiscovery: {
        cwd: string
        searchedRoots: string[]
        missingRoots: string[]
        unsupportedProviders: { provider: string; reason: string }[]
        candidateCount: number
        exclusions: string[]
        chosen: { ageMs: number } | null
      }
    }
    // Index age (freshness) — the field chief needs to judge staleness.
    expect(review.indexHealth).toHaveProperty("isStale")
    expect(review.indexHealth).toHaveProperty("lastRebuild")
    // Active-session candidate roots + counts.
    const sd = review.sessionDiscovery
    expect(Array.isArray(sd.searchedRoots)).toBe(true)
    expect(Array.isArray(sd.missingRoots)).toBe(true)
    expect(typeof sd.candidateCount).toBe("number")
    expect(Array.isArray(sd.exclusions)).toBe(true)
    // Unsupported-provider diagnostics (loud, not silently skipped).
    expect(Array.isArray(sd.unsupportedProviders)).toBe(true)
  })

  test("default JSON returns within a small bounded time (no live-LLM race path)", () => {
    const { status, elapsedMs } = runStatus(["--json"])
    expect(status).toBe(0)
    expect(elapsedMs).toBeLessThan(30_000)
  })

  test("status on unmigrated database exits non-zero and names schema version and migrate command", () => {
    const claudeDir = join(home, ".claude")
    mkdirSync(claudeDir, { recursive: true })
    const dbPath = join(claudeDir, "session-index.db")
    const db = new Database(dbPath)
    for (const sql of [
      `
      PRAGMA user_version = 3;`,
      `      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_path TEXT, jsonl_path TEXT);`,
      `      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT);`,
    ]) {
      db.exec(assertSingleStatement(sql))
    }
    db.close()

    const { status, stdout, stderr } = runStatus([])
    expect(status).not.toBe(0)
    const combined = stdout + stderr
    expect(combined).toMatch(/Database schema version 3 requires migration to \d+/)
    expect(combined).toContain("recall index --migrate")
  })
})
