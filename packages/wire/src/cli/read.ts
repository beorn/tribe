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
 *   - reload        (MCP/RPC tribe.reload hot-reload parity)
 *   - repair        (operator-bounded state repair)
 *   - activity      (line ~674)
 *
 * The legacy `tools/tribe-cli.ts` continues to ship these same verbs until
 * Phase C deletes it. There is no `members` verb in the source — it is
 * exposed via `tribe.members` MCP call only, not the CLI.
 */

import { Command, int } from "@silvery/commander"
import { cliOption, visibleCliProjectionForMcp } from "../command-descriptors.ts"
import { DEFAULT_INBOX_WAIT_SESSION, resolveInboxWaitOptions } from "../lib/inbox-wait-options.ts"
import { connectToDaemon, resolveSocketPath } from "../lib/socket.ts"
import { watchActivity } from "../lib/activity-watch.ts"
import { clearReaperExempt, listReaperExempt, setReaperExempt } from "../reaper-exempt.ts"

const PENDING_CLI = visibleCliProjectionForMcp("pending")
const INBOX_WAIT_CLI = visibleCliProjectionForMcp("inbox.wait")
const FETCH_CLI = visibleCliProjectionForMcp("fetch")
const REPAIR_CLI = visibleCliProjectionForMcp("repair")

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
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ECONNREFUSED" || code === "ENOENT") {
      console.error(`No daemon running (socket: ${socketPath})`)
      console.error(`Start one with: bun tribe-daemon (package tribe-daemon), or let a host autostart it`)
      process.exit(1)
    }
    throw err
  }
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
  ts: number
}

/** One drained inbox row (20843 wait-and-drain return shape). */
export type InboxWaitEvent = {
  id: string
  rowid: number
  type: string
  from: string
  to: string
  content: string
  bead: string | null
  ref: string | null
  ts: string
  delivery: string
  topic: string | null
  room_id: string | null
  summary: string | null
}

/**
 * Wait-and-drain result (20843): `events` is the drained batch. The legacy
 * status fields (`unread_count` etc.) appear only on `--peek` observer calls,
 * which never drain.
 */
export type InboxWaitResult = {
  session: string
  events?: InboxWaitEvent[]
  cursor?: number
  /** actionable | timeout | aborted — shared vocabulary with `tent await`. */
  wakeReason?: string
  unread_count?: number
  oldest_unread_age_min?: number
  oldest_unread_ts?: number
  waited_ms: number
  timed_out: boolean
  aborted: boolean
}

type InboxWaitCall = (args: { session: string; timeoutMs: number; peek?: boolean }) => Promise<InboxWaitResult>

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

function fmtMsg(m: Msg): void {
  const to = m.recipient === "*" ? "all" : m.recipient
  const txt = m.content.length > 120 ? m.content.slice(0, 117) + "..." : m.content
  const bead = m.bead_id ? ` bead=${m.bead_id}` : ""
  console.log(`  ${fmtTime(m.ts)}  ${pad(`${m.sender} → ${to}`, 28)}  [${m.type}]${bead} "${txt}"`)
}

