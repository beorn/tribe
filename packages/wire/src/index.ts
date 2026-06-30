/**
 * tribe-wire
 *
 * Tribe client library — Unix-socket IPC primitives, JSON-RPC 2.0 wire
 * protocol, line parser, daemon client, auto-start, reconnection,
 * deadline-bounded call, and composition primitives (pipe, Scope, tool
 * registry).
 *
 * Consumers (tribe daemon, lore plugin, MCP proxy, agent shells) import
 * from here instead of duplicating the wire protocol per package.
 */

// JSON-RPC wire protocol
export type { JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./rpc.ts"
export { isNotification, isRequest, isResponse, makeError, makeNotification, makeRequest, makeResponse } from "./rpc.ts"

// Line-delimited JSON parser
export { createLineParser } from "./parser.ts"

// Daemon client
export type { ConnectOrStartOpts, ConnectToDaemonOpts, DaemonClient, ReconnectingClientOpts } from "./client.ts"
export { connectOrStart, connectToDaemon, createReconnectingClient, isSocketAlive } from "./client.ts"

// Deadline-bounded call (hook-friendly)
export type { DaemonCallOutcome, WithDaemonCallOpts } from "./util.ts"
export { withDaemonCall } from "./util.ts"

// Socket path discovery
export { resolvePeerSocketPath, resolveSocketPath } from "./paths.ts"

// Reaper-exempt markers — exempt a PID from the health-reaper auto-kill (gap 1)
export type { ReaperExemptEntry } from "./reaper-exempt.ts"
export {
  clearReaperExempt,
  isReaperExempt,
  listReaperExempt,
  reaperExemptMarkerPath,
  resolveReaperExemptDir,
  setReaperExempt,
} from "./reaper-exempt.ts"

// Topic trust registry
export type { SessionRoster, SessionRosterEntry, TopicGlob, TrustTier } from "./trust.ts"
export {
  TRUST_TIERS,
  isRegisteredTrustTopic,
  registeredTrustTierForTopic,
  senderMayUseRegisteredTrustTopic,
  trustTierFor,
  trustTierForTopic,
} from "./trust.ts"

// Composition — pipe + Scope + tool registry. See `hub/composition.md`.
export type { Plugin, Tool, ToolContext, ToolHandler, ToolRegistry, WithTools } from "./composition/index.ts"
export { Scope, createScope, disposable, pipe, withTool, withTools } from "./composition/index.ts"

// HTTP MCP adapter — local loopback bridge (Silvercode SSH/AgentProxy route).
export type { StartTribeHttpMcpServerOptions, TribeHttpMcpServer } from "./http-adapter.ts"
export { startTribeHttpMcpServer } from "./http-adapter.ts"

// Join delivery resolution (require-join-before-push contract, c6071f3 + 333193c).
export { resolveJoinDelivery } from "./lib/delivery.ts"

// Inbox-wait option parsing shared by CLI and MCP/raw daemon call paths.
export type { InboxWaitOptions, InboxWaitOptionSource } from "./lib/inbox-wait-options.ts"
export {
  DEFAULT_INBOX_WAIT_SESSION,
  DEFAULT_INBOX_WAIT_TIMEOUT_MS,
  parseInboxWaitTimeoutMs,
  resolveInboxWaitOptions,
} from "./lib/inbox-wait-options.ts"

// Command descriptors - source of truth for MCP/CLI/help/future UI projection.
export type {
  JsonObject,
  JsonSchemaObject,
  TribeCliArgument,
  TribeCliOption,
  TribeCliProjection,
  TribeCommandDescriptor,
  TribeFanout,
  TribeMcpTool,
  TribeMessageType,
} from "./command-descriptors.ts"
export {
  TRIBE_COMMAND_DESCRIPTORS,
  TRIBE_DELIVERY_MODES,
  TRIBE_FANOUTS,
  TRIBE_MESSAGE_TYPES,
  cliArgument,
  cliOption,
  commandDescriptorByMcpName,
  visibleCliProjectionForMcp,
} from "./command-descriptors.ts"

// Runtime identity — `<version>+<sha>` for `tribe-wire --version` + daemon startup
// (@km/infra/20359, vendor-local; mirrors code-pin's running-code visibility).
export { formatRuntimeId, gitShortHead, tribeWireRuntimeId, wireVersion } from "./runtime-id.ts"
