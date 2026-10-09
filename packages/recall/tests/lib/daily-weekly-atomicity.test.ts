/**
 * @failure Recall's daily summary file is written straight to its final path, so a concurrently
 *          running weekly reader can synthesise from a half-written day and lose the real content.
 * @level l1
 * @consumer Recall summarizeDay -> summarizeWeek
 * @testonly none
 *
 * Approved contract (27702 plan, CTO condition): daily files need atomic temp-file/rename writes;
 * a partial daily file must never reach a concurrent weekly reader. One armed observation required.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest"

const DAY = "2026-10-01"
const OLD_MARKER = "MARKER-OLD-END"
const NEW_MARKER = "MARKER-NEW-END"

const h = vi.hoisted(() => ({
  home: "",
  project: "",
  dailySynth: "",
  dailyPath: "",
  arm: false,
  weekPromise: undefined as undefined | Promise<unknown>,
  startWeek: undefined as undefined | (() => Promise<unknown>),
  weekQuestions: [] as string[],
}))

vi.mock("os", async (original) => ({ ...(await original<typeof import("os")>()), homedir: () => h.home }))

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>()
  const write = actual.writeFileSync as (...a: unknown[]) => void
  const writeFileSync = ((p: unknown, data: unknown, ...rest: unknown[]) => {
    const target = String(p)
    if (h.arm && target === h.dailyPath && typeof data === "string") {
      h.arm = false
      // Real partial write: everything before the new completion marker.
      write(target, data.slice(0, data.indexOf(NEW_MARKER)))
      // Start the real weekly reader while the daily path is partial; it reads before its first await.
      h.weekPromise = h.startWeek?.()
      return write(target, data)
    }
    return write(p, data, ...rest)
  }) as typeof actual.writeFileSync
  // The approved fix publishes through a temp sibling + rename; start the concurrent weekly reader
  // at that boundary too, so the armed observation fires for the atomic path, not only the direct write.
  const renameSync = ((from: unknown, to: unknown) => {
    if (h.arm && String(to) === h.dailyPath) {
      h.arm = false
      h.weekPromise = h.startWeek?.()
    }
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
      queryModel: async ({ question }: { question: string }) => {
        if (question.includes("# Weekly Development Summary:")) {
          h.weekQuestions.push(question)
          return { response: { content: "Weekly body" } }
        }
        if (question.includes("# Daily Development Summary:")) return { response: { content: h.dailySynth } }
        return { response: { content: "Session fixture summary" } }
      },
      getModel: () => undefined,
      getCheapModel: () => model,
      getCheapModels: () => [model],
      estimateCost: () => 0,
      isProviderAvailable: () => true,
    }),
  }
})

const { summarizeDay, summarizeWeek } = await import("../../src/lib/summarize-daily.ts")
const { closeDb, getDb } = await import("../../src/history/db.ts")

h.home = mkdtempSync(join(realpathSync(tmpdir()), "recall-daily-atomic-"))
h.project = join(h.home, "project")
h.dailySynth = `Daily body for ${DAY}\n${NEW_MARKER}`

function memoryDir(): string {
  return join(h.home, ".claude", "projects", h.project.replace(/\//g, "-"), "memory", "sessions")
}

beforeEach(() => {
  h.arm = false
  h.weekQuestions = []
  h.weekPromise = undefined
  h.startWeek = () => summarizeWeek(DAY)
  process.env.CLAUDE_PROJECT_DIR = h.project
  process.env.RECALL_DB_PATH = join(h.home, "recall.db")

  const sessionsDir = memoryDir()
  rmSync(sessionsDir, { recursive: true, force: true })
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    join(sessionsDir, `${DAY}.md`),
    `# ${DAY}\n\nOLD daily body\n${OLD_MARKER}\n\n---\n## Sessions\nold index\n`,
    "utf8",
  )
  h.dailyPath = join(sessionsDir, `${DAY}.md`)

  const transcriptPath = join(h.home, "session.jsonl")
  writeFileSync(
    transcriptPath,
    [
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "Investigate the daily summary publication race in detail." }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "x".repeat(6000) }] },
      }),
    ].join("\n") + "\n",
    "utf8",
  )
  const at = new Date(`${DAY}T12:00:00`).getTime()
  const db = getDb()
  db.prepare(
    `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title, cwd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("sess-daily-atomic-1", "/test", transcriptPath, at - 60_000, at, 2, "daily fixture", h.project)
  closeDb()
})

afterAll(() => {
  closeDb()
  delete process.env.RECALL_DB_PATH
  delete process.env.CLAUDE_PROJECT_DIR
  rmSync(h.home, { recursive: true, force: true })
})

describe("daily summary atomic publication", () => {
  test("a concurrent weekly reader never synthesises from a partial daily file", async () => {
    h.arm = true
    const day = await summarizeDay(DAY)
    expect(day.skipped).toBe(false)
    await h.weekPromise
    expect(h.weekQuestions.length).toBe(1)
    const during = h.weekQuestions[0] ?? ""
    // The weekly request must carry a COMPLETE old or new day, never the partial replacement alone.
    expect(during.includes(OLD_MARKER) || during.includes(NEW_MARKER)).toBe(true)

    // A later weekly read sees the published replacement.
    await summarizeWeek(DAY)
    expect(h.weekQuestions.length).toBe(2)
    expect(h.weekQuestions[1] ?? "").toContain(NEW_MARKER)
  })
})
