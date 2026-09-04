/** Read and inspect verbs for the canonical `tribe-wire` CLI. */

import { readFileSync } from "node:fs"
import { Command, int } from "@silvery/commander"
import { cliOption, visibleCliProjectionForMcp } from "../command-descriptors.ts"
import {
  deriveInboxWaitCallTimeoutMs,
  parseInboxWaitResult,
  resolveInboxWaitControls,
  type InboxWaitResult,
} from "../lib/inbox-wait-options.ts"
import {
  connectToDaemon,
  resolveSocketPath,
  isSupportedProtocolVersion,
  TRIBE_PROTOCOL_VERSION,
  TRIBE_SUPPORTED_PROTOCOL_VERSIONS,
  type DaemonClient,
} from "../lib/socket.ts"
import { watchActivity } from "../lib/activity-watch.ts"
import { clearReaperExempt, listReaperExempt, setReaperExempt } from "../reaper-exempt.ts"
import { readTribeLaunchId } from "../launch-environment.ts"
import { withCliDaemonClient } from "./daemon-client.ts"
import { writeJsonStdout } from "./json-output.ts"
import { mcpJsonContent } from "./mcp-json-content.ts"
import {
  resolveCheckoutCodeIdentity,
  resolvePinDirection,
  type CheckoutCodeIdentity,
  type GitProbe,
  type PinDirection,
} from "../lib/code-identity.ts"
import type { BallSettlementReason } from "../lib/ball-outcome.ts"
import { AG_SESSION_AUTH_ENV, readSelfMailboxAuthorityFromEnvironment } from "../lib/self-mailbox-authority.ts"

const PENDING_CLI = visibleCliProjectionForMcp("pending")
const MEMBERS_CLI = visibleCliProjectionForMcp("members")
const INBOX_WAIT_CLI = visibleCliProjectionForMcp("inbox.wait")
const REPAIR_CLI = visibleCliProjectionForMcp("repair")

const STALE_MANAGED_INBOX_DAEMON_ERROR =
  "Running Tribe daemon is stale and cannot resolve this managed inbox; update the module root before restarting the daemon. Use --session only for an explicit operator target."
const STALE_MANAGED_PENDING_DAEMON_ERROR =
  "Running Tribe daemon is stale and cannot resolve this managed pending owner; update the module root before restarting the daemon. Use --owner only for an explicit recovery or audit target."
const INBOX_WAIT_PROTOCOL_MISMATCH = "TRIBE_INBOX_WAIT_PROTOCOL_MISMATCH"

function pendingReadRecoveryCommand(expired: boolean, owed: boolean, staleMs: number | undefined): string {
  return [
    "tribe pending --owner <seat>",
    expired ? "--expired" : "",
    owed ? "--owed" : "",
    staleMs === undefined ? "" : `--stale ${staleMs / 1000}s`,
    "--json",
  ]
    .filter((part) => part.length > 0)
    .join(" ")
}

function pendingReadCliError(method: string, error: unknown, recoveryCommand: string): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: unknown }).code
  const recoverableIdentityFailure =
    code === -32004 ||
    code === -32003 ||
    message === STALE_MANAGED_PENDING_DAEMON_ERROR ||
    message.startsWith(`${AG_SESSION_AUTH_ENV} must be`)
  if (method !== "cli_session_pending_read_v1" || !recoverableIdentityFailure) return message
  const punctuation = message.endsWith(".") ? "" : "."
  return (
    `${message}${punctuation} No pending query ran. ` +
    `For an explicit recovery or audit read, run '${recoveryCommand}'.`
  )
}

function invalidAuthenticatedPendingSnapshot(
  method: string,
  payload: { owner?: string; count?: number; pending?: PendingCliRow[] },
): boolean {
  if (method !== "cli_session_pending_read_v1") return false
  if (
    typeof payload.owner !== "string" ||
    payload.owner.length === 0 ||
    typeof payload.count !== "number" ||
    !Number.isSafeInteger(payload.count) ||
    payload.count < 0 ||
    !Array.isArray(payload.pending)
  ) {
    return true
  }
  return payload.count !== payload.pending.length
}

// ---------------------------------------------------------------------------
// Daemon connection
// ---------------------------------------------------------------------------

async function callDaemon(method: string, params?: Record<string, unknown>): Promise<unknown> {
  return withCliDaemonClient(async (client) => {
    try {
      return await client.call(method, params)
    } catch (error) {
      const code = (error as { code?: string | number }).code
      if (code === -32601 && method.endsWith("_by_launch_v1")) {
        throw new Error(STALE_MANAGED_INBOX_DAEMON_ERROR)
      }
      if (code === -32601 && method === "cli_session_pending_read_v1") {
        throw new Error(STALE_MANAGED_PENDING_DAEMON_ERROR)
      }
      throw error
    }
  })
}

function cliInboxTargetParams(session: string | undefined): Record<string, unknown> {
  if (session !== undefined) return { session }
  const launchId = readTribeLaunchId(process.env)
  const persona = process.env.TRIBE_SESSION_NAME?.trim() || process.env.TRIBE_NAME?.trim()
  if (launchId) {
    return { launch_id: launchId, ...(persona === undefined ? {} : { persona }) }
  }
  throw new Error(
    "Managed inbox request requires provider launch identity; use --session for an explicit operator target",
  )
}

function cliInboxMethod(base: "status" | "wait" | "drain", session: string | undefined): string {
  return session === undefined ? `cli_inbox_${base}_by_launch_v1` : `cli_inbox_${base}`
}

interface RestartResult {
  error?: string
  restarting?: boolean
  reason?: string
  pid?: number
}

export function formatRestartResult(result: RestartResult): string {
  const pid = typeof result.pid === "number" ? ` (pid ${result.pid})` : ""
  const reason = result.reason ?? "manual restart"
  return `Restarting tribe daemon${pid}: ${reason}.`
}

interface StopResult {
  error?: string
  stopping?: boolean
  reason?: string
  pid?: number
}

export function formatStopResult(result: StopResult): string {
  const pid = typeof result.pid === "number" ? ` (pid ${result.pid})` : ""
  const reason = result.reason ?? "manual stop"
  return `Stopping tribe daemon${pid}: ${reason}. Clean exit 0 — no successor will be spawned.`
}

/** The hab supervisor context — hab stamps HAB_SERVICE_NAME into every
 * service environment, so its own lifecycle tooling may stop the daemon
 * without the --force ceremony. */
export function isHabSupervisorContext(env: { HAB_SERVICE_NAME?: string }): boolean {
  return typeof env.HAB_SERVICE_NAME === "string" && env.HAB_SERVICE_NAME.trim() !== ""
}

export const STOP_REFUSAL_MESSAGE =
  "tribe stop: refusing to stop the shared coordination daemon — every registered session loses its rail. " +
  "Pass --force if you mean it. (Runs without --force only from the hab supervisor context, " +
  "i.e. HAB_SERVICE_NAME set.)"

// ---------------------------------------------------------------------------
// Formatting helpers (shared with the legacy CLI; same byte-for-byte output)
// ---------------------------------------------------------------------------

function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
}

function pad(s: string, n: number): string {
  return s.padEnd(n)
}

/**
 * Compact a cwd path for table display — strips the user's home prefix and
 * truncates to a reasonable width. `~/Code/pim/km-wt7` is more scannable
 * than `/Users/beorn/Code/pim/km-wt7`.
 */
function fmtCwd(cwd: string | undefined, maxWidth: number = 30): string {
  if (!cwd) return "—"
  const home = process.env.HOME ?? ""
  let display = home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd
  if (display.length > maxWidth) {
    display = "…" + display.slice(display.length - (maxWidth - 1))
  }
  return display
}

// ---------------------------------------------------------------------------
// Types (subset of the daemon's reply shapes used by the read verbs)
// ---------------------------------------------------------------------------

/** Mirrors the daemon's TribePluginHandle — `error` present iff the load failed. */
interface PluginStatus {
  name: string
  active: boolean
  error?: string
}

interface SessionInfo {
  id: string
  name: string
  role: string
  domains: string[]
  pid: number
  projectName?: string
  claudeSessionId: string | null
  connectedAt: number
  uptimeMs: number
  /**
   * Wall-clock ms since this session's last inbound request. Drives the
   * `IDLE` column in `tribe sessions` / `tribe health`. Spec:
   * `@km/tribe/15588-tribe-list-sessions`.
   */
  idleMs?: number
  /**
   * Working directory the session registered from. Same value as the
   * daemon's internal `project` field, surfaced under the `cwd`
   * alias to match the bead's vocabulary.
   */
  cwd?: string
  source: "daemon" | "db"
  conn?: string
}

interface Msg {
  id: string
  type: string
  sender: string
  recipient: string
  content: string
  bead_id: string | null
  ref: string | null
  request: string | null
  reply: string | null
  ts: number
}

export type { InboxWaitResult } from "../lib/inbox-wait-options.ts"

type InboxDrainResult = {
  session: string
  unread_count: number
  oldest_unread_age_min: number
  oldest_unread_ts: number
  drained_count: number
  events: Array<{
    type: string
    from: string
    content: string
  }>
}

type InboxWaitCall = (args: {
  session?: string
  timeoutMs: number
  wakeOnCorrelatedReply: boolean
  afterSeq?: number
}) => Promise<InboxWaitChunkResult>

type InboxWaitChunkResult = InboxWaitResult & {
  /** Private daemon reconnect cursor; never exposed by the CLI. */
  baseline_seq?: number
}

const INBOX_WAIT_CHUNK_MS = 30_000
const INBOX_WAIT_RETRY_DELAY_MS = 250
const INBOX_WAIT_MAX_RETRY_DELAY_MS = 5_000
const INBOX_WAIT_UNAVAILABLE_GRACE_MS = 2_000

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

/**
 * A plugin that refused to load is reported here and nowhere else the operator
 * routinely looks. Printing it unconditionally — including when the session
 * list is empty — is the point: the 2026-08-13 outage was a plugin failure that
 * no status surface named.
 */
function printDegradedPlugins(plugins: PluginStatus[] | undefined): void {
  const failed = (plugins ?? []).filter((plugin) => plugin.error !== undefined)
  if (!failed.length) return
  console.log(`\n  DEGRADED — ${failed.length} plugin${failed.length !== 1 ? "s" : ""} disabled by a load failure:`)
  for (const plugin of failed) {
    console.log(`    ${plugin.name}: ${plugin.error?.split("\n")[0] ?? "(no cause recorded)"}`)
  }
  console.log(`  Coordination is unaffected; these plugins' signals are NOT being observed.`)
}

