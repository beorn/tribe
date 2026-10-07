/**
 * @failure A transcript that changes while the summary extractor reads it is summarized from a
 *          mixed input, or the change is silently retried, instead of a named changed-input skip.
 * @level l1
 * @consumer Recall summarizeSession (extraction identity check)
 *
 * Approved contract (27702 plan §2, @cto ruling b2b6724c): the two-pass identity check uses
 * dev, ino, size, mtime AND ctime (mtime can be set back; ctime cannot). A change produces a named
 * changed-input skip with no hidden retry loop. The fixture rewrites the real file with equal size
 * and a restored mtime, so only ctime moves — no metadata receipt is fabricated.
 */

import { mkdtempSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const fake = vi.hoisted(() => ({ home: "" }))
// The FixtureMutator: on the first open of the transcript the bytes are rewritten in place with the
// SAME length and the mtime restored, so the only observable identity change is ctime.
const target = vi.hoisted(() => ({ path: "", bytes: "", mtimeMs: 0, atimeMs: 0, opens: 0, mutated: false }))

vi.mock("os", async (original) => ({
  ...(await original<typeof import("os")>()),
  homedir: () => fake.home,
}))
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>()
  return {
    ...actual,
    openSync: ((p: Parameters<typeof actual.openSync>[0], ...rest: unknown[]) => {
      if (String(p) === target.path) {
        target.opens += 1
        if (target.opens === 1) {
          actual.writeFileSync(p, target.bytes)
          actual.utimesSync(p, target.atimeMs / 1000, target.mtimeMs / 1000)
          target.mutated = true
        }
      }
      return (actual.openSync as (...a: unknown[]) => unknown)(p, ...rest)
    }) as typeof actual.openSync,
  }
})
vi.mock("../../src/lib/llm-backend.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/llm-backend.ts")>()
  return { ...actual, loadLlm: async () => null }
})

const { summarizeSession } = await import("../../src/lib/summarize-session.ts")
const { closeDb, getDb } = await import("../../src/history/db.ts")

const SESSION_ID = "sess-changed-input"

beforeEach(() => {
  closeDb()
  delete process.env.RECALL_DB_PATH
  if (fake.home) rmSync(fake.home, { recursive: true, force: true })
  fake.home = mkdtempSync(join(realpathSync(tmpdir()), "recall-changed-input-"))
  process.env.CLAUDE_PROJECT_DIR = join(fake.home, "project")
  process.env.RECALL_DB_PATH = join(fake.home, "recall.db")

  const transcriptPath = join(fake.home, "session.jsonl")
  const text =
    Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({
        type: i % 2 === 0 ? "user" : "assistant",
        message: { content: [{ type: "text", text: `CHANGED-INPUT-${String(i).padStart(3, "0")}: ${"x".repeat(40)}` }] },
      }),
    ).join("\n") + "\n"
  writeFileSync(transcriptPath, text, "utf8")

  const before = statSync(transcriptPath)
  target.path = transcriptPath
  target.bytes = text
  target.mtimeMs = before.mtimeMs
  target.atimeMs = before.atimeMs
  target.opens = 0
  target.mutated = false

  const db = getDb()
  db.prepare(
    `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(SESSION_ID, "/test", transcriptPath, Date.now() - 1000, Date.now(), 200, "fixture")
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

describe("changed-input ctime detection", () => {
  test("a transcript whose ctime moves mid-read is a named changed-input skip, with no retry", async () => {
    const out = await summarizeSession(SESSION_ID)

    expect(out.summary).toBeNull()
    expect(out.reason ?? "").toMatch(/changed[-_ ]?input/i)
    // The change was genuine (equal size, restored mtime, ctime moved) ...
    expect(target.mutated).toBe(true)
    // ... and the reader did not loop trying to re-read it.
    expect(target.opens).toBeLessThanOrEqual(2)
  })
})
