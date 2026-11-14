/**
 * @failure  `recall status --bench`'s live recall test called recall() without a vault once the vault became a call
 *           option, so the quality diagnostic silently lost every vault hit while still reporting results
 * @level    l1
 * @consumer src/history/scanner.ts reviewMemorySystem, fed by src/lib/status.ts (@ag/recall/three-dark-search-paths,
 *           @cto 456e6e77)
 * @testonly none
 */
import { afterEach, describe, expect, test, vi } from "vitest"

process.env.RECALL_DB_PATH = ":memory:"

const recallMock = vi.hoisted(() => vi.fn())

vi.mock("../src/history/search.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/history/search.ts")>()),
  recall: recallMock,
}))
vi.mock("../src/lib/llm-backend.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/llm-backend.ts")>()),
  loadLlm: async () => null,
}))

const { reviewMemorySystem } = await import("../src/history/scanner.ts")
const { closeDb } = await import("../src/history/db.ts")

afterEach(() => {
  recallMock.mockReset()
  closeDb()
})

describe("the review's live recall test searches the vault its caller names", () => {
  test("bound, the recall carries that vault; unbound, it carries null", async () => {
    recallMock.mockResolvedValue({ results: [], synthesis: null, calls: [] })

    await reviewMemorySystem(process.cwd(), { skipSearchBenchmarks: true, vaultDb: "/fixture/vault/.km/state.db", allowMetered: true })
    // A caller's unpaid-route refusal must not turn into advice to add keys.
    recallMock.mockResolvedValueOnce({
      results: [{ sessionId: "fixture-lexical-hit" }], synthesis: null, calls: [],
      synthesisFailure: { summary: "No LLM provider is available", excludedProviders: [{ provider: "openrouter", modelId: "paid-only", reason: "no unpaid route for paid-only" }] },
    })
    const unpaid = await reviewMemorySystem(process.cwd(), { skipSearchBenchmarks: true, vaultDb: null, allowMetered: false })

    expect(
      recallMock.mock.calls.map(([query, options]) => [query, (options as { vaultDb?: unknown }).vaultDb]),
    ).toEqual([
      ["inline edit", "/fixture/vault/.km/state.db"],
      ["inline edit", null],
    ])
    expect(recallMock.mock.calls.map(([, options]) => (options as { allowMetered?: boolean }).allowMetered)).toEqual([true, false])
    expect(unpaid.recommendations.join(" ")).toContain("no unpaid route for paid-only")
    expect(unpaid.recommendations.join(" ")).not.toContain("check API keys")
  })
})
