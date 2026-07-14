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
import { resolveSocketPath, createReconnectingClient, TRIBE_PROTOCOL_VERSION, type DaemonClient } from "./lib/socket.ts"
import { shouldAttemptDaemonRecovery } from "./lib/daemon-recovery.ts"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { toolListForDeliveryCapability } from "./lib/tools-list.ts"
import { createLogger, setSuppressConsole } from "loggily"
import { createTimers } from "./timers.ts"
import { defangModelInput } from "./lib/defang.ts"
import { createConnectReplayGate, MAX_REPLAY_EVENTS, selectReplayEvents } from "./lib/replay-cap.ts"
import { evaluateCwdPolicy, probeCwd, readCwdPolicyFromEnv, type CwdEvaluation } from "./lib/cwd-guardrail.ts"
import {
  deliveryCapabilityInstruction,
  mcpInboxWaitRefusal,
  resolveDeliveryCapability,
  resolveJoinDelivery,
  type TribeDeliveryCapability,
} from "./lib/delivery.ts"

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
const DELIVERY_CAPABILITY = resolveDeliveryCapability({
  delivery: DELIVERY,
  channel: CLAUDE_CHANNEL_ENABLED,
  pullTransport: process.env.TRIBE_PULL_TRANSPORT ?? process.env.TRIBE_WAIT_TRANSPORT,
})
const TRIBE_TOOLS_LIST = toolListForDeliveryCapability(DELIVERY_CAPABILITY)
// c6071f3: a connected MCP adapter is NOT a push-delivered tribe member until
// the model explicitly calls tribe.join. Keep pre-join delivery pull-only, but
// seed explicit @personas at register time so configured Codex identities
// (`TRIBE_NAME=@chief`, `@agent/N`, etc.) never surface as unknown-*.
const REQUIRE_EXPLICIT_JOIN = process.env.TRIBE_REQUIRE_JOIN !== "0"
const LAUNCH_NAME = typeof args.name === "string" && args.name.trim().length > 0 ? args.name.trim() : undefined
const REGISTER_WITH_LAUNCH_NAME =
  LAUNCH_NAME !== undefined && (!REQUIRE_EXPLICIT_JOIN || isExplicitTribePersonaName(LAUNCH_NAME))
// 20703 — managed spawns set TRIBE_TAKEOVER=1 so an explicit-persona
// respawn can supersede a stale live holder once. The capability is consumed
// after the first successful registration; replaying it on reconnect lets two
// displaced adapters evict each other forever (21049).
const TAKEOVER = REGISTER_WITH_LAUNCH_NAME && process.env.TRIBE_TAKEOVER === "1"
const LAUNCH_ID_RAW = process.env.TRIBE_LAUNCH_ID?.trim() ?? ""
// 21049 — adapters forward a complete launcher-minted identity or nothing.
// They never mint/default the id themselves. Parent provenance comes from the
// actual process tree, NOT another inherited env var: an unsanitized nested
// provider may inherit a stale launch id, but its adapter has a different OS
// parent and therefore cannot fan into the old launch.
const LAUNCH_IDENTITY = LAUNCH_ID_RAW.length > 0 ? { id: LAUNCH_ID_RAW, parentPid: process.ppid } : null

// km 19442 — connect-time replay flood backstop. The wakeup→drain path is capped
// by selectReplayEvents, but a stale/old daemon that still pushes message BODIES
// as `channel` notifications bypasses that cap. This gate bounds the post-(re)connect
// `channel` burst to MAX_REPLAY_EVENTS; dropped rows stay durable + fetchable. Knobs
// exist for tests (small cap/window → deterministic burst assertions).
const CHANNEL_REPLAY_MAX = Number(process.env.TRIBE_CHANNEL_REPLAY_MAX) || undefined
const CHANNEL_REPLAY_WINDOW_MS = Number(process.env.TRIBE_CHANNEL_REPLAY_WINDOW_MS) || undefined
const connectReplayGate = createConnectReplayGate({ maxEvents: CHANNEL_REPLAY_MAX, windowMs: CHANNEL_REPLAY_WINDOW_MS })

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
const mySessionId = randomUUID()
const PROJECT_NAME = resolveProjectName()

