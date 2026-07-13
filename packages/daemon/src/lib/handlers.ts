/**
 * Tribe tool handlers — all MCP tool case implementations.
 */

import { createLogger } from "loggily"
import { randomUUID } from "node:crypto"
import type { Database } from "bun:sqlite"
import { resolveInboxWaitOptions } from "tribe-wire"
import type { TribeContext } from "./context.ts"
import type { TribeRole } from "tribe-wire/lib/config"

const log = createLogger("tribe:handlers")
import { existsSync, readFileSync, statSync } from "node:fs"
import { validateName, sanitizeMessage } from "./validation.ts"
import { sendMessage, deriveSummary, logEvent, countUnackedActionables, type SenderAttribution } from "./messaging.ts"
import { ACTIONABLE_TYPES_SET } from "./database.ts"
import { isPidAlive as pidStillAlive, registerSession } from "./session.ts"
import { gatherCodePin } from "./code-pin.ts"
import { senderMayUseRegisteredTrustTopic, type SessionRoster } from "./trust.ts"
import type { LifecycleStore, LifecycleSnapshotRecord } from "./lifecycle-store.ts"

// ---------------------------------------------------------------------------
// Reconciler snapshot — read-only view into chief-reconciler output, surfaced
// inside tribe.health() so consumers see stale leases / dead sessions /
// orphan worktrees in real-time without a separate `km tribe doctor` call.
// Path comes from `TRIBE_RECONCILER_SNAPSHOT` so the daemon stays
// km-agnostic (matches vendor/CLAUDE.md: no hardcoded km paths in vendor).
// ---------------------------------------------------------------------------

const RECONCILER_STALE_MS = 20 * 60 * 1000 // 20min

interface ReconcilerFinding {
  kind: string
  severity?: "info" | "warn" | "action"
  summary?: string
  bead?: string
  agent?: string
  worktree?: string
  pid?: number
  fix?: string
}

interface ReconcilerSnapshotShape {
  ts: number
  findings: ReconcilerFinding[]
}

interface ReconcilerSection {
  lastTickAt?: number
  ageMs?: number
  findings?: Record<string, number>
  actions?: ReconcilerFinding[]
  error?: string
  snapshotPath?: string
}

/** Read + summarize the chief-reconciler snapshot. Returns null when the
 *  feature is opt-out (env var unset). All errors degrade gracefully into
 *  an `error` field — never throws, because tribe.health() must keep
 *  working when the snapshot file is missing, corrupt, or stale. */
export function readReconcilerSnapshot(): ReconcilerSection | null {
  const path = process.env.TRIBE_RECONCILER_SNAPSHOT
  if (!path) return null
  if (!existsSync(path)) {
    return { error: "snapshot not found", snapshotPath: path }
  }
  try {
    const raw = readFileSync(path, "utf8")
    const report = JSON.parse(raw) as ReconcilerSnapshotShape
    const lastTickAt = typeof report.ts === "number" ? report.ts : statSync(path).mtimeMs
    // statSync's mtimeMs is fractional; clamp to nonneg so a snapshot
    // written in the same tick doesn't surface a slightly-negative ageMs.
    const ageMs = Math.max(0, Date.now() - lastTickAt)
    const findings: Record<string, number> = {}
    const actions: ReconcilerFinding[] = []
    for (const f of Array.isArray(report.findings) ? report.findings : []) {
      const kind = String(f.kind ?? "unknown")
      findings[kind] = (findings[kind] ?? 0) + 1
      if (f.severity === "action") {
        actions.push({
          kind,
          ...(f.bead ? { bead: f.bead } : {}),
          ...(f.agent ? { agent: f.agent } : {}),
          ...(f.worktree ? { worktree: f.worktree } : {}),
          ...(f.pid ? { pid: f.pid } : {}),
          ...(f.fix ? { fix: f.fix } : {}),
        })
      }
    }
    if (ageMs > RECONCILER_STALE_MS) {
      findings["stale-snapshot"] = (findings["stale-snapshot"] ?? 0) + 1
    }
    return { lastTickAt, ageMs, findings, actions }
  } catch (err) {
    return { error: `snapshot parse failed: ${err instanceof Error ? err.message : String(err)}`, snapshotPath: path }
  }
}

// ---------------------------------------------------------------------------
// Canonical tribe-coordination daemon RPC method names.
// ---------------------------------------------------------------------------

export const TRIBE_COORD_METHODS = {
  send: "tribe.send",
  fetch: "tribe.fetch",
  members: "tribe.members",
  inboxWait: "tribe.inbox.wait",
  rename: "tribe.rename",
  health: "tribe.health",
  join: "tribe.join",
  reload: "tribe.reload",
  retro: "tribe.retro",
  debug: "tribe.debug",
  repair: "tribe.repair",
  filter: "tribe.filter",
  lifecyclePublish: "tribe.lifecycle.publish",
  lifecycle: "tribe.lifecycle",
  healthPublish: "tribe.health.publish",
  pending: "tribe.pending",
} as const

/**
 * The lateral recovery channel's topic (km @ag/super/20324-chain-refactor/20327
 * gap-4). `tribe.health.publish` stamps every recovery broadcast with this topic
 * SERVER-SIDE — the diagnostics tribe adapter treats `health:*` events as ambient
 * visibility, so chief/deck SEE an agent's force-settle / restart / rotation
 * instead of it rendering only in the agent's own pane.
 */
const HEALTH_RECOVERY_TOPIC = "health:recovery"

export type TribeCoordMethod = (typeof TRIBE_COORD_METHODS)[keyof typeof TRIBE_COORD_METHODS]

/**
 * Notification-semantics primer returned in every `tribe.join` response. Host-
 * agnostic — every agent calls `tribe.join` exactly once at startup, so this is
 * the one reliable injection point for the convention (works for silvercode,
 * raw Claude Code, codex, anything that speaks tribe MCP). The text teaches:
 *
 *   1. Notifications (`from: daemon`, broadcasts `to: "*"`) are AMBIENT —
 *      surface them in fetch reads but never act on them.
 *   2. `assign` / `query` / `request` / `verdict` typed messages are the
 *      ACTIONABLE channel. Direct `notify` / `status` / `response` rows are
 *      inbox-visible, but they do not wake `inbox.wait`.
 *   3. When an actionable message needs no response and no comment, reply with
 *      ONLY `<ack/>` (or `<ack id="<msgid>"/>` to correlate) — silvercode
 *      suppresses bare-ack replies from the chat bubble, so a quiet
 *      acknowledgement is invisible while a real reply renders normally.
 *
 * Bead: `@km/code/15654` (Part 1).
 */
export const TRIBE_JOIN_PRIMER =
  "Tribe notification semantics: messages from `from: daemon` (github:push, " +
  'session events, health) and broadcasts (`to: "*"`) are AMBIENT awareness ' +
  "only — surface in `tribe.fetch` reads but DO NOT act on them. Direct " +
  "`type: assign`/`query`/`request`/`verdict` messages are the actionable " +
  "channel and wake `inbox.wait`. Direct `notify`/`status`/`response` rows are " +
  "inbox-visible, but not wakeable. " +
  "When an actionable message needs no response and no comment, reply with " +
  '`<ack/>` (or `<ack id="<msgid>"/>` to correlate) and nothing else — ' +
  "silvercode suppresses bare-ack replies from the chat bubble."

const REMOVED_TRIBE_METHODS = new Set([
  "tribe.broadcast",
  "tribe.history",
  "tribe.inbox",
  "tribe.ping",
  "tribe.read",
  "broadcast",
  "history",
  "inbox",
  "ping",
  "read",
  // F12 of @km/tribe/15496-coordination-drift — the tribe-wire daemon is
  // role-agnostic; chief-ness is an L3 fact (the `@chief` bead lease), not a
  // daemon concept. These coordination-role methods were removed entirely.
  "tribe.chief",
  "tribe.claim-chief",
  "tribe.release-chief",
])
const REMOVED_TRIBE_METHOD_HINT = "use send/fetch/filter — see hub/bearly/design/tribe-message-bus.md"

export function isRemovedTribeMethod(name: string): boolean {
  return REMOVED_TRIBE_METHODS.has(name)
}

export function removedTribeMethodMessage(name: string): string {
  return `${name} removed; ${REMOVED_TRIBE_METHOD_HINT}`
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToolResult = {
  content: Array<{ type: string; text: string }>
  /**
   * MCP-spec first-class structured payload, paired with the tool's
   * `outputSchema` (see `tools-list.ts`). Hosts can render / validate /
   * consume this directly instead of double-parsing an escaped-JSON-string
   * out of `content[0].text`. Spec:
   * `@km/infra/15623-mcp-tools-structuredcontent`.
   *
   * The MCP `CallToolResult` schema requires structuredContent to be an
   * *object* — array / primitive payloads must be wrapped (the `jsonResult`
   * helper below does this automatically: arrays go under `items`,
   * primitives under `value`).
   */
  structuredContent?: Record<string, unknown>
  isError?: boolean
}
type ToolArgs = Record<string, unknown>

/**
 * Wrap a JSON-able payload as a dual content + structuredContent MCP tool
 * result. The `content[0].text` mirrors the payload as pretty-printed JSON
 * (backward compatible — pre-15623 hosts that only know `content` still see
 * the data); the `structuredContent` field carries the same payload as a
 * first-class object so structuredContent-aware hosts can render it
 * natively without the escaped-string envelope.
 *
 * For string-typed responses (e.g. retro markdown), pass `text` to override
 * the JSON-stringified text with a raw human-readable variant; the
 * structured payload is still wrapped as `{ text }` so the schema match
 * holds.
 *
 * Spec: @km/infra/15623-mcp-tools-structuredcontent.
 */
function jsonResult(payload: unknown, opts?: { text?: string }): ToolResult {
  const structured = ensureRecord(payload)
  const text = opts?.text ?? JSON.stringify(payload, null, 2)
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
  }
}