async function cmdLog(limit: number, follow: boolean): Promise<void> {
  const result = (await callDaemon("cli_log", { limit })) as { messages: Msg[] }
  const rows = result.messages

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
      const newResult = (await client.call("cli_log", { limit: 50 })) as { messages: Msg[] }
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
  staleMs: number | undefined,
  close: string | undefined,
): Promise<void> {
  const args: Record<string, unknown> = {}
  if (owner) args.owner = owner
  if (staleMs !== undefined) args.stale_ms = staleMs
  if (close) args.close = close
  const result = (await callDaemon("tribe.pending", args)) as {
    structuredContent?: {
      owner?: string
      request_id?: string
      closed?: number
      pending?: Array<{
        request_id: string
        sender: string
        opened_at: string
        age_ms: number
        message_id: string
        fanout: string
      }>
      count?: number
    }
  }
  const payload = result.structuredContent
  if (!payload) {
    console.log("No structured result returned.")
    return
  }
  if (close) {
    console.log(
      `Closed ${payload.closed ?? 0} pending request(s) for ${payload.owner ?? owner ?? "(caller)"}: ${payload.request_id ?? close}`,
    )
    return
  }
  const count = payload.count ?? 0
  const displayOwner = payload.owner ?? owner ?? "(caller)"
  if (count === 0) {
    console.log(`No pending requests for ${displayOwner}.`)
    return
  }
  console.log(`${count} pending request(s) for ${displayOwner}:`)
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
 * Spec: @km/all/silent-errors-enforcement/chief-silent-watchdog-relay-pattern-detection (Layer 2).
 */
async function cmdInboxStatus(opts: { session?: string; json?: boolean }): Promise<void> {
  const session = opts.session ?? "@chief"
  const result = (await callDaemon("cli_inbox_status", { session })) as {
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
    console.log(`${session}: inbox drained (0 unread actionable DMs).`)
    return
  }
  console.log(
    `${session}: ${n} unread actionable DM${n === 1 ? "" : "s"}, ` + `oldest ${result.oldest_unread_age_min}min ago.`,
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

function totalWaited(result: InboxWaitResult, startedAt: number, now: () => number): InboxWaitResult {
  return { ...result, waited_ms: Math.max(result.waited_ms, Math.max(0, now() - startedAt)) }
}

function timeoutInboxWaitResult(
  session: string,
  startedAt: number,
  now: () => number,
  opts: { peek?: boolean; events?: InboxWaitEvent[] } = {},
): InboxWaitResult {
  return {
    session,
    ...(opts.peek === true
      ? { unread_count: 0, oldest_unread_age_min: 0, oldest_unread_ts: 0 }
      : { events: opts.events ?? [], wakeReason: "timeout" }),
    waited_ms: Math.max(0, now() - startedAt),
    timed_out: true,
    aborted: false,
  }
}

export async function waitForInboxWithReconnect(opts: {
  session: string
  timeoutMs: number
  call: InboxWaitCall
  peek?: boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  maxChunkMs?: number
  retryDelayMs?: number
  unavailableGraceMs?: number
}): Promise<InboxWaitResult> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const maxChunkMs = opts.maxChunkMs ?? INBOX_WAIT_CHUNK_MS
  const retryDelayMs = opts.retryDelayMs ?? INBOX_WAIT_RETRY_DELAY_MS
  const unavailableGraceMs = opts.unavailableGraceMs ?? INBOX_WAIT_UNAVAILABLE_GRACE_MS
  const startedAt = now()
  const deadline = startedAt + Math.max(0, opts.timeoutMs)

  // Ambient rows drained by an intermediate chunk's timeout are HELD here and
  // delivered on the final return — a transport chunk boundary must not look
  // like a wake to the caller (20843: ambient never wakes the wait), and a
  // drained row must never be dropped.
  const accumulated: InboxWaitEvent[] = []

  const finish = (result: InboxWaitResult): InboxWaitResult => {
    if (opts.peek === true) return totalWaited(result, startedAt, now)
    return totalWaited({ ...result, events: [...accumulated, ...(result.events ?? [])] }, startedAt, now)
  }

  while (true) {
    const remainingMs = Math.max(0, deadline - now())
    if (remainingMs <= 0) {
      return timeoutInboxWaitResult(opts.session, startedAt, now, { peek: opts.peek, events: accumulated })
    }

    try {
      const result = await opts.call({
        session: opts.session,
        timeoutMs: Math.min(maxChunkMs, remainingMs),
        peek: opts.peek,
      })
      if ((result.unread_count ?? 0) > 0) return finish(result)
      if (result.aborted || result.timed_out) {
        accumulated.push(...(result.events ?? []))
        if (now() >= deadline) {
          return timeoutInboxWaitResult(opts.session, startedAt, now, { peek: opts.peek, events: accumulated })
        }
        continue
      }
      return finish(result)
    } catch (err) {
      const kind = inboxWaitErrorKind(err)
      if (!kind) throw err
      if (kind === "daemon-unavailable" && now() - startedAt >= unavailableGraceMs) throw err
      const afterErrorRemainingMs = Math.max(0, deadline - now())
      if (afterErrorRemainingMs <= 0) {
        return timeoutInboxWaitResult(opts.session, startedAt, now, { peek: opts.peek, events: accumulated })
      }
      const pauseMs = Math.min(retryDelayMs, afterErrorRemainingMs)
      if (pauseMs > 0) await sleep(pauseMs)
    }
  }
}

async function callInboxWaitChunk(session: string, timeoutMs: number, peek?: boolean): Promise<InboxWaitResult> {
  const socketPath = resolveSocketPath()
  const client = await connectToDaemon(socketPath, { callTimeoutMs: Math.max(10_000, timeoutMs + 5_000) })
  try {
    return (await client.call("cli_inbox_wait", {
      session,
      timeout_ms: timeoutMs,
      ...(peek === true ? { peek: true } : {}),
    })) as InboxWaitResult
  } finally {
    client.close()
  }
}

const ACTIONABLE_EVENT_TYPES = new Set(["request", "query", "verdict", "assign"])

function printDrainedEvents(session: string, result: InboxWaitResult, timeoutMs: number): void {
  const events = result.events ?? []
  if (events.length === 0) {
    console.log(`${session}: no messages within ${Math.round(timeoutMs / 1000)}s.`)
    process.exitCode = 64
    return
  }
  const actionable = events.filter((e) => ACTIONABLE_EVENT_TYPES.has(e.type)).length
  console.log(
    `${session}: drained ${events.length} message${events.length === 1 ? "" : "s"} ` +
      `(${actionable} actionable, waited ${Math.round(result.waited_ms / 1000)}s).`,
  )
  for (const e of events) {
    const head = (e.summary ?? e.content).split("\n")[0] ?? ""
    console.log(`  [${e.type}] ${e.from} -> ${e.to}: ${head.length > 120 ? `${head.slice(0, 120)}…` : head}`)
  }
}

async function cmdInboxWait(opts: {
  session?: string
  timeoutMs?: number
  json?: boolean
  peek?: boolean
}): Promise<void> {
  const { session, timeoutMs } = resolveInboxWaitOptions(
    { session: opts.session, timeoutMs: opts.timeoutMs },
    { defaultSession: DEFAULT_INBOX_WAIT_SESSION },
  )
  const result = await waitForInboxWithReconnect({
    session,
    timeoutMs,
    peek: opts.peek,
    call: ({ session: chunkSession, timeoutMs: chunkTimeoutMs, peek }) =>
      callInboxWaitChunk(chunkSession, chunkTimeoutMs, peek),
  })
  if (opts.json) {
    console.log(JSON.stringify(result))
    if (!opts.peek && (result.events ?? []).length === 0 && result.timed_out) process.exitCode = 64
    return
  }
  if (result.aborted) {
    console.log(`${session}: inbox wait aborted.`)
    return
  }
  if (opts.peek === true) {
    // Observer mode: status only, nothing drained (pre-20843 contract).
    if (result.timed_out || (result.unread_count ?? 0) === 0) {
      console.log(`${session}: no actionable DMs within ${Math.round(timeoutMs / 1000)}s.`)
      process.exitCode = 64
      return
    }
    const n = result.unread_count ?? 0
    console.log(
      `${session}: ${n} unread actionable DM${n === 1 ? "" : "s"}, ` +
        `oldest ${result.oldest_unread_age_min}min ago (waited ${Math.round(result.waited_ms / 1000)}s).`,
    )
    return
  }
  printDrainedEvents(session, result, timeoutMs)
}

/** `tribe fetch` — the timeout-0 alias of wait-and-drain: one plain atomic
 *  drain of the session's inbox (20843 S2). Not the seat-facing idle loop —
 *  that is `tent await`. */
async function cmdFetch(opts: { session?: string; json?: boolean }): Promise<void> {
  const { session } = resolveInboxWaitOptions({ session: opts.session }, { defaultSession: DEFAULT_INBOX_WAIT_SESSION })
  const result = await callInboxWaitChunk(session, 0)
  if (opts.json) {
    console.log(JSON.stringify(result))
    return
  }
  const events = result.events ?? []
  if (events.length === 0) {
    console.log(`${session}: inbox drained (0 pending messages).`)
    return
  }
  printDrainedEvents(session, result, 0)
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

  const pendingOwner = cliOption(PENDING_CLI, "owner")
  const pendingStale = cliOption(PENDING_CLI, "stale")
  const pendingClose = cliOption(PENDING_CLI, "close")
  program
    .command(PENDING_CLI.name)
    .description(PENDING_CLI.description)
    .option(pendingOwner.flags, pendingOwner.description)
    .option(pendingStale.flags, pendingStale.description)
    .option(pendingClose.flags, pendingClose.description)
    .action((opts: { owner?: string; stale?: string; close?: string }) => {
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
      void cmdPending(opts.owner, stale, opts.close)
    })

  program
    .command("log")
    .description("Show recent messages")
    .option("-n, --limit <n>", "Number of messages", int, 20)
    .option("-f, --follow", "Follow live — stream new messages")
    .action((opts: { limit?: number; follow?: boolean }) => void cmdLog(opts.limit ?? 20, !!opts.follow))

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
    .command("inbox-status")
    .description("Show actionable DMs the target session hasn't drained yet (chief-silent watchdog Layer 2)")
    .option("--session <name>", "Session to inspect (default: @chief)", "@chief")
    .option("--json", "Emit machine-readable JSON (for hooks)")
    .action((opts: { session?: string; json?: boolean }) => void cmdInboxStatus(opts))

  const inboxWaitSession = cliOption(INBOX_WAIT_CLI, "session")
  const inboxWaitTimeout = cliOption(INBOX_WAIT_CLI, "timeout")
  const inboxWaitJson = cliOption(INBOX_WAIT_CLI, "json")
  program
    .command(INBOX_WAIT_CLI.name)
    .description(INBOX_WAIT_CLI.description)
    .option(inboxWaitSession.flags, inboxWaitSession.description, inboxWaitSession.default)
    .option(inboxWaitTimeout.flags, inboxWaitTimeout.description, inboxWaitTimeout.default)
    .option(inboxWaitJson.flags, inboxWaitJson.description)
    .option(cliOption(INBOX_WAIT_CLI, "peek").flags, cliOption(INBOX_WAIT_CLI, "peek").description)
    .action((opts: { session?: string; timeout?: string; json?: boolean; peek?: boolean }) => {
      const timeoutMs = opts.timeout ? parseDurationMs(opts.timeout) : undefined
      if (opts.timeout && timeoutMs === undefined) {
        console.error(`tribe inbox-wait: bad --timeout '${opts.timeout}' (expected NNs|NNm|NNh)`)
        process.exit(2)
      }
      void cmdInboxWait({ session: opts.session, timeoutMs, json: opts.json, peek: opts.peek })
    })

  const fetchSession = cliOption(FETCH_CLI, "session")
  const fetchJson = cliOption(FETCH_CLI, "json")
  program
    .command(FETCH_CLI.name)
    .description(FETCH_CLI.description)
    .option(fetchSession.flags, fetchSession.description, fetchSession.default)
    .option(fetchJson.flags, fetchJson.description)
    .action((opts: { session?: string; json?: boolean }) => void cmdFetch(opts))

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
