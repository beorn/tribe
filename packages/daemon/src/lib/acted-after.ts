/**
 * #30649, #38555: the one rule for "this seat already handled a row it was handed inline".
 *
 * A non-ball row the socket carried WITH its body (push delivery, at or below the seat's
 * `last_delivered_seq`) is handled once the same session acted strictly after the row: a later
 * non-event send, a later turn-start receipt, or a later turn-end receipt for the current launch
 * (#38555 slice 2, @cto ac37d401: a row handed inline before a turn ends was read in that turn,
 * which is how a no-reply verdict handled by text alone is retired). The health page's
 * busy-not-draining reading and the attention projection (inbox-status, default fetch,
 * inbox-wait, and so the Stop hook) all apply this one predicate, so they agree about a row.
 *
 * It is not a read receipt: a pull seat binds `$deliveredSeq = 0`, so nothing here fires for it,
 * and neither a ball-opening (directive) row nor a tracked row (`m.request` set, e.g. a verdict
 * sent with request tracking) ever matches, so an open request stays owed until settled.
 */
import type { Database } from "bun:sqlite"
import { BALL_OPENING_TYPES } from "tribe-wire/lib/wake-read-directive"

export const BALL_OPENING_TYPES_SQL = [...BALL_OPENING_TYPES].map((type) => `'${type}'`).join(", ")

/**
 * A direct row covered by a completed socket write to this seat: `last_delivered_seq`
 * is written after a successful `socket.write()`, in the rowid/seq space shared by
 * both journal halves (`with-broadcast.ts` `persistDeliveredCursor`). `delivery = 'push'`
 * keeps an inbox-only row out of it — that row was never fanned out, whatever a
 * later delivery raised the high-water mark to.
 */
export function deliveredInlineRowSql(sequence: string): string {
  return `m.${sequence} <= $deliveredSeq
      AND m.delivery = 'push'
      AND m.type NOT IN (${BALL_OPENING_TYPES_SQL})`
}

/**
 * Retired only when the row was delivered inline (push, never pull) AND a send or receipt from
 * the same session came strictly after it (@cto 8da79000). The journal keeps no per-row delivery
 * time, so the row's send time `m.ts`, never later than its delivery, stands in for it.
 * `$sessionStartedAt` keeps a restarted session's send from retiring a row the previous session
 * was handed. A tracked row (`m.request` names the ball it opened) is never retired here: its ball
 * stays owed until settled (#38555 slice 2, @cto ac37d401). The exclusion lives here, not in
 * `deliveredInlineRowSql`, so the health page's inline grace and cause split are unchanged.
 */
export function actedSinceDeliverySql(sequence: string): string {
  return `${deliveredInlineRowSql(sequence)}
      AND m.request IS NULL
      AND m.ts >= $sessionStartedAt
      AND m.ts < $actedAfter`
}

export type ActedAfterFacts = {
  /** Latest of the seat's newest non-event send, turn-start receipt and turn-end receipt; 0 = none observed. */
  actedAfter: number
  /** When the seat's current session registered; 0 = unknown, so no row is pre-session. */
  sessionStartedAt: number
  /** The seat's newest non-event send alone (the health page reports it); null = none. */
  lastNonEventSendAt: number | null
}

/** The seat's session row fields the rule reads. */
export type ActedAfterSession = {
  readonly started_at: number | null
  readonly delivery: string | null
  readonly last_delivered_seq: number | null
  readonly launch_id: string | null
  readonly launch_parent_pid: number | null
}

/** The bind parameters `actedSinceDeliverySql` names. */
export type ActedAfterBind = { $deliveredSeq: number; $actedAfter: number; $sessionStartedAt: number }

type Statements = {
  session: ReturnType<Database["prepare"]>
  lastNonEventSend: ReturnType<Database["prepare"]>
  lastTurnStart: ReturnType<Database["prepare"]>
  lastTurnEnd: ReturnType<Database["prepare"]>
}
const statements = new WeakMap<Database, Statements>()

function prepared(db: Database): Statements {
  let found = statements.get(db)
  if (found === undefined) {
    found = {
      session: db.prepare(`
        SELECT started_at, delivery, last_delivered_seq, launch_id, launch_parent_pid
        FROM sessions WHERE name = $session ORDER BY updated_at DESC LIMIT 1
      `),
      lastNonEventSend: db.prepare(`
        SELECT ts FROM messages WHERE sender = $session AND kind != 'event' ORDER BY ts DESC LIMIT 1
      `),
      // `session` holds the seat NAME (the dispatcher writes `client.name`), and the UNIQUE launch
      // key leads the index, so this is a seek per seat rather than a scan per row.
      lastTurnStart: db.prepare(`
        SELECT MAX(received_at) AS ts FROM turn_start_receipts
        WHERE session = $session AND launch_id = $launchId AND launch_parent_pid = $launchParentPid
      `),
      // One row per launch (primary key), written by cli_turn_end_receipt_by_launch_v1.
      lastTurnEnd: db.prepare(`
        SELECT received_at AS ts FROM turn_end_receipts
        WHERE launch_id = $launchId AND launch_parent_pid = $launchParentPid AND session = $session
      `),
    }
    statements.set(db, found)
  }
  return found
}

/** When the seat last acted (send, turn start or turn end) and when its session began. */
export function readActedAfterFacts(db: Database, session: string, row?: ActedAfterSession | null): ActedAfterFacts {
  const stmts = prepared(db)
  const cursor = row === undefined ? (stmts.session.get({ $session: session }) as ActedAfterSession | null) : row
  const lastNonEventSend = stmts.lastNonEventSend.get({ $session: session }) as { ts: number } | null
  const launch =
    cursor?.launch_id != null && cursor.launch_parent_pid != null
      ? { $session: session, $launchId: cursor.launch_id, $launchParentPid: cursor.launch_parent_pid }
      : null
  const lastTurnStart = launch === null ? null : (stmts.lastTurnStart.get(launch) as { ts: number | null } | null)
  const lastTurnEnd = launch === null ? null : (stmts.lastTurnEnd.get(launch) as { ts: number } | null)
  return {
    actedAfter: Math.max(lastNonEventSend?.ts ?? 0, lastTurnStart?.ts ?? 0, lastTurnEnd?.ts ?? 0),
    sessionStartedAt: cursor?.started_at ?? 0,
    lastNonEventSendAt: lastNonEventSend?.ts ?? null,
  }
}

/** The full bind for one seat: only an acknowledged push seat can have been handed a body. */
export function readActedAfterBind(db: Database, session: string): ActedAfterBind {
  const row = prepared(db).session.get({ $session: session }) as ActedAfterSession | null
  const facts = readActedAfterFacts(db, session, row)
  return {
    $deliveredSeq: row?.delivery === "push" ? (row.last_delivered_seq ?? 0) : 0,
    $actedAfter: facts.actedAfter,
    $sessionStartedAt: facts.sessionStartedAt,
  }
}