async function cmdStatus(): Promise<void> {
  const result = (await callDaemon("cli_status")) as {
    sessions: SessionInfo[]
    daemon: {
      pid: number
      uptime: number
      clients: number
      dbPath: string
      socketPath: string
      plugins?: PluginStatus[]
    }
  }
  const { sessions, daemon } = result

  if (!sessions.length) {
    console.log("No active tribe sessions.")
    printDegradedPlugins(daemon?.plugins)
    return
  }

  console.log(`TRIBE STATUS — ${sessions.length} session${sessions.length !== 1 ? "s" : ""} active\n`)
  const nW = Math.max(4, ...sessions.map((r) => r.name.length))
  const rW = Math.max(4, ...sessions.map((r) => r.role.length))
  const dW = Math.max(
    7,
    ...sessions.map((r) => {
      const d = r.domains ?? []
      return (d.length ? d.join(", ") : "—").length
    }),
  )
  console.log(`  ${pad("NAME", nW)}  ${pad("ROLE", rW)}  ${pad("DOMAINS", dW)}  ${pad("UPTIME", 10)}  SOURCE`)
  for (const r of sessions) {
    const d = r.domains ?? []
    console.log(
      `  ${pad(r.name, nW)}  ${pad(r.role, rW)}  ${pad(d.length ? d.join(", ") : "—", dW)}  ${pad(fmtDur(r.uptimeMs), 10)}  ${r.source}`,
    )
  }
  console.log(`\n  Daemon: pid=${daemon.pid}, uptime=${fmtDur(daemon.uptime * 1000)}, clients=${daemon.clients}`)
  printDegradedPlugins(daemon.plugins)
}

async function cmdSessions(showAll: boolean): Promise<void> {
  const result = (await callDaemon("cli_status")) as {
    sessions: SessionInfo[]
    daemon: { pid: number; uptime: number; clients: number }
  }
  let sessions = result.sessions

  if (!showAll) {
    sessions = sessions.filter((s) => s.source === "daemon")
  }

  if (!sessions.length) {
    console.log(showAll ? "No tribe sessions." : "No active tribe sessions.")
    return
  }

  console.log(`TRIBE SESSIONS — ${sessions.length} ${showAll ? "all" : "active"}\n`)
  const nW = Math.max(4, ...sessions.map((r) => r.name.length))
  const rW = Math.max(4, ...sessions.map((r) => r.role.length))
  const cwds = sessions.map((r) => fmtCwd(r.cwd))
  const cW = Math.max(3, ...cwds.map((c) => c.length))
  console.log(
    `  ${pad("NAME", nW)}  ${pad("ROLE", rW)}  ${pad("PID", 7)}  ${pad("UPTIME", 10)}  ${pad("IDLE", 8)}  ${pad("CWD", cW)}  SOURCE`,
  )
  for (let i = 0; i < sessions.length; i++) {
    const r = sessions[i]!
    const idle = typeof r.idleMs === "number" ? fmtDur(r.idleMs) : "—"
    console.log(
      `  ${pad(r.name, nW)}  ${pad(r.role, rW)}  ${pad(String(r.pid), 7)}  ${pad(fmtDur(r.uptimeMs), 10)}  ${pad(idle, 8)}  ${pad(cwds[i]!, cW)}  ${r.source}`,
    )
  }
}

/**
 * `tribe-wire members` — machine-readable member sessions via the daemon's
 * `tribe.members` handler (the same reply the MCP tool returns), printed as
 * one JSON object: `{"sessions":[...]}`. Unlike the human `sessions` verb
 * (cli_status text table), every row carries `launch_id` — the 21049
 * claim-derived launch identity the session's adapter advertised at
 * registration — plus daemon-authoritative transport and
 * owner verdicts, so a supervisor can match a
 * spawn's epoch against the JOIN EVIDENCE ITSELF instead of inferring from
 * name/row counts (tent bootstrap-epoch, @ag/super/21075 blocker 3).
 */
async function cmdMembers(showAll: boolean): Promise<void> {
  const result = mcpJsonContent(await callDaemon("tribe.members", showAll ? { all: true } : {}))
  if (result === null || typeof result !== "object" || !Array.isArray((result as { sessions?: unknown }).sessions)) {
    console.error(`tribe members: daemon returned an unexpected reply shape: ${JSON.stringify(result)}`)
    process.exit(1)
  }
  await writeJsonStdout(result)
}

function fmtMsg(m: Msg): void {
  const to = m.recipient === "*" ? "all" : m.recipient
  const txt = m.content.length > 120 ? m.content.slice(0, 117) + "..." : m.content
  const bead = m.bead_id ? ` bead=${m.bead_id}` : ""
  console.log(`  ${fmtTime(m.ts)}  ${pad(`${m.sender} → ${to}`, 28)}  [${m.type}]${bead} "${txt}"`)
}

async function cmdLog(
  limit: number,
  all: boolean,
  follow: boolean,
  json: boolean,
  refPrefix?: string,
  replyPrefix?: string,
): Promise<void> {
  if (follow && json) {
    console.error("tribe log: --follow and --json are mutually exclusive; omit --follow for one JSON snapshot")
    process.exit(2)
  }
  if (follow && all) {
    console.error("tribe log: --follow and --all are mutually exclusive; omit --all for a bounded follow snapshot")
    process.exit(2)
  }
  const params: Record<string, unknown> = all ? { all: true } : { limit }
  if (refPrefix) params.ref_prefix = refPrefix
  if (replyPrefix) params.reply_prefix = replyPrefix
  const result = (await callDaemon("cli_log", params)) as {
    messages: Msg[]
    query?: { all: boolean; ref_prefix: string | null; reply_prefix: string | null }
  }
  const rows = result.messages

  if (json) {
    await writeJsonStdout({ messages: rows, query: result.query })
    return
  }

  if (!follow) {
    if (!rows.length) {
      console.log("No messages in tribe log.")
      return
    }
    console.log(`TRIBE LOG — last ${rows.length} message${rows.length !== 1 ? "s" : ""}\n`)
    for (const m of rows) {
      fmtMsg(m)
    }
    return
  }

  // Follow mode: print recent, then subscribe to daemon notifications
  console.log(`TRIBE LOG — follow mode (Ctrl+C to quit)\n`)
  for (const m of rows) fmtMsg(m)

  // For follow mode, keep the daemon connection open and listen for notifications
  const socketPath = resolveSocketPath()
  const client = await connectToDaemon(socketPath)
  client.onNotification((method, params) => {
    if (method === "channel") {
      const ts = Date.now()
      const from = String(params?.from ?? "unknown")
      const type = String(params?.type ?? "notify")
      const content = String(params?.content ?? "")
      const to = "all"
      console.log(
        `  ${fmtTime(ts)}  ${pad(`${from} → ${to}`, 28)}  [${type}] "${content.length > 120 ? content.slice(0, 117) + "..." : content}"`,
      )
    } else if (method === "session.joined" || method === "session.left") {
      const name = String(params?.name ?? "unknown")
      const action = method === "session.joined" ? "joined" : "left"
      console.log(`  ${fmtTime(Date.now())}  [system] ${name} ${action} the tribe`)
    }
  })
  // Subscribe to push notifications
  await client.call("subscribe")
  // Also poll for new DB messages periodically
  let lastTs = rows.length ? Math.max(...rows.map((m) => m.ts)) : Date.now()
  setInterval(async () => {
    try {
      const pollParams: Record<string, unknown> = { limit: 50 }
      if (refPrefix) pollParams.ref_prefix = refPrefix
      if (replyPrefix) pollParams.reply_prefix = replyPrefix
      const newResult = (await client.call("cli_log", pollParams)) as { messages: Msg[] }
      const newMsgs = newResult.messages.filter((m) => m.ts > lastTs)
      for (const m of newMsgs) {
        fmtMsg(m)
        lastTs = m.ts
      }
    } catch {
      // Connection lost
    }
  }, 2000)
}

/**
 * Parse a `tribe pending --stale <duration>` argument (NNs|NNm|NNh) into
 * milliseconds. Returns undefined on unparseable input — the caller exits
 * with an error so the bad arg is loud.
 */
function parseStaleMs(spec: string): number | undefined {
  const match = spec.match(/^(\d+)([smh])$/)
  if (!match) return undefined
  const n = Number(match[1])
  if (!Number.isFinite(n) || n < 0) return undefined
  switch (match[2]) {
    case "s":
      return n * 1000
    case "m":
      return n * 60_000
    case "h":
      return n * 3_600_000
    default:
      return undefined
  }
}

function parseDurationMs(spec: string): number | undefined {
  return parseStaleMs(spec)
}

/**
 * Ball-tracker query — list open requests where `owner` is responsible for
 * replying. Wraps the `tribe.pending` MCP tool added in
 * @km/tribe/message-ball-tracker Phase 2a. Used by §C1 chief loop step 0.5
 * (call with `--owner @chief --stale 15m` to surface dropped balls).
 */
type PendingCliRow = {
  request_id: string
  recipient: string
  sender: string
  opened_at: string
  age_ms: number
  message_id: string
  fanout: string
  summary: string | null
  status?: "active" | "expired" | "unanswered"
  settlement?: BallSettlementReason | null
  settled_at?: string | null
  owner_transport_registered?: boolean
  owner_transport_state?: "connected" | "disconnected"
  owner_state?: "live" | "dead" | "unknown"
  owner_answer_capability?: "observed" | "not-observed"
  owner_transport_reason?: string
  owner_transport_observed_at?: string
}

function pendingOwnerTransportWarning(row: PendingCliRow): string {
  if (row.owner_answer_capability !== "not-observed") return ""
  const observedAt = row.owner_transport_observed_at ?? "unknown observation time"
  return (
    `  DEGRADED — current owner has no connected, PID-live transport as of ${observedAt}` +
    "; obligation remains open; no automatic close/reroute"
  )
}

