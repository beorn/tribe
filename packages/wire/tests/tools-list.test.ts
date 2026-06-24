import { describe, expect, it } from "vitest"
import { TOOLS_LIST } from "../src/lib/tools-list.ts"

describe("tribe MCP tools list", () => {
  it("exposes inbox.wait as a callable tool", () => {
    const tool = TOOLS_LIST.find((entry) => entry.name === "inbox.wait")
    expect(tool).toBeTruthy()
    expect(tool?.description).toContain("Long-poll the actionable inbox")
  })
})
