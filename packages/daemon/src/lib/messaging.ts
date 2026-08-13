/**
 * Tribe messaging — send messages and log events.
 */

import { randomUUID } from "node:crypto"
import type { TribeContext } from "./context.ts"
import { AUTO_TRACK_TYPES_SET } from "./database.ts"
import { incidentKey, type BallSettlementReason, type IncidentIdentity } from "tribe-wire"

export type { BallSettlementReason } from "tribe-wire"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * `MessageKind` describes the *transport* class of a row in `messages`:
 *
 *   - `direct`    — addressed to a single recipient (recipient = session name)
 *   - `broadcast` — addressed to everyone (recipient = '*')
 *   - `event`     — journal-only row, never delivered to any client
 *                   (recipient = '*' but delivery filter checks `kind` first)
 *
 * Channel fanout lives on the separate `delivery` column — see `Delivery`
 * below. The two axes are independent: a broadcast can be `push`
 * (channel-delivered) or `pull` (ambient inbox-only), and a direct message
 * defaults to `push`. `inbox.wait` actionability is a narrower type-level
 * contract (`request` / `query` / `assign` / `verdict`).
 */
export type MessageKind = "direct" | "broadcast" | "event"

/**
 * `Delivery` is the km-tribe.event-classification routing class:
 *
 *   - `push` — eligible for per-session channel admission + lands in inbox
 *   - `pull` — inbox only; the agent reads it when it asks
 *
 * Default for back-compat is `push` (existing call sites unchanged).
 */
export type Delivery = "push" | "pull"

/**
 * `ReplyHint` is the per-event hint the daemon derives at delivery time
 * from `(kind, recipient, senderRole)` — see `deriveReplyHint` below. It
 * is no longer persisted on the row (the column was dropped by migration
 * v11) and is no longer surfaced on the channel envelope. The type is
 * exported only because the broadcast pipeline still uses it as a return
 * shape. Focus admission uses the canonical actionable type set instead.
 *
 *   - `yes`      — direct DM from a peer member → reply via tribe.send
 *   - `optional` — broadcast / system / daemon push → agent decides
 *   - `no`       — ambient (event row) → silent read is correct
 */
export type ReplyHint = "yes" | "no" | "optional"

/**
 * Optional classification metadata for a message. All fields are optional —
 * pass nothing and the row defaults to push delivery.
 */
export type Classification = {
  delivery?: Delivery
  topic?: string
  roomId?: string
  /** Force this direct row into the durable attention projection. */
  attentionRequired?: boolean
  /** Persist an existing request id as correlation without opening another ball. */
  correlationRequest?: string
  /**
   * Authored one-line summary of the message (the LLM-generated one-liner shown
   * by default in the channel UI; the body discloses the full markdown). When a
   * sender omits it, the send boundary derives one via `deriveSummary` rather
   * than rejecting the message — see the derive-not-reject design call on
   * @ag/code/20113-visual-polish/llm-authored-tribe-summary-persistence.
   */
  summary?: string
  /** Client-generated durable identity; retries reuse the same row. */
  messageId?: string
}

export type SenderAttribution = {
  sender?: string
  senderRole?: string
}

/**
 * Derive a one-line summary from message content — the fallback when a sender
 * omits an authored `summary`. Takes the first non-empty line, collapses
 * whitespace, and truncates to `max` cols at a word boundary (mirrors the
 * channel UI's `clip()` so derived and authored one-liners read alike). Never
 * throws and never returns junk: an empty/whitespace-only body yields "".
 */
export function deriveSummary(content: string, max = 80): string {
  const firstLine =
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  const flat = firstLine.replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  const sliced = flat.slice(0, max - 1)
  const ws = sliced.lastIndexOf(" ")
  return `${ws > max - 12 ? sliced.slice(0, ws) : sliced}…`
}

/**
 * Ball-tracker fields — see @km/tribe/message-ball-tracker. Every typed direct
 * request/query/assign automatically open a recipient-owned request; verdict
 * remains wakeable but does not implicitly create a second obligation. An
 * explicit `request` tracks any direct type and overrides its id, while a
 * message with `reply` closes the referenced request. This lower-level writer
 * owns the invariant so plugin and adapter call sites cannot accidentally
 * create an acknowledged actionable with no durable response obligation.
 * `handleSend` resolves explicit multi-target lists and broadcast snapshots
 * into per-recipient pending rows.
 */