// MCP server reference — constructed + connected to Claude Code BEFORE the
// daemon connection resolves, so the MCP `initialize` handshake is answered
// in milliseconds rather than blocked on daemon spawn/connect.
// oxlint-disable-next-line eslint(prefer-const) -- deferred init, assigned before use
let mcp: Server
// Daemon client — populated asynchronously by `daemonReady` (the daemon
// block below). Stays `undefined` until the background connect resolves;
// call sites either `await daemonReady` (when they need a guaranteed
// client) or use `daemon?.` (best-effort).
let daemon: DaemonClient | undefined
// oxlint-disable-next-line eslint(prefer-const) -- assigned in the daemon block below
let daemonReady: Promise<DaemonClient>
// Daemon-unavailable degrade ("loud but soft", km 19851): when the daemon can
// never start, the adapter stays alive as a fully functional solo session —
// MCP handshake answered, every tribe tool returns ONE clear sentence, and the
// degrade is announced exactly once (log + channel), never once per call.
let daemonDegradedReason: string | null = null
// Version-skew guard (km 19851): warn exactly once per process, not on
// every reconnect.
let versionSkewWarned = false

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
  if (!joined) return
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

type TribeFetchResult = {
  events?: Array<{
    id?: string
    type?: string
    from?: string
    content?: string
    bead?: string | null
    topic?: string | null
    ts?: string
  }>
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

const baseRegisterParams = {
  ...(REGISTER_WITH_LAUNCH_NAME ? { name: LAUNCH_NAME } : {}),
  ...(args.role ? { role: args.role } : {}),
  domains: SESSION_DOMAINS,
  project: process.cwd(),
  projectName: PROJECT_NAME,
  projectId: resolveProjectId(),
  protocolVersion: TRIBE_PROTOCOL_VERSION,
  // Peer-direct messaging was removed (km-tribe DM-body-drop bug): a DM
  // delivered socket-to-socket bypassed the daemon journal, so the body row
  // never landed in `messages` and pull/reconnect readers lost it. All sends
  // now route through the daemon, which persists the row AND fans out.
  peerSocket: null,
  pid: process.pid,
  claudeSessionId: CLAUDE_SESSION_ID,
  claudeSessionName: CLAUDE_SESSION_NAME,
  identityToken,
  ...(LAUNCH_IDENTITY ? { launchId: LAUNCH_IDENTITY.id, launchParentPid: LAUNCH_IDENTITY.parentPid } : {}),
  delivery: REQUIRE_EXPLICIT_JOIN ? "pull" : DELIVERY,
  // @km/infra/15641 Phase 1 — per-session account/provider label sourced
  // from `ag` via TRIBE_ACCOUNT / TRIBE_PROVIDER env vars (which ag sets
  // at backend-launch time). Tribe stores them; quota visibility lives in
  // ag, not here.
  ...(args.account ? { account: args.account } : {}),
  ...(args.provider ? { provider: args.provider } : {}),
}
let hasRegistered = false

type RequiredMcpTransportStatus = "advertised" | "live" | "closed"

interface RequiredMcpTransportHealth {
  readonly status: RequiredMcpTransportStatus
  readonly reason: string
}

let managedRegistrationConflicts = 0
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
          `launch_id=${launchId}; launch_parent_pid=${process.ppid}; transport_pid=${process.pid}; ${recovery}`,
      },
    ],
    isError: true,
  }
}

function registerParamsForConnection(): typeof baseRegisterParams & { takeover?: true } {
  return TAKEOVER && !hasRegistered ? { ...baseRegisterParams, takeover: true } : baseRegisterParams
}

