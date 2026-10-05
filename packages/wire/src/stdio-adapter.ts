#!/usr/bin/env bun
/**
 * Stdio Adapter — thin MCP server that bridges Claude Code's stdio MCP wire
 * to the tribe daemon's Unix-socket MCP wire.
 *
 * Per-agent transport translator: stdio ↔ daemon. No direct DB access, no
 * polling, no plugins — just MCP forwarding.
 *
 * Local dev (workspace .mcp.json):
 *   `bun packages/wire/src/stdio-adapter.ts --name chief --role chief`
 * Published (plugin runtime): the plugin's `server.ts` calls
 *   `import { runStdioAdapter } from "tribe-wire/stdio"`
 * which transitively imports this file and invokes its module-level bootstrap.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import {
  parseTribeArgs,
  parseSessionDomains,
  resolveClaudeSessionId,
  resolveClaudeSessionName,
  resolveProjectName,
  resolveProjectId,
} from "./lib/config.ts"
import {
  resolveSocketPath,
  connectToDaemon,
  createReconnectingClient,
  isSupportedProtocolVersion,
  negotiateProtocolVersion,
  protocolVersionAdvertisement,
  protocolVersionsFromMismatch,
  reconnectRegistrationJitterMs,
  TRIBE_PROTOCOL_VERSION,
  TRIBE_SUPPORTED_PROTOCOL_VERSIONS,
  type DaemonClient,
} from "./lib/socket.ts"
import { shouldAttemptDaemonRecovery } from "./lib/daemon-recovery.ts"
import { createReconnectWatchdog } from "./lib/reconnect-watchdog.ts"
import { resolveCheckoutCodeIdentity } from "./lib/code-identity.ts"
import { pacedReexec, type ReloadDaemonView, type ReloadPeers } from "./lib/reload-pacing.ts"
import { createHash } from "node:crypto"
import { constants as osConstants } from "node:os"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { readIdentityTokenFromEnvironment } from "./lib/identity-token.ts"
import { isIdentityTokenMissingRefusal } from "./lib/identity-token-missing-refusal.ts"
import { TRIBE_PLUGIN_PERSONA_REFUSAL_EXIT_CODE_ENV } from "./lib/session-identity-env.ts"
import { toolListForDeliveryCapability } from "./lib/tools-list.ts"
import { callTribeTool } from "./lib/tool-daemon-call.ts"
import { initialFilterModeFromEnv } from "./lib/filter-mode.ts"
import { isExplicitTribePersonaName, isTribeNameShape, TRIBE_NAME_SHAPE_ERROR } from "./lib/persona-name.ts"
import { createLogger, setSuppressConsole } from "loggily"
import { createTimers } from "./timers.ts"
import { defangModelInput } from "./lib/defang.ts"
import {
  createConnectReplayGate,
  createDeliveryCounter,
  createForwardedAttentionTracker,
  decidePendingBallSummary,
  MAX_REPLAY_EVENTS,
  replayEnvelopeMeta,
  selectReplayEvents,
  type PendingBallSummaryState,
} from "./lib/replay-cap.ts"
import {
  DELIVERY_LEDGER_WINDOW_MS,
  deliveryLedgerPath,
  loadDeliveryLedger,
  openDeliveryLedgerWindow,
  saveDeliveryLedger,
  type DeliveryLedgerState,
} from "./lib/delivery-ledger.ts"
import { evaluateCwdPolicy, probeCwd, readCwdPolicyFromEnv, type CwdEvaluation } from "./lib/cwd-guardrail.ts"
import {
  deliveryCapabilityInstruction,
  resolveDeliveryCapability,
  resolveJoinDelivery,
  validateDeliveryAcknowledgement,
  type TribeDeliveryAcknowledgement,
  type TribeDeliveryCapability,
} from "./lib/delivery.ts"
import { adapterLaunchIdentity } from "./lib/adapter-launch-identity.ts"
import {
  TRIBE_PLUGIN_ADAPTER_CHILD_ENV,
  TRIBE_PLUGIN_ADAPTER_EXIT_RECORD_ENV,
  TRIBE_PLUGIN_PROVIDER_PARENT_PID_ENV,
  TRIBE_PLUGIN_REEXEC_EXIT_CODE_ENV,
  TRIBE_PLUGIN_RESUME_JOINED_ENV,
  TRIBE_TAKEOVER_ENV,
} from "./launch-environment.ts"

// stdout IS the MCP wire — a single non-JSON line (a loggily INFO banner)
// poisons the host's JSON-RPC parser and the session silently loses its
// tribe tools. Console suppression is therefore UNCONDITIONAL here
// (deliberate divergence from bearly's DEBUG_LOG-gated shape, which only
// survives there because the bearly plugin wrapper always sets DEBUG_LOG).
// Logs flow to LOG_FILE/DEBUG_LOG when set; otherwise they are dropped.
setSuppressConsole(true)
if (process.env.DEBUG_LOG) process.env.LOG_FILE ??= process.env.DEBUG_LOG

const log = createLogger("tribe:stdio-adapter")

const proxyAc = new AbortController()
const timers = createTimers(proxyAc.signal)

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const args = parseTribeArgs()
const SOCKET_PATH = resolveSocketPath(args.socket)
const SESSION_DOMAINS = parseSessionDomains(args)
const CLAUDE_SESSION_ID = resolveClaudeSessionId()
const CLAUDE_SESSION_NAME = resolveClaudeSessionName()
// MCP-only clients without a Claude channel reader (codex, gemini, hermes,
// etc.) should run with TRIBE_DELIVERY=pull so the daemon queues events for
// tribe.fetch instead of fanning them out down a Claude-specific notification
// channel.
const DELIVERY = process.env.TRIBE_DELIVERY === "pull" ? "pull" : "push"
const CLAUDE_CHANNEL_ENABLED = DELIVERY === "push"
const PULL_TRANSPORT = process.env.TRIBE_PULL_TRANSPORT ?? process.env.TRIBE_WAIT_TRANSPORT
const DELIVERY_CAPABILITY = resolveDeliveryCapability({
  delivery: DELIVERY,
  channel: CLAUDE_CHANNEL_ENABLED,
  pullTransport: PULL_TRANSPORT,
})
// What a session that has not joined actually gets: the daemon holds it as pull
// (see currentDeliveryCapability), so that is what its model is told.
const UNJOINED_DELIVERY_CAPABILITY = CLAUDE_CHANNEL_ENABLED
  ? resolveDeliveryCapability({ delivery: "pull", channel: false, pullTransport: PULL_TRANSPORT })
  : DELIVERY_CAPABILITY

// A launch controller may declare one existing daemon filter as session
// configuration. The adapter forwards it on register so the session is never
// push-eligible under the default mode, even for one event-loop turn.
const INITIAL_FILTER_MODE = initialFilterModeFromEnv(process.env.TRIBE_FILTER_MODE)
// c6071f3: a connected MCP adapter is NOT a push-delivered tribe member until
// the model explicitly calls tribe.join. Keep pre-join delivery pull-only, but
// seed explicit @personas at register time so configured Codex identities
// (`TRIBE_NAME=@chief`, `@agent/N`, etc.) never surface as unknown-*.
const REQUIRE_EXPLICIT_JOIN = process.env.TRIBE_REQUIRE_JOIN !== "0"
const LAUNCH_NAME = typeof args.name === "string" && args.name.trim().length > 0 ? args.name.trim() : undefined
// 21768 — a MALFORMED launch name is an operator error, not a hint to fall back
// on. The daemon would reject it at register/join anyway, so degrading to an
// `unknown-<rand>` placeholder only converts a fixable startup error into
// minutes of silently dropped messages. Fail at launch, naming the string.
//
// The line is malformed vs. merely sigil-less. A well-formed bare name
// (`degrade-test`) is a legitimate unidentified session: it is still not
// pre-seeded under require-join and still joins from inside, exactly as before.
// Only a name that could never be a valid tribe name is fatal.
if (LAUNCH_NAME !== undefined && !isTribeNameShape(LAUNCH_NAME)) {
  throw new Error(
    `Invalid TRIBE_NAME=${JSON.stringify(LAUNCH_NAME)}; ${TRIBE_NAME_SHAPE_ERROR} ` +
      "Refusing to register under an unaddressable unknown-<rand> placeholder.",
  )
}
const REGISTER_WITH_LAUNCH_NAME =
  LAUNCH_NAME !== undefined && (!REQUIRE_EXPLICIT_JOIN || isExplicitTribePersonaName(LAUNCH_NAME))
let joined = !REQUIRE_EXPLICIT_JOIN || process.env[TRIBE_PLUGIN_RESUME_JOINED_ENV] === "1"
let deliveryAcknowledgement: TribeDeliveryAcknowledgement = {
  acknowledged: false,
  cause: "awaiting daemon registration",
}
/**
 * Confirmed delivery follows this transport's ACK; neither configuration nor
 * a sibling's effective session push mode confirms this adapter's capability.
 */
function currentDeliveryCapability(): TribeDeliveryCapability {
  const capability =
    joined && deliveryAcknowledgement.acknowledged
      ? resolveDeliveryCapability({
          delivery: deliveryAcknowledgement.transportDelivery,
          channel: CLAUDE_CHANNEL_ENABLED,
          pullTransport: PULL_TRANSPORT,
        })
      : UNJOINED_DELIVERY_CAPABILITY
  return { ...capability, acknowledgement: deliveryAcknowledgement }
}

function deliveryAcknowledgementSummary(): string {
  return deliveryAcknowledgement.acknowledged
    ? `acknowledged transportDelivery=${deliveryAcknowledgement.transportDelivery}; session delivery=${deliveryAcknowledgement.delivery}`
    : `unacknowledged: ${deliveryAcknowledgement.cause}; delivery=pull`
}

