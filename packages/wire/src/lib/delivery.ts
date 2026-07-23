export type TribeDelivery = "push" | "pull"
export type TribePullTransport = "mcp" | "cli" | "host-stream"
export type TribeIdleStrategy = "channel" | "host-stream" | "cli-inbox-wait"

export type TribeDeliveryCapability = {
  readonly delivery: TribeDelivery
  readonly channel: boolean
  readonly pullTransport: TribePullTransport | null
  readonly idleStrategy: TribeIdleStrategy
  readonly summary: string
  readonly command?: string
  readonly mcpTool?: string
}

export const DEFAULT_TRIBE_DELIVERY_CAPABILITY: TribeDeliveryCapability = Object.freeze({
  delivery: "pull",
  channel: false,
  pullTransport: "mcp",
  idleStrategy: "cli-inbox-wait",
  summary: "delivery=pull; pullTransport=mcp; use `tribe inbox-wait` for idle waits, then drain/reply through MCP",
  command: "tribe inbox-wait --session <name> --timeout <duration>",
  mcpTool: "inbox.wait",
})

export function resolveJoinDelivery(opts: {
  readonly adapterDelivery: TribeDelivery
  readonly requestedDelivery: unknown
  readonly allowRequestedDelivery: boolean
}): TribeDelivery {
  if (opts.allowRequestedDelivery && (opts.requestedDelivery === "push" || opts.requestedDelivery === "pull")) {
    return opts.requestedDelivery
  }
  return opts.adapterDelivery
}

export function resolvePullTransport(value: unknown): TribePullTransport {
  if (value === "cli") return "cli"
  if (value === "host-stream" || value === "stream" || value === "channel") return "host-stream"
  return "mcp"
}

export function resolveDeliveryCapability(opts: {
  readonly delivery: TribeDelivery
  readonly channel: boolean
  readonly pullTransport?: unknown
}): TribeDeliveryCapability {
  if (opts.delivery === "push" && opts.channel) {
    return {
      delivery: "push",
      channel: true,
      pullTransport: null,
      idleStrategy: "channel",
      summary: "delivery=push; idleStrategy=channel; messages arrive as channel notifications; do not poll",
    }
  }

  const pullTransport = resolvePullTransport(opts.pullTransport)
  if (pullTransport === "cli") {
    return {
      delivery: "pull",
      channel: false,
      pullTransport,
      idleStrategy: "cli-inbox-wait",
      summary: "delivery=pull; pullTransport=cli; use `tribe inbox-wait` for idle waits, then drain/reply through MCP",
      command: "tribe inbox-wait --session <name> --timeout <duration>",
    }
  }
  if (pullTransport === "host-stream") {
    return {
      delivery: "pull",
      channel: false,
      pullTransport,
      idleStrategy: "host-stream",
      summary: "delivery=pull; pullTransport=host-stream; host provides a Tribe stream; do not poll",
    }
  }
  return DEFAULT_TRIBE_DELIVERY_CAPABILITY
}

export function deliveryCapabilityInstruction(capability: TribeDeliveryCapability): string {
  if (capability.idleStrategy === "channel") {
    return `Delivery capability: ${capability.summary}. Use MCP tools for join, send, fetch snapshots, pending, health, and lifecycle.`
  }
  if (capability.idleStrategy === "host-stream") {
    return `Delivery capability: ${capability.summary}. Use the host stream for idle delivery; use MCP tools for join, send, fetch snapshots, pending, health, and lifecycle.`
  }
  return `Delivery capability: ${capability.summary}. Use one max-window CLI wait and let it return on actionable inbox activity (type=request/query/assign/verdict), an explicitly enabled validated correlated response/status, or timeout; do not simulate long-polling with repeated short waits. MCP remains the authority for join, fetch, send, pending, health, and lifecycle.`
}
