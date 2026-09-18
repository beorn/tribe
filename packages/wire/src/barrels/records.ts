/**
 * tribe-wire/records — the shared-fact sub-barrel.
 *
 * The record SHAPES the daemon, the CLI and the MCP surface must agree on:
 * ball outcomes, incident identity, join delivery, inbox-wait options, command
 * descriptors, runtime id and reaper-exempt markers. Parsers and tables, not
 * transport.
 *
 * Closure is 7 files and it deliberately does NOT reach launch-environment or
 * client. That is the point: a consumer of these facts should not become a
 * graph dependent of the daemon client (24965; measured in 24905, where every
 * tribe-wire file selected the same ~785 test files because the root barrel
 * made the package atomic to `vitest related`).
 */

// Pending-ball deadline and settlement replay facts. The daemon and wire reports
// share this parser so malformed evidence cannot mean different things on
// different read surfaces.
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
} from "../lib/ball-outcome.ts"

// One-ball-per-incident identity, shared by the CLI (which parses the
// `--incident` key) and the daemon (which keys the ball on it).
export {
  INCIDENT_KEY_SEPARATOR,
  incidentKey,
  isIncidentKey,
  parseIncidentKey,
  type IncidentIdentity,
} from "../lib/incident.ts"

// Join delivery resolution (require-join-before-push contract).
export { resolveJoinDelivery } from "../lib/delivery.ts"

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
} from "../lib/inbox-wait-options.ts"
export {
  DEFAULT_INBOX_WAIT_SESSION,
  DEFAULT_INBOX_WAIT_TIMEOUT_MS,
  DEFAULT_MCP_INBOX_WAIT_TIMEOUT_MS,
  MAX_INBOX_WAIT_TIMEOUT_MS,
  MCP_INBOX_WAIT_HOST_CEILING_MS,
  MCP_INBOX_WAIT_HOST_CEILING_SOURCE,
  deriveInboxWaitCallTimeoutMs,
  inboxWaitHostCutResult,
  parseInboxWaitTimeoutMs,
  resolveInboxWaitOptions,
} from "../lib/inbox-wait-options.ts"

// Command descriptors — source of truth for MCP/CLI/help/future UI projection.
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
} from "../command-descriptors.ts"
export {
  TRIBE_COMMAND_DESCRIPTORS,
  TRIBE_DELIVERY_MODES,
  TRIBE_FANOUTS,
  TRIBE_MESSAGE_TYPES,
  cliArgument,
  cliOption,
  commandDescriptorByMcpName,
  visibleCliProjectionForMcp,
} from "../command-descriptors.ts"

// Runtime identity — `<version>+<sha>` for `tribe-wire --version` and daemon startup.
export { formatRuntimeId, gitShortHead, tribeWireRuntimeId, wireVersion } from "../runtime-id.ts"

// Reaper-exempt markers — exempt a PID from the health-reaper auto-kill.
export type { ReaperExemptEntry } from "../reaper-exempt.ts"
export {
  clearReaperExempt,
  isReaperExempt,
  listReaperExempt,
  reaperExemptMarkerPath,
  resolveReaperExemptDir,
  setReaperExempt,
} from "../reaper-exempt.ts"
