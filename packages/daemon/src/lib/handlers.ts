/**
 * Tribe tool handlers — all MCP tool case implementations.
 */

import { createLogger } from "loggily"
import { randomUUID } from "node:crypto"
import {
  parseBallOutcomeFact,
  resolveInboxWaitOptions,
  type BallDeadlineObservationPayload,
  type BallFactEvidence,
  type BallOutcomeFactRow,
  type BallSettlementFact,
  type InboxWaitResult,
} from "tribe-wire"
import type { TribeContext } from "./context.ts"
import type { TribeRole } from "tribe-wire/lib/config"
import { TRIBE_PROTOCOL_VERSION } from "tribe-wire/lib/socket"

const log = createLogger("tribe:handlers")
import { validateName, sanitizeMessageWithReport, MESSAGE_MAX_LENGTH, type SanitizedMessage } from "./validation.ts"
import {
  sendMessage,
  deriveSummary,
  logEvent,
  countUnackedAttention,
  defaultBallTtlMs,
  MAX_BALL_TTL_MS,
  settlePendingRows,
  type Classification,
  type BallSettlementReason,
  type Delivery,
  type PendingSettlementRow,
} from "./messaging.ts"
import {
  ACTIONABLE_TYPES_SET,
  ACTIONABLE_TYPES_SQL,
  AUTO_TRACK_TYPES_SET,
  unretiredAttentionPredicateSql,
} from "./database.ts"
import {
  classifySessionRegistrationLifetime,
  isPidAlive as pidStillAlive,
  persistRuntimeRename,
  registerSession,
  type StaleTransportReapReport,
} from "./session.ts"
import { incidentKey, type IncidentIdentity } from "tribe-wire"
import { gatherCodePin } from "./code-pin.ts"
import { parseDbGrowthWarningBytes, projectHealthCadence } from "./health-cadence.ts"
import { registeredTrustTierForTopic, senderMayUseRegisteredTrustTopic, type SessionRoster } from "./trust.ts"
import type { LifecycleStore, LifecycleSnapshotRecord } from "./lifecycle-store.ts"
import {
  DEFAULT_MAX_SILENCE_SEC,
  projectSessionLiveness,
  projectSessionTransportEvidence,
  projectSessionTransportState,
  type OwnerState,
  type SessionTransportEvidence,
} from "./session-transport-state.ts"
import type { DirectDeliveryResolution, DirectDeliveryResolver } from "./delivery-resolution.ts"
import { isUnidentifiedSessionName } from "./resolve-name.ts"

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
  restart: "tribe.restart",
  stop: "tribe.stop",
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
  "tribe.reload",
])
const REMOVED_TRIBE_METHOD_HINT = "use send/fetch/filter — see docs/architecture.md"

export function isRemovedTribeMethod(name: string): boolean {
  return REMOVED_TRIBE_METHODS.has(name)
}

export function removedTribeMethodMessage(name: string): string {
  if (name === "tribe.reload") {
    return `${name} renamed to tribe.restart; restart re-execs the same pinned module root and does not change code`
  }
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
  protocolVersions?: number[]
}

export type HandlerOpts = {
  cleanup: () => void
  userRenamed: boolean
  setUserRenamed: (v: boolean) => void
  /**
   * Return ctx.sessionId of every currently-connected participating session —
   * the transport-registry half of `alive` on DB-sourced session rows
   * (no heartbeat timer). Necessary but not sufficient: a registry entry can
   * outlive the process it names, so `alive` also requires a pid probe
   * (`pidStillAlive` + `projectSessionLiveness`) — never derived from this
   * set alone. Excludes daemon / watch / pending sessions.
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
   * Optional: clean daemon shutdown (drain, close socket, exit 0) — the
   * `tribe.stop` actuator. The daemon wires this to withRuntime's shutdown();
   * direct handler harnesses omit it and `tribe.stop` reports itself
   * unavailable instead of pretending to stop anything.
   */
  triggerStop?: () => void
  /**
   * Optional host/project delivery policy. Tribe owns only the generic
   * disposition; concrete parent/fallback routing is injected by composition.
   */
  resolveDelivery?: DirectDeliveryResolver
}

type OwnerTransportReason = SessionTransportEvidence["answer_reason"] | "no-session-record"

type OwnerTransportObservation = {
  owner_transport_registered: boolean
  owner_transport_state: "connected" | "disconnected"
  owner_state: OwnerState
  owner_answer_capability: "observed" | "not-observed"
  owner_transport_reason: OwnerTransportReason
  owner_transport_observed_at: string
}

function ownerTransportObservationProjector(ctx: TribeContext, opts: HandlerOpts, observedAt: number) {
  const sessionRows = ctx.db.prepare("SELECT name FROM sessions").all() as Array<{ name: string }>
  const knownNames = new Set(sessionRows.map((row) => row.name))
  // Any currently-registered session has a live `sessions` row and therefore
  // an addressable mailbox — durable-launch (hab-tracked) and plain
  // connection-scoped registrations alike (e.g. a CLI-rail pull seat that
  // joined without launch_id/launch_parent_pid). A tracked send to a known
  // name always lands; `tribe.fetch`/`tribe pending` will surface it on the
  // recipient's next drain regardless of how it registered. The union below
  // additionally covers names that have since left `sessions` entirely
  // (superseded/reaped rows) but were active recently enough to deserve a
  // grace period.
  const mailboxRecipientNames = new Set(knownNames)
  const recentSince = observedAt - DEFAULT_MAX_SILENCE_SEC * 1_000
  const recentActivity = ctx.db
    .prepare(
      `
        SELECT sender AS name FROM messages WHERE ts >= $since
        UNION
        SELECT sender AS name FROM messages_archive WHERE ts >= $since
      `,
    )
    .all({ $since: recentSince }) as Array<{ name: string }>
  for (const row of recentActivity) mailboxRecipientNames.add(row.name)
  const activeByName = new Map<string, ActiveSessionInfo[]>()
  for (const info of opts.getActiveSessionInfo()) {
    const siblings = activeByName.get(info.name) ?? []
    siblings.push(info)
    activeByName.set(info.name, siblings)
  }
  const observedAtIso = new Date(observedAt).toISOString()
  const cache = new Map<string, OwnerTransportObservation>()

  const observe = (name: string): OwnerTransportObservation => {
    const cached = cache.get(name)
    if (cached !== undefined) return cached
    const evidence = (activeByName.get(name) ?? []).map((info) =>
      projectSessionTransportEvidence({
        transportConnected: true,
        transportPids: info.transportPids,
        agentPid: info.launchParentPid ?? info.pid,
      }),
    )
    const selected =
      evidence.find((row) => row.answer_capability === "observed") ??
      evidence.find((row) => row.owner_state === "dead") ??
      evidence[0]
    const observation: OwnerTransportObservation = selected
      ? {
          owner_transport_registered: selected.transport_registered,
          owner_transport_state: selected.transport_state,
          owner_state: selected.owner_state,
          owner_answer_capability: selected.answer_capability,
          owner_transport_reason: selected.answer_reason,
          owner_transport_observed_at: observedAtIso,
        }
      : {
          owner_transport_registered: false,
          owner_transport_state: "disconnected",
          owner_state: "unknown",
          owner_answer_capability: "not-observed",
          owner_transport_reason: knownNames.has(name) ? "owner-unknown-no-transport" : "no-session-record",
          owner_transport_observed_at: observedAtIso,
        }
    cache.set(name, observation)
    return observation
  }

  return {
    observe,
    mailboxRecipientNames,
    answerableNames: new Set(
      [...activeByName.keys()].filter((name) => observe(name).owner_answer_capability === "observed"),
    ),
  }
}

type AcceptedDirectDeliveryResolution = Extract<DirectDeliveryResolution, { readonly status: "accepted" }>