function acceptDeliveryAcknowledgement(reply: unknown, requested: "push" | "pull"): void {
  deliveryAcknowledgement = validateDeliveryAcknowledgement(reply, requested)
  if (!deliveryAcknowledgement.acknowledged) {
    log.warn?.(`tribe delivery acknowledgement ${deliveryAcknowledgementSummary()}`)
  }
}
// 20703 — managed spawns set TRIBE_TAKEOVER=1 so an explicit-persona
// respawn can supersede a stale live holder once. The capability is consumed
// after the first successful registration; replaying it on reconnect lets two
// displaced adapters evict each other forever (21049).
const TAKEOVER = REGISTER_WITH_LAUNCH_NAME && process.env[TRIBE_TAKEOVER_ENV] === "1"
const PLUGIN_ADAPTER_CHILD = process.env[TRIBE_PLUGIN_ADAPTER_CHILD_ENV] === "1"
const PLUGIN_PROVIDER_PARENT_PID_RAW = process.env[TRIBE_PLUGIN_PROVIDER_PARENT_PID_ENV]?.trim() ?? ""
// G9 P0 row 7 — the launch's adapter-exit record, named by the supervisor that
// appends to it (plugins/claude/supervisor-exit-record.ts). Registering it lets
// tribe members name the file on this seat's row after this adapter is gone.
const ADAPTER_EXIT_RECORD = PLUGIN_ADAPTER_CHILD
  ? process.env[TRIBE_PLUGIN_ADAPTER_EXIT_RECORD_ENV]?.trim() || undefined
  : undefined

function reportSupervisedIdentity(name: string): void {
  if (!PLUGIN_ADAPTER_CHILD || !isTribeNameShape(name)) return
  process.send?.({ tribePluginIdentity: { name, joined } })
}

function resolveLaunchParentPid(): number {
  if (!PLUGIN_ADAPTER_CHILD) return process.ppid
  const providerParentPid = Number(PLUGIN_PROVIDER_PARENT_PID_RAW)
  if (!/^[1-9]\d*$/u.test(PLUGIN_PROVIDER_PARENT_PID_RAW) || !Number.isSafeInteger(providerParentPid)) {
    throw new Error(
      "tribe plugin adapter child is missing valid provider-parent provenance; restart the host session or reinstall the Tribe plugin",
    )
  }
  return providerParentPid
}

// 21049 — adapters forward a complete launcher-minted identity or nothing.
// They never mint/default the id themselves. A direct adapter uses its actual
// OS parent. A plugin-supervised adapter uses the provider parent validated by
// its stable wrapper: either the complete Hab launcher tuple or, for standalone
// plugins, the wrapper's actual OS parent. Thus child replacements preserve one
// launch owner without treating ambient adapter env as authoritative.
// 25074 3d-1: a launch-named adapter holding its token keys under the token's sid (adapter-launch-identity.ts).
const LAUNCH_READ = adapterLaunchIdentity({
  env: process.env,
  launchName: REGISTER_WITH_LAUNCH_NAME ? LAUNCH_NAME : undefined,
  resolveParentPid: resolveLaunchParentPid,
})
if (LAUNCH_READ.malformedToken !== null) {
  process.stderr.write(`tribe adapter: ${LAUNCH_READ.malformedToken}; the daemon's verifier judges it\n`)
}
const LAUNCH_IDENTITY = LAUNCH_READ.identity

// km 19442 — connect-time replay flood backstop. The wakeup→drain path is capped
// by selectReplayEvents, but a stale/old daemon that still pushes message BODIES
// as `channel` notifications bypasses that cap. This gate bounds the post-(re)connect
// `channel` burst to MAX_REPLAY_EVENTS; dropped rows stay durable + fetchable. Knobs
// exist for tests (small cap/window → deterministic burst assertions).
const CHANNEL_REPLAY_MAX = Number(process.env.TRIBE_CHANNEL_REPLAY_MAX) || undefined
const CHANNEL_REPLAY_WINDOW_MS = Number(process.env.TRIBE_CHANNEL_REPLAY_WINDOW_MS) || undefined
const connectReplayGate = createConnectReplayGate({ maxEvents: CHANNEL_REPLAY_MAX, windowMs: CHANNEL_REPLAY_WINDOW_MS })

// 27346 — the wakeup drain used to re-forward the open-ball summary line on every
// arrival. An unchanged set is now re-surfaced at most once per window. Knob exists
// for tests (small window → deterministic recurrence).
const PENDING_BALL_SUMMARY_WINDOW_MS = Number(process.env.TRIBE_PENDING_BALL_SUMMARY_WINDOW_MS) || undefined

// Worktree-isolation guardrail (km-bearly.tribe-codex-cwd-worktree-guardrail):
// standalone codex / non-launcher MCP clients inherit the user's invocation
// cwd. If that cwd is the main repo while a `<basename>-wtN` pool exists,
// warn the agent so edits don't leak into main. Evaluation is pure; the
// notification fires after MCP is up. Policy env: TRIBE_MAIN_REPO_POLICY.
const CWD_POLICY = readCwdPolicyFromEnv()
const CWD_EVAL: CwdEvaluation = evaluateCwdPolicy(CWD_POLICY, probeCwd())
if (CWD_EVAL.kind === "warn" || CWD_EVAL.kind === "refuse") {
  log.warn?.(CWD_EVAL.message)
} else {
  log.debug?.(`cwd-guardrail: ${CWD_EVAL.kind} (${CWD_EVAL.reason})`)
}

log.info?.(`Connecting to daemon at ${SOCKET_PATH}`)

let myName = "pending"
let myRole = "member"
const PROJECT_NAME = resolveProjectName()

// MCP server reference — constructed + connected to Claude Code BEFORE the
// daemon connection resolves, so the MCP `initialize` handshake is answered
// in milliseconds rather than blocked on daemon spawn/connect.
// oxlint-disable-next-line prefer-const, typescript/no-deprecated -- deferred init, assigned before use; the adapter is built on the low-level Server, and moving it to McpServer is its own change
let mcp: Server
// Daemon client — populated asynchronously by `daemonReady` (the daemon
// block below). Stays `undefined` until the background connect resolves;
// call sites either `await daemonReady` (when they need a guaranteed
// client) or use `daemon?.` (best-effort).
let daemon: DaemonClient | undefined
let registrationInFlight: Promise<unknown> | null = null
// oxlint-disable-next-line eslint(prefer-const) -- assigned in the daemon block below
let daemonReady: Promise<DaemonClient>
// Daemon-unavailable degrade ("loud but soft", km 19851): when the daemon can
// never start, the adapter stays alive as a fully functional solo session —
// MCP handshake answered, every tribe tool returns ONE clear sentence, and the
// degrade is announced exactly once (log + channel), never once per call.
let daemonDegradedReason: string | null = null

/**
 * Forward a channel notification to Claude Code.
 *
 * The `content` is defanged via `defangModelInput` before reaching the
 * MCP wire. This is the third leg of the autocatalytic-trigger fix
 * (alongside the hook-stdio muzzle in `lib/tribe/hook-dispatch.ts` and
 * the envelope-defang in `injection-envelope/src/emit.ts`):
 *
 *   - Hooks → handled by hook-dispatch muzzle.
 *   - additionalContext payloads → handled by emit.ts defang.
 *   - **Tribe channel notifications** (this path) → handled here.
 *     These travel through the MCP server's notification channel,
 *     which Claude Code wraps as `<system-reminder>A message arrived
 *     from plugin:tribe:tribe ...</system-reminder>`. Without this
 *     defang, content like `agent7 | claimed: ... last commit: <SHA>`
 *     reads as transcript-shaped to the model — same trigger surface
 *     as additionalContext but a different transport.
 *
 * `meta` is harness/tribe routing metadata (from / type / bead /
 * message_id) — not user-visible content — so it's left as-is.
 */
function sendChannel(content: string, meta: Record<string, string | undefined>): void {
  if (meta.from !== "tribe-startup" && (!joined || !currentDeliveryCapability().channel)) return
  if (!CLAUDE_CHANNEL_ENABLED) return
  if (!mcp) return // Not yet initialized
  const safeContent = defangModelInput(content)
  mcp.notification({ method: "notifications/claude/channel", params: { content: safeContent, meta } }).catch(() => {})
}

const NOTIFICATION_ONLY_MARKER = "notification-only:do-not-acknowledge-or-respond-to"

function isNotificationOnlyType(type: string): boolean {
  if (type === "session" || type === "status" || type === "delta") return true
  if (type.startsWith("chief:")) return true
  if (type.startsWith("github:")) return true
  return false
}

function markedType(type: string): string {
  return isNotificationOnlyType(type) ? `${NOTIFICATION_ONLY_MARKER}:${type}` : type
}

/** One row of a `tribe.fetch` result — the same shape for the attention
 * projection and the ambient event window. */
type TribeFetchResultRow = {
  id?: string
  type?: string
  from?: string
  content?: string
  bead?: string | null
  topic?: string | null
  ts?: string
  from_authority?: string | null
  /**
   * 27346 - the daemon sets this true when the mailbox cursor is already past
   * the row, so this presentation is a re-presentation of something the seat
   * has already been shown (the tracked branch of selectAttention keeps an
   * untaken ball visible past the cursor on purpose, 22203). Never set on an
   * ambient window row, which is new by construction.
   */
  replay?: boolean
}

type TribeFetchResult = {
  attention?: {
    actionable_unread?: TribeFetchResultRow[]
    pending_balls?: Array<{
      request_id?: string
      sender?: string
      opened_at?: string
      age_ms?: number
      message_id?: string
      fanout?: string
      summary?: string
    }>
    pending_balls_summary?: {
      total?: number
      oldest_age_ms?: number
      truncated?: boolean
      withheld?: {
        total?: number
        by_kind?: { request?: number; incident?: number }
      }
    }
  }
  events?: TribeFetchResultRow[]
}

