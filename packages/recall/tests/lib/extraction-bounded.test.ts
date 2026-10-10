/**
 * @failure Recall summary extraction reads the whole transcript into the JS heap before sampling.
 * @level l1
 * @consumer Recall summarize (extractSessionContent)
 * @testonly none
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

import { extractSessionContent, scanSessionTranscript } from "../../src/lib/extract.ts"
import { closeDb, getDb } from "../../src/history/db.ts"

/** The production pair: a bounded scan, then the content rendered from it. */
function extractFor(id: string) {
  const scan = scanSessionTranscript(id)
  return scan ? extractSessionContent(scan) : null
}

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
    const out = extractFor(SESSION_ID)
    expect(out).not.toBeNull()
    expect(readCalls).not.toContain(transcriptPath)
  })

  test("retains no raw sampled record: a 120x10KB transcript yields one bounded tail", () => {
    // The reviewer's shape: 120 records of 10 KB are sampled, but the scan must not hold those ~1.2 MB.
    writeFixture(
      Array.from({ length: 120 }, () =>
        JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "x".repeat(10000) }] } }),
      ),
    )
    const scan = scanSessionTranscript(SESSION_ID)
    expect(scan).not.toBeNull()
    expect(scan?.diagnostics.sampled).toBe(120)
    expect(scan?.content.length).toBeLessThanOrEqual(4000)
    // No field carries a raw line: the whole scan serialises to a few KB regardless of the 1.2 MB input.
    expect(JSON.stringify(scan).length).toBeLessThan(6000)
  })

  test("metadata mode keeps classification and counts but constructs no content", () => {
    writeFixture(Array.from({ length: 120 }, (_, i) => record(i)))
    const scan = scanSessionTranscript(SESSION_ID, { mode: "metadata" })
    expect(scan?.content).toBe("")
    expect(scan?.isSubAgent).toBe(false)
    expect(scan?.diagnostics.sampled).toBe(120)
    expect(JSON.stringify(scan).length).toBeLessThan(1000)
  })

  test("metadata mode formats nothing: content renders messages, metadata renders none", () => {
    // Records carry BOTH a text block and a tool_use block, so the guard is exercised on the
    // text-truncation AND the tool-description path. `content === ""` alone passes even when
    // metadata builds and discards every message; `rendered` is the discriminator (@dev/review2 1180059).
    const records = Array.from({ length: 120 }, (_, i) =>
      JSON.stringify({
        type: i % 2 === 0 ? "user" : "assistant",
        message: {
          content: [
            { type: "text", text: `T-${String(i).padStart(3, "0")}: ${"z".repeat(30)}` },
            { type: "tool_use", name: "Bash", input: { command: `echo ${i}` } },
          ],
        },
      }),
    )
    writeFixture(records)

    const meta = scanSessionTranscript(SESSION_ID, { mode: "metadata" })
    expect(meta?.content).toBe("")
    expect(meta?.diagnostics.sampled).toBe(120)
    expect(meta?.diagnostics.rendered).toBe(0)

    const content = scanSessionTranscript(SESSION_ID, { mode: "content" })
    expect(content?.diagnostics.rendered).toBe(120)
    expect(content?.content).toContain("[Bash]")
  })
})

describe("extractSessionContent summary sampling", () => {
  test("N=120 selects every record", () => {
    writeFixture(Array.from({ length: 120 }, (_, i) => record(i)))
    const out = extractFor(SESSION_ID)
    expect(out?.content).toContain("REC-000:")
    expect(out?.content).toContain("REC-119:")
  })

  test("N=121 selects indices 0-79 and 81-120", () => {
    writeFixture(Array.from({ length: 121 }, (_, i) => record(i)))
    const out = extractFor(SESSION_ID)
    expect(out?.content).toContain("REC-000:")
    expect(out?.content).toContain("REC-079:")
    expect(out?.content).not.toContain("REC-080:")
    expect(out?.content).toContain("REC-081:")
    expect(out?.content).toContain("REC-120:")
  })

  test("selected user evidence keeps subagent classification after the 4000-char tail drops it", () => {
    const records = Array.from({ length: 161 }, (_, i) => longRecord(i))
    writeFixture(records)
    const out = extractFor(SESSION_ID)
    expect(out).not.toBeNull()
    // The early user record is pushed out of the retained tail, but classification must hold.
    expect(out?.content).not.toContain("REC-000:")
    expect(out?.isSubAgent).toBe(false)
  })
})
