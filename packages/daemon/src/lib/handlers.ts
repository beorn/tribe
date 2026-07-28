/**
 * Tribe tool handlers — all MCP tool case implementations.
 */

import { createLogger } from "loggily"
import { randomUUID } from "node:crypto"
import { resolveInboxWaitOptions, type InboxWaitResult } from "tribe-wire"
import type { TribeContext } from "./context.ts"
import type { TribeRole } from "tribe-wire/lib/config"

const log = createLogger("tribe:handlers")
import { existsSync, readFileSync, statSync } from "node:fs"
import { validateName, sanitizeMessageWithReport, MESSAGE_MAX_LENGTH, type SanitizedMessage } from "./validation.ts"
import {
  sendMessage,
  deriveSummary,
  logEvent,
  countUnackedAttention,
  MAX_BALL_TTL_MS,
  type Classification,
  type Delivery,
} from "./messaging.ts"
import { ACTIONABLE_TYPES_SET, ACTIONABLE_TYPES_SQL, AUTO_TRACK_TYPES_SET } from "./database.ts"
import {
  classifySessionRegistrationLifetime,
  isPidAlive as pidStillAlive,
  persistRuntimeRename,
  registerSession,
  type StaleTransportReapReport,
} from "./session.ts"
import { gatherCodePin } from "./code-pin.ts"
import { parseDbGrowthWarningBytes, projectHealthCadence } from "./health-cadence.ts"
import { senderMayUseRegisteredTrustTopic, type SessionRoster } from "./trust.ts"
import type { LifecycleStore, LifecycleSnapshotRecord } from "./lifecycle-store.ts"
import { projectSessionLiveness, projectSessionTransportState } from "./session-transport-state.ts"
import type { DirectDeliveryResolution, DirectDeliveryResolver } from "./delivery-resolution.ts"

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
 *   2. `assign` / `query` / `request` / `verdict` messages are the ACTIONABLE
 *      channel. Direct `notify` / `status` / `response` rows are inbox-visible,
 *      but do not wake `inbox.wait` by default; callers may opt into validated
 *      `status` / `response` replies to their own tracked requests.
 *   3. Every non-self direct assign/query/request automatically opens one
 *      semantic response ball. Verdict stays actionable and wakeable without
 *      automatically minting another obligation. Answer
 *      or explicitly defer tracked work with the structured MCP
 *      `reply: "<request-id>"` field (CLI: `--reply <request-id>`), never a
 *      prose `reply=...` marker; a transport/read acknowledgement is neither
 *      required nor sufficient to release that ownership.
 *
 * Bead: `@km/code/15654` (Part 1).
 */
export const TRIBE_JOIN_PRIMER =
  "Tribe notification semantics: messages from `from: daemon` (github:push, " +
  'session events, health) and broadcasts (`to: "*"`) are AMBIENT awareness ' +
  "only — surface in `tribe.fetch` reads but DO NOT act on them. Direct " +
  "`type: assign`/`query`/`request` messages are actionable, wake `inbox.wait`, " +
  "and automatically open a semantic response ball. Direct `type: verdict` is " +
  "also actionable and wakeable, but does not automatically open another ball. " +
  "Direct `notify`/`status`/`response` rows are inbox-visible and not wakeable by default; " +
  "a waiter may explicitly opt into validated `status`/`response` replies to its own tracked requests. " +
  "Answer or explicitly defer each actionable with the structured MCP " +
  '`reply: "<request-id>"` field (CLI: `--reply <request-id>`), never a prose ' +
  "`reply=...` marker, so its semantic ball closes; no transport or exact-id " +
  "delivery ACK is required."

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
const REMOVED_TRIBE_METHOD_HINT = "use send/fetch/filter — see docs/architecture.md"

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
  /**
   * Return whether any non-pending transport is connected for a session.
   * Unlike getActiveSessionIds, this includes watch transports and is the
   * authority for destructive reclaim decisions.
   */
  hasActiveTransport: (sessionId: string) => boolean
  isReconnectGraceProtected?: (sessionId: string, nowMs: number) => boolean
  /** Realtime snapshot of connected sessions (daemon clients Map). */
  getActiveSessionInfo: () => ActiveSessionInfo[]
  /** Optional: dump daemon internals for `tribe.debug`. Daemon-only (tests using
   *  handlers directly can omit this — `tribe.debug` then returns a minimal
   *  snapshot synthesized from the other accessors). */
  getDebugState?: () => Record<string, unknown>
  /** Optional: per-session lifecycle-snapshot cache (last-write-wins).
   *  Returns the daemon's singleton store; omitted when running handlers
   *  outside the daemon (tests, smoke harness) — `tribe.lifecycle.publish`
   *  / `tribe.lifecycle` then return an `error` field explaining that the
   *  store isn't available, instead of throwing. See `lifecycle-store.ts`
   *  + `@km/infra/15630-stuck-agent-observability` § S4. */
  getLifecycleStore?: () => LifecycleStore
  /** Optional: inbox wait primitive shared by CLI and MCP. */
  inboxWait?: {
    wait: (
      session: string,
      connId: string,
      timeoutMs: number,
      opts?: { readonly wakeOnCorrelatedReply?: boolean },
    ) => Promise<InboxWaitResult>
  }
  /**
   * Optional: fire a JSON-RPC `wakeup` notification at the claiming session's
   * live socket so push-mode clients drain recovered attention immediately,
   * without waiting for the next turn-start `tribe.fetch`. Daemon wires this
   * through the broadcast capability; tests / smoke harness omit it (the
   * mailbox state is durable in the DB regardless — the wakeup is an
   * opportunistic nudge). See `countUnackedAttention` in messaging.ts and
   * the mailbox injection in `handleFetch`.
   */
  notifyWakeupForReplay?: (sessionId: string, claimedName: string) => void
  /** Daemon-owned bounded cleanup. Omitted in direct handler harnesses that do
   * not compose the authenticated transport registry. */
  reapStaleTransports?: () => StaleTransportReapReport
  /**
   * Optional host/project delivery policy. Tribe owns only the generic
   * disposition; concrete parent/fallback routing is injected by composition.
   */
  resolveDelivery?: DirectDeliveryResolver
}

type AcceptedDirectDeliveryResolution = Extract<DirectDeliveryResolution, { readonly status: "accepted" }>

interface ResolvedDirectRecipient {
  readonly recipient: string
  readonly resolution: AcceptedDirectDeliveryResolution
}