async function cmdPending(
  owner: string | undefined,
  all: boolean,
  expired: boolean,
  owed: boolean,
  json: boolean,
  staleMs: number | undefined,
  close: string | undefined,
): Promise<void> {
  const args: Record<string, unknown> = {}
  if (all) args.all = true
  if (expired) args.expired = true
  if (owed) args.owed = true
  if (owner) args.owner = owner
  if (staleMs !== undefined) args.stale_ms = staleMs
  if (close) args.close = close
  const explicitRecoveryCommand = pendingReadRecoveryCommand(expired, owed, staleMs)
  let method = "tribe.pending"
  let rawResult: unknown
  try {
    if (close) {
      const authority = readSelfMailboxAuthorityFromEnvironment(process.env)
      method = "cli_session_pending_close_v1"
      // Null is deliberate: the daemon records the refused capability attempt
      // and returns a typed -32004 without ever reaching pending-row mutation.
      args.authority = authority
    } else if (!all && owner === undefined) {
      // A one-shot CLI socket starts life under a pending-* placeholder. An
      // implicit owner must therefore come from the launcher-minted current-
      // session authority, never from that transport context (or name hints).
      // Null is deliberate: the daemon returns a typed, named refusal when the
      // managed-session bearer is absent instead of answering count:0 for nobody.
      method = "cli_session_pending_read_v1"
      args.authority = readSelfMailboxAuthorityFromEnvironment(process.env)
    }
    rawResult = await callDaemon(method, args)
  } catch (error) {
    console.error(`tribe pending: ${pendingReadCliError(method, error, explicitRecoveryCommand)}`)
    process.exitCode = 2
    return
  }
  const result = rawResult as {
    content?: Array<{ type?: string; text?: string }>
    structuredContent?: {
      error?: string
      all?: boolean
      owner?: string
      request_id?: string
      closed?: number
      warning?: string
      pending?: PendingCliRow[]
      owners?: Array<{
        owner: string
        count: number
        oldest_age_ms: number
        pending: PendingCliRow[]
      }>
      owner_count?: number
      oldest_age_ms?: number
      count?: number
    }
  }
  const payload = result.structuredContent ?? (mcpJsonContent(result) as NonNullable<typeof result.structuredContent>)
  if (!payload) {
    console.error(
      "tribe pending: daemon returned no structured pending result. Run 'tribe doctor' to compare the running daemon with this checkout before retrying.",
    )
    process.exitCode = 2
    return
  }
  // A daemon refusal arrives as a SUCCESSFUL response carrying `error`, not as a
  // thrown RPC fault, so callDaemon passes it straight through. Without this the
  // refusal falls to `count ?? 0` below and prints "No pending requests" — a
  // confident, well-formed wrong answer to a query the daemon actually rejected.
  if (typeof payload.error === "string") {
    console.error(`tribe pending: ${payload.error}`)
    process.exitCode = 2
    return
  }
  if (invalidAuthenticatedPendingSnapshot(method, payload)) {
    console.error(
      "tribe pending: daemon returned an invalid authenticated pending snapshot; expected non-empty owner, a pending array, and non-negative integer count matching its length. Run 'tribe doctor' to compare the running daemon with this checkout before retrying.",
    )
    process.exitCode = 2
    return
  }
  if (json) {
    await writeJsonStdout(payload, 2)
    return
  }
  if (close) {
    console.log(
      `Closed ${payload.closed ?? 0} pending request(s) for ${payload.owner ?? owner ?? "(caller)"}: ${payload.request_id ?? close}`,
    )
    if (payload.warning) console.warn(`Warning: ${payload.warning}`)
    return
  }
  const count = payload.count ?? 0
  if (all) {
    if (count === 0) {
      console.log(`No ${expired ? "expired" : "pending"} requests across all owners.`)
      return
    }
    const groups = payload.owners ?? []
    console.log(
      `${count} ${expired ? "expired" : "pending"} request(s) across ${payload.owner_count ?? groups.length} owner(s):`,
    )
    for (const group of groups) {
      const oldestSec = Math.floor(group.oldest_age_ms / 1000)
      const oldest = oldestSec >= 60 ? `${Math.floor(oldestSec / 60)}m` : `${oldestSec}s`
      const ownerWarning = group.pending[0] ? pendingOwnerTransportWarning(group.pending[0]) : ""
      console.log(`  ${group.owner}: ${group.count} (oldest ${oldest} ago)${ownerWarning}`)
      for (const p of group.pending) {
        const summary = p.summary?.trim() || "(no summary)"
        const outcome = expired ? `  settlement=${p.settlement ?? "unsettled"}` : ""
        console.log(
          `    ${p.request_id}  from ${p.sender}  to ${p.recipient}  ${summary}${outcome}  (msg ${p.message_id})`,
        )
      }
    }
    return
  }
  const displayOwner = payload.owner ?? owner ?? "(caller)"
  if (count === 0) {
    console.log(`No ${expired ? "expired" : "pending"} requests for ${displayOwner}.`)
    return
  }
  console.log(`${count} ${expired ? "expired" : "pending"} request(s) for ${displayOwner}:`)
  for (const p of payload.pending ?? []) {
    const ageSec = Math.floor(p.age_ms / 1000)
    const age = ageSec >= 60 ? `${Math.floor(ageSec / 60)}m` : `${ageSec}s`
    const outcome = expired ? `  settlement=${p.settlement ?? "unsettled"}` : ""
    console.log(
      `  ${p.request_id}  from ${p.sender}  ${age} ago  fanout=${p.fanout}${outcome}  ` +
        `(msg ${p.message_id})${pendingOwnerTransportWarning(p)}`,
    )
  }
}

async function cmdHealth(): Promise<void> {
  const result = (await callDaemon("cli_health")) as {
    content: Array<{ type: string; text: string }>
    sessions?: Array<{ name: string; role: string; pid: number; cwd?: string; uptimeMs: number; idleMs: number }>
    daemon: { pid: number; uptime: number; clients: number }
  }

  console.log("TRIBE HEALTH DIAGNOSTICS\n")
  // The health response comes from tribe_health handler, which returns MCP-formatted content
  try {
    const data = mcpJsonContent(result) as Record<string, unknown>
    for (const [key, value] of Object.entries(data)) {
      if (key === "issues" && Array.isArray(value)) {
        if ((value as unknown[]).length) {
          console.log("\n  Issues:")
          for (const i of value as string[]) console.log(`    ${i}`)
        } else {
          console.log("  No issues detected.")
        }
      }
    }
    // 15588 — show the live roster section so chief can answer "who is
    // connected / who is idle >15min" with one command. Roster comes from
    // the dispatcher's cli_health response (live `clients` map, not the
    // DB), so it reflects active connections.
    if (Array.isArray(result.sessions) && result.sessions.length > 0) {
      console.log(`\n  Sessions: ${result.sessions.length} active`)
      const nW = Math.max(4, ...result.sessions.map((r) => r.name.length))
      const rW = Math.max(4, ...result.sessions.map((r) => r.role.length))
      const cwds = result.sessions.map((r) => fmtCwd(r.cwd))
      console.log(
        `    ${pad("NAME", nW)}  ${pad("ROLE", rW)}  ${pad("PID", 7)}  ${pad("UPTIME", 10)}  ${pad("IDLE", 8)}  CWD`,
      )
      for (let i = 0; i < result.sessions.length; i++) {
        const r = result.sessions[i]!
        console.log(
          `    ${pad(r.name, nW)}  ${pad(r.role, rW)}  ${pad(String(r.pid), 7)}  ${pad(fmtDur(r.uptimeMs), 10)}  ${pad(fmtDur(r.idleMs), 8)}  ${cwds[i]}`,
        )
      }
    }
    if (result.daemon) {
      console.log(
        `\n  Daemon: pid=${result.daemon.pid}, uptime=${fmtDur(result.daemon.uptime * 1000)}, clients=${result.daemon.clients}`,
      )
    }
  } catch {
    // Fallback: just print the raw result
    await writeJsonStdout(result, 2)
  }
}

// ---------------------------------------------------------------------------
// Doctor — daemon code-staleness check (@km/tribe/20033 prevention)
// ---------------------------------------------------------------------------

/**
 * @km/tribe/20033 prevention — daemon code-staleness doctor.
 *
 * The in-daemon `code_pin` detector (handleHealth) can only report staleness
 * when the running daemon is new enough to CONTAIN it. A daemon that predates
 * the detector serves old handlers AND cannot self-report — its `tribe.health()`
 * comes back with no `code_pin` field at all. `evaluateDoctor` treats that
 * absence as a positive staleness signal: a missing known-current field on a
 * method that fresh daemons always populate IS the stale signal. This is
 * bootstrap-proof, closing the gap the in-daemon detector left open — the
 * detector lives inside the daemon, so it cannot catch a daemon too old to
 * contain it; the probe must live outside (here).
 */
export interface DoctorVerdict {
  outcome: DoctorOutcome
  severity: DoctorCheckVerdict
  /** Operator-facing remedy, or null when fresh. */
  reason: string | null
  /** running/on-disk/pin SHAs when the daemon could self-report, else null. */
  detail: { running: string | null; on_disk: string | null; superproject_pin: string | null } | null
}

export type DoctorCheckVerdict = "OK" | "WARNING" | "CRITICAL" | "UNKNOWN"
export type DoctorFinalVerdict = "OK" | "FAIL" | "UNKNOWN"

export interface DoctorOutcome {
  verdict: DoctorFinalVerdict
  exitCode: 0 | 1 | 2
}

/**
 * Reduce every doctor check through one verdict algebra. UNKNOWN is worst:
 * an unanswerable check can never be collapsed into an evidence-free green.
 */
export function deriveDoctorOutcome(checks: readonly DoctorCheckVerdict[]): DoctorOutcome {
  if (checks.includes("UNKNOWN")) return { verdict: "UNKNOWN", exitCode: 2 }
  if (checks.some((check) => check === "WARNING" || check === "CRITICAL")) {
    return { verdict: "FAIL", exitCode: 1 }
  }
  return { verdict: "OK", exitCode: 0 }
}

interface DoctorHealthShape {
  code_pin?: {
    stale: boolean | null
    reason: string | null
    running: string | null
    on_disk: string | null
    superproject_pin: string | null
    /**
     * Ancestry direction of an on_disk-vs-pin mismatch (additive field; older
     * daemons omit it). evaluateDoctor doesn't branch on it today — the
     * daemon's own `reason` text is already direction-aware and is what's
     * surfaced — but the shape is declared here so it isn't silently dropped
     * by callers that log or forward the full payload.
     */
    pin_direction?: PinDirection | null
  }
}