function isExplicitTribePersonaName(name: string): boolean {
  return /^@[a-z0-9][a-z0-9_./-]{0,31}$/.test(name)
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

function failManagedPersonaRegistration(err: unknown): never {
  const reason = errorMessage(err)
  log.warn?.(`tribe registration failed for explicit launch persona ${LAUNCH_NAME}: ${reason}`)
  daemon?.close()
  proxyAc.abort()
  process.exitCode = 2
  process.exit()
}

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
    async onConnect(client) {
      // km 19442 — open a fresh connect-replay window so a stale daemon's body-push
      // burst on (re)connect is bounded (see connectReplayGate + the `channel` handler).
      connectReplayGate.reset(Date.now())
      let reg: {
        sessionId: string
        name: string
        role: string
        chief: string
        protocolVersion?: number
      }
      try {
        reg = (await client.call("register", registerParamsForConnection())) as typeof reg
      } catch (err) {
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
        throw err
      }
      hasRegistered = true
      managedRegistrationConflicts = 0
      setRequiredMcpTransportHealth("live", "registered with tribe daemon")
      daemonDegradedReason = null
      myName = reg.name
      myRole = reg.role
      log.info?.(`Registered as ${myName} (${myRole})`)
      // Version-skew guard (km 19851): with the daemon embedded in host
      // binaries, two host versions can share one daemon — the first-started
      // binary's daemon serves the rest. Skew is warn-once, never a block:
      // the daemon already tolerates older clients, and a hard fail would
      // break exactly the zero-config flow the embedding exists for.
      if (
        !versionSkewWarned &&
        typeof reg.protocolVersion === "number" &&
        reg.protocolVersion !== TRIBE_PROTOCOL_VERSION
      ) {
        versionSkewWarned = true
        log.warn?.(
          `tribe protocol version skew: this session speaks v${TRIBE_PROTOCOL_VERSION}, daemon speaks v${reg.protocolVersion}. ` +
            `Coordination continues; restart the daemon (or the older sessions) to align.`,
        )
      }
      void client.call("subscribe").catch(() => {})

      // Startup banner — emit tribe state to the channel so the agent (and user) sees the setup
      try {
        const membersResult = (await client.call("tribe.members", {})) as { content: Array<{ text: string }> }
        const membersData = JSON.parse(membersResult.content?.[0]?.text ?? "{}") as {
          sessions?: Array<{ name: string; role: string; alive: boolean; uptime_min: number; delivery?: string }>
        }
        const sessions = (membersData.sessions ?? []).filter((s: { alive: boolean }) => s.alive)
        const chief = reg.chief || sessions.find((s: { role: string }) => s.role === "chief")?.name || "(none)"
        const peers =
          sessions
            .filter((s: { name: string }) => s.name !== myName)
            .map((s: { name: string; role: string }) => `${s.name} (${s.role})`)
            .join(", ") || "(solo)"

        const shortSocket = SOCKET_PATH.replace(process.env.HOME ?? "", "~")
        const banner = `**tribe** ${myName} (${myRole}) · chief: ${chief} · ${DELIVERY} · peers: ${peers} · ${shortSocket}`
        sendChannel(banner, { from: "tribe-startup", type: "system" })
      } catch {
        // Non-fatal — banner is diagnostic, don't block startup
        log.debug?.("Startup banner failed (non-fatal)")
      }
    },
    onDisconnect() {
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
    if (isManagedPersonaRegistrationConflict(err)) failManagedPersonaRegistration(err)

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

const joinInstruction = `If you receive a stdio-adapter auto-identify message, just call tribe.join with a short name for your focus area. Omit the role parameter — the daemon registers every session as a plain "member"; it does NOT assign "chief" by connect order. "chief" is a bead-lease hat (claimed via /up / the bead lease system), not a daemon-assigned role. No need to call tribe.members or tribe.fetch afterward — just join silently and continue.`
const deliveryInstruction = deliveryCapabilityInstruction(DELIVERY_CAPABILITY)

// Shared turn-start inbox guidance for every role variant. Kept deliberately
// SMALL: the turn-start call is a small catch-up drain, NOT a full replay. The
// old `limit: 50` window re-pulled already-seen ambient traffic on every turn
// and flooded long-running agent context. See km @km/tribe/19442.
function turnStartInboxCheckForDelivery(capability: TribeDeliveryCapability): string {
  if (capability.idleStrategy === "channel") {
    return `Turn-start inbox check:
- New messages also arrive inline as <channel> envelopes — read those first; you do not need to fetch to receive them.
- For turn-start catch-up keep the drain SMALL: tribe.fetch({ limit: 10 }). Do NOT pull a large window every turn — replaying ~50 events re-surfaces already-seen ambient traffic and floods context.
- For a specific peer's latest, use the snapshot filter: tribe.fetch({ with: <your session name>, limit: 10 }) or tribe.fetch({ from: <peer>, limit: 10 }) — these return the newest matching messages; use them to find a thread, not to replay the whole channel.
- Surface only actionable items: direct messages, requests, blockers, assignments, chief verdicts, CI alerts, or user-relevant coordination.
- Ignore routine ambient joins/leaves, git commits, low-severity status, and notification-only events unless explicitly asked.`
  }
  if (capability.idleStrategy === "host-stream") {
    return `Turn-start inbox check:
- Host-provided Tribe stream events may already be visible — handle actionable streamed messages first.
- For turn-start catch-up keep the drain SMALL: tribe.fetch({ limit: 10 }). Do NOT pull a large window every turn — replaying ~50 events re-surfaces already-seen ambient traffic and floods context.
- For a specific peer's latest, use the snapshot filter: tribe.fetch({ with: <your session name>, limit: 10 }) or tribe.fetch({ from: <peer>, limit: 10 }) — these return the newest matching messages; use them to find a thread, not to replay the whole channel.
- Surface only actionable items: direct messages, requests, blockers, assignments, chief verdicts, CI alerts, or user-relevant coordination.
- Ignore routine ambient joins/leaves, git commits, low-severity status, and notification-only events unless explicitly asked.`
  }
  return `Turn-start inbox check:
- This session is pull-delivery; tribe messages do not arrive as channel envelopes. Use the advertised inbox-wait/host cadence for idle waits, then do a small catch-up drain.
- For turn-start catch-up keep the drain SMALL: tribe.fetch({ limit: 10 }). Do NOT pull a large window every turn — replaying ~50 events re-surfaces already-seen ambient traffic and floods context.
- For a specific peer's latest, use the snapshot filter: tribe.fetch({ with: <your session name>, limit: 10 }) or tribe.fetch({ from: <peer>, limit: 10 }) — these return the newest matching messages; use them to find a thread, not to replay the whole channel.
- Surface only actionable items: direct messages, requests, blockers, assignments, chief verdicts, CI alerts, or user-relevant coordination.
- Ignore routine ambient joins/leaves, git commits, low-severity status, and notification-only events unless explicitly asked.`
}

const turnStartInboxCheck = turnStartInboxCheckForDelivery(DELIVERY_CAPABILITY)

const chiefInstructions = `Messages from other Claude Code sessions arrive as <channel source="tribe" from="..." type="..." bead="...">.

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

const memberInstructions = `Messages from other Claude Code sessions arrive as <channel source="tribe" from="..." type="..." bead="...">.

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

let nudgeSent = false
/** Check if session name is auto-generated (not explicitly set by user/agent) */
function isAutoName(name: string): boolean {
  return name.startsWith("member-") || name.startsWith("pending-") || /^[a-z]+-\d+-[a-z0-9]{3}$/.test(name)
}
mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  // Nudge on tools discovery (fires on session init/resume)
  if (!nudgeSent && isAutoName(myName)) {
    nudgeSent = true
    timers.setTimeout(() => {
      sendChannel(
        `Auto-identify: call tribe.join(name="${myName}") with a short name for your focus area. Omit the role parameter — the daemon auto-assigns it. Do not call tribe.members or tribe.fetch — just join silently and continue.`,
        { from: "stdio-adapter", type: "system" },
      )
    }, 500)
  }
  return { tools: TRIBE_TOOLS_LIST }
})

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: toolArgs } = req.params
  const a = (toolArgs ?? {}) as Record<string, unknown>

  if (name === "inbox.wait" && DELIVERY_CAPABILITY.idleStrategy !== "mcp-inbox.wait") {
    const session = typeof a.session === "string" && a.session.trim() ? a.session.trim() : myName
    const refusal = mcpInboxWaitRefusal(DELIVERY_CAPABILITY, session)
    if (!refusal) throw new Error("inbox.wait refusal missing for non-MCP delivery")
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: refusal,
        },
      ],
    }
  }

  try {
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
    // Tool names are bare verbs ("send", "fetch"); daemon wire methods use "tribe." prefix
    const daemonMethod = `tribe.${name}`
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
    const result = await d.call(daemonMethod, payload)
    // Update local name/role after join/rename
    if (name === "join") joined = true
    if (name === "join" || name === "rename") {
      const r = result as { content: Array<{ type: string; text: string }> }
      try {
        const data = JSON.parse(r.content[0]?.text ?? "{}") as Record<string, string>
        if (data.name) myName = data.name
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
      content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : err}` }],
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
  onReload: () => {
    proxyAc.abort()
    daemon?.close()
  },
})

const shutdown = () => {
  proxyAc.abort()
  daemon?.close()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

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
import { watch as fsWatch } from "node:fs"
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
            if (data.name) myName = data.name
            log.info?.(`auto-renamed from /rename slug: ${myName}`)
          } catch {
            /* ignore */
          }
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
let joined = !REQUIRE_EXPLICIT_JOIN
function tryAutoRenameOnClaim(content: string): void {
  if (autoRenamed) return
  // Only auto-rename if session still has auto-generated name (km-N-XXX pattern)
  if (!/^km-\d+-[a-z0-9]{3}$/.test(myName)) return
  // Match "[by:claude:XXXXXXXX]" in claim message and check if it's this session
  const byMatch = content.match(/\[by:claude:([a-f0-9]+)\]/)
  if (!byMatch) return
  const claimSessionPrefix = byMatch[1]!
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
        if (data.name) myName = data.name
      } catch {
        /* ignore */
      }
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
  })
}

let drainInFlight = false
let drainAgain = false

function drainDaemonInbox(): void {
  if (drainInFlight) {
    drainAgain = true
    return
  }
  drainInFlight = true
  void (async () => {
    try {
      do {
        drainAgain = false
        // 19442: against a current daemon this drain returns only unacked
        // actionable directs (the durable mailbox) plus genuinely-new rows —
        // a claim/rename floods nothing by construction. The replay cap below
        // is the STALE-DAEMON BACKSTOP: a legacy daemon that still rewinds
        // cursors can dump a large backlog, and only a recent, capped subset
        // may reach the model as <channel> envelopes. Excess rows are still
        // drained (the cursor moves past them) — just not replayed.
        const result = parseToolText<TribeFetchResult>(await daemon?.call("tribe.fetch", { limit: 500 }))
        const events = result?.events ?? []
        const { forward, skippedOld, capped } = selectReplayEvents(events, { now: Date.now() })
        for (const event of forward) forwardFetchedEvent(event)
        if (skippedOld > 0 || capped > 0) {
          log.warn?.(
            `tribe drain: surfaced ${forward.length}/${events.length} event(s) (skipped ${skippedOld} older than 1d, ${capped} over cap ${MAX_REPLAY_EVENTS}); rest drained but not replayed`,
          )
        }
      } while (drainAgain)
    } catch (err) {
      log.warn?.(`Failed to drain tribe inbox after wakeup: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      drainInFlight = false
      if (drainAgain) drainDaemonInbox()
    }
  })()
}

