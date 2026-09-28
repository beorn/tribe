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
import { adapterLaunchIdentity } from "./lib/adapter-launch-identity.ts"
import { readIdentityTokenFromEnvironment } from "./lib/identity-token.ts"
import { isExplicitTribePersonaName } from "./lib/persona-name.ts"
import {
  resolveSocketPath,
  createReconnectingClient,
  TRIBE_PROTOCOL_VERSION,
  TRIBE_SUPPORTED_PROTOCOL_VERSIONS,
  type DaemonClient,
} from "./lib/socket.ts"
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
  /** @deprecated Remove this option: identity comes from the inherited launch token. Nonblank values refuse.
   * Remove this transitional declaration after the first wire release containing that refusal. */
  readonly launchId?: string
}

export async function startTribeHttpMcpServer(opts: StartTribeHttpMcpServerOptions = {}): Promise<TribeHttpMcpServer> {
  // oxlint-disable-next-line typescript/no-deprecated -- one-release refusal of the published legacy option, not a consumer
  if (opts.launchId?.trim()) {
    throw new Error(
      "tribe HTTP adapter launchId is obsolete: remove the launchId option; identity comes from the launch token",
    )
  }
  const socketPath = resolveSocketPath(opts.socketPath)
  const initialFilterMode = initialFilterModeFromEnv(process.env.TRIBE_FILTER_MODE)
  const requireJoin = opts.requireJoin !== false
  const initialName = opts.name?.trim() || undefined
  // A named persona binds on the first registration. An unnamed child may inherit the environment,
  // but it never presents that host's mailbox authority (the stdio adapter's 25074 3b rule).
  const personaLaunch = initialName !== undefined && isExplicitTribePersonaName(initialName)
  const launchToken = personaLaunch ? readIdentityTokenFromEnvironment(process.env) : null
  const launchRead = personaLaunch
    ? adapterLaunchIdentity({ env: process.env, launchName: initialName, resolveParentPid: () => process.pid })
    : { identity: null, malformedToken: null }
  if (launchRead.malformedToken !== null) {
    process.stderr.write(`tribe HTTP adapter: ${launchRead.malformedToken}; the daemon's verifier judges it\n`)
  }
  if (personaLaunch && launchToken === null) {
    process.stderr.write(
      `tribe HTTP adapter ${initialName}: persona without launch token: claimed; launch through hab to read the managed mailbox\n`,
    )
  }
  const deliveryCapability = resolveDeliveryCapability({
    delivery: opts.delivery ?? "pull",
    channel: false,
    pullTransport: opts.pullTransport,
  })
  const sessionId = randomUUID()
  let myName = "pending"
  let myRole = opts.role ?? "member"
  // Correlation handle for adapter join calls; never mailbox authority.
  const identityToken = createHash("sha256")
    .update(`${sessionId}|${opts.project ?? process.cwd()}|${myRole}`)
    .digest("hex")
    .slice(0, 16)

  const daemon = await createReconnectingClient({
    socketPath,
    maxAttempts: 30,
    noSpawn: true,
    async onConnect(client) {
      // Re-present the original persona with its token; the daemon reapplies persisted runtime renames.
      const registerName = personaLaunch
        ? initialName
        : myName !== "pending"
          ? myName
          : !requireJoin
            ? initialName
            : undefined
      const reg = (await client.call("register", {
        ...(registerName !== undefined ? { name: registerName } : {}),
        role: myRole,
        domains: [...(opts.domains ?? [])],
        project: opts.project ?? process.cwd(),
        projectName: opts.projectName ?? process.cwd().split("/").pop() ?? "silvercode",
        projectId: opts.projectId,
        protocolVersion: TRIBE_PROTOCOL_VERSION,
        supportedProtocolVersions: [...TRIBE_SUPPORTED_PROTOCOL_VERSIONS],
        peerSocket: null,
        pid: process.pid,
        identityToken,
        ...(launchToken === null ? {} : { idToken: launchToken }),
        ...(launchRead.identity !== null
          ? { launchId: launchRead.identity.id, launchParentPid: launchRead.identity.parentPid }
          : launchToken !== null
            ? { launchParentPid: process.pid }
            : {}),
        delivery: !personaLaunch && requireJoin ? "pull" : deliveryCapability.delivery,
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
        requireJoin: !personaLaunch && requireJoin,
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
      void http.stop(true)
      daemon.close()
    },
  }
}

function createMcpServer(opts: {
  readonly daemon: DaemonClient
  readonly identityToken: string
  readonly defaultDelivery: TribeDelivery
  readonly deliveryCapability: TribeDeliveryCapability
  readonly requireJoin: boolean
  readonly getName: () => string
  readonly setName: (name: string) => void
  readonly setRole: (role: string) => void
  // oxlint-disable-next-line typescript/no-deprecated -- the adapter is built on the low-level Server, as stdio-adapter is
}): McpServer {
  const toolsList = toolListForDeliveryCapability(opts.deliveryCapability)
  // oxlint-disable-next-line typescript/no-deprecated -- the adapter is built on the low-level Server (see its return type)
  const mcp = new McpServer(
    { name: "tribe", version: "0.14.1" },
    {
      capabilities: { tools: {} },
      instructions: `Tribe coordination is available through MCP tools. ${
        opts.requireJoin
          ? "Call tribe.join(name, delivery) before relying on tribe notifications or inbox routing."
          : `Already registered as ${opts.getName()}; no join is required. Use this registered name for your mailbox.`
      } ${deliveryCapabilityInstruction(opts.deliveryCapability)}`,
    },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolsList }))
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