function parseToolText<T>(result: unknown): T | null {
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text
  if (typeof text !== "string") return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Daemon connection
// ---------------------------------------------------------------------------

// Identity token — stable across Claude Code restarts in the same project
// with the same role hint. Hash of (claude_session_id, project_path, role_hint)
// → first 16 hex chars of sha256. When claude_session_id is null (some
// environments), the token still matches on project+role — weaker but safe
// (no cross-project or cross-role leakage). See km-tribe.session-identity.
const identityToken = createHash("sha256")
  .update(`${CLAUDE_SESSION_ID ?? ""}|${process.cwd()}|${args.role ?? "member"}`)
  .digest("hex")
  .slice(0, 16)
// 25074 3b — only a registration under the launch's own name presents the launch's token: an unnamed or renamed
// child inheriting it would be refused as a mismatch, where today it is served on its claimed name.
const launchIdentityToken = REGISTER_WITH_LAUNCH_NAME ? readIdentityTokenFromEnvironment(process.env) : null

const baseRegisterParams = {
  ...(REGISTER_WITH_LAUNCH_NAME ? { name: LAUNCH_NAME } : {}),
  ...(args.role ? { role: args.role } : {}),
  domains: SESSION_DOMAINS,
  project: process.cwd(),
  projectName: PROJECT_NAME,
  projectId: resolveProjectId(),
  // Peer-direct messaging was removed (km-tribe DM-body-drop bug): a DM
  // delivered socket-to-socket bypassed the daemon journal, so the body row
  // never landed in `messages` and pull/reconnect readers lost it. All sends
  // now route through the daemon, which persists the row AND fans out.
  peerSocket: null,
  pid: process.pid,
  claudeSessionId: CLAUDE_SESSION_ID,
  claudeSessionName: CLAUDE_SESSION_NAME,
  identityToken,
  ...(launchIdentityToken === null ? {} : { idToken: launchIdentityToken }),
  // 25074 3c-2b (@cto def441bf): the adapter registers by the seat's token with its launch parent pid and the daemon
  // keys it `<sid>@<gen>`. LAUNCH_IDENTITY is the token's sid (3d-1); no launcher projects TRIBE_LAUNCH_ID (3d-2b).
  ...(LAUNCH_IDENTITY
    ? { launchId: LAUNCH_IDENTITY.id, launchParentPid: LAUNCH_IDENTITY.parentPid }
    : launchIdentityToken !== null
      ? { launchParentPid: resolveLaunchParentPid() }
      : {}),
  ...(ADAPTER_EXIT_RECORD === undefined ? {} : { adapterExitRecord: ADAPTER_EXIT_RECORD }),
  ...(INITIAL_FILTER_MODE === undefined ? {} : { filterMode: INITIAL_FILTER_MODE }),
  // @km/infra/15641 Phase 1 — per-session account/provider label sourced
  // from `ag` via TRIBE_ACCOUNT / TRIBE_PROVIDER env vars (which ag sets
  // at backend-launch time). Tribe stores them; quota visibility lives in
  // ag, not here.
  ...(args.account ? { account: args.account } : {}),
  ...(args.provider ? { provider: args.provider } : {}),
}
let hasRegistered = false
let hasAttemptedRegistration = false
let selectedProtocolVersion = TRIBE_PROTOCOL_VERSION - 1
let protocolMismatchReason: string | null = null

type RequiredMcpTransportStatus = "advertised" | "live" | "closed"

interface RequiredMcpTransportHealth {
  readonly status: RequiredMcpTransportStatus
  readonly reason: string
}

let managedRegistrationConflicts = 0
let registeredDaemonPid: number | null = null
let requiredMcpTransportHealth: RequiredMcpTransportHealth = {
  status: "advertised",
  reason: "awaiting daemon registration",
}

function setRequiredMcpTransportHealth(status: RequiredMcpTransportStatus, reason: string): void {
  requiredMcpTransportHealth = { status, reason }
}

function requiredMcpTransportFailureResult(): {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }]
  readonly isError: true
} {
  const launchId = LAUNCH_IDENTITY?.id ?? "missing"
  const recovery =
    requiredMcpTransportHealth.status === "closed"
      ? `reconnect_attempts=${managedRegistrationConflicts}`
      : "reconnect_attempts=pending"
  return {
    content: [
      {
        type: "text",
        text:
          `required MCP tribe status=${requiredMcpTransportHealth.status}; ` +
          `stop_reason=${requiredMcpTransportHealth.reason}; ` +
          `launch_id=${launchId}; launch_parent_pid=${LAUNCH_IDENTITY?.parentPid ?? process.ppid}; ` +
          `transport_pid=${process.pid}; ${recovery}`,
      },
    ],
    isError: true,
  }
}

function registerParamsForConnection(): typeof baseRegisterParams & {
  delivery: "push" | "pull"
  takeover?: true
} {
  return {
    ...baseRegisterParams,
    ...protocolVersionAdvertisement(selectedProtocolVersion),
    delivery: joined ? DELIVERY_CAPABILITY.delivery : UNJOINED_DELIVERY_CAPABILITY.delivery,
    ...(TAKEOVER && !hasRegistered ? { takeover: true as const } : {}),
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isPersonaNameConflictError(err: unknown): boolean {
  const errorLike = err as { code?: unknown; message?: unknown }
  return (
    errorLike.code === -32000 &&
    typeof errorLike.message === "string" &&
    /^Name "[^"]+" is already taken by live pid \d+/.test(errorLike.message)
  )
}

function isManagedPersonaRegistrationConflict(err: unknown): boolean {
  return REGISTER_WITH_LAUNCH_NAME && isPersonaNameConflictError(err)
}

/**
 * 24767 — the daemon refused this transport because it presents its seat's
 * session authority under another seat's name and launch (a shared provider
 * config baked the other identity into this connector's env). Retrying cannot
 * change who this connector claims to be, so every tool call answers with the
 * refusal at once instead of waiting on a registration that will not come.
 */
let foreignIdentityRefusal: string | null = null

function isForeignIdentityRefusal(err: unknown): boolean {
  const data = (err as { data?: unknown } | null)?.data
  // 25074 3b — a token the daemon's verifier contradicts, or one naming another actor, is refused the same way:
  // retrying cannot change what the token proves. A verifier fault is not here; it may clear, so it retries.
  const kind = typeof data === "object" && data !== null ? (data as { kind?: unknown }).kind : undefined
  return kind === "foreign-identity-transport" || kind === "identity-contradicted" || kind === "identity-name-mismatch"
}

let fatalRegistrationRefusal: string | null = null
function failManagedPersonaRegistration(err: unknown): never {
  const reason = errorMessage(err)
  if (fatalRegistrationRefusal !== null) throw err
  fatalRegistrationRefusal = reason
  log.warn?.(`tribe registration failed for explicit launch persona ${LAUNCH_NAME}: ${reason}`)
  process.stderr.write(`tribe stdio adapter: ${reason}\n`)
  setRequiredMcpTransportHealth("closed", reason)
  daemon?.close()
  proxyAc.abort()
  const refusalExit = Number(process.env[TRIBE_PLUGIN_PERSONA_REFUSAL_EXIT_CODE_ENV])
  const exitCode =
    isIdentityTokenMissingRefusal(err) && Number.isSafeInteger(refusalExit) && refusalExit > 0 && refusalExit <= 252
      ? refusalExit
      : 2
  process.exitCode = exitCode
  if (!isIdentityTokenMissingRefusal(err)) process.exit(2)
  // Leave one flush window for an already-arrived MCP tool call to receive this refusal before stdio closes.
  setTimeout(() => process.exit(exitCode), 100)
  throw err
}

function reportProtocolVersion(reason: string): void {
  log.warn?.(`tribe protocol version mismatch; staying degraded until it is repaired: ${reason}`)
}

function pluginReexecExitCode(): number | null {
  const supervisedExitCode = Number(process.env[TRIBE_PLUGIN_REEXEC_EXIT_CODE_ENV])
  if (Number.isSafeInteger(supervisedExitCode) && supervisedExitCode > 0 && supervisedExitCode <= 252) {
    return supervisedExitCode
  }
  return null
}

function supervisedReexecExitCode(reasonOffset = 0): number | null {
  const baseExitCode = pluginReexecExitCode()
  return baseExitCode === null ? null : baseExitCode + reasonOffset + (joined ? 1 : 0)
}

function requestPluginReexec(reason: string, supervisedExitCode = supervisedReexecExitCode()): never {
  daemon?.close()
  proxyAc.abort()
  if (supervisedExitCode !== null) {
    log.warn?.(`tribe plugin requesting current-disk re-exec: ${reason}`)
    process.exitCode = supervisedExitCode
    process.exit()
  }
  process.stderr.write(
    `tribe plugin reconnect failed: ${reason}; restart the host session or reinstall the Tribe plugin.\n`,
  )
  process.exitCode = 2
  process.exit()
}

function handleDaemonGenerationChange(reason: string): void {
  if (supervisedReexecExitCode(2) !== null) {
    requestPacedReexec(reason, () => supervisedReexecExitCode(2))
    return
  }
  log.info?.(`tribe direct adapter re-registered without a host re-exec supervisor: ${reason}`)
}

/** cli_status `reload_peers`: absent from an older daemon (null), malformed from a broken one (a loud read failure). */
function parseReloadPeers(raw: unknown): ReloadPeers | null {
  if (raw === undefined) return null
  const names = (value: unknown, field: string): string[] => {
    if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) {
      throw new Error(`cli_status reload_peers.${field} is not a list of names`)
    }
    return value as string[]
  }
  if (typeof raw !== "object" || raw === null) throw new Error("cli_status reload_peers is not an object")
  const peers = raw as { declared?: unknown; live_undeclared?: unknown }
  return {
    declared: names(peers.declared, "declared"),
    liveUndeclared: names(peers.live_undeclared, "live_undeclared"),
  }
}

