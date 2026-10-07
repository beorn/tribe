/**
 * @failure Recall summary extraction reads the whole transcript into the JS heap before sampling.
 * @level l1
 * @consumer Recall summarize (extractSessionContent)
 *
 * Approved contract (27702 plan, CTO conditions): extraction must not materialise the whole
 * transcript, and the existing beginning/middle/end sampling and user-vs-subagent classification
 * must be preserved. Bounded read is asserted by intercepting the fs boundary the extractor uses.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

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

import { extractSessionContent } from "../../src/lib/extract.ts"
import { closeDb, getDb } from "../../src/history/db.ts"

const SESSION_ID = "sess-extract-bounded"
let dir: string | undefined

beforeEach(() => {
  readCalls.length = 0
})

afterEach(() => {
  closeDb()
  delete process.env.RECALL_DB_PATH
  vi.restoreAllMocks()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** Records whose text is >20 chars (the extractor's inclusion threshold) and index-addressable. */
function record(i: number): string {
  const type = i % 2 === 0 ? "user" : "assistant"
  const marker = `REC-${String(i).padStart(3, "0")}`
  // 21-char text keeps 120 selected messages inside the extractor's 4000-char tail.
  return JSON.stringify({ type, message: { content: [{ type: "text", text: `${marker}: ${"x".repeat(12)}` }] } })
}

/** Longer text so 120 selected records exceed the extractor's 4000-char tail. */
function longRecord(i: number): string {
  const type = i % 2 === 0 ? "user" : "assistant"
  const marker = `REC-${String(i).padStart(3, "0")}`
  return JSON.stringify({ type, message: { content: [{ type: "text", text: `${marker}: ${"y".repeat(60)}` }] } })
}

function writeFixture(records: string[]): string {
  dir = mkdtempSync(join(tmpdir(), "recall-extract-"))
  const transcriptPath = join(dir, "session.jsonl")
  writeFileSync(transcriptPath, records.join("\n") + "\n", "utf8")
  process.env.RECALL_DB_PATH = join(dir, "recall.db")
  const db = getDb()
  db.prepare(
    `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(SESSION_ID, "/test", transcriptPath, Date.now() - 1000, Date.now(), records.length, "fixture")
  closeDb()
  return transcriptPath
}

describe("extractSessionContent bounded loading", () => {
  test("does not read the whole transcript into the heap", () => {
    const transcriptPath = writeFixture(Array.from({ length: 200 }, (_, i) => record(i)))
    const out = extractSessionContent(SESSION_ID)
    expect(out).not.toBeNull()
    expect(readCalls).not.toContain(transcriptPath)
  })
})

describe("extractSessionContent summary sampling", () => {
  test("N=120 selects every record", () => {
    writeFixture(Array.from({ length: 120 }, (_, i) => record(i)))
    const out = extractSessionContent(SESSION_ID)
    expect(out?.content).toContain("REC-000:")
    expect(out?.content).toContain("REC-119:")
  })

  test("N=121 selects indices 0-79 and 81-120", () => {
    writeFixture(Array.from({ length: 121 }, (_, i) => record(i)))
    const out = extractSessionContent(SESSION_ID)
    expect(out?.content).toContain("REC-000:")
    expect(out?.content).toContain("REC-079:")
    expect(out?.content).not.toContain("REC-080:")
    expect(out?.content).toContain("REC-081:")
    expect(out?.content).toContain("REC-120:")
  })

  test("selected user evidence keeps subagent classification after the 4000-char tail drops it", () => {
    const records = Array.from({ length: 161 }, (_, i) => longRecord(i))
    writeFixture(records)
    const out = extractSessionContent(SESSION_ID)
    expect(out).not.toBeNull()
    // The early user record is pushed out of the retained tail, but classification must hold.
    expect(out?.content).not.toContain("REC-000:")
    expect(out?.isSubAgent).toBe(false)
  })
})
