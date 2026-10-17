/**
 * @failure The injection record's bound silently disappears when the size of the file cannot be read: debug.ts's
 *          `readLiveSegment` (then named `recordBytesOnDisk`) caught EVERY stat error and returned 0, so a record
 *          this process could not measure was appended to blind — the segment could pass its ceiling while the
 *          writer claimed it was empty (/hh/var/@dev-review2/29681-injection-record-verdict.md, P2 "stat failures
 *          silently become zero").
 * @level l2 — the real writer against a scratch directory, with statSync (and only statSync) made to fail for one path
 * @consumer @ag/hab/29681-every-log-writer-goes-through/bound-the-tribe-injection-record
 * @reach fs-walk <fixture-only: an mkdtemp scratch directory, written by the writer under test>
 * @testonly none
 *
 * Only a genuinely absent file is the empty-file case. Any other stat failure is named on stderr and the segment is
 * treated as full, so the next row opens a fresh segment rather than growing a record nobody can measure.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { setLogLevel, setSuppressConsole, type LogLevel } from "loggily"
import { emitInjectionDebugEvent, flushInjectionFileWriters, installInjectionFileWriter } from "../src/debug.ts"

/** The file statSync refuses to measure: needed inside the hoisted mock factory, so declared with vi.hoisted. */
const { UNMEASURABLE } = vi.hoisted(() => ({ UNMEASURABLE: "unmeasurable.jsonl" }))

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    statSync: (target: Parameters<typeof statSync>[0], ...rest: unknown[]): ReturnType<typeof statSync> => {
      if (typeof target === "string" && target.endsWith(UNMEASURABLE)) {
        const denied = new Error("EACCES: permission denied, stat") as NodeJS.ErrnoException
        denied.code = "EACCES"
        throw denied
      }
      return (actual.statSync as (...args: unknown[]) => ReturnType<typeof statSync>)(target, ...rest)
    },
  }
})

const MIB = 1024 * 1024
const unsubs: Array<() => void> = []
let prevLevel: string | undefined
let dir: string
let errors: string[]

beforeEach(() => {
  prevLevel = process.env.LOG_LEVEL
  setLogLevel("info")
  setSuppressConsole(true)
  dir = mkdtempSync(join(tmpdir(), "inj-record-stat-"))
  errors = []
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "))
  })
})

afterEach(() => {
  while (unsubs.length) unsubs.pop()?.()
  setSuppressConsole(false)
  setLogLevel((prevLevel as LogLevel) ?? "warn")
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function track(unsub: () => void): void {
  unsubs.push(unsub)
}

function emitRow(size: number, marker: string): void {
  emitInjectionDebugEvent({
    source: "recall",
    action: "skip",
    reason: marker,
    additionalContext: "x".repeat(size),
  })
}

describe("injection record — a segment whose size cannot be read", () => {
  test("the failure is named with its path, and the next row opens a fresh segment rather than appending blind", () => {
    const path = join(dir, UNMEASURABLE)
    writeFileSync(path, "x".repeat(MIB))

    track(installInjectionFileWriter(path))
    emitRow(1024, "row-after-an-unmeasurable-segment")
    flushInjectionFileWriters()

    const named = errors.join("\n")
    expect(named, "an unknown occupancy must be named, not read as an empty record").toContain(path)
    expect(named).toContain("EACCES")
    expect(existsSync(`${path}.1`), "the segment nobody can measure is rotated aside, not appended to").toBe(true)
    expect(readFileSync(path, "utf8")).toContain("row-after-an-unmeasurable-segment")
  })

  test("a record that does not exist yet is the empty-file case: installing and appending it says nothing on stderr", () => {
    const path = join(dir, "first-run.jsonl")

    track(installInjectionFileWriter(path))
    emitRow(1024, "the-first-row")
    flushInjectionFileWriters()

    expect(errors.join("\n"), "an absent record is not a failure").toBe("")
    expect(readFileSync(path, "utf8")).toContain("the-first-row")
  })
})
