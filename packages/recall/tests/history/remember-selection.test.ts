/**
 * @failure Recall remember skips a live fallback when its preferred provider is unavailable.
 * @level l1
 * @consumer Recall remember
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { LlmBackend, LlmModel } from "../../src/lib/llm-backend.ts"

const { loadLlmMock } = vi.hoisted(() => ({ loadLlmMock: vi.fn() }))

vi.mock("../../src/lib/llm-backend.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/llm-backend.ts")>()
  return { ...actual, loadLlm: loadLlmMock }
})

import { remember } from "../../src/history/synthesize.ts"

let testDir: string | undefined

afterEach(() => {
  loadLlmMock.mockReset()
  vi.restoreAllMocks()
  if (testDir) rmSync(testDir, { recursive: true, force: true })
  testDir = undefined
})

function writeTranscriptFixture(): { transcriptPath: string; memoryDir: string } {
  testDir = mkdtempSync(join(tmpdir(), "recall-remember-selection-"))
  const transcriptPath = join(testDir, "session.jsonl")
  const memoryDir = join(testDir, "memory")
  writeFileSync(
    transcriptPath,
    [
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "Investigate provider fallback." }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "The first provider was unavailable, so use the next live one." }],
        },
      }),
    ].join("\n"),
  )
  return { transcriptPath, memoryDir }
}

describe("remember model selection", () => {
  test("uses the next live model when the preferred provider is unavailable", async () => {
    const { transcriptPath, memoryDir } = writeTranscriptFixture()

    const preferred: LlmModel = { modelId: "dead-preferred", provider: "openai" }
    const live: LlmModel = { modelId: "live-fallback", provider: "anthropic" }
    const queryModel = vi.fn(async () => ({ response: { content: "- Advance past unavailable providers." } }))
    const llm: LlmBackend = {
      queryModel,
      getModel: vi.fn(),
      getCheapModel: vi.fn(() => preferred),
      getCheapModels: vi.fn(() => [preferred, live]),
      estimateCost: vi.fn(() => 0),
      isProviderAvailable: vi.fn((provider) => provider === "anthropic"),
      explainUnavailable: vi.fn(() => "OPENAI_API_KEY unset"),
    }
    loadLlmMock.mockResolvedValue(llm)

    const result = await remember({ transcriptPath, sessionId: "session-12345678", memoryDir })

    expect(result).toMatchObject({ skipped: false, lessonsCount: 1 })
    expect(queryModel).toHaveBeenCalledOnce()
    expect(queryModel).toHaveBeenCalledWith(expect.objectContaining({ model: live }))
  })

  test("keeps the public reason code and emits the exhaustive rejection report", async () => {
    const { transcriptPath, memoryDir } = writeTranscriptFixture()
    const preferred: LlmModel = { modelId: "dead-openai", provider: "openai" }
    const other: LlmModel = { modelId: "dead-anthropic", provider: "anthropic" }
    const llm: LlmBackend = {
      queryModel: vi.fn(),
      getModel: vi.fn(),
      getCheapModel: vi.fn(() => preferred),
      getCheapModels: vi.fn(() => [preferred, other]),
      estimateCost: vi.fn(() => 0),
      isProviderAvailable: vi.fn(() => false),
      explainUnavailable: vi.fn((provider) => `${provider.toUpperCase()}_API_KEY unset`),
    }
    loadLlmMock.mockResolvedValue(llm)
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    const result = await remember({ transcriptPath, sessionId: "session-12345678", memoryDir })

    expect(result).toEqual({ skipped: true, reason: "no_llm_provider" })
    expect(stderr).toHaveBeenCalledWith(
      "[recall:remember] No cheap LLM provider is available; tried in getCheapModel() first, then remaining getCheapModels() registry order: dead-openai (openai): OPENAI_API_KEY unset; dead-anthropic (anthropic): ANTHROPIC_API_KEY unset\n",
    )
  })
})
