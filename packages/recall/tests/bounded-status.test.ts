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
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const CLI = join(import.meta.dirname, "..", "src", "cli.ts")

let home: string

function runStatus(args: string[]): { status: number | null; stdout: string; stderr: string; elapsedMs: number } {
  const start = Date.now()
  const res = spawnSync(process.execPath, [CLI, "status", ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, HOME: home, TRIBE_LLM_DIR: "" },
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

  test("--bench opts back into LLM stages (no bounded-skip recommendation)", () => {
    const { status, stdout } = runStatus(["--json", "--bench"])
    expect(status).toBe(0)
    const review = JSON.parse(stdout) as { recommendations: string[] }
    // With --bench the bounded-skip notice must NOT be emitted; the recall test
    // runs (it may report a missing backend, but the skip notice is absent).
    expect(review.recommendations.join(" ")).not.toMatch(/bounded status: llm checks skipped/i)
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
    // The slow path raced 5 queries at up to 10s each (30-50s). Bounded status
    // does a DB read + a windowed FS scan — orders of magnitude faster. A 30s
    // ceiling cleanly separates the two while tolerating cold start + CI load.
    expect(elapsedMs).toBeLessThan(30_000)
  })
})