/** The daemon view a paced reload reads: the peers for this adapter's rank, and the code the daemon runs. */
async function readReloadDaemonView(): Promise<ReloadDaemonView> {
  const probe = await connectToDaemon(SOCKET_PATH, { callTimeoutMs: 1_000 })
  try {
    const status = (await probe.call("cli_status")) as {
      sessions?: Array<{ name?: unknown }>
      reload_peers?: unknown
      daemon?: { code_identity?: { cert?: unknown } }
    }
    const liveNames = (status.sessions ?? []).flatMap((session) =>
      typeof session.name === "string" ? [session.name] : [],
    )
    const cert = status.daemon?.code_identity?.cert
    return {
      liveNames,
      peers: parseReloadPeers(status.reload_peers),
      runningCert: typeof cert === "string" ? cert : null,
    }
  } finally {
    probe.close()
  }
}

const ADAPTER_SOURCE_DIR = dirname(fileURLToPath(import.meta.url))

function reloadDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    timers.setTimeout(resolve, ms)
  })
}
let pacedReexecPending = false

/**
 * A fleet-wide re-exec (a source change, a daemon generation change) waits for this adapter's slot in a rolling
 * restart and for a daemon running the code on disk (25663). The first request wins; a second while one is pending
 * is the same reload. The exit code is read when the adapter re-execs, not when the reload is requested: it carries
 * the joined bit, and a seat that joins during the paced wait must re-exec joined (25663 P4-1).
 */
function requestPacedReexec(reason: string, supervisedExitCode: () => number | null): void {
  if (supervisedExitCode() === null) requestPluginReexec(reason, null)
  if (pacedReexecPending) {
    log.info?.(`paced re-exec already pending; also: ${reason}`)
    return
  }
  pacedReexecPending = true
  void pacedReexec(
    {
      self: myName,
      readDaemon: readReloadDaemonView,
      onDiskCert: () => {
        const onDisk = resolveCheckoutCodeIdentity(ADAPTER_SOURCE_DIR).onDisk
        return onDisk.ok ? onDisk.value : null
      },
      now: () => Date.now(),
      sleep: reloadDelay,
      timeout: reloadDelay,
      warn: (message) => log.warn?.(message),
      info: (message) => log.info?.(message),
      reexec: (why) => requestPluginReexec(why, supervisedExitCode()),
    },
    reason,
  ).catch((error: unknown) =>
    requestPluginReexec(`${reason}; paced re-exec failed: ${errorMessage(error)}`, supervisedExitCode()),
  )
}

const reconnectWatchdog = createReconnectWatchdog({
  timers,
  thresholdMs: 60_000,
  retryMs: 5_000,
  now: () => Date.now(),
  async probeDaemon() {
    let probe: DaemonClient | undefined
    try {
      probe = await connectToDaemon(SOCKET_PATH, { callTimeoutMs: 1_000 })
      await probe.call("cli_daemon")
      return true
    } catch {
      return false
    } finally {
      probe?.close()
    }
  },
  onStuck({ reconnectingMs }) {
    if (protocolMismatchReason !== null) {
      reportProtocolVersion(`${protocolMismatchReason}; retrying without host re-exec`)
      return
    }
    requestPluginReexec(
      `primary transport remained reconnecting for ${reconnectingMs}ms while the daemon answered a fresh connection`,
    )
  },
})

// NON-BLOCKING: the daemon connect runs in the background. We do NOT await
// it here — module evaluation continues straight through to `mcp.connect()`
// so the MCP `initialize` handshake is answered immediately. Without this, a
// slow daemon connect (cold start, or spawn + retry backoff) stalled the
// handshake long enough for codex's MCP launcher to time out and relaunch
// the server — the double-spawn seen in the connect logs. Tool calls that
// arrive before the daemon is ready `await daemonReady` in the handler.
function startDaemonConnection(): Promise<DaemonClient> {
  return createReconnectingClient({
    socketPath: SOCKET_PATH,
    // Provider-owned bridges reconnect to the singleton; they never own it.
    // Lifecycle belongs to an explicit daemon install or Hab supervision.
    noSpawn: true,
    async onConnect(client) {
      if (hasAttemptedRegistration) {
        await timers.delay(reconnectRegistrationJitterMs())
      }
      hasAttemptedRegistration = true
      // km 19442 — open a fresh connect-replay window so a stale daemon's body-push
      // burst on (re)connect is bounded (see connectReplayGate + the `channel` handler).
      connectReplayGate.reset(Date.now())
      let reg: {
        sessionId: string
        name: string
        role: string
        chief: string
        protocolVersion?: number
        transportDelivery?: unknown
        delivery?: unknown
        daemon?: { pid?: number }
      }
      client.onNotification(handleDaemonNotification)
      try {
        const registration = registerParamsForConnection()
        const registerPromise = client.call("register", registration)
        registrationInFlight = registerPromise
        try {
          reg = (await registerPromise) as typeof reg
          acceptDeliveryAcknowledgement(reg, registration.delivery)
        } finally {
          registrationInFlight = null
        }
      } catch (err) {
        const reason = errorMessage(err)
        if (isIdentityTokenMissingRefusal(err)) failManagedPersonaRegistration(err)
        if (/protocol version mismatch/i.test(reason)) {
          protocolMismatchReason = reason
          const daemonVersions = protocolVersionsFromMismatch(reason)
          const negotiatedVersion = negotiateProtocolVersion(TRIBE_SUPPORTED_PROTOCOL_VERSIONS, daemonVersions)
          if (negotiatedVersion !== null) {
            selectedProtocolVersion = negotiatedVersion
            reportProtocolVersion(`${reason}; retrying protocol=${negotiatedVersion}`)
          } else {
            reportProtocolVersion(`${reason}; no compatible version in the shipped window; retrying slowly`)
          }
        }
        // Legacy adapters launched without a logical launch id cannot tell a
        // transient reconnect race from another adapter in the same provider
        // launch. Closing their provider-owned stdio leaves native Codex with
        // an advertised tool that can only report `Transport closed`, so keep
        // stdio alive and reuse the bounded reconnect loop. Identified launches
        // are different: the daemon fans same-launch transports together, so a
        // conflict means an explicit different-launch takeover and
        // must retain the existing fail-loud displacement behavior.
        if (hasRegistered && isManagedPersonaRegistrationConflict(err)) {
          if (LAUNCH_IDENTITY) failManagedPersonaRegistration(err)
          managedRegistrationConflicts += 1
          setRequiredMcpTransportHealth("closed", errorMessage(err))
        }
        if (isForeignIdentityRefusal(err)) {
          foreignIdentityRefusal = errorMessage(err)
          log.warn?.(foreignIdentityRefusal)
          setRequiredMcpTransportHealth("closed", foreignIdentityRefusal)
        }
        throw err
      }
      const nextDaemonPid = typeof reg.daemon?.pid === "number" ? reg.daemon.pid : null
      if (
        hasRegistered &&
        registeredDaemonPid !== null &&
        nextDaemonPid !== null &&
        nextDaemonPid !== registeredDaemonPid
      ) {
        handleDaemonGenerationChange(`daemon generation changed from pid ${registeredDaemonPid} to ${nextDaemonPid}`)
      }
      registeredDaemonPid = nextDaemonPid
      hasRegistered = true
      protocolMismatchReason = null
      foreignIdentityRefusal = null
      managedRegistrationConflicts = 0
      setRequiredMcpTransportHealth("live", "registered with tribe daemon")
      reconnectWatchdog.markConnected()
      daemonDegradedReason = null
      myName = reg.name
      reportSupervisedIdentity(myName)
      myRole = reg.role
      log.info?.(`Registered as ${myName} (${myRole})`)
      if (typeof reg.protocolVersion === "number") {
        if (isSupportedProtocolVersion(reg.protocolVersion)) {
          selectedProtocolVersion = reg.protocolVersion
        } else {
          reportProtocolVersion(`session=${TRIBE_PROTOCOL_VERSION}, daemon=${reg.protocolVersion}`)
        }
      }
      void client.call("subscribe").catch(() => {})

      // Startup banner — emit tribe state to the channel so the agent (and user) sees the setup
      try {
        const membersResult = (await client.call("tribe.members", {})) as { content: Array<{ text: string }> }
        const membersData = JSON.parse(membersResult.content?.[0]?.text ?? "{}") as {
          sessions?: Array<{
            name: string
            role: string
            transport_state: "connected" | "disconnected"
            uptime_min: number
            delivery?: string
          }>
        }
        const sessions = (membersData.sessions ?? []).filter((session) => session.transport_state === "connected")
        const chief = reg.chief || sessions.find((s: { role: string }) => s.role === "chief")?.name || "(none)"
        const peers =
          sessions
            .filter((s: { name: string }) => s.name !== myName)
            .map((s: { name: string; role: string }) => `${s.name} (${s.role})`)
            .join(", ") || "(solo)"

        const shortSocket = SOCKET_PATH.replace(process.env.HOME ?? "", "~")
        const banner = `**tribe** ${myName} (${myRole}) · chief: ${chief} · ${deliveryAcknowledgementSummary()} · peers: ${peers} · ${shortSocket}`
        sendChannel(banner, { from: "tribe-startup", type: "system" })
      } catch {
        // Non-fatal — banner is diagnostic, don't block startup
        log.debug?.("Startup banner failed (non-fatal)")
      }
    },
    onDisconnect() {
      deliveryAcknowledgement = { acknowledged: false, cause: "daemon connection closed; reconnecting" }
      reconnectWatchdog.markReconnecting()
      if (REGISTER_WITH_LAUNCH_NAME) {
        setRequiredMcpTransportHealth("advertised", "daemon connection closed; reconnecting")
      }
      log.debug?.(`Daemon connection lost`)
    },
    onReconnect() {
      log.info?.(`Reconnected to daemon`)
      // km 19442 — a reconnect can replay the daemon's pending body-push burst; rebound it.
      connectReplayGate.reset(Date.now())
    },
    maxAttempts: Number.POSITIVE_INFINITY,
  }).then((client) => {
    daemon = client
    // A successful (re)connect clears the degrade — the session is live again.
    daemonDegradedReason = null
    return client
  })
}

