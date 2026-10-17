/**
 * @failure The tribe injection record grows without bound again: ~/.local/share/bearly/injection.jsonl
 *          reached 251,832,256 B by 2026-10-16 with nothing rotating or trimming it, and every row
 *          carried `producer` (one constant, and the file's path already names the writer) and `level`
 *          (which no reader parses). @cto ruled the writer keeps the live file plus one previous
 *          segment, at most 64 MiB together, and writes only the fields a reader uses
 *          (/hh/var/@cto/review/centralized-logging-fates-2026-10-16.md, fate RECORD).
 * @level l2 — the real loggily file writer against a scratch directory
 * @consumer @ag/hab/29681-every-log-writer-goes-through/bound-the-tribe-injection-record, and the reader
 *           this writer feeds: packages/daemon/src/lib/hook-latency-reader.ts:198, whose parser accepts
 *           only `recall:hook:prompt` rows and uses `ts`, `pid`, `msg` and the props it needs.
 * @reach fs-walk <fixture-only: an mkdtemp scratch directory, written by the writer under test>
 * @testonly none
 *
 * The bound is asserted as the ruling states it, not as a copy of the implementation's constant: rows
 * with ~1 MiB props are written until well past 64 MiB, and what lands on disk must satisfy it.
 */

import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { setLogLevel, setSuppressConsole, type LogLevel } from "loggily"
import { emitInjectionDebugEvent, flushInjectionFileWriters, installInjectionFileWriter } from "../src/debug.ts"

const MIB = 1024 * 1024
/** The ruling's ceiling for the live file plus the one previous segment. */
const RECORD_TOTAL_BOUND = 64 * MIB
/** Its per-segment half: no append may carry the live file past this. */
const SEGMENT_BOUND = RECORD_TOTAL_BOUND / 2
/** One row's own bytes may cross the rotation threshold before it rotates, so the bound carries this slack. */
const ONE_ROW_SLACK = 2 * MIB

const unsubs: Array<() => void> = []
let prevLevel: string | undefined
let dir: string

beforeEach(() => {
  prevLevel = process.env.LOG_LEVEL
  setLogLevel("info")
  setSuppressConsole(true)
  dir = mkdtempSync(join(tmpdir(), "inj-record-bound-"))
})

afterEach(() => {
  while (unsubs.length) unsubs.pop()?.()
  setSuppressConsole(false)
  setLogLevel((prevLevel as LogLevel) ?? "warn")
  rmSync(dir, { recursive: true, force: true })
})

function track(unsub: () => void): void {
  unsubs.push(unsub)
}

/** Emit one row carrying roughly `size` bytes of props. */
function emitRow(size: number, marker: string): void {
  emitInjectionDebugEvent({
    source: "recall",
    action: "skip",
    reason: marker,
    additionalContext: "x".repeat(size),
  })
}

function sizeOf(path: string): number {
  return existsSync(path) ? statSync(path).size : 0
}

/** Emit one row carrying roughly `chars` characters of `unit`: a multi-byte `unit` makes characters and bytes differ. */
function emitRowOfChars(unit: string, chars: number, marker: string): void {
  emitInjectionDebugEvent({
    source: "recall",
    action: "skip",
    reason: marker,
    additionalContext: unit.repeat(chars),
  })
}

