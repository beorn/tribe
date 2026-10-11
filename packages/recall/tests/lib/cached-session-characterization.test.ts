/**
 * @failure A cached session still loads the external LLM backend, or its real classification is
 *          lost on the cache path.
 * @level l1
 * @consumer Recall summarizeSession (cache-hit admission)
 * @testonly none
 *
 * Approved contract (27702 plan §3, @cto ruling b2b6724c): a cached session returns the cached
 * result with the SAME legacy classification, and the backend loader is never used. The cache-hit
 * metadata cost (double streaming) is accepted; the materiality bar only gates a later
 * cache-format decision.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { LlmBackend, LlmModel } from "../../src/lib/llm-backend.ts"

const fake = vi.hoisted(() => ({ home: "" }))
const backend = vi.hoisted(() => ({ loads: 0 }))

vi.mock("os", async (original) => ({
  ...(await original<typeof import("os")>()),
  homedir: () => fake.home,
}))
vi.mock("../../src/lib/llm-backend.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/llm-backend.ts")>()
  return {
    ...actual,
    loadLlm: async () => {
      backend.loads += 1
      const model: LlmModel = { modelId: "live-cheap", provider: "anthropic" }
      const llm: LlmBackend = {
        queryModel: async () => ({ response: { content: "- Cached-path session summarized once." } }),
        getModel: () => undefined,
        getCheapModel: () => model,
        getCheapModels: () => [model],
        estimateCost: () => 0,
        isProviderAvailable: () => true,
        explainUnavailable: () => "",
      }
      return llm
    },
  }
})

const { summarizeSession } = await import("../../src/lib/summarize-session.ts")
const { closeDb, getDb } = await import("../../src/history/db.ts")

const SESSION_ID = "sess-cached-characterization"

beforeEach(() => {
  closeDb()
  delete process.env.RECALL_DB_PATH
  if (fake.home) rmSync(fake.home, { recursive: true, force: true })
  fake.home = mkdtempSync(join(realpathSync(tmpdir()), "recall-cached-"))
  process.env.CLAUDE_PROJECT_DIR = join(fake.home, "project")
  process.env.RECALL_DB_PATH = join(fake.home, "recall.db")
  backend.loads = 0

  const transcriptPath = join(fake.home, "session.jsonl")
  writeFileSync(
    transcriptPath,
    [
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "A real user request for the cached session." }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "An assistant response that is long enough to summarize." }] },
      }),
    ].join("\n") + "\n",
    "utf8",
  )

  const db = getDb()
  db.prepare(
    `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(SESSION_ID, "/test", transcriptPath, Date.now() - 1000, Date.now(), 2, "fixture")
  closeDb()
})

afterEach(() => {
  closeDb()
  vi.restoreAllMocks()
})

afterAll(() => {
  closeDb()
  delete process.env.RECALL_DB_PATH
  delete process.env.CLAUDE_PROJECT_DIR
  if (fake.home) rmSync(fake.home, { recursive: true, force: true })
})

describe("cached session characterization", () => {
  test("a cache hit returns the cached result with its classification and does not load the backend", async () => {
    const first = await summarizeSession(SESSION_ID)
    expect(first.cached).toBe(false)
    expect(first.summary).not.toBeNull()
    expect(first.isSubAgent).toBe(false)
    const loadsAfterFirst = backend.loads

    const second = await summarizeSession(SESSION_ID)
    expect(second.cached).toBe(true)
    expect(second.summary).toBe(first.summary)
    // Classification is preserved on the cache path.
    expect(second.isSubAgent).toBe(first.isSubAgent)
    // The backend loader is not used again for a cached session.
    expect(backend.loads).toBe(loadsAfterFirst)
  })
})