// The ONE degrade notice. Without this catch, a daemon that can never start
// (no socket + no daemon script — e.g. a standalone install with a broken
// spawn path) rejects the connect promise and every chained `.then` unhandled.
// Re-armed on each recovery attempt (see recoverDaemonIfDegraded), but the
// notice itself fires exactly ONCE per process (km 19851): re-setting the
// reason each time keeps state accurate without spamming the log/channel on
// every failed retry.
let degradeAnnounced = false
function armDegradeNotice(p: Promise<DaemonClient>): void {
  p.catch((err: unknown) => {
    if (fatalRegistrationRefusal !== null) return
    if (isManagedPersonaRegistrationConflict(err)) {
      failManagedPersonaRegistration(err)
    }

    daemonDegradedReason = errorMessage(err)
    if (degradeAnnounced) return
    degradeAnnounced = true
    log.warn?.(`tribe daemon unavailable — running solo (${daemonDegradedReason})`)
    try {
      sendChannel(`**tribe** unavailable — running solo. This session works normally; tribe tools are disabled.`, {
        from: "tribe-startup",
        type: "system",
      })
    } catch {
      // Channel may not be wired yet/at all — the log line above is the notice.
    }
  })
}

// Self-heal: a degraded session re-attempts the daemon connect on demand. The
// reconnect loop only covers post-connect drops, so an initial-connect failure
// (transient ECONNREFUSED during a startup herd, daemon briefly down at launch)
// would otherwise pin the session solo until restart. Throttled so a daemon
// that is genuinely down is not respawned/hammered on every tool call.
let lastDaemonRecoveryMs = 0
const DAEMON_RECOVERY_THROTTLE_MS = 5_000
async function recoverDaemonIfDegraded(): Promise<void> {
  const nowMs = Date.now()
  if (
    !shouldAttemptDaemonRecovery({
      daemonConnected: daemon !== undefined,
      degraded: daemonDegradedReason !== null,
      lastAttemptMs: lastDaemonRecoveryMs,
      nowMs,
      throttleMs: DAEMON_RECOVERY_THROTTLE_MS,
    })
  ) {
    return
  }
  lastDaemonRecoveryMs = nowMs
  const attempt = startDaemonConnection()
  armDegradeNotice(attempt)
  daemonReady = attempt
  try {
    await attempt
  } catch {
    // Still unreachable — daemonDegradedReason is re-set by armDegradeNotice.
  }
}

daemonReady = startDaemonConnection()
armDegradeNotice(daemonReady)

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const joinInstruction = `When you call tribe.join, omit the role parameter — the daemon registers every session as a plain "member"; it does NOT assign "chief" by connect order. "chief" is a bead-lease hat (claimed via /up / the bead lease system), not a daemon-assigned role. No need to call tribe.members or tribe.fetch afterward.`
// Instructions are fixed at initialize and remain conservative. The existing
// startup banner and tools/list report subsequent acknowledged delivery.
const initialDeliveryCapability = currentDeliveryCapability()
const channelEnvelopeIntro =
  'After the startup banner confirms acknowledged transportDelivery=push, messages from other Claude Code sessions can arrive as <channel source="tribe" from="..." type="..." bead="...">.'
const deliveryInstruction = `${deliveryCapabilityInstruction(initialDeliveryCapability)} Read your turn-start inbox until the startup banner confirms your acknowledged transportDelivery. ${REQUIRE_EXPLICIT_JOIN ? "Push remains unavailable until this session calls tribe.join and receives its acknowledgement. " : ""}An unacknowledged banner names the cause; tools/list reports the current confirmed delivery capability.`
const attentionProjectionInstruction =
  "- Default fetch exposes `attention.actionable_unread` (request/query/verdict/assign, direct responses, and direct status/notify from another named seat whose ref names an open request ball you own or sent) and up to 10 `attention.pending_balls`, prioritizing peer requests over watcher incidents, ahead of ambient events; `attention.pending_balls_summary` reports the full total/oldest age and any omitted request/incident counts, while `tribe.pending` returns the full pile. Responses and those status/notify rows remain quiet for default inbox waits. These are facts projected from the existing mailbox and ball tracker, not another queue. A row whose `replay` is true was already shown to this mailbox — the ball tracker deliberately keeps an untaken ball visible past the mailbox cursor — so it is a re-presentation, not a new instruction: never act on one as new and never re-acknowledge it, and read its `ts` as when it was first sent."

// Shared turn-start inbox guidance for every role variant. Kept deliberately
// SMALL: the turn-start call is a small catch-up drain, NOT a full replay. The
// old `limit: 50` window re-pulled already-seen ambient traffic on every turn
// and flooded long-running agent context. See km @km/tribe/19442.
function turnStartInboxCheckForDelivery(capability: TribeDeliveryCapability): string {
  if (capability.idleStrategy === "channel") {
    return `Turn-start inbox check:
- New messages also arrive inline as <channel> envelopes — read those first; you do not need to fetch to receive them.
${attentionProjectionInstruction}
- For turn-start catch-up keep the drain SMALL: tribe.fetch({ limit: 10 }). Do NOT pull a large window every turn — replaying ~50 events re-surfaces already-seen ambient traffic and floods context.
- For a specific peer's latest, use the snapshot filter: tribe.fetch({ with: <your session name>, limit: 10 }) or tribe.fetch({ from: <peer>, limit: 10 }) — these return the newest matching messages; use them to find a thread, not to replay the whole channel.
- Surface only actionable items: direct messages, requests, blockers, assignments, chief verdicts, CI alerts, or user-relevant coordination.
- Ignore routine ambient joins/leaves, git commits, low-severity status, and notification-only events unless explicitly asked.`
  }
  if (capability.idleStrategy === "host-stream") {
    return `Turn-start inbox check:
- Host-provided Tribe stream events may already be visible — handle actionable streamed messages first.
${attentionProjectionInstruction}
- For turn-start catch-up keep the drain SMALL: tribe.fetch({ limit: 10 }). Do NOT pull a large window every turn — replaying ~50 events re-surfaces already-seen ambient traffic and floods context.
- For a specific peer's latest, use the snapshot filter: tribe.fetch({ with: <your session name>, limit: 10 }) or tribe.fetch({ from: <peer>, limit: 10 }) — these return the newest matching messages; use them to find a thread, not to replay the whole channel.
- Surface only actionable items: direct messages, requests, blockers, assignments, chief verdicts, CI alerts, or user-relevant coordination.
- Ignore routine ambient joins/leaves, git commits, low-severity status, and notification-only events unless explicitly asked.`
  }
  return `Turn-start inbox check:
- This session is pull-delivery; tribe messages do not arrive as channel envelopes. Use the advertised inbox-wait/host cadence for idle waits, then do a small catch-up drain.
${attentionProjectionInstruction}
- For turn-start catch-up keep the drain SMALL: tribe.fetch({ limit: 10 }). Do NOT pull a large window every turn — replaying ~50 events re-surfaces already-seen ambient traffic and floods context.
- For a specific peer's latest, use the snapshot filter: tribe.fetch({ with: <your session name>, limit: 10 }) or tribe.fetch({ from: <peer>, limit: 10 }) — these return the newest matching messages; use them to find a thread, not to replay the whole channel.
- Surface only actionable items: direct messages, requests, blockers, assignments, chief verdicts, CI alerts, or user-relevant coordination.
- Ignore routine ambient joins/leaves, git commits, low-severity status, and notification-only events unless explicitly asked.`
}

const turnStartInboxCheck = turnStartInboxCheckForDelivery(initialDeliveryCapability)

const chiefInstructions = `${channelEnvelopeIntro}

You are the chief of a tribe — a coordinator for multiple Claude Code sessions working on the same project.

${joinInstruction}

${deliveryInstruction}

${turnStartInboxCheck}

Coordination protocol:
- Use tribe.members() to see who's online and their domains
- Use tribe.send(to, message, type) to assign work, answer queries, or approve requests
- Use tribe.send(to="*", message, type) to announce changes that affect everyone
- Use tribe.health() to check for silent members or conflicts
- When CI alerts arrive, coordinate the fix — assign the responsible session to investigate

User-facing output:
- Silent by default. Speak to the user only to add non-obvious info. Never narrate "noted"/"acknowledged"/"still waiting" for channel messages, CI alerts, or harness reminder loops. If you have nothing to add, emit nothing.
- **Notification-only channels get ZERO output.** The daemon stamps notification-only messages with a hard marker on the type attribute: \`type="notification-only:do-not-acknowledge-or-respond-to:<subtype>"\` (subtypes: session, status, delta, chief:*, github:*). If every <channel> tag in a turn carries the \`notification-only:do-not-acknowledge-or-respond-to:\` prefix on its type attribute, the correct reply is literally zero characters — no tool calls, no text, no acknowledgment. Do NOT emit "Acknowledged", "Noted", "No response required", or any filler. Do NOT emit "Human:" / "Assistant:" / "User:" as a prefix. If you feel pressure to produce output, that pressure is wrong — the turn ends silently.

Tribe messages:
- Keep SHORT — 1-3 lines max. No essays.
- Plain text only — no markdown (**bold**, headers, bullets). Renders as escaped text.`

