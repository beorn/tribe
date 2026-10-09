/**
 * @failure Recall's per-session summary cache is written straight to its final path, so a
 *          concurrent cache reader can observe a half-written file and treat it as a summary.
 * @level l1
 * @consumer Recall summarizeSession -> getSessionSummaryCache
 *
 * Approved contract (27702 plan, CTO condition): daily files and session caches need atomic
 * temp-file/rename writes; a partial write must never be visible to a reader. One armed
 * observation is required; a missing observation is a fixture failure, not a pass.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest"

const h = vi.hoisted(() => ({
  home: "",
  project: "",
  summary: "# Session summary\nGoal: fixture atomicity.\nMARKER-COMPLETE-END\n",
  arm: false,
  cachePath: "",
  sessionId: "",
  reader: undefined as undefined | ((id: string) => string | null),
  seen: [] as (string | null)[],
}))

vi.mock("os", async (original) => ({ ...(await original<typeof import("os")>()), homedir: () => h.home }))

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>()
  const write = actual.writeFileSync as (...a: unknown[]) => void
  const observe = (): void => {
    h.arm = false
    h.seen.push(h.reader ? h.reader(h.sessionId) : null) // observer while the final path is unpublished
  }
  const writeFileSync = ((p: unknown, data: unknown, ...rest: unknown[]) => {
    const target = String(p)
    if (h.arm && target === h.cachePath && typeof data === "string") {
      write(target, data.slice(0, Math.floor(data.length / 2))) // real partial write (direct-write defect)
      observe()
      return write(target, data) // complete the real write
    }
    return write(p, data, ...rest)
  }) as typeof actual.writeFileSync
  // The approved fix publishes through a temp sibling + rename; observe at that boundary too, so
  // the armed observation fires for the atomic path instead of only for the direct write.
  const renameSync = ((from: unknown, to: unknown) => {
    if (h.arm && String(to) === h.cachePath) observe()
    return actual.renameSync(from as string, to as string)
  }) as typeof actual.renameSync
  return { ...actual, writeFileSync, renameSync }
})

vi.mock("../../src/lib/llm-backend.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/llm-backend.ts")>()
  const model = { modelId: "cheap-fixture", provider: "fixture" }
  return {
    ...actual,
    loadLlm: async () => ({
      queryModel: async () => ({ response: { content: h.summary } }),
      getModel: () => undefined,
      getCheapModel: () => model,
      getCheapModels: () => [model],
      estimateCost: () => 0,
      isProviderAvailable: () => true,
    }),
  }
})

const { summarizeSession, getSessionSummaryCache } = await import("../../src/lib/summarize-session.ts")
const { closeDb, getDb } = await import("../../src/history/db.ts")

h.home = mkdtempSync(join(realpathSync(tmpdir()), "recall-cache-atomic-"))
h.project = join(h.home, "project")

const SESSION_ID = "sess-cache-atomic-1"

beforeEach(() => {
  h.arm = false
  h.seen = []
  h.sessionId = SESSION_ID
  h.reader = getSessionSummaryCache
  h.cachePath = join(
    h.home,
    ".claude",
    "projects",
    h.project.replace(/\//g, "-"),
    "memory",
    "session-summaries",
    `${SESSION_ID.slice(0, 8)}.md`,
  )
  process.env.CLAUDE_PROJECT_DIR = h.project
  const transcriptPath = join(h.home, "session.jsonl")
  writeFileSync(
    transcriptPath,
    [
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "Summarize this fixture session about atomic cache publication." }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "The cache must publish atomically so a reader never sees a prefix." }] },
      }),
    ].join("\n") + "\n",
    "utf8",
  )
  process.env.RECALL_DB_PATH = join(h.home, "recall.db")
  const db = getDb()
  db.prepare(
    `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(SESSION_ID, "/test", transcriptPath, Date.now() - 1000, Date.now(), 2, "fixture")
  closeDb()
})

afterAll(() => {
  closeDb()
  delete process.env.RECALL_DB_PATH
  delete process.env.CLAUDE_PROJECT_DIR
  rmSync(h.home, { recursive: true, force: true })
})

describe("session summary cache atomic publication", () => {
  test("a cache reader never observes a partial summary", async () => {
    h.arm = true
    const out = await summarizeSession(SESSION_ID)
    expect(h.seen.length).toBe(1) // exactly one armed observation
    const during = h.seen[0]
    // The reader, called while the final path was partial, must see a miss or the whole value.
    expect(during === null || during === h.summary).toBe(true)
    expect(getSessionSummaryCache(SESSION_ID)).toBe(h.summary)
    expect(out.summary).toBe(h.summary)
  })
})