interface ResolvedDirectRecipient {
  readonly recipient: string
  readonly resolution: AcceptedDirectDeliveryResolution
}

type ExpiredPendingRequest = {
  request_id: string
  recipient: string
  sender: string
  opened_at: number
  expires_at: number
  message_id: string
  fanout: "first" | "all"
  summary: string | null
}

/** Record deadline passage without releasing ownership. Expiry is an
 * escalation/presentation fact; only an explicit settlement edge may remove
 * the owner. The selection excludes already-recorded edges across both
 * retention tiers, and the transaction makes each daemon boundary observe a
 * stable set. */
function recordExpiredPendingRequests(ctx: TribeContext, now: number): number {
  return ctx.db.transaction(() => {
    const rows = ctx.stmts.selectExpiredPendingRequests.all({ $now: now }) as ExpiredPendingRequest[]
    for (const row of rows) {
      const fact = {
        schema_version: 2,
        request_id: row.request_id,
        recipient: row.recipient,
        sender: row.sender,
        opened_at: row.opened_at,
        expires_at: row.expires_at,
        message_id: row.message_id,
        fanout: row.fanout,
        summary: row.summary,
        observation: "deadline-passed",
        observed_at: now,
      } satisfies BallDeadlineObservationPayload
      logEvent(ctx, "ball.expired", undefined, fact, { sender: "daemon", ref: row.request_id, ts: now })
    }
    return rows.length
  })()
}

export function handleToolCall(
  ctx: TribeContext,
  name: string,
  a: ToolArgs,
  opts: HandlerOpts,
  connId?: string,
): ToolResult | Promise<ToolResult> {
  // Class-default deadlines are daemon-owned escalation; a sender can only
  // override their duration. Every RPC boundary records elapsed deadlines
  // before projecting attention, but ownership remains active until an actual
  // reply or typed non-reply settlement. History remains for audit/replay.
  const now = Date.now()
  recordExpiredPendingRequests(ctx, now)
  // Presence heartbeat (@km/tribe/19784): ANY authenticated tool call
  // refreshes the caller's last_seen — presence = "spoke to the daemon
  // recently", not "joined or drained rows recently". Before this, send-only
  // / empty-drain sessions read as idle (the 2026-06-10 false-idle class,
  // pinned in tests/tribe-delivery-semantics.test.ts).
  ctx.stmts.touchSessionPresence.run({ $id: ctx.sessionId, $now: now })
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
    case TRIBE_COORD_METHODS.restart:
      return handleRestart(ctx, a, opts.cleanup)
    case TRIBE_COORD_METHODS.stop:
      return handleStop(ctx, a, opts)
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
  const only = unique.at(0)
  if (unique.length === 1 && only !== undefined) return only
  return unique
}

function activeBroadcastRecipients(ctx: TribeContext, answerableNames: ReadonlySet<string>): string[] {
  const names = [...answerableNames].filter((name) => name !== ctx.getName())
  if (names.length === 0) return []
  const placeholders = names.map(() => "?").join(", ")
  // This used to INNER JOIN room_members. Because every session was auto-joined
  // to its project room at register, the join matched everything — it was a
  // no-op filter standing in for "is a real session", and deleting the auto-join
  // without removing it would have made every broadcast enumerate ZERO
  // recipients. The membership table was never a room concept here; it was an
  // accidental liveness predicate.
  const rows = ctx.db
    .prepare(`
      SELECT s.name
      FROM sessions s
      WHERE s.name IN (${placeholders})
        AND s.role = 'member'
      ORDER BY s.name ASC
    `)
    .all(...names) as Array<{ name: string }>
  return rows.map((row) => row.name)
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
  const messageIdArg = a.message_id
  if (messageIdArg !== undefined && (typeof messageIdArg !== "string" || messageIdArg.trim().length === 0)) {
    return jsonResult({ error: "tribe.send: `message_id` must be a non-empty client-generated UUID when supplied." })
  }
  if (messageIdArg !== undefined && Array.isArray(recipients)) {
    return jsonResult({
      error: "tribe.send: `message_id` is supported for one recipient or broadcast, not a recipient list.",
    })
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
  if (typeof requestArg === "string" && requestArg.trim() === "true") {
    return jsonResult({
      error:
        'tribe.send: explicit request id "true" is reserved for generated message-id tracking; pass boolean `true` instead.',
    })
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
  // Stage 2(d) incident identity. A watcher passes the identity of the
  // condition it observed instead of letting the tracker key on the message
  // id, so N observations hold ONE obligation. Validation is a typed refusal
  // with the supported shape named, never a throw across the RPC boundary.
  let incident: (IncidentIdentity & { active?: boolean }) | undefined
  if (a.incident !== undefined) {
    const raw = a.incident
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return jsonResult({
        error:
          "tribe.send: `incident` must be an object {emitter, subject, condition, active?} identifying one live condition.",
      })
    }
    const fields = raw as Record<string, unknown>
    for (const field of ["emitter", "subject", "condition"] as const) {
      if (typeof fields[field] !== "string" || (fields[field] as string).trim().length === 0) {
        return jsonResult({
          error: `tribe.send: \`incident.${field}\` must be a non-empty string; all three of emitter/subject/condition identify the condition and a missing part would merge distinct incidents.`,
        })
      }
    }
    if (fields.active !== undefined && typeof fields.active !== "boolean") {
      return jsonResult({
        error:
          "tribe.send: `incident.active` must be a boolean — omit it (or pass true) while the condition holds, pass false as the clearing edge that closes the ball.",
      })
    }
    if (requestFlag || requestId !== null) {
      return jsonResult({
        error: "tribe.send: pass `incident` or `request`, not both — the incident identity IS the tracked request id.",
      })
    }
    if (recipients === "*" || Array.isArray(recipients)) {
      return jsonResult({
        error:
          "tribe.send: `incident` requires exactly one recipient — an incident is one standing obligation with one owner, and a broadcast owns no ball.",
      })
    }
    try {
      // Reuses the canonical builder so the wire and the daemon can never
      // disagree about what a well-formed identity is.
      incidentKey(fields as unknown as IncidentIdentity)
    } catch (error) {
      return jsonResult({ error: `tribe.send: ${(error as Error).message}` })
    }
    incident = {
      emitter: (fields.emitter as string).trim(),
      subject: (fields.subject as string).trim(),
      condition: (fields.condition as string).trim(),
      ...(fields.active === undefined ? {} : { active: fields.active as boolean }),
    }
  }
  if (incident !== undefined && a.expires_in_ms !== undefined) {
    return jsonResult({
      error:
        "tribe.send: `expires_in_ms` cannot be combined with `incident`; an incident is a standing condition cleared only by its emitter, not a reply deadline.",
    })
  }
  const sender = ctx.getName()
  const hasImplicitOwner = Array.isArray(recipients)
    ? recipients.some((recipient) => recipient !== sender)
    : recipients !== "*" && recipients !== sender
  const willTrack =
    requestFlag ||
    requestId !== null ||
    (incident !== undefined && incident.active !== false) ||
    (hasImplicitOwner && AUTO_TRACK_TYPES_SET.has(msgType))
  if (a.expires_in_ms !== undefined && !willTrack) {
    return jsonResult({ error: "tribe.send: `expires_in_ms` requires a tracked request." })
  }
  expiresInMs ??= defaultBallTtlMs(msgType, willTrack)
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
  const classification = {
    summary,
    ...(delivery ? { delivery } : {}),
    ...(typeof messageIdArg === "string" ? { messageId: messageIdArg.trim() } : {}),
  }
  const observedAt = Date.now()
  const transport = ownerTransportObservationProjector(ctx, opts, observedAt)
  const resolveRecipient = (recipient: string, tracked: boolean): DirectDeliveryResolution =>
    resolveDirectDelivery(recipient, transport, opts.resolveDelivery, tracked, delivery)
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
      observedAt,
    })
  }

  const broadcastOwners =
    recipients === "*" && (requestFlag || requestId !== null)
      ? activeBroadcastRecipients(ctx, transport.answerableNames)
      : undefined
  if (recipients === "*" && broadcastOwners !== undefined && broadcastOwners.length === 0) {
    return trackedDeliveryFailure(ctx, {
      recipients: [recipients],
      reason:
        `at admission snapshot ${new Date(observedAt).toISOString()}, no answer-capable broadcast owner was observed; ` +
        "start or resume a recipient, address a declared live holder, or retry later",
      observedAt,
      args: a,
      requestId,
    })
  }
  const resolution =
    recipients === "*"
      ? ({ status: "accepted", state: broadcastOwners === undefined ? "offline" : "online" } as const)
      : resolveRecipient(recipients, willTrack)
  if (resolution.status !== "accepted") {
    if (willTrack) {
      return trackedDeliveryFailure(ctx, {
        recipients: [recipients],
        reason: resolution.reason,
        observedAt,
        args: a,
        requestId,
      })
    }
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
      owners: broadcastOwners,
      incident,
    },
  )
  // An incident reports its identity as the request id so the caller can see
  // which standing obligation this observation landed on — the same key a
  // later clearing edge must carry.
  const effectiveRequestId =
    incident !== undefined
      ? incidentKey(incident)
      : requestFlag || (requestId === null && AUTO_TRACK_TYPES_SET.has(msgType) && sender !== recipients)
        ? result.id
        : requestId
  if (!result.deduplicated) {
    persistDeadLetter(ctx, resolution, sanitized, a, classification, effectiveRequestId)
  }
  if (!result.deduplicated) {
    logEvent(ctx, `message.sent.${msgType}`, a.bead as string | undefined, {
      to: recipients,
      message_id: result.id,
      ...(summaryDerived ? { summary_derived: true } : {}),
    })
  }
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
    ...(result.deduplicated ? { deduplicated: true } : {}),
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
  resolveRecipient: (recipient: string, tracked: boolean) => DirectDeliveryResolution
  observedAt: number
}): ToolResult {
  const implicitlyTracked =
    AUTO_TRACK_TYPES_SET.has(input.msgType) && input.recipients.some((recipient) => recipient !== input.sender)
  const sharedRequestId = input.requestFlag
    ? randomUUID()
    : (input.requestId ?? (implicitlyTracked ? randomUUID() : null))
  const explicitlyTracked = input.requestFlag || input.requestId !== null
  const resolutions = resolveDirectRecipients(input.recipients, (recipient) =>
    input.resolveRecipient(
      recipient,
      explicitlyTracked || (AUTO_TRACK_TYPES_SET.has(input.msgType) && recipient !== input.sender),
    ),
  )
  if (resolutions instanceof Error) {
    if (sharedRequestId !== null) {
      return trackedDeliveryFailure(input.ctx, {
        recipients: input.recipients,
        reason: resolutions.message.replace(/^tribe\.send:\s*/u, ""),
        observedAt: input.observedAt,
        args: input.args,
        requestId: sharedRequestId,
      })
    }
    return jsonResult({ error: resolutions.message })
  }
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
  transport: ReturnType<typeof ownerTransportObservationProjector>,
  resolver: DirectDeliveryResolver | undefined,
  tracked: boolean,
  explicitDelivery: Delivery | undefined,
): DirectDeliveryResolution {
  const directMailboxResolution = {
    status: "accepted",
    state: transport.answerableNames.has(recipient) ? "online" : "offline",
  } as const
  const resolution =
    explicitDelivery === "pull"
      ? directMailboxResolution
      : (resolver?.({ recipient, answerableNames: transport.answerableNames }) ?? directMailboxResolution)
  if (!tracked || resolution.status !== "accepted") return resolution
  if (resolution.state === "online" && transport.answerableNames.has(recipient)) return resolution
  if (resolution.state === "bounced" && transport.answerableNames.has(resolution.to)) return resolution
  if (resolution.state === "offline" && transport.mailboxRecipientNames.has(recipient)) return resolution

  const original = transport.observe(recipient)
  const snapshot = original.owner_transport_observed_at
  if (resolution.state === "bounced") {
    const fallback = transport.observe(resolution.to)
    return {
      status: "unresolved",
      reason:
        `at admission snapshot ${snapshot}, no connected, PID-live transport was observed for ` +
        `${JSON.stringify(recipient)}; configured fallback ${JSON.stringify(resolution.to)} also had ` +
        `no connected, PID-live transport (${fallback.owner_transport_reason}); start or resume ${recipient}, ` +
        "address a declared live holder, or retry later",
    }
  }
  return {
    status: "unresolved",
    reason:
      `at admission snapshot ${snapshot}, no connected, PID-live transport was observed for ` +
      `${JSON.stringify(recipient)} (${original.owner_transport_reason}); start or resume ${recipient}, ` +
      "address a declared live holder, or retry later",
  }
}

