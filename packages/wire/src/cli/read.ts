/**
 * Read/inspect verbs for the unified `tribe-wire` CLI.
 *
 * Family 1 of Phase A.2 verb-port — see
 * `@km/bearly/19231-tribe-cli-unify-phase-a2-verbs`. Each verb mirrors the
 * implementation in `vendor/tribe/tools/tribe-cli.ts` (which stays canonical
 * until the Phase C atomic-delete). The handlers here are pure ports — same
 * RPCs, same flags, same output shape — with the only changes being:
 *
 *   - Import paths are intra-package (`../lib/...`) instead of
 *     `tribe-wire/lib/...` (to avoid self-import).
 *   - The `activity-watch.ts` reader was copied into
 *     `../lib/activity-watch.ts` so this module has no `tools/` dependency.
 *   - The verbs are registered on a caller-supplied `Command` rather than
 *     created on a fresh `program` — the main dispatcher (`cli.ts`) calls
 *     `registerReadCommands(program)` to wire them up.
 *
 * Verbs in this family:
 *   - status        (line ~570 in tools/tribe-cli.ts)
 *   - sessions      (line ~575)
 *   - pending       (line ~596)
 *   - log           (line ~610)
 *   - health        (line ~617)
 *   - inbox-status  (line ~622)
 *   - inbox-drain   (bounded actionable drain without transient registration)
 *   - reload        (MCP/RPC tribe.reload hot-reload parity)
 *   - repair        (operator-bounded state repair)
 *   - activity      (line ~674)
 *
 * The legacy `tools/tribe-cli.ts` continues to ship these same verbs until
 * Phase C deletes it. There is no `members` verb in the source — it is
 * exposed via `tribe.members` MCP call only, not the CLI.
 */

import { readFileSync } from "node:fs"
import { Command, int } from "@silvery/commander"
import { cliOption, visibleCliProjectionForMcp } from "../command-descriptors.ts"
import {
  deriveInboxWaitCallTimeoutMs,
  parseInboxWaitResult,
  resolveInboxWaitControls,
  type InboxWaitResult,
} from "../lib/inbox-wait-options.ts"
import { connectToDaemon, resolveSocketPath } from "../lib/socket.ts"
import { watchActivity } from "../lib/activity-watch.ts"
import { clearReaperExempt, listReaperExempt, setReaperExempt } from "../reaper-exempt.ts"

const PENDING_CLI = visibleCliProjectionForMcp("pending")
const INBOX_WAIT_CLI = visibleCliProjectionForMcp("inbox.wait")
const REPAIR_CLI = visibleCliProjectionForMcp("repair")

const STALE_MANAGED_INBOX_DAEMON_ERROR =
  "Running Tribe daemon is stale and cannot resolve this managed inbox; update/reload the daemon before retrying. Use --session only for an explicit operator target."

// ---------------------------------------------------------------------------
// Daemon connection
// ---------------------------------------------------------------------------

async function callDaemon(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const socketPath = resolveSocketPath()
  try {
    const client = await connectToDaemon(socketPath)
    try {
      const result = await client.call(method, params)
      return result
    } finally {
      client.close()
    }
  } catch (err) {
    const code = (err as { code?: string | number }).code
    if (code === -32601 && method.endsWith("_by_launch_v1")) {
      throw new Error(STALE_MANAGED_INBOX_DAEMON_ERROR)
    }
    if (code === "ECONNREFUSED" || code === "ENOENT") {
      console.error(`No daemon running (socket: ${socketPath})`)
      console.error(`Start one with: bun tribe-daemon (package tribe-daemon), or let a host autostart it`)
      process.exit(1)
    }
    throw err
  }
}

function cliInboxTargetParams(session: string | undefined): Record<string, unknown> {
  if (session !== undefined) return { session }
  const launchId = process.env.TRIBE_LAUNCH_ID?.trim()
  if (launchId) return { launch_id: launchId }
  throw new Error("Managed inbox request requires TRIBE_LAUNCH_ID; use --session for an explicit operator target")
}

function cliInboxMethod(base: "status" | "wait" | "drain", session: string | undefined): string {
  return session === undefined ? `cli_inbox_${base}_by_launch_v1` : `cli_inbox_${base}`
}

/**
 * Unwrap an MCP tool result's JSON content (`content[0].text` → parsed), or
 * return the raw value when there is no parseable content. Shared by the read
 * verbs that consume MCP-formatted daemon replies (`health`, `doctor`) so the
 * unwrap is not re-derived per verb.
 */
