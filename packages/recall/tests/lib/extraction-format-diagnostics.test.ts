/**
 * @failure An unsupported (non-Claude) sampled transcript — e.g. a Codex rollout `response_item` file — is
 *          silently classified as a sub-agent and skipped with no reason, so it is dropped without explanation.
 * @level l1
 * @consumer Recall summarize (scanSessionTranscript / summarizeSession)
 * @testonly none
 *
 * The 27702 plan §2 and CTO ruling require an unsupported-sample explanation with per-session diagnostics and
 * no Codex decoder: recognised envelope types only explain a no-content result, and a mixed sample keeps its
 * valid Claude content.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const fake = vi.hoisted(() => ({ home: "" }))
vi.mock("os", async (original) => ({
  ...(await original<typeof import("os")>()),
  homedir: () => fake.home,
}))

const { scanSessionTranscript } = await import("../../src/lib/extract.ts")
const { summarizeSession } = await import("../../src/lib/summarize-session.ts")
const { closeDb, getDb } = await import("../../src/history/db.ts")

const SESSION_ID = "sess-format-diag"
const unsupported = (): string =>
  JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(6000) }] },
  })
const claudeUser = (marker: string): string =>
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: `${marker} ${"y".repeat(40)}` }] } })

let dir: string | undefined

function writeFixture(lines: string[]): void {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = mkdtempSync(join(tmpdir(), "recall-format-diag-"))
  fake.home = dir
  const transcriptPath = join(dir, "session.jsonl")
  writeFileSync(transcriptPath, lines.join("\n") + "\n", "utf8")
  process.env.RECALL_DB_PATH = join(dir, "recall.db")
  const db = getDb()
  db.prepare(
    `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(SESSION_ID, "/test", transcriptPath, Date.now() - 1000, Date.now(), lines.length, "fixture")
  closeDb()
}

beforeEach(() => {
  delete process.env.CLAUDE_PROJECT_DIR
})

afterEach(() => {
  closeDb()
  delete process.env.RECALL_DB_PATH
  vi.restoreAllMocks()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe("unsupported sampled format diagnostics", () => {
  test("an unsupported-only sample is named, not silently a sub-agent", async () => {
    writeFixture([unsupported()])

    const scan = scanSessionTranscript(SESSION_ID)
    expect(scan?.reason).toBe("unsupported-sampled-format")
    expect(scan?.isSubAgent).toBe(false)
    expect(scan?.diagnostics.unsupported).toBe(1)

    const summary = await summarizeSession(SESSION_ID)
    expect(summary.reason).toBe("unsupported-sampled-format")
    expect(summary.isSubAgent).toBe(false)
    expect(summary.summary).toBeNull()
  })

  test("a mixed sample keeps its valid Claude content and only counts the unsupported records", () => {
    writeFixture([unsupported(), claudeUser("mixed-marker"), unsupported()])

    const scan = scanSessionTranscript(SESSION_ID)
    expect(scan?.reason).toBeUndefined()
    expect(scan?.isSubAgent).toBe(false)
    expect(scan?.content).toContain("mixed-marker")
    expect(scan?.diagnostics.unsupported).toBe(2)
  })

  test("malformed sampled records are counted, not silently dropped", () => {
    writeFixture(["{ not json", claudeUser("kept-marker")])

    const scan = scanSessionTranscript(SESSION_ID)
    expect(scan?.diagnostics.malformed).toBe(1)
    expect(scan?.content).toContain("kept-marker")
  })
})
