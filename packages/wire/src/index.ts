/**
 * tribe-wire
 *
 * Tribe client library — Unix-socket IPC primitives, JSON-RPC 2.0 wire
 * protocol, line parser, daemon client, auto-start, reconnection,
 * deadline-bounded call, and composition primitives (pipe, Scope, tool
 * registry).
 *
 * THIS ROOT BARREL IS FOR `vendor/tribe`'s OWN packages and tests. Outside it,
 * import the narrowest sub-barrel instead — `tribe-wire/launch-environment`,
 * `tribe-wire/client`, `tribe-wire/trust` or `tribe-wire/records` — because one
 * import of this file makes the consumer a graph dependent of all 30 modules.
 * Measured in 24905: every file in this package selected the same ~785 test
 * files, so the package was atomic to `vitest related`. An oxlint
 * `no-restricted-imports` entry enforces it (24965).
 */

// JSON-RPC wire protocol
export type { JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./rpc.ts"
export { isNotification, isRequest, isResponse, makeError, makeNotification, makeRequest, makeResponse } from "./rpc.ts"

// Line-delimited JSON parser
export { createLineParser } from "./parser.ts"

// Daemon client
export type {
  ConnectOrStartOpts,
  ConnectToDaemonOpts,
  DaemonCallOpts,
  DaemonClient,
  ReconnectingClientOpts,
  StandaloneDaemonSupervisorOpts,
} from "./barrels/client.ts"
export {
  connectOrStart,
  connectToDaemon,
  createReconnectingClient,
  isSocketAlive,
  spawnStandaloneDaemonSupervisor,
} from "./barrels/client.ts"

// Deadline-bounded call (hook-friendly)
export type { DaemonCallOutcome, WithDaemonCallOpts } from "./barrels/client.ts"
export { withDaemonCall } from "./barrels/client.ts"

// Socket path discovery
export { resolvePeerSocketPath, resolveSocketPath } from "./barrels/client.ts"

// Process-boundary projection for a neutral launchId. Tribe owns its private
// environment representation; launchers pass only the structural value.
export type { TribeLaunchEnvironment } from "./launch-environment.ts"
export {
  projectTribeLaunchEnvironment,
  readTribeLaunchId,
  tribeLaunchEnvironmentNames,
  tribeSessionIdentityEnvironmentNames,
  withTribeLaunchEnvironment,
} from "./launch-environment.ts"

// Reaper-exempt markers — exempt a PID from the health-reaper auto-kill (gap 1)
export type { ReaperExemptEntry } from "./barrels/records.ts"
export {
  clearReaperExempt,
  isReaperExempt,
  listReaperExempt,
  reaperExemptMarkerPath,
  resolveReaperExemptDir,
  setReaperExempt,
} from "./barrels/records.ts"

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
export { resolveJoinDelivery } from "./barrels/records.ts"

// Pending-ball deadline and settlement replay facts. The daemon and wire
// reports share this parser so malformed evidence cannot mean different things
// on different read surfaces.
export {
  BALL_SETTLEMENT_REASONS,
  NON_REPLY_BALL_SETTLEMENT_REASONS,
  parseBallOutcomeFact,
  type BallDeadlineFact,
  type BallDeadlineObservationPayload,
  type BallFactEvidence,
  type BallOutcomeFactRow,
  type BallSettlementFact,
  type BallSettlementReason,
} from "./barrels/records.ts"

// One-ball-per-incident identity, shared by the CLI (which parses the
// `--incident` key) and the daemon (which keys the ball on it). One
// definition, so the wire and the tracker cannot disagree about what a
// well-formed identity is.
export {
  incidentKey,
  parseIncidentKey,
  isIncidentKey,
  INCIDENT_KEY_SEPARATOR,
  type IncidentIdentity,
} from "./barrels/records.ts"

// Inbox-wait option parsing shared by CLI and MCP/raw daemon call paths.
export type {
  InboxWaitAttention,
  InboxWaitHostCeilingSource,
  InboxWaitHostCutResult,
  InboxWaitOptions,
  InboxWaitOptionSource,
  InboxWaitResult,
  InboxWaitTerminalStatus,
  InboxWaitToolResult,
} from "./barrels/records.ts"
export {
  DEFAULT_INBOX_WAIT_SESSION,
  DEFAULT_INBOX_WAIT_TIMEOUT_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  DEFAULT_MCP_INBOX_WAIT_TIMEOUT_MS,
  MAX_INBOX_WAIT_TIMEOUT_MS,
  MCP_INBOX_WAIT_HOST_CEILING_MS,
  MCP_INBOX_WAIT_HOST_CEILING_SOURCE,
  deriveInboxWaitCallTimeoutMs,
  inboxWaitHostCutResult,
  parseInboxWaitTimeoutMs,
  resolveInboxWaitOptions,
  resolveWaitOptions,
} from "./barrels/records.ts"

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
} from "./barrels/records.ts"
export {
  TRIBE_COMMAND_DESCRIPTORS,
  TRIBE_DELIVERY_MODES,
  TRIBE_FANOUTS,
  TRIBE_MESSAGE_TYPES,
  cliArgument,
  cliOption,
  commandDescriptorByMcpName,
  visibleCliProjectionForMcp,
} from "./barrels/records.ts"

// Runtime identity — `<version>+<sha>` for `tribe-wire --version` + daemon startup
// (@km/infra/20359, vendor-local; mirrors code-pin's running-code visibility).
export { formatRuntimeId, gitShortHead, tribeWireRuntimeId, wireVersion } from "./barrels/records.ts"
export { deriveTribePersonaLaunchIdentity, type TribePersonaLaunchIdentity } from "./lib/persona-launch-identity.ts"

export { connectTribeLaunch } from "./barrels/client.ts"
export type { TribeLaunchRequest, TribeLaunchConnection, TribeLaunchDeps } from "./barrels/client.ts"

// Convenient reply and taking resolution (bead 25028)
export { deriveFirstLineSummary, resolveRequestSender } from "./cli/send.ts"
