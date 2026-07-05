/**
 * Session inbox drain, addressed by name — the atomic "pull everything unread
 * and advance the cursor" primitive behind wait-and-drain `tribe.inbox.wait`
 * (one-call idle loop, 20843 S1) and the `tribe fetch` timeout-0 alias (S2).
 *
 * This is the same default-drain contract as the MCP `tribe.fetch` cursor
 * path (recipient = session or '*', own sends excluded, journal events
 * excluded, trust-topic filtered, cursor advanced to the last returned row),
 * but keyed by session NAME so one-shot CLI callers and the daemon dispatcher
 * can drain a seat's inbox without holding that seat's connection.
 */

import { randomUUID } from "node:crypto"
import type { Database } from "bun:sqlite"
import type { TribeStatements } from "./database.ts"
import { senderMayUseRegisteredTrustTopic, type SessionRoster } from "./trust.ts"

export type InboxDrainEvent = {
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

export type InboxDrainResult = {
  events: InboxDrainEvent[]
  cursor: number
}

type DrainRow = {
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

/** Drain cap — mirrors the `tribe.fetch` hard limit so one return cannot be
 *  unbounded; leftover rows surface on the immediate next call. */
const DRAIN_LIMIT = 500

function resolveSessionRow(
  db: Database,
  stmts: TribeStatements,
  sessionName: string,
): { id: string; last_inbox_pull_seq: number } {
  const row = stmts.getSessionByName.get({ $name: sessionName }) as {
    id: string
    last_inbox_pull_seq: number
  } | null
  if (row) return row

  // Unknown name: create an at-tail session row (the tribe.repair precedent)
  // instead of failing or replaying the whole broadcast journal from seq 0.
  // Rows addressed to this name from now on are drainable; history stays
  // history. This keeps `inbox-wait --session X` arm-before-join safe.
  const now = Date.now()
  const id = `drain-${randomUUID()}`
  stmts.upsertSession.run({
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
    $now: now,
    $delivery: "pull",
    $account: null,
    $provider: null,
  })
  const tail = (stmts.getMessageTailSeq.get() as { seq: number } | null)?.seq ?? 0
  stmts.advanceInboxCursor.run({ $id: id, $seq: tail, $now: now })
  return { id, last_inbox_pull_seq: tail }
}

/**
 * Ensure a drainable session row exists for `sessionName` — called at wait
 * ARM time. Without this, a wait armed on a never-joined name would create
 * the session at DRAIN time with an at-tail cursor, silently skipping the
 * very row that woke the wait (create-at-tail would sit past it).
 */
export function ensureDrainableSession(db: Database, stmts: TribeStatements, sessionName: string): void {
  resolveSessionRow(db, stmts, sessionName)
}

/**
 * Pull all unread rows for `sessionName` and advance its pull cursor to the
 * last returned row. Synchronous and single-statement-serialized, so a return
 * consumes each row exactly once even under concurrent waiters — the second
 * drain simply sees an advanced cursor and returns fewer (or zero) rows.
 */
export function drainInboxByName(db: Database, stmts: TribeStatements, sessionName: string): InboxDrainResult {
  const session = resolveSessionRow(db, stmts, sessionName)
  const rows = stmts.getInboxRows.all({
    $since: session.last_inbox_pull_seq,
    $name: sessionName,
    $limit: DRAIN_LIMIT,
  }) as DrainRow[]

  const last = rows.at(-1)
  const cursor = last ? Math.max(session.last_inbox_pull_seq, last.rowid) : session.last_inbox_pull_seq
  if (last) {
    stmts.advanceInboxCursor.run({ $id: session.id, $seq: cursor, $now: Date.now() })
  }

  // Trust filter mirrors tribe.fetch: rows failing the registered-trust-topic
  // check are consumed (cursor moved past) but not delivered.
  const roster = db.prepare("SELECT name, role FROM sessions").all() as SessionRoster
  const visible = rows.filter((r) => senderMayUseRegisteredTrustTopic(r.topic, r.sender, roster))

  return {
    cursor,
    events: visible.map((r) => ({
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
    })),
  }
}