function trackedDeliveryFailure(
  ctx: TribeContext,
  input: {
    recipients: readonly string[]
    reason: string
    observedAt: number
    args: ToolArgs
    requestId: string | null
  },
): ToolResult {
  const deliveryFailureId = logEvent(
    ctx,
    "message.delivery-failed",
    input.args.bead as string | undefined,
    {
      schema_version: 1,
      recipients: input.recipients,
      reason: input.reason,
      observed_at: input.observedAt,
      ...(input.requestId === null ? {} : { request_id: input.requestId }),
    },
    { sender: ctx.getName(), ref: input.args.ref as string | undefined, ts: input.observedAt },
  )
  return jsonResult({
    error: `tribe.send: ${input.reason}`,
    delivery_failure_id: deliveryFailureId,
    observed_at: new Date(input.observedAt).toISOString(),
  })
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
  fanout: "first" | "all"
  request_kind: "request" | "incident"
  summary: string | null
  content?: string | null
}

type PendingBall = {
  request_id: string
  recipient: string
  sender: string
  opened_at: string
  expires_at: string | null
  age_ms: number
  message_id: string
  fanout: "first" | "all"
  /** Persisted ownership class. Missing only on historical journal outcomes
   *  written before the discriminator existed. */
  request_kind?: "request" | "incident"
  summary: string | null
  status: "active" | "expired" | "unanswered"
  /** Full question body, joined from the messages table on the pending
   * surfaces (22844). `null` means the store no longer holds the body — the
   * row stays listed, explicitly distinguishable from a readable one. Absent
   * on the attention preview, which stays summary-sized. */
  content?: string | null
}

type PendingBallWithOwnerTransport = PendingBall & OwnerTransportObservation

type PendingOutcomeBall = PendingBall & {
  status: "expired" | "unanswered"
  settlement: BallSettlementReason | null
  settled_at: string | null
  /** Older generations of the same (request_id, recipient) collapsed behind
   * this row — the incident rail re-sends one condition under fresh message
   * ids, and each generation's deadline fact would otherwise render as its
   * own obligation. History is disclosed here, never multiplied. */
  superseded_count?: number
  /** Which store stands behind the row: "live" = a pending_request row still
   * exists (declared deadline passed, still open — genuinely owed, and
   * closable); "journal" = reconstructed from journal facts alone (history:
   * settled later, or an unsettled ghost no close can reach). The legacy
   * status labels encode the same split under misleading names ("expired" =
   * live, "unanswered" = journal). */
  backing: "live" | "journal"
}

type PendingBallWithContent = PendingBall & { content: string | null }

type PendingReplyFactRow = {
  sender: string
  reply: string
}

type PendingBallSummary = {
  total: number
  oldest_age_ms: number
}

const ATTENTION_PENDING_BALL_LIMIT = 10

