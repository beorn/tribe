/**
 * @failure The health projection's database half scans the whole journal again:
 *          the 7d growth window walks messages_archive by archived_at, the
 *          per-session last-message probe re-sorts each sender's rows into a
 *          TEMP B-TREE, and the inbox-lag "oldest actionable" probe walks the
 *          archive from its cursor because no index leads with `recipient`.
 *          tribe.health then blocks the single-threaded daemon past the wire
 *          client's 10 s deadline, which is how the 19:00 restart stalled every
 *          caller for ~7 minutes.
 * @level l2
 * @consumer tribe.health / cli_health, via projectHealthCadence().
 * @testonly none: every symbol this test imports (openDatabase and the
 *           attention-predicate helpers) is production code that
 *           projectHealthCadence / inboxLagProjection also use; the test reads
 *           query plans, it does not reach into a test-only seam.
 *
 * 27882 (@chief filing 2026-10-07) — measured on a copy of the live 893 MB
 * store: ONE cli_health call read ~1.65 GB with zero connected sessions and
 * ~4.1 GB with 18 live sessions; the fleet's polling turned that into the
 * ~800 MB/s the 19:00 stall was measured at. Three indexes make each query
 * O(the answer it reports): idx_messages_archive_archived_at,
 * idx_messages_sender_ts, and the partial idx_messages_archive_attention.
 *
 * Asserted as query PLANS, not byte counts: the byte cost depends on which rows
 * exist, while the plan says whether the access path can be linear at all.
 * The archive attention statement is built here from the same exported
 * predicate helpers inboxLagProjection uses, so the two cannot drift on the
 * WHERE clause that decides whether the partial index is legal to use.
 */

import { assertSingleStatement } from "@bearly/sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Database } from "bun:sqlite"

import {
  ATTENTION_PREDICATE_SQL,
  createStatements,
  noOpenIncidentAttentionPredicateSql,
  openDatabase,
  unretiredAttentionPredicateSql,
} from "./database.ts"

/** A seat with no mail is the shape that paid the whole-archive walk. */
const SEAT = "@seat-with-no-mail"
const NOW = 1_800_000_000_000

