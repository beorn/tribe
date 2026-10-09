/**
 * @failure A transcript record larger than the approved per-record cap is materialised whole and,
 *          when selected, its leading bytes reach the summary content as if it were ordinary text.
 * @level l1
 * @consumer Recall summarize (extractSessionContent)
 * @testonly none
 *
 * Approved contract (27702 plan §1, @cto ruling b2b6724c): the summary bound is 4 MiB per JSONL
 * record, excluding the newline. An oversized record keeps its position in N; its bytes are
 * discarded while streaming to the next newline, and a selected oversized record renders a named
 * placeholder. One oversized record never skips the whole session.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { extractSessionContent, scanSessionTranscript } from "../../src/lib/extract.ts"
import { closeDb, getDb } from "../../src/history/db.ts"

/** The production pair: a bounded scan, then the content rendered from it. */
function extractFor(id: string) {
  const scan = scanSessionTranscript(id)
  return scan ? extractSessionContent(scan) : null
}

const SESSION_ID = "sess-extract-oversize"
const CAP_BYTES = 4 * 1024 * 1024
const PAYLOAD_MARKER = "OVERSIZED-PAYLOAD-MARKER"
let dir: string | undefined

beforeEach(() => {
  closeDb()
  delete process.env.RECALL_DB_PATH
})

afterEach(() => {
  closeDb()
  delete process.env.RECALL_DB_PATH
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** A small, index-addressable record whose text clears the extractor's 20-char threshold. */
function smallRecord(i: number): string {
  return JSON.stringify({
    type: i % 2 === 0 ? "user" : "assistant",
    message: { content: [{ type: "text", text: `SMALL-${String(i).padStart(3, "0")}: ${"x".repeat(30)}` }] },
  })
}

/** A record whose encoded bytes exceed the approved cap; the marker sits at the start so the
 *  legacy per-text truncation would still surface it if the record were not discarded. */
function oversizedRecord(): string {
  return JSON.stringify({
    type: "user",
    message: { content: [{ type: "text", text: `${PAYLOAD_MARKER} ${"z".repeat(CAP_BYTES + 4096)}` }] },
  })
}

function writeFixture(records: string[]): void {
  dir = mkdtempSync(join(tmpdir(), "recall-extract-oversize-"))
  const transcriptPath = join(dir, "session.jsonl")
  writeFileSync(transcriptPath, records.join("\n") + "\n", "utf8")
  process.env.RECALL_DB_PATH = join(dir, "recall.db")
  const db = getDb()
  db.prepare(
    `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(SESSION_ID, "/test", transcriptPath, Date.now() - 1000, Date.now(), records.length, "fixture")
  closeDb()
}

describe("extractSessionContent oversized-record placeholders", () => {
  test("a selected oversized record is discarded with a named placeholder; the session still summarizes", () => {
    // The oversized record sits inside the [0,40) sample; the neighbouring small records must survive.
    const records = [smallRecord(0), smallRecord(1), oversizedRecord(), smallRecord(3), smallRecord(4)]
    writeFixture(records)

    const out = extractFor(SESSION_ID)
    expect(out).not.toBeNull()

    // Bytes discarded: the record's leading bytes must not reach the summary content.
    expect(out?.content).not.toContain(PAYLOAD_MARKER)

    // Position preserved and other content survives: the session is NOT skipped for one big record.
    expect(out?.content).toContain("SMALL-000")
    expect(out?.content).toContain("SMALL-004")

    // A named placeholder stands in for the discarded record.
    expect(out?.content ?? "").toMatch(/oversiz/i)
  })
})
