/**
 * @failure Recall reads and constructs a transcript's content even when no LLM backend is
 *          configured, so an unsummarisable session still pays the full extraction cost.
 * @level l1
 * @consumer Recall summarizeSession (model-selection admission)
 * @testonly none
 *
 * Approved contract (27702 plan, CTO condition): with no backend, the skip is named and happens
 * BEFORE transcript content construction; the real rejection text is kept, not zeros.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest"

const readCalls = vi.hoisted(() => [] as string[])

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>()
  return {
    ...actual,
    readFileSync: ((p: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
      readCalls.push(String(p))
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)
    }) as typeof actual.readFileSync,
  }
})

vi.mock("../../src/lib/llm-backend.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/llm-backend.ts")>()
  return { ...actual, loadLlm: async () => null }
})

const { summarizeSession } = await import("../../src/lib/summarize-session.ts")
const { closeDb, getDb } = await import("../../src/history/db.ts")

const SESSION_ID = "sess-no-backend-1"
let home: string | undefined
let transcriptPath = ""

beforeEach(() => {
  readCalls.length = 0
  closeDb()
  delete process.env.RECALL_DB_PATH
  delete process.env.CLAUDE_PROJECT_DIR
  if (home) rmSync(home, { recursive: true, force: true })
  home = mkdtempSync(join(realpathSync(tmpdir()), "recall-no-backend-"))
  transcriptPath = join(home, "session.jsonl")
  writeFileSync(
    transcriptPath,
    [
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "A session that cannot be summarised without a backend." }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "The backend is absent, so no synthesis is possible here." }] },
      }),
    ].join("\n") + "\n",
    "utf8",
  )
  process.env.RECALL_DB_PATH = join(home, "recall.db")
  const db = getDb()
  db.prepare(
    `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(SESSION_ID, "/test", transcriptPath, Date.now() - 1000, Date.now(), 2, "fixture")
  closeDb()
})

afterAll(() => {
  closeDb()
  if (home) rmSync(home, { recursive: true, force: true })
})

describe("no-backend admission", () => {
  test("names the skip without constructing transcript content", async () => {
    const out = await summarizeSession(SESSION_ID)
    expect(out.summary).toBeNull()
    expect(out.reason).toBe("No LLM backend is configured (TRIBE_LLM_DIR unset or failed to load)")
    expect(readCalls).not.toContain(transcriptPath)
  })
})