// Frozen pre-29521 grouped query: the correlated replacement must retain
// tracked, archived, retired and cursor semantics independently of its builder.
const OLD_FLEET_UNREAD_SQL = `
      SELECT recipient, COUNT(*) AS count
      FROM (
        SELECT m.recipient, m.id
        FROM messages AS m
        WHERE m.recipient != '*'
          AND m.kind = 'direct'
          AND m.sender != m.recipient
          AND (type IN ('request', 'query', 'verdict', 'assign') OR attention_required = 1)
          AND m.is_incident = 0
          AND NOT EXISTS (
    SELECT 1
    FROM messages AS reply_message
    WHERE reply_message.kind = 'direct'
      AND reply_message.sender = m.recipient
      AND reply_message.recipient = m.sender
      AND reply_message.rowid > m.rowid
      AND reply_message.reply = COALESCE(m.request, m.id)
  )
    AND NOT EXISTS (
    SELECT 1
    FROM messages AS taking_request_message
    WHERE taking_request_message.kind = 'direct'
      AND taking_request_message.type = 'status'
      AND taking_request_message.sender = m.recipient
      AND taking_request_message.recipient = m.sender
      AND taking_request_message.ref IS NOT NULL
      AND taking_request_message.ref = m.request
      AND taking_request_message.rowid > m.rowid
  )
    AND NOT EXISTS (
    SELECT 1
    FROM messages AS taking_message_message
    WHERE taking_message_message.kind = 'direct'
      AND taking_message_message.type = 'status'
      AND taking_message_message.sender = m.recipient
      AND taking_message_message.recipient = m.sender
      AND taking_message_message.ref IS NOT NULL
      AND taking_message_message.ref = m.id
      AND taking_message_message.rowid > m.rowid
  )
          AND m.rowid > COALESCE(
            (SELECT last_actionable_seq FROM mailbox_cursors WHERE recipient = m.recipient),
            0
          )
        UNION
        SELECT p.recipient, COALESCE(m.id, a.id) AS id
        FROM pending_request AS p INDEXED BY idx_pending_recipient
  LEFT JOIN messages AS m ON m.id = p.message_id
  LEFT JOIN messages_archive AS a ON a.id = p.message_id
        WHERE p.recipient = p.recipient
    AND p.request_kind != 'incident'
    AND COALESCE(m.kind, a.kind) IN ('direct', 'broadcast')
    AND NOT EXISTS (
    SELECT 1
    FROM messages AS taking_request_message
    WHERE taking_request_message.kind = 'direct'
      AND taking_request_message.type = 'status'
      AND taking_request_message.sender = p.recipient
      AND taking_request_message.recipient = p.sender
      AND taking_request_message.ref IS NOT NULL
      AND taking_request_message.ref = p.request_id
      AND taking_request_message.rowid > COALESCE(m.rowid, a.seq)
  )
    AND NOT EXISTS (
    SELECT 1
    FROM messages AS taking_message_message
    WHERE taking_message_message.kind = 'direct'
      AND taking_message_message.type = 'status'
      AND taking_message_message.sender = p.recipient
      AND taking_message_message.recipient = p.sender
      AND taking_message_message.ref IS NOT NULL
      AND taking_message_message.ref = p.message_id
      AND taking_message_message.rowid > COALESCE(m.rowid, a.seq)
  )
    AND NOT EXISTS (
    SELECT 1
    FROM messages_archive AS taking_request_archived
    WHERE taking_request_archived.kind = 'direct'
      AND taking_request_archived.type = 'status'
      AND taking_request_archived.sender = p.recipient
      AND taking_request_archived.recipient = p.sender
      AND taking_request_archived.ref IS NOT NULL
      AND taking_request_archived.ref = p.request_id
      AND taking_request_archived.seq > COALESCE(m.rowid, a.seq)
  )
    AND NOT EXISTS (
    SELECT 1
    FROM messages_archive AS taking_message_archived
    WHERE taking_message_archived.kind = 'direct'
      AND taking_message_archived.type = 'status'
      AND taking_message_archived.sender = p.recipient
      AND taking_message_archived.recipient = p.sender
      AND taking_message_archived.ref IS NOT NULL
      AND taking_message_archived.ref = p.message_id
      AND taking_message_archived.seq > COALESCE(m.rowid, a.seq)
  )
    AND (COALESCE(m.type, a.type) != 'response'
    OR COALESCE(m.rowid, a.seq) > COALESCE(
      (SELECT last_actionable_seq FROM mailbox_cursors WHERE recipient = p.recipient), 0))
          AND COALESCE(m.sender, a.sender) != p.recipient
          AND (COALESCE(m.type, a.type) IN ('request', 'query', 'verdict', 'assign')
  OR COALESCE(m.attention_required, a.attention_required) = 1)
      )
      GROUP BY recipient
    `

type Fixture = { db: Database; dir: string }
const open: Fixture[] = []

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tribe-health-indexes-"))
  const db = openDatabase(join(dir, "tribe.db"))
  // A couple of rows so the planner has a table to choose against; the plan
  // does not depend on how many (there is no ANALYZE in the fixture).
  const insert = db.prepare(
    assertSingleStatement(
      `INSERT INTO messages_archive
         (seq, id, type, sender, recipient, content, ts, archived_at, summary)
       VALUES ($seq, $id, 'request', 'daemon', $recipient, 'body', $ts, $ts, 's')`,
    ),
  )
  for (let i = 0; i < 20; i++) {
    insert.run({ $seq: i + 1, $id: "a" + i, $recipient: i % 2 === 0 ? SEAT : "@other", $ts: NOW - i * 1_000 })
  }
  const entry = { db, dir }
  open.push(entry)
  return entry
}

function plan(db: Database, sql: string, params: Record<string, string | number> = {}): string {
  return (db.prepare(assertSingleStatement(`EXPLAIN QUERY PLAN ${sql}`)).all(params) as Array<{ detail: string }>)
    .map((row) => row.detail)
    .join("\n")
}

afterEach(() => {
  for (const entry of open.splice(0)) {
    entry.db.close()
    rmSync(entry.dir, { recursive: true, force: true })
  }
})