/** Example balls named in a close-miss warning; the count carries the rest. */
const MISS_WARNING_EXAMPLES = 5

/** Ids one `tribe.pending` close batch may carry. See the batch branch. */
const PENDING_CLOSE_BATCH_MAX = 100

/**
 * What a partly-successful batch close actually did.
 *
 * Deliberately NOT the single-id miss template: that text hardcodes
 * "closed 0 rows" and takes a request id, so a batch could only feed it a
 * count, and a drain that worked reported itself as a total failure. This
 * states the real total first, then names the ids that matched nothing —
 * bounded, because a stale drain can miss on many ids at once and the per-id
 * `reason` rows in the response already carry the full detail.
 */
function pendingCloseBatchWarning(
  owner: string,
  submitted: number,
  closed: number,
  results: ReadonlyArray<{ request_id: string; closed: number }>,
): string {
  const missed = results.filter((row) => row.closed === 0).map((row) => row.request_id)
  const shown = missed.slice(0, MISS_WARNING_EXAMPLES)
  const elided = missed.length - shown.length
  const more = elided > 0 ? `, and ${elided} more` : ""
  const noun = missed.length === 1 ? "id" : "ids"
  return (
    `closed ${closed} of ${submitted} for ${owner}; ` +
    `${missed.length} ${noun} matched no open ball: ${shown.join(", ")}${more} ` +
    `(per-id detail in results)`
  )
}

export type AttentionProjection = {
  actionable_unread: FetchEvent[]
  pending_balls: PendingBall[]
  pending_balls_summary: PendingBallSummary
}

function pendingBall(row: PendingBallRow, now: number): PendingBall {
  const expired = row.expires_at !== null && row.expires_at <= now
  return {
    request_id: row.request_id,
    recipient: row.recipient,
    sender: row.sender,
    opened_at: new Date(row.opened_at).toISOString(),
    expires_at: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
    age_ms: now - row.opened_at,
    message_id: row.message_id,
    fanout: row.fanout,
    request_kind: row.request_kind,
    summary: row.summary,
    status: expired ? "expired" : "active",
  }
}

function pendingBallWithContent(row: PendingBallRow, now: number): PendingBallWithContent {
  return { ...pendingBall(row, now), content: row.content ?? null }
}

function pendingOutcomeBall(
  fact: BallFactEvidence,
  now: number,
  settlement: BallSettlementReason | null,
  settledAt: number | null,
): PendingOutcomeBall {
  return {
    request_id: fact.request_id,
    recipient: fact.recipient,
    sender: fact.sender,
    opened_at: new Date(fact.opened_at).toISOString(),
    expires_at: fact.expires_at === null ? null : new Date(fact.expires_at).toISOString(),
    age_ms: now - fact.opened_at,
    message_id: fact.message_id,
    fanout: fact.fanout,
    summary: fact.summary,
    status: "unanswered",
    settlement,
    settled_at: settledAt === null ? null : new Date(settledAt).toISOString(),
    backing: "journal",
  }
}

function pendingBallsForOwner(ctx: TribeContext, owner: string, now: number): PendingBall[] {
  const rows = ctx.stmts.selectPendingForRecipient.all({ $recipient: owner }) as PendingBallRow[]
  return sortPendingBalls(rows.map((row) => pendingBall(row, now)))
}

function pendingBallsForOwnerWithContent(ctx: TribeContext, owner: string, now: number): PendingBallWithContent[] {
  const rows = ctx.stmts.selectPendingForRecipientWithContent.all({ $recipient: owner }) as PendingBallRow[]
  return sortPendingBalls(rows.map((row) => pendingBallWithContent(row, now)))
}

/**
 * A ball must never outlive its question (22844): the tracker's retention is
 * unbounded while every log read is a window, so the pending surfaces join
 * the body back in by message id. `content: null` marks a body the store no
 * longer holds — the obligation stays listed, explicitly flagged, never
 * indistinguishable from a readable one.
 */
function withQuestionBodies<T extends { message_id: string }>(
  ctx: TribeContext,
  balls: T[],
): (T & { content: string | null })[] {
  const bodies = new Map<string, string | null>()
  return balls.map((ball) => {
    let content = bodies.get(ball.message_id)
    if (content === undefined) {
      const row = ctx.stmts.selectMessageContentById.get({ $id: ball.message_id }) as { content: string } | null
      content = row?.content ?? null
      bodies.set(ball.message_id, content)
    }
    return { ...ball, content }
  })
}

function pendingFactKey(fact: Pick<BallFactEvidence, "request_id" | "recipient" | "message_id">): string {
  return JSON.stringify([fact.request_id, fact.recipient, fact.message_id])
}

function indexPendingReplies(replies: readonly PendingReplyFactRow[]): Map<string, Set<string>> {
  const respondersByRef = new Map<string, Set<string>>()
  for (const reply of replies) {
    const responders = respondersByRef.get(reply.reply) ?? new Set<string>()
    responders.add(reply.sender)
    respondersByRef.set(reply.reply, responders)
  }
  return respondersByRef
}

function pendingFactWasAnswered(
  fact: Pick<BallFactEvidence, "request_id" | "recipient" | "message_id" | "fanout">,
  respondersByRef: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const requestResponders = respondersByRef.get(fact.request_id)
  const messageResponders = respondersByRef.get(fact.message_id)
  if (fact.fanout === "first") return (requestResponders?.size ?? 0) > 0 || (messageResponders?.size ?? 0) > 0
  return requestResponders?.has(fact.recipient) === true || messageResponders?.has(fact.recipient) === true
}

/** Read-authoritative fold. Live deadline passage comes from pending_request,
 * replies come from durable messages, and non-reply terminal reasons come from
 * journal facts. The journal's ball.expired row is only an observation echo;
 * it is never misreported as a terminal settlement. */
function expiredPendingBalls(ctx: TribeContext, now: number): PendingOutcomeBall[] {
  const rows = ctx.stmts.selectPendingOutcomeFacts.all() as BallOutcomeFactRow[]
  const replies = ctx.stmts.selectPendingReplyFacts.all() as PendingReplyFactRow[]
  const respondersByRef = indexPendingReplies(replies)
  const facts = rows.map(parseBallOutcomeFact)
  const settlements = new Map<string, BallSettlementFact>()
  for (const fact of facts) {
    if (fact.kind !== "settled") continue
    const key = pendingFactKey(fact)
    const prior = settlements.get(key)
    if (prior !== undefined && prior.settlement !== fact.settlement) {
      throw new Error(
        `conflicting ball settlement facts for ${fact.request_id}: ${prior.settlement} vs ${fact.settlement}`,
      )
    }
    settlements.set(key, fact)
  }

  const live = allPendingBalls(ctx, now).filter(
    (ball): ball is PendingBall & { status: "expired" } => ball.status === "expired",
  )
  const liveKeys = new Set(live.map(pendingFactKey))
  // A live pending_request row is the ownership authority. A malformed or
  // wrong-owner reply may be durably recorded with closed=0, but it must never
  // hide the row that still exists and is still owed.
  const outcomes: PendingOutcomeBall[] = live.map((ball) => ({
    ...ball,
    settlement: null,
    settled_at: null,
    backing: "live" as const,
  }))
  const representedSettlements = new Set<string>()

  for (const fact of facts) {
    if (fact.kind !== "deadline-passed") continue
    const key = pendingFactKey(fact)
    if (liveKeys.has(key) || pendingFactWasAnswered(fact, respondersByRef)) continue
    const settlement = settlements.get(key)
    if (settlement?.settlement === "answered") continue
    if (settlement) representedSettlements.add(key)
    outcomes.push(pendingOutcomeBall(fact, now, settlement?.settlement ?? null, settlement?.settled_at ?? null))
  }

  for (const fact of settlements.values()) {
    if (fact.settlement === "answered") continue
    const key = pendingFactKey(fact)
    if (liveKeys.has(key) || representedSettlements.has(key) || pendingFactWasAnswered(fact, respondersByRef)) continue
    outcomes.push(pendingOutcomeBall(fact, now, fact.settlement, fact.settled_at))
  }
  return sortPendingBalls(collapseOutcomeGenerations(outcomes))
}

