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
 *   - activity      (line ~674)
 *
 * The legacy `tools/tribe-cli.ts` continues to ship these same verbs until
 * Phase C deletes it. There is no `members` verb in the source — it is
 * exposed via `tribe.members` MCP call only, not the CLI.
 */

import { Command, int } from "@silvery/commander"
import { connectToDaemon, resolveSocketPath } from "../lib/socket.ts"
import { watchActivity } from "../lib/activity-watch.ts"
import { runInboxWait, type ActionableSnapshot, type InboxWaitResult } from "../lib/inbox-wait.ts"

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

/**
 * Ball-tracker query — list open requests where `owner` is responsible for
 * replying. Wraps the `tribe.pending` MCP tool added in
 * @km/tribe/message-ball-tracker Phase 2a. Used by §C1 chief loop step 0.5
 * (call with `--owner @chief --stale 15m` to surface dropped balls).
 */
async function cmdPending(owner: string | undefined, staleMs: number | undefined): Promise<void> {
  const args: Record<string, unknown> = {}
  if (owner) args.owner = owner
  if (staleMs !== undefined) args.stale_ms = staleMs
  const result = (await callDaemon("tribe.pending", args)) as {
    structuredContent?: {
      owner?: string
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

// ---------------------------------------------------------------------------
// inbox-wait — shared long-poll primitive (@km/bearly/20352-inbox-wait)
// ---------------------------------------------------------------------------

/**
 * Parse a `--timeout` duration into milliseconds. Accepts `NNs|NNm|NNh|NNd`
 * and the literals `0` / `none` / `infinite` (→ `Infinity`, wait forever).
 * Returns undefined on unparseable input so the caller can exit loud.
 */
export function parseTimeoutMs(spec: string): number | undefined {
  const s = spec.trim().toLowerCase()
  if (s === "0" || s === "none" || s === "infinite" || s === "inf") return Infinity
  const match = s.match(/^(\d+)\s*([smhd])$/)
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
    case "d":
      return n * 86_400_000
    default:
      return undefined
  }
}

/**
 * `inbox-wait` — block until an ACTIONABLE inbox event arrives for `session`,
 * or until `--timeout` elapses, or until a termination signal is received.
 *
 * Mechanism: bounded long-poll. The actionable check reuses the daemon's
 * canonical `getUnreadDms` predicate via the `cli_inbox_status` RPC — the SAME
 * filter the chief-silent watchdog + health-monitor consume — so there is no
 * second, drifting definition of "actionable". The daemon's push `wakeup`
 * notification (fired on every message insert to connected sockets) is wired in
 * as an ACCELERATOR: it breaks the inter-poll sleep early so an arriving event
 * is observed promptly rather than at the next interval boundary. The
 * authoritative decision is always the actionable probe, so ambient/broadcast
 * wakeups never produce a false return. The loop AWAITS its sleep between
 * probes — it is zero-spin by construction (no tight re-query).
 *
 * Exit codes: 0 = actionable event arrived (drain via `tribe.fetch`);
 * 64 = timeout (back off + re-arm); 0 = clean exit on SIGINT/SIGTERM;
 * 1 = daemon unreachable (from the shared `callDaemon` helper).
 */
async function cmdInboxWait(opts: {
  session: string
  timeoutMs: number
  pollIntervalMs: number
  json?: boolean
}): Promise<void> {
  const socketPath = resolveSocketPath()

  // One long-lived connection for the duration of the wait: the probe RPC plus
  // the push-wakeup accelerator share it. Daemon-unreachable surfaces as exit 1
  // exactly like the other read verbs (mirrors `callDaemon`).
  let client
  try {
    client = await connectToDaemon(socketPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ECONNREFUSED" || code === "ENOENT") {
      console.error(`No daemon running (socket: ${socketPath})`)
      console.error(`Start one with: bun tribe-daemon (package tribe-daemon), or let a host autostart it`)
      process.exit(1)
    }
    throw err
  }

  // Push-wakeup accelerator. Each daemon `wakeup` notification resolves a
  // one-shot promise that the inter-poll sleep races against, so the next probe
  // fires immediately instead of waiting out the interval. Re-armed after each
  // wakeup. NOT authoritative — the probe still decides actionability.
  let wakeResolve: (() => void) | null = null
  client.onNotification((method) => {
    if (method === "wakeup" && wakeResolve) {
      const r = wakeResolve
      wakeResolve = null
      r()
    }
  })
  // Subscribe so the daemon pushes notifications down this connection.
  try {
    await client.call("subscribe")
  } catch {
    // silent-fallback-allow: subscribe is the OPTIONAL push accelerator; on
    // failure the wait degrades to pure bounded-poll (still correct, just no
    // early-break). The actionable probe below is the load-bearing path.
  }

  const pollActionable = async (): Promise<ActionableSnapshot> => {
    const row = (await client.call("cli_inbox_status", { session: opts.session })) as {
      unread_count?: number
      oldest_unread_ts?: number
    }
    return { count: row.unread_count ?? 0, oldestTs: row.oldest_unread_ts ?? 0 }
  }

  // sleep(ms) resolves on the timer OR an early push-wakeup, whichever fires
  // first. This is the zero-spin guarantee AND the push accelerator in one.
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        wakeResolve = null
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, ms)
      ;(timer as { unref?: () => void }).unref?.()
      wakeResolve = finish
    })

  // Clean exit on termination signals: resolve the signal promise so the loop
  // returns `reason:"signal"` (exit 0) at its next checkpoint.
  let signalResolve: (() => void) | null = null
  const signal = new Promise<void>((resolve) => {
    signalResolve = resolve
  })
  const onSignal = (): void => signalResolve?.()
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)

  let result: InboxWaitResult
  try {
    result = await runInboxWait({
      pollActionable,
      timeoutMs: opts.timeoutMs,
      pollIntervalMs: opts.pollIntervalMs,
      sleep,
      signal,
    })
  } finally {
    process.removeListener("SIGINT", onSignal)
    process.removeListener("SIGTERM", onSignal)
    client.close()
  }

  if (opts.json) {
    console.log(
      JSON.stringify({
        session: opts.session,
        reason: result.reason,
        exit_code: result.exitCode,
        unread_count: result.snapshot?.count ?? 0,
        oldest_unread_ts: result.snapshot?.oldestTs ?? 0,
        polls: result.polls,
      }),
    )
  } else if (result.reason === "actionable") {
    const n = result.snapshot?.count ?? 0
    console.log(`${opts.session}: ${n} actionable inbox event${n === 1 ? "" : "s"} — drain via tribe.fetch.`)
  } else if (result.reason === "timeout") {
    console.error(`${opts.session}: no actionable inbox event within timeout — back off and re-arm.`)
  } else {
    console.error(`${opts.session}: inbox-wait interrupted by signal.`)
  }
  process.exit(result.exitCode)
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
    .command("pending")
    .description("List open ball-tracker requests for an owner (§C1 chief loop step 0.5)")
    .option("-o, --owner <name>", "Owner session name (default: caller)")
    .option("-s, --stale <duration>", "Only show requests older than this (e.g. 15m, 1h)")
    .action((opts: { owner?: string; stale?: string }) => {
      const stale = opts.stale ? parseStaleMs(opts.stale) : undefined
      if (opts.stale && stale === undefined) {
        console.error(`tribe pending: bad --stale '${opts.stale}' (expected NNs|NNm|NNh)`)
        process.exit(2)
      }
      void cmdPending(opts.owner, stale)
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

  program
    .command("inbox-wait")
    .description("Long-poll: block until an actionable inbox event arrives for a session (no busy-loop)")
    .option("--session <name>", "Session to wait for (default: @chief)", "@chief")
    .option("--timeout <duration>", "Max wait, e.g. 30s, 5m, 1h, or 0/none to wait forever", "5m")
    .option("--poll-interval <duration>", "Bounded sleep between polls (cap), e.g. 500ms, 1s", "1s")
    .option("--json", "Emit machine-readable JSON (for hooks / loop callers)")
    .action((opts: { session?: string; timeout?: string; pollInterval?: string; json?: boolean }) => {
      const timeoutMs = parseTimeoutMs(opts.timeout ?? "5m")
      if (timeoutMs === undefined) {
        console.error(`tribe inbox-wait: bad --timeout '${opts.timeout}' (expected NNs|NNm|NNh|NNd or 0/none)`)
        process.exit(2)
      }
      // --poll-interval also accepts a bare `NNms` form; fall back to the
      // duration parser for s/m/h/d. Default 1s. Floor at 50ms so a 0/typo
      // can't spin.
      const rawPoll = (opts.pollInterval ?? "1s").trim().toLowerCase()
      const msMatch = rawPoll.match(/^(\d+)\s*ms$/)
      const pollIntervalMs = msMatch ? Number(msMatch[1]) : parseTimeoutMs(rawPoll)
      if (pollIntervalMs === undefined || !Number.isFinite(pollIntervalMs)) {
        console.error(`tribe inbox-wait: bad --poll-interval '${opts.pollInterval}' (expected NNms|NNs|NNm)`)
        process.exit(2)
      }
      void cmdInboxWait({
        session: opts.session ?? "@chief",
        timeoutMs,
        pollIntervalMs: Math.max(50, pollIntervalMs),
        json: opts.json,
      })
    })

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
}