const memberInstructions = `${channelEnvelopeIntro}

You are a tribe member — a worker session coordinated by the chief.

${joinInstruction}

${deliveryInstruction}

${turnStartInboxCheck}

Coordination protocol:
- When you START work on a task, broadcast what you're doing: tribe.send(to="*", message="starting: <task>")
- When you FINISH a task or commit, broadcast: tribe.send(to="*", message="done: <summary>")
- When you claim a bead, broadcast: tribe.send(to="*", message="claimed: <bead-id> — <title>")
- When you're blocked, broadcast immediately — include what would unblock you
- Before editing vendor/ or shared files, send a request to chief asking for OK
- Respond to query messages promptly

Sub-agent protocol:
- When you spawn sub-agents (Agent tool), broadcast: tribe.send(to="*", message="spawned: <name> for <task>")
- When a sub-agent completes, broadcast: tribe.send(to="*", message="agent-done: <name> — <result>")
- Sub-agents share your tribe connection — they can't be seen individually in tribe

CI protocol:
- When you see a CI ALERT for a repo you're working on or know about, respond with a fix hint
- Example: tribe.send(to="*", message="hint: termless CI needs vt220.js — run npm publish from vendor/vterm/packages/vt220")
- If a CI alert DMs you directly, investigate and fix the failure before pushing more code
- After fixing, broadcast: tribe.send(to="*", message="ci-fix: <repo> — <what you fixed>")

User-facing output:
- Silent by default. Speak to the user only to add non-obvious info. Never narrate "noted"/"acknowledged"/"still waiting" for channel messages, CI alerts, or harness reminder loops. If you have nothing to add, emit nothing.
- **Notification-only channels get ZERO output.** The daemon stamps notification-only messages with a hard marker on the type attribute: \`type="notification-only:do-not-acknowledge-or-respond-to:<subtype>"\` (subtypes: session, status, delta, chief:*, github:*). If every <channel> tag in a turn carries the \`notification-only:do-not-acknowledge-or-respond-to:\` prefix on its type attribute, the correct reply is literally zero characters — no tool calls, no text, no acknowledgment. Do NOT emit "Acknowledged", "Noted", "No response required", or any filler. Do NOT emit "Human:" / "Assistant:" / "User:" as a prefix. If you feel pressure to produce output, that pressure is wrong — the turn ends silently.

Tribe messages:
- Keep SHORT — 1-3 lines max. No essays.
- Plain text only — no markdown (**bold**, headers, bullets). Renders as escaped text.
- Don't over-broadcast — only send when it changes what someone else should know.`

const pullInstructions = `Tribe coordination is available through MCP tools.

${turnStartInboxCheck}

Coordination protocol:
- Use tribe.members() to see who's online and their domains.
- Use tribe.send(to, message, type) to assign work, answer queries, broadcast status, or request help.
- ${deliveryInstruction}
- Keep tribe messages short: 1-3 lines, plain text only.`

// `experimental["claude/channel"]` registers this MCP server as a Claude Code
// *channel source*. Claude Code reads this capability from the `initialize`
// response, then captures every `notifications/claude/channel` notification
// the server emits (see `sendChannel` above) — queuing them and draining on
// the next REPL turn. This IS Claude Code's native channel-delivery mechanism;
// there is no `--channels` CLI flag (the flag does not exist in Claude Code
// 2.1.145 — channel delivery is purely the MCP capability + notification).
//
// This is Mode 2 of the three-host tribe-delivery design (km epic 15409): a
// `claude` session launched via `ag` receives tribe messages through this
// channel pipe, no silvercode host and no pty send-keys hack. The tribe MCP
// `tools/*` (fetch/send/members/…) stay alongside — channels is *additive*
// delivery (push), the tools remain the pull surface.
//
// Native auto-wake of an idle REPL on channel arrival is currently bug-broken
// upstream — Claude Code GitHub issue #44380 (channel messages queue but do
// not wake an idle REPL). Channels-as-delivery is still correct: messages
// arrive, queue, and drain on the next turn. The `/loop` heartbeat is the
// interim wake mechanism until #44380 lands.
// oxlint-disable-next-line typescript/no-deprecated -- the adapter is built on the low-level Server (see its declaration)
mcp = new Server(
  { name: "tribe", version: "0.14.1" },
  {
    capabilities: {
      ...(CLAUDE_CHANNEL_ENABLED ? { experimental: { "claude/channel": {} } } : {}),
      tools: {},
    },
    // Role for the `initialize` instructions must be known synchronously
    // (the daemon hasn't connected yet — see the non-blocking daemon block).
    // `args.role` is the launch-time hint; daemon-assigned role isn't
    // available this early. Members are the common case; a chief is launched
    // with the role hint.
    instructions: CLAUDE_CHANNEL_ENABLED
      ? args.role === "chief"
        ? chiefInstructions
        : memberInstructions
      : pullInstructions,
  },
)

// ---------------------------------------------------------------------------
// Tools — forward all to daemon
// ---------------------------------------------------------------------------

// Projected per call: inbox.wait describes the delivery this session has now,
// which changes at tribe.join. (An auto-identify join nudge used to fire here;
// it went through sendChannel, which drops everything before join, so no
// session could ever receive it.)
mcp.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: toolListForDeliveryCapability(currentDeliveryCapability()),
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: toolArgs } = req.params
  const a = (toolArgs ?? {}) as Record<string, unknown>

  try {
    if (fatalRegistrationRefusal !== null) {
      return { content: [{ type: "text", text: fatalRegistrationRefusal }], isError: true }
    }
    if (REGISTER_WITH_LAUNCH_NAME && hasAttemptedRegistration && requiredMcpTransportHealth.status === "advertised") {
      try {
        await daemonReady
      } catch (error) {
        if (isIdentityTokenMissingRefusal(error)) {
          return { content: [{ type: "text", text: errorMessage(error) }], isError: true }
        }
      }
    }
    if (foreignIdentityRefusal !== null) {
      return { content: [{ type: "text", text: foreignIdentityRefusal }], isError: true }
    }
    // Degraded: an earlier connect failed. Before reporting either managed
    // transport health or solo mode, self-heal — the daemon may be up now.
    // Throttled inside recoverDaemonIfDegraded.
    if (daemonDegradedReason !== null && daemon === undefined) {
      await recoverDaemonIfDegraded()
    }
    if (REGISTER_WITH_LAUNCH_NAME && requiredMcpTransportHealth.status !== "live") {
      return requiredMcpTransportFailureResult()
    }
    // Attach identity_token to join so the daemon can adopt prior
    // session state when Claude Code restarts and the agent calls join again.
    const payload =
      name === "join"
        ? {
            ...a,
            // Pull-only adapters have no channel reader. Do not let a model
            // self-report push and make later tribe.fetch calls skip directs.
            delivery: resolveJoinDelivery({
              adapterDelivery: DELIVERY,
              requestedDelivery: a.delivery,
              allowRequestedDelivery: CLAUDE_CHANNEL_ENABLED,
            }),
            identity_token: identityToken,
            // @km/tribe/19975 — forward the launch-time account/provider label
            // on join (symmetric with registerParams). A join is authoritative
            // for these in the daemon, so re-joining corrects a row that was
            // first seeded with a stale label. Only attach when the model
            // didn't pass its own, and only when ag set the env (TRIBE_ACCOUNT
            // / TRIBE_PROVIDER) — an unset launch context omits them and the
            // daemon-side COALESCE preserves any existing good label.
            ...(a.account === undefined && args.account ? { account: args.account } : {}),
            ...(a.provider === undefined && args.provider ? { provider: args.provider } : {}),
          }
        : a
    // Still degraded after the retry → one clear sentence per call, never the
    // raw connect error (km 19851 loud-but-soft).
    if (daemonDegradedReason !== null && daemon === undefined) {
      return {
        content: [
          {
            type: "text",
            text: `tribe unavailable — running solo. This session works normally without tribe; it auto-retries the daemon connection periodically — restart it to force an immediate retry.`,
          },
        ],
      }
    }
    // A tool call may arrive before the background daemon connect resolves
    // (the daemon block is non-blocking) — await `daemonReady` in that case.
    const d = daemon ?? (await daemonReady)
    const result = await callTribeTool(d, name, payload)
    // Update local name/role after join/rename
    if (name === "join") {
      const data = parseToolText<Record<string, unknown>>(result)
      if (data?.joined === true && (result as { isError?: boolean }).isError !== true) {
        acceptDeliveryAcknowledgement(data, payload.delivery as "push" | "pull")
        joined = deliveryAcknowledgement.acknowledged
      } else {
        joined = false
        deliveryAcknowledgement = {
          acknowledged: false,
          cause: `join refused: ${String(data?.error ?? "no joined acknowledgement")}`,
        }
        log.warn?.(`tribe delivery acknowledgement ${deliveryAcknowledgementSummary()}`)
      }
      sendChannel(`**tribe** ${myName} · ${deliveryAcknowledgementSummary()}`, {
        from: "tribe-startup",
        type: "system",
      })
    }
    if ((name === "join" && joined) || name === "rename") {
      const r = result as { content: Array<{ type: string; text: string }> }
      try {
        const data = JSON.parse(r.content[0]?.text ?? "{}") as Record<string, string>
        if (data.name) {
          myName = data.name
          reportSupervisedIdentity(myName)
        }
        if (data.role) myRole = data.role
      } catch {
        /* parse error, ignore */
      }
      // Explicit rename by the agent — don't auto-rename later
      autoRenamed = true
    }
    return result as { content: Array<{ type: string; text: string }> }
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      // @ag/tribe/27428 — a caught throw must reach the host as a tool error. Without this, an
      // MCP client that keys on isError reads a transport failure as a successful result whose
      // payload happens to be a string.
      isError: true,
    }
  }
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Hot-reload: re-exec on source changes (only when running from source, not bundled)
import { setupHotReload } from "./lib/hot-reload.ts"
using _reload = setupHotReload({
  importMetaUrl: import.meta.url,
  logActivity: (type, content) => {
    daemon?.call("log_event", { type, content }).catch(() => {})
  },
  replaceProcess: (reason) => requestPacedReexec(reason, () => supervisedReexecExitCode()),
})

