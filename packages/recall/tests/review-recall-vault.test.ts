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
    recallMock.mockResolvedValue({ results: [], synthesis: null, llmCost: null })

    await reviewMemorySystem(process.cwd(), { skipSearchBenchmarks: true, vaultDb: "/fixture/vault/.km/state.db" })
    await reviewMemorySystem(process.cwd(), { skipSearchBenchmarks: true, vaultDb: null })

    expect(
      recallMock.mock.calls.map(([query, options]) => [query, (options as { vaultDb?: unknown }).vaultDb]),
    ).toEqual([
      ["inline edit", "/fixture/vault/.km/state.db"],
      ["inline edit", null],
    ])
  })
})
