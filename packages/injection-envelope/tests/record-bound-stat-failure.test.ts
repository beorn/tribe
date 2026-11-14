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

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { setLogLevel, setSuppressConsole, type LogLevel } from "loggily"
import { emitInjectionDebugEvent, flushInjectionFileWriters, installInjectionFileWriter } from "../src/debug.ts"

/** The file statSync refuses to measure: needed inside the hoisted mock factory, so declared with vi.hoisted. The
 * refusal is one SEGMENT's (the oversized one written below): once it is rotated aside, the fresh segment at the
 * same path measures, as loggily's own open-time measurement (34294) requires. */
const { UNMEASURABLE, UNMEASURABLE_AT_LEAST } = vi.hoisted(() => ({
  UNMEASURABLE: "unmeasurable.jsonl",
  UNMEASURABLE_AT_LEAST: 1024 * 1024,
}))

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    statSync: (target: Parameters<typeof statSync>[0], ...rest: unknown[]): ReturnType<typeof statSync> => {
      const segment =
        typeof target === "string" && target.endsWith(UNMEASURABLE)
          ? actual.statSync(target, { throwIfNoEntry: false })
          : undefined
      if (segment !== undefined && segment.size >= UNMEASURABLE_AT_LEAST) {
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

  /** A real permission denial, not the mock: the root vitest config does not transform loggily, so a mocked
   * statSync would never reach loggily's own open-time measurement there. A directory without search permission
   * refuses every stat, open and rename under it, in every config. */
  test("a path where every stat fails: install throws loud, keeps the old segment, and registers nothing", () => {
    const locked = join(dir, "no-search")
    mkdirSync(locked)
    const path = join(locked, "record.jsonl")
    writeFileSync(path, "old-segment-row\n")
    chmodSync(locked, 0o600)
    try {
      expect(() => track(installInjectionFileWriter(path))).toThrow(/EACCES/)
      expect(errors.join("\n"), "the refusal is named with the record's path").toContain(path)
      // A failed install claims nothing: the next call tries again and fails loud again, never a silent no-op.
      expect(() => track(installInjectionFileWriter(path))).toThrow(/EACCES/)
    } finally {
      chmodSync(locked, 0o700)
    }
    // Nothing was appended, rotated or lost.
    expect(readFileSync(path, "utf8")).toBe("old-segment-row\n")
    expect(existsSync(`${path}.1`)).toBe(false)
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