/** Pure staleness decision — no IO, so all three classes unit-test cleanly. */
export function evaluateDoctor(health: DoctorHealthShape): DoctorVerdict {
  const cp = health.code_pin
  if (cp === undefined) {
    return {
      outcome: deriveDoctorOutcome(["UNKNOWN"]),
      severity: "UNKNOWN",
      reason:
        "running daemon predates the code_pin detector (@km/tribe/20033): its tribe.health() has no `code_pin` field, so it is too old to self-report. Stop it so the next autostart respawns from current source.",
      detail: null,
    }
  }
  const detail = { running: cp.running, on_disk: cp.on_disk, superproject_pin: cp.superproject_pin }
  const unresolved = (Object.entries(detail) as Array<[keyof typeof detail, string | null]>)
    .filter(([, value]) => value === null)
    .map(([field]) => field)
  if (unresolved.length > 0) {
    return {
      outcome: deriveDoctorOutcome(["UNKNOWN"]),
      severity: "UNKNOWN",
      reason: `cannot compare daemon code identity: unresolved ${unresolved.join(", ")}`,
      detail,
    }
  }
  if (cp.stale || cp.running !== cp.on_disk || cp.on_disk !== cp.superproject_pin) {
    const severity = cp.running !== cp.on_disk ? "CRITICAL" : "WARNING"
    return {
      outcome: deriveDoctorOutcome([severity]),
      severity,
      reason:
        cp.reason ??
        (cp.running !== cp.on_disk
          ? `running ${cp.running} != on_disk ${cp.on_disk} — restart the daemon from the on-disk source`
          : `on_disk ${cp.on_disk} != superproject_pin ${cp.superproject_pin} — materialize the pinned Tribe checkout`),
      detail,
    }
  }
  return { outcome: deriveDoctorOutcome(["OK"]), severity: "OK", reason: null, detail }
}

export type DoctorRailCheck =
  | { severity: "OK"; evidence: { messageId: string; waitedMs: number } }
  | { severity: "CRITICAL"; diagnosis: string; remedy: string }

export interface DoctorDiagnosticCheck {
  severity: DoctorCheckVerdict
  diagnosis: string
  remedy?: string
  values?: { running: string; on_disk: string; pin: string }
}

function probeFailure(probe: Exclude<GitProbe, { ok: true }>): string {
  const { path, operation, errno, message } = probe.failure
  return `${operation} failed path=${path} errno=${errno}: ${message}`
}

/**
 * `pinDirection` is an INPUT, not derived here: resolving ancestry needs
 * `git merge-base --is-ancestor` (IO), and this check is tested with
 * fabricated GitProbe values, no live git — mirrors the same pure/impure
 * split as code-pin.ts's evaluateCodePin. Callers (cmdDoctor) resolve
 * direction via resolvePinDirection and pass the fact in; pass null when
 * on_disk/pin don't differ (direction moot) or wasn't computed.
 */
export function evaluateDoctorIdentity(
  reported: { cert: string | null; root: string } | undefined,
  resolved: CheckoutCodeIdentity | undefined,
  pinDirection: PinDirection | null,
): DoctorDiagnosticCheck {
  if (reported === undefined) {
    return {
      severity: "UNKNOWN",
      diagnosis: "daemon status did not report code identity path=? errno=UNSUPPORTED_CODE_IDENTITY",
      remedy: "materialize current Tribe code, reload the daemon, then re-run `tribe doctor`",
    }
  }
  if (!reported.root || reported.cert === null) {
    return {
      severity: "UNKNOWN",
      diagnosis: `daemon code identity is unresolved path=${reported.root || "?"} errno=UNREPORTED_CERT`,
      remedy: "reload the daemon from a Git-backed Tribe checkout, then re-run `tribe doctor`",
    }
  }
  if (resolved === undefined) {
    return { severity: "UNKNOWN", diagnosis: `checkout identity was not resolved path=${reported.root} errno=NO_PROBE` }
  }
  if (!resolved.onDisk.ok) {
    return { severity: "UNKNOWN", diagnosis: probeFailure(resolved.onDisk) }
  }
  if (!resolved.superprojectPin.ok) {
    // `git rev-parse --show-superproject-working-tree` exits 0 with empty
    // output when this checkout has no superproject — e.g. CI's own
    // standalone checkout of tribe, or any bare `git clone`. That is a fact
    // about the checkout shape, not a probe failure: `probeGitValue` folds
    // it into EMPTY_RESULT specifically so callers can tell it apart from a
    // genuine error (git missing, corrupt repo, permission denied — all of
    // which keep their own distinct errno and still fall through to
    // UNKNOWN below). With no pin to compare against, identity reduces to
    // running-vs-on-disk only.
    if (resolved.superprojectPin.failure.errno !== "EMPTY_RESULT") {
      return { severity: "UNKNOWN", diagnosis: probeFailure(resolved.superprojectPin) }
    }
    if (reported.cert !== resolved.onDisk.value) {
      return {
        severity: "CRITICAL",
        diagnosis:
          `daemon code integrity mismatch running=${reported.cert} on_disk=${resolved.onDisk.value} ` +
          "pin=none (standalone checkout, no superproject)",
        remedy:
          "the daemon is running a different module root; restarting will not help. Advance the daemon module root, then re-run `tribe doctor`",
      }
    }
    return {
      severity: "OK",
      diagnosis: `running=${reported.cert} on_disk=${resolved.onDisk.value} pin=none (standalone checkout, no superproject)`,
    }
  }
  const values = {
    running: reported.cert,
    on_disk: resolved.onDisk.value,
    pin: resolved.superprojectPin.value,
  }
  if (values.running !== values.on_disk) {
    return {
      severity: "CRITICAL",
      values,
      diagnosis: `daemon code integrity mismatch running=${values.running} on_disk=${values.on_disk} pin=${values.pin}`,
      remedy:
        "the daemon is running a different module root; restarting will not help. Advance the daemon module root, then re-run `tribe doctor`",
    }
  }
  if (values.on_disk !== values.pin) {
    if (pinDirection === "checkout-ahead") {
      return {
        severity: "WARNING",
        values,
        diagnosis:
          `Tribe checkout is ahead of its host pin running=${values.running} on_disk=${values.on_disk} pin=${values.pin} ` +
          "(the pin lags the checkout; convergence pending elsewhere)",
        remedy:
          "no daemon action needed; do NOT materialize the submodule from this pin, it would roll the checkout " +
          "backward. If the pin itself needs to move, that is a superproject change made upstream, not a `tribe doctor` remedy.",
      }
    }
    if (pinDirection === "divergent") {
      return {
        severity: "WARNING",
        values,
        diagnosis:
          `Tribe checkout and its host pin have diverged running=${values.running} on_disk=${values.on_disk} pin=${values.pin} ` +
          "(neither is an ancestor of the other)",
        remedy: "investigate before acting; no mechanical remedy applies here",
      }
    }
    if (pinDirection === "checkout-behind") {
      return {
        severity: "WARNING",
        values,
        diagnosis: `Tribe checkout is behind its host pin running=${values.running} on_disk=${values.on_disk} pin=${values.pin}`,
        remedy:
          `resolve the superproject with \`git -C ${JSON.stringify(reported.root)} rev-parse --show-superproject-working-tree\`, ` +
          "materialize its pinned Tribe submodule, then re-run `tribe doctor`",
      }
    }
    return {
      severity: "UNKNOWN",
      values,
      diagnosis:
        `Tribe checkout differs from its host pin running=${values.running} on_disk=${values.on_disk} pin=${values.pin}, ` +
        "but ancestry between them could not be resolved (unknown-direction)",
      remedy: "do not guess; inspect both commits (e.g. fetch missing objects) before acting",
    }
  }
  return {
    severity: "OK",
    values,
    diagnosis: `running=${values.running} on_disk=${values.on_disk} pin=${values.pin}`,
  }
}

type DoctorVersionRow = {
  name: string
  protocol_versions?: number[]
  version_state?: "current" | "version-degraded" | "version-unknown" | string
}

export function evaluateDoctorVersions(
  daemonProtocol: number | undefined,
  sessions: readonly DoctorVersionRow[],
): DoctorDiagnosticCheck {
  if (daemonProtocol === undefined) {
    return { severity: "UNKNOWN", diagnosis: "daemon protocol version is unresolved" }
  }
  const degraded = sessions
    .filter((session) => session.version_state === "version-degraded")
    .map(
      (session) =>
        `${session.name}=version-degraded(${(session.protocol_versions ?? []).map((v) => `v${v}`).join(",") || "unknown"})`,
    )
  if (daemonProtocol < TRIBE_PROTOCOL_VERSION) degraded.unshift(`daemon=version-degraded(v${daemonProtocol})`)
  if (degraded.length > 0) {
    return {
      severity: "WARNING",
      diagnosis: degraded.join(" "),
      remedy: "finish the rolling Tribe restart so every daemon and seat negotiates the current wire version",
    }
  }
  const unknown = sessions
    .filter(
      (session) =>
        session.version_state === undefined ||
        session.version_state === "version-unknown" ||
        !Array.isArray(session.protocol_versions),
    )
    .map((session) => session.name)
  if (unknown.length > 0) {
    return { severity: "UNKNOWN", diagnosis: `wire version unresolved for ${unknown.join(", ")}` }
  }
  const seats = sessions.map(
    (session) =>
      `${session.name}:${(session.protocol_versions ?? []).map((version) => `v${version}`).join(",") || "none"}`,
  )
  return {
    severity: "OK",
    diagnosis: `daemon=v${daemonProtocol} seats=${seats.join(" ") || "none"}`,
  }
}

type DoctorMembershipRow = { name: string; transport_state?: string }
type DoctorMembershipDiscrepancy = { status?: string; missing?: Array<{ name: string; state: string }> }

export function evaluateDoctorMembership(
  sessions: readonly DoctorMembershipRow[],
  discrepancy: DoctorMembershipDiscrepancy | undefined,
): DoctorDiagnosticCheck {
  const states = new Map(sessions.map((session) => [session.name, session.transport_state ?? "unknown"]))
  for (const missing of discrepancy?.missing ?? []) states.set(missing.name, missing.state)
  const evidence = [...states].map(([name, state]) => `${name}=${state}`).join(" ") || "seats=none"
  if ([...states.values()].some((state) => state === "unknown")) {
    return { severity: "UNKNOWN", diagnosis: `membership rail state unresolved: ${evidence}` }
  }
  if (discrepancy?.status === "degraded" || [...states.values()].some((state) => state !== "connected")) {
    return {
      severity: "WARNING",
      diagnosis: `membership degraded: ${evidence}`,
      remedy: "rejoin each disconnected or missing-transport seat, then re-run `tribe doctor`",
    }
  }
  return { severity: "OK", diagnosis: `connected=${states.size} missing=0 ${evidence}` }
}