function ensureRecord(payload: unknown): Record<string, unknown> {
  if (payload === null || payload === undefined) return {}
  if (Array.isArray(payload)) return { items: payload }
  if (typeof payload === "object") return payload as Record<string, unknown>
  return { value: payload }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type ActiveSessionInfo = {
  id: string
  name: string
  pid: number
  cwd: string
  role: string
  claudeSessionId: string | null
  registeredAt: number
  launchId: string | null
  launchParentPid: number | null
  transportPids: number[]
}

export type HandlerOpts = {
  cleanup: () => void
  userRenamed: boolean
  setUserRenamed: (v: boolean) => void
  /**
   * Return ctx.sessionId of every currently-connected participating session —
   * used to compute `alive` on DB-sourced session rows without a heartbeat
   * timer. Excludes daemon / watch / pending sessions.
   */
  getActiveSessionIds: () => Set<string>
  /** Realtime snapshot of connected sessions (daemon clients Map). */
  getActiveSessionInfo: () => ActiveSessionInfo[]
  /** Optional: dump daemon internals for `tribe.debug`. Daemon-only (tests using
   *  handlers directly can omit this — `tribe.debug` then returns a minimal
   *  snapshot synthesized from the other accessors). `full: true` requests the
   *  complete cursor dump; otherwise the daemon caps it (see summarizeCursors). */
  getDebugState?: (opts?: { full?: boolean }) => Record<string, unknown>
  /** Optional: raw registry client snapshot for the identity/pressure gauges in
   *  `handleHealth` (@km/bearly/17018). The daemon wires this from its live
   *  `clients` map; direct-handler callers (tests, smoke harness) omit it and
   *  the registry gauges are then absent from the health result. */
  getRegistryClients?: () => RegistryClientSnapshot[]
  /** Optional: per-session lifecycle-snapshot cache (last-write-wins).
   *  Returns the daemon's singleton store; omitted when running handlers
   *  outside the daemon (tests, smoke harness) — `tribe.lifecycle.publish`
   *  / `tribe.lifecycle` then return an `error` field explaining that the
   *  store isn't available, instead of throwing. See `lifecycle-store.ts`
   *  + `@km/infra/15630-stuck-agent-observability` § S4. */
  getLifecycleStore?: () => LifecycleStore
  /** Optional: inbox wait primitive shared by CLI and MCP. */
  inboxWait?: {
    wait: (session: string, connId: string, timeoutMs: number) => Promise<unknown>
  }
  /**
   * Optional: fire a JSON-RPC `wakeup` notification at the claiming session's
   * live socket so push-mode clients drain recovered actionables immediately,
   * without waiting for the next turn-start `tribe.fetch`. Daemon wires this
   * through the broadcast capability; tests / smoke harness omit it (the
   * mailbox state is durable in the DB regardless — the wakeup is an
   * opportunistic nudge). See `countUnackedActionables` in messaging.ts and
   * the mailbox injection in `handleFetch`.
   */
  notifyWakeupForReplay?: (sessionId: string, claimedName: string) => void
}

// ---------------------------------------------------------------------------
// Observability facts (@km/bearly/17018) — tool-latency window, registry +
// identity gauges, DB-pressure gauges, and the degraded contract. Every fact
// lives on the EXISTING handleHealth surface; no new daemon/poller/store/gate.
// The 2026-07-13 20703 recurrence proved the daemon was fast but had zero
// facts, so a 60-70s pane observation could not be attributed to any layer.
// ---------------------------------------------------------------------------

/** In-memory rolling window of tool-call durations (ms), keyed by tool name
 *  without the `tribe.` prefix. Fixed-size per tool; lost on daemon restart by
 *  design (mirrors the lifecycle store's ephemerality). Timed at the single
 *  `handleToolCall` chokepoint so every tribe.* tool is covered. */
const TOOL_LATENCY_WINDOW = 512
const CANONICAL_TOOL_KEYS = ["fetch", "send", "members", "inbox.wait"] as const
const toolLatencyWindows = new Map<string, number[]>()
const COORD_METHOD_SET: ReadonlySet<string> = new Set(Object.values(TRIBE_COORD_METHODS))

export type ToolLatencyStat = { n: number; p50_ms: number; p95_ms: number; max_ms: number }

function toolLatencyKey(method: string): string {
  return method.startsWith("tribe.") ? method.slice("tribe.".length) : method
}

function recordToolLatency(method: string, durationMs: number): void {
  const key = toolLatencyKey(method)
  let win = toolLatencyWindows.get(key)
  if (!win) {
    win = []
    toolLatencyWindows.set(key, win)
  }
  win.push(durationMs)
  if (win.length > TOOL_LATENCY_WINDOW) win.shift()
}

/** Test-only — wipe the rolling window so per-tool counts are deterministic. */
export function resetToolLatencyWindows(): void {
  toolLatencyWindows.clear()
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Nearest-rank percentile over an ascending-sorted sample array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.ceil((p / 100) * sorted.length) - 1
  const idx = Math.min(sorted.length - 1, Math.max(0, rank))
  return sorted[idx]!
}

function statsFor(samples: number[]): ToolLatencyStat {
  if (samples.length === 0) return { n: 0, p50_ms: 0, p95_ms: 0, max_ms: 0 }
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    n: sorted.length,
    p50_ms: round2(percentile(sorted, 50)),
    p95_ms: round2(percentile(sorted, 95)),
    max_ms: round2(sorted[sorted.length - 1]!),
  }
}

/** Per-tool {n,p50,p95,max} plus an `all` rollup. Canonical tools are always
 *  present (stable contract) even with zero samples. */
function computeToolLatency(): Record<string, ToolLatencyStat> {
  const out: Record<string, ToolLatencyStat> = {}
  for (const key of CANONICAL_TOOL_KEYS) out[key] = statsFor(toolLatencyWindows.get(key) ?? [])
  const all: number[] = []
  for (const [key, samples] of toolLatencyWindows) {
    if (!(key in out)) out[key] = statsFor(samples)
    all.push(...samples)
  }
  out.all = statsFor(all)
  return out
}

/** Raw registry client snapshot used for the identity gauges. */
export type RegistryClientSnapshot = {
  sessionId: string
  name: string
  role: string
  launchId: string | null
  registeredAt: number
}

export type RegistryGauges = {
  clients_total: number
  members_total: number
  pending_placeholder_conns: number
  personas_multi_launch: number
}

/** A pending placeholder older than this is a leaked never-registered
 *  connection (`tribe log -f` watchers, half-registered adapters). */
const PENDING_PLACEHOLDER_STALE_MS = 60_000

function computeRegistryGauges(clients: RegistryClientSnapshot[], now: number): RegistryGauges {
  const memberSessionIds = new Set<string>()
  const launchIdsByName = new Map<string, Set<string>>()
  let pending_placeholder_conns = 0
  for (const c of clients) {
    if (c.role === "pending") {
      if (now - c.registeredAt > PENDING_PLACEHOLDER_STALE_MS) pending_placeholder_conns++
      continue
    }
    memberSessionIds.add(c.sessionId)
    let launches = launchIdsByName.get(c.name)
    if (!launches) {
      launches = new Set()
      launchIdsByName.set(c.name, launches)
    }
    // null launchId is its own bucket: a token-less CLI carrier squatting a
    // persona alongside a launched adapter IS a collision (21052 signature).
    launches.add(c.launchId ?? " null")
  }
  let personas_multi_launch = 0
  for (const launches of launchIdsByName.values()) {
    if (launches.size >= 2) personas_multi_launch++
  }
  return {
    clients_total: clients.length,
    members_total: memberSessionIds.size,
    pending_placeholder_conns,
    personas_multi_launch,
  }
}

export type DbPressure = {
  db_bytes: number
  wal_bytes: number
  sessions_rows: number
  messages_rows: number
  archive_rows: number
}

function countRows(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number }).n
}

function computeDbPressure(db: Database): DbPressure {
  const dbPath = db.filename
  let db_bytes = 0
  let wal_bytes = 0
  // db.filename is ":memory:" for in-memory DBs — no backing file, legitimately
  // 0 bytes on disk. A real path that is missing throws loudly (a genuine fault,
  // per NO SILENT ERRORS), rather than masking a vanished DB as healthy.
  if (dbPath && dbPath !== ":memory:") {
    db_bytes = statSync(dbPath).size
    const walPath = `${dbPath}-wal`
    // -wal is legitimately absent when the WAL has been fully checkpointed.
    if (existsSync(walPath)) wal_bytes = statSync(walPath).size
  }
  return {
    db_bytes,
    wal_bytes,
    sessions_rows: countRows(db, "sessions"),
    messages_rows: countRows(db, "messages"),
    archive_rows: countRows(db, "messages_archive"),
  }
}

/** Documented degraded thresholds (@km/bearly/17018). Pragmatic constants — a
 *  breach means the daemon is unhealthy and `tribe health` must exit non-zero. */
export const HEALTH_THRESHOLDS = {
  /** WAL file larger than 64MB — checkpoint/GC is falling behind. */
  wal_bytes: 64 * 1024 * 1024,
  /** sessions table ungarbage-collected. */
  sessions_rows: 2000,
  /** messages_archive is write-only plaster growing unbounded. */
  archive_rows: 250_000,
  /** leaked never-registered placeholder connections. */
  pending_placeholder_conns: 5,
  /** any persona held under ≥2 launch generations — identity-takeover churn. */
  personas_multi_launch: 0,
  /** any single tool's p95 over 5s. */
  tool_p95_ms: 5000,
} as const

