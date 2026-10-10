/**
 * @failure Recall keys its per-session summary cache on the first 8 characters of the session id,
 *          so every Codex session (all sharing the prefix "codex:01") resolves to one cache file
 *          and a cached summary is served for a DIFFERENT session.
 * @level l1
 * @consumer Recall summarizeSession -> getSessionSummaryCache
 * @testonly none
 *
 * Contract: the per-session summary cache is keyed so that two distinct session ids can never
 * share an entry. Observed specimen (2026-10-09): one real day logged 211 Codex sessions whose
 * shortId was the shared "codex:01" against 211 distinct rollout sources.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest"

// Two real Codex session ids from the specimen. Their first 8 characters are identical.
const SESSION_A = "codex:01a0f1e9-3851-7692-986b-7527f44e6bd5"
const SESSION_B = "codex:01a0f4b0-9cbc-7062-b89e-d175b2caa0bb"

const h = vi.hoisted(() => ({
  home: "",
  project: "",
  answers: [] as string[],
  asked: 0,
}))

vi.mock("os", async (original) => ({ ...(await original<typeof import("os")>()), homedir: () => h.home }))

vi.mock("../../src/lib/llm-backend.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/llm-backend.ts")>()
  const model = { modelId: "cheap-fixture", provider: "fixture" }
  return {
    ...actual,
    loadLlm: async () => ({
      // One distinct answer per call, in order, so a cache hit shows up as a missing answer.
      queryModel: async () => {
        const answer = h.answers[h.asked] ?? "unexpected-extra-call"
        h.asked += 1
        return { response: { content: answer } }
      },
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

h.home = mkdtempSync(join(realpathSync(tmpdir()), "recall-cache-key-"))
h.project = join(h.home, "project")

function transcript(marker: string): string {
  // Both turns are padded past MIN_CONTENT_LENGTH (100) so extraction records real content and the
  // summarizer reaches the cache-writing path instead of the "content too short" skip.
  return (
    [
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "text",
              text: `Summarize this fixture session ${marker}; it is padded past the minimum content gate so the run reaches the LLM and cache path.`,
            },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: `Recorded for ${marker}. This assistant turn is also padded beyond the minimum so extraction reports substantive content for the summary step.`,
            },
          ],
        },
      }),
    ].join("\n") + "\n"
  )
}

beforeEach(() => {
  h.asked = 0
  h.answers = []
  process.env.CLAUDE_PROJECT_DIR = h.project
  process.env.RECALL_DB_PATH = join(h.home, "recall.db")
  const db = getDb()
  db.exec("DELETE FROM sessions")
  for (const [id, marker] of [
    [SESSION_A, "A"],
    [SESSION_B, "B"],
  ] as const) {
    const transcriptPath = join(h.home, `${marker}.jsonl`)
    writeFileSync(transcriptPath, transcript(marker), "utf8")
    db.prepare(
      `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, "/test", transcriptPath, Date.now() - 1000, Date.now(), 2, `fixture-${marker}`)
  }
  closeDb()
})

afterAll(() => {
  closeDb()
  delete process.env.RECALL_DB_PATH
  delete process.env.CLAUDE_PROJECT_DIR
  rmSync(h.home, { recursive: true, force: true })
})

describe("session summary cache key", () => {
  test("two distinct session ids sharing a prefix never share a cache entry", async () => {
    h.answers = ["summary-for-A", "summary-for-B"]

    const a = await summarizeSession(SESSION_A)
    expect(a.summary).toBe("summary-for-A")

    // The whole defect: with the shared 8-character key this returns A's summary for B.
    expect(getSessionSummaryCache(SESSION_B)).toBeNull()

    const b = await summarizeSession(SESSION_B)
    expect(b.summary).toBe("summary-for-B")
    expect(b.summary).not.toBe(a.summary)

    // Each session still reads back its own summary.
    expect(getSessionSummaryCache(SESSION_A)).toBe("summary-for-A")
    expect(getSessionSummaryCache(SESSION_B)).toBe("summary-for-B")
  })
})
