/**
 * The prompt hook's recall step has a hard wall clock (@ag/tribe/25071 stopgap, @chief c348476a).
 *
 * @failure Recall is synchronous SQLite, so no timer on the hook's thread can stop it: a real prompt under load took
 *          26 s in the glossary fallback alone, and Claude Code's 30 s kill discarded the whole hook output.
 * @level     l2 — real Workers and a real child process; the recall inside the worker is a fixture that blocks.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { safeRemoveSync } from "removely"
import { describe, expect, test } from "vitest"

import { makeKmVault } from "./helpers/km-vault.ts"

const { createMemorySeenStore, runInjectDelta } = await import("../src/lib/inject-core.ts")
const { createDeadlineRecall, RecallDeadlineError } = await import("../src/lib/recall-deadline.ts")
const { RECALL_WALL_MS } = await import("../src/history/recall-budget.ts")

const BLOCKS = new URL("./fixtures/recall-blocks.worker.ts", import.meta.url)
const IN_MEMORY = new URL("./fixtures/recall-memory.worker.ts", import.meta.url)
const SALIENT = "what did we decide about km-storage-sync layering?"

// @failure The vault binding was module state on the hook's thread; the deadline Worker never had it, so from tribe
// e1ecf2f0 (2026-09-23) every hook recall searched no vault and said nothing (probe: 7 vault hits in-thread, 0
// through the Worker). The vault now rides the call (@cto 456e6e77).
describe("the vault rides the recall call, so the deadline Worker searches it", () => {
  test("hook-mode recall through the real Worker returns the hit of the vault the call names", async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "recall-deadline-vault-"))
    const recall = createDeadlineRecall({ deadlineMs: 10_000, workerUrl: IN_MEMORY })
    try {
      const vaultDb = makeKmVault(dir, [
        {
          id: "@i/search/27897-memory-system",
          fsPath: "@i/search/27897-memory-system.md",
          title: "Jev memory system",
          content: "Jev keeps the memory system's notes.",
        },
      ])
      const result = await recall("Jev", { mode: "hook", raw: true, limit: 5, vaultDb })
      expect(result.results.map((r) => `${r.type}:${r.sessionId}`)).toEqual(["vault:@i/search/27897-memory-system.md"])
    } finally {
      recall.close()
      safeRemoveSync(dir, { within: realpathSync(tmpdir()) })
    }
  }, 15_000)
})

describe("25071 stopgap: recall that outlives its deadline is skipped, loudly", () => {
  test("the deadline is the 1.5 s wall, and its skip says so (25071 row 2)", () => {
    expect(RECALL_WALL_MS).toBe(1500)
    expect(new RecallDeadlineError(RECALL_WALL_MS).message).toBe("recall skipped: over the 1.5 s wall (25071)")
  })

  test("a recall that holds its thread for 10 s returns in under 2.5 s and names the skip", async () => {
    const recall = createDeadlineRecall({ workerUrl: BLOCKS })
    const started = performance.now()
    try {
      const result = await runInjectDelta(SALIENT, createMemorySeenStore(), {
        vaultDb: "/fixture/vault/.km/state.db",
        deps: { recall, ensureProjectSourcesIndexed: () => {}, findGlossaryAnchor: () => null },
      })
      expect(performance.now() - started).toBeLessThan(2500)
      expect(result).toMatchObject({
        skipped: false,
        additionalContext: "recall skipped: over the 1.5 s wall (25071)",
        skippedSteps: { recall: "recall skipped: over the 1.5 s wall (25071)" },
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