const shutdown = (exitCode = 0) => {
  proxyAc.abort()
  daemon?.close()
  process.exit(exitCode)
}
// A signal exits 128+signo, never 0 (25661). Code 0 is the host closing our
// stdin, which the plugin wrapper treats as final because a replacement would
// inherit fd 0 at EOF; a signal aimed at this child alone is a crash to retry.
const shutdownOnSignal = (signal: "SIGINT" | "SIGTERM") => () => shutdown(128 + osConstants.signals[signal])
// The harness closing our stdin is the end of this launch — the provider
// process is gone and nothing will reconnect under this launch id. Say so to
// the daemon before closing, so the `session.left` fact carries a reason a
// reader can act on; a signal says nothing about the launch and closes
// silently (@ag/tribe/tribe-membership-projection-counts-permanent-history-as-degraded).
let harnessExitAnnounced = false
const shutdownAfterHarnessExit = () => {
  if (harnessExitAnnounced) return
  harnessExitAnnounced = true
  const announced = daemon?.call("leave", { reason: "harness-exited" }).catch(() => undefined)
  const deadline = new Promise<void>((resolve) => {
    setTimeout(resolve, 500)
  })
  void Promise.race([announced ?? Promise.resolve(), deadline]).finally(() => shutdown(0))
}
process.on("SIGINT", shutdownOnSignal("SIGINT"))
process.on("SIGTERM", shutdownOnSignal("SIGTERM"))
process.stdin.once("end", shutdownAfterHarnessExit)
process.stdin.once("close", shutdownAfterHarnessExit)

// Connect MCP to Claude Code
await mcp.connect(new StdioServerTransport())

// Surface the cwd-guardrail decision on the tribe channel so the agent sees
// it next to other startup signals. Wrapped in setTimeout to give the MCP
// channel time to settle (mirrors the autoidentify nudge pattern above).
if (CWD_EVAL.kind === "warn" || CWD_EVAL.kind === "refuse") {
  const prefix = CWD_EVAL.kind === "refuse" ? "system" : "warning"
  timers.setTimeout(() => {
    sendChannel(CWD_EVAL.message, { from: "stdio-adapter", type: prefix })
    // Also log to the daemon's activity stream so diagnostics can surface it.
    daemon
      ?.call("log_event", {
        type: CWD_EVAL.kind === "refuse" ? "cwd_guardrail_refuse" : "cwd_guardrail_warn",
        content: CWD_EVAL.message,
      })
      .catch(() => {
        /* daemon may not be ready yet — log_event is best-effort */
      })
  }, 750)
}

// Watch transcript file for /rename slug changes and auto-sync to tribe
import { resolveTranscriptPath, readTranscriptSlug } from "./lib/transcript.ts"
{
  const transcriptPath = resolveTranscriptPath(CLAUDE_SESSION_ID)
  if (transcriptPath) {
    let lastSlug: string | null = null
    const checkSlug = () => {
      const slug = readTranscriptSlug(transcriptPath)
      if (!slug || slug === lastSlug || slug === myName) return
      lastSlug = slug
      autoRenamed = true
      daemon
        ?.call("tribe.rename", { new_name: slug })
        .then((result) => {
          const r = result as { content: Array<{ type: string; text: string }> }
          try {
            const data = JSON.parse(r.content[0]?.text ?? "{}") as Record<string, string>
            if (data.name) {
              myName = data.name
              reportSupervisedIdentity(myName)
            }
            log.info?.(`auto-renamed from /rename slug: ${myName}`)
          } catch {
            /* ignore */
          }
          return undefined
        })
        .catch(() => {
          /* rename failed — name taken or similar */
        })
    }
    // Check periodically (file watch is unreliable for appended JSONL files)
    timers.setInterval(checkSlug, 5_000)
  }
}

// Auto-rename: when this session claims a bead, rename to the bead scope
// e.g., claiming "km-storage.foo" renames session to "km-storage"
let autoRenamed = false
function tryAutoRenameOnClaim(content: string): void {
  if (autoRenamed) return
  // Only auto-rename if session still has auto-generated name (km-N-XXX pattern)
  if (!/^km-\d+-[a-z0-9]{3}$/.test(myName)) return
  // Match "[by:claude:XXXXXXXX]" in claim message and check if it's this session
  const byMatch = content.match(/\[by:claude:([a-f0-9]+)\]/)
  if (!byMatch) return
  const claimSessionPrefix = byMatch[1]
  if (claimSessionPrefix === undefined) return
  if (!CLAUDE_SESSION_ID || !CLAUDE_SESSION_ID.startsWith(claimSessionPrefix)) return
  // Extract bead scope from "Claimed: km-<scope>.<suffix> — ..."
  const beadMatch = content.match(/^Claimed: (km-[a-z][\w-]*?)\./)
  if (!beadMatch) return
  const scope = beadMatch[1]
  if (scope === myName) return
  autoRenamed = true
  daemon
    ?.call("tribe.rename", { new_name: scope })
    .then((result) => {
      const r = result as { content: Array<{ type: string; text: string }> }
      try {
        const data = JSON.parse(r.content[0]?.text ?? "{}") as Record<string, string>
        if (data.name) {
          myName = data.name
          reportSupervisedIdentity(myName)
        }
      } catch {
        /* ignore */
      }
      return undefined
    })
    .catch(() => {
      /* rename failed, e.g. name taken — that's fine */
    })
}

function forwardFetchedEvent(event: NonNullable<TribeFetchResult["events"]>[number]): void {
  const content = String(event.content ?? "")
  const type = markedType(String(event.type ?? "notify"))
  if (type === "bead:claimed") tryAutoRenameOnClaim(content)
  sendChannel(content, {
    from: String(event.from ?? "unknown"),
    type,
    bead: event.bead ? String(event.bead) : undefined,
    message_id: event.id ? String(event.id) : undefined,
    // 25074 3d-1a (@cto 2bfc1935 Q0): whether the sender is verified, a bearer, or only claims its name. A row from
    // before the daemon recorded it, or one the daemon sent, carries none.
    authority: event.from_authority ? String(event.from_authority) : undefined,
    // 27346 - a re-presented attention row names itself a replay and when it
    // was first sent, so a pane that drains hours later does not read it as a
    // fresh instruction.
    ...replayEnvelopeMeta(event),
  })
}

