/**
 * Tribe context — shared state passed to all functions instead of module globals.
 */

import type { Database } from "bun:sqlite"
import { CORRELATED_REPLY_TYPES_SET, type TribeStatements } from "./database.ts"
import type { TribeRole } from "tribe-wire/lib/config"
import type { Delivery, MessageKind } from "./messaging.ts"

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Message-inserted hook — invoked synchronously inside `sendMessage` after
 * the row is committed. The daemon installs this to fan out to every
 * currently-connected socket whose name matches the recipient (or any name
 * for `recipient = "*"`). Absent (undefined) for standalone callers like
 * tests, which only need the durable row.
 */
export type MessageInsertedInfo = {
  id: string
  ts: number
  rowid: number
  type: string
  /** Transport class — `direct` / `broadcast` / `event`. `event` rows are
   *  journal-only and must NOT be delivered to any client. */
  kind: MessageKind
  sender: string
  /** Sender's TribeRole (`chief` / `member` / `watch` / `daemon` / `system` /
   *  `pending`) — used by the broadcast pipeline to derive the channel-envelope
   *  reply hint. Replaces the persisted responseExpected column dropped in v11. */
  senderRole: string
  recipient: string
  content: string
  bead_id: string | null
  /** km-tribe.event-classification routing — `push` lands on the MCP channel,
   *  `pull` is queued for `tribe.fetch`. */
  delivery: Delivery
  /** Originating plugin event id (e.g. `git:commit`); null for human messages. */
  topic: string | null
  /** Matrix-shape room scope; null until populated by the room-aware path. */
  roomId: string | null
  /** 25662 P3 3 — this row is an incident edge (its open, or a changed condition) and wakes its owner's inbox-wait
   *  like an actionable type. Mirrors the row's durable `wakes_owner` column. */
  wakesOwner?: boolean
  /** Mailboxes that received an open pending row for this tracked broadcast.
   * Absent for direct, untracked broadcast, and journal-only messages. */
  pendingOwners?: readonly string[]
  /** Canonical tracked-request correlation, present only when this message
   *  closed a still-open reply target owned by `requester`. */
  correlatedReply: { requestId: string; requester: string } | null
}

/** True when this message settles a tracked request that `session` opened. The
 *  one answer to "is this the reply I asked for?", shared by inbox.wait's opt-in
 *  wake and focus-mode push. */
export function settlesRequestOpenedBy(
  info: Pick<MessageInsertedInfo, "type" | "correlatedReply">,
  session: string,
): boolean {
  return CORRELATED_REPLY_TYPES_SET.has(info.type) && info.correlatedReply?.requester === session
}

export type TribeContext = {
  db: Database
  stmts: TribeStatements
  sessionId: string
  sessionRole: TribeRole
  domains: string[]
  claudeSessionId: string | null
  claudeSessionName: string | null
  getName(): string
  setName(name: string): void
  getRole(): TribeRole
  setRole(role: TribeRole): void
  onMessageInserted?: (info: MessageInsertedInfo) => void
}

export function createTribeContext(opts: {
  db: Database
  stmts: TribeStatements
  sessionId: string
  sessionRole: TribeRole
  initialName: string
  domains: string[]
  claudeSessionId: string | null
  claudeSessionName: string | null
  onMessageInserted?: (info: MessageInsertedInfo) => void
}): TribeContext {
  let currentName = opts.initialName
  let currentRole = opts.sessionRole
  return {
    db: opts.db,
    stmts: opts.stmts,
    sessionId: opts.sessionId,
    get sessionRole() {
      return currentRole
    },
    set sessionRole(r: TribeRole) {
      currentRole = r
    },
    domains: opts.domains,
    claudeSessionId: opts.claudeSessionId,
    claudeSessionName: opts.claudeSessionName,
    getName: () => currentName,
    setName: (n: string) => {
      currentName = n
    },
    getRole: () => currentRole,
    setRole: (r: TribeRole) => {
      currentRole = r
    },
    onMessageInserted: opts.onMessageInserted,
  }
}
