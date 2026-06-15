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

function runStatus(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, "status", ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, HOME: home, TRIBE_LLM_DIR: "" },
  })
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" }
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
})