function formatPendingBallAge(ageMs: number): string {
  const minutes = Math.max(0, Math.floor(ageMs / 60_000))
  if (minutes < 1) return "<1m"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function forwardPendingBallSummary(
  balls: NonNullable<NonNullable<TribeFetchResult["attention"]>["pending_balls"]>,
  summary?: NonNullable<TribeFetchResult["attention"]>["pending_balls_summary"],
): void {
  const total = summary?.total ?? balls.length
  if (total === 0) return
  const ordered = [...balls].sort((left, right) => (right.age_ms ?? 0) - (left.age_ms ?? 0))
  const oldest = formatPendingBallAge(summary?.oldest_age_ms ?? ordered[0]?.age_ms ?? 0)
  const top = ordered
    .map((ball) => ball.summary?.trim())
    .filter((summary): summary is string => Boolean(summary))
    .slice(0, 3)
  const topText = top.length > 0 ? ` Top: ${top.join(" | ")}` : ""
  const withheld = summary?.withheld
  const withheldText =
    withheld && (withheld.total ?? 0) > 0
      ? ` Preview withheld ${withheld.total} (${withheld.by_kind?.request ?? 0} request, ${withheld.by_kind?.incident ?? 0} incident).`
      : ""
  sendChannel(`You own ${total} ${total === 1 ? "ball" : "balls"}, oldest ${oldest}.${topText}${withheldText}`, {
    from: "tribe",
    type: "attention:pending-balls",
  })
}

let drainInFlight = false
let drainAgain = false
// 27346 — in-memory only; the adapter process lifetime is the throttle scope.
let pendingBallSummaryState: PendingBallSummaryState | null = null
// 27346 — rows THIS pane has already been handed, so a re-presented attention
// row stops re-forwarding on every wakeup. Adapter-local by necessity: the
// daemon's `replay` flag is cursor-based and a registration tail-reset makes a
// never-delivered recovery row read `replay:true` (see createForwardedAttentionTracker).
const forwardedAttention = createForwardedAttentionTracker()

// #27459 — the per-pane delivery counter (@cto 9a077460): `presented` is every
// actionable row the daemon exposes to this adapter (forwarded or suppressed);
// `delivered` is a successful handoff. The durable half is the per-pane
// first-successful-handoff ledger under habitat kpi state, so a handoff after a
// restart still reads as a duplicate rather than a fresh delivery.
const deliveryCounter = createDeliveryCounter()
let deliveryLedgerFilePath: string | null = null
let deliveryLedgerState: DeliveryLedgerState | null = null
let deliveryLedgerReady = false

function ensureDeliveryLedger(now: number): void {
  if (deliveryLedgerReady) return
  const pane = myName !== "" ? myName : process.env.TRIBE_NAME?.trim() || "@unknown"
  const path = deliveryLedgerPath({ pane, env: process.env })
  if (path === null) {
    // No habitat kpi root and no override: count in memory only, and never invent
    // a $HOME location (25231). The counters still work; only durability is off.
    deliveryLedgerReady = true
    return
  }
  const loaded = loadDeliveryLedger(path)
  const opened = openDeliveryLedgerWindow({ existing: loaded.state, coverage: loaded.coverage, pane, now })
  // #27459 REVISE — seed the cumulative same-window totals too, not just the
  // id set, or the first persist of a resumed window reads as all-zero.
  deliveryCounter.restore(opened.ids, opened.counters)
  forwardedAttention.restore(opened.ids)
  // #27459 gap-7 — the summary throttle is restored too, or a restart re-presents
  // an unchanged "You own N balls ..." line (the class the id set just closed).
  pendingBallSummaryState = opened.pendingBallSummary
  deliveryLedgerFilePath = path
  deliveryLedgerState = opened
  deliveryLedgerReady = true
}

function persistDeliveryLedger(now: number): void {
  if (deliveryLedgerFilePath === null || deliveryLedgerState === null) return
  if (now - deliveryLedgerState.windowStartMs >= DELIVERY_LEDGER_WINDOW_MS) {
    deliveryCounter.resetCounters()
    deliveryLedgerState = openDeliveryLedgerWindow({
      existing: deliveryLedgerState,
      coverage: deliveryLedgerState.coverage,
      pane: deliveryLedgerState.pane,
      now,
    })
  }
  deliveryLedgerState = {
    ...deliveryLedgerState,
    updatedAtMs: now,
    ids: deliveryCounter.firstHandoffIds(),
    counters: deliveryCounter.snapshot(),
    // #27459 gap-7 — persisted with the ids so an adapter restart resumes the
    // throttle instead of re-presenting an unchanged summary.
    pendingBallSummary: pendingBallSummaryState,
  }
  try {
    saveDeliveryLedger(deliveryLedgerFilePath, deliveryLedgerState)
  } catch (err) {
    // NO SILENT ERRORS: a ledger we could not persist must not read as a clean 0.
    log.warn?.(`Failed to persist tribe delivery ledger: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function drainDaemonInbox(): void {
  if (drainInFlight) {
    drainAgain = true
    return
  }
  drainInFlight = true
  void (async () => {
    try {
      if (registrationInFlight) {
        try {
          await registrationInFlight
        } catch {
          // silent-fallback-allow: registration rejection is handled by startDaemonConnection's own try/catch
        }
      }
      const d = daemon ?? (await daemonReady.catch(() => undefined))
      if (!d) return
      ensureDeliveryLedger(Date.now())
      do {
        drainAgain = false
        // 19442: against a current daemon this drain returns only unacked
        // actionable directs (the durable mailbox) plus genuinely-new rows —
        // a claim/rename floods nothing by construction. The replay cap below
        // is the STALE-DAEMON BACKSTOP: a legacy daemon that still rewinds
        // cursors can dump a large backlog, and only a recent, capped subset
        // may reach the model as <channel> envelopes. Excess AMBIENT rows are
        // still drained (the session cursor moves past them) — just not
        // replayed.
        //
        // 21757: `receipt:false` — no model is behind this read. sendChannel
        // below is a fire-and-forget notification the host may never render
        // (a dark pane), so this drain must not acknowledge the mailbox
        // cursor or count as the seat's attention read. The attention rows it
        // forwards stay in actionable_unread until the model's own in-turn
        // read (MCP fetch or `tribe inbox`) returns them — that read is the
        // receipt. On 2026-09-02 eight officer rows were drained, acked here,
        // and never seen; this is the line that lost them.
        const result = parseToolText<TribeFetchResult>(await d.call("tribe.fetch", { limit: 500, receipt: false }))
        // 27346 — forward an attention row only on its FIRST delivery to this
        // pane. The daemon's `replay` flag is NOT that fact (registration
        // tail-resets the session cursor, so a recovered row that predates this
        // seat reads replay:true on its first delivery), so delivery is tracked
        // adapter-locally. Ids are remembered from ALL actionable rows, before
        // the admission filter, so a suppressed row cannot sneak back in through
        // the ambient-events path below.
        const attentionEventsAll = result?.attention?.actionable_unread ?? []
        const attentionIds = new Set(attentionEventsAll.map((event) => event.id).filter(Boolean))
        // #27459 — every actionable row the daemon exposed this drain is a
        // PRESENTATION; a row the once-per-row filter admits is also a DELIVERY.
        for (const event of attentionEventsAll) {
          deliveryCounter.present(event.id ? String(event.id) : undefined)
        }
        const attentionEvents = attentionEventsAll.filter(
          (event) => !forwardedAttention.has(event.id ? String(event.id) : undefined),
        )
        for (const event of attentionEvents) {
          forwardFetchedEvent(event)
          // Marked only AFTER the handoff, so a throw re-delivers next drain.
          forwardedAttention.remember(event.id ? String(event.id) : undefined)
          deliveryCounter.deliver(
            event.id ? String(event.id) : undefined,
            Buffer.byteLength(String(event.content ?? ""), "utf8"),
          )
        }
        const currentPendingBalls = result?.attention?.pending_balls ?? []
        const currentPendingBallSummary = result?.attention?.pending_balls_summary
        const currentPendingBallTotal = currentPendingBallSummary?.total ?? currentPendingBalls.length
        // 27346 — one summary per unchanged set (or per window), not per wakeup.
        const pendingBallDecision = decidePendingBallSummary(
          { balls: currentPendingBalls, summary: currentPendingBallSummary },
          { now: Date.now(), windowMs: PENDING_BALL_SUMMARY_WINDOW_MS, state: pendingBallSummaryState },
        )
        pendingBallSummaryState = pendingBallDecision.state
        if (pendingBallDecision.send) forwardPendingBallSummary(currentPendingBalls, currentPendingBallSummary)
        const events = (result?.events ?? []).filter((event) => !event.id || !attentionIds.has(event.id))
        // #27459 - the ambient events path is the SAME pane inbox as attention.
        // A notify recovered from the mailbox cursor re-appears on every
        // receipt:false drain; it obeys the one forwarded-id record too, and both
        // paths feed the delivery counter/ledger, or the report misses the
        // measured residual duplicate rate. The filter runs BEFORE the age/count
        // cap, and a row with no id fails open (never withheld).
        for (const event of events) {
          deliveryCounter.present(event.id ? String(event.id) : undefined)
        }
        const freshEvents = events.filter((event) => !forwardedAttention.has(event.id ? String(event.id) : undefined))
        const { forward, skippedOld, capped } = selectReplayEvents(freshEvents, { now: Date.now() })
        for (const event of forward) {
          forwardFetchedEvent(event)
          forwardedAttention.remember(event.id ? String(event.id) : undefined)
          deliveryCounter.deliver(
            event.id ? String(event.id) : undefined,
            Buffer.byteLength(String(event.content ?? ""), "utf8"),
          )
        }
        if (skippedOld > 0 || capped > 0) {
          log.warn?.(
            `tribe drain: surfaced ${attentionEvents.length} actionable + ${currentPendingBalls.length}/${currentPendingBallTotal} pending + ${forward.length}/${events.length} event(s) (skipped ${skippedOld} older than 1d, ${capped} over cap ${MAX_REPLAY_EVENTS}); rest drained but not replayed`,
          )
        }
      } while (drainAgain)
      persistDeliveryLedger(Date.now())
    } catch (err) {
      log.warn?.(`Failed to drain tribe inbox after wakeup: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      drainInFlight = false
      if (drainAgain) drainDaemonInbox()
    }
  })()
}

function handleDaemonNotification(method: string, params?: Record<string, unknown>): void {
  if (method === "wakeup") {
    drainDaemonInbox()
    return
  }
  if (method === "channel") {
    const content = String(params?.content ?? "")
    const type = markedType(String(params?.type ?? "notify"))
    // Auto-rename on bead claim by this session — runs even when the forward is
    // capped below; the rename is opportunistic and idempotent (durable in the DB).
    if (type === "bead:claimed") tryAutoRenameOnClaim(content)
    // km 19442 — bound a stale daemon's connect-time body-push burst. Steady-state
    // live messages pass freely; only an over-cap (re)connect storm is dropped here
    // (the rows stay durable in the daemon journal and remain fetchable via tribe.fetch).
    if (!connectReplayGate.admit(Date.now())) {
      if (connectReplayGate.dropped === 1) {
        log.warn?.(
          `tribe channel-push: connect-replay burst over cap ${MAX_REPLAY_EVENTS} — dropping excess body-pushes (durable + fetchable). Likely a stale tribe plugin/daemon; see km 19442.`,
        )
      }
      return
    }
    // #27459 gap-1 — the live push path is the SAME pane inbox as the drain
    // paths. A reconnect re-push of a row this pane already holds must not
    // re-present it: the daemon's `replay` flag is cursor-relative and is NOT
    // that fact (see createForwardedAttentionTracker), so the one forwarded-id
    // record decides. A push with no message id fails open, and a suppressed
    // push stays durable in the mailbox for the model's own read (21757: a
    // model-backed receipt, not transport, retires custody).
    const pushedId = params?.message_id ? String(params.message_id) : undefined
    if (pushedId !== undefined && forwardedAttention.has(pushedId)) return
    sendChannel(content, {
      from: String(params?.from ?? "unknown"),
      type,
      bead: params?.bead_id ? String(params.bead_id) : undefined,
      message_id: params?.message_id ? String(params.message_id) : undefined,
    })
    if (pushedId !== undefined) {
      // Marked only AFTER the handoff, and persisted, so an adapter restart
      // cannot make the daemon's reconnect re-push read as a fresh delivery.
      ensureDeliveryLedger(Date.now())
      forwardedAttention.remember(pushedId)
      deliveryCounter.deliver(pushedId, Buffer.byteLength(content, "utf8"))
      persistDeliveryLedger(Date.now())
    }
  } else if (method === "session.joined" || method === "session.left") {
    const action = method === "session.joined" ? "joined" : "left"
    sendChannel(`${String(params?.name ?? "unknown")} ${action} the tribe`, { from: "daemon", type: "status" })
  }
}

// Forward daemon notifications to Claude Code. Registered in onConnect before
// registration (26969 condition 3). The trailing catch keeps a degraded daemon
// from turning this chain into an unhandled rejection — the degrade notice is
// owned by the daemonReady.catch.
void daemonReady.catch(() => {
  /* daemon never came up — the CallTool handler surfaces this to callers */
})
