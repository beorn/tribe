/**
 * The prompt hook's recall step has a hard wall clock (@ag/tribe/25071 stopgap, @chief c348476a).
 *
 * @failure Recall is synchronous SQLite, so no timer on the hook's thread can stop it: a real prompt under load took
 *          26 s in the glossary fallback alone, and Claude Code's 30 s kill discarded the whole hook output.
 * @level     l2 — real Workers and a real child process; the recall inside the worker is a fixture that blocks.
 */
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const { createMemorySeenStore, runInjectDelta } = await import("../src/lib/inject-core.ts")
const { createDeadlineRecall, RECALL_DEADLINE_MS, RecallDeadlineError } = await import("../src/lib/recall-deadline.ts")

const BLOCKS = new URL("./fixtures/recall-blocks.worker.ts", import.meta.url)
const SALIENT = "what did we decide about km-storage-sync layering?"

describe("25071 stopgap: recall that outlives its deadline is skipped, loudly", () => {
  test("the deadline is 5 s, and its skip says so", () => {
    expect(RECALL_DEADLINE_MS).toBe(5000)
    expect(new RecallDeadlineError(RECALL_DEADLINE_MS).message).toBe("recall skipped: over 5 s (25071 stopgap)")
  })

  test("a recall that holds its thread for 10 s returns in under 6 s and names the skip", async () => {
    const recall = createDeadlineRecall({ workerUrl: BLOCKS })
    const started = performance.now()
    try {
      const result = await runInjectDelta(SALIENT, createMemorySeenStore(), {
        deps: { recall, ensureProjectSourcesIndexed: () => {}, findGlossaryAnchor: () => null },
      })
      expect(performance.now() - started).toBeLessThan(6000)
      expect(result).toMatchObject({
        skipped: false,
        additionalContext: "recall skipped: over 5 s (25071 stopgap)",
        skippedSteps: { recall: "recall skipped: over 5 s (25071 stopgap)" },
      })
    } finally {
      recall.close()
    }
  }, 15_000)

  test("one deadline covers the first query and the glossary fallback together", async () => {
    const recall = createDeadlineRecall({ deadlineMs: 600, workerUrl: BLOCKS })
    const started = performance.now()
    try {
      // The first query answers empty after 400 ms; the fallback then has only the 200 ms left, not a fresh 600.
      await recall("400", {})
      await expect(recall("400", {})).rejects.toBeInstanceOf(RecallDeadlineError)
      expect(performance.now() - started).toBeLessThan(900)
    } finally {
      recall.close()
    }
  })

  test("a recall that answers inside the deadline is returned as it came", async () => {
    const recall = createDeadlineRecall({ deadlineMs: 5000, workerUrl: BLOCKS })
    try {
      await expect(recall("10", {})).resolves.toMatchObject({ query: "10", results: [] })
    } finally {
      recall.close()
    }
  })

  // Needs bun >= 1.4: 1.3.14 does not end a process whose Worker sits in a native SQLite call, even on process.exit
  // (review2, tribe CI run 35910142616). .bun-version pins the fleet's 1.4.2, so CI runs it.
  test("a process whose recall is stuck inside SQLite still exits at the deadline", () => {
    // Measured: a Worker stuck in one native SQLite call keeps its process alive after terminate() until the call
    // returns (48 s in the probe), so the deadline is only real because the hook exits explicitly.
    const script = fileURLToPath(new URL("./fixtures/recall-deadline-exit.ts", import.meta.url))
    const started = performance.now()
    const child = spawnSync(process.execPath, [script, "500", "20000"], { encoding: "utf8", timeout: 15_000 })
    const wall = performance.now() - started
    expect(child.stderr).toBe("")
    expect(child.stdout).toMatch(/^deadline \d+\n$/u)
    expect(child.status).toBe(0)
    expect(wall).toBeLessThan(5000)
  }, 20_000)
})
