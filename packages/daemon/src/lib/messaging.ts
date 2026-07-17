/**
 * Tribe messaging — send messages and log events.
 */

import { randomUUID } from "node:crypto"
import type { TribeContext } from "./context.ts"
import { AUTO_TRACK_TYPES_SET } from "./database.ts"

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
 * contract (`request` / `query` / `assign` / `verdict` / `ball:reminder`).
 */
export type MessageKind = "direct" | "broadcast" | "event"

/**
 * `Delivery` is the km-tribe.event-classification routing class:
 *
 *   - `push` — actionable: fanned out down the MCP channel + lands in inbox
 *   - `pull` — ambient: lands in inbox only; the agent reads it when it asks
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
 * shape (and `tribe.filter` mode `focus` still gates on it).
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
  /**
   * Authored one-line summary of the message (the LLM-generated one-liner shown
   * by default in the channel UI; the body discloses the full markdown). When a
   * sender omits it, the send boundary derives one via `deriveSummary` rather
   * than rejecting the message — see the derive-not-reject design call on
   * @ag/code/20113-visual-polish/llm-authored-tribe-summary-persistence.
   */
  summary?: string
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
   * and copies it here). Recipient(s) own the ball until a message with
   * `reply=<id>` arrives.
   */
  request?: string | true
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
  /** Time from message commit until escalation. Defaults to 10 minutes for
   * newly tracked balls; legacy rows remain unbounded with NULL expires_at. */
  expiresInMs?: number
}

export const DEFAULT_BALL_TTL_MS = 10 * 60_000
export const MAX_BALL_TTL_MS = 24 * 60 * 60_000

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
): { id: string; ts: number; rowid: number; tracker?: { request_id: string; closed: number } } {
  const id = randomUUID()
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
  const requestId = explicitRequest === true ? id : (explicitRequest ?? (autoTrackActionable ? id : null))
  const replyId = ballTracker.reply ?? null
  const expiresInMs = ballTracker.expiresInMs ?? DEFAULT_BALL_TTL_MS
  if (requestId && (!Number.isSafeInteger(expiresInMs) || expiresInMs <= 0 || expiresInMs > MAX_BALL_TTL_MS)) {
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
          }) as { request_id: string; fanout: string; expires_at: number | null } | null)
        : null
    const canonicalReplyId = pendingReply?.request_id ?? replyId
    const pendingReplyExpiresAt = pendingReply?.expires_at
    const pendingReplyExpired =
      pendingReplyExpiresAt !== null && pendingReplyExpiresAt !== undefined && pendingReplyExpiresAt <= ts
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
      $request: requestId,
      $reply: canonicalReplyId,
      $summary: classification.summary ?? null,
    })
    const rowid = Number(result.lastInsertRowid)
    // sendMessage knows one durable recipient string. Explicit broadcast
    // snapshots remain handleSend's responsibility; direct rows are complete
    // before this transaction returns.
    if (resolvedKind === "direct") {
      if (requestId) {
        ctx.stmts.openPendingRequest.run({
          $request_id: requestId,
          $recipient: recipient,
          $sender: sender,
          $opened_at: ts,
          $expires_at: ts + expiresInMs,
          $message_id: id,
          $fanout: ballTracker.fanout ?? "first",
        })
      }
      // A reply/defer is an answer only while the SLA lease is active. Once
      // expires_at is reached, preserve the row for the deadline sweep so the
      // typed ball:expired exception and configured escalation cannot be
      // silently erased in the cadence gap. The late reply is still journaled.
      if (canonicalReplyId && !pendingReplyExpired) {
        if (pendingReply?.fanout === "first") {
          const closed = ctx.stmts.closePendingRequestAll.run({ $request_id: canonicalReplyId })
          tracker = { request_id: canonicalReplyId, closed: closed.changes ?? 0 }
        } else {
          const closed = ctx.stmts.closePendingRequest.run({
            $request_id: canonicalReplyId,
            $recipient: sender,
          })
          tracker = { request_id: canonicalReplyId, closed: closed.changes ?? 0 }
        }
      }
    }
    return { rowid, tracker }
  })
  const { rowid, tracker } = persist()
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
  })
  return { id, ts, rowid, ...(tracker ? { tracker } : {}) }
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
 * acknowledged actionable rowid; `handleFetch`'s default drain injects the
 * unacknowledged actionable directs (request / query / verdict / assign /
 * ball:reminder —
 * `ACTIONABLE_TYPES` in database.ts) ahead of the ambient window and
 * acknowledges exactly what it returns. Join/rename/takeover only need to
 * COUNT the outstanding actionables (below) and nudge the client to drain.
 */
export function countUnackedActionables(ctx: TribeContext, recipient: string): number {
  const row = ctx.stmts.countUnackedActionables.get({ $name: recipient }) as { count: number } | undefined
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
export function logEvent(ctx: TribeContext, type: string, bead_id?: string, data?: Record<string, unknown>): void {
  ctx.stmts.insertMessage.run({
    $id: randomUUID(),
    $type: `event.${type}`,
    $sender: ctx.getName(),
    $recipient: "*",
    $kind: "event",
    $content: data ? JSON.stringify(data) : "",
    $bead_id: bead_id ?? null,
    $ref: null,
    $ts: Date.now(),
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
  })
}
