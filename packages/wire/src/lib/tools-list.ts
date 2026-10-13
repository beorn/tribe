/**
 * Tribe MCP tools list - projected from the Tribe command descriptors.
 *
 * Public coordination surface is the descriptor list in
 * `src/command-descriptors.ts`. Admin and diagnostic verbs still declare
 * explicit descriptor metadata there, even when their CLI projection is hidden,
 * so MCP/CLI drift is reviewable instead of implicit.
 *
 * Every listed tool is re-read by the model on every turn, so a daemon verb
 * the installed CLI covers and no seat calls over MCP (`mcpList: { cliOnly }`)
 * is not listed: it stays a daemon verb the adapter answers by name.
 */

import { TRIBE_COMMAND_DESCRIPTORS, type TribeMcpTool } from "../command-descriptors.ts"
import { DEFAULT_TRIBE_DELIVERY_CAPABILITY, type TribeDeliveryCapability } from "./delivery.ts"

/** MCP verbs the installed CLI covers instead of tools/list: MCP name → CLI spelling. */
export const CLI_ONLY_TOOLS: ReadonlyMap<string, string> = new Map(
  TRIBE_COMMAND_DESCRIPTORS.flatMap((descriptor) =>
    descriptor.mcpList === "listed" ? [] : [[descriptor.mcp.name, descriptor.mcpList.cliOnly] as const],
  ),
)

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
): TribeMcpTool[] {
  return TRIBE_COMMAND_DESCRIPTORS.filter((descriptor) => descriptor.mcpList === "listed").map((descriptor) =>
    projectMcpTool(descriptor.mcp, capability),
  )
}

export const TOOLS_LIST = toolListForDeliveryCapability()
