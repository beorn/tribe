/**
 * A prompt the daemon served still says which step it skipped rather than waited on.
 *
 * @failure The daemon's inject_delta skipped a busy project-source step and the hook logged only "daemon ok" or
 *          "daemon skipped": the skip was recorded nowhere (@ag/tribe/25071 row 3 review).
 * @level     l2 — the real `cmdHook`; the daemon call is mocked at its module, and loggily's loggers record rows.
 */
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"

type Row = { namespace: string; level: string; msg: unknown; data: unknown }
const fake = vi.hoisted(() => ({ home: "", rows: [] as Row[], daemonResult: {} as Record<string, unknown> }))
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
  withDaemonCall: async (
    _opts: unknown,
    run: (client: { call: (method: string) => Promise<unknown> }) => Promise<unknown>,
  ) => ({
    kind: "ok",
    value: await run({
      call: async (method) => (method === "tribe.hello" ? {} : fake.daemonResult),
    }),
  }),
}))

const { cmdHook } = await import("../../src/lib/hooks")

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fake.rows = []
})
afterAll(() => safeRemoveSync(fake.home, { within: realpathSync(tmpdir()) }))

const BUSY = "Recall project sources skipped: another connection holds the write lock (database is locked)"

describe("the prompt hook logs a daemon-served skip (@ag/tribe/25071 row 3)", () => {
  test.each([
    ["the daemon skipped the prompt", { skipped: true, reason: "no_results", skippedSteps: { project_sources: BUSY } }],
    [
      "the daemon injected context",
      {
        skipped: false,
        additionalContext: "context",
        seenCount: 1,
        turnNumber: 1,
        skippedSteps: { project_sources: BUSY },
      },
    ],
  ])("%s: one warn row names the skipped step and path daemon", async (_case, daemonResult) => {
    vi.stubEnv("TRIBE_NO_DAEMON", undefined)
    fake.daemonResult = daemonResult
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
      yield Buffer.from(
        JSON.stringify({ prompt: "what did we decide about km-storage-sync layering?", cwd: fake.home }),
      )
      return undefined
    })
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    // The injected case prints the hook's JSON response on stdout; this test reads the log rows, not the response.
    vi.spyOn(console, "log").mockImplementation(() => {})

    await cmdHook()

    const warns = fake.rows.filter((row) => row.namespace === "recall:hook:prompt" && row.level === "warn")
    expect(warns).toEqual([
      expect.objectContaining({
        msg: "step skipped rather than waited on",
        data: expect.objectContaining({ path: "daemon", skipped_steps: { project_sources: BUSY } }),
      }),
    ])
  })
})