export type BallTracker = {
  /**
   * If set, this message OPENS a tracked request with this id. Convention:
   * the message id IS its own request id (the daemon stamps the message id
   * and copies it here). Recipient(s) own the ball until a send carries the
   * structured `reply` field (CLI: `--reply`).
   */
  request?: string | true
  /**
   * Semantic owner of the request. Defaults to the message recipient.
   * Delivery resolvers use this to make a fallback recipient own the original
   * request without changing its durable address or request id.
   */
  owner?: string
  /**
   * If set, this message CLOSES the request with the given id. The ball is
   * released from the recipient(s).
   */
  reply?: string
  /**
   * Multi-recipient ball-routing policy when this message opens a request.
   * - `'first'` (default): first recipient to reply closes the ball for all
   *   others (AMQP competing-consumers shape).
   * - `'all'`: every recipient owns their own ball; closed individually.
   * Ignored if `request` is not set.
   */
  fanout?: "first" | "all"
  /** Snapshot owners for one persisted broadcast request. Ownership rows are
   * committed with the broadcast before its publish callback can observe it. */
  owners?: readonly string[]
  /** Per-send escalation-deadline override. Tracked sends otherwise use their
   * class policy; deadline passage never settles ownership. */
  expiresInMs?: number
  /**
   * Ambient incident identity — habwire stage 2(d), "one ball per incident".
   *
   * A watcher that fires on every tick would otherwise mint one obligation per
   * OBSERVATION. Supplying an identity derives the tracked request id from
   * `emitter:subject:condition` instead of the message id, so repeated
   * observations of ONE live condition upsert into ONE ball: the open pile
   * becomes a projection of current conditions rather than a log of sightings.
   *
   * `active: false` is the clearing edge — the watcher reporting that the
   * condition no longer holds. It closes that ball with no operator verb.
   *
   * This adds no lifecycle owner: it is a new TRIGGER for the existing
   * `pending_request` open/close transitions, which remain the only place a
   * ball begins or ends.
   */
  incident?: IncidentIdentity & { active?: boolean }
}

export const DEFAULT_BALL_TTL_MS_BY_CLASS = {
  request: 20 * 60_000,
  query: 20 * 60_000,
} as const

export const MAX_BALL_TTL_MS = 24 * 60 * 60_000

export type PendingSettlementRow = {
  request_id: string
  recipient: string
  sender: string
  opened_at: number
  expires_at: number | null
  message_id: string
  fanout: "first" | "all"
  summary: string | null
}

/** Append a recoverable terminal outcome, then release exactly those owner
 * rows. The caller selects the rows and invokes this inside the same SQLite
 * transaction, so history and active ownership cannot disagree after a crash. */
export function settlePendingRows(
  ctx: TribeContext,
  rows: readonly PendingSettlementRow[],
  settlement: BallSettlementReason,
  settledBy: string,
  settledAt = Date.now(),
): number {
  for (const row of rows) {
    logEvent(
      ctx,
      "ball.settled",
      undefined,
      {
        schema_version: 1,
        request_id: row.request_id,
        recipient: row.recipient,
        sender: row.sender,
        opened_at: row.opened_at,
        expires_at: row.expires_at,
        message_id: row.message_id,
        fanout: row.fanout,
        summary: row.summary,
        settlement,
        settled_at: settledAt,
        settled_by: settledBy,
      },
      { sender: "daemon", ref: row.request_id, ts: settledAt },
    )
    ctx.stmts.closePendingRequest.run({ $request_id: row.request_id, $recipient: row.recipient })
  }
  return rows.length
}

/** Resolve the mechanism-owned deadline default. Explicitly tracked message
 *  types outside the implicit trio are requests by construction: the sender
 *  supplied `request` (or an incident identity) to open ownership. */
export function defaultBallTtlMs(type: string, tracked: boolean): number | undefined {
  if (!tracked) return undefined
  if (type === "assign") return undefined
  if (type === "query") return DEFAULT_BALL_TTL_MS_BY_CLASS.query
  return DEFAULT_BALL_TTL_MS_BY_CLASS.request
}

