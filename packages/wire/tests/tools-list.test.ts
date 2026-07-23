import { describe, expect, it } from "vitest"
import { resolveDeliveryCapability } from "../src/lib/delivery.ts"
import { TOOLS_LIST, toolListForDeliveryCapability } from "../src/lib/tools-list.ts"

describe("tribe MCP tools list", () => {
  it("exposes inbox.wait as a callable tool", () => {
    const tool = TOOLS_LIST.find((entry) => entry.name === "inbox.wait")
    expect(tool).toBeTruthy()
    expect(tool?.description).toContain("Long-poll the actionable inbox")
    expect(tool?.description).toContain("request/query/assign/verdict")
    expect(tool?.description).not.toContain("ball:reminder")
    expect(tool?.description).toContain("notify/status/response")
    expect(tool?.description).toContain("pullTransport=mcp")
    expect(tool?.description).toContain("host_cut")
    expect(tool?.description).toContain("tribe inbox-wait")
    expect((tool as { _meta?: Record<string, unknown> })._meta?.["tribe.deliveryCapability"]).toMatchObject({
      delivery: "pull",
      pullTransport: "mcp",
      idleStrategy: "cli-inbox-wait",
    })
  })

  it("specializes inbox.wait for the advertised pull transport", () => {
    const tools = toolListForDeliveryCapability(
      resolveDeliveryCapability({ delivery: "pull", channel: false, pullTransport: "cli" }),
    )
    const tool = tools.find((entry) => entry.name === "inbox.wait")
    expect(tool?.description).toContain("pullTransport=cli")
    expect(tool?.description).toContain("tribe inbox-wait")
    expect(tool?.description).toContain("one max-window CLI wait")
    expect(tool?.description).toContain("type=request/query/assign/verdict")
    expect(tool?.description).not.toContain("ball:reminder")
    expect(tool?.description).toContain("repeated short waits")
    expect((tool as { _meta?: Record<string, unknown> })._meta?.["tribe.deliveryCapability"]).toMatchObject({
      delivery: "pull",
      pullTransport: "cli",
      idleStrategy: "cli-inbox-wait",
    })
  })

  it("tells host-stream clients not to poll", () => {
    const tools = toolListForDeliveryCapability(
      resolveDeliveryCapability({ delivery: "pull", channel: false, pullTransport: "host-stream" }),
    )
    const tool = tools.find((entry) => entry.name === "inbox.wait")
    expect(tool?.description).toContain("pullTransport=host-stream")
    expect(tool?.description).toContain("host Tribe stream")
    expect(tool?.description).toContain("do not poll")
    expect((tool as { _meta?: Record<string, unknown> })._meta?.["tribe.deliveryCapability"]).toMatchObject({
      delivery: "pull",
      pullTransport: "host-stream",
      idleStrategy: "host-stream",
    })
  })
})
