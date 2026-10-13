import { describe, expect, it } from "vitest"
import { TRIBE_COMMAND_DESCRIPTORS } from "../src/command-descriptors.ts"
import { resolveDeliveryCapability } from "../src/lib/delivery.ts"
import { CLI_ONLY_TOOLS, TOOLS_LIST, toolListForDeliveryCapability } from "../src/lib/tools-list.ts"

/** The bytes a Claude Code model re-reads per tool each turn: name, description and input schema. The output
 * schema is served on tools/list but never rendered to the model. */
function modelVisibleBytes(tool: { name: string; description: string; inputSchema: unknown }): number {
  return JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }).length
}

describe("tribe MCP tools list", () => {
  it("exposes inbox.wait as a callable tool", () => {
    const tool = TOOLS_LIST.find((entry) => entry.name === "inbox.wait")
    expect(tool).toBeTruthy()
    expect(tool?.description).toContain("Short diagnostic wait")
    expect(tool?.description).toContain("default 5000ms")
    expect(tool?.description).not.toContain("Long-poll the actionable inbox")
    expect(tool?.description).toContain("request/query/assign/verdict")
    expect(tool?.description).not.toContain("ball:reminder")
    expect(tool?.description).toContain("notify/status/response")
    expect(tool?.description).toContain("pullTransport=mcp")
    expect(tool?.description).toContain("host_cut")
    expect(tool?.description).toContain("tribe inbox-wait")
    expect(tool?.description).toContain("never repeated short waits")
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
    expect(tool?.description).toContain("one max-window")
    expect(tool?.description).toContain("request/query/assign/verdict")
    expect(tool?.description).not.toContain("ball:reminder")
    expect(tool?.description).toContain("never repeated short waits")
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

  it("lists every verb except the ones the installed CLI covers (29143)", () => {
    // Of the verbs no seat called over MCP in the 7-day census behind 29137, only these two have a CLI verb; the
    // others (debug, filter, lifecycle.publish, health.publish, lifecycle) have no other rail and stay listed.
    expect([...CLI_ONLY_TOOLS.keys()]).toEqual(["retro", "repair"])
    expect(CLI_ONLY_TOOLS.get("repair")).toContain("tribe repair")
    expect(CLI_ONLY_TOOLS.get("retro")).toContain("tribe retro")
    expect(TOOLS_LIST.map((tool) => tool.name)).toEqual([
      "send",
      "pending",
      "inbox.wait",
      "fetch",
      "members",
      "rename",
      "health",
      "join",
      "restart",
      "debug",
      "filter",
      "lifecycle.publish",
      "health.publish",
      "lifecycle",
    ])
    const listed = new Set(TOOLS_LIST.map((tool) => tool.name))
    for (const descriptor of TRIBE_COMMAND_DESCRIPTORS) {
      expect(listed.has(descriptor.mcp.name), descriptor.mcp.name).toBe(descriptor.mcpList === "listed")
    }
  })

  it("keeps the listed tools' model-visible text inside its budget (29143)", () => {
    // Before 29143 the list weighed 17,023 model-visible bytes (send alone 4,864); the long guidance now lives in
    // the plugin skill, read on demand instead of every turn. Measured at this change: 11,038 in total, send 3,454.
    const sizes = Object.fromEntries(TOOLS_LIST.map((tool) => [tool.name, modelVisibleBytes(tool)]))
    const total = Object.values(sizes).reduce((sum, bytes) => sum + bytes, 0)
    expect(total, JSON.stringify(sizes)).toBeLessThanOrEqual(12_000)
    for (const [name, bytes] of Object.entries(sizes)) expect(bytes, name).toBeLessThanOrEqual(4_000)
  })
})
