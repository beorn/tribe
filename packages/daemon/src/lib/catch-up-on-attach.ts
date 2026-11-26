/**
 * #38676 residual: a wake inserted while a seat had no push transport.
 *
 * The #38676 fix (bdc1bd62) keeps a wake whose socket write FAILED and retries it. It cannot see a
 * row inserted while the session had no push transport at all: `toConnected` walks connected clients,
 * `canFanout` is false for every one of them, nothing is queued, and nothing retries — the row is
 * durable and correct, and the seat is never told it exists until it fetches for an unrelated reason.
 * Side effect of the same blind spot: `sessions.last_delivered_seq` stays behind, so fleet health
 * calls the row "never written to its socket" for as long as it sits there.
 *
 * This module answers one question for the attach path: which rows has this seat never been told
 * about, and does its filter want to hear about them. Writing the wakeup is the caller's job, because
 * it owns the coalescer and the cursor.
 *
 * Two deliberate limits, both named rather than implied:
 *   - Only the live `messages` table is read. A row old enough to have been archived had its moment
 *     to be delivered; waking a seat about a months-old row would be noise, and the archive's seq
 *     space is not the delivery cursor's.
 *   - The wakeup names the NEWEST undelivered row. One wakeup is what the wire is for (it tells the
 *     client to fetch `latest_seq`), and advancing the cursor to that row is what retires the older
 *     ones — the same accounting a batched fanout already does.
 */
import type { Database } from "bun:sqlite"

import { ACTIONABLE_TYPES_SET } from "./database.ts"
import type { MessageKind } from "./messaging.ts"

/** The durable shape of one undelivered row, as the wake path needs it. */
export type CatchUpRow = {
  readonly rowid: number
  readonly id: string
  readonly ts: number
  readonly type: string
  readonly kind: MessageKind
  readonly sender: string
  readonly topic: string | null
  readonly isIncident: boolean
  readonly wakesOwner: boolean
  readonly attentionRequired: boolean
  /** The row settles a request this seat opened — the one non-actionable type a focus filter wakes for. */
  readonly settlesOwnRequest: boolean
}

export type CatchUpReading = {
  /** Every undelivered push row for this seat, not only the ones the newest-row cap reaches. */
  readonly rows: number
  /** The newest undelivered row, or null when the seat is up to date. */
  readonly newest: CatchUpRow | null
  /**
   * Any undelivered row an actionable filter wakes for: an actionable type, or an incident edge that
   * wakes its owner. False leaves the decision to the seat's own `shouldDeliver` reading of `newest`.
   */
  readonly anyActionable: boolean
}

const NOTHING: CatchUpReading = { rows: 0, newest: null, anyActionable: false }

const ACTIONABLE_TYPES_SQL = [...ACTIONABLE_TYPES_SET].map((type) => `'${type}'`).join(", ")

type Statements = {
  sessionDelivery: ReturnType<Database["prepare"]>
  summary: ReturnType<Database["prepare"]>
  newest: ReturnType<Database["prepare"]>
}

const statements = new WeakMap<Database, Statements>()

function prepared(db: Database): Statements {
  let found = statements.get(db)
  if (found === undefined) {
    const undelivered = `
      FROM messages
      WHERE delivery = 'push'
        AND kind <> 'event'
        AND rowid > $cursor
        AND (recipient = $name OR recipient = '*')
        AND sender <> $name`
    found = {
      sessionDelivery: db.prepare(`
        SELECT delivery, last_delivered_seq FROM sessions WHERE id = $id ORDER BY updated_at DESC LIMIT 1
      `),
      summary: db.prepare(`
        SELECT COUNT(*) AS rows,
               COALESCE(MAX(rowid), 0) AS newest_rowid,
               COALESCE(MAX(ts), 0) AS newest_ts,
               COALESCE(MAX(CASE WHEN wakes_owner = 1 OR type IN (${ACTIONABLE_TYPES_SQL}) OR (kind = 'broadcast' AND attention_required = 1) THEN 1 ELSE 0 END), 0)
                 AS any_actionable
        ${undelivered}
      `),
      newest: db.prepare(`
        SELECT rowid, id, ts, type, kind, sender, topic, is_incident, wakes_owner, attention_required,
               (correlated_reply_requester = $name) AS settles_own
        ${undelivered}
        ORDER BY rowid DESC
        LIMIT 1
      `),
    }
    statements.set(db, found)
  }
  return found
}

/**
 * What this seat has never been told about, over the live journal.
 *
 * `sessionId` is the durable `sessions.id` that carries `last_delivered_seq`; `name` is the seat name
 * rows are addressed to. Both are passed because the wire addresses seats by name and the cursor lives
 * on the session row.
 */
export function readCatchUp(db: Database, sessionId: string, name: string): CatchUpReading {
  const stmts = prepared(db)
  const session = stmts.sessionDelivery.get({ $id: sessionId }) as {
    delivery: string | null
    last_delivered_seq: number | null
  } | null
  // A pull seat drains by fetch; its rows are never fanned out by design, so there is nothing to catch up.
  if (session === null || session.delivery === "pull") return NOTHING
  const cursor = session.last_delivered_seq ?? 0
  const bind = { $cursor: cursor, $name: name }
  const summary = stmts.summary.get(bind) as {
    rows: number
    newest_rowid: number
    newest_ts: number
    any_actionable: number
  } | null
  if (summary === null || summary.rows <= 0) return NOTHING
  const row = stmts.newest.get(bind) as {
    rowid: number
    id: string
    ts: number
    type: string
    kind: string
    sender: string
    topic: string | null
    is_incident: number
    wakes_owner: number
    attention_required: number
    settles_own: number
  } | null
  if (row === null) return { rows: 0, newest: null, anyActionable: false }
  return {
    rows: summary.rows,
    anyActionable: summary.any_actionable === 1,
    newest: {
      rowid: row.rowid,
      id: row.id,
      ts: row.ts,
      type: row.type,
      kind: row.kind as MessageKind,
      sender: row.sender,
      topic: row.topic,
      isIncident: row.is_incident === 1,
      wakesOwner: row.wakes_owner === 1,
      attentionRequired: row.attention_required === 1,
      settlesOwnRequest: row.settles_own === 1,
    },
  }
}