type DoctorConnect = typeof connectToDaemon

/**
 * Exercise the coordination rail through its ordinary write + long-poll
 * paths. The pending sender and ephemeral receiver are isolated from every
 * live seat identity; the receiver consumes the canary before disconnecting.
 */
export async function probeDoctorRail(
  socketPath = resolveSocketPath(),
  connect: DoctorConnect = connectToDaemon,
): Promise<DoctorRailCheck> {
  let receiver: DaemonClient | undefined
  let sender: DaemonClient | undefined
  try {
    receiver = await connect(socketPath, { callTimeoutMs: 3_000 })
    sender = await connect(socketPath, { callTimeoutMs: 3_000 })
    const registered = mcpJsonContent(
      await receiver.call("register", {
        name: "tribe-doctor-canary",
        role: "member",
        domains: ["diagnostics"],
        delivery: "pull",
        project: process.cwd(),
        projectName: process.cwd().split("/").filter(Boolean).at(-1) ?? "unknown",
        pid: process.pid,
        protocolVersion: TRIBE_PROTOCOL_VERSION - 1,
        supportedProtocolVersions: [...TRIBE_SUPPORTED_PROTOCOL_VERSIONS],
      }),
    ) as { name?: unknown }
    if (typeof registered.name !== "string" || registered.name.length === 0) {
      throw new Error("daemon registration returned no canary mailbox name")
    }
    const mailbox = registered.name
    // Both requests share one sender socket. JSON-RPC request ordering makes
    // the wait arm before the send is dispatched, while the daemon's
    // concurrent request callbacks let the send wake that pending wait.
    const waitPromise = sender.call(
      "cli_inbox_wait",
      { session: mailbox, timeout_ms: 2_000 },
      { timeoutMs: 2_500 },
    ) as Promise<{ status?: unknown; timed_out?: unknown; waited_ms?: unknown }>
    const sendPromise = sender.call("tribe.send", {
      to: mailbox,
      message: "tribe doctor coordination-rail canary",
      type: "verdict",
      delivery: "pull",
      summary: "doctor rail canary",
    })
    const [waited, sentRaw] = await Promise.all([waitPromise, sendPromise])
    const sent = mcpJsonContent(sentRaw) as { sent?: unknown; id?: unknown; error?: unknown }
    if (sent.error !== undefined) throw new Error(String(sent.error))
    if (sent.sent !== true || typeof sent.id !== "string") {
      throw new Error("daemon send did not acknowledge the canary message")
    }
    if (waited.status !== "woken" || waited.timed_out !== false) {
      throw new Error(`long-poll returned status=${String(waited.status)} timed_out=${String(waited.timed_out)}`)
    }

    // 21757 — no model is behind the doctor's canary read; do not let a
    // health probe acknowledge a mailbox or stamp an attention read.
    await receiver.call("tribe.fetch", { receipt: false })
    return {
      severity: "OK",
      evidence: {
        messageId: sent.id,
        waitedMs: typeof waited.waited_ms === "number" ? waited.waited_ms : 0,
      },
    }
  } catch (error) {
    const code = (error as { code?: unknown }).code
    const detail = error instanceof Error ? error.message : String(error)
    return {
      severity: "CRITICAL",
      diagnosis: `rail canary failed${code === undefined ? "" : ` (${String(code)})`}: ${detail}`,
      remedy: 'run `tribe restart --reason "doctor rail canary failed"`, then re-run `tribe doctor`',
    }
  } finally {
    sender?.close()
    receiver?.close()
  }
}

/** Extract the health payload from a callDaemon result (MCP-wrapped or raw). */
function parseDoctorHealth(raw: unknown): DoctorHealthShape {
  return (mcpJsonContent(raw) ?? {}) as DoctorHealthShape
}

function inboxWaitProtocolMismatchError(daemonProtocolVersion: number | null, health: DoctorHealthShape): Error {
  const pins = health.code_pin
  return Object.assign(
    new Error(
      "Inbox-wait protocol version mismatch: " +
        `client=${TRIBE_PROTOCOL_VERSION} daemon=${daemonProtocolVersion ?? "unsupported"}; ` +
        `running=${pins?.running ?? "?"} on_disk=${pins?.on_disk ?? "?"} pin=${pins?.superproject_pin ?? "?"}. ` +
        "Materialize the pinned Tribe checkout and restart the daemon before retrying.",
    ),
    { code: INBOX_WAIT_PROTOCOL_MISMATCH },
  )
}

async function assertInboxWaitProtocol(client: DaemonClient, timeoutMs: number): Promise<void> {
  let daemonProtocolVersion: number | null = null
  try {
    const result = (await client.call("cli_protocol", undefined, { timeoutMs })) as {
      protocol_version?: unknown
    }
    if (typeof result.protocol_version === "number") {
      daemonProtocolVersion = result.protocol_version
    }
  } catch (err) {
    if ((err as { code?: unknown }).code !== -32601) throw err
  }

  if (daemonProtocolVersion !== null && isSupportedProtocolVersion(daemonProtocolVersion)) return

  let health: DoctorHealthShape = {}
  try {
    health = parseDoctorHealth(await client.call("tribe.health", undefined, { timeoutMs }))
  } catch {
    // The protocol verdict is already authoritative. Health is best-effort
    // diagnostic enrichment for daemons too old to expose code-pin details.
  }
  throw inboxWaitProtocolMismatchError(daemonProtocolVersion, health)
}