// Forward daemon notifications to Claude Code. Registered once the
// background daemon connect resolves; handlers persist across reconnects.
// The trailing catch keeps a degraded (never-started) daemon from turning
// this chain into an unhandled rejection — the degrade notice is owned by
// the daemonReady.catch above.
void daemonReady
  .then((d) =>
    d.onNotification((method, params) => {
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
        sendChannel(content, {
          from: String(params?.from ?? "unknown"),
          type,
          bead: params?.bead_id ? String(params.bead_id) : undefined,
          message_id: params?.message_id ? String(params.message_id) : undefined,
        })
      } else if (method === "session.joined" || method === "session.left") {
        const action = method === "session.joined" ? "joined" : "left"
        sendChannel(`${params?.name ?? "unknown"} ${action} the tribe`, { from: "daemon", type: "status" })
      } else if (method === "reload") {
        log.info?.(`Daemon requests reload: ${params?.reason}`)
        timers.setTimeout(() => {
          d.close()
          spawn(process.execPath, process.argv.slice(1), { stdio: "inherit", env: process.env }).on(
            "exit",
            (code: number | null) => process.exit(code ?? 0),
          )
        }, 500)
      }
    }),
  )
  .catch(() => {
    /* daemon never came up — the CallTool handler surfaces this to callers */
  })
