/**
 * HTTP MCP adapter — local loopback bridge from MCP Streamable HTTP to the
 * tribe daemon Unix-socket protocol.
 *
 * Silvercode uses this for SSH-hosted ACP agents: the agent sees a remote
 * `http://127.0.0.1:<port>/mcp` MCP server, while SSH forwards that remote
 * loopback port back to this local process. No tribe socket, daemon, bunx, or
 * npx needs to exist on the SSH host.
 */

import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { createHash, randomUUID } from "node:crypto"
import { toolListForDeliveryCapability } from "./lib/tools-list.ts"
import { callTribeTool } from "./lib/tool-daemon-call.ts"
import { initialFilterModeFromEnv } from "./lib/filter-mode.ts"
import { resolveSocketPath, createReconnectingClient, TRIBE_PROTOCOL_VERSION, type DaemonClient } from "./lib/socket.ts"
import {
  deliveryCapabilityInstruction,
  resolveDeliveryCapability,
  resolveJoinDelivery,
  type TribeDelivery,
  type TribeDeliveryCapability,
  type TribePullTransport,
} from "./lib/delivery.ts"

export type TribeHttpMcpServer = {
  readonly port: number
  readonly url: string
  close(): void
}

export type StartTribeHttpMcpServerOptions = {
  readonly port?: number
  readonly socketPath?: string
  readonly name?: string
  readonly role?: string
  readonly domains?: readonly string[]
  readonly delivery?: TribeDelivery
  readonly pullTransport?: TribePullTransport
  readonly project?: string
  readonly projectName?: string
  readonly projectId?: string
  readonly requireJoin?: boolean
  /** Caller-minted host launch identity. Blank values preserve legacy registration. */
  readonly launchId?: string
}

export async function startTribeHttpMcpServer(opts: StartTribeHttpMcpServerOptions = {}): Promise<TribeHttpMcpServer> {
  const socketPath = resolveSocketPath(opts.socketPath)
  const initialFilterMode = initialFilterModeFromEnv(process.env.TRIBE_FILTER_MODE)
  const requireJoin = opts.requireJoin !== false
  const initialName = opts.name?.trim() || undefined
  const launchId = opts.launchId?.trim() || undefined
  const deliveryCapability = resolveDeliveryCapability({
    delivery: opts.delivery ?? "pull",
    channel: false,
    pullTransport: opts.pullTransport,
  })
  const sessionId = randomUUID()
  let myName = "pending"
  let myRole = opts.role ?? "member"
  const identityToken = createHash("sha256")
    .update(`${sessionId}|${opts.project ?? process.cwd()}|${myRole}`)
    .digest("hex")
    .slice(0, 16)

  const daemon = await createReconnectingClient({
    socketPath,
    maxAttempts: 30,
    noSpawn: true,
    async onConnect(client) {
      const registerName = myName !== "pending" ? myName : !requireJoin ? initialName : undefined
      const reg = (await client.call("register", {
        ...(registerName !== undefined ? { name: registerName } : {}),
        role: myRole,
        domains: [...(opts.domains ?? [])],
        project: opts.project ?? process.cwd(),
        projectName: opts.projectName ?? process.cwd().split("/").pop() ?? "silvercode",
        projectId: opts.projectId,
        protocolVersion: TRIBE_PROTOCOL_VERSION,
        peerSocket: null,
        pid: process.pid,
        identityToken,
        ...(launchId !== undefined ? { launchId, launchParentPid: process.pid } : {}),
        delivery: requireJoin ? "pull" : deliveryCapability.delivery,
        ...(initialFilterMode === undefined ? {} : { filterMode: initialFilterMode }),
      })) as { name?: string; role?: string }
      if (reg.name) myName = reg.name
      if (reg.role) myRole = reg.role
    },
  })

  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    async fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname === "/health") return Response.json({ ok: true, name: myName })
      if (url.pathname !== "/mcp") return new Response("not found", { status: 404 })

      // Tribe preflights MCP inbox.wait against the measured host ceiling.
      // Disable Bun's separate per-request idle timeout so it cannot create a
      // second, ambiguous cutoff below the typed host_cut/wait contract.
      server.timeout(req, 0)

      const mcp = createMcpServer({
        daemon,
        identityToken,
        defaultDelivery: deliveryCapability.delivery,
        deliveryCapability,
        getName: () => myName,
        setName: (name) => {
          myName = name
        },
        setRole: (role) => {
          myRole = role
        },
      })
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      await mcp.connect(transport)
      const response = await transport.handleRequest(req)
      await mcp.close()
      return response
    },
  })

  const port = http.port
  if (port === undefined) throw new Error("tribe HTTP MCP bridge failed to bind a loopback port")

  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    close() {
      http.stop(true)
      daemon.close()
    },
  }
}

function createMcpServer(opts: {
  readonly daemon: DaemonClient
  readonly identityToken: string
  readonly defaultDelivery: TribeDelivery
  readonly deliveryCapability: TribeDeliveryCapability
  readonly getName: () => string
  readonly setName: (name: string) => void
  readonly setRole: (role: string) => void
}): McpServer {
  const toolsList = toolListForDeliveryCapability(opts.deliveryCapability)
  const mcp = new McpServer(
    { name: "tribe", version: "0.14.1" },
    {
      capabilities: { tools: {} },
      instructions: `Tribe coordination is available through MCP tools. Call tribe.join(name, delivery) before relying on tribe notifications or inbox routing. ${deliveryCapabilityInstruction(opts.deliveryCapability)}`,
    },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsList }))
  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: toolArgs } = req.params
    const a = (toolArgs ?? {}) as Record<string, unknown>
    const payload =
      name === "join"
        ? {
            ...a,
            // The HTTP bridge has no Claude channel reader. The bridge host may
            // choose its adapter delivery, but a model call cannot upgrade it.
            delivery: resolveJoinDelivery({
              adapterDelivery: opts.defaultDelivery,
              requestedDelivery: a.delivery,
              allowRequestedDelivery: false,
            }),
            identity_token: opts.identityToken,
          }
        : a
    try {
      const result = await callTribeTool(opts.daemon, name, payload)
      if (name === "join" || name === "rename") {
        const r = result as { content?: Array<{ text?: string }> }
        try {
          const data = JSON.parse(r.content?.[0]?.text ?? "{}") as { name?: string; role?: string }
          if (data.name) opts.setName(data.name)
          if (data.role) opts.setRole(data.role)
        } catch {
          /* ignore malformed daemon response */
        }
      }
      return result as { content: Array<{ type: string; text: string }> }
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }] }
    }
  })

  return mcp
}
