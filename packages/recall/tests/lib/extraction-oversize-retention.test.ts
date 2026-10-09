/**
 * @failure An oversized record outside the sampling window is dropped from the record count, so the
 *          middle/last window shifts and the session silently summarizes the wrong slice; a trailing
 *          oversized record with no newline is materialised whole.
 * @level l1
 * @consumer Recall summarize (extractSessionContent)
 * @testonly none
 *
 * Approved contract (27702 plan §1/AC3, @cto ruling b2b6724c): the per-record budget applies to
 * EVERY record, selected or not; an elided record keeps its position in N, so the sample windows do
 * not move, and a trailing record with no newline is handled exactly like a terminated one.
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

const SESSION_ID = "sess-extract-oversize-retention"
const CAP_BYTES = 4 * 1024 * 1024
const PAYLOAD_MARKER = "OVERSIZED-OUTSIDE-SAMPLE-MARKER"
let dir: string | undefined
let transcriptPath = ""

beforeEach(() => {
  readCalls.length = 0
  closeDb()
  delete process.env.RECALL_DB_PATH
})

afterEach(() => {
  closeDb()
  delete process.env.RECALL_DB_PATH
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** The production pair: a bounded scan, then the content rendered from it. */
function extractFor(id: string) {
  const scan = scanSessionTranscript(id)
  return scan ? extractSessionContent(scan) : null
}

/** A small, index-addressable record whose text clears the extractor's 20-char threshold. */
function smallRecord(i: number): string {
  return JSON.stringify({
    type: i % 2 === 0 ? "user" : "assistant",
    message: { content: [{ type: "text", text: `SMALL-${String(i).padStart(3, "0")}: ${"x".repeat(30)}` }] },
  })
}

/** A record whose encoded bytes exceed the approved cap; the marker sits at the start. */
function oversizedRecord(marker: string): string {
  return JSON.stringify({
    type: "user",
    message: { content: [{ type: "text", text: `${marker} ${"z".repeat(CAP_BYTES + 4096)}` }] },
  })
}

function writeFixture(text: string, recordCount: number): void {
  dir = mkdtempSync(join(tmpdir(), "recall-extract-oversize-retention-"))
  transcriptPath = join(dir, "session.jsonl")
  writeFileSync(transcriptPath, text, "utf8")
  process.env.RECALL_DB_PATH = join(dir, "recall.db")
  const db = getDb()
  db.prepare(
    `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(SESSION_ID, "/test", transcriptPath, Date.now() - 1000, Date.now(), recordCount, "fixture")
  closeDb()
}

describe("extractSessionContent oversized-record retention", () => {
  test("an oversized record OUTSIDE the sample still counts in N, so the windows do not move", () => {
    // Index 40 falls between the first-40 window (0-39) and the middle window (100-139);
    // the last window is 201-240 only if the elided record was counted.
    const records = [
      ...Array.from({ length: 40 }, (_, i) => smallRecord(i)),
      oversizedRecord(PAYLOAD_MARKER),
      ...Array.from({ length: 200 }, (_, i) => smallRecord(41 + i)),
    ]
    writeFixture(records.join("\n") + "\n", records.length)

    const out = extractFor(SESSION_ID)
    expect(out).not.toBeNull()

    // The elided record's bytes never reach content, and it was not selected anyway.
    expect(out?.content).not.toContain(PAYLOAD_MARKER)
    expect(out?.content).not.toContain("SMALL-040")

    // Position preserved: the last window still starts at 201 and ends at 240, so the elided
    // record counted in N. (Had it been dropped, the window would be 200-239.)
    expect(out?.content).not.toContain("SMALL-200")
    expect(out?.content).toContain("SMALL-240")

    // Bounded read: the 4 MiB transcript is streamed, never read whole into the heap.
    expect(readCalls).not.toContain(transcriptPath)
  })

  test("a trailing oversized record with no newline is elided with a named placeholder", () => {
    const records = [...Array.from({ length: 5 }, (_, i) => smallRecord(i)), oversizedRecord(PAYLOAD_MARKER)]
    // No trailing newline: the oversized record is the last, unterminated record.
    writeFixture(records.join("\n"), records.length)

    const out = extractFor(SESSION_ID)
    expect(out).not.toBeNull()
    expect(out?.content).not.toContain(PAYLOAD_MARKER)
    expect(out?.content).toContain("SMALL-000")
    expect(out?.content).toContain("SMALL-004")
    expect(out?.content ?? "").toMatch(/oversiz/i)
    expect(readCalls).not.toContain(transcriptPath)
  })
})
