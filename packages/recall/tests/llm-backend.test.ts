import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { _resetLlmBackendForTests, loadLlm } from "../src/lib/llm-backend"

let tmpRoot: string | undefined
let originalTribeLlmDir: string | undefined
let originalClaudeProjectDir: string | undefined

function writeFakeLlmBackend(projectRoot: string): string {
  const src = join(projectRoot, "vendor", "bearly", "plugins", "llm", "src")
  const lib = join(src, "lib")
  mkdirSync(lib, { recursive: true })
  writeFileSync(
    join(lib, "types.ts"),
    `
export function getModel(id) {
  return { provider: "mock", modelId: id }
}
export function getCheapModel() {
  return { provider: "mock", modelId: "mock-cheap" }
}
export function getCheapModels(max = 2) {
  return [
    { provider: "mock", modelId: "mock-cheap" },
    { provider: "mock", modelId: "mock-cheap-2" },
  ].slice(0, Math.max(0, max))
}
export function estimateCost() {
  return 0.0001
}
`,
    "utf-8",
  )
  writeFileSync(
    join(lib, "research.ts"),
    `
export async function queryModel(opts) {
  return { response: { content: \`mock response: \${opts.question}\` } }
}
`,
    "utf-8",
  )
  writeFileSync(
    join(lib, "providers.ts"),
    `
export function isProviderAvailable(provider) {
  return provider === "mock"
}
`,
    "utf-8",
  )
  return src
}

beforeEach(() => {
  originalTribeLlmDir = process.env.TRIBE_LLM_DIR
  originalClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR
  tmpRoot = mkdtempSync(join(tmpdir(), "recall-llm-backend-"))
  delete process.env.TRIBE_LLM_DIR
  delete process.env.CLAUDE_PROJECT_DIR
  _resetLlmBackendForTests()
})

afterEach(() => {
  _resetLlmBackendForTests()
  if (originalTribeLlmDir === undefined) delete process.env.TRIBE_LLM_DIR
  else process.env.TRIBE_LLM_DIR = originalTribeLlmDir
  if (originalClaudeProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR
  else process.env.CLAUDE_PROJECT_DIR = originalClaudeProjectDir
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
  tmpRoot = undefined
})

describe("loadLlm", () => {
  test("discovers host-local bearly plugins/llm when TRIBE_LLM_DIR is unset", async () => {
    expect(tmpRoot).toBeDefined()
    const expectedDir = writeFakeLlmBackend(tmpRoot!)
    process.env.CLAUDE_PROJECT_DIR = tmpRoot

    const llm = await loadLlm()

    expect(process.env.TRIBE_LLM_DIR).toBeUndefined()
    expect(llm).not.toBeNull()
    expect(llm!.getCheapModel()).toEqual({ provider: "mock", modelId: "mock-cheap" })
    expect(llm!.getCheapModels(1)).toEqual([{ provider: "mock", modelId: "mock-cheap" }])
    expect(llm!.isProviderAvailable("mock")).toBe(true)
    await expect(
      llm!.queryModel({
        question: "hello",
        model: { provider: "mock", modelId: "mock-cheap" },
      }),
    ).resolves.toMatchObject({ response: { content: "mock response: hello" } })
    expect(expectedDir).toContain(join("vendor", "bearly", "plugins", "llm", "src"))
  })
})
