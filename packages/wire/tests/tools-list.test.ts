import { describe, expect, it } from "vitest"
import { resolveDeliveryCapability } from "../src/lib/delivery.ts"
import { TOOLS_LIST, toolListForDeliveryCapability } from "../src/lib/tools-list.ts"

describe("tribe MCP tools list", () => {
  it("exposes inbox.wait as a callable tool", () => {
    const tool = TOOLS_LIST.find((entry) => entry.name === "inbox.wait")
    expect(tool).toBeTruthy()
    expect(tool?.description).toContain("Long-poll the actionable inbox")
    expect(tool?.description).toContain("pullTransport=mcp")
    expect((tool as { _meta?: Record<string, unknown> })._meta?.["tribe.deliveryCapability"]).toMatchObject({
      delivery: "pull",
      pullTransport: "mcp",
      idleStrategy: "mcp-inbox.wait",
    })
  })

  it("specializes inbox.wait for the advertised pull transport", () => {
    const tools = toolListForDeliveryCapability(
      resolveDeliveryCapability({ delivery: "pull", channel: false, pullTransport: "cli" }),
    )
    const tool = tools.find((entry) => entry.name === "inbox.wait")
    expect(tool?.description).toContain("pullTransport=cli")
    expect(tool?.description).toContain("bun tribe inbox-wait")
    expect((tool as { _meta?: Record<string, unknown> })._meta?.["tribe.deliveryCapability"]).toMatchObject({
      delivery: "pull",
      pullTransport: "cli",
      idleStrategy: "cli-inbox-wait",
    })
  })
})