export type DegradedFacts = {
  wal_bytes: number
  sessions_rows: number
  archive_rows: number
  /** null when the registry accessor is unavailable (direct-handler context). */
  pending_placeholder_conns: number | null
  personas_multi_launch: number | null
  /** per-tool p95; the `all` rollup is intentionally not a degrade trigger. */
  tool_latency: Record<string, { p95_ms: number }>
}

/** Pure degraded-fact evaluator — names each breached fact. */
export function evaluateDegraded(f: DegradedFacts): string[] {
  const degraded: string[] = []
  if (f.wal_bytes > HEALTH_THRESHOLDS.wal_bytes) degraded.push("wal_bytes")
  if (f.sessions_rows > HEALTH_THRESHOLDS.sessions_rows) degraded.push("sessions_rows")
  if (f.archive_rows > HEALTH_THRESHOLDS.archive_rows) degraded.push("archive_rows")
  if (f.pending_placeholder_conns !== null && f.pending_placeholder_conns > HEALTH_THRESHOLDS.pending_placeholder_conns)
    degraded.push("pending_placeholder_conns")
  if (f.personas_multi_launch !== null && f.personas_multi_launch > HEALTH_THRESHOLDS.personas_multi_launch)
    degraded.push("personas_multi_launch")
  for (const [tool, stat] of Object.entries(f.tool_latency)) {
    if (tool === "all") continue
    if (stat.p95_ms > HEALTH_THRESHOLDS.tool_p95_ms) degraded.push(`tool_latency.${tool}.p95_ms`)
  }
  return degraded
}

// ---------------------------------------------------------------------------
// Debug-dump cursor cap (@km/bearly/17018) — tribe.debug used to dump every
// sessions row (thousands of cursors, MB payloads). Summarise to the stalest +
// newest cursors unless the caller explicitly asks for the full dump.
// ---------------------------------------------------------------------------

export type CursorDumpRow = {
  id: string
  name: string
  last_delivered_ts: number | null
  last_delivered_seq: number | null
}

export type CursorDump = {
  cursors_total: number
  cursors: CursorDumpRow[]
  cursors_truncated?: boolean
}

const DEBUG_CURSORS_STALEST = 50
const DEBUG_CURSORS_NEWEST = 10

/** {cursors_total, cursors} — the 50 stalest + 10 newest cursors by last
 *  delivery, or the complete set when `full` (or when under the cap). A null
 *  last_delivered_ts (never delivered) sorts as the stalest. */
export function summarizeCursors(rows: CursorDumpRow[], opts?: { full?: boolean }): CursorDump {
  const cursors_total = rows.length
  if (opts?.full || rows.length <= DEBUG_CURSORS_STALEST + DEBUG_CURSORS_NEWEST) {
    return { cursors_total, cursors: rows }
  }
  const sorted = [...rows].sort((a, b) => (a.last_delivered_ts ?? 0) - (b.last_delivered_ts ?? 0))
  const stalest = sorted.slice(0, DEBUG_CURSORS_STALEST)
  const newest = sorted.slice(sorted.length - DEBUG_CURSORS_NEWEST)
  return { cursors_total, cursors: [...stalest, ...newest], cursors_truncated: true }
}

export function handleToolCall(
  ctx: TribeContext,
  name: string,
  a: ToolArgs,
  opts: HandlerOpts,
): ToolResult | Promise<ToolResult> {
  // Presence heartbeat (@km/tribe/19784): ANY authenticated tool call
  // refreshes the caller's last_seen — presence = "spoke to the daemon
  // recently", not "joined or drained rows recently". Before this, send-only
  // / empty-drain sessions read as idle (the 2026-06-10 false-idle class,
  // pinned in tests/tribe-delivery-semantics.test.ts).
  ctx.stmts.touchSessionPresence.run({ $id: ctx.sessionId, $now: Date.now() })

  // Tool-latency window (@km/bearly/17018): time every tribe.* tool at this
  // single chokepoint, on both sync and async return paths. Unknown / removed
  // methods throw inside dispatchToolCall and are not recorded — they never did
  // real work, so timing them would only pollute the window.
  if (!COORD_METHOD_SET.has(name)) {
    return dispatchToolCall(ctx, name, a, opts)
  }
  const startedAt = performance.now()
  let result: ToolResult | Promise<ToolResult>
  try {
    result = dispatchToolCall(ctx, name, a, opts)
  } catch (err) {
    recordToolLatency(name, performance.now() - startedAt)
    throw err
  }
  if (result instanceof Promise) {
    return result.then(
      (resolved) => {
        recordToolLatency(name, performance.now() - startedAt)
        return resolved
      },
      (err) => {
        recordToolLatency(name, performance.now() - startedAt)
        throw err
      },
    )
  }
  recordToolLatency(name, performance.now() - startedAt)
  return result
}

function dispatchToolCall(
  ctx: TribeContext,
  name: string,
  a: ToolArgs,
  opts: HandlerOpts,
): ToolResult | Promise<ToolResult> {
  switch (name) {
    case TRIBE_COORD_METHODS.send:
      return handleSend(ctx, a, opts)
    case TRIBE_COORD_METHODS.fetch:
      return handleFetch(ctx, a)
    case TRIBE_COORD_METHODS.members:
      return handleSessions(ctx, a, opts)
    case TRIBE_COORD_METHODS.inboxWait:
      return handleInboxWait(ctx, a, opts)
    case TRIBE_COORD_METHODS.rename:
      return handleRename(ctx, a, opts)
    case TRIBE_COORD_METHODS.join:
      return handleJoin(ctx, a, opts)
    case TRIBE_COORD_METHODS.health:
      return handleHealth(ctx, opts)
    case TRIBE_COORD_METHODS.reload:
      return handleReload(ctx, a, opts.cleanup)
    case TRIBE_COORD_METHODS.retro:
      return handleRetro(ctx, a)
    case TRIBE_COORD_METHODS.debug:
      return handleDebug(ctx, a, opts)
    case TRIBE_COORD_METHODS.repair:
      return handleRepair(ctx, a)
    case TRIBE_COORD_METHODS.filter:
      return handleFilter(ctx, a)
    case TRIBE_COORD_METHODS.lifecyclePublish:
      return handleLifecyclePublish(ctx, a, opts)
    case TRIBE_COORD_METHODS.healthPublish:
      return handleHealthPublish(ctx, a, opts)
    case TRIBE_COORD_METHODS.lifecycle:
      return handleLifecycle(a, opts)
    case TRIBE_COORD_METHODS.pending:
      return handlePending(ctx, a, opts)
    default:
      if (REMOVED_TRIBE_METHODS.has(name)) {
        throw new Error(removedTribeMethodMessage(name))
      }
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Names of currently-active sessions, lexicographically sorted. Returned as
 *  `existing_names` on conflict errors so the caller can pick a non-colliding
 *  alternative without a separate `tribe.sessions` round-trip. */
function listActiveSessionNames(ctx: TribeContext, activeIds?: Set<string>): string[] {
  const rows = ctx.db.prepare("SELECT id, name FROM sessions").all() as Array<{ id: string; name: string }>
  const active = activeIds ?? new Set(rows.map((r) => r.id))
  return rows
    .filter((r) => active.has(r.id))
    .map((r) => r.name)
    .sort()
}

function parseDomains(value: string): string[] {
  const parsed: unknown = JSON.parse(value)
  return Array.isArray(parsed) && parsed.every((v) => typeof v === "string") ? parsed : []
}

function normalizeRecipients(value: unknown): string | string[] | null {
  if (typeof value === "string" && value.length > 0) return value
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && v.length > 0)) {
    return [...new Set(value as string[])]
  }
  return null
}

function activeBroadcastRecipients(ctx: TribeContext, opts: HandlerOpts): string[] {
  const activeIds = [...opts.getActiveSessionIds()]
  if (activeIds.length === 0) return []
  const placeholders = activeIds.map(() => "?").join(", ")
  const rows = ctx.db
    .prepare(`
      SELECT DISTINCT s.name
      FROM sessions s
      INNER JOIN room_members rm ON rm.session_id = s.id
      WHERE s.id IN (${placeholders})
        AND s.name != ?
        AND s.role = 'member'
      ORDER BY s.name ASC
    `)
    .all(...activeIds, ctx.getName()) as Array<{ name: string }>
  return rows.map((row) => row.name)
}

function openPendingRows(
  ctx: TribeContext,
  recipients: readonly string[],
  requestId: string,
  messageId: string,
  openedAt: number,
  fanout: "first" | "all" | undefined,
  sender: string,
): void {
  for (const recipient of recipients) {
    ctx.stmts.openPendingRequest.run({
      $request_id: requestId,
      $recipient: recipient,
      $sender: sender,
      $opened_at: openedAt,
      $message_id: messageId,
      $fanout: fanout ?? "first",
    })
  }
}

function sendAttribution(ctx: TribeContext, a: ToolArgs): SenderAttribution {
  if (ctx.getRole() !== "daemon") return {}
  const sender = typeof a.sender === "string" ? a.sender.trim() : ""
  if (sender.length === 0 || sender === ctx.getName()) return {}
  return { sender, senderRole: "member" }
}

