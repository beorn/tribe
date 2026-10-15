/**
 * @failure  the prompt hook's log could not tell a search that ran out of the 1.5 s wall from one that found nothing:
 *           both wrote reason no_results in the envelope's injection:skip row with no time or session, and the hook's
 *           own timed row named neither (@dev/5, injection.jsonl 2026-10-15: 18 no_results rows, none timed)
 * @level    l1
 * @consumer lib/hooks.ts "library ok" / "library skipped" rows; daemon hook-latency-reader.ts (@ag/recall/29480)
 * @testonly none
 */
import { beforeEach, describe, expect, test, vi } from "vitest"

const { createMemorySeenStore, runInjectDelta } = await import("../src/lib/inject-core.ts")
const { RecallDeadlineError } = await import("../src/lib/recall-deadline.ts")
const { hookResultFromCore } = await import("../src/history/scanner.ts")
const { hookDecisionFields } = await import("../src/lib/hooks.ts")

const recallMock = vi.fn()
const JEV = "how does the Jev memory system and smarter linting work?"
const anchor = { query: "Jev memory system", identifier: "Jev" }

/** One hook decision through the real runInjectDelta and the hook's own mapping, as its log row would carry it. */
async function decisionRow(): Promise<Record<string, unknown>> {
  const core = await runInjectDelta(JEV, createMemorySeenStore(), {
    vaultDb: "/fixture/vault/.km/state.db",
    deps: {
      recall: recallMock as unknown as typeof import("../src/history/search.ts").recall,
      ensureProjectSourcesIndexed: vi.fn(),
      deriveVaultAnchor: () => anchor,
    },
  })
  return hookDecisionFields(hookResultFromCore(core))
}

beforeEach(() => {
  recallMock.mockReset()
})

describe("the hook's own row names why nothing was injected", () => {
  test("a wall-expired run and an empty-index run write distinguishable rows", async () => {
    recallMock.mockResolvedValueOnce({ results: [] }).mockRejectedValueOnce(new RecallDeadlineError(1500))
    const wall = await decisionRow()
    recallMock.mockResolvedValue({ results: [] })
    const empty = await decisionRow()

    expect(wall).toMatchObject({ empty_reason: "no_results", wall_cut: ["recall"] })
    expect(empty).toMatchObject({ empty_reason: "no_results" })
    expect(empty).not.toHaveProperty("wall_cut")
    expect(wall).not.toEqual(empty)
  })

  test("the row says what was searched and how long each call took", async () => {
    recallMock.mockResolvedValue({ results: [] })

    expect(await decisionRow()).toMatchObject({
      searched: expect.stringMatching(
        /^the vault for "Jev memory system" in \d+ ms, and messages and titles for the prompt in \d+ ms$/,
      ),
    })
  })

  test("the first call over the wall is its own cut, named in words", async () => {
    recallMock.mockRejectedValueOnce(new RecallDeadlineError(1500))

    expect(await decisionRow()).toMatchObject({
      wall_cut: ["recall_vault"],
      skipped_steps: {
        recall_vault:
          'recall skipped: over the 1.5 s wall (25071): the vault search for "Jev memory system" did not finish, so nothing was searched after it',
      },
    })
  })
})
