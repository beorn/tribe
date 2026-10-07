/**
 * @failure Recall's remember hook reports only the days it summarized, so a day that was eligible
 *          and skipped in the same run is invisible in the log.
 * @level l1
 * @consumer Recall cmdRemember (remember log)
 *
 * Approved contract (27702 plan §5, @cto ruling b2b6724c): mixed success/skips retain both
 * outcomes — the summarized days AND the skipped days with their existing reasons. A first reason
 * must not hide other skip causes.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"

const logs = vi.hoisted(() => [] as Array<{ ns: string; level: string; msg: unknown[] }>)
const fake = vi.hoisted(() => ({ home: "" }))
const MIXED = vi.hoisted(() => [
  { date: "2026-09-29", sessionsCount: 1, summary: "A day that summarized.", memoryFile: null, skipped: false },
  { date: "2026-09-30", sessionsCount: 1, summary: null, memoryFile: null, skipped: true, reason: "no_content" },
])

fake.home = mkdtempSync(join(realpathSync(tmpdir()), "recall-remember-mixed-"))

vi.mock("os", async (original) => ({
  ...(await original<typeof import("os")>()),
  homedir: () => fake.home,
}))
vi.mock("loggily", async (original) => {
  const actual = await original<typeof import("loggily")>()
  const logger = (ns: string) => ({
    info: (...a: unknown[]) => logs.push({ ns, level: "info", msg: a }),
    warn: (...a: unknown[]) => logs.push({ ns, level: "warn", msg: a }),
    error: (...a: unknown[]) => logs.push({ ns, level: "error", msg: a }),
    debug: () => {},
    child: () => logger(ns),
  })
  return { ...actual, drainOutput: async () => {}, createLogger: (ns: string) => logger(ns) }
})
vi.mock("../../src/lib/summarize-daily", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/summarize-daily")>()
  return { ...actual, summarizeUnprocessedDays: async () => MIXED }
})

const { cmdRemember } = await import("../../src/lib/hooks.ts")

afterEach(() => {
  logs.length = 0
  vi.restoreAllMocks()
})

afterAll(() => {
  rmSync(fake.home, { recursive: true, force: true })
})

/** Every logged arg rendered to text: strings stay verbatim, structured payloads are serialized. */
function logText(): string {
  return logs
    .map((l) => l.msg.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "))
    .join("\n")
}

describe("remember mixed success/skip log", () => {
  test("a summarized day and a skipped day are both retained with the skip reason", async () => {
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
      yield Buffer.from(JSON.stringify({ session_id: "abcdef1234567890" }))
      return undefined
    })
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)

    await cmdRemember({})

    const all = logText()
    // The summarized day is named (existing behavior).
    expect(all).toContain("2026-09-29")
    // The skipped day of the SAME run is named too, with its reason.
    expect(all).toContain("2026-09-30")
    expect(all).toContain("no_content")
  })
})