function handleSend(ctx: TribeContext, a: ToolArgs, opts: HandlerOpts): ToolResult {
  // The tribe-wire daemon is role-agnostic (F12 of
  // @km/tribe/15496-coordination-drift): every message type is delivered to
  // every session with no role gate. `assign` / `verdict` are ordinary
  // message types — coordination authority is an L3 concern, not a daemon one.
  const recipients = normalizeRecipients(a.to)
  if (recipients === null) {
    return jsonResult({ error: "tribe.send: `to` must be a non-empty string or array of non-empty strings." })
  }
  const msgType = (a.type as string) ?? "notify"
  const sanitized = sanitizeMessage(a.message as string)
  // Ball-tracker fields (@km/tribe/message-ball-tracker Phase 2a):
  // both optional, orthogonal to `type`. `request: true` is the
  // shorthand for "this message IS its own request id" — we resolve it
  // post-send by passing the message id through. Explicit string forms
  // bind to an existing request id.
  const requestArg = a.request
  const replyArg = a.reply
  const fanoutArg = a.fanout as "first" | "all" | undefined
  // For `request: true`, the request id IS the message id. sendMessage
  // generates the message id internally, so for the truthy-shorthand case
  // we open the pending row AFTER the insert. For string-form, we open
  // immediately with the supplied id.
  const requestFlag = requestArg === true
  const requestId = typeof requestArg === "string" ? requestArg : null
  const replyId = typeof replyArg === "string" ? replyArg : null
  const summaryArg = typeof a.summary === "string" ? a.summary.trim() : ""
  const llmSender = ctx.claudeSessionId !== null || ctx.claudeSessionName !== null
  if (llmSender && summaryArg.length === 0) {
    return jsonResult({
      error: "tribe.send: summary is required for LLM senders; author a one-line summary before sending.",
    })
  }
  // 20316 #3: LLM senders must author the one-line summary up front. Non-LLM
  // callers still get the derived fallback so legacy CLI/human sends remain
  // ergonomic.
  const summaryDerived = summaryArg.length === 0
  const summary = summaryDerived ? deriveSummary(sanitized) : summaryArg
  const attribution = sendAttribution(ctx, a)
  const sender = attribution.sender ?? ctx.getName()
  if (Array.isArray(recipients)) {
    const sharedRequestId = requestFlag ? randomUUID() : requestId
    const results = recipients.map((recipient) =>
      sendMessage(
        ctx,
        recipient,
        sanitized,
        msgType,
        a.bead as string | undefined,
        a.ref as string | undefined,
        "direct",
        { summary },
        {
          request: sharedRequestId ?? undefined,
          reply: replyId ?? undefined,
          fanout: fanoutArg,
        },
        attribution,
      ),
    )
    const tracker = replyId
      ? {
          request_id: replyId,
          closed: results.reduce((total, item) => total + (item.tracker?.closed ?? 0), 0),
        }
      : undefined
    logEvent(ctx, `message.sent.${msgType}`, a.bead as string | undefined, {
      to: recipients,
      message_ids: results.map((r) => r.id),
      ...(sharedRequestId ? { request_id: sharedRequestId } : {}),
      ...(summaryDerived ? { summary_derived: true } : {}),
    })
    return jsonResult({
      sent: true,
      id: results[0]?.id ?? null,
      ids: results.map((r) => r.id),
      ...(sharedRequestId ? { request_id: sharedRequestId } : {}),
      ...(tracker ? { tracker } : {}),
      summary,
      ...(summaryDerived
        ? {
            summary_derived: true,
            warning:
              "no `summary` provided — derived a one-liner from the message; pass an authored `summary` for the channel one-liner.",
          }
        : {}),
    })
  }

  const result = sendMessage(
    ctx,
    recipients,
    sanitized,
    msgType,
    a.bead as string | undefined,
    a.ref as string | undefined,
    "direct",
    { summary },
    {
      request: requestFlag ? undefined : (requestId ?? undefined),
      reply: replyId ?? undefined,
      fanout: fanoutArg,
    },
    attribution,
  )
  // Truthy-shorthand fixup: the canonical convention is request_id == message_id.
  // sendMessage already wrote the message; we now open the pending row using
  // the freshly-assigned id (no second SQL insert path — same statement).
  if (requestFlag) {
    ctx.stmts.setMessageRequest.run({ $id: result.id, $request: result.id })
  }
  if (requestFlag && recipients !== "*") {
    ctx.stmts.openPendingRequest.run({
      $request_id: result.id,
      $recipient: recipients,
      $sender: sender,
      $opened_at: result.ts,
      $message_id: result.id,
      $fanout: fanoutArg ?? "first",
    })
  }
  if ((requestFlag || requestId) && recipients === "*") {
    openPendingRows(
      ctx,
      activeBroadcastRecipients(ctx, opts),
      requestFlag ? result.id : requestId!,
      result.id,
      result.ts,
      fanoutArg,
      sender,
    )
  }
  logEvent(ctx, `message.sent.${msgType}`, a.bead as string | undefined, {
    to: recipients,
    message_id: result.id,
    ...(summaryDerived ? { summary_derived: true } : {}),
  })
  return jsonResult({
    sent: true,
    id: result.id,
    ...(result.tracker ? { tracker: result.tracker } : {}),
    summary,
    ...(summaryDerived
      ? {
          summary_derived: true,
          warning:
            "no `summary` provided — derived a one-liner from the message; pass an authored `summary` for the channel one-liner.",
        }
      : {}),
  })
}

function handlePending(ctx: TribeContext, a: ToolArgs, _opts: HandlerOpts): ToolResult {
  // Ball-tracker pending-query (@km/tribe/message-ball-tracker Phase 2a):
  // return open requests addressed to the given recipient (the "owner" of
  // the open ball). Default recipient is the caller's own session name.
  // Optional `stale_ms` filters to requests older than that threshold.
  const owner = (a.owner as string) ?? ctx.getName()
  const staleMs = typeof a.stale_ms === "number" ? a.stale_ms : null
  const now = Date.now()

  // Explicit repair path (@km/tribe/20008): prune stale balls for `owner`. Safe
  // to run during chief recovery — it REQUIRES a stale_ms threshold so it can
  // only ever delete balls older than that age (fresh request/reply balls and
  // other recipients are untouched), and it removes only the ball-tracker row,
  // never message history.
  if (a.prune === true) {
    if (staleMs === null) {
      return jsonResult({ error: "prune requires stale_ms (the minimum ball age, in ms, to GC)." })
    }
    const res = ctx.stmts.gcStalePendingForRecipient.run({ $recipient: owner, $cutoff: now - staleMs })
    return jsonResult({ owner, pruned: res.changes ?? 0, stale_ms: staleMs })
  }

  const closeId = typeof a.close === "string" && a.close.length > 0 ? a.close : null
  if (closeId) {
    const res = ctx.stmts.closePendingRequest.run({ $request_id: closeId, $recipient: owner })
    return jsonResult({ owner, request_id: closeId, closed: res.changes ?? 0 })
  }

  const rows = ctx.stmts.selectPendingForRecipient.all({ $recipient: owner }) as Array<{
    request_id: string
    sender: string
    opened_at: number
    message_id: string
    fanout: string
  }>
  const filtered = staleMs === null ? rows : rows.filter((r) => now - r.opened_at >= staleMs)
  const pending = filtered.map((r) => ({
    request_id: r.request_id,
    sender: r.sender,
    opened_at: new Date(r.opened_at).toISOString(),
    age_ms: now - r.opened_at,
    message_id: r.message_id,
    fanout: r.fanout,
  }))
  return jsonResult({ owner, pending, count: pending.length })
}

function handleSessions(ctx: TribeContext, a: ToolArgs, opts: HandlerOpts): ToolResult {
  // Membership is sourced from the `room_members` table (Matrix-shape, see
  // km-tribe.matrix-shape). Today every project has exactly one default room
  // and registerSession() populates the join row, so this is functionally a
  // no-op vs the prior `clients` Map sweep — but it exercises the schema so
  // the table stops being inert. Liveness still comes from the daemon's
  // in-memory clients Map (no DB-level tri-state).
  const activeIds = opts.getActiveSessionIds()
  const activeInfo = opts.getActiveSessionInfo()
  // INNER JOIN on room_members: a session that hasn't joined any room is not
  // visible. The startup invariant + per-register backfill (joinDefaultRoom)
  // guarantee every active session has a row, so this match is total in
  // practice. Sessions appear once per room they belong to — DISTINCT collapses
  // multi-room sessions to one row (future-proofs sub-room work without
  // changing today's output shape).
  const rows = ctx.db
    .prepare(`
      SELECT DISTINCT s.id, s.name, s.role, s.domains, s.pid, s.cwd,
        s.claude_session_id, s.claude_session_name, s.started_at, s.updated_at,
        s.account, s.provider, s.launch_id, s.launch_parent_pid
      FROM sessions s
      INNER JOIN room_members rm ON rm.session_id = s.id
      ORDER BY s.started_at
    `)
    .all() as Array<{
    id: string
    name: string
    role: string
    domains: string
    pid: number
    cwd: string
    claude_session_id: string | null
    claude_session_name: string | null
    started_at: number
    updated_at: number
    account: string | null
    provider: string | null
    launch_id: string | null
    launch_parent_pid: number | null
  }>

  // By default return only currently-connected sessions. `a.all` exposes the
  // full DB (useful for diagnostics and tribe retro).
  const visibleRows = a.all ? rows : rows.filter((r) => activeIds.has(r.id))

  // Build parent map: first session per claudeSessionId is the parent, rest are sub-agents
  const parentMap = new Map<string, string>()
  for (const r of visibleRows) {
    if (!r.claude_session_id) continue
    if (!parentMap.has(r.claude_session_id)) {
      parentMap.set(r.claude_session_id, r.name)
    }
  }

  const sessions = visibleRows.map((r) => {
    const parent = r.claude_session_id ? parentMap.get(r.claude_session_id) : undefined
    const active = activeInfo.find((session) => session.id === r.id)
    return {
      member_id: r.id,
      name: r.name,
      role: r.role,
      domains: parseDomains(r.domains),
      pid: active?.pid ?? r.pid,
      launch_id: r.launch_id,
      launch_parent_pid: r.launch_parent_pid,
      transport_pids: active?.transportPids ?? [],
      cwd: r.cwd,
      claude_session_id: r.claude_session_id,
      claude_session_name: r.claude_session_name,
      alive: activeIds.has(r.id),
      uptime_min: Math.round((Date.now() - r.started_at) / 60_000),
      last_seen_sec: Math.round((Date.now() - r.updated_at) / 1000),
      parent: parent && parent !== r.name ? parent : undefined,
      // @km/infra/15641 Phase 1 — surface per-session account/provider
      // (omit when null so the output stays compact for sessions that
      // weren't spawned through ag).
      ...(r.account ? { account: r.account } : {}),
      ...(r.provider ? { provider: r.provider } : {}),
    }
  })
  return jsonResult({ sessions })
}

