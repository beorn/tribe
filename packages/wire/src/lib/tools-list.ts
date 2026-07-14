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
  mcpInboxWaitRefusal,
  type TribeDeliveryCapability,
} from "./delivery.ts"

function inboxWaitDescription(capability: TribeDeliveryCapability): string {
  const base =
    "Long-poll the actionable inbox for a session until a request/query/assign/verdict direct message arrives or the timeout elapses. Direct notify/status/response rows are inbox-visible but do not wake this wait. Defaults to the caller's session."
  const refusal = mcpInboxWaitRefusal(capability, "<name>")
  if (refusal) return `${deliveryCapabilityInstruction(capability)} ${refusal}`
  return `${deliveryCapabilityInstruction(capability)} ${base}`
}

function projectMcpTool(tool: TribeMcpTool, capability: TribeDeliveryCapability): TribeMcpTool {
  if (tool.name !== "inbox.wait") return tool
  return {
    ...tool,
    description: inboxWaitDescription(capability),
    _meta: {
      ...(tool._meta ?? {}),
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