/**
 * One obligation per (request_id, recipient). The fact fold above is keyed
 * per MESSAGE — correct for journal identity, wrong for display: a standing
 * condition re-sent across generations leaves one deadline fact per fresh
 * message id, and the live pile rendered 255 rows for 198 identities (one
 * wait-watch condition alone rendered 15 unanswered ghosts no close could
 * reach). Keep the latest generation; disclose the rest as superseded_count.
 */
function collapseOutcomeGenerations(outcomes: PendingOutcomeBall[]): PendingOutcomeBall[] {
  const byIdentity = new Map<string, PendingOutcomeBall>()
  for (const row of outcomes) {
    const key = JSON.stringify([row.request_id, row.recipient])
    const prior = byIdentity.get(key)
    if (prior === undefined) {
      byIdentity.set(key, { ...row, superseded_count: 0 })
      continue
    }
    const latest = prior.opened_at >= row.opened_at ? prior : { ...row, superseded_count: 0 }
    latest.superseded_count = (prior.superseded_count ?? 0) + 1
    // Content (message id, summary, settlement) is the LATEST generation's;
    // the obligation's AGE is the condition's whole standing life — it has
    // been owed since the first opening, not since the newest re-send.
    latest.opened_at = prior.opened_at <= row.opened_at ? prior.opened_at : row.opened_at
    latest.age_ms = Math.max(prior.age_ms, row.age_ms)
    byIdentity.set(key, latest)
  }
  return [...byIdentity.values()]
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
  // This read is unbounded: it fetches the owner's whole pile to produce the
  // count below, so miss latency grows with the backlog — measured 0.07ms at
  // 20 balls, 0.50ms at 400. It stays that way because half a millisecond on
  // a miss is not worth the complexity of a bounded count-plus-sample, and
  // for no other reason. In particular NOT to preserve the peer preference
  // below: `peers` is undefined at the close call site, so that branch is
  // inert there and only does work on the tracker/reply path.
  const allPending = pendingBallsForOwner(ctx, owner, now)
  const peerPending = allPending.filter(fromRelevantPeer)
  // An empty ball list is the *loudest* case, not the quiet one: the id matched
  // nothing and there was nothing it could have matched, which is exactly the
  // shape a fabricated or truncated request id produces. Staying silent here
  // let a close that closed nothing read as clean success.
  if (allPending.length === 0) return `reply/close ${attemptedId} closed 0 rows; ${owner} owns no open balls`
  // Prefer obligations from the addressed peer because they are the likely
  // intended close target. If that peer has none, show the owner's actual open
  // obligations instead of making the false global claim that none exist.
  const pending = peerPending.length > 0 ? peerPending : allPending
  // Bounded. This listing named EVERY open ball, so it grew with the backlog —
  // measured at 877 characters for 20 balls and 16,757 for 400 — on the path an
  // operator hits most while draining a stale pile. The count is what tells
  // them the id was wrong; a few examples tell them what the right ones look
  // like; the rest is a response body nobody reads. `tribe pending` remains the
  // way to see all of them.
  const shown = pending.slice(0, MISS_WARNING_EXAMPLES)
  const listing = shown
    .map((ball) => {
      const deadlinePassed = ball.expires_at !== null && Date.parse(ball.expires_at) <= now
      const deadline = deadlinePassed ? "; declared deadline passed, still open" : ""
      return `${ball.request_id} (message ${ball.message_id}, from ${ball.sender}${deadline})`
    })
    .join(", ")
  const elided = pending.length - shown.length
  const more = elided > 0 ? `, and ${elided} more (run \`tribe pending\` for the full list)` : ""
  return `reply/close ${attemptedId} closed 0 rows; ${owner} owns ${pending.length} open ball(s): ${listing}${more}`
}

/**
 * Settle one ball for `owner`. The single and batch close paths share this so
 * the two can never diverge on what "closed" means. Must be called inside a
 * transaction by its caller — the batch opens one for the whole list.
 */
function closeOneBall(
  ctx: TribeContext,
  owner: string,
  attemptedId: string,
  now: number,
): { request_id: string; closed: number; reason?: string } {
  const requestId = pendingRequestIdForOwner(ctx, owner, attemptedId)
  const row = ctx.stmts.selectPendingSettlementForRecipient.get({
    $request_id: requestId,
    $recipient: owner,
  }) as PendingSettlementRow | null
  if (row === null) {
    return { request_id: requestId, closed: 0, reason: `no open ball ${requestId} owned by ${owner}` }
  }
  const settlement = ctx.getName() === row.sender && ctx.getName() !== owner ? "sender-withdrawn" : "manual-close"
  return { request_id: requestId, closed: settlePendingRows(ctx, [row], settlement, ctx.getName(), now) }
}

function pendingRequestIdForOwner(ctx: TribeContext, owner: string, attemptedId: string): string {
  const pending = ctx.stmts.selectPendingForReplyRecipient.get({
    $reply_id: attemptedId,
    $recipient: owner,
  }) as { request_id: string } | null
  return pending?.request_id ?? attemptedId
}