function handleRename(
  ctx: TribeContext,
  a: ToolArgs,
  opts: {
    userRenamed: boolean
    setUserRenamed: (v: boolean) => void
    /** Optional: when provided, allow reclaiming names held by non-active sessions. */
    getActiveSessionIds?: () => Set<string>
    /** Optional: opportunistic socket wakeup after a name-claim replay rewind. */
    notifyWakeupForReplay?: (sessionId: string, claimedName: string) => void
  },
): ToolResult {
  const newName = a.new_name as string
  // Rename-to-self: silent no-op. Without this short-circuit, the rest of the
  // handler still validates, broadcasts "Member X is now X", and emits a
  // session.renamed event — pure noise.
  if (newName === ctx.getName()) {
    return jsonResult({ renamed: false, name: newName })
  }
  // Validate name format
  const nameError = validateName(newName)
  if (nameError) {
    return jsonResult({ error: nameError })
  }
  // Check if name is taken. If the holder is a non-active (dead / disconnected)
  // session, reclaim the name — tombstone the old row so journaled messages
  // stay addressable (recipient column still points at the old id) but the
  // unique `name` column is freed. See km-bearly.tribe-session-resume F1-B.
  const existing = ctx.stmts.checkNameTaken.get({ $name: newName, $session_id: ctx.sessionId }) as
    | { id: string }
    | undefined
  if (existing) {
    const activeIds = opts.getActiveSessionIds?.()
    const isActive = activeIds ? activeIds.has(existing.id) : true
    if (isActive) {
      const existing_names = listActiveSessionNames(ctx, activeIds)
      return jsonResult({ error: `Name "${newName}" is already taken`, existing_names })
    }
    // Tombstone the dead holder's name so the current session can claim it.
    // Format: `<name>-dead-<8-char-id-prefix>` — deterministic, preserves the
    // old row (message journal stays valid), avoids collisions between
    // multiple sequential reclaims.
    const tombstoneName = `${newName}-dead-${existing.id.slice(0, 8)}`
    ctx.db
      .prepare("UPDATE sessions SET name = $tomb, updated_at = $now WHERE id = $id")
      .run({ $tomb: tombstoneName, $now: Date.now(), $id: existing.id })
    log.info?.(`reclaimed name "${newName}" from dead session ${existing.id} (tombstoned as "${tombstoneName}")`)
  }
  const oldName = ctx.getName()
  // A rename is the same session (same pid, same socket, same ctx.sessionId).
  // The tribe-wire daemon is role-agnostic (F12) — there is no chief claim to
  // carry across the rename, so a rename can no longer flap a coordination
  // identity. Chief-ness is an L3 fact (the `@chief` bead lease).
  ctx.stmts.renameSession.run({ $new_name: newName, $session_id: ctx.sessionId, $now: Date.now() })
  ctx.setName(newName)
  opts.setUserRenamed(true) // Explicit rename — name is now sticky, won't be overridden
  // Actionable-mailbox recovery (19442): the mailbox travels with the NAME.
  // Any unacknowledged actionable directs addressed to `newName` surface on
  // the next default `tribe.fetch` (injected ahead of the ambient window) —
  // no cursor rewind, no ambient replay. Here we only count and nudge.
  const recoveredActionables = countUnackedActionables(ctx, newName)
  if (recoveredActionables > 0) {
    log.info?.(`actionable-recovery: ${recoveredActionables} unacked actionable(s) await "${newName}" (rename)`)
    opts.notifyWakeupForReplay?.(ctx.sessionId, newName)
  }
  // Broadcast the rename
  sendMessage(ctx, "*", `Member "${oldName}" is now "${newName}"`, "notify")
  logEvent(ctx, "session.renamed", undefined, { old_name: oldName, new_name: newName })
  return jsonResult({
    renamed: true,
    old_name: oldName,
    new_name: newName,
    ...(recoveredActionables > 0 ? { recovered_actionables: recoveredActionables } : {}),
  })
}

function handleJoin(ctx: TribeContext, a: ToolArgs, opts: HandlerOpts): ToolResult {
  let joinName = a.name as string
  let joinRole = (a.role as string) ?? ctx.sessionRole
  const joinDomains = (a.domains as string[]) ?? ctx.domains
  const identityToken = (a.identity_token as string) ?? (a.identityToken as string) ?? null
  // @km/tribe/19975 — a join/refresh is authoritative for the session's
  // account/provider label. ag sets these from TRIBE_ACCOUNT / TRIBE_PROVIDER
  // and the stdio-adapter forwards them on every join, so re-joining (which
  // /up does each session start) self-corrects a stale label. NULL when the
  // launch context didn't set them — `updateSessionMeta` COALESCEs so an
  // unlabelled join never wipes a good label.
  const joinAccount = (a.account as string) ?? null
  const joinProvider = (a.provider as string) ?? null
  const selfInfo = opts.getActiveSessionInfo().find((session) => session.id === ctx.sessionId)

  // Identity-token adoption: if the caller supplies a token that matches a
  // non-active prior session, inherit its name/role when the caller didn't
  // pass them explicitly. Symmetric with the register path in tribe-daemon.
  if (identityToken) {
    const prior = ctx.db
      .prepare(
        "SELECT id, name, role FROM sessions WHERE identity_token = $tok AND id != $id ORDER BY updated_at DESC LIMIT 1",
      )
      .get({ $tok: identityToken, $id: ctx.sessionId }) as {
      id: string
      name: string
      role: string
    } | null
    if (prior) {
      const isActive = opts.getActiveSessionIds().has(prior.id)
      if (!isActive) {
        if (!a.name) joinName = prior.name
        if (!a.role) joinRole = prior.role
      }
    }
  }

  // Validate name format
  const joinNameError = validateName(joinName)
  if (joinNameError) {
    return jsonResult({ error: joinNameError })
  }

  const hasSelfRow = ctx.db.prepare("SELECT 1 FROM sessions WHERE id = $id LIMIT 1").get({ $id: ctx.sessionId }) as {
    1: number
  } | null
  if (!hasSelfRow) {
    const requestedDelivery = a.delivery === "push" || a.delivery === "pull" ? a.delivery : undefined
    // 21052 — carry the connected client's metadata into the late-registration
    // row. Daemon-local pid/cwd values make the persisted member identity sticky
    // to the broker rather than the client that owns the session.
    registerSession(
      ctx,
      undefined,
      (sessionId) => opts.getActiveSessionIds().has(sessionId),
      identityToken,
      selfInfo?.pid ?? 0,
      requestedDelivery,
      selfInfo?.cwd ?? process.cwd(),
      joinAccount,
      joinProvider,
    )
    const tail = (ctx.stmts.getMessageTailSeq.get() as { seq: number } | null)?.seq ?? 0
    ctx.stmts.resetSessionDeliveryOffsets.run({ $id: ctx.sessionId, $seq: tail, $ts: Date.now() })
  }

  // Check if name is taken. Like handleRename, reclaim from non-active holders
  // by tombstoning the dead row (preserves message journal addressability).
  const taken = ctx.stmts.checkNameTaken.get({ $name: joinName, $session_id: ctx.sessionId }) as
    | { id: string }
    | undefined
  if (taken) {
    const holderIsActive = opts.getActiveSessionIds().has(taken.id)
    if (!holderIsActive) {
      // Dead session — tombstone and reclaim.
      const tombstoneName = `${joinName}-dead-${taken.id.slice(0, 8)}`
      ctx.db
        .prepare("UPDATE sessions SET name = $tomb, updated_at = $now WHERE id = $id")
        .run({ $tomb: tombstoneName, $now: Date.now(), $id: taken.id })
      log.info?.(`reclaimed name "${joinName}" from dead session ${taken.id} (tombstoned as "${tombstoneName}")`)
    } else {
      // Active holder — tribe.join is an explicit identity assertion ("I am
      // @agent/3"). The old holder is a stale adapter process from a previous
      // session that Claude Code didn't kill. Tombstone and take over — the
      // user's explicit name wins over a lingering socket.
      const tombstoneName = `${joinName}-dead-${taken.id.slice(0, 8)}`
      ctx.db
        .prepare("UPDATE sessions SET name = $tomb, updated_at = $now WHERE id = $id")
        .run({ $tomb: tombstoneName, $now: Date.now(), $id: taken.id })
      log.info?.(
        `tribe.join takeover: "${joinName}" reclaimed from active session ${taken.id} (tombstoned as "${tombstoneName}")`,
      )
    }
  }

  const prevName = ctx.getName()
  // Note: renames are in-place; the old name is not preserved.

  ctx.stmts.updateSessionMeta.run({
    $id: ctx.sessionId,
    $name: joinName,
    $role: joinRole,
    $domains: JSON.stringify(joinDomains),
    $account: joinAccount,
    $provider: joinProvider,
    $pid: selfInfo?.pid ?? null,
    $cwd: selfInfo?.cwd ?? null,
    $now: Date.now(),
  })
  ctx.setName(joinName)
  ctx.setRole(joinRole as TribeRole)

  // km-bearly.tribe-dm-delivery-gap: declare delivery mode. `push` (default)
  // means the daemon fans events out on the MCP channel; `pull` queues them
  // and the agent drains via tribe.fetch. MCP-only clients (codex, gemini,
  // etc.) without a notification reader should join with `pull`.
  const deliveryRaw = a.delivery
  if (deliveryRaw === "push" || deliveryRaw === "pull") {
    ctx.stmts.setSessionDelivery.run({
      $id: ctx.sessionId,
      $delivery: deliveryRaw,
      $now: Date.now(),
    })
  }
  const delivery =
    deliveryRaw === "push" || deliveryRaw === "pull"
      ? deliveryRaw
      : ((
          ctx.db.prepare("SELECT delivery FROM sessions WHERE id = $id").get({ $id: ctx.sessionId }) as
            | { delivery: string }
            | undefined
        )?.delivery ?? "push")

  // Actionable-mailbox recovery (19442): claiming a name inherits its durable
  // mailbox — any unacknowledged actionable directs surface on the next
  // default `tribe.fetch` without touching the ambient session cursor. A
  // same-name join is only a refresh, and the mailbox cursor already reflects
  // everything this session has acknowledged, so counting is claim-only.
  const recoveredActionables = prevName === joinName ? 0 : countUnackedActionables(ctx, joinName)
  if (recoveredActionables > 0) {
    log.info?.(`actionable-recovery: ${recoveredActionables} unacked actionable(s) await "${joinName}" (join)`)
    opts.notifyWakeupForReplay?.(ctx.sessionId, joinName)
  }

  logEvent(ctx, "session.joined", undefined, {
    name: joinName,
    role: joinRole,
    domains: joinDomains,
    delivery,
    rejoin: true,
  })

  return jsonResult({
    joined: true,
    name: joinName,
    role: joinRole,
    domains: joinDomains,
    delivery,
    previous_name: joinName !== prevName ? prevName : undefined,
    // 15654 Part 1 — notification-semantics primer. See TRIBE_JOIN_PRIMER docstring.
    primer: TRIBE_JOIN_PRIMER,
    ...(recoveredActionables > 0 ? { recovered_actionables: recoveredActionables } : {}),
  })
}