export function mcpJsonContent(raw: unknown): unknown {
  const text = (raw as { content?: ReadonlyArray<{ text?: string }> })?.content?.[0]?.text
  if (typeof text === "string") {
    try {
      return JSON.parse(text)
    } catch {
      /* not JSON — fall back to the raw value */
    }
  }
  return raw
}

interface ReloadResult {
  error?: string
  reloading?: boolean
  reason?: string
  pid?: number
}

export function formatReloadResult(result: ReloadResult): string {
  const pid = typeof result.pid === "number" ? ` (pid ${result.pid})` : ""
  const reason = result.reason ?? "manual reload"
  return `Reloading tribe daemon${pid}: ${reason}.`
}

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
}) => Promise<InboxWaitResult>

const INBOX_WAIT_CHUNK_MS = 30_000
const INBOX_WAIT_RETRY_DELAY_MS = 250
const INBOX_WAIT_UNAVAILABLE_GRACE_MS = 2_000

// ---------------------------------------------------------------------------
// Command implementations (ported verbatim from tools/tribe-cli.ts)
// ---------------------------------------------------------------------------

async function cmdStatus(): Promise<void> {
  const result = (await callDaemon("cli_status")) as {
    sessions: SessionInfo[]
    daemon: { pid: number; uptime: number; clients: number; dbPath: string; socketPath: string }
  }
  const { sessions, daemon } = result

  if (!sessions.length) {
    console.log("No active tribe sessions.")
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
 * supervisor-issued launch identity the session's environment advertised via
 * TRIBE_LAUNCH_ID at registration — plus daemon-authoritative transport and
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
  console.log(JSON.stringify(result))
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
    console.log(JSON.stringify({ messages: rows, query: result.query }))
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
async function cmdPending(
  owner: string | undefined,
  all: boolean,
  expired: boolean,
  json: boolean,
  staleMs: number | undefined,
  close: string | undefined,
): Promise<void> {
  const args: Record<string, unknown> = {}
  if (all) args.all = true
  if (expired) args.expired = true
  if (owner) args.owner = owner
  if (staleMs !== undefined) args.stale_ms = staleMs
  if (close) args.close = close
  const result = (await callDaemon("tribe.pending", args)) as {
    content?: Array<{ type?: string; text?: string }>
    structuredContent?: {
      all?: boolean
      owner?: string
      request_id?: string
      closed?: number
      warning?: string
      pending?: Array<{
        request_id: string
        recipient: string
        sender: string
        opened_at: string
        age_ms: number
        message_id: string
        fanout: string
        summary: string | null
      }>
      owners?: Array<{
        owner: string
        count: number
        oldest_age_ms: number
        pending: Array<{
          request_id: string
          recipient: string
          sender: string
          opened_at: string
          age_ms: number
          message_id: string
          fanout: string
          summary: string | null
        }>
      }>
      owner_count?: number
      oldest_age_ms?: number
      count?: number
    }
  }
  const payload = result.structuredContent ?? (mcpJsonContent(result) as NonNullable<typeof result.structuredContent>)
  if (!payload) {
    console.log("No structured result returned.")
    return
  }
  if (json) {
    console.log(JSON.stringify(payload, null, 2))
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
      console.log(`  ${group.owner}: ${group.count} (oldest ${oldest} ago)`)
      for (const p of group.pending) {
        const summary = p.summary?.trim() || "(no summary)"
        console.log(`    ${p.request_id}  from ${p.sender}  to ${p.recipient}  ${summary}  (msg ${p.message_id})`)
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
    console.log(`  ${p.request_id}  from ${p.sender}  ${age} ago  fanout=${p.fanout}  (msg ${p.message_id})`)
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
      const cW = Math.max(3, ...cwds.map((c) => c.length))
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
    console.log(JSON.stringify(result, null, 2))
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
  stale: boolean
  /** Operator-facing remedy, or null when fresh. */
  reason: string | null
  /** running/on-disk/pin SHAs when the daemon could self-report, else null. */
  detail: { running: string | null; on_disk: string | null; superproject_pin: string | null } | null
}

interface DoctorHealthShape {
  code_pin?: {
    stale: boolean
    reason: string | null
    running: string | null
    on_disk: string | null
    superproject_pin: string | null
  }
}

/** Pure staleness decision — no IO, so all three classes unit-test cleanly. */
export function evaluateDoctor(health: DoctorHealthShape): DoctorVerdict {
  const cp = health.code_pin
  if (cp === undefined) {
    return {
      stale: true,
      reason:
        "running daemon predates the code_pin detector (@km/tribe/20033): its tribe.health() has no `code_pin` field, so it is too old to self-report. Stop it so the next autostart respawns from current source.",
      detail: null,
    }
  }
  const detail = { running: cp.running, on_disk: cp.on_disk, superproject_pin: cp.superproject_pin }
  if (cp.stale) return { stale: true, reason: cp.reason, detail }
  return { stale: false, reason: null, detail }
}

/** Extract the health payload from a callDaemon result (MCP-wrapped or raw). */
function parseDoctorHealth(raw: unknown): DoctorHealthShape {
  return (mcpJsonContent(raw) ?? {}) as DoctorHealthShape
}

async function cmdDoctor(opts: { fix?: boolean }): Promise<void> {
  const health = parseDoctorHealth(await callDaemon("tribe.health"))
  const verdict = evaluateDoctor(health)

  console.log("TRIBE DOCTOR — daemon code-staleness check\n")
  if (verdict.detail) {
    const d = verdict.detail
    console.log(`  running=${d.running ?? "?"}  on_disk=${d.on_disk ?? "?"}  pin=${d.superproject_pin ?? "?"}`)
  }

  if (!verdict.stale) {
    console.log("  OK — running daemon matches the on-disk + superproject-pinned tribe code.")
    return
  }

  console.error(`  STALE — ${verdict.reason}`)
  if (opts.fix) {
    // Operator-gated only — never auto, never in the hot hook path. The actual
    // restart is a lifecycle op (which lives in the tribe-daemon package, not
    // this read-only CLI), so --fix prints the exact operator remedy rather
    // than mutating live daemon state from here. Restart-execution wiring is
    // the tracked lifecycle follow-up slice.
    console.error(
      "\n  --fix (operator-gated remedy):\n" +
        "    1. if on_disk != pin: update the tribe submodule to its pin, then\n" +
        "    2. stop the stale daemon (it idle-exits; or kill its `daemon.ts` pid)\n" +
        "       so the next autostart respawns from current source, then\n" +
        "    3. re-run `tribe doctor` to confirm OK.\n" +
        "  (Automated restart is the tracked lifecycle follow-up; not wired here.)",
    )
  }
  process.exit(1)
}

/**
 * Inbox status — count + age of actionable DMs the target session hasn't
 * drained via `tribe.fetch` yet. JSON when `--json` is set; otherwise a
 * human-readable summary. Used by `.claude/hooks/chief-drain-check.sh`.
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
    console.log(JSON.stringify(result))
    return
  }
  const n = result.unread_count
  if (n === 0) {
    console.log(`${result.session}: inbox drained (0 unread actionable DMs).`)
    return
  }
  console.log(
    `${result.session}: ${n} unread actionable DM${n === 1 ? "" : "s"}, ` +
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

async function cmdInboxDrain(opts: { session?: string; limit?: number; json?: boolean }): Promise<void> {
  const result = (await callDaemon(cliInboxMethod("drain", opts.session), {
    ...cliInboxTargetParams(opts.session),
    limit: opts.limit ?? 10,
    // The fd number is public process metadata; the capability content never
    // enters env/argv, where another same-user process could inspect it.
    operator_capability: readOperatorCapabilityFromInheritedFd(process.env.TRIBE_OPERATOR_CAPABILITY_FD),
  })) as InboxDrainResult
  if (opts.json) {
    console.log(JSON.stringify(result))
    return
  }
  for (const event of result.events) {
    console.log(`${event.from} [${event.type}]`)
    console.log(event.content)
  }
  console.log(
    `${result.session}: drained ${result.drained_count} actionable DM${result.drained_count === 1 ? "" : "s"}; ` +
      `${result.unread_count} remaining.`,
  )
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
  result: InboxWaitResult,
  startedAt: number,
  now: () => number,
  effectiveTimeoutMs: number,
): InboxWaitResult {
  return {
    ...result,
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
  return totalWaited(
    {
      ...latest,
      timed_out: true,
      aborted: false,
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
  const retryDelayMs = opts.retryDelayMs ?? INBOX_WAIT_RETRY_DELAY_MS
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
      })
      latestResult = result
      lastRetryableError = undefined
      if (result.unread_count > 0 || (!result.timed_out && !result.aborted)) {
        return totalWaited(result, startedAt, now, controls.timeoutMs)
      }
      if (result.aborted || result.timed_out) {
        if (now() >= deadline) {
          return logicalTimeoutInboxWaitResult(result, lastRetryableError, startedAt, now, controls.timeoutMs)
        }
        continue
      }
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
      const pauseMs = Math.min(retryDelayMs, afterErrorRemainingMs)
      if (pauseMs > 0) await sleep(pauseMs)
    }
  }
}

async function callInboxWaitChunk(
  method: string,
  target: Record<string, unknown>,
  timeoutMs: number,
  wakeOnCorrelatedReply: boolean,
): Promise<InboxWaitResult> {
  const socketPath = resolveSocketPath()
  const callTimeoutMs = deriveInboxWaitCallTimeoutMs(timeoutMs)
  const client = await connectToDaemon(socketPath, { callTimeoutMs })
  try {
    return parseInboxWaitResult(
      await client.call(
        method,
        {
          ...target,
          timeout_ms: timeoutMs,
          ...(wakeOnCorrelatedReply ? { wake_on_correlated_reply: true } : {}),
        },
        { timeoutMs: callTimeoutMs },
      ),
    )
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
  const result = await waitForInboxWithReconnect({
    session: opts.session,
    timeoutMs: controls.timeoutMs,
    wakeOnCorrelatedReply: controls.wakeOnCorrelatedReply,
    call: ({ timeoutMs: chunkTimeoutMs, wakeOnCorrelatedReply }) =>
      callInboxWaitChunk(cliInboxMethod("wait", opts.session), target, chunkTimeoutMs, wakeOnCorrelatedReply),
  })
  if (opts.json) {
    console.log(JSON.stringify(result))
    return
  }
  if (result.aborted) {
    console.log(`${result.session}: inbox wait aborted.`)
    return
  }
  if (result.timed_out) {
    console.log(`${result.session}: no actionable DMs within ${Math.round(controls.timeoutMs / 1000)}s.`)
    process.exitCode = 64
    return
  }
  if (result.unread_count === 0) {
    console.log(`${result.session}: correlated tracked-request reply arrived.`)
    return
  }
  const n = result.unread_count
  console.log(
    `${result.session}: ${n} unread actionable DM${n === 1 ? "" : "s"}, ` +
      `oldest ${result.oldest_unread_age_min}min ago (waited ${Math.round(result.waited_ms / 1000)}s).`,
  )
}

async function cmdRepair(opts: { session?: string; inboxCursor?: string; json?: boolean }): Promise<void> {
  const session = opts.session ?? "@chief"
  const inboxCursor = opts.inboxCursor ?? "tail"
  const allowedInboxCursors = cliOption(REPAIR_CLI, "inbox-cursor").enum ?? []
  if (!allowedInboxCursors.includes(inboxCursor)) {
    console.error(`tribe repair: bad --inbox-cursor '${inboxCursor}' (expected ${allowedInboxCursors.join("|")})`)
    process.exit(2)
  }

  const result = mcpJsonContent(await callDaemon("tribe.repair", { session, inbox_cursor: inboxCursor })) as {
    error?: string
    repaired?: boolean
    session?: string
    repair?: string
    cursor_before?: number
    cursor_after?: number
    tail?: number
  }

  if (opts.json) {
    console.log(JSON.stringify(result))
    return
  }
  if (result.error) {
    console.error(`tribe repair: ${result.error}`)
    process.exit(1)
  }

  console.log(
    `Repaired ${result.session ?? session}: inbox cursor ` +
      `${result.cursor_before ?? "?"} -> ${result.cursor_after ?? "?"} (tail ${result.tail ?? "?"}).`,
  )
}

async function cmdReload(opts: { reason?: string; json?: boolean }): Promise<void> {
  const params: Record<string, unknown> = opts.reason ? { reason: opts.reason } : {}
  const result = mcpJsonContent(await callDaemon("tribe.reload", params)) as ReloadResult

  if (opts.json) {
    console.log(JSON.stringify(result))
    return
  }
  if (result.error) {
    console.error(`tribe reload: ${result.error}`)
    process.exit(1)
  }

  console.log(formatReloadResult(result))
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register read/inspect verbs (Family 1 of Phase A.2 verb-port).
 * Each verb mirrors the implementation in `vendor/tribe/tools/tribe-cli.ts`.
 *
 * Bead: @km/bearly/19231-tribe-cli-unify-phase-a2-verbs
 */
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

  program
    .command("members")
    .description("List member sessions as JSON with transport and owner verdicts")
    .option("-a, --all", "Include disconnected durable session rows")
    .action((opts: { all?: boolean }) => void cmdMembers(!!opts.all))

  const pendingOwner = cliOption(PENDING_CLI, "owner")
  const pendingAll = cliOption(PENDING_CLI, "all")
  const pendingJson = cliOption(PENDING_CLI, "json")
  const pendingExpired = cliOption(PENDING_CLI, "expired")
  const pendingStale = cliOption(PENDING_CLI, "stale")
  const pendingClose = cliOption(PENDING_CLI, "close")
  program
    .command(PENDING_CLI.name)
    .description(PENDING_CLI.description)
    .option(pendingAll.flags, pendingAll.description)
    .option(pendingJson.flags, pendingJson.description)
    .option(pendingExpired.flags, pendingExpired.description)
    .option(pendingOwner.flags, pendingOwner.description)
    .option(pendingStale.flags, pendingStale.description)
    .option(pendingClose.flags, pendingClose.description)
    .action(
      (opts: { all?: boolean; expired?: boolean; json?: boolean; owner?: string; stale?: string; close?: string }) => {
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
        void cmdPending(opts.owner, !!opts.all, !!opts.expired, !!opts.json, stale, opts.close)
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
      (opts: {
        limit?: number
        all?: boolean
        follow?: boolean
        json?: boolean
        refPrefix?: string
        replyPrefix?: string
      }) => void cmdLog(opts.limit ?? 20, !!opts.all, !!opts.follow, !!opts.json, opts.refPrefix, opts.replyPrefix),
    )

  program
    .command("health")
    .description("Run health diagnostics")
    .action(() => void cmdHealth())

  program
    .command("doctor")
    .description("Check whether the running daemon is serving stale code (@km/tribe/20033)")
    .option("--fix", "Print the operator-gated remedy for a stale daemon (does not auto-restart)")
    .action((opts: { fix?: boolean }) => void cmdDoctor(opts))

  program
    .command("inbox-drain")
    .description("Drain a managed or explicit mailbox with the inherited operator capability")
    .option(
      "--session <name>",
      "Explicit role mailbox to drain with the inherited TRIBE_OPERATOR_CAPABILITY_FD capability",
    )
    .option("--limit <n>", "Maximum actionable DMs to return and acknowledge (max 100)", int, 10)
    .option("--json", "Emit machine-readable JSON")
    .action((opts: { session?: string; limit?: number; json?: boolean }) => void cmdInboxDrain(opts))

  program
    .command("inbox-status")
    .description("Show actionable DMs for the current managed launch or an explicit session")
    .option("--session <name>", "Explicit session to inspect")
    .option("--json", "Emit machine-readable JSON (for hooks)")
    .action((opts: { session?: string; json?: boolean }) => void cmdInboxStatus(opts))

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
    .action((opts: { session?: string; timeout?: string; wakeOnCorrelatedReply?: boolean; json?: boolean }) => {
      const timeoutMs = opts.timeout ? parseDurationMs(opts.timeout) : undefined
      if (opts.timeout && timeoutMs === undefined) {
        console.error(`tribe inbox-wait: bad --timeout '${opts.timeout}' (expected NNs|NNm|NNh)`)
        process.exit(2)
      }
      void cmdInboxWait({
        session: opts.session,
        timeoutMs,
        wakeOnCorrelatedReply: opts.wakeOnCorrelatedReply,
        json: opts.json,
      })
    })

  const repairSession = cliOption(REPAIR_CLI, "session")
  const repairInboxCursor = cliOption(REPAIR_CLI, "inbox-cursor")
  const repairJson = cliOption(REPAIR_CLI, "json")
  program
    .command(REPAIR_CLI.name)
    .description(REPAIR_CLI.description)
    .option(repairSession.flags, repairSession.description, repairSession.default)
    .option(repairInboxCursor.flags, repairInboxCursor.description, repairInboxCursor.default)
    .option(repairJson.flags, repairJson.description)
    .action((opts: { session?: string; inboxCursor?: string; json?: boolean }) => void cmdRepair(opts))

  program
    .command("reload")
    .description("Hot-reload the tribe daemon via RPC tribe.reload")
    .option("--reason <text>", "Why the reload is needed (logged by the daemon)")
    .option("--json", "Emit machine-readable JSON")
    .action((opts: { reason?: string; json?: boolean }) => void cmdReload(opts))

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