describe("health projection reads the archive through an index", () => {
  it("keeps fleet unread equal to the old grouped query across mailbox and tracked attention", () => {
    const { db } = fixture()
    const stmts = createStatements(db)
    db.exec(
      assertSingleStatement(`
      INSERT INTO messages (rowid, id, type, sender, recipient, content, ts, kind, request, reply, ref, attention_required, is_incident) VALUES
        (101, 'tracked', 'request', 'caller', 'alpha', 'body', 100, 'direct', 'ball', NULL, NULL, 0, 0),
        (102, 'untracked', 'query', 'caller', 'beta', 'body', 200, 'direct', NULL, NULL, NULL, 0, 0),
        (103, 'broadcast', 'request', 'caller', '*', 'body', 300, 'broadcast', 'broadcast-ball', NULL, NULL, 0, 0),
        (104, 'retired', 'query', 'caller', 'delta', 'body', 400, 'direct', NULL, NULL, NULL, 0, 0),
        (105, 'reply', 'response', 'delta', 'caller', 'body', 500, 'direct', NULL, 'retired', NULL, 0, 0),
        (106, 'taken', 'request', 'caller', 'epsilon', 'body', 600, 'direct', 'taken-ball', NULL, NULL, 0, 0),
        (107, 'taking', 'status', 'epsilon', 'caller', 'body', 700, 'direct', NULL, NULL, 'taken-ball', 0, 0),
        (108, 'response', 'response', 'caller', 'response-owner', 'body', 800, 'direct', 'response-ball', NULL, NULL, 1, 0),
        (109, 'incident', 'request', 'caller', 'incident-owner', 'body', 900, 'direct', 'incident-ball', NULL, NULL, 1, 1),
        (110, 'self', 'query', 'self-owner', 'self-owner', 'body', 1000, 'direct', NULL, NULL, NULL, 0, 0)
    `),
    )
    db.exec(
      assertSingleStatement(`
      INSERT INTO messages_archive (seq, id, type, sender, recipient, content, ts, archived_at, kind, request) VALUES
        (21, 'archived', 'request', 'caller', 'archive-owner', 'body', 50, 90, 'direct', 'archive-ball')
    `),
    )
    db.exec(
      assertSingleStatement(`
      INSERT INTO pending_request (request_id, recipient, sender, opened_at, expires_at, message_id, fanout, request_kind) VALUES
        ('ball', 'alpha', 'caller', 100, 10000, 'tracked', 'first', 'request'),
        ('broadcast-ball', 'gamma', 'caller', 300, 10000, 'broadcast', 'all', 'request'),
        ('archive-ball', 'archive-owner', 'caller', 50, 10000, 'archived', 'first', 'request'),
        ('taken-ball', 'epsilon', 'caller', 600, 10000, 'taken', 'first', 'request'),
        ('response-ball', 'response-owner', 'caller', 800, 10000, 'response', 'first', 'request'),
        ('incident-ball', 'incident-owner', 'caller', 900, 10000, 'incident', 'first', 'incident')
    `),
    )
    db.exec(
      assertSingleStatement(`
      INSERT INTO mailbox_cursors (recipient, last_actionable_seq, updated_at) VALUES
        ('alpha', 1000, 1000), ('beta', 1000, 1000), ('response-owner', 1000, 1000)
    `),
    )
    const actual = stmts.getAllUnreadDms.all() as Array<{ recipient: string; count: number }>
    // #29521: listing recipients must read only the covering index, not each
    // direct message's payload. The result oracle alone cannot detect this cost.
    const fleetPlan = plan(db, stmts.getAllUnreadDms.toString())
    expect(fleetPlan).toMatch(/\b(?:SCAN|SEARCH) messages USING COVERING INDEX\b/)
    expect(fleetPlan).not.toMatch(/\bSCAN (?:messages|m)\b(?! USING COVERING INDEX\b)/)
    const sort = (rows: Array<{ recipient: string; count: number }>) =>
      rows.sort((a, b) => a.recipient.localeCompare(b.recipient))
    expect(sort(actual)).toEqual(sort(db.prepare(assertSingleStatement(OLD_FLEET_UNREAD_SQL)).all() as typeof actual))
    expect(actual).toEqual([
      { recipient: "alpha", count: 1 },
      { recipient: "archive-owner", count: 1 },
      { recipient: "gamma", count: 1 },
    ])
    for (const row of actual) {
      expect(stmts.getUnreadDms.get({ $name: row.recipient })).toMatchObject({ count: row.count })
    }
    db.exec("DELETE FROM mailbox_cursors WHERE recipient IN ('beta', 'response-owner')")
    expect(sort(stmts.getAllUnreadDms.all() as typeof actual)).toEqual(
      sort(db.prepare(assertSingleStatement(OLD_FLEET_UNREAD_SQL)).all() as typeof actual),
    )
  })

  it("seeks taking receipts for open balls in both retention tiers without scanning receipts", () => {
    const { db } = fixture()
    const stmts = createStatements(db)
    db.exec(
      assertSingleStatement(`
      INSERT INTO messages (rowid, id, type, sender, recipient, content, ts, kind, ref) VALUES
        (101, 'original', 'request', 'caller', 'owner', 'body', 100, 'direct', NULL),
        (102, 'hot-taking', 'status', 'owner', 'caller', 'body', 200, 'direct', 'ball'),
        (103, 'wrong-owner', 'status', 'other', 'caller', 'body', 900, 'direct', 'ball')
    `),
    )
    db.exec(
      assertSingleStatement(`
      INSERT INTO messages_archive (seq, id, type, sender, recipient, content, ts, archived_at, kind, ref) VALUES
        (104, 'archive-taking', 'status', 'owner', 'caller', 'body', 300, 400, 'direct', 'original'),
        (99, 'too-early', 'status', 'owner', 'caller', 'body', 800, 900, 'direct', 'ball')
    `),
    )
    db.exec(
      assertSingleStatement(`
      INSERT INTO pending_request (request_id, recipient, sender, opened_at, expires_at, message_id, fanout) VALUES
        ('ball', 'owner', 'caller', 100, 10000, 'original', 'first')
    `),
    )
    // Both approved original-sequence expressions keep the existing index seeks.
    for (const statement of [stmts.selectTakingReceiptsForOpenBalls, stmts.selectTakingReceiptsForPendingBalls]) {
      expect(statement.all()).toEqual([
        { request_id: "ball", recipient: "owner", message_id: "original", taking_receipt_at_ms: 300 },
      ])
      const queryPlan = plan(db, statement.toString())
      expect(queryPlan).not.toMatch(/\bSCAN\s+(?:r|messages|messages_archive)\b/i)
    }
  })

  it("bounds the 7d growth window by archived_at instead of scanning the archive", () => {
    const { db } = fixture()
    const p = plan(db, "SELECT COUNT(*) FROM messages_archive WHERE archived_at >= $cutoff AND archived_at <= $now", {
      $cutoff: NOW - 7 * 86_400_000,
      $now: NOW,
    })
    expect(p).toContain("idx_messages_archive_archived_at")
    expect(p).not.toContain("SCAN messages_archive")
  })

  it("answers a session's last message without re-sorting its rows", () => {
    const { db } = fixture()
    const p = plan(db, "SELECT ts FROM messages WHERE sender = $name ORDER BY ts DESC LIMIT 1", { $name: SEAT })
    expect(p).toContain("idx_messages_sender_ts")
    // A temp B-tree means LIMIT 1 cannot short-circuit: SQLite sorts every row.
    expect(p).not.toContain("USE TEMP B-TREE")
  })

  it("drives the inbox-lag oldest-actionable probe off the recipient, not the whole archive", () => {
    const { db } = fixture()
    // Mirrors inboxLagProjection's oldestActionableQueryArchive; built from the
    // same exported helpers so the partial index stays legal to use.
    const sql = `SELECT m.id, m.type, m.sender, m.summary, m.ts, m.seq AS seq
      FROM messages_archive AS m
      WHERE m.seq > COALESCE(
        (SELECT last_actionable_seq FROM mailbox_cursors WHERE recipient = $session), 0
      )
        AND m.recipient = $session
        AND m.kind = 'direct'
        AND m.sender != $session
        AND ${ATTENTION_PREDICATE_SQL}
        AND ${noOpenIncidentAttentionPredicateSql("m")}
        AND ${unretiredAttentionPredicateSql("m", { relation: "journal", sequence: "seq" })}
      ORDER BY m.seq ASC
      LIMIT 1`
    const p = plan(db, sql, { $session: SEAT })
    expect(p).toContain("idx_messages_archive_attention")
    expect(p).not.toContain("SCAN m")
    // The correlated retirement probes must keep their own dedicated partial
    // indexes; the recipient-led index is exactly what made them quadratic
    // when the planner chose it for them.
    expect(p).toContain("idx_messages_archive_reply_retire")
    expect(p).toContain("idx_messages_archive_status_ref_retire")
  })
})