function handleHealth(ctx: TribeContext, opts: HandlerOpts): ToolResult {
  const silentThreshold = Date.now() - 300_000 // 5 minutes

  // Liveness comes from the daemon's in-memory clients Map. Dead sessions
  // are simply absent from activeSessionInfo — no DB pruning required.
  const activeInfo = opts.getActiveSessionInfo()
  const byId = new Map(activeInfo.map((s) => [s.id, s]))
  const rows = ctx.stmts.allSessions.all() as Array<{
    id: string
    name: string
    role: string
    domains: string
    pid: number
    started_at: number
    updated_at: number
  }>
  const liveSessions = rows.filter((r) => byId.has(r.id))

  const members = liveSessions.map((s) => {
    const active = byId.get(s.id)!
    const alive = true // by definition — only connected sessions reported
    // Find last message from this member
    const lastMsg = ctx.db
      .prepare("SELECT ts FROM messages WHERE sender = $name ORDER BY ts DESC LIMIT 1")
      .get({ $name: s.name }) as { ts: number } | null

    const lastMsgAge = lastMsg ? Date.now() - lastMsg.ts : null
    const warnings: string[] = []
    if (alive && lastMsgAge && lastMsgAge > silentThreshold) {
      warnings.push(`no message in ${Math.round(lastMsgAge / 60_000)} min`)
    }
    if (!lastMsg) warnings.push("never sent a message")

    // Spawn-time identity binding (@km/tribe/spawn-time-identity-binding):
    // a session whose stored PID is dead is a structural zombie — the
    // daemon thinks it's connected but the owning OS process is gone.
    // Surface this so health checks + chief reconciliation can detect
    // and clean up before a second `claude --name @agent/N` collides.
    const transportPids = active.transportPids
    const pidAlive = transportPids.length === 0 || transportPids.some((pid) => pidStillAlive(pid))
    if (!pidAlive) {
      warnings.push(`transport pids ${transportPids.join(",")} are dead — session is a zombie`)
    }

    return {
      member_id: s.id,
      name: s.name,
      role: s.role,
      domains: parseDomains(s.domains),
      pid: active.pid,
      launch_id: active.launchId,
      launch_parent_pid: active.launchParentPid,
      transport_pids: transportPids,
      alive,
      pid_alive: pidAlive,
      last_message: lastMsgAge ? `${Math.round(lastMsgAge / 60_000)} min ago` : "never",
      warnings,
    }
  })

  // Actionable unread direct-message count per recipient. This intentionally
  // mirrors getUnreadDms/chief-silent semantics: ambient notify/status/response
  // DMs should not surface as stop-line backlog when pending(owner) is empty.
  const unread = ctx.db
    .prepare(`
				SELECT m.recipient, COUNT(*) as count FROM messages m
				WHERE m.recipient != '*'
				AND m.kind = 'direct'
				AND m.type IN ('request', 'query', 'verdict', 'assign')
				AND m.rowid > COALESCE(
					(SELECT s.last_inbox_pull_seq FROM sessions s WHERE s.name = m.recipient),
					0
				)
				GROUP BY m.recipient
			`)
    .all() as Array<{ recipient: string; count: number }>

  const stats = {
    messages: (ctx.db.prepare("SELECT COUNT(*) as n FROM messages").get() as { n: number } | undefined)?.n ?? 0,
    events:
      (ctx.db.prepare("SELECT COUNT(*) as n FROM messages WHERE kind = 'event'").get() as { n: number } | undefined)
        ?.n ?? 0,
  }

  // Observability facts (@km/bearly/17018) — tool latency, DB pressure, and
  // (daemon-only) registry/identity gauges, folded into the degraded contract.
  const tool_latency = computeToolLatency()
  const dbPressure = computeDbPressure(ctx.db)
  const registryClients = opts.getRegistryClients?.()
  const registryGauges = registryClients ? computeRegistryGauges(registryClients, Date.now()) : null
  const degraded = evaluateDegraded({
    wal_bytes: dbPressure.wal_bytes,
    sessions_rows: dbPressure.sessions_rows,
    archive_rows: dbPressure.archive_rows,
    pending_placeholder_conns: registryGauges?.pending_placeholder_conns ?? null,
    personas_multi_launch: registryGauges?.personas_multi_launch ?? null,
    tool_latency,
  })

  // Stale-code detector (@km/tribe/20033): surface whether the running daemon
  // is provably older than the on-disk / superproject-pinned tribe code, so a
  // stale daemon serving old handlers is observable (not silent) to any
  // tribe.health() reader and the health-monitor.
  const result: Record<string, unknown> = {
    members,
    unread,
    stats,
    tool_latency,
    db_bytes: dbPressure.db_bytes,
    wal_bytes: dbPressure.wal_bytes,
    sessions_rows: dbPressure.sessions_rows,
    messages_rows: dbPressure.messages_rows,
    archive_rows: dbPressure.archive_rows,
    ...(registryGauges ?? {}),
    degraded,
    code_pin: gatherCodePin(),
    checked_at: new Date().toISOString(),
  }
  // L4 of @km/tribe/stable-coordination: surface the chief-reconciler's
  // four-source reconciliation (live processes / bead claims / worktrees /
  // tribe sessions) inline so any session asking tribe.health() sees
  // orphans in real-time. Opt-in via TRIBE_RECONCILER_SNAPSHOT env var so
  // the bearly daemon stays km-agnostic for standalone deployments.
  const reconciler = readReconcilerSnapshot()
  if (reconciler) result.reconciler = reconciler
  return jsonResult(result)
}

function handleReload(ctx: TribeContext, a: ToolArgs, cleanup: () => void): ToolResult {
  const reason = (a.reason as string) ?? "manual reload"
  logEvent(ctx, "session.reload", undefined, { name: ctx.getName(), reason })
  log.info?.(`reloading: ${reason}`)

  // Schedule the re-exec after the tool response is flushed.
  //
  // We deliberately do NOT spawn the replacement daemon here. A naive
  // `Bun.spawn([execPath, ...process.argv])` re-exec races the old daemon to
  // re-bind the socket, sees "Another daemon is already listening", and exits
  // immediately; meanwhile the old daemon also exits. Net result: NO daemon,
  // and every session sees "No daemon running". (Reproduced 2026-05-21 — a
  // session calling `tribe.reload` repeatedly killed the daemon.)
  //
  // Instead we SIGHUP ourselves. The daemon's `withSignals` factory routes
  // SIGHUP → `withHotReload.reload()`, which closes + unlinks the socket then
  // spawns a DETACHED replacement that binds the freed path fresh — the
  // replacement survives this process's exit, and adapters reconnect
  // transparently. This is the same hardened path `tribe reload` (the CLI)
  // already uses.
  setTimeout(() => {
    cleanup()
    log.info?.(`SIGHUP self (pid=${process.pid}) — hot-reload via detached re-exec`)
    process.kill(process.pid, "SIGHUP")
  }, 100) // small delay so the tool response gets sent first

  return jsonResult({ reloading: true, reason, pid: process.pid })
}