function incidentCloseRefusal(ctx: TribeContext, owner: string, attemptedIds: readonly string[]): string | undefined {
  const incidentId = attemptedIds
    .map((id) => pendingRequestIdForOwner(ctx, owner, id))
    .find((requestId) => {
      const row = ctx.stmts.selectPendingKindForRecipient.get({
        $request_id: requestId,
        $recipient: owner,
      }) as { request_kind: "request" | "incident" } | null
      return row?.request_kind === "incident"
    })
  if (incidentId === undefined) return undefined
  return (
    `tribe.pending: refusing --close for incident ${JSON.stringify(incidentId)}; ` +
    "only the incident emitter can clear it when the condition ends. " +
    `From the emitter, run \`tribe send ${owner} 'incident cleared' --type notify --summary 'incident cleared' ` +
    `--incident ${JSON.stringify(incidentId)} --incident-cleared\`.`
  )
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

function allPendingBalls(ctx: TribeContext, now: number): PendingBall[] {
  const rows = ctx.stmts.selectAllPendingRequests.all() as PendingBallRow[]
  return sortPendingBalls(rows.map((row) => pendingBall(row, now)))
}

function allPendingBallsWithContent(ctx: TribeContext, now: number): PendingBallWithContent[] {
  const rows = ctx.stmts.selectAllPendingRequestsWithContent.all() as PendingBallRow[]
  return sortPendingBalls(rows.map((row) => pendingBallWithContent(row, now)))
}

function sortPendingBalls<T extends PendingBall>(rows: readonly T[]): T[] {
  const statusRank = { expired: 0, unanswered: 1, active: 2 } as const
  return rows.toSorted((left, right) => {
    if (left.status !== right.status) return statusRank[left.status] - statusRank[right.status]
    return Date.parse(left.opened_at) - Date.parse(right.opened_at) || left.request_id.localeCompare(right.request_id)
  })
}

function pendingOwnerGroups<T extends PendingBall>(pending: readonly T[]) {
  const byOwner = new Map<string, T[]>()
  for (const ball of pending) {
    const rows = byOwner.get(ball.recipient) ?? []
    rows.push(ball)
    byOwner.set(ball.recipient, rows)
  }
  return [...byOwner.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([owner, rows]) => {
      const oldestFirst = sortPendingBalls(rows)
      return {
        owner,
        count: oldestFirst.length,
        oldest_age_ms: oldestFirst.reduce((oldest, row) => Math.max(oldest, row.age_ms), 0),
        pending: oldestFirst,
      }
    })
}

function pendingOwnerSummaries(pending: readonly PendingBall[]) {
  return pendingOwnerGroups(pending).map(({ pending: _pending, ...summary }) => summary)
}

function handlePending(ctx: TribeContext, a: ToolArgs, opts: HandlerOpts): ToolResult {
  // Ball-tracker pending-query (@km/tribe/message-ball-tracker Phase 2a):
  // return open requests addressed to the given recipient (the "owner" of
  // the open ball). Default recipient is the caller's own session name.
  // Optional `stale_ms` filters to requests older than that threshold.
  const owner = (a.owner as string) ?? ctx.getName()
  const all = a.all === true
  const expired = a.expired === true
  const owed = a.owed === true
  const staleMs = typeof a.stale_ms === "number" ? a.stale_ms : null
  const now = Date.now()
  const transport = ownerTransportObservationProjector(ctx, opts, now)
  const withOwnerTransport = <T extends PendingBall>(rows: readonly T[]): Array<T & OwnerTransportObservation> =>
    rows.map((row) => ({ ...row, ...transport.observe(row.recipient) }))

  if (all && typeof a.owner === "string") {
    return jsonResult({ error: "tribe.pending: all and owner are mutually exclusive." })
  }
  if (all && (a.close !== undefined || a.prune === true)) {
    return jsonResult({ error: "tribe.pending: all is read-only; close/prune require one explicit owner." })
  }
  if (expired && (a.close !== undefined || a.prune === true)) {
    return jsonResult({ error: "tribe.pending: expired is a read-only diagnostic view." })
  }
  if (owed && !expired) {
    return jsonResult({ error: "tribe.pending: owed filters the expired view; pass expired: true." })
  }

  // Explicit repair path (@km/tribe/20008): prune stale balls for `owner`. Safe
  // to run during chief recovery — it REQUIRES a stale_ms threshold so it can
  // only ever settle balls older than that age (fresh request/reply balls and
  // other recipients are untouched). It records full gc-expired evidence before
  // removing active ownership and never deletes message history.
  if (a.prune === true) {
    if (staleMs === null) {
      return jsonResult({ error: "prune requires stale_ms (the minimum ball age, in ms, to GC)." })
    }
    const pruned = ctx.db.transaction(() => {
      const rows = ctx.stmts.selectPendingSettlementsForRecipientBefore.all({
        $recipient: owner,
        $cutoff: now - staleMs,
      }) as PendingSettlementRow[]
      return settlePendingRows(ctx, rows, "gc-expired", ctx.getName(), now)
    })()
    return jsonResult({ owner, pruned, stale_ms: staleMs })
  }

  // A backlog drain used to cost one round trip per ball, so a standing
  // "at most five open balls" rule was unsatisfiable against 200 parked ones:
  // 200 spawn+connect+RPC cycles on a rail that one send per 1.5s already
  // saturates. `close` therefore also accepts a LIST, settled in one call and
  // one transaction. Both forms route through the same `closeOneBall` below,
  // so the batch cannot drift from the single close it batches.
  //
  // Note for anyone optimising further: the per-close cost is not the problem.
  // A close that HITS is flat at ~0.047ms whether 20 or 400 balls are open —
  // both lookups are keyed on pending_request's primary key — and a full drain
  // is linear, not quadratic. The win here is collapsing n round trips into 1.
  const closeBatch = Array.isArray(a.close) ? a.close : null
  if (closeBatch !== null) {
    if (closeBatch.length === 0 || !closeBatch.every((id) => typeof id === "string" && id.length > 0)) {
      return jsonResult({
        error: "tribe.pending: close accepts a request id or a non-empty list of non-empty request ids.",
      })
    }
    // Capped. The whole batch runs inside ONE write transaction, on a branch
    // whose subject is event-loop starvation — an unbounded list is a wedge
    // waiting to be submitted. A 200-ball backlog takes two calls, which is
    // still two round trips instead of two hundred.
    if (closeBatch.length > PENDING_CLOSE_BATCH_MAX) {
      return jsonResult({
        error:
          `tribe.pending: close batch of ${closeBatch.length} exceeds the ${PENDING_CLOSE_BATCH_MAX} id limit; ` +
          `split it into batches of at most ${PENDING_CLOSE_BATCH_MAX}.`,
      })
    }
    const ids = closeBatch as string[]
    const refusal = incidentCloseRefusal(ctx, owner, ids)
    if (refusal !== undefined) return jsonResult({ error: refusal })
    // One transaction for the whole batch, but NOT all-or-nothing about
    // MISSES: an id that matches nothing is a reported result row, not a
    // rollback of its peers. A genuine ERROR mid-batch is different — it
    // aborts the transaction, so nothing settles and the caller never sees a
    // `results` array. That is deliberate: on error, no ball was closed.
    const results = ctx.db.transaction(() => ids.map((id) => closeOneBall(ctx, owner, id, now)))()
    const closed = results.reduce((total, row) => total + row.closed, 0)
    // The batch composes its OWN summary and never borrows the single-id miss
    // template. That template's text hardcodes "closed 0 rows" and expects a
    // request id where the batch could only supply a count, so a drain that
    // WORKED announced "reply/close 3 of 4 closed 0 rows; owner owns no open
    // balls" — a loud false failure on the primary path, fired precisely
    // because the close succeeded.
    const warning = closed === ids.length ? undefined : pendingCloseBatchWarning(owner, ids.length, closed, results)
    return jsonResult({ owner, closed, results, ...(warning ? { warning } : {}) })
  }

  // An empty string reached neither branch — not an array, and length 0 — so
  // it fell through to the plain pending listing: a close that closed nothing
  // and never said so. Refused here, symmetric with the batch's refusal above.
  if (typeof a.close === "string" && a.close.length === 0) {
    return jsonResult({
      error: "tribe.pending: close requires a non-empty request id.",
    })
  }

  const closeId = typeof a.close === "string" && a.close.length > 0 ? a.close : null
  if (closeId) {
    const refusal = incidentCloseRefusal(ctx, owner, [closeId])
    if (refusal !== undefined) return jsonResult({ error: refusal })
    const outcome = ctx.db.transaction(() => closeOneBall(ctx, owner, closeId, now))()
    const warning = outcome.closed === 0 ? pendingCloseMissWarning(ctx, owner, undefined, closeId) : undefined
    return jsonResult({
      owner,
      request_id: outcome.request_id,
      closed: outcome.closed,
      ...(warning ? { warning } : {}),
    })
  }

  if (all) {
    const rows = expired
      ? withQuestionBodies(
          ctx,
          expiredPendingBalls(ctx, now).filter(
            (row) => (!owed || row.backing === "live") && (staleMs === null || row.age_ms >= staleMs),
          ),
        )
      : allPendingBallsWithContent(ctx, now).filter((row) => staleMs === null || row.age_ms >= staleMs)
    const pending: PendingBallWithOwnerTransport[] = withOwnerTransport(rows)
    const owners = pendingOwnerGroups(pending)
    return jsonResult({
      all: true,
      expired,
      ...(owed ? { owed: true } : {}),
      scope: "all",
      pending,
      owners,
      owner_count: owners.length,
      oldest_age_ms: pending.reduce((oldest, row) => Math.max(oldest, row.age_ms), 0),
      count: pending.length,
    })
  }

  const rows = expired
    ? withQuestionBodies(
        ctx,
        expiredPendingBalls(ctx, now).filter(
          (row) =>
            row.recipient === owner && (!owed || row.backing === "live") && (staleMs === null || row.age_ms >= staleMs),
        ),
      )
    : pendingBallsForOwnerWithContent(ctx, owner, now).filter((row) => staleMs === null || row.age_ms >= staleMs)
  const pending: PendingBallWithOwnerTransport[] = withOwnerTransport(rows)
  return jsonResult({ owner, expired, ...(owed ? { owed: true } : {}), pending, count: pending.length })
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

/**
 * The launch ids a currently-connected session holds. `launch_id` is
 * `providerLaunchId::persona` (wire `persona-launch-identity.ts`), so it names
 * one seat of one provider launch — two rows sharing it are the same seat
 * registered twice, never two different seats.
 */
function activeLaunchIdSet(rows: readonly MembershipSessionRow[], activeIds: ReadonlySet<string>): Set<string> {
  const launchIds = new Set<string>()
  for (const row of rows) {
    if (!activeIds.has(row.id)) continue
    if (typeof row.launch_id === "string" && row.launch_id.length > 0) launchIds.add(row.launch_id)
  }
  return launchIds
}

function latestDisconnectedSessionRows<T extends MembershipSessionRow>(
  rows: readonly T[],
  activeIds: ReadonlySet<string>,
): T[] {
  const activeNames = new Set(rows.filter((row) => activeIds.has(row.id)).map((row) => row.name))
  // A seat that comes back while its old row still holds the name registers
  // under an auto-suffixed name (session.ts `registerSession`), so the name
  // check alone leaves the old row standing forever as a phantom wedge — 21
  // of 23 durable launches read as a fleet outage that was not happening.
  // A LIVE claimant for the same launch id is positive evidence that the old
  // registration was replaced. This never concludes absence from a missing
  // transport; it concludes supersession from a present one.
  const supersededLaunchIds = activeLaunchIdSet(rows, activeIds)
  const latestByName = new Map<string, T>()
  for (const row of rows) {
    if (activeIds.has(row.id) || activeNames.has(row.name)) continue
    if (typeof row.launch_id === "string" && supersededLaunchIds.has(row.launch_id)) continue
    const previous = latestByName.get(row.name)
    if (previous === undefined || row.updated_at > previous.updated_at) latestByName.set(row.name, row)
  }
  return [...latestByName.values()]
}

function projectDisconnectedSessionRows<T extends MembershipSessionRow>(
  rows: readonly T[],
  activeIds: ReadonlySet<string>,
): { diagnostic: T[]; anonymousDurable: T[] } {
  const diagnostic: T[] = []
  const anonymousDurable: T[] = []
  for (const row of latestDisconnectedSessionRows(rows, activeIds)) {
    if (isDurableMembershipSessionRow(row) && isUnidentifiedSessionName(row.name)) {
      anonymousDurable.push(row)
    } else {
      diagnostic.push(row)
    }
  }
  return { diagnostic, anonymousDurable }
}

function projectMembershipDiscrepancy(
  rows: readonly MembershipSessionRow[],
  activeIds: ReadonlySet<string>,
  disconnectedRows: readonly MembershipSessionRow[],
): MembershipDiscrepancy | undefined {
  // Superseded rows are excluded from the denominator too, or a seat that
  // re-registered under an auto-suffixed name counts as two known launches
  // and reports "1 of 2 connected" about one live seat.
  const supersededLaunchIds = activeLaunchIdSet(rows, activeIds)
  const durableRows = rows
    .filter(isDurableMembershipSessionRow)
    .filter((row) => !isUnidentifiedSessionName(row.name))
    .filter((row) => activeIds.has(row.id) || !supersededLaunchIds.has(row.launch_id))
  const knownNames = new Set(durableRows.map((row) => row.name))
  const connectedNames = new Set(durableRows.filter((row) => activeIds.has(row.id)).map((row) => row.name))
  const missing = disconnectedRows.filter(isDurableMembershipSessionRow).map((row) => ({
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
  // Sessions are read directly. This used to INNER JOIN room_members, which
  // filtered the roster to sessions holding a membership row — and since every
  // session was auto-joined at register, the filter matched everything and was
  // a no-op that had become load-bearing by accident. Deleting the auto-join
  // without this would have blinded `tribe members`: new sessions would have no
  // membership row and the join would drop them. The DISTINCT went with it; it
  // existed only to collapse a session appearing once per room.
  const rows = ctx.db
    .prepare(`
      SELECT s.id, s.name, s.role, s.domains, s.pid, s.cwd,
        s.claude_session_id, s.claude_session_name, s.started_at, s.updated_at,
        s.account, s.provider, s.launch_id, s.launch_parent_pid, s.delivery
      FROM sessions s
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
    const protocolVersions = active?.protocolVersions ?? []
    const transportConnected = activeIds.has(r.id)
    const transportPids = active?.transportPids ?? []
    // A registry entry can outlive the process it names — a dead transport
    // adapter, a session mid-restart whose old socket hasn't been pruned yet
    // — so BOTH `transport_state` and `alive` must be confirmed with a pid
    // probe at read time, never read off transport-registry presence alone.
    // Registry presence stays visible as `transport_registered`; it just no
    // longer speaks for the transport. Disconnected rows are deliberately NOT
    // pid-probed: a DB-stored pid is reusable and proves nothing once the
    // transport is gone (session.ts `isPidAlive` docstring) —
    // transport_connected=false already yields alive=false below.
    const agentPid = active ? (active.launchParentPid ?? active.pid) : null
    const evidence = projectSessionTransportEvidence({
      transportConnected,
      transportPids,
      agentPid,
      lastSeenSec: Math.round((Date.now() - r.updated_at) / 1000),
      probe: (pid) => (pidStillAlive(pid) ? "live" : "dead"),
    })
    return {
      member_id: r.id,
      name: r.name,
      role: r.role,
      domains: parseDomains(r.domains),
      pid: active?.pid ?? r.pid,
      agent_pid: agentPid,
      launch_id: r.launch_id,
      launch_parent_pid: r.launch_parent_pid,
      delivery: r.delivery,
      transport_pids: transportPids,
      protocol_versions: protocolVersions,
      version_state:
        protocolVersions.length === 0
          ? "version-unknown"
          : protocolVersions.some((version) => version < TRIBE_PROTOCOL_VERSION)
            ? "version-degraded"
            : "current",
      cwd: r.cwd,
      claude_session_id: r.claude_session_id,
      claude_session_name: r.claude_session_name,
      ...evidence,
      // `alive` (plus transport_alive/agent_alive/pid_alive/is_silent) is
      // derived above, never asserted from transport-registry presence — see
      // the comment on `liveness`. Kept as `alive` for wire compatibility;
      // the other fields are additive.
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
  const disconnected = projectDisconnectedSessionRows(rows, activeIds)
  const membershipDiscrepancy = projectMembershipDiscrepancy(rows, activeIds, disconnected.diagnostic)
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
  const disconnected = projectDisconnectedSessionRows(rows, activeIds)
  const transportWedges = disconnected.diagnostic.flatMap((session) => {
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
  const membershipDiscrepancy = projectMembershipDiscrepancy(rows, activeIds, disconnected.diagnostic)

  const members = liveSessions.map((s) => {
    const active = byId.get(s.id)
    if (active === undefined) throw new Error(`active session ${s.id} disappeared during membership projection`)
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
    // The zombie warning above and `transport_state` used to disagree inside
    // one row: the warning said the pids were dead while the projection still
    // reported `connected` off registry presence. Feed the same probe into the
    // projection so both read from one fact.
    const transport = projectSessionTransportState({ transportConnected: true, transportPidsAlive: pidAlive })
    const agentPid = active.launchParentPid ?? active.pid
    const agentPidAlive = agentPid ? pidStillAlive(agentPid) : pidAlive
    const lastSeenSec = lastMsgAge ? Math.round(lastMsgAge / 1000) : Math.round((Date.now() - s.started_at) / 1000)
    const liveness = projectSessionLiveness({
      transportConnected: true,
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
				AND ${unretiredAttentionPredicateSql("m")}
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
    // Retain unidentified durable history without manufacturing named-seat
    // alarms. One known producer is @ag/tribe/no-tribe-flag-does-not-gate-the-join.
    anonymous_disconnected: disconnected.anonymousDurable.length,
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
  return jsonResult(result)
}

function handleRestart(ctx: TribeContext, a: ToolArgs, cleanup: () => void): ToolResult {
  const reason = (a.reason as string) ?? "manual restart"
  logEvent(ctx, "session.restart", undefined, { name: ctx.getName(), reason })
  log.info?.(`restarting: ${reason}`)

  // Schedule the re-exec after the tool response is flushed.
  //
  // We deliberately do NOT spawn the replacement daemon here. A naive
  // `Bun.spawn([execPath, ...process.argv])` re-exec races the old daemon to
  // re-bind the socket, sees "Another daemon is already listening", and exits
  // immediately; meanwhile the old daemon also exits. Net result: NO daemon,
  // and every session sees "No daemon running". (Reproduced 2026-05-21 — a
  // session calling `tribe.restart` repeatedly killed the daemon.)
  //
  // Instead we SIGHUP ourselves. The daemon's `withSignals` factory routes
  // SIGHUP → `withHotReload.reload()`, which asks the declared lifecycle owner
  // for a replacement. A directly launched standalone daemon first installs
  // that stable owner; successor daemons never detach themselves. This is the
  // same hardened path `tribe restart` (the CLI) already uses.
  setTimeout(() => {
    cleanup()
    log.info?.(`SIGHUP self (pid=${process.pid}) — restart via lifecycle owner`)
    process.kill(process.pid, "SIGHUP")
  }, 100) // small delay so the tool response gets sent first

  return jsonResult({ restarting: true, reason, pid: process.pid })
}

/**
 * `tribe.stop` — clean daemon shutdown: drain long-polls, close the socket,
 * exit 0. Mirrors handleRestart's flush-then-act shape but routes to the
 * plain shutdown path, NOT the SIGHUP → lifecycle-owner re-exec: no successor
 * is asked for. This is the sanctioned alternative to killing the process
 * externally (the socket-squatter kill era).
 *
 * Guarded: stopping halts coordination for every registered session, so a
 * casual caller must not be able to do it by accident. The daemon refuses
 * without an explicit `force: true`; the CLI (`tribe stop`) supplies it for
 * `--force` or a hab-supervisor context (HAB_SERVICE_NAME in the caller's
 * environment). There is deliberately NO command descriptor for this method —
 * it never appears on the MCP tool surface, so a bridge session cannot reach
 * it at all; the force gate covers raw socket callers.
 */
function handleStop(ctx: TribeContext, a: ToolArgs, opts: HandlerOpts): ToolResult {
  if (a.force !== true) {
    return jsonResult({
      error:
        "tribe.stop refused: stopping halts the shared coordination daemon for every registered session. " +
        "Pass force: true (CLI: `tribe stop --force`) — or run the CLI from the hab supervisor context — " +
        "if you really mean to stop the rail.",
    })
  }
  const triggerStop = opts.triggerStop
  if (!triggerStop) {
    return jsonResult({
      error: "tribe.stop unavailable: this handler surface has no daemon shutdown hook (direct handler harness?)",
    })
  }
  const reason = (a.reason as string) ?? "manual stop"
  logEvent(ctx, "daemon.stop", undefined, { name: ctx.getName(), reason })
  log.info?.(`stopping: ${reason} (requested by ${ctx.getName()})`)
  // Schedule after the tool response is flushed — same shape as handleRestart.
  setTimeout(() => {
    opts.cleanup()
    log.info?.(`clean shutdown (pid=${process.pid}) — tribe.stop, no successor`)
    triggerStop()
  }, 100)
  return jsonResult({ stopping: true, reason, pid: process.pid })
}

async function handleRetro(ctx: TribeContext, a: ToolArgs): Promise<ToolResult> {
  const { generateRetro, formatMarkdown, parseDuration } = await import("../../../wire/src/lib/retro.ts")
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
  return opts.inboxWait.wait(session, connId, timeoutMs, { wakeOnCorrelatedReply }).then((result) => {
    const publicResult = { ...result } as InboxWaitResult & {
      baseline_seq?: number
    }
    delete publicResult.baseline_seq
    return jsonResult(publicResult)
  })
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
  return ctx.stmts.sessionRoster.all() as Array<{ name: string; role: string | null }>
}

function filterRowsByTrust(ctx: TribeContext, rows: FetchRow[]): FetchRow[] {
  if (rows.length === 0) return rows
  // `senderMayUseRegisteredTrustTopic` consults the roster only for a topic in
  // the registered trust set, and returns true without reading it for every
  // other topic. Reading the roster up front therefore compiled a statement
  // and scanned the whole `sessions` table on every attention read, almost
  // always to answer a question no row was asking. Materialise it only when a
  // row actually carries a registered trust topic; the filter below is
  // unchanged, so the admitted set is identical either way.
  if (!rows.some((r) => registeredTrustTierForTopic(r.topic))) return rows
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

/**
 * The session's stored subscription, as bound parameters for `getInboxRows`.
 *
 * Deliberately mirrors `shouldDeliver` in with-broadcast.ts, which governs the
 * push wakeup — the two must agree or a seat's subscription would mean one thing
 * when pushed and another when pulled. A session with no row yet defaults to
 * `normal` with no mute, matching that function's `if (!filter) return true`.
 */
function inboxFilterParams(ctx: TribeContext): {
  $filter_mode: string
  $filter_mute: string | null
  $filter_until: number | null
  $now: number
} {
  const filter = ctx.stmts.getSessionFilter.get({ $id: ctx.sessionId }) as
    | { filter_mode: string | null; filter_mute: string | null; filter_until: number | null }
    | undefined
  return {
    $filter_mode: filter?.filter_mode || "normal",
    $filter_mute: filter?.filter_mute ?? null,
    $filter_until: filter?.filter_until ?? null,
    $now: Date.now(),
  }
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
  let exhaustedTo: number | null = null
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
    // Read the high-water mark BEFORE the window so it can only be
    // conservative: a row inserted between the two reads is above it and is
    // picked up on the next drain rather than skipped.
    const highWater = (ctx.stmts.getMaxMessageRowid.get() as { max_rowid: number }).max_rowid
    const windowRows =
      windowBudget > 0
        ? (ctx.stmts.getInboxRows.all({
            $since: cursorBase,
            $name: currentName,
            $limit: windowBudget,
            ...inboxFilterParams(ctx),
          }) as FetchRow[])
        : []
    // A short window means the predicate exhausted the tail: every row above the
    // cursor is either in this result or excluded by this seat's subscription.
    if (windowBudget > 0 && windowRows.length < windowBudget) exhaustedTo = highWater
    rows = [...recovered, ...windowRows]
    shouldAdvance = !topicsAreSnapshot && a.advance !== false
  }

  const visibleRows = rows
  rows = filterRowsByTrust(ctx, visibleRows)
  const filtered = topics && topics.length > 0 ? rows.filter((r) => matchesGlob(topics, r.topic)) : rows
  const cursorRows = topics && topics.length > 0 ? visibleRows.filter((r) => matchesGlob(topics, r.topic)) : visibleRows
  let outputCursor = Math.max(cursorBase, filtered.at(-1)?.rowid ?? cursorBase)

  if (shouldAdvance) {
    let seq = Math.max(cursorBase, cursorRows.at(-1)?.rowid ?? cursorBase)
    // Excluded rows still advance the cursor. Parking it on a seat whose whole
    // window was filtered would leave the excluded tail to be re-scanned on
    // every fetch — unbounded growth on the hot path.
    if (exhaustedTo !== null) seq = Math.max(seq, exhaustedTo)
    if (seq > cursorBase) {
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
    {},
    { sender: "daemon", senderRole: "daemon" },
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
