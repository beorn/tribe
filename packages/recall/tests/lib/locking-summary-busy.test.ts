/**
 * @failure A second summary engine runs concurrently on the same Recall DB — including through a
 *          symlink alias path — so two processes write the same daily and cache files.
 * @level l1
 * @consumer Recall summarizeDay (the manual / opt-in daily engine)
 *
 * Approved contract (27702 plan §4, @cto ruling b2b6724c): one summary-operation lock keyed on the
 * canonical realpath of the selected Recall DB plus `.summary.lock`, reusing @bearly/flock.
 * Equivalent DB symlink paths share one lock. Contention returns the existing skipped result shape
 * with `reason: summary_busy`; termination releases it for the next process.
 */

import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tryAcquireFlock } from "@bearly/flock"
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const fake = vi.hoisted(() => ({ home: "" }))

vi.mock("os", async (original) => ({
  ...(await original<typeof import("os")>()),
  homedir: () => fake.home,
}))
vi.mock("../../src/lib/llm-backend.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/llm-backend.ts")>()
  return { ...actual, loadLlm: async () => null }
})

const { summarizeDay } = await import("../../src/lib/summarize-daily.ts")
const { closeDb, getDb } = await import("../../src/history/db.ts")

const DAY = "2026-09-29"
const SESSION_ID = "sess-summary-lock"
let realDir: string | undefined
let aliasDir = ""
let realDb = ""

beforeEach(() => {
  closeDb()
  delete process.env.RECALL_DB_PATH
  if (realDir) rmSync(realDir, { recursive: true, force: true })
  realDir = mkdtempSync(join(realpathSync(tmpdir()), "recall-summary-lock-"))
  fake.home = realDir
  aliasDir = `${realDir}-alias`
  try {
    rmSync(aliasDir, { recursive: true, force: true })
  } catch {
    // no prior alias
  }
  symlinkSync(realDir, aliasDir)
  realDb = join(realDir, "recall.db")

  const transcriptPath = join(realDir, "session.jsonl")
  // Assistant-only text > 5 KB keeps the session "meaningful" while classifying it as a sub-agent,
  // so summarizeDay reaches the operation but returns before any synthesis/git/beads work.
  writeFileSync(
    transcriptPath,
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: `sub-agent tool chatter ${"z".repeat(6000)}` }] },
    }) + "\n",
    "utf8",
  )

  process.env.RECALL_DB_PATH = realDb
  const db = getDb()
  db.prepare(
    `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SESSION_ID,
    "/test",
    transcriptPath,
    new Date(`${DAY}T12:00:00`).getTime() - 1000,
    new Date(`${DAY}T12:00:00`).getTime(),
    1,
    "fixture",
  )
  closeDb()
})

afterEach(() => {
  closeDb()
  delete process.env.RECALL_DB_PATH
  vi.restoreAllMocks()
  if (realDir) rmSync(realDir, { recursive: true, force: true })
  rmSync(aliasDir, { recursive: true, force: true })
  realDir = undefined
})

afterAll(() => {
  delete process.env.RECALL_DB_PATH
})

describe("summary-operation lock", () => {
  test("a held lock on the canonical realpath is felt through a symlink alias as summary_busy", async () => {
    // The premise: the alias and the real path are the same canonical DB.
    expect(realpathSync(join(aliasDir, "recall.db"))).toBe(realpathSync(realDb))
    // Hold the lock the plan names, reached through the ALIAS path's canonical target.
    using held = tryAcquireFlock(`${realpathSync(join(aliasDir, "recall.db"))}.summary.lock`, {
      body: JSON.stringify({ startedAt: Date.now() }),
    })
    expect(held).not.toBeNull()

    // Invoke the dated engine through the alias path: distinct project output dir, same DB.
    process.env.RECALL_DB_PATH = join(aliasDir, "recall.db")
    const result = await summarizeDay(DAY)

    expect(result.skipped).toBe(true)
    expect(result.reason).toBe("summary_busy")
  })

  test("releasing the lock lets the next process run", async () => {
    {
      using held = tryAcquireFlock(`${realpathSync(realDb)}.summary.lock`, {
        body: JSON.stringify({ startedAt: Date.now() }),
      })
      expect(held).not.toBeNull()
    }

    process.env.RECALL_DB_PATH = join(aliasDir, "recall.db")
    const result = await summarizeDay(DAY)
    expect(result.reason).not.toBe("summary_busy")
  })
})
