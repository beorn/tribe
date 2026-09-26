/**
 * Prompt hook runs recall directly in-process and logs its outcome without any daemon step (25298 AC1/AC2).
 *
 * @failure The prompt hook dialed a dead lore.sock, failing in 2 ms and leaving an uninformative daemon/no-daemon
 *          step before running in-process recall (@ag/tribe/25298, @cto ruling).
 * @level     l2 — the real `cmdHook`; hookRecall is mocked to isolate hook logging, steps, and outcomes.
 */
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"

type Row = { namespace: string; level: string; msg: unknown; data: unknown }
const fake = vi.hoisted(() => ({
  home: "",
  rows: [] as Row[],
  recallResult: {} as Record<string, unknown>,
  daemonCallCount: 0,
}))
fake.home = mkdtempSync(join(realpathSync(tmpdir()), "recall-hook-daemon-"))

vi.mock("os", async (original) => ({ ...(await original<typeof import("os")>()), homedir: () => fake.home }))
vi.mock("loggily", async (original) => {
  const actual = await original<typeof import("loggily")>()
  const recorder = (namespace: string): unknown =>
    new Proxy(
      {},
      {
        get: (_target, level) => (msg: unknown, data: unknown) => {
          fake.rows.push({ namespace, level: String(level), msg, data })
        },
      },
    )
  // drainOutput ends the process's stdout and stderr before the hook exits; a test must keep them open.
  return { ...actual, createLogger: recorder, drainOutput: async () => {} }
})
vi.mock("../../../../plugins/claude/recall/lib/socket.ts", async (original) => ({
  ...(await original<typeof import("../../../../plugins/claude/recall/lib/socket.ts")>()),
  withDaemonCall: async () => {
    fake.daemonCallCount++
    return { kind: "no-daemon" }
  },
}))
vi.mock("../../src/history/recall", async (original) => ({
  ...(await original<typeof import("../../src/history/recall")>()),
  hookRecall: async (_prompt: string, opts?: { steps?: Record<string, number> }) => {
    if (opts?.steps) opts.steps.recall = 5
    return fake.recallResult
  },
}))

const { cmdHook } = await import("../../src/lib/hooks")

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fake.rows = []
  fake.daemonCallCount = 0
})
afterAll(() => safeRemoveSync(fake.home, { within: realpathSync(tmpdir()) }))

const BUSY = "Recall project sources skipped: another connection holds the write lock (database is locked)"

describe("prompt hook executes in-process recall without daemon dial (25298)", () => {
  test("recall skipped: logs library skipped, records library path on warn, and omits daemon step", async () => {
    fake.recallResult = {
      skipped: true,
      reason: "no_results",
      skippedSteps: { project_sources: BUSY },
    }
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
      yield Buffer.from(
        JSON.stringify({ prompt: "what did we decide about km-storage-sync layering?", cwd: fake.home }),
      )
      return undefined
    })
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    vi.spyOn(console, "log").mockImplementation(() => {})

    await cmdHook()

    // withDaemonCall was never invoked by cmdHook
    expect(fake.daemonCallCount).toBe(0)

    // Warn row names path "library"
    const warns = fake.rows.filter((row) => row.namespace === "recall:hook:prompt" && row.level === "warn")
    expect(warns).toEqual([
      expect.objectContaining({
        msg: "step skipped rather than waited on",
        data: expect.objectContaining({ path: "library", skipped_steps: { project_sources: BUSY } }),
      }),
    ])

    // Outcome is "library skipped", never "daemon skipped" or "no-daemon"
    const infoRows = fake.rows.filter((row) => row.namespace === "recall:hook:prompt" && row.level === "info")
    const outcomeRow = infoRows.find((r) => r.msg === "library skipped")
    expect(outcomeRow).toBeDefined()
    const outcomeData = outcomeRow?.data as { steps?: Record<string, number> }
    expect(outcomeData.steps).toBeDefined()
    expect(outcomeData.steps).toHaveProperty("recall")
    expect(outcomeData.steps).not.toHaveProperty("daemon")

    // No daemon-related log rows exist
    const daemonRows = fake.rows.filter((r) => String(r.msg).includes("daemon"))
    expect(daemonRows).toHaveLength(0)
  })

  test("recall ok: logs library ok, emits hook json, and omits daemon step", async () => {
    fake.recallResult = {
      skipped: false,
      hookOutput: {
        hookSpecificOutput: {
          additionalContext: "injected test context",
        },
      },
    }
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
      yield Buffer.from(
        JSON.stringify({ prompt: "what did we decide about km-storage-sync layering?", cwd: fake.home }),
      )
      return undefined
    })
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    const stdoutLines: string[] = []
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      stdoutLines.push(String(line))
    })

    await cmdHook()

    // withDaemonCall was never invoked by cmdHook
    expect(fake.daemonCallCount).toBe(0)

    // Outcome is "library ok", never "daemon ok"
    const infoRows = fake.rows.filter((row) => row.namespace === "recall:hook:prompt" && row.level === "info")
    const outcomeRow = infoRows.find((r) => r.msg === "library ok")
    expect(outcomeRow).toBeDefined()
    const outcomeData = outcomeRow?.data as { steps?: Record<string, number>; context_len?: number }
    expect(outcomeData.context_len).toBe("injected test context".length)
    expect(outcomeData.steps).toHaveProperty("recall")
    expect(outcomeData.steps).not.toHaveProperty("daemon")

    // Standard hook envelope output was emitted
    expect(stdoutLines).toHaveLength(1)
    expect(stdoutLines[0]).toContain("injected test context")

    // No daemon-related log rows exist
    const daemonRows = fake.rows.filter((r) => String(r.msg).includes("daemon"))
    expect(daemonRows).toHaveLength(0)
  })
})