describe("injection record — the writer keeps the live file plus one previous", () => {
  test("writing well past 64 MiB leaves the live file plus exactly one previous, under the ruling's bound", () => {
    const path = join(dir, "injection.jsonl")
    track(installInjectionFileWriter(path))

    // 140 rows of ~1 MiB is about 140 MiB written: more than two segments' worth.
    for (let i = 0; i < 140; i++) emitRow(MIB, `row-${i}`)
    flushInjectionFileWriters()

    const live = sizeOf(path)
    const previous = sizeOf(`${path}.1`)

    expect(live).toBeGreaterThan(0)
    expect(previous).toBeGreaterThan(0)
    expect(existsSync(`${path}.2`)).toBe(false)
    expect(live + previous).toBeLessThanOrEqual(RECORD_TOTAL_BOUND + ONE_ROW_SLACK)
    // A rotation must have happened: the live file alone cannot hold everything written.
    expect(live).toBeLessThan(140 * MIB)
  })

  test("the newest row is readable at the live path after a rotation", () => {
    const path = join(dir, "injection.jsonl")
    track(installInjectionFileWriter(path))

    for (let i = 0; i < 60; i++) emitRow(MIB, `row-${i}`)
    flushInjectionFileWriters()
    emitRow(1024, "the-newest-row")
    flushInjectionFileWriters()

    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>
    expect(last.reason).toBe("the-newest-row")
  })

  test("a file that is already past the threshold rotates on its first append, keeping that content as the previous segment", () => {
    const path = join(dir, "injection.jsonl")
    writeFileSync(path, "p".repeat(33 * MIB))
    track(installInjectionFileWriter(path))

    emitRow(1024, "after-a-preexisting-file")
    flushInjectionFileWriters()

    expect(sizeOf(`${path}.1`)).toBeGreaterThanOrEqual(33 * MIB)
    expect(sizeOf(path)).toBeLessThan(2 * MIB)
  })

  test("a non-ASCII row is counted in encoded bytes: the bound holds for rows whose UTF-8 size is twice their length", () => {
    const path = join(dir, "injection.jsonl")
    track(installInjectionFileWriter(path))

    // "é" is one UTF-16 unit and two UTF-8 bytes, and the writer stores it as UTF-8 (loggily writeSync of the
    // string). 40 such rows are ~40 MiB of characters — four fifths of the two segments counted as characters —
    // and 80 MiB as bytes, so a character-counting cap would let the pair pass 64 MiB on disk.
    for (let i = 0; i < 40; i++) emitRowOfChars("é", MIB, `utf8-row-${i}`)
    flushInjectionFileWriters()

    const live = sizeOf(path)
    const previous = sizeOf(`${path}.1`)

    expect(previous, "80 MiB of bytes must have crossed the 32 MiB segment ceiling").toBeGreaterThan(0)
    expect(live + previous).toBeLessThanOrEqual(RECORD_TOTAL_BOUND + ONE_ROW_SLACK)
  })

  test("bytes another producer wrote to the same file are counted, so a peer cannot fill the segment behind this writer", () => {
    const path = join(dir, "injection.jsonl")
    track(installInjectionFileWriter(path))

    // The default record path is shared by every hook process and each keeps its own counter, so what a peer has
    // already flushed to disk (its own buffer is at most loggily's 4 KiB) is invisible to this writer's count. That
    // is the shape that let two producers leave ~94 MiB: the file, not this process's tally, is the bound. This row
    // exercises the peer-bytes half alone; the row below pairs it with this writer's own buffered rows.
    appendFileSync(path, "p".repeat(30 * MIB))

    emitRow(4 * MIB, "row-after-a-peer-filled-the-segment")
    flushInjectionFileWriters()

    expect(sizeOf(`${path}.1`), "the peer's 30 MiB became the previous segment").toBeGreaterThanOrEqual(30 * MIB)
    expect(sizeOf(path), "this row opened a fresh segment instead of passing the ceiling").toBeLessThan(8 * MIB)
    expect(readFileSync(path, "utf8")).toContain("row-after-a-peer-filled-the-segment")
  })

  test("a peer's flushed bytes and this writer's own buffered rows are both counted, not one instead of the other", () => {
    const path = join(dir, "injection.jsonl")
    track(installInjectionFileWriter(path))

    // Fill a segment, then set the live length EXACTLY, so what follows is @dev/review2's sequential counterexample
    // rather than a race: the ceiling is the ruling's per-segment half, and live sits 70 KiB under it.
    for (let i = 0; i < 40; i++) emitRow(MIB, `fill-${i}`)
    flushInjectionFileWriters()
    truncateSync(path, SEGMENT_BOUND - 70 * 1024)

    // This writer's own ~3 KiB row, left in loggily's buffer (under 4096 characters, so write() does not flush it).
    emitRow(3000, "own-row-still-buffered")
    expect(sizeOf(path), "the fixture needs this row buffered, not on disk").toBe(SEGMENT_BOUND - 70 * 1024)

    // A second hook process on the same shared file flushes its own 4 KiB behind this writer's back.
    appendFileSync(path, "q".repeat(4 * 1024))

    // The next row is the decision point: our buffered row and the peer's bytes are different bytes, and only their
    // SUM is the occupancy. Measured as max(tally, disk) this row is accepted — the disk says ceiling − 66 KiB, so
    // ceiling − 1.5 KiB fits — and the file then ends at ceiling + 1.6 KiB, past the bound the ruling sets. Flushing
    // the buffered row first makes the file's size the whole occupancy, so this row opens a fresh segment instead.
    emitRow(63 * 1024, "the-row-that-decides")
    flushInjectionFileWriters()

    const live = sizeOf(path)
    const previous = sizeOf(`${path}.1`)

    expect(live, "no append may carry the live segment past its ceiling").toBeLessThanOrEqual(SEGMENT_BOUND)
    expect(live + previous).toBeLessThanOrEqual(RECORD_TOTAL_BOUND)
  })
})

describe("injection record — only the fields a reader uses", () => {
  test("rows carry no producer and no level, and keep the fields the reader parses", () => {
    const path = join(dir, "injection.jsonl")
    track(installInjectionFileWriter(path))

    emitInjectionDebugEvent({
      source: "recall",
      sessionId: "abc-1234",
      action: "emit",
      hookEvent: "UserPromptSubmit",
      prompt: "the reader parses this",
      itemCount: 2,
      chars: 137,
    })
    flushInjectionFileWriters()

    const row = JSON.parse(readFileSync(path, "utf8").trim().split("\n").filter(Boolean).pop()!) as Record<
      string,
      unknown
    >

    expect(row.producer).toBeUndefined()
    expect(row.level).toBeUndefined()
    // The fields hook-latency-reader.ts reads, plus the props it takes them from.
    expect(typeof row.namespace).toBe("string")
    expect(typeof row.ts).toBe("string")
    expect(typeof row.pid).toBe("number")
    expect(row.msg).toBe("emit")
    expect(row.source).toBe("recall")
    expect(row.sessionId).toBe("abc-1234")
    expect(row.chars).toBe(137)
  })
})