async function handleRetro(ctx: TribeContext, a: ToolArgs): Promise<ToolResult> {
  const { generateRetro, formatMarkdown, parseDuration } = await import("./retro.ts")
  const sinceStr = a.since as string | undefined
  let sinceMs: number | undefined
  if (sinceStr) {
    try {
      sinceMs = parseDuration(sinceStr)
    } catch {
      return jsonResult({ error: `Invalid duration: "${sinceStr}"` })
    }
  }
  const fmt = (a.format as string) ?? "markdown"
  const report = generateRetro(ctx.db, sinceMs)
  // Retro is one of the two string-typed tool results (markdown vs json) —
  // we still emit `structuredContent: { text }` so the shape contract is
  // uniform; chat-surface shows the markdown / pretty JSON as-is.
  if (fmt === "json") {
    return jsonResult(report)
  }
  const markdown = formatMarkdown(report)
  return jsonResult({ text: markdown }, { text: markdown })
}

function handleDebug(_ctx: TribeContext, a: ToolArgs, opts: HandlerOpts): ToolResult {
  // Prefer the daemon-provided dump when available (richest snapshot: clients
  // Map, per-session cursors). Otherwise synthesize a minimal view from the
  // generic accessors so in-process tests still get meaningful output without
  // wiring getDebugState. `full: true` requests the complete cursor dump; the
  // daemon otherwise caps it (@km/bearly/17018 — see summarizeCursors).
  const full = a.full === true
  const state = opts.getDebugState
    ? opts.getDebugState({ full })
    : {
        clients: opts.getActiveSessionInfo(),
        cursors_total: 0,
        cursors: [],
      }
  return jsonResult(state)
}

function handleRepair(ctx: TribeContext, a: ToolArgs): ToolResult {
  const sessionName = typeof a.session === "string" && a.session.length > 0 ? a.session : ctx.getName()
  const repairMode = (a.inbox_cursor ?? a.inboxCursor) as unknown
  if (repairMode !== "tail") {
    return jsonResult({ error: 'repair requires inbox_cursor: "tail"' })
  }

  const tail = (ctx.stmts.getMessageTailSeq.get() as { seq: number } | null)?.seq ?? 0
  let createdSession = false
  let row = ctx.db
    .prepare("SELECT id, last_inbox_pull_seq FROM sessions WHERE name = $name LIMIT 1")
    .get({ $name: sessionName }) as { id: string; last_inbox_pull_seq: number } | null
  if (!row) {
    const now = Date.now()
    const id = `repair-${randomUUID()}`
    ctx.stmts.upsertSession.run({
      $id: id,
      $name: sessionName,
      $role: "member",
      $domains: "[]",
      $pid: 0,
      $cwd: process.cwd(),
      $project_id: null,
      $claude_session_id: null,
      $claude_session_name: null,
      $identity_token: null,
      $launch_id: null,
      $launch_parent_pid: null,
      $now: now,
      $delivery: "pull",
      $account: null,
      $provider: null,
    })
    row = { id, last_inbox_pull_seq: 0 }
    createdSession = true
  }

  ctx.stmts.advanceInboxCursor.run({ $id: row.id, $seq: tail, $now: Date.now() })
  const after = ctx.stmts.getInboxCursor.get({ $id: row.id }) as { last_inbox_pull_seq: number } | null

  return jsonResult({
    repaired: true,
    created_session: createdSession,
    session: sessionName,
    repair: "inbox_cursor_to_tail",
    cursor_before: row.last_inbox_pull_seq,
    cursor_after: after?.last_inbox_pull_seq ?? row.last_inbox_pull_seq,
    tail,
  })
}

function handleInboxWait(ctx: TribeContext, a: ToolArgs, opts: HandlerOpts): ToolResult | Promise<ToolResult> {
  const { session, timeoutMs } = resolveInboxWaitOptions(a, { defaultSession: ctx.getName() })
  if (!opts.inboxWait) {
    return jsonResult({ error: "inbox wait is unavailable in this handler context" })
  }
  return opts.inboxWait.wait(session, ctx.sessionId, timeoutMs).then((result) => jsonResult(result))
}

// ---------------------------------------------------------------------------
// km-tribe.event-classification handlers
// ---------------------------------------------------------------------------

type FetchRow = {
  id: string
  rowid: number
  type: string
  sender: string
  recipient: string
  content: string
  bead_id: string | null
  ref: string | null
  ts: number
  delivery: string
  topic: string | null
  room_id: string | null
  summary: string | null
}

type SnapshotFilters = {
  currentName: string
  limit: number
  since: number | null
  withPeer: string | null
  from: string | null
  to: string | null
}

function sessionRoster(ctx: TribeContext): SessionRoster {
  return ctx.db.prepare("SELECT name, role FROM sessions").all() as Array<{ name: string; role: string | null }>
}

function filterRowsByTrust(ctx: TribeContext, rows: FetchRow[]): FetchRow[] {
  if (rows.length === 0) return rows
  const roster = sessionRoster(ctx)
  return rows.filter((r) => senderMayUseRegisteredTrustTopic(r.topic, r.sender, roster))
}

function querySnapshotRows(ctx: TribeContext, filters: SnapshotFilters): FetchRow[] {
  const conditions = ["kind != 'event'"]
  const params: Record<string, number | string> = { $limit: filters.limit }

  if (filters.since !== null) {
    conditions.push("rowid > $since")
    params.$since = filters.since
  }
  if (filters.withPeer !== null) {
    conditions.push("((sender = $self AND recipient = $peer) OR (sender = $peer AND recipient = $self))")
    params.$self = filters.currentName
    params.$peer = filters.withPeer
  }
  if (filters.from !== null) {
    conditions.push("sender = $from")
    params.$from = filters.from
  }
  if (filters.to !== null) {
    conditions.push("recipient = $to")
    params.$to = filters.to
  }

  const order = filters.since !== null ? "ASC" : "DESC"
  const rows = ctx.db
    .prepare(`
      SELECT id, rowid, type, sender, recipient, content, bead_id, ref, ts, delivery, topic, room_id, summary
      FROM messages
      WHERE ${conditions.join("\n        AND ")}
      ORDER BY rowid ${order}
      LIMIT $limit
    `)
    .all(params) as FetchRow[]
  return filters.since !== null ? rows : rows.reverse()
}

function rowMatchesSnapshotFilters(row: FetchRow, filters: Omit<SnapshotFilters, "limit">): boolean {
  if (filters.since !== null && row.rowid <= filters.since) return false
  if (
    filters.withPeer !== null &&
    !(
      (row.sender === filters.currentName && row.recipient === filters.withPeer) ||
      (row.sender === filters.withPeer && row.recipient === filters.currentName)
    )
  ) {
    return false
  }
  if (filters.from !== null && row.sender !== filters.from) return false
  if (filters.to !== null && row.recipient !== filters.to) return false
  return true
}

function handleFetch(ctx: TribeContext, a: ToolArgs): ToolResult {
  const limit = typeof a.limit === "number" && a.limit > 0 && a.limit <= 500 ? a.limit : 50
  const topics = normalizeStringArray(a.topics)
  if (a.topics !== undefined && topics === null) {
    return jsonResult({ error: "topics must be an array of strings." })
  }

  // Topic-filtered reads are SNAPSHOTS (@km/tribe/19785): filters = views,
  // the default drain is the ONE cursor-advancing consumer. The old behavior
  // advanced past the last MATCHING row, silently consuming non-matching rows
  // in the gap — message loss (NO SILENT ERRORS class). An explicit
  // advance:true with topics would be that loss on request — reject it loudly.
  const topicsAreSnapshot = topics !== null && topics.length > 0
  if (topicsAreSnapshot && a.advance === true) {
    return jsonResult({
      error: "topics reads are snapshots and never advance the cursor — drain without topics to advance (19785).",
    })
  }

  const cursor = ctx.stmts.getInboxCursor.get({ $id: ctx.sessionId }) as { last_inbox_pull_seq: number } | null
  const currentName = ctx.getName()
  let rows: FetchRow[]
  let shouldAdvance = false
  let cursorBase = cursor?.last_inbox_pull_seq ?? 0
  const since = typeof a.since === "number" ? a.since : null
  if (since !== null) cursorBase = since
  const withPeer = typeof a.with === "string" && a.with.length > 0 ? a.with : null
  const from = typeof a.from === "string" && a.from.length > 0 ? a.from : null
  const to = typeof a.to === "string" && a.to.length > 0 ? a.to : null
  const snapshotFilters = { currentName, since, withPeer, from, to }

  const ids = normalizeStringArray(a.ids)
  if (a.ids !== undefined && ids === null) {
    return jsonResult({ error: "ids must be an array of strings." })
  }

  if (ids && ids.length > 0) {
    const placeholders = ids.map(() => "?").join(", ")
    rows = ctx.db
      .prepare(`
        SELECT id, rowid, type, sender, recipient, content, bead_id, ref, ts, delivery, topic, room_id, summary
        FROM messages
        WHERE id IN (${placeholders})
          AND kind != 'event'
        ORDER BY rowid ASC
        LIMIT ?
      `)
      .all(...ids, limit) as FetchRow[]
    const byId = new Map(rows.map((r) => [r.id, r]))
    rows = ids
      .map((id) => byId.get(id))
      .filter((r): r is FetchRow => !!r)
      .filter((r) => rowMatchesSnapshotFilters(r, snapshotFilters))
  } else if (withPeer !== null || from !== null || to !== null || since !== null) {
    rows = querySnapshotRows(ctx, { ...snapshotFilters, limit })
    shouldAdvance = !topicsAreSnapshot && since !== null && a.advance === true
  } else {
    // 19442 — inject unacknowledged actionable directs (the durable mailbox)
    // ahead of the ambient window. Recovery rows are bounded to rowid <=
    // cursorBase, so they can never duplicate a window row, and the ambient
    // session cursor is never rewound — a claim/rename floods nothing. See
    // selectUnackedActionables in database.ts.
    const recovered = ctx.stmts.selectUnackedActionables.all({
      $name: currentName,
      $upto: cursorBase,
      $limit: limit,
    }) as FetchRow[]
    const windowBudget = limit - recovered.length
    const windowRows =
      windowBudget > 0
        ? (ctx.stmts.getInboxRows.all({
            $since: cursorBase,
            $name: currentName,
            $limit: windowBudget,
          }) as FetchRow[])
        : []
    rows = [...recovered, ...windowRows]
    shouldAdvance = !topicsAreSnapshot && a.advance !== false
  }

  const visibleRows = rows
  rows = filterRowsByTrust(ctx, visibleRows)
  const filtered = topics && topics.length > 0 ? rows.filter((r) => matchesGlob(topics, r.topic)) : rows
  const cursorRows = topics && topics.length > 0 ? visibleRows.filter((r) => matchesGlob(topics, r.topic)) : visibleRows
  let outputCursor = Math.max(cursorBase, filtered.at(-1)?.rowid ?? cursorBase)

  if (cursorRows.length > 0 && shouldAdvance) {
    const last = cursorRows.at(-1)
    if (last) {
      const seq = Math.max(cursorBase, last.rowid)
      ctx.stmts.advanceInboxCursor.run({ $id: ctx.sessionId, $seq: seq, $now: Date.now() })
      outputCursor = seq
    }
  }

  // 19442 — acknowledge returned actionables into the durable mailbox. The
  // caller is about to see `filtered`; every actionable direct in it (typed
  // per ACTIONABLE_TYPES, addressed to this name, not self-sent) advances the
  // recipient-keyed mailbox cursor so no later claim of this name re-recovers
  // it. Advance-only. A trust- or topic-excluded row is policy-excluded, not
  // "unseen" — it never blocks the cursor.
  if (shouldAdvance) {
    let lastActionable = 0
    for (const r of filtered) {
      if (r.recipient === currentName && r.sender !== currentName && ACTIONABLE_TYPES_SET.has(r.type)) {
        lastActionable = Math.max(lastActionable, r.rowid)
      }
    }
    if (lastActionable > 0) {
      ctx.stmts.advanceMailboxCursor.run({ $recipient: currentName, $seq: lastActionable, $now: Date.now() })
    }
  }

  const events = filtered.map((r) => ({
    id: r.id,
    rowid: r.rowid,
    type: r.type,
    from: r.sender,
    to: r.recipient,
    content: r.content,
    bead: r.bead_id,
    ref: r.ref,
    ts: new Date(r.ts).toISOString(),
    delivery: r.delivery,
    topic: r.topic,
    room_id: r.room_id,
    summary: r.summary,
  }))
  return jsonResult({ events, cursor: outputCursor })
}