export function handleToolCall(
  ctx: TribeContext,
  name: string,
  a: ToolArgs,
  opts: HandlerOpts,
  connId?: string,
): ToolResult | Promise<ToolResult> {
  // Presence heartbeat (@km/tribe/19784): ANY authenticated tool call
  // refreshes the caller's last_seen — presence = "spoke to the daemon
  // recently", not "joined or drained rows recently". Before this, send-only
  // / empty-drain sessions read as idle (the 2026-06-10 false-idle class,
  // pinned in tests/tribe-delivery-semantics.test.ts).
  ctx.stmts.touchSessionPresence.run({ $id: ctx.sessionId, $now: Date.now() })
  switch (name) {
    case TRIBE_COORD_METHODS.send:
      return handleSend(ctx, a, opts)
    case TRIBE_COORD_METHODS.fetch:
      return handleFetch(ctx, a)
    case TRIBE_COORD_METHODS.members:
      return handleSessions(ctx, a, opts)
    case TRIBE_COORD_METHODS.inboxWait:
      return handleInboxWait(ctx, a, opts, connId)
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
      return handleRepair(ctx, a, opts)
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
function listActiveSessionNames(ctx: TribeContext, activeIds?: Set<string> | string[]): string[] {
  const rows = ctx.db.prepare("SELECT id, name FROM sessions").all() as Array<{ id: string; name: string }>
  const active = activeIds
    ? Array.isArray(activeIds)
      ? new Set(activeIds)
      : activeIds
    : new Set(rows.map((r) => r.id))
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
  const raw = typeof value === "string" ? [value] : Array.isArray(value) ? value : null
  if (!raw || raw.length === 0 || raw.some((recipient) => typeof recipient !== "string")) return null

  const recipients: string[] = []
  for (const recipient of raw as string[]) {
    const segments = recipient.split(",").map((segment) => segment.trim())
    if (segments.some((segment) => segment.length === 0)) return null
    recipients.push(...segments)
  }
  const unique = [...new Set(recipients)]
  if (unique.includes("*") && unique.length > 1) return null
  return unique.length === 1 ? unique[0]! : unique
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
  expiresAt: number | null,
  fanout: "first" | "all" | undefined,
  sender: string,
): void {
  for (const recipient of recipients) {
    ctx.stmts.openPendingRequest.run({
      $request_id: requestId,
      $recipient: recipient,
      $sender: sender,
      $opened_at: openedAt,
      $expires_at: expiresAt,
      $message_id: messageId,
      $fanout: fanout ?? "first",
    })
  }
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
  const truncation = sanitizeMessageWithReport(a.message as string)
  const sanitized = truncation.content
  const deliveryArg = a.delivery
  let delivery: Delivery | undefined
  if (deliveryArg === "push" || deliveryArg === "pull") delivery = deliveryArg
  else if (deliveryArg !== undefined) {
    return jsonResult({ error: "tribe.send: `delivery` must be 'push' or 'pull' when supplied." })
  }
  // Ball-tracker fields (@km/tribe/message-ball-tracker Phase 2a): typed
  // non-self direct actionables auto-open a semantic ball in sendMessage.
  // `request:true` explicitly applies message-id ownership to another type;
  // a string overrides the id. `reply` closes the referenced semantic ball.
  const requestArg = a.request
  const replyArg = a.reply
  const fanoutArg = a.fanout as "first" | "all" | undefined
  if (requestArg !== undefined && requestArg !== true && typeof requestArg !== "string") {
    return jsonResult({ error: "tribe.send: `request` must be true or a non-empty string when supplied." })
  }
  if (typeof requestArg === "string" && requestArg.trim().length === 0) {
    return jsonResult({ error: "tribe.send: `request` must be true or a non-empty string when supplied." })
  }
  const requestFlag = requestArg === true
  const requestId = typeof requestArg === "string" ? requestArg.trim() : null
  const replyId = typeof replyArg === "string" ? replyArg : null
  let expiresInMs: number | undefined
  if (a.expires_in_ms !== undefined) {
    if (
      typeof a.expires_in_ms !== "number" ||
      !Number.isSafeInteger(a.expires_in_ms) ||
      a.expires_in_ms <= 0 ||
      a.expires_in_ms > MAX_BALL_TTL_MS
    ) {
      return jsonResult({
        error: `tribe.send: \`expires_in_ms\` must be a positive integer no greater than ${MAX_BALL_TTL_MS}.`,
      })
    }
    expiresInMs = a.expires_in_ms
  }
  const willTrack = requestFlag || requestId !== null || (recipients !== "*" && AUTO_TRACK_TYPES_SET.has(msgType))
  if (a.expires_in_ms !== undefined && !willTrack) {
    return jsonResult({ error: "tribe.send: `expires_in_ms` requires a tracked request." })
  }
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
  const classification = { summary, ...(delivery ? { delivery } : {}) }
  const sender = ctx.getName()
  const activeNames = new Set(opts.getActiveSessionInfo().map((session) => session.name))
  const resolveRecipient = (recipient: string): DirectDeliveryResolution =>
    resolveDirectDelivery(recipient, activeNames, opts.resolveDelivery)
  if (Array.isArray(recipients)) {
    return handleMultiSend({
      ctx,
      args: a,
      recipients,
      msgType,
      content: sanitized,
      classification,
      sender,
      requestArg,
      requestFlag,
      requestId,
      replyId,
      fanout: fanoutArg,
      expiresInMs,
      summary,
      summaryDerived,
      truncation,
      resolveRecipient,
    })
  }

  const resolution = resolveRecipient(recipients)
  if (resolution.status !== "accepted") {
    return jsonResult({
      error: `tribe.send: ${resolution.status} recipient ${JSON.stringify(recipients)}: ${resolution.reason}`,
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
    classification,
    {
      request: requestFlag ? true : (requestId ?? undefined),
      owner: resolution.state === "bounced" ? resolution.to : undefined,
      reply: replyId ?? undefined,
      fanout: fanoutArg,
      expiresInMs,
    },
  )
  const effectiveRequestId =
    requestFlag || (requestId === null && AUTO_TRACK_TYPES_SET.has(msgType) && sender !== recipients)
      ? result.id
      : requestId
  persistDeadLetter(ctx, resolution, sanitized, a, classification, effectiveRequestId)
  if ((requestFlag || requestId) && recipients === "*") {
    openPendingRows(
      ctx,
      activeBroadcastRecipients(ctx, opts),
      requestFlag ? result.id : requestId!,
      result.id,
      result.ts,
      expiresInMs === undefined ? null : result.ts + expiresInMs,
      fanoutArg,
      sender,
    )
  }
  logEvent(ctx, `message.sent.${msgType}`, a.bead as string | undefined, {
    to: recipients,
    message_id: result.id,
    ...(summaryDerived ? { summary_derived: true } : {}),
  })
  const warning = combineWarnings(
    maybeDerivedSummaryWarning(summaryDerived),
    maybeTruncationWarning(truncation),
    trackerMissWarning(ctx, sender, [recipients], result.tracker),
  )
  return jsonResult({
    sent: true,
    id: result.id,
    ...(effectiveRequestId ? { request_id: effectiveRequestId } : {}),
    delivery: deliveryReport([{ recipient: recipients, resolution }])[0],
    ...(result.tracker ? { tracker: result.tracker } : {}),
    ...replyCloseFailure(result.tracker),
    summary,
    ...(summaryDerived ? { summary_derived: true } : {}),
    ...truncationReport(truncation),
    ...(warning ? { warning } : {}),
  })
}

function handleMultiSend(input: {
  ctx: TribeContext
  args: ToolArgs
  recipients: readonly string[]
  msgType: string
  content: string
  classification: Classification
  sender: string
  requestArg: true | string | undefined
  requestFlag: boolean
  requestId: string | null
  replyId: string | null
  fanout: "first" | "all" | undefined
  expiresInMs: number | undefined
  summary: string
  summaryDerived: boolean
  truncation: SanitizedMessage
  resolveRecipient: (recipient: string) => DirectDeliveryResolution
}): ToolResult {
  const resolutions = resolveDirectRecipients(input.recipients, input.resolveRecipient)
  if (resolutions instanceof Error) return jsonResult({ error: resolutions.message })
  const implicitlyTracked =
    AUTO_TRACK_TYPES_SET.has(input.msgType) && input.recipients.some((recipient) => recipient !== input.sender)
  const sharedRequestId = input.requestFlag
    ? randomUUID()
    : (input.requestId ?? (implicitlyTracked ? randomUUID() : null))
  const results = resolutions.map(({ recipient, resolution }) => {
    const result = sendMessage(
      input.ctx,
      recipient,
      input.content,
      input.msgType,
      input.args.bead as string | undefined,
      input.args.ref as string | undefined,
      "direct",
      input.classification,
      {
        // Implicit tracking still excludes self-directed rows. Explicit
        // request:true/string retains its existing ability to name any
        // direct recipient, including the sender.
        request:
          input.requestArg === undefined && recipient === input.sender ? undefined : (sharedRequestId ?? undefined),
        owner: resolution.state === "bounced" ? resolution.to : undefined,
        reply: input.replyId ?? undefined,
        fanout: input.fanout,
        expiresInMs: input.expiresInMs,
      },
    )
    persistDeadLetter(input.ctx, resolution, input.content, input.args, input.classification, sharedRequestId)
    return { ...result, recipient, resolution }
  })
  const tracker = aggregateReplyTracker(results, input.replyId)
  const warning = combineWarnings(
    maybeDerivedSummaryWarning(input.summaryDerived),
    maybeTruncationWarning(input.truncation),
    trackerMissWarning(input.ctx, input.sender, input.recipients, tracker),
  )
  const deliveries = deliveryReport(results)
  logEvent(input.ctx, `message.sent.${input.msgType}`, input.args.bead as string | undefined, {
    to: input.recipients,
    message_ids: results.map((result) => result.id),
    ...(sharedRequestId ? { request_id: sharedRequestId } : {}),
    deliveries,
    ...(input.summaryDerived ? { summary_derived: true } : {}),
  })
  return jsonResult({
    sent: true,
    id: results[0]?.id ?? null,
    ids: results.map((result) => result.id),
    ...(sharedRequestId ? { request_id: sharedRequestId } : {}),
    ...(tracker ? { tracker } : {}),
    ...replyCloseFailure(tracker),
    deliveries,
    summary: input.summary,
    ...(input.summaryDerived ? { summary_derived: true } : {}),
    ...truncationReport(input.truncation),
    ...(warning ? { warning } : {}),
  })
}

function resolveDirectDelivery(
  recipient: string,
  activeNames: ReadonlySet<string>,
  resolver: DirectDeliveryResolver | undefined,
): DirectDeliveryResolution {
  return (
    resolver?.({ recipient, activeNames }) ?? {
      status: "accepted",
      state: activeNames.has(recipient) ? "online" : "offline",
    }
  )
}

function resolveDirectRecipients(
  recipients: readonly string[],
  resolve: (recipient: string) => DirectDeliveryResolution,
): ResolvedDirectRecipient[] | Error {
  const resolved: ResolvedDirectRecipient[] = []
  for (const recipient of recipients) {
    const resolution = resolve(recipient)
    if (resolution.status !== "accepted") {
      return new Error(`tribe.send: ${resolution.status} recipient ${JSON.stringify(recipient)}: ${resolution.reason}`)
    }
    resolved.push({ recipient, resolution })
  }
  return resolved
}

function persistDeadLetter(
  ctx: TribeContext,
  resolution: AcceptedDirectDeliveryResolution,
  content: string,
  args: ToolArgs,
  classification: Classification,
  requestId: string | null,
): void {
  if (resolution.state !== "bounced") return
  sendMessage(
    ctx,
    resolution.to,
    content,
    "dead-letter",
    args.bead as string | undefined,
    args.ref as string | undefined,
    "direct",
    {
      ...classification,
      attentionRequired: true,
      ...(requestId ? { correlationRequest: requestId } : {}),
    },
  )
}

function deliveryReport(rows: readonly ResolvedDirectRecipient[]): Array<
  | {
      state: "bounced"
      original_target: string
      recipient: string
      reason: string
    }
  | {
      state: "online" | "offline" | "parked"
      recipient: string
    }
> {
  return rows.map(({ recipient, resolution }) =>
    resolution.state === "bounced"
      ? {
          state: resolution.state,
          original_target: recipient,
          recipient: resolution.to,
          reason: resolution.reason,
        }
      : { state: resolution.state, recipient },
  )
}

function derivedSummaryWarning(): string {
  return "no `summary` provided — derived a one-liner from the message; pass an authored `summary` for the channel one-liner."
}

function maybeDerivedSummaryWarning(summaryDerived: boolean): string | undefined {
  return summaryDerived ? derivedSummaryWarning() : undefined
}

/**
 * @ag/tribe/22497 — report the cap on every send result, both ways.
 *
 * `truncated` is emitted unconditionally (never only when true): an absent
 * flag aliases "not truncated" with "this daemon predates the field", so a
 * sender could not tell an intact message from an unknown one. An explicit
 * `false` is the affirmative statement that nothing was dropped.
 */
function truncationReport(truncation: SanitizedMessage): { truncated: boolean; original_length: number } {
  return { truncated: truncation.truncated, original_length: truncation.originalLength }
}

/**
 * The human/LLM-readable half of the same fact. The structured flag alone is
 * easy to skip past; a sender that only reads `warning` still learns the tail
 * of its message never arrived.
 */
function maybeTruncationWarning(truncation: SanitizedMessage): string | undefined {
  if (!truncation.truncated) return undefined
  const dropped = truncation.originalLength - MESSAGE_MAX_LENGTH
  return `message truncated to ${MESSAGE_MAX_LENGTH} chars — ${dropped} of ${truncation.originalLength} were dropped and the recipient did NOT receive them; resend the remainder or link the full text.`
}

type Tracker = { request_id: string; closed: number }

function aggregateReplyTracker(results: readonly { tracker?: Tracker }[], replyId: string | null): Tracker | undefined {
  if (replyId === null) return undefined
  const trackers = results.flatMap((item) => (item.tracker ? [item.tracker] : []))
  return {
    request_id: trackers.find((item) => item.closed > 0)?.request_id ?? trackers[0]?.request_id ?? replyId,
    closed: trackers.reduce((total, item) => total + item.closed, 0),
  }
}

function combineWarnings(...warnings: Array<string | undefined>): string | undefined {
  const present = warnings.filter((warning): warning is string => warning !== undefined)
  return present.length > 0 ? present.join(" ") : undefined
}

type PendingBallRow = {
  request_id: string
  recipient: string
  sender: string
  opened_at: number
  expires_at: number | null
  message_id: string
  fanout: string
  summary: string | null
}

type PendingBall = {
  request_id: string
  recipient: string
  sender: string
  opened_at: string
  expires_at: string | null
  age_ms: number
  message_id: string
  fanout: string
  summary: string | null
}

type PendingBallSummary = {
  total: number
  oldest_age_ms: number
}

const ATTENTION_PENDING_BALL_LIMIT = 10

export type AttentionProjection = {
  actionable_unread: FetchEvent[]
  pending_balls: PendingBall[]
  pending_balls_summary: PendingBallSummary
}

function pendingBall(row: PendingBallRow, now: number): PendingBall {
  return {
    request_id: row.request_id,
    recipient: row.recipient,
    sender: row.sender,
    opened_at: new Date(row.opened_at).toISOString(),
    expires_at: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
    age_ms: now - row.opened_at,
    message_id: row.message_id,
    fanout: row.fanout,
    summary: row.summary,
  }
}

type PendingBallView = "active" | "expired"

function pendingRowMatchesView(row: PendingBallRow, now: number, view: PendingBallView): boolean {
  const expired = row.expires_at !== null && row.expires_at <= now
  // Passing a declared deadline never settles ownership. The default/open
  // view therefore includes every pending row; --expired is a narrower fact
  // projection for consumers that need deadline-passed rows specifically.
  return view === "expired" ? expired : true
}

function pendingBallsForOwner(
  ctx: TribeContext,
  owner: string,
  now: number,
  view: PendingBallView = "active",
): PendingBall[] {
  const rows = ctx.stmts.selectPendingForRecipient.all({ $recipient: owner }) as PendingBallRow[]
  return rows.filter((row) => pendingRowMatchesView(row, now, view)).map((row) => pendingBall(row, now))
}

function pendingCloseMissWarning(
  ctx: TribeContext,
  owner: string,
  peers: readonly string[] | undefined,
  attemptedId: string,
): string | undefined {
  const peerSet = peers ? new Set(peers) : null
  const now = Date.now()
  const fromRelevantPeer = (ball: PendingBall) => peerSet === null || peerSet.has(ball.sender)
  const pending = pendingBallsForOwner(ctx, owner, now).filter(fromRelevantPeer)
  // An empty ball list is the *loudest* case, not the quiet one: the id matched
  // nothing and there was nothing it could have matched, which is exactly the
  // shape a fabricated or truncated request id produces. Staying silent here
  // let a close that closed nothing read as clean success.
  if (pending.length === 0) return `reply/close ${attemptedId} closed 0 rows; ${owner} owns no open balls`
  const listing = pending
    .map((ball) => {
      const deadlinePassed = ball.expires_at !== null && Date.parse(ball.expires_at) <= now
      const deadline = deadlinePassed ? "; declared deadline passed, still open" : ""
      return `${ball.request_id} (message ${ball.message_id}, from ${ball.sender}${deadline})`
    })
    .join(", ")
  return `reply/close ${attemptedId} closed 0 rows; balls owned by ${owner}: ${listing}`
}

function trackerMissWarning(
  ctx: TribeContext,
  owner: string,
  peers: readonly string[],
  tracker: Tracker | undefined,
): string | undefined {
  if (tracker?.closed !== 0) return undefined
  return pendingCloseMissWarning(ctx, owner, peers, tracker.request_id)
}

/**
 * A declared reply that closed no row did not settle anything. The CLI rail
 * already exits non-zero on this; MCP callers only ever saw `sent: true`, so
 * the close failure needs its own unambiguous field rather than a count they
 * have to notice and interpret.
 */
function replyCloseFailure(tracker: Tracker | undefined): { reply_close_failed: true } | undefined {
  return tracker?.closed === 0 ? { reply_close_failed: true } : undefined
}

function allPendingBalls(ctx: TribeContext, now: number, view: PendingBallView = "active"): PendingBall[] {
  const rows = ctx.stmts.selectAllPendingRequests.all() as PendingBallRow[]
  return rows.filter((row) => pendingRowMatchesView(row, now, view)).map((row) => pendingBall(row, now))
}

function pendingOwnerGroups(pending: readonly PendingBall[]) {
  const byOwner = new Map<string, PendingBall[]>()
  for (const ball of pending) {
    const rows = byOwner.get(ball.recipient) ?? []
    rows.push(ball)
    byOwner.set(ball.recipient, rows)
  }
  return [...byOwner.entries()].map(([owner, rows]) => ({
    owner,
    count: rows.length,
    oldest_age_ms: rows[0]?.age_ms ?? 0,
    pending: rows,
  }))
}

function pendingOwnerSummaries(pending: readonly PendingBall[]) {
  return pendingOwnerGroups(pending).map(({ pending: _pending, ...summary }) => summary)
}

function handlePending(ctx: TribeContext, a: ToolArgs, _opts: HandlerOpts): ToolResult {
  // Ball-tracker pending-query (@km/tribe/message-ball-tracker Phase 2a):
  // return open requests addressed to the given recipient (the "owner" of
  // the open ball). Default recipient is the caller's own session name.
  // Optional `stale_ms` filters to requests older than that threshold.
  const owner = (a.owner as string) ?? ctx.getName()
  const all = a.all === true
  const expired = a.expired === true
  const view: PendingBallView = expired ? "expired" : "active"
  const staleMs = typeof a.stale_ms === "number" ? a.stale_ms : null
  const now = Date.now()

  if (all && typeof a.owner === "string") {
    return jsonResult({ error: "tribe.pending: all and owner are mutually exclusive." })
  }
  if (all && (a.close !== undefined || a.prune === true)) {
    return jsonResult({ error: "tribe.pending: all is read-only; close/prune require one explicit owner." })
  }
  if (expired && (a.close !== undefined || a.prune === true)) {
    return jsonResult({ error: "tribe.pending: expired is a read-only diagnostic view." })
  }

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
    const pending = ctx.stmts.selectPendingForReplyRecipient.get({
      $reply_id: closeId,
      $recipient: owner,
    }) as { request_id: string } | null
    const requestId = pending?.request_id ?? closeId
    const res = ctx.stmts.closePendingRequest.run({ $request_id: requestId, $recipient: owner })
    const closed = res.changes ?? 0
    const warning = closed === 0 ? pendingCloseMissWarning(ctx, owner, undefined, closeId) : undefined
    return jsonResult({ owner, request_id: requestId, closed, ...(warning ? { warning } : {}) })
  }

  if (all) {
    const rows = allPendingBalls(ctx, now, view)
    const pending = staleMs === null ? rows : rows.filter((row) => row.age_ms >= staleMs)
    const owners = pendingOwnerGroups(pending)
    return jsonResult({
      all: true,
      expired,
      scope: "all",
      pending,
      owners,
      owner_count: owners.length,
      oldest_age_ms: pending.reduce((oldest, row) => Math.max(oldest, row.age_ms), 0),
      count: pending.length,
    })
  }

  const rows = pendingBallsForOwner(ctx, owner, now, view)
  const pending = staleMs === null ? rows : rows.filter((row) => row.age_ms >= staleMs)
  return jsonResult({ owner, expired, pending, count: pending.length })
}

type MembershipSessionRow = {
  id: string
  name: string
  launch_id: string | null
  launch_parent_pid: number | null
  updated_at: number
}

type DurableMembershipSessionRow = MembershipSessionRow & {
  launch_id: string
  launch_parent_pid: number
}

type MembershipDiscrepancy = {
  status: "degraded"
  connected_durable_launches: number
  known_durable_launches: number
  missing_count: number
  missing: Array<{
    member_id: string
    name: string
    launch_id: string
    launch_parent_pid: number
    state: "missing-transport"
  }>
  meaning: "missing transport does not establish agent absence"
}

function latestDisconnectedSessionRows<T extends MembershipSessionRow>(
  rows: readonly T[],
  activeIds: ReadonlySet<string>,
): T[] {
  const activeNames = new Set(rows.filter((row) => activeIds.has(row.id)).map((row) => row.name))
  const latestByName = new Map<string, T>()
  for (const row of rows) {
    if (activeIds.has(row.id) || activeNames.has(row.name)) continue
    const previous = latestByName.get(row.name)
    if (previous === undefined || row.updated_at > previous.updated_at) latestByName.set(row.name, row)
  }
  return [...latestByName.values()]
}

function projectMembershipDiscrepancy(
  rows: readonly MembershipSessionRow[],
  activeIds: ReadonlySet<string>,
): MembershipDiscrepancy | undefined {
  const durableRows = rows.filter(isDurableMembershipSessionRow)
  const knownNames = new Set(durableRows.map((row) => row.name))
  const connectedNames = new Set(durableRows.filter((row) => activeIds.has(row.id)).map((row) => row.name))
  const missing = latestDisconnectedSessionRows(durableRows, activeIds).map((row) => ({
    member_id: row.id,
    name: row.name,
    launch_id: row.launch_id,
    launch_parent_pid: row.launch_parent_pid,
    state: "missing-transport" as const,
  }))
  if (missing.length === 0) return undefined
  return {
    status: "degraded",
    connected_durable_launches: connectedNames.size,
    known_durable_launches: knownNames.size,
    missing_count: missing.length,
    missing,
    meaning: "missing transport does not establish agent absence",
  }
}

function isDurableMembershipSessionRow(row: MembershipSessionRow): row is DurableMembershipSessionRow {
  return (
    classifySessionRegistrationLifetime({
      launchId: row.launch_id,
      launchParentPid: row.launch_parent_pid,
    }) === "durable-launch"
  )
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
        s.account, s.provider, s.launch_id, s.launch_parent_pid, s.delivery
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
    delivery: "push" | "pull"
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
    const transport = projectSessionTransportState({
      transportConnected: activeIds.has(r.id),
    })
    return {
      member_id: r.id,
      name: r.name,
      role: r.role,
      domains: parseDomains(r.domains),
      pid: active?.pid ?? r.pid,
      launch_id: r.launch_id,
      launch_parent_pid: r.launch_parent_pid,
      delivery: r.delivery,
      transport_pids: active?.transportPids ?? [],
      cwd: r.cwd,
      claude_session_id: r.claude_session_id,
      claude_session_name: r.claude_session_name,
      ...transport,
      // Compatibility alias for existing clients. `transport_state` is the
      // authority; never derive either fact on a separate code path.
      alive: transport.transport_state === "connected",
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
  const membershipDiscrepancy = projectMembershipDiscrepancy(rows, activeIds)
  return jsonResult({
    sessions,
    ...(membershipDiscrepancy === undefined ? {} : { membership_discrepancy: membershipDiscrepancy }),
  })
}

function handleRename(
  ctx: TribeContext,
  a: ToolArgs,
  opts: {
    userRenamed: boolean
    setUserRenamed: (v: boolean) => void
    /** Participating sessions, used only for user-facing member projections. */
    getActiveSessionIds: () => Set<string>
    /** All connected transports, used to authorize destructive name reclaim. */
    hasActiveTransport: (sessionId: string) => boolean
    isReconnectGraceProtected?: (sessionId: string, nowMs: number) => boolean
    /** Optional: opportunistic socket wakeup after a name-claim replay rewind. */
    notifyWakeupForReplay?: (sessionId: string, claimedName: string) => void
  },
): ToolResult {
  const newName = a.new_name as string
  const contextName = ctx.getName()
  const storedSession = ctx.db
    .prepare("SELECT name FROM sessions WHERE id = $id LIMIT 1")
    .get({ $id: ctx.sessionId }) as { name: string } | null
  const storedName = ctx.getName()
  const dbRow = ctx.db.prepare("SELECT name FROM sessions WHERE id = $id").get({ $id: ctx.sessionId }) as {
    name: string
  } | null
  const dbName = dbRow?.name ?? storedName

  if (storedName === newName && dbName === newName) {
    return jsonResult({ renamed: false, name: storedName })
  }
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
    const selfRow = ctx.db.prepare("SELECT pid FROM sessions WHERE id = $id").get({ $id: ctx.sessionId }) as {
      pid: number
    } | null
    const selfPid = selfRow?.pid ?? 0
    const existingRow = ctx.db
      .prepare("SELECT pid, updated_at FROM sessions WHERE id = $id")
      .get({ $id: existing.id }) as { pid: number; updated_at: number } | null
    const existingPid = existingRow?.pid ?? 0
    const holderIsActive = opts.hasActiveTransport(existing.id)
    const isDifferentLiveProcess =
      existingPid > 0 && (selfPid === 0 || existingPid !== selfPid) && pidStillAlive(existingPid)
    const holderIsAlive =
      holderIsActive ||
      isDifferentLiveProcess ||
      (opts.isReconnectGraceProtected ? opts.isReconnectGraceProtected(existing.id, Date.now()) : false)
    if (holderIsAlive) {
      const activeIds = opts.getActiveSessionIds()
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
  const oldName = dbName
  // A rename is the same session (same pid, same socket, same ctx.sessionId).
  // The tribe-wire daemon is role-agnostic (F12) — there is no chief claim to
  // carry across the rename, so a rename can no longer flap a coordination
  // identity. Chief-ness is an L3 fact (the `@chief` bead lease).
  ctx.stmts.renameSession.run({ $new_name: newName, $session_id: ctx.sessionId, $now: Date.now() })
  ctx.setName(newName)
  opts.setUserRenamed(true) // Explicit rename — name is now sticky, won't be overridden
  // 21454 — write the rename through to the persisted authority record so a
  // reconnect/daemon-restart re-register (which carries the frozen spawn-time
  // name) re-applies it instead of silently reverting the identity.
  persistRuntimeRename(ctx, newName)
  // Attention-mailbox recovery (19442, 21757): the mailbox travels with the
  // NAME. Any unacknowledged attention directs addressed to `newName` surface on
  // the next default `tribe.fetch` (injected ahead of the ambient window) —
  // no cursor rewind, no ambient replay. Here we only count and nudge.
  const recoveredAttention = countUnackedAttention(ctx, newName)
  if (recoveredAttention > 0) {
    log.info?.(`attention-recovery: ${recoveredAttention} unacked row(s) await "${newName}" (rename)`)
    opts.notifyWakeupForReplay?.(ctx.sessionId, newName)
  }
  // Broadcast the rename
  sendMessage(ctx, "*", `Member "${oldName}" is now "${newName}"`, "notify")
  logEvent(ctx, "session.renamed", undefined, { old_name: oldName, new_name: newName })
  return jsonResult({
    renamed: true,
    old_name: oldName,
    new_name: newName,
    ...(recoveredAttention > 0 ? { recovered_actionables: recoveredAttention } : {}),
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
      if (!opts.hasActiveTransport(prior.id)) {
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
      (sessionId) => opts.hasActiveTransport(sessionId),
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
    const selfPid =
      selfInfo?.pid ??
      (ctx.db.prepare("SELECT pid FROM sessions WHERE id = $id").get({ $id: ctx.sessionId }) as { pid: number } | null)
        ?.pid ??
      0
    const takenRow = ctx.db.prepare("SELECT pid, updated_at FROM sessions WHERE id = $id").get({ $id: taken.id }) as {
      pid: number
      updated_at: number
    } | null
    const takenPid = takenRow?.pid ?? 0
    const holderIsActive = opts.hasActiveTransport(taken.id)
    const isDifferentLiveProcess = takenPid > 0 && (selfPid === 0 || takenPid !== selfPid) && pidStillAlive(takenPid)
    const holderIsAlive =
      holderIsActive ||
      isDifferentLiveProcess ||
      (opts.isReconnectGraceProtected ? opts.isReconnectGraceProtected(taken.id, Date.now()) : false)
    if (!holderIsAlive) {
      // Dead session — tombstone and reclaim.
      const tombstoneName = `${joinName}-dead-${taken.id.slice(0, 8)}`
      ctx.db
        .prepare("UPDATE sessions SET name = $tomb, updated_at = $now WHERE id = $id")
        .run({ $tomb: tombstoneName, $now: Date.now(), $id: taken.id })
      log.info?.(`reclaimed name "${joinName}" from dead session ${taken.id} (tombstoned as "${tombstoneName}")`)
    } else {
      // A connected holder owns the name until the dispatcher performs an
      // explicit whole-transport takeover. DB-only tombstoning leaves the old
      // socket/context live under a different persisted name, producing
      // `-dead-*` members that are still connected and cannot rename-repair.
      const existing_names = listActiveSessionNames(ctx, opts.getActiveSessionIds())
      return jsonResult({ error: `Name "${joinName}" is already taken`, existing_names })
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
  // 21454 — tribe.join is an explicit identity assertion (the /up hat-claim
  // shape); persist it exactly like tribe.rename so reconnects re-apply it.
  persistRuntimeRename(ctx, joinName)

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

  // Attention-mailbox recovery (19442, 21757): claiming a name inherits its
  // durable mailbox — any unacknowledged attention directs surface on the next
  // default `tribe.fetch` without touching the ambient session cursor. A
  // same-name join is only a refresh, and the mailbox cursor already reflects
  // everything this session has acknowledged, so counting is claim-only.
  const recoveredAttention = prevName === joinName ? 0 : countUnackedAttention(ctx, joinName)
  if (recoveredAttention > 0) {
    log.info?.(`attention-recovery: ${recoveredAttention} unacked row(s) await "${joinName}" (join)`)
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
    ...(recoveredAttention > 0 ? { recovered_actionables: recoveredAttention } : {}),
  })
}

function handleHealth(ctx: TribeContext, opts: HandlerOpts): ToolResult {
  const now = Date.now()
  const silentThreshold = now - 300_000 // 5 minutes

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
    launch_id: string | null
    launch_parent_pid: number | null
  }>
  const liveSessions = rows.filter((r) => byId.has(r.id))
  const activeIds = new Set(byId.keys())
  const transportWedges = latestDisconnectedSessionRows(rows, activeIds).flatMap((session) => {
    const lifetime = classifySessionRegistrationLifetime({
      launchId: session.launch_id,
      launchParentPid: session.launch_parent_pid,
    })
    if (lifetime === "connection-scoped") return []
    const transport = projectSessionTransportState({
      transportConnected: false,
    })
    return [
      {
        member_id: session.id,
        name: session.name,
        pid: session.pid,
        launch_id: session.launch_id,
        launch_parent_pid: session.launch_parent_pid,
        registration_lifetime: lifetime,
        wedge_reason: lifetime === "durable-launch" ? "durable-launch-no-transport" : "malformed-launch-identity",
        ...transport,
      },
    ]
  })
  const membershipDiscrepancy = projectMembershipDiscrepancy(rows, activeIds)

  const members = liveSessions.map((s) => {
    const active = byId.get(s.id)!
    const transport = projectSessionTransportState({ transportConnected: true })
    // Find last message from this member
    const lastMsg = ctx.db
      .prepare("SELECT ts FROM messages WHERE sender = $name ORDER BY ts DESC LIMIT 1")
      .get({ $name: s.name }) as { ts: number } | null

    const lastMsgAge = lastMsg ? now - lastMsg.ts : null
    const warnings: string[] = []
    if (lastMsgAge && lastMsgAge > silentThreshold) {
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
    const agentPid = active.launchParentPid ?? active.pid
    const agentPidAlive = agentPid ? pidStillAlive(agentPid) : pidAlive
    const lastSeenSec = lastMsgAge ? Math.round(lastMsgAge / 1000) : Math.round((Date.now() - s.started_at) / 1000)
    const liveness = projectSessionLiveness({
      transportConnected: transport.transport_state === "connected",
      pidAlive,
      agentPidAlive,
      lastSeenSec,
    })
    if (liveness.is_silent) {
      warnings.push(`silent for ${Math.round(lastSeenSec / 60)} min`)
    }

    return {
      member_id: s.id,
      name: s.name,
      role: s.role,
      domains: parseDomains(s.domains),
      pid: active.pid,
      agent_pid: agentPid,
      launch_id: active.launchId,
      launch_parent_pid: active.launchParentPid,
      transport_pids: transportPids,
      ...transport,
      ...liveness,
      last_message: lastMsgAge ? `${Math.round(lastMsgAge / 60_000)} min ago` : "never",
      warnings,
    }
  })

  // Default-wake/stop-line unread direct-message count per recipient. Direct
  // responses can ride durable attention without becoming health backlog when
  // pending(owner) is empty; ambient notify/status DMs remain awareness only.
  const unread = ctx.db
    .prepare(`
				SELECT m.recipient, COUNT(*) as count FROM messages m
				WHERE m.recipient != '*'
				AND m.kind = 'direct'
				AND m.sender != m.recipient
				AND m.type IN (${ACTIONABLE_TYPES_SQL})
				AND m.rowid > COALESCE(
					(SELECT c.last_actionable_seq FROM mailbox_cursors c WHERE c.recipient = m.recipient),
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

  // 20876 / 17199: fleet-wide open-ball attention is derived from the one
  // existing pending_request authority. A per-owner sample can be empty while
  // another role is blocked, so health carries the all-owner projection and a
  // bounded aggregate warning for active rows older than two hours.
  const pending = allPendingBalls(ctx, now)
  const pendingOwners = pendingOwnerSummaries(pending)
  const stalePending = pending.filter((ball) => ball.age_ms >= 2 * 60 * 60 * 1000)
  const staleOwnerCount = new Set(stalePending.map((ball) => ball.recipient)).size
  const oldestStaleAgeMs = stalePending.reduce((oldest, ball) => Math.max(oldest, ball.age_ms), 0)
  const pendingIssues =
    stalePending.length === 0
      ? []
      : [
          `${stalePending.length} stale pending ${stalePending.length === 1 ? "ball" : "balls"} across ${staleOwnerCount} ${staleOwnerCount === 1 ? "owner" : "owners"}; oldest is ${Math.floor(oldestStaleAgeMs / 60_000)}m old`,
        ]
  const cadence = projectHealthCadence(ctx.db, {
    now,
    connectedSessionNames: liveSessions.map((session) => session.name),
    dbGrowthWarningBytes: parseDbGrowthWarningBytes(process.env.TRIBE_HEALTH_DB_GROWTH_WARN_BYTES),
  })

  // Stale-code detector (@km/tribe/20033): surface whether the running daemon
  // is provably older than the on-disk / superproject-pinned tribe code, so a
  // stale daemon serving old handlers is observable (not silent) to any
  // tribe.health() reader and the health-monitor.
  const result: Record<string, unknown> = {
    members,
    unread,
    pending_balls: {
      count: pending.length,
      owner_count: pendingOwners.length,
      oldest_age_ms: pending.reduce((oldest, ball) => Math.max(oldest, ball.age_ms), 0),
      owners: pendingOwners,
      stale: {
        count: stalePending.length,
        owner_count: staleOwnerCount,
        oldest_age_ms: oldestStaleAgeMs,
      },
    },
    transport_wedges: transportWedges,
    ...(membershipDiscrepancy === undefined ? {} : { membership_discrepancy: membershipDiscrepancy }),
    issues: [
      ...transportWedges.map(
        (wedge) =>
          `transport wedge ${wedge.name}: transport_state=${wedge.transport_state} owner_state=${wedge.owner_state} reason=${wedge.wedge_reason}`,
      ),
      ...pendingIssues,
      ...cadence.warnings,
    ],
    cadence,
    stats,
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
  // SIGHUP → `withHotReload.reload()`, which asks the declared lifecycle owner
  // for a replacement. A directly launched standalone daemon first installs
  // that stable owner; successor daemons never detach themselves. This is the
  // same hardened path `tribe reload` (the CLI) already uses.
  setTimeout(() => {
    cleanup()
    log.info?.(`SIGHUP self (pid=${process.pid}) — hot-reload via lifecycle owner`)
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

function handleDebug(_ctx: TribeContext, _a: ToolArgs, opts: HandlerOpts): ToolResult {
  // Prefer the daemon-provided dump when available (richest snapshot: clients
  // Map, per-session cursors). Otherwise synthesize a minimal view from the
  // generic accessors so in-process tests still get meaningful output without
  // wiring getDebugState.
  const state = opts.getDebugState
    ? opts.getDebugState()
    : {
        clients: opts.getActiveSessionInfo(),
        cursors: [],
      }
  return jsonResult(state)
}

function handleRepair(ctx: TribeContext, a: ToolArgs, opts: HandlerOpts): ToolResult {
  const repairMode = (a.inbox_cursor ?? a.inboxCursor) as unknown
  const reapMode = a.reap_stale_transports ?? a.reapStaleTransports
  if (repairMode !== undefined && reapMode === true) {
    return jsonResult({ error: "repair modes are mutually exclusive; choose inbox_cursor or reap_stale_transports" })
  }
  if (reapMode !== undefined && reapMode !== true) {
    return jsonResult({ error: "reap_stale_transports must be true when selected" })
  }
  if (reapMode === true) {
    if (!opts.reapStaleTransports) {
      return jsonResult({ error: "stale transport repair is unavailable in this handler context" })
    }
    return jsonResult({ repaired: true, repair: "reap_stale_transports", ...opts.reapStaleTransports() })
  }
  if (repairMode !== "tail" && repairMode !== "reconcile") {
    return jsonResult({ error: 'repair requires inbox_cursor: "tail" or "reconcile"' })
  }

  const sessionName = typeof a.session === "string" && a.session.length > 0 ? a.session : ctx.getName()
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

  if (repairMode === "tail") {
    ctx.stmts.advanceInboxCursor.run({ $id: row.id, $seq: tail, $now: Date.now() })
  }
  const after = ctx.stmts.getInboxCursor.get({ $id: row.id }) as { last_inbox_pull_seq: number } | null

  const mbCurrent =
    (
      ctx.db.prepare("SELECT last_actionable_seq FROM mailbox_cursors WHERE recipient = ?").get(sessionName) as {
        last_actionable_seq: number
      } | null
    )?.last_actionable_seq ?? 0

  const minOpenReqRow = ctx.db
    .prepare(
      `
    SELECT MIN(m.rowid) AS min_seq
    FROM messages m
    JOIN pending_request p ON p.message_id = m.id
    WHERE p.recipient = ?
  `,
    )
    .get(sessionName) as { min_seq: number | null } | null
  const minOpenReqSeq = minOpenReqRow?.min_seq ?? null

  let mbTarget = mbCurrent
  if (minOpenReqSeq !== null && mbCurrent >= minOpenReqSeq) {
    mbTarget = Math.max(0, minOpenReqSeq - 1)
  }

  let mbReconciled = false
  if (mbTarget !== mbCurrent) {
    const now = Date.now()
    ctx.db
      .prepare(
        `
      INSERT INTO mailbox_cursors (recipient, last_actionable_seq, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(recipient) DO UPDATE SET
        last_actionable_seq = ?,
        updated_at = ?
    `,
      )
      .run(sessionName, mbTarget, now, mbTarget, now)
    mbReconciled = true
  }

  return jsonResult({
    repaired: true,
    created_session: createdSession,
    session: sessionName,
    repair: repairMode === "tail" ? "inbox_cursor_to_tail" : "inbox_cursor_reconcile",
    cursor_before: row.last_inbox_pull_seq,
    cursor_after: after?.last_inbox_pull_seq ?? row.last_inbox_pull_seq,
    tail,
    mailbox_cursor_before: mbCurrent,
    mailbox_cursor_after: mbTarget,
    mailbox_reconciled: mbReconciled,
  })
}

function handleInboxWait(
  ctx: TribeContext,
  a: ToolArgs,
  opts: HandlerOpts,
  connId: string | undefined,
): ToolResult | Promise<ToolResult> {
  const { session, timeoutMs, wakeOnCorrelatedReply } = resolveInboxWaitOptions(a, {
    defaultSession: ctx.getName(),
  })
  if (!opts.inboxWait || connId === undefined) {
    return jsonResult({ error: "inbox wait requires a connection-owned handler context" })
  }
  return opts.inboxWait.wait(session, connId, timeoutMs, { wakeOnCorrelatedReply }).then((result) => jsonResult(result))
}

// ---------------------------------------------------------------------------
// km-tribe.event-classification handlers
// ---------------------------------------------------------------------------

export type FetchRow = {
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
  attention_required: number
}

export type FetchEvent = {
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

export function fetchEvent(row: FetchRow): FetchEvent {
  return {
    id: row.id,
    rowid: row.rowid,
    type: row.type,
    from: row.sender,
    to: row.recipient,
    content: row.content,
    bead: row.bead_id,
    ref: row.ref,
    ts: new Date(row.ts).toISOString(),
    delivery: row.delivery,
    topic: row.topic,
    room_id: row.room_id,
    summary: row.summary,
  }
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

/** One canonical attention projection for fetch and inbox-wait carriage. */
export function readAttentionProjection(
  ctx: TribeContext,
  owner: string,
  now = Date.now(),
): { attentionRows: FetchRow[]; attention: AttentionProjection } {
  const attentionRows = filterRowsByTrust(ctx, ctx.stmts.selectAttention.all({ $name: owner }) as FetchRow[])
  const pendingBalls = pendingBallsForOwner(ctx, owner, now)
  return {
    attentionRows,
    attention: {
      actionable_unread: attentionRows.map(fetchEvent),
      pending_balls: pendingBalls.slice(0, ATTENTION_PENDING_BALL_LIMIT),
      pending_balls_summary: {
        total: pendingBalls.length,
        oldest_age_ms: pendingBalls[0]?.age_ms ?? 0,
      },
    },
  }
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
      SELECT id, rowid, type, sender, recipient, content, bead_id, ref, ts, delivery, topic, room_id, summary,
             attention_required
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
  let attentionRows: FetchRow[] = []
  let attention: AttentionProjection | null = null
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
        SELECT id, rowid, type, sender, recipient, content, bead_id, ref, ts, delivery, topic, room_id, summary,
               attention_required
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
    if (!topicsAreSnapshot) {
      const projected = readAttentionProjection(ctx, currentName)
      attentionRows = projected.attentionRows
      attention = projected.attention
    }
    // 19442 / 21757 — inject unacknowledged attention directs (the durable mailbox)
    // ahead of the ambient window. Recovery rows are bounded to rowid <=
    // cursorBase, so they can never duplicate a window row, and the ambient
    // session cursor is never rewound — a claim/rename floods nothing. See
    // selectUnackedAttention in database.ts.
    const recovered = ctx.stmts.selectUnackedAttention.all({
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

  // 19442 / 21757 — acknowledge every canonical attention row this fetch
  // returns. Default drains carry the full attention projection; explicit
  // since+advance reads carry their returned rows. The persisted classifier
  // keeps newly surfaced responses distinct from legacy ambient responses.
  if (shouldAdvance) {
    let lastAttention = 0
    for (const row of [...attentionRows, ...filtered]) {
      if (
        row.recipient === currentName &&
        row.sender !== currentName &&
        (ACTIONABLE_TYPES_SET.has(row.type) || row.attention_required === 1)
      ) {
        lastAttention = Math.max(lastAttention, row.rowid)
      }
    }
    if (lastAttention > 0) {
      ctx.stmts.advanceMailboxCursor.run({ $recipient: currentName, $seq: lastAttention, $now: Date.now() })
    }
  }

  // 21626 — only the canonical, identity-bound attention projection is a
  // mailbox-read receipt. Filtered/snapshot fetches omit attention and do not
  // let a narrow history query masquerade as checking the owned inbox.
  if (attention !== null) {
    ctx.stmts.touchMailboxAttentionRead.run({ $recipient: currentName, $now: Date.now() })
  }

  const events = filtered.map(fetchEvent)
  return jsonResult(attention === null ? { events, cursor: outputCursor } : { attention, events, cursor: outputCursor })
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
  const truncation = sanitizeMessageWithReport(content)
  const result = sendMessage(
    ctx,
    "*",
    truncation.content,
    HEALTH_RECOVERY_TOPIC, // type == topic, mirroring the accountly-plugin's health:* broadcasts
    undefined,
    undefined,
    "broadcast",
    { delivery: "pull", topic: HEALTH_RECOVERY_TOPIC },
  )
  logEvent(ctx, `message.sent.${HEALTH_RECOVERY_TOPIC}`, undefined, { agent, seq, message_id: result.id })
  const warning = maybeTruncationWarning(truncation)
  return jsonResult({
    published: true,
    id: result.id,
    agent,
    seq,
    ...truncationReport(truncation),
    ...(warning ? { warning } : {}),
  })
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