async function cmdDoctor(opts: { fix?: boolean }): Promise<void> {
  let status: {
    sessions?: DoctorVersionRow[]
    daemon?: {
      protocol_version?: number
      code_identity?: { cert: string | null; root: string }
    }
  } = {}
  try {
    status = (await callDaemon("cli_status")) as typeof status
  } catch {
    // silent-fallback-allow: older daemons omit cli_status; doctor marks UNKNOWN
  }
  let daemonProtocol = status.daemon?.protocol_version
  if (daemonProtocol === undefined) {
    try {
      const protocol = (await callDaemon("cli_protocol")) as { protocol_version?: unknown }
      if (typeof protocol.protocol_version === "number") daemonProtocol = protocol.protocol_version
    } catch {
      // silent-fallback-allow: cli_protocol unresolved → doctor UNKNOWN, not a fake version
    }
  }
  const rawReportedIdentity = status.daemon?.code_identity
  const reportedIdentity =
    rawReportedIdentity &&
    typeof rawReportedIdentity.root === "string" &&
    (typeof rawReportedIdentity.cert === "string" || rawReportedIdentity.cert === null)
      ? rawReportedIdentity
      : undefined
  const resolvedIdentity =
    reportedIdentity?.root && typeof reportedIdentity.root === "string"
      ? resolveCheckoutCodeIdentity(reportedIdentity.root)
      : undefined
  // Same precondition as gatherCodePin: only worth resolving ancestry when
  // on_disk and pin actually differ (and both resolved in the first place).
  const identityPinDirection =
    reportedIdentity?.root &&
    resolvedIdentity?.onDisk.ok &&
    resolvedIdentity.superprojectPin.ok &&
    resolvedIdentity.onDisk.value !== resolvedIdentity.superprojectPin.value
      ? resolvePinDirection(
          reportedIdentity.root,
          resolvedIdentity.onDisk.value,
          resolvedIdentity.superprojectPin.value,
        )
      : null
  const identity = evaluateDoctorIdentity(reportedIdentity, resolvedIdentity, identityPinDirection)
  const versions = evaluateDoctorVersions(daemonProtocol, status.sessions ?? [])

  let membership: DoctorDiagnosticCheck
  try {
    const members = mcpJsonContent(await callDaemon("tribe.members")) as {
      sessions?: DoctorMembershipRow[]
      membership_discrepancy?: DoctorMembershipDiscrepancy
    }
    if (members === null || typeof members !== "object" || !Array.isArray(members.sessions)) {
      throw new Error(`daemon returned an unexpected members shape: ${JSON.stringify(members)}`)
    }
    membership = evaluateDoctorMembership(members.sessions, members.membership_discrepancy)
  } catch (error) {
    membership = {
      severity: "UNKNOWN",
      diagnosis: `membership query failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const rail = await probeDoctorRail()
  const outcome = deriveDoctorOutcome([identity.severity, versions.severity, membership.severity, rail.severity])

  console.log("TRIBE DOCTOR — coordination rail + daemon code identity\n")
  if (identity.severity === "OK") {
    console.log(`  OK — code identity ${identity.diagnosis}`)
  } else {
    console.error(`  ${identity.severity} — code identity: ${identity.diagnosis}`)
    if (identity.remedy) console.error(`  REMEDY — ${identity.remedy}`)
  }
  if (versions.severity === "OK") {
    console.log(`  OK — wire versions ${versions.diagnosis}`)
  } else {
    console.error(`  ${versions.severity} — wire versions: ${versions.diagnosis}`)
    if (versions.remedy) console.error(`  REMEDY — ${versions.remedy}`)
  }
  if (membership.severity === "OK") {
    console.log(`  OK — membership ${membership.diagnosis}`)
  } else {
    console.error(`  ${membership.severity} — ${membership.diagnosis}`)
    if (membership.remedy) console.error(`  REMEDY — ${membership.remedy}`)
  }

  if (rail.severity === "OK") {
    console.log(`  OK — rail canary message=${rail.evidence.messageId} waited_ms=${rail.evidence.waitedMs}`)
  } else {
    console.error(`  CRITICAL — ${rail.diagnosis}`)
    console.error(`  REMEDY — ${rail.remedy}`)
  }

  if (outcome.verdict === "OK") {
    return
  }

  console.error(`\n  FINAL ${outcome.verdict} — derived from the worst doctor check.`)
  if (opts.fix) console.error("  --fix is read-only; execute the diagnosis-specific REMEDY line(s) above.")
  process.exitCode = outcome.exitCode
}

/**
 * Inbox status — count + age of unanswered actionable attention: unread
 * attention messages plus open balls without an owner TAKING receipt. JSON
 * when `--json` is set; otherwise a human-readable summary. Used by
 * `tools/agent-rig/hooks/chief-drain-check.sh` and its installed
 * `.agents/hooks` twin.
 * Delivery-attention lineage: @ag/tribe/21626-per-seat-inbox-staleness-alarm.
 */
async function cmdInboxStatus(opts: { session?: string; json?: boolean }): Promise<void> {
  const result = (await callDaemon(cliInboxMethod("status", opts.session), cliInboxTargetParams(opts.session))) as {
    session: string
    unread_count: number
    oldest_unread_age_min: number
    oldest_unread_ts: number
  }
  if (opts.json) {
    await writeJsonStdout(result)
    return
  }
  const n = result.unread_count
  if (n === 0) {
    console.log(`${result.session}: no unanswered actionables.`)
    return
  }
  console.log(
    `${result.session}: ${n} unanswered actionable item${n === 1 ? "" : "s"}, ` +
      `oldest ${result.oldest_unread_age_min}min ago.`,
  )
}

function readOperatorCapabilityFromInheritedFd(fdRaw: string | undefined): string | undefined {
  if (fdRaw === undefined) return undefined
  const fd = Number(fdRaw)
  if (!Number.isSafeInteger(fd) || fd < 3) {
    throw new Error(`TRIBE_OPERATOR_CAPABILITY_FD must name an inherited fd >= 3, received ${JSON.stringify(fdRaw)}`)
  }
  const capability = readFileSync(fd, "utf8").trim()
  if (!capability) throw new Error("TRIBE_OPERATOR_CAPABILITY_FD contained an empty operator capability")
  return capability
}

async function cmdInboxDrain(opts: {
  session?: string
  limit?: number
  json?: boolean
  peek?: boolean
}): Promise<void> {
  const result = (await callDaemon(cliInboxMethod("drain", opts.session), {
    ...cliInboxTargetParams(opts.session),
    limit: opts.limit ?? 10,
    peek: opts.peek,
    // The fd number is public process metadata; the capability content never
    // enters env/argv, where another same-user process could inspect it.
    operator_capability: readOperatorCapabilityFromInheritedFd(process.env.TRIBE_OPERATOR_CAPABILITY_FD),
  })) as InboxDrainResult
  if (opts.json) {
    if (!opts.peek) {
      console.error(
        `tribe inbox-drain: read was destructive; messages consumed and cursor advanced. Use --peek to read without consuming.`,
      )
    }
    await writeJsonStdout(result)
    return
  }
  for (const event of result.events) {
    console.log(`${event.from} [${event.type}]`)
    console.log(event.content)
  }
  if (opts.peek) {
    console.log(
      `${result.session} (PEEK): viewed ${result.drained_count} actionable DM${result.drained_count === 1 ? "" : "s"}; ` +
        `${result.unread_count} remaining.`,
    )
  } else {
    console.log(
      `[CONSUMED] ${result.session}: drained ${result.drained_count} actionable DM${result.drained_count === 1 ? "" : "s"}; ` +
        `${result.unread_count} remaining.`,
    )
    console.log(
      `\n(Note: this drain consumed the messages and advanced the cursor. Use --peek to read without consuming.)`,
    )
  }
}

interface SelfInboxEvent {
  id?: string
  from?: string
  type?: string
  content?: string
}

interface SelfInboxResult {
  attention?: {
    /** 21757 — retention archived unread actionables while this seat was dormant. */
    pruned?: { count?: number; before?: string; recorded_at?: string }
    actionable_unread?: SelfInboxEvent[]
    pending_balls?: Array<{ request_id?: string; sender?: string; summary?: string }>
    pending_balls_summary?: { total?: number }
  }
  events?: SelfInboxEvent[]
  cursor?: number
}

function printSelfInboxEvent(event: SelfInboxEvent): void {
  console.log(`${event.from ?? "unknown"} [${event.type ?? "message"}]`)
  console.log(event.content ?? "")
}

async function cmdInbox(opts: { limit?: number; json?: boolean; peek?: boolean }): Promise<void> {
  const authority = readSelfMailboxAuthorityFromEnvironment(process.env)
  if (authority === null) {
    throw new Error(`${AG_SESSION_AUTH_ENV} is missing; this managed session has no self-mailbox authority source`)
  }
  const result = mcpJsonContent(
    await callDaemon("cli_self_inbox_v1", { authority, limit: opts.limit ?? 50, peek: opts.peek }),
  ) as SelfInboxResult
  if (opts.json) {
    if (!opts.peek) {
      console.error(
        `tribe inbox: read was destructive; messages consumed and cursor advanced. Use --peek to read without consuming.`,
      )
    }
    await writeJsonStdout(result)
    return
  }
  const actionable = result.attention?.actionable_unread ?? []
  const actionableIds = new Set(actionable.map((event) => event.id).filter((id): id is string => id !== undefined))
  const pruned = result.attention?.pruned
  if (pruned !== undefined) {
    // 21757 — loud by design: this seat was dormant past the retention live
    // window and lost attention rows to archival. They are not gone: the
    // archive is fetchable by id or history.
    console.log(
      `PRUNED: ${pruned.count ?? "?"} unread actionable row(s) addressed to you were archived before ${pruned.before ?? "?"} while this seat was dormant (recorded ${pruned.recorded_at ?? "?"}). ` +
        `They no longer appear in attention. Recover with: tribe log --json (history) or the MCP fetch with:<peer>. This notice is shown once.`,
    )
  }
  for (const event of actionable) printSelfInboxEvent(event)
  for (const event of result.events ?? []) {
    if (event.id !== undefined && actionableIds.has(event.id)) continue
    printSelfInboxEvent(event)
  }
  const pending = result.attention?.pending_balls ?? []
  for (const ball of pending) {
    console.log(`pending from ${ball.sender ?? "unknown"} [${ball.request_id ?? "unidentified"}]`)
    console.log(ball.summary ?? "")
  }
  const pendingTotal = result.attention?.pending_balls_summary?.total ?? pending.length

  if (opts.peek) {
    console.log(
      `inbox (PEEK): ${actionable.length} actionable unread; ${pendingTotal} pending ball(s); cursor ${result.cursor ?? 0}.`,
    )
  } else {
    console.log(
      `[CONSUMED] inbox: ${actionable.length} actionable unread; ${pendingTotal} pending ball(s); cursor ${result.cursor ?? 0}.`,
    )
    console.log(
      `\n(Note: this read consumed the messages and advanced the cursor. Use --peek to read without consuming.)`,
    )
  }
}

interface InboxDrainFailureProjection {
  code: number | string | null
  kind: string
  message: string
  reason: string
}

function projectInboxDrainFailure(error: unknown): InboxDrainFailureProjection {
  const failure = error instanceof Error ? (error as Error & { code?: unknown; data?: unknown }) : undefined
  const data =
    typeof failure?.data === "object" && failure.data !== null ? (failure.data as Record<string, unknown>) : undefined
  return {
    code: typeof failure?.code === "number" || typeof failure?.code === "string" ? failure.code : null,
    // An older daemon can return -32003 without saying whether it evaluated a
    // credential. That evidence is indeterminate, never proof of rejection.
    kind: typeof data?.kind === "string" ? data.kind : "could-not-evaluate",
    message: failure?.message ?? String(error),
    reason: typeof data?.reason === "string" ? data.reason : "unclassified-authority-failure",
  }
}

function renderInboxDrainFailure(error: unknown, json: boolean): void {
  const failure = projectInboxDrainFailure(error)
  if (json) {
    console.error(JSON.stringify({ error: failure }))
    return
  }
  console.error(`tribe inbox-drain: ${failure.kind} — ${failure.message} (reason=${failure.reason})`)
}

type InboxWaitErrorKind = "transport-close" | "daemon-unavailable" | null

function inboxWaitErrorKind(err: unknown): InboxWaitErrorKind {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === "ENOENT" || code === "ECONNREFUSED") return "daemon-unavailable"
  if (code === "ECONNRESET" || code === "EPIPE") return "transport-close"
  const message = err instanceof Error ? err.message : String(err)
  return /connection closed|socket closed|socket hang up|closed before response|request cli_inbox_wait timed out/i.test(
    message,
  )
    ? "transport-close"
    : null
}

export function isRetryableInboxWaitError(err: unknown): boolean {
  return inboxWaitErrorKind(err) !== null
}

function totalWaited(
  result: InboxWaitChunkResult,
  startedAt: number,
  now: () => number,
  effectiveTimeoutMs: number,
): InboxWaitResult {
  const publicResult = { ...result }
  delete publicResult.baseline_seq
  return {
    ...publicResult,
    waited_ms: Math.max(result.waited_ms, Math.max(0, now() - startedAt)),
    effective_timeout_ms: effectiveTimeoutMs,
  }
}

function logicalTimeoutInboxWaitResult(
  latest: InboxWaitResult | undefined,
  lastRetryableError: unknown,
  startedAt: number,
  now: () => number,
  effectiveTimeoutMs: number,
): InboxWaitResult {
  if (latest === undefined) {
    if (lastRetryableError !== undefined) throw lastRetryableError
    throw new Error("Inbox wait ended without an authoritative daemon result")
  }
  if (latest.aborted) {
    return totalWaited(latest, startedAt, now, effectiveTimeoutMs)
  }
  return totalWaited(
    {
      ...latest,
      status: "timeout",
      timed_out: true,
    },
    startedAt,
    now,
    effectiveTimeoutMs,
  )
}

export async function waitForInboxWithReconnect(opts: {
  session?: string
  timeoutMs: number
  call: InboxWaitCall
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  maxChunkMs?: number
  retryDelayMs?: number
  unavailableGraceMs?: number
  wakeOnCorrelatedReply?: boolean
}): Promise<InboxWaitResult> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const maxChunkMs = opts.maxChunkMs ?? INBOX_WAIT_CHUNK_MS
  const retryDelayMs = Math.max(0, opts.retryDelayMs ?? INBOX_WAIT_RETRY_DELAY_MS)
  const unavailableGraceMs = opts.unavailableGraceMs ?? INBOX_WAIT_UNAVAILABLE_GRACE_MS
  const controls = resolveInboxWaitControls({
    timeout_ms: opts.timeoutMs,
    wake_on_correlated_reply: opts.wakeOnCorrelatedReply,
  })
  const startedAt = now()
  const deadline = startedAt + controls.timeoutMs
  let latestResult: InboxWaitResult | undefined
  let lastRetryableError: unknown
  let attempted = false
  let afterSeq: number | undefined
  let consecutiveRetryableErrors = 0

  while (true) {
    const remainingMs = Math.max(0, deadline - now())
    if (attempted && remainingMs <= 0) {
      return logicalTimeoutInboxWaitResult(latestResult, lastRetryableError, startedAt, now, controls.timeoutMs)
    }

    try {
      attempted = true
      const result = await opts.call({
        session: opts.session,
        timeoutMs: Math.min(maxChunkMs, remainingMs),
        wakeOnCorrelatedReply: controls.wakeOnCorrelatedReply,
        ...(afterSeq === undefined ? {} : { afterSeq }),
      })
      consecutiveRetryableErrors = 0
      if (Number.isSafeInteger(result.baseline_seq) && Number(result.baseline_seq) >= 0) {
        afterSeq = Number(result.baseline_seq)
      }
      latestResult = result
      lastRetryableError = undefined
      if (result.reconnect === true) {
        continue
      }
      if (result.aborted) {
        return totalWaited(result, startedAt, now, controls.timeoutMs)
      }
      if (!result.timed_out) {
        return totalWaited(result, startedAt, now, controls.timeoutMs)
      }
      if (now() >= deadline) {
        return logicalTimeoutInboxWaitResult(result, lastRetryableError, startedAt, now, controls.timeoutMs)
      }
      continue
    } catch (err) {
      const kind = inboxWaitErrorKind(err)
      if (!kind) throw err
      lastRetryableError = err
      if (kind === "daemon-unavailable" && latestResult === undefined && now() - startedAt >= unavailableGraceMs) {
        throw err
      }
      const afterErrorRemainingMs = Math.max(0, deadline - now())
      if (afterErrorRemainingMs <= 0) {
        return logicalTimeoutInboxWaitResult(latestResult, lastRetryableError, startedAt, now, controls.timeoutMs)
      }
      const retryBackoffMs = Math.min(
        INBOX_WAIT_MAX_RETRY_DELAY_MS,
        retryDelayMs * 2 ** Math.min(consecutiveRetryableErrors, 30),
      )
      consecutiveRetryableErrors += 1
      const pauseMs = Math.min(retryBackoffMs, afterErrorRemainingMs)
      if (pauseMs > 0) await sleep(pauseMs)
    }
  }
}

async function callInboxWaitChunk(
  method: string,
  target: Record<string, unknown>,
  timeoutMs: number,
  wakeOnCorrelatedReply: boolean,
  afterSeq?: number,
): Promise<InboxWaitChunkResult> {
  const socketPath = resolveSocketPath()
  const callTimeoutMs = deriveInboxWaitCallTimeoutMs(timeoutMs)
  const client = await connectToDaemon(socketPath, { callTimeoutMs })
  try {
    await assertInboxWaitProtocol(client, deriveInboxWaitCallTimeoutMs(0))
    const raw = await client.call(
      method,
      {
        ...target,
        timeout_ms: timeoutMs,
        ...(wakeOnCorrelatedReply ? { wake_on_correlated_reply: true } : {}),
        ...(afterSeq === undefined ? {} : { after_seq: afterSeq }),
      },
      { timeoutMs: callTimeoutMs },
    )
    const parsed = parseInboxWaitResult(raw)
    const baselineSeq = (raw as { baseline_seq?: unknown }).baseline_seq
    if (!Number.isSafeInteger(baselineSeq) || Number(baselineSeq) < 0) {
      throw new Error("Inbox-wait daemon omitted the private reconnect baseline")
    }
    return { ...parsed, baseline_seq: Number(baselineSeq) }
  } catch (err) {
    if ((err as { code?: unknown }).code === -32601 && method.endsWith("_by_launch_v1")) {
      throw new Error(STALE_MANAGED_INBOX_DAEMON_ERROR)
    }
    throw err
  } finally {
    client.close()
  }
}

async function cmdInboxWait(opts: {
  session?: string
  timeoutMs?: number
  wakeOnCorrelatedReply?: boolean
  json?: boolean
}): Promise<void> {
  const controls = resolveInboxWaitControls({
    timeout_ms: opts.timeoutMs,
    wake_on_correlated_reply: opts.wakeOnCorrelatedReply,
  })
  const target = cliInboxTargetParams(opts.session)
  let result: InboxWaitResult
  try {
    result = await waitForInboxWithReconnect({
      session: opts.session,
      timeoutMs: controls.timeoutMs,
      wakeOnCorrelatedReply: controls.wakeOnCorrelatedReply,
      call: ({ timeoutMs: chunkTimeoutMs, wakeOnCorrelatedReply, afterSeq }) =>
        callInboxWaitChunk(
          cliInboxMethod("wait", opts.session),
          target,
          chunkTimeoutMs,
          wakeOnCorrelatedReply,
          afterSeq,
        ),
    })
  } catch (err) {
    if ((err as { code?: unknown }).code !== INBOX_WAIT_PROTOCOL_MISMATCH) throw err
    console.error(`tribe inbox-wait: ${(err as Error).message}`)
    process.exitCode = 1
    return
  }
  if (opts.json) {
    await writeJsonStdout(result)
    return
  }
  if (result.aborted) {
    console.log(`${result.session}: inbox wait aborted.`)
    return
  }
  if (result.timed_out) {
    console.log(`${result.session}: no unanswered actionables within ${Math.round(controls.timeoutMs / 1000)}s.`)
    process.exitCode = 64
    return
  }
  if (result.unread_count === 0) {
    console.log(`${result.session}: actionable inbox attention is available.`)
    return
  }
  const n = result.unread_count
  console.log(
    `${result.session}: ${n} unanswered actionable item${n === 1 ? "" : "s"}, ` +
      `oldest ${result.oldest_unread_age_min}min ago (waited ${Math.round(result.waited_ms / 1000)}s).`,
  )
}

export type RepairCliOptions = {
  session?: string
  inboxCursor?: string
  reapStaleTransports?: boolean
  json?: boolean
}

export function resolveRepairOptions(
  opts: RepairCliOptions,
):
  | { params: { session: string; inbox_cursor: string; reap_stale_transports?: never } }
  | { params: { reap_stale_transports: true; session?: never; inbox_cursor?: never } }
  | { error: string } {
  if (opts.inboxCursor !== undefined && opts.reapStaleTransports === true) {
    return { error: "--inbox-cursor and --reap-stale-transports are mutually exclusive" }
  }
  if (opts.reapStaleTransports === true) {
    return { params: { reap_stale_transports: true } }
  }

  const inboxCursor = opts.inboxCursor ?? "tail"
  const allowedInboxCursors = cliOption(REPAIR_CLI, "inbox-cursor").enum ?? []
  if (!allowedInboxCursors.includes(inboxCursor)) {
    return { error: `bad --inbox-cursor '${inboxCursor}' (expected ${allowedInboxCursors.join("|")})` }
  }
  return { params: { session: opts.session ?? "@chief", inbox_cursor: inboxCursor } }
}

async function cmdRepair(opts: RepairCliOptions): Promise<void> {
  const resolved = resolveRepairOptions(opts)
  if ("error" in resolved) {
    console.error(`tribe repair: ${resolved.error}`)
    process.exit(2)
  }

  const result = mcpJsonContent(await callDaemon("tribe.repair", resolved.params)) as {
    error?: string
    repaired?: boolean
    session?: string
    repair?: string
    cursor_before?: number
    cursor_after?: number
    tail?: number
    mailbox_cursor_before?: number
    mailbox_cursor_after?: number
    mailbox_reconcile_reason?: string
    examined?: number
    reaped?: number
    reason_counts?: Record<string, number>
  }

  if (opts.json) {
    await writeJsonStdout(result)
    return
  }
  if (result.error) {
    console.error(`tribe repair: ${result.error}`)
    process.exit(1)
  }

  if (result.repair === "reap_stale_transports") {
    const reasons = Object.entries(result.reason_counts ?? {})
      .map(([reason, count]) => `${reason}=${count}`)
      .join(" ")
    console.log(
      `Reaped ${result.reaped ?? 0}/${result.examined ?? 0} stale transport rows${reasons ? ` (${reasons})` : ""}.`,
    )
    return
  }

  const verb = result.repaired === true ? "Repaired" : "Checked"
  console.log(
    `${verb} ${result.session ?? opts.session ?? "@chief"}: inbox cursor ` +
      `${result.cursor_before ?? "?"} -> ${result.cursor_after ?? "?"} (tail ${result.tail ?? "?"}); ` +
      `mailbox cursor ${result.mailbox_cursor_before ?? "?"} -> ${result.mailbox_cursor_after ?? "?"}` +
      `${result.mailbox_reconcile_reason ? ` — ${result.mailbox_reconcile_reason}` : ""}.`,
  )
}

async function cmdRestart(opts: { reason?: string; json?: boolean }): Promise<void> {
  const params: Record<string, unknown> = opts.reason ? { reason: opts.reason } : {}
  const result = mcpJsonContent(await callDaemon("tribe.restart", params)) as RestartResult

  if (opts.json) {
    await writeJsonStdout(result)
    return
  }
  if (result.error) {
    console.error(`tribe restart: ${result.error}`)
    process.exit(1)
  }

  console.log(formatRestartResult(result))
}

/**
 * `tribe stop` — clean daemon shutdown via RPC `tribe.stop` (drain, close
 * socket, exit 0; no SIGHUP/lifecycle-owner successor). Guarded twice, same
 * rule: this CLI refuses locally without --force outside the hab supervisor
 * context, and the daemon independently refuses the RPC without `force: true`
 * so a raw socket caller cannot stop the rail casually either.
 */
async function cmdStop(opts: { force?: boolean; reason?: string; json?: boolean }): Promise<void> {
  if (!opts.force && !isHabSupervisorContext({ HAB_SERVICE_NAME: process.env.HAB_SERVICE_NAME })) {
    console.error(STOP_REFUSAL_MESSAGE)
    process.exit(2)
  }
  const params: Record<string, unknown> = { force: true, ...(opts.reason ? { reason: opts.reason } : {}) }
  const result = mcpJsonContent(await callDaemon("tribe.stop", params)) as StopResult

  if (opts.json) {
    await writeJsonStdout(result)
    return
  }
  if (result.error) {
    console.error(`tribe stop: ${result.error}`)
    process.exit(1)
  }

  console.log(formatStopResult(result))
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register the CLI's read and inspect verbs. */
export function registerReadCommands(program: Command): void {
  program
    .command("status")
    .description("Show active sessions with uptime and last-seen")
    .action(() => void cmdStatus())

  program
    .command("sessions")
    .description("List sessions")
    .option("-a, --all", "Include historical (disconnected) sessions")
    .action((opts: { all?: boolean }) => void cmdSessions(!!opts.all))

  const membersAll = cliOption(MEMBERS_CLI, "all")
  program
    .command(MEMBERS_CLI.name)
    .description(MEMBERS_CLI.description)
    .option(membersAll.flags, membersAll.description)
    .action((opts: { all?: boolean }) => cmdMembers(!!opts.all))

  const pendingOwner = cliOption(PENDING_CLI, "owner")
  const pendingAll = cliOption(PENDING_CLI, "all")
  const pendingJson = cliOption(PENDING_CLI, "json")
  const pendingExpired = cliOption(PENDING_CLI, "expired")
  const pendingOwed = cliOption(PENDING_CLI, "owed")
  const pendingStale = cliOption(PENDING_CLI, "stale")
  const pendingClose = cliOption(PENDING_CLI, "close")
  program
    .command(PENDING_CLI.name)
    .description(PENDING_CLI.description)
    .option(pendingAll.flags, pendingAll.description)
    .option(pendingJson.flags, pendingJson.description)
    .option(pendingExpired.flags, pendingExpired.description)
    .option(pendingOwed.flags, pendingOwed.description)
    .option(pendingOwner.flags, pendingOwner.description)
    .option(pendingStale.flags, pendingStale.description)
    .option(pendingClose.flags, pendingClose.description)
    .action(
      async (opts: {
        all?: boolean
        expired?: boolean
        owed?: boolean
        json?: boolean
        owner?: string
        stale?: string
        close?: string
      }) => {
        const stale = opts.stale ? parseStaleMs(opts.stale) : undefined
        if (opts.stale && stale === undefined) {
          console.error(`tribe pending: bad --stale '${opts.stale}' (expected NNs|NNm|NNh)`)
          process.exit(2)
        }
        if (opts.close && pendingClose.requires?.includes("owner") && !opts.owner) {
          console.error(
            "tribe pending: --close requires --owner because one-shot CLI callers are not a registered session",
          )
          process.exit(2)
        }
        if (opts.all && opts.owner) {
          console.error("tribe pending: --all and --owner are mutually exclusive")
          process.exit(2)
        }
        if (opts.all && opts.close) {
          console.error("tribe pending: --all is read-only; --close requires --owner")
          process.exit(2)
        }
        if (opts.expired && opts.close) {
          console.error("tribe pending: --expired is read-only; --close is not allowed")
          process.exit(2)
        }
        // `--owed` without `--expired` is deliberately NOT re-validated here: the
        // daemon already owns that rule and refuses loudly, and the refusal now
        // reaches the user (see cmdPending). Duplicating it would be a second
        // authority for one invariant, free to drift from the first.
        await cmdPending(opts.owner, !!opts.all, !!opts.expired, !!opts.owed, !!opts.json, stale, opts.close)
      },
    )

  program
    .command("log")
    .description("Show recent messages")
    .option("-n, --limit <n>", "Number of messages", int, 20)
    .option("-a, --all", "Return every message in the selected correlation-prefix scope")
    .option("-f, --follow", "Follow live — stream new messages")
    .option("--json", "Print one machine-readable JSON snapshot")
    .option("--ref-prefix <prefix>", "Only messages whose durable ref starts with this literal prefix")
    .option("--reply-prefix <prefix>", "Also include messages whose tracked reply id starts with this literal prefix")
    .action(
      async (opts: {
        limit?: number
        all?: boolean
        follow?: boolean
        json?: boolean
        refPrefix?: string
        replyPrefix?: string
      }) => cmdLog(opts.limit ?? 20, !!opts.all, !!opts.follow, !!opts.json, opts.refPrefix, opts.replyPrefix),
    )

  program
    .command("health")
    .description("Run health diagnostics")
    .action(() => cmdHealth())

  program
    .command("doctor")
    .description("Check whether the running daemon is serving stale code (@km/tribe/20033)")
    .option("--fix", "Print the operator-gated remedy for a stale daemon (does not auto-restart)")
    .action((opts: { fix?: boolean }) => void cmdDoctor(opts))

  program
    .command("inbox")
    .description("Read and acknowledge this managed session's canonical mailbox")
    .option("--limit <n>", "Maximum events to return (max 500)", int, 50)
    .option("--json", "Emit the canonical machine-readable attention projection")
    .option("--peek", "Read the inbox without consuming messages or advancing the cursor")
    .action(async (opts: { limit?: number; json?: boolean; peek?: boolean }) => {
      try {
        await cmdInbox(opts)
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
      }
    })

  program
    .command("inbox-drain")
    .description("Drain a managed or explicit mailbox with the inherited operator capability")
    .option(
      "--session <name>",
      "Explicit role mailbox to drain with the inherited TRIBE_OPERATOR_CAPABILITY_FD capability",
    )
    .option("--limit <n>", "Maximum actionable DMs to return and acknowledge (max 100)", int, 10)
    .option("--json", "Emit machine-readable JSON")
    .option("--peek", "Read the inbox without consuming messages or advancing the cursor")
    .action(async (opts: { session?: string; limit?: number; json?: boolean; peek?: boolean }) => {
      try {
        await cmdInboxDrain(opts)
      } catch (error) {
        renderInboxDrainFailure(error, !!opts.json)
        process.exitCode = 1
      }
    })

  program
    .command("inbox-status")
    .description("Show unanswered actionable attention for the current managed launch or an explicit session")
    .option("--session <name>", "Explicit session to inspect")
    .option("--json", "Emit machine-readable JSON (for hooks)")
    .action((opts: { session?: string; json?: boolean }) => cmdInboxStatus(opts))

  const inboxWaitSession = cliOption(INBOX_WAIT_CLI, "session")
  const inboxWaitTimeout = cliOption(INBOX_WAIT_CLI, "timeout")
  const inboxWaitWakeOnCorrelatedReply = cliOption(INBOX_WAIT_CLI, "wake-on-correlated-reply")
  const inboxWaitJson = cliOption(INBOX_WAIT_CLI, "json")
  program
    .command(INBOX_WAIT_CLI.name)
    .description(INBOX_WAIT_CLI.description)
    .option(inboxWaitSession.flags, inboxWaitSession.description, inboxWaitSession.default)
    .option(inboxWaitTimeout.flags, inboxWaitTimeout.description, inboxWaitTimeout.default)
    .option(inboxWaitWakeOnCorrelatedReply.flags, inboxWaitWakeOnCorrelatedReply.description)
    .option(inboxWaitJson.flags, inboxWaitJson.description)
    .action(async (opts: { session?: string; timeout?: string; wakeOnCorrelatedReply?: boolean; json?: boolean }) => {
      const timeoutMs = opts.timeout ? parseDurationMs(opts.timeout) : undefined
      if (opts.timeout && timeoutMs === undefined) {
        console.error(`tribe inbox-wait: bad --timeout '${opts.timeout}' (expected NNs|NNm|NNh)`)
        process.exit(2)
      }
      await cmdInboxWait({
        session: opts.session,
        timeoutMs,
        wakeOnCorrelatedReply: opts.wakeOnCorrelatedReply,
        json: opts.json,
      })
    })

  const repairSession = cliOption(REPAIR_CLI, "session")
  const repairInboxCursor = cliOption(REPAIR_CLI, "inbox-cursor")
  const repairReapStaleTransports = cliOption(REPAIR_CLI, "reap-stale-transports")
  const repairJson = cliOption(REPAIR_CLI, "json")
  program
    .command(REPAIR_CLI.name)
    .description(REPAIR_CLI.description)
    .option(repairSession.flags, repairSession.description, repairSession.default)
    .option(repairInboxCursor.flags, repairInboxCursor.description)
    .option(repairReapStaleTransports.flags, repairReapStaleTransports.description)
    .option(repairJson.flags, repairJson.description)
    .action((opts: RepairCliOptions) => cmdRepair(opts))

  program
    .command("restart")
    .description("Restart the tribe daemon from the same pinned module root via RPC tribe.restart")
    .option("--reason <text>", "Why the restart is needed (logged by the daemon)")
    .option("--json", "Emit machine-readable JSON")
    .action((opts: { reason?: string; json?: boolean }) => cmdRestart(opts))

  program
    .command("stop")
    .description("Stop the tribe daemon cleanly via RPC tribe.stop (drain, close socket, exit 0; no restart)")
    .option("--force", "Confirm stopping the shared daemon (required outside the hab supervisor context)")
    .option("--reason <text>", "Why the stop is needed (logged by the daemon)")
    .option("--json", "Emit machine-readable JSON")
    .action((opts: { force?: boolean; reason?: string; json?: boolean }) => cmdStop(opts))

  program
    .command("activity")
    .description("Tail the unified activity log (tribe DMs + recall injections + gate verdicts)")
    .option("-f, --follow", "Follow live — stream new entries as they land")
    .option("-s, --since <duration>", "Start from now-<duration>, e.g. 1h, 30m, 2d (default: today midnight)")
    .option("--no-color", "Disable ANSI colors (good for piping to jq / grep)")
    .action(async (opts: { follow?: boolean; since?: string; color?: boolean }) => {
      try {
        await watchActivity({
          follow: !!opts.follow,
          since: opts.since,
          noColor: opts.color === false,
        })
      } catch (err) {
        console.error(`tribe activity: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    })

  // @km/infra/reaper-and-cwd-guard-hardening-followons gap 1 — mark a PID exempt
  // from the health-reaper so a live #undead repro is never auto-killed.
  program
    .command("reaper-exempt [pid]")
    .description("Exempt a PID from the health-reaper auto-kill (a live repro); --clear removes, --list shows all")
    .option("--clear", "remove the exemption instead of adding it")
    .option("--list", "list all current exemptions")
    .option("--reason <text>", "why it is exempt (stored for --list)")
    .action((pid: string | undefined, opts: { clear?: boolean; list?: boolean; reason?: string }) => {
      if (opts.list) {
        const entries = listReaperExempt()
        if (entries.length === 0) {
          console.log("No reaper exemptions.")
          return
        }
        console.log(`${entries.length} reaper exemption(s):`)
        for (const e of entries) console.log(`  PID ${e.pid}${e.reason ? `  — ${e.reason}` : ""}`)
        return
      }
      const n = Number(pid)
      if (!pid || !Number.isInteger(n) || n <= 0) {
        console.error("tribe reaper-exempt: a positive <pid> is required (or pass --list)")
        process.exit(2)
      }
      if (opts.clear) {
        console.log(
          clearReaperExempt(n) ? `Cleared reaper exemption for PID ${n}.` : `No reaper exemption for PID ${n}.`,
        )
        return
      }
      setReaperExempt(n, opts.reason ?? "")
      console.log(
        `PID ${n} is now reaper-exempt${opts.reason ? ` (${opts.reason})` : ""} — the health-reaper will not auto-kill it.`,
      )
    })
}
