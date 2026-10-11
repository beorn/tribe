/**
 * @failure Recall's remember hook logs "no unprocessed days" even when eligible days existed and
 *          every one was skipped, so a real skip is reported as no work at all.
 * @level l1
 * @consumer Recall cmdRemember (remember log)
 * @testonly none
 *
 * Approved contract (27702 plan, CTO condition): a nonempty all-skipped result set logs the actual
 * days and their existing reasons, never "no unprocessed days".
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const NO_BACKEND = "No LLM backend is configured (TRIBE_LLM_DIR unset or failed to load)"
const DAYS = ["2026-09-28", "2026-09-29", "2026-09-30"]

const logs = vi.hoisted(() => [] as Array<{ ns: string; level: string; msg: unknown }>)
// db-schema.ts reads os.homedir() at module load, during the hoisted import of hooks.ts, so the
// fixture home has to exist before any mock factory runs. `fake.home` is mutated in beforeEach.
const fake = vi.hoisted(() => ({ home: "" }))

vi.mock("os", async (original) => ({
  ...(await original<typeof import("os")>()),
  homedir: () => fake.home,
}))
vi.mock("loggily", async (original) => {
  const actual = await original<typeof import("loggily")>()
  const logger = (ns: string) => ({
    info: (msg: unknown) => logs.push({ ns, level: "info", msg }),
    warn: (msg: unknown) => logs.push({ ns, level: "warn", msg }),
    error: (msg: unknown) => logs.push({ ns, level: "error", msg }),
    debug: () => {},
    child: () => logger(ns),
  })
  return { ...actual, drainOutput: async () => {}, createLogger: (ns: string) => logger(ns) }
})
vi.mock("../../src/lib/llm-backend.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/llm-backend.ts")>()
  return { ...actual, loadLlm: async () => null }
})

const { cmdRemember } = await import("../../src/lib/hooks.ts")
const { closeDb, getDb } = await import("../../src/history/db.ts")

beforeEach(() => {
  logs.length = 0
  closeDb()
  delete process.env.RECALL_DB_PATH
  if (fake.home) rmSync(fake.home, { recursive: true, force: true })
  fake.home = mkdtempSync(join(realpathSync(tmpdir()), "recall-remember-log-"))
  process.env.CLAUDE_PROJECT_DIR = join(fake.home, "project")
  const memoryDir = join(
    fake.home,
    ".claude",
    "projects",
    join(fake.home, "project").replace(/\//g, "-"),
    "memory",
    "sessions",
  )
  mkdirSync(memoryDir, { recursive: true })
  process.env.RECALL_DB_PATH = join(fake.home, "recall.db")
  const db = getDb()
  const insert = db.prepare(
    `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title, cwd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  DAYS.forEach((day, i) => {
    const transcriptPath = join(fake.home, `session-${i}.jsonl`)
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "text", text: `Eligible day ${day} fixture.` }] },
        }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "z".repeat(6000) }] } }),
      ].join("\n") + "\n",
      "utf8",
    )
    const at = new Date(`${day}T12:00:00`).getTime()
    insert.run(`sess-${day}`, "/test", transcriptPath, at - 1000, at, 2, `fixture ${day}`, join(fake.home, "project"))
  })
  closeDb()
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(() => {
  closeDb()
  delete process.env.RECALL_DB_PATH
  delete process.env.CLAUDE_PROJECT_DIR
  if (fake.home) rmSync(fake.home, { recursive: true, force: true })
})

describe("remember truthful skip log", () => {
  test("all-skipped eligible days are named with their reasons, never 'no unprocessed days'", async () => {
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
      yield Buffer.from(JSON.stringify({ session_id: "abcdef1234567890" }))
      return undefined
    })
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)

    await cmdRemember({})

    const messages = logs.map((l) => String(l.msg))
    expect(messages).not.toContain("no unprocessed days")
    const named = messages.find((m) => m.includes("2026-09-30"))
    expect(named).toBeDefined()
    expect(named ?? "").toContain(NO_BACKEND)
  })
})