function normalizeStringArray(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((s) => typeof s !== "string")) return null
  return value as string[]
}

function matchesGlob(globs: string[], value: string | null): boolean {
  if (!value) return false
  for (const g of globs) {
    if (g === "*") return true
    if (!g.includes("*") && g === value) return true
    if (g.includes("*")) {
      const re: RegExp = new RegExp("^" + g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$")
      if (re.test(value)) return true
    }
  }
  return false
}

/**
 * Apply a session-level event filter — combines persistent mode + time-bounded
 * mute + per-topic glob list into a single tool call.
 *
 * Empty args clear the filter (mode → 'normal', mute + until → null).
 * `until` is an absolute unix-ms timestamp. `mute` without `until` is persistent.
 *
 * Direct messages always bypass mute/until — only `mode: 'focus'` filters DMs.
 */
function handleFilter(ctx: TribeContext, a: ToolArgs): ToolResult {
  const rawMode = a.mode
  if (rawMode !== undefined && rawMode !== "focus" && rawMode !== "normal" && rawMode !== "ambient") {
    return jsonResult({ error: `Invalid mode: "${String(rawMode)}". Use focus|normal|ambient.` })
  }
  const mode = (rawMode as string | undefined) ?? "normal"

  const rawUntil = a.until
  if (rawUntil !== undefined && (typeof rawUntil !== "number" || rawUntil < 0)) {
    return jsonResult({ error: "until must be a non-negative unix-ms timestamp." })
  }
  const until = (rawUntil as number | undefined) ?? null

  const rawMute = a.mute
  if (rawMute !== undefined && (!Array.isArray(rawMute) || rawMute.some((topic) => typeof topic !== "string"))) {
    return jsonResult({ error: "mute must be an array of strings." })
  }
  const mute = Array.isArray(rawMute) && rawMute.length > 0 ? JSON.stringify(rawMute) : null

  ctx.stmts.setSessionFilter.run({
    $id: ctx.sessionId,
    $mode: mode,
    $until: until,
    $mute: mute,
    $now: Date.now(),
  })

  return jsonResult({
    set: true,
    mode,
    until: until !== null ? new Date(until).toISOString() : null,
    mute: Array.isArray(rawMute) ? rawMute : null,
  })
}

// ---------------------------------------------------------------------------
// Lifecycle snapshots — per-session diagnostic cache.
//
// A session publishes its tool-call-lifecycle snapshot on every state
// transition (S1 of `@km/infra/15630-stuck-agent-observability`); chief
// / observers read the latest snapshot to diagnose stuck-agent situations.
// The daemon is opaque about the payload shape — the publisher owns the
// schema. See `lifecycle-store.ts` for the in-memory store, and the bead
// body for the larger architecture (S1 reducer, S2 observer, S3 typed
// diagnostic ChatEvent, S4 = this surface + chief introspection).
// ---------------------------------------------------------------------------

function lifecycleSnapshotJson(record: LifecycleSnapshotRecord): Record<string, unknown> {
  return {
    sessionName: record.sessionName,
    sessionId: record.sessionId,
    receivedAt: new Date(record.receivedAt).toISOString(),
    payload: record.payload,
  }
}

function handleLifecyclePublish(ctx: TribeContext, a: ToolArgs, opts: HandlerOpts): ToolResult {
  const store = opts.getLifecycleStore?.()
  if (!store) {
    return jsonResult({ error: "lifecycle store unavailable (daemon required)" })
  }
  const payload = a.snapshot
  if (payload === undefined || payload === null) {
    return jsonResult({ error: "snapshot field is required" })
  }
  // A publisher MAY attribute the snapshot to an explicit session name. This is
  // required for multiplexing observers (one silvercode host watches many agent
  // sessions over a single daemon connection): the connection name is the host,
  // not the agent, so without this every host's snapshots collapse onto one
  // shared name and `tribe.lifecycle("@agent/N")` can't find them (bead 20080).
  // Falls back to the connection's own name for single-identity publishers.
  const explicitName = a.sessionName
  if (explicitName !== undefined && typeof explicitName !== "string") {
    return jsonResult({ error: "sessionName field must be a string when provided" })
  }
  const sessionName = typeof explicitName === "string" && explicitName.length > 0 ? explicitName : ctx.getName()
  const record = store.set(sessionName, ctx.sessionId, payload, Date.now())
  return jsonResult({
    published: true,
    sessionName: record.sessionName,
    receivedAt: new Date(record.receivedAt).toISOString(),
  })
}

/**
 * km @ag/super/20324-chain-refactor/20327 gap-4 — publish an agent recovery
 * (force-settle / restart / rotation) as an ambient `health:recovery` broadcast.
 *
 * Why a dedicated tool (not tribe.send): the send tool deliberately omits topic
 * (clients cannot set arbitrary topics — trust.ts gates registered topics), and
 * `health:*` topics are daemon-classified (the accountly-plugin emits them
 * server-side). This is the host-facing seam for that same server-side
 * classification, mirroring tribe.lifecycle.publish. The recovering agent's
 * identity travels in `content` (and `agent`/`seq` metadata) — the connection is
 * the host, not the agent.
 */
function handleHealthPublish(ctx: TribeContext, a: ToolArgs, _opts: HandlerOpts): ToolResult {
  const content = a.content
  if (typeof content !== "string" || content.length === 0) {
    return jsonResult({ error: "content field is required (a non-empty string)" })
  }
  // Optional metadata for consumer dedup/ordering — the per-agent monotonic seq
  // from the lateral producer. Never load-bearing for the emit itself.
  const agent = typeof a.agent === "string" ? a.agent : undefined
  const seq = typeof a.seq === "number" ? a.seq : undefined
  const result = sendMessage(
    ctx,
    "*",
    sanitizeMessage(content),
    HEALTH_RECOVERY_TOPIC, // type == topic, mirroring the accountly-plugin's health:* broadcasts
    undefined,
    undefined,
    "broadcast",
    { delivery: "pull", topic: HEALTH_RECOVERY_TOPIC },
  )
  logEvent(ctx, `message.sent.${HEALTH_RECOVERY_TOPIC}`, undefined, { agent, seq, message_id: result.id })
  return jsonResult({ published: true, id: result.id, agent, seq })
}

function handleLifecycle(a: ToolArgs, opts: HandlerOpts): ToolResult {
  const store = opts.getLifecycleStore?.()
  if (!store) {
    return jsonResult({ error: "lifecycle store unavailable (daemon required)" })
  }
  const sessionArg = a.session
  if (sessionArg !== undefined && typeof sessionArg !== "string") {
    return jsonResult({ error: "session field must be a string when provided" })
  }
  if (typeof sessionArg === "string" && sessionArg.length > 0) {
    const record = store.get(sessionArg)
    if (!record) {
      return jsonResult({ session: sessionArg, snapshot: null })
    }
    return jsonResult({ session: sessionArg, snapshot: lifecycleSnapshotJson(record) })
  }
  // No session arg → return all known snapshots, newest first.
  return jsonResult({ snapshots: store.list().map(lifecycleSnapshotJson) })
}
