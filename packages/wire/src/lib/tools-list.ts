/**
 * Tribe MCP tools list - projected from the Tribe command descriptors.
 *
 * Public coordination surface is the descriptor list in
 * `src/command-descriptors.ts`. Admin and diagnostic verbs still declare
 * explicit descriptor metadata there, even when their CLI projection is hidden,
 * so MCP/CLI drift is reviewable instead of implicit.
 *
 * Every listed tool is re-read by the model on every turn, so the default list
 * carries only the verbs a seat calls (`exposure: "default"`). An
 * `exposure: "opt-in"` verb stays callable but is listed only when the adapter's
 * environment sets TRIBE_MCP_OPTIONAL_TOOLS=1.
 */

import { TRIBE_COMMAND_DESCRIPTORS, type TribeMcpTool } from "../command-descriptors.ts"
import { DEFAULT_TRIBE_DELIVERY_CAPABILITY, type TribeDeliveryCapability } from "./delivery.ts"

export const TRIBE_MCP_OPTIONAL_TOOLS_ENV = "TRIBE_MCP_OPTIONAL_TOOLS"

export function optionalToolsEnabled(env: Record<string, string | undefined>): boolean {
  return env[TRIBE_MCP_OPTIONAL_TOOLS_ENV] === "1"
}

export const OPTIONAL_TOOL_NAMES: readonly string[] = TRIBE_COMMAND_DESCRIPTORS.filter(
  (descriptor) => descriptor.exposure === "opt-in",
).map((descriptor) => descriptor.mcp.name)

function idleStrategyNote(capability: TribeDeliveryCapability): string {
  if (capability.idleStrategy === "host-stream") return "Idle delivery is the host Tribe stream; do not poll."
  if (capability.idleStrategy === "channel") return "Idle delivery is the channel; this tool is diagnostic only."
  return "Idle delivery is one max-window `tribe inbox-wait`, never repeated short waits."
}

function projectMcpTool(tool: TribeMcpTool, capability: TribeDeliveryCapability): TribeMcpTool {
  if (tool.name !== "inbox.wait") return tool
  return {
    ...tool,
    description: `${capability.summary}. ${tool.description} ${idleStrategyNote(capability)}`,
    _meta: {
      ...tool._meta,
      "tribe.deliveryCapability": capability,
    },
  }
}

export function toolListForDeliveryCapability(
  capability: TribeDeliveryCapability = DEFAULT_TRIBE_DELIVERY_CAPABILITY,
  options: { readonly includeOptional?: boolean } = {},
): TribeMcpTool[] {
  const includeOptional = options.includeOptional === true
  return TRIBE_COMMAND_DESCRIPTORS.filter((descriptor) => includeOptional || descriptor.exposure === "default").map(
    (descriptor) => projectMcpTool(descriptor.mcp, capability),
  )
}

export const TOOLS_LIST = toolListForDeliveryCapability()
