/**
 * The prompt hook says its recall skip in its own output, and exits, when recall outlives the deadline.
 *
 * @failure A real prompt under load spent 26 s in recall's glossary fallback; Claude Code's 30 s kill then discarded
 *          the whole hook output, and a Worker stuck in SQLite would have held the process open past the deadline
 *          (@ag/tribe/25071 stopgap).
 * @level     l2 — the real `cmdHook` library path and a real Worker; the Worker's recall is a fixture that blocks, the
 *          deadline is shortened, and the project-source refresh is stubbed.
 */
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"

const fake = vi.hoisted(() => ({ home: "" }))
fake.home = mkdtempSync(join(realpathSync(tmpdir()), "recall-hook-deadline-"))

vi.mock("os", async (original) => ({ ...(await original<typeof import("os")>()), homedir: () => fake.home }))
vi.mock("loggily", async (original) => {
  // drainOutput ends the process's stdout and stderr before the hook exits; a test must keep them open.
  return { ...(await original<typeof import("loggily")>()), drainOutput: async () => {} }
})
vi.mock("../../src/history/project-sources.ts", async (original) => ({
  ...(await original<typeof import("../../src/history/project-sources.ts")>()),
  ensureProjectSourcesIndexed: () => {},
}))
vi.mock("../../src/lib/recall-deadline.ts", async (original) => {
  const actual = await original<typeof import("../../src/lib/recall-deadline.ts")>()
  return {
    ...actual,
    createDeadlineRecall: () =>
      actual.createDeadlineRecall({
        deadlineMs: 300,
        workerUrl: new URL("../fixtures/recall-blocks.worker.ts", import.meta.url),
      }),
  }
})

const { cmdHook } = await import("../../src/lib/hooks")

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
afterAll(() => safeRemoveSync(fake.home, { within: realpathSync(tmpdir()) }))

describe("25071 stopgap: the hook names a recall that outlived its deadline", () => {
  test("its output carries the skip line, and it exits 0 without waiting for the Worker", async () => {
    vi.stubEnv("TRIBE_NO_DAEMON", "1")
    vi.stubEnv("CLAUDE_SESSION_ID", undefined)
    // The fixture Worker reads `sqlite:<ms>` at the query's start and holds one SQLite call that long.
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
      yield Buffer.from(JSON.stringify({ prompt: "sqlite:10000 what did we decide about km-storage-sync layering?" }))
      return undefined
    })
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    const printed: string[] = []
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      printed.push(String(line))
    })

    // The skip is also a warn row in the hook's log, beside the line in its output.
    const warned: unknown[][] = []
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warned.push(args)
    })

    const started = performance.now()
    await cmdHook()

    expect(performance.now() - started).toBeLessThan(3000)
    expect(printed).toHaveLength(1)
    expect(printed[0]).toContain("recall skipped: over 0.3 s (25071 stopgap)")
    expect(exit).toHaveBeenCalledWith(0)
    expect(JSON.stringify(warned)).toContain('"skipped_steps":{"recall":"recall skipped: over 0.3 s (25071 stopgap)"}')
  }, 15_000)
})