/**
 * Derive the channel-envelope reply hint from the durable message metadata.
 * Replaces the persisted column dropped by migration v11 — every consumer
 * that needs the hint computes it on demand.
 *
 *   - `event` rows are journal-only, never delivered → `'no'`
 *   - `'*'` recipient (broadcast) → `'optional'` regardless of sender
 *   - sender role of `daemon` / `system` (plugin emits) → `'optional'`
 *   - everything else (direct DM from a peer member) → `'yes'`
 */
export function deriveReplyHint(opts: { kind: MessageKind; recipient: string; senderRole: string }): ReplyHint {
  if (opts.kind === "event") return "no"
  if (opts.recipient === "*") return "optional"
  if (opts.senderRole === "daemon" || opts.senderRole === "system") return "optional"
  return "yes"
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Insert a message row and (optionally) fan out to connected sockets.
 *
 * The daemon wires its fan-out hook through `ctx.onMessageInserted` so that
 * handlers in this file don't need to know about sockets. Standalone callers
 * (tests, migrations) don't set the hook — the row still lands in SQLite,
 * which is the durability baseline.
 *
 * `rowid` is returned so the daemon can advance per-recipient
 * `sessions.last_delivered_seq` after a successful write().
 *
 * `kind` defaults to `direct` for backward compatibility. Broadcasts should
 * pass `broadcast`; journal-only events should pass `event` (and route via
 * `logEvent` which sets the type prefix).
 */
export function sendMessage(
  ctx: TribeContext,
  recipient: string,
  content: string,
  type = "notify",
  bead_id?: string,
  ref?: string,
  kind: MessageKind = "direct",
  classification: Classification = {},
  ballTracker: BallTracker = {},
  attribution: SenderAttribution = {},
): {
  id: string
  ts: number
  rowid: number
  tracker?: { request_id: string; closed: number }
  deduplicated?: boolean
} {
  const id = classification.messageId ?? randomUUID()
  const ts = Date.now()
  const sender = attribution.sender ?? ctx.getName()
  const senderRole = attribution.senderRole ?? ctx.getRole()
  // Default kind inference: '*' is a broadcast unless the caller explicitly
  // passed 'event'. This keeps existing call sites correct without audit.
  const resolvedKind: MessageKind = kind === "event" ? "event" : recipient === "*" ? "broadcast" : kind
  // Direct messages default to channel fanout. Events are journal-only and
  // never delivered, so delivery is irrelevant — keep the column populated for
  // schema invariants.
  const delivery: Delivery = classification.delivery ?? "push"
  // Selected direct types own a semantic response ball. The mailbox
  // cursor may acknowledge DELIVERY as soon as attention is projected; the
  // tracker survives that acknowledgement until the recipient explicitly
  // replies/defer-closes it. This is not a transport ACK and introduces no new
  // queue: it reuses the existing pending_request authority. Self-directed and
  // broadcast actionables remain untracked because neither has a peer owner.
  const autoTrackActionable = resolvedKind === "direct" && sender !== recipient && AUTO_TRACK_TYPES_SET.has(type)
  const explicitRequest = typeof ballTracker.request === "string" ? ballTracker.request.trim() : ballTracker.request
  if (typeof explicitRequest === "string" && explicitRequest.length === 0) {
    throw new Error("tracked request id must be non-empty")
  }
  // Stage 2(d): an incident identity replaces the message id as the tracked
  // request id, which is what turns repeated observations into one upserted
  // ball. Accepting both an identity and an explicit id would leave two
  // answers to "which obligation is this" — refuse rather than pick one.
  const incident = ballTracker.incident
  if (incident !== undefined && explicitRequest !== undefined && explicitRequest !== null) {
    throw new Error(
      "a tracked send may carry an incident identity or an explicit request id, not both: the incident identity IS the request id",
    )
  }
  // Built before the transaction so a malformed identity fails loud without
  // persisting a message whose obligation could not be keyed.
  const incidentRequestId = incident === undefined ? null : incidentKey(incident)
  const incidentActive = incident?.active ?? true
  const requestId =
    incidentRequestId !== null
      ? incidentActive
        ? incidentRequestId
        : null
      : explicitRequest === true
        ? id
        : (explicitRequest ?? (autoTrackActionable ? id : null))
  const correlationRequest = classification.correlationRequest?.trim()
  if (classification.correlationRequest !== undefined && !correlationRequest) {
    throw new Error("correlation request id must be non-empty")
  }
  const persistedRequest = correlationRequest ?? requestId
  const replyId = ballTracker.reply ?? null
  const expiresInMs = ballTracker.expiresInMs ?? defaultBallTtlMs(type, requestId !== null)
  if (
    requestId &&
    expiresInMs !== undefined &&
    (!Number.isSafeInteger(expiresInMs) || expiresInMs <= 0 || expiresInMs > MAX_BALL_TTL_MS)
  ) {
    throw new Error(`tracked request TTL must be a positive integer no greater than ${MAX_BALL_TTL_MS}ms`)
  }
  // Message persistence and semantic tracker ownership are one commit. A
  // crash/error may leave neither fact, never a delivered message whose
  // mandatory response ball failed to open. The fanout callback runs only
  // after this transaction commits.
  const persist = ctx.db.transaction(() => {
    const pendingReply =
      replyId && resolvedKind === "direct"
        ? (ctx.stmts.selectPendingForReplyRecipient.get({
            $reply_id: replyId,
            $recipient: sender,
          }) as { request_id: string; fanout: string; expires_at: number | null; sender: string } | null)
        : null
    const canonicalReplyId = pendingReply?.request_id ?? replyId
    const correlatedReply = pendingReply ? { requestId: pendingReply.request_id, requester: pendingReply.sender } : null
    let tracker = canonicalReplyId ? { request_id: canonicalReplyId, closed: 0 } : undefined
    const result = ctx.stmts.insertMessage.run({
      $id: id,
      $type: type,
      $sender: sender,
      $recipient: recipient,
      $kind: resolvedKind,
      $content: content,
      $bead_id: bead_id ?? null,
      $ref: ref ?? null,
      $ts: ts,
      $delivery: delivery,
      $topic: classification.topic ?? null,
      $room_id: classification.roomId ?? null,
      $request: persistedRequest,
      $reply: canonicalReplyId,
      $correlated_reply_requester: correlatedReply?.requester ?? null,
      $summary: classification.summary ?? null,
      $attention_required: classification.attentionRequired === true ? 1 : 0,
    })
    if (result.changes === 0) {
      const existing = ctx.stmts.selectMessageById.get({ $id: id }) as { rowid: number; ts: number } | undefined
      if (existing === undefined) throw new Error(`message idempotency row disappeared for ${id}`)
      return { rowid: existing.rowid, ts: existing.ts, deduplicated: true as const }
    }
    const rowid = Number(result.lastInsertRowid)
    // sendMessage knows one durable recipient string. Explicit broadcast
    // snapshots remain handleSend's responsibility; direct rows are complete
    // before this transaction returns.
    if (resolvedKind === "direct") {
      if (requestId) {
        ctx.stmts.openPendingRequest.run({
          $request_id: requestId,
          $recipient: ballTracker.owner ?? recipient,
          $sender: sender,
          $opened_at: ts,
          $expires_at: expiresInMs === undefined ? null : ts + expiresInMs,
          $message_id: id,
          $fanout: ballTracker.fanout ?? "first",
        })
      }
      // Stage 2(d) clearing edge: the watcher reports the condition no longer
      // holds, so the standing obligation ends without an operator verb. This
      // reuses the ordinary ball-close transition — an incident is closed the
      // same way a replied-to request is, so there is still exactly one place
      // a ball ends. `closePendingRequestAll` because the condition cleared
      // for every owner of that identity, not just one.
      if (incidentRequestId !== null && !incidentActive) {
        const rows = ctx.stmts.selectPendingSettlementsForRequest.all({
          $request_id: incidentRequestId,
        }) as PendingSettlementRow[]
        tracker = {
          request_id: incidentRequestId,
          closed: settlePendingRows(ctx, rows, "incident-cleared", sender, ts),
        }
      }
      // A daemon boundary settles expired rows before this send path runs.
      // Any still-open row is therefore closed by an explicit reply here.
      if (canonicalReplyId) {
        if (pendingReply?.fanout === "first") {
          const rows = ctx.stmts.selectPendingSettlementsForRequest.all({
            $request_id: canonicalReplyId,
          }) as PendingSettlementRow[]
          tracker = {
            request_id: canonicalReplyId,
            closed: settlePendingRows(ctx, rows, "answered", sender, ts),
          }
        } else {
          const row = ctx.stmts.selectPendingSettlementForRecipient.get({
            $request_id: canonicalReplyId,
            $recipient: sender,
          }) as PendingSettlementRow | null
          tracker = {
            request_id: canonicalReplyId,
            closed: settlePendingRows(ctx, row === null ? [] : [row], "answered", sender, ts),
          }
        }
      }
    }
    if (resolvedKind === "broadcast" && requestId) {
      for (const owner of ballTracker.owners ?? []) {
        ctx.stmts.openPendingRequest.run({
          $request_id: requestId,
          $recipient: owner,
          $sender: sender,
          $opened_at: ts,
          $expires_at: expiresInMs === undefined ? null : ts + expiresInMs,
          $message_id: id,
          $fanout: ballTracker.fanout ?? "first",
        })
      }
    }
    return { rowid, ts, tracker, correlatedReply }
  })
  const { rowid, ts: persistedTs, tracker, correlatedReply, deduplicated } = persist()
  if (deduplicated) return { id, ts: persistedTs, rowid, deduplicated: true }
  ctx.onMessageInserted?.({
    id,
    ts,
    rowid,
    type,
    kind: resolvedKind,
    sender,
    senderRole,
    recipient,
    content,
    bead_id: bead_id ?? null,
    delivery,
    topic: classification.topic ?? null,
    roomId: classification.roomId ?? null,
    correlatedReply,
  })
  return { id, ts: persistedTs, rowid, ...(tracker ? { tracker } : {}) }
}

/**
 * 19442 undead reframe — actionable-mailbox recovery.
 *
 * Push delivery is session-id-bound: a message addressed to name X is fanned
 * out to whichever live socket currently holds X. If X is unheld (the prior
 * holder disconnected) when an actionable direct lands, it journals but never
 * fans out — and the successor's register-time tail-reset would step over it.
 *
 * The OLD mechanism rewound the claiming session's `last_inbox_pull_seq` to
 * the oldest missed direct, which made the next default fetch replay every
 * intervening AMBIENT broadcast too (joins, health warns, git pushes — the
 * 97-row transcript flood). Count/age caps bounded the flood but preserved the
 * structural leak: journal-window guards are not a model-context admission
 * policy.
 *
 * The reframe: recovery never touches the ambient session cursor. A durable
 * `mailbox_cursors` row keyed by the RECIPIENT NAME tracks the highest
 * acknowledged durable-attention rowid; `handleFetch`'s default drain injects
 * unacknowledged actionables plus newly classified direct responses ahead of
 * the ambient window and acknowledges exactly what it returns.
 * Join/rename/takeover only need to COUNT the outstanding attention rows
 * (below) and nudge the client to drain.
 */
export function countUnackedAttention(ctx: TribeContext, recipient: string): number {
  const row = ctx.stmts.countUnackedAttention.get({ $name: recipient }) as { count: number } | undefined
  return row?.count ?? 0
}

/**
 * Log an event — a journal-only row that lands in `messages` but is never
 * delivered to any client. Rows are tagged with `kind='event'` and prefixed
 * type `event.<type>`, queryable via
 * `SELECT * FROM messages WHERE kind = 'event'`.
 *
 * Recipient is `'*'` so the row still participates in broadcast-style history
 * queries that join on recipient; the delivery-side filter
 * (`broadcastToConnected`) skips `kind='event'` rows before fanning out.
 */
export function logEvent(
  ctx: TribeContext,
  type: string,
  bead_id?: string,
  data?: Record<string, unknown>,
  options: { sender?: string; ref?: string; ts?: number } = {},
): string {
  const id = randomUUID()
  ctx.stmts.insertMessage.run({
    $id: id,
    $type: `event.${type}`,
    $sender: options.sender ?? ctx.getName(),
    $recipient: "*",
    $kind: "event",
    $content: data ? JSON.stringify(data) : "",
    $bead_id: bead_id ?? null,
    $ref: options.ref ?? null,
    $ts: options.ts ?? Date.now(),
    // Event rows are journal-only; the daemon's broadcastToConnected drops
    // kind='event' before delivery. The delivery column is still populated to
    // keep schema invariants — every row carries a delivery class.
    $delivery: "push",
    $topic: null,
    $room_id: null,
    // Event rows never participate in ball-tracking — they're journal-only,
    // not addressed to anyone in particular. Columns stay populated for
    // schema invariants.
    $request: null,
    $reply: null,
    $correlated_reply_requester: null,
    $summary: null,
    $attention_required: 0,
  })
  return id
}
