/**
 * Tribe MCP tools list - projected from the Tribe command descriptors.
 *
 * Public coordination surface is the descriptor list in
 * `src/command-descriptors.ts`. Admin and diagnostic verbs still declare
 * explicit descriptor metadata there, even when their CLI projection is hidden,
 * so MCP/CLI drift is reviewable instead of implicit.
 */

import { TRIBE_COMMAND_DESCRIPTORS, type TribeMcpTool } from "../command-descriptors.ts"
import {
  DEFAULT_TRIBE_DELIVERY_CAPABILITY,
  deliveryCapabilityInstruction,
  type TribeDeliveryCapability,
} from "./delivery.ts"

function inboxWaitDescription(base: string, capability: TribeDeliveryCapability): string {
  if (capability.idleStrategy === "cli-inbox-wait") {
    return `${deliveryCapabilityInstruction(capability)} ${base} This MCP tool remains callable for short diagnostic waits, but the advertised idle wait primitive is CLI because this host may cap long-running MCP calls.`
  }
  if (capability.idleStrategy === "host-stream") {
    return `${deliveryCapabilityInstruction(capability)} ${base} This MCP tool remains callable for diagnostics, but the advertised idle wait primitive is the host Tribe stream.`
  }
  if (capability.idleStrategy === "channel") {
    return `${deliveryCapabilityInstruction(capability)} ${base} This MCP tool remains callable for diagnostics, but the advertised idle wait primitive is channel delivery.`
  }
  return `${deliveryCapabilityInstruction(capability)} ${base}`
}

function projectMcpTool(tool: TribeMcpTool, capability: TribeDeliveryCapability): TribeMcpTool {
  if (tool.name !== "inbox.wait") return tool
  return {
    ...tool,
    description: inboxWaitDescription(tool.description, capability),
    _meta: {
      ...tool._meta,
      "tribe.deliveryCapability": capability,
    },
  }
}

export function toolListForDeliveryCapability(
  capability: TribeDeliveryCapability = DEFAULT_TRIBE_DELIVERY_CAPABILITY,
): TribeMcpTool[] {
  return TRIBE_COMMAND_DESCRIPTORS.map((descriptor) => projectMcpTool(descriptor.mcp, capability))
}

export const TOOLS_LIST = toolListForDeliveryCapability()
