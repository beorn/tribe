import { describe, expect, it } from "vitest"
import { TRIBE_COMMAND_DESCRIPTORS } from "../src/command-descriptors.ts"
import { resolveDeliveryCapability } from "../src/lib/delivery.ts"
import {
  OPTIONAL_TOOL_NAMES,
  optionalToolsEnabled,
  TOOLS_LIST,
  toolListForDeliveryCapability,
  TRIBE_MCP_OPTIONAL_TOOLS_ENV,
} from "../src/lib/tools-list.ts"

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

  it("lists only the default-exposure verbs unless the environment opts in (29143)", () => {
    // Seven of the eight verbs no seat called in the 7-day census behind 29137; each stays callable. The eighth,
    // rename, stays listed because the shipped plugin skill maps `/tribe rename` to it.
    expect(OPTIONAL_TOOL_NAMES).toEqual([
      "retro",
      "debug",
      "repair",
      "filter",
      "lifecycle.publish",
      "health.publish",
      "lifecycle",
    ])
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
    ])
    const everything = toolListForDeliveryCapability(undefined, { includeOptional: true })
    expect(everything.map((tool) => tool.name)).toEqual(TRIBE_COMMAND_DESCRIPTORS.map((d) => d.mcp.name))
    expect(optionalToolsEnabled({})).toBe(false)
    expect(optionalToolsEnabled({ [TRIBE_MCP_OPTIONAL_TOOLS_ENV]: "1" })).toBe(true)
    expect(optionalToolsEnabled({ [TRIBE_MCP_OPTIONAL_TOOLS_ENV]: "true" })).toBe(false)
  })

  it("keeps the default list's model-visible text inside its budget (29143)", () => {
    // Before 29143 the default list weighed 17,023 model-visible bytes (send alone 4,864); the long guidance now
    // lives in the /tribe skill, read on demand instead of every turn.
    // Measured at this change: 8,887 in total, send 3,454 (its 14 properties carry three enums and two oneOf shapes).
    const sizes = Object.fromEntries(TOOLS_LIST.map((tool) => [tool.name, modelVisibleBytes(tool)]))
    const total = Object.values(sizes).reduce((sum, bytes) => sum + bytes, 0)
    expect(total, JSON.stringify(sizes)).toBeLessThanOrEqual(9_000)
    for (const [name, bytes] of Object.entries(sizes)) expect(bytes, name).toBeLessThanOrEqual(3_600)
  })
})
