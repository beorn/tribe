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
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Database } from "bun:sqlite"

import { projectHealthCadence } from "./health-cadence.ts"
import { createTribeContext } from "./context.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"

import {
  ATTENTION_PREDICATE_SQL,
  createStatements,
  noOpenIncidentAttentionPredicateSql,
  openDatabase,
  unretiredAttentionPredicateSql,
  unsettledAttentionPredicateSql,
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
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const entry of open.splice(0)) {
    entry.db.close()
    rmSync(entry.dir, { recursive: true, force: true })
  }
})

describe("health projection reads the archive through an index", () => {
  // 33650: a requested disconnected seat can have an old cursor. This count
  // must seek its recipients and read no message payload; the existing archive
  // attention-index test covers only actionable rows, not this all-kind count.
  it("covers archived cursor backlog without changing cursor, kind, sender or broadcast semantics", () => {
    const { db } = fixture()
    db.exec("DELETE FROM messages_archive")
    db.prepare(`INSERT INTO sessions
      (id, name, role, pid, cwd, started_at, updated_at, last_inbox_pull_seq)
      VALUES ('lag-reader', ?, 'member', 0, '', ?, ?, 100)`).run(SEAT, NOW, NOW)
    const insert = db.prepare(`INSERT INTO messages_archive
      (seq, id, type, sender, recipient, content, ts, archived_at, kind)
      VALUES (?, ?, 'notify', ?, ?, 'body', ?, ?, ?)`)
    for (const [seq, sender, recipient, kind, age] of [
      [99, "other", SEAT, "direct", 9000],
      [100, "other", SEAT, "direct", 8000],
      [101, "other", SEAT, "direct", 2000],
      [102, "other", "*", "broadcast", 1000],
      [103, SEAT, "*", "broadcast", 7000],
      [104, "other", SEAT, "event", 6000],
      [105, "other", "@unrelated", "direct", 5000],
    ] as const) {
      insert.run(seq, `lag-${seq}`, sender, recipient, NOW - age, NOW, kind)
    }
    const projected = projectHealthCadence(db, {
      now: NOW,
      connectedSessionNames: [],
      requestedSessionNames: [SEAT],
      slaRole: null,
    })
    expect(projected.inbox_lag).toEqual([expect.objectContaining({ session: SEAT, rows: 2, oldest_age_ms: 2000 })])
    const archivePlan = plan(
      db,
      `SELECT COUNT(*) AS rows, MIN(ts) AS oldest_ts
      FROM messages_archive
      WHERE seq > $cursor AND kind IN ('direct', 'broadcast')
        AND sender != $session AND recipient IN ($session, '*')`,
      {
        $cursor: 100,
        $session: SEAT,
      },
    )
    expect(archivePlan).toMatch(/SEARCH messages_archive USING COVERING INDEX .*\(recipient=\? AND seq>\?\)/)
  })

  it("keeps fleet unread equal to the old grouped query across mailbox and tracked attention", () => {
    const { db } = fixture()
    const stmts = createStatements(db)
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(NOW)
    const ctx = createTribeContext({
      db,
      stmts,
      sessionId: "health-reader",
      sessionRole: "member",
      initialName: "health-reader",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    const opts: HandlerOpts = {
      cleanup: () => undefined,
      userRenamed: false,
      setUserRenamed: () => undefined,
      getActiveSessionIds: () => new Set(),
      hasActiveTransport: () => false,
      isReconnectGraceProtected: () => false,
      getActiveSessionInfo: () => [],
    }
    const health = (args: Record<string, unknown>) => {
      const result = handleToolCall(ctx, "tribe.health", args, opts)
      const text = (result as { content: Array<{ text: string }> }).content[0]!.text
      return JSON.parse(text) as Record<string, unknown>
    }
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
    // 33650: scope is explicit and independent of backlog's `sessions` option.
    // Reuse the oracle fixture so tracked/direct overlap, archive, broadcast,
    // cursor retirement, TAKING and self-send cannot diverge at the API boundary.
    const assertUnreadScopes = () => {
      const oracle = sort(db.prepare(assertSingleStatement(OLD_FLEET_UNREAD_SQL)).all() as typeof actual)
      const legacy = health({})
      expect(sort(legacy.unread as typeof actual)).toEqual(oracle)
      expect(legacy).not.toHaveProperty("unread_scope")
      expect(sort(health({ sessions: ["alpha"] }).unread as typeof actual)).toEqual(oracle)
      for (const names of [
        [],
        [
          "alpha",
          "alpha",
          "archive-owner",
          "gamma",
          "beta",
          "delta",
          "epsilon",
          "response-owner",
          "incident-owner",
          "self-owner",
          "unknown",
        ],
        ["unknown"],
        ["alpha"],
      ]) {
        const scoped = health({ unread_sessions: names })
        expect(sort(scoped.unread as typeof actual)).toEqual(oracle.filter((row) => names.includes(row.recipient)))
        expect(scoped).toEqual({
          ...legacy,
          unread: scoped.unread,
          unread_scope: { kind: "sessions", names: [...new Set(names)] },
        })
      }
    }
    assertUnreadScopes()
    db.exec("DELETE FROM mailbox_cursors WHERE recipient IN ('alpha', 'beta', 'response-owner')")
    expect(sort(stmts.getAllUnreadDms.all() as typeof actual)).toEqual(
      sort(db.prepare(assertSingleStatement(OLD_FLEET_UNREAD_SQL)).all() as typeof actual),
    )
    assertUnreadScopes()
    // An explicit empty scope has no unread work, even if those queries cannot run.
    const unavailable = () => {
      throw new Error("unread query must not run for an empty scope")
    }
    vi.spyOn(stmts.getAllUnreadDms, "all").mockImplementation(unavailable)
    vi.spyOn(stmts.getUnreadDms, "get").mockImplementation(unavailable)
    expect(health({ unread_sessions: [] })).toMatchObject({
      unread: [],
      unread_scope: { kind: "sessions", names: [] },
    })
  })

  it("seeks taking receipts for open balls in both retention tiers without scanning receipts", () => {
    const { db, dir } = fixture()
    const stmts = createStatements(db)
    db.exec(
      assertSingleStatement(`
      INSERT INTO sessions (id, name, role, domains, pid, cwd, started_at, updated_at) VALUES
        ('sess-caller', 'caller', 'chief', '[]', 1, '/hh', 100, 100),
        ('sess-owner', 'owner', 'dev', '[]', 2, '/hh', 100, 100)
    `),
    )
    db.exec(
      assertSingleStatement(`
      INSERT INTO messages (rowid, id, type, sender, recipient, content, ts, kind, ref) VALUES
        (101, 'original', 'request', 'caller', 'owner', 'body', 100, 'direct', NULL),
        (102, 'hot-taking', 'status', 'owner', 'caller', 'body', 200, 'direct', 'ball'),
        (103, 'wrong-owner', 'status', 'other', 'caller', 'body', 900, 'direct', 'ball'),
        (105, 'reverse-direction', 'status', 'caller', 'owner', 'body', 950, 'direct', 'ball'),
        (106, 'missing-orig-taking', 'status', 'owner', 'other-caller', 'body', 250, 'direct', 'ball-missing-orig')
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
      INSERT INTO pending_request (request_id, recipient, sender, opened_at, expires_at, message_id, fanout, request_kind) VALUES
        ('ball', 'owner', 'caller', 100, 10000, 'original', 'first', 'request')
    `),
    )

    // 1. All four prepared receipt statements must use idx_messages_status_ref_retire and
    // idx_messages_archive_status_ref_retire, and never fall back to idx_messages_recipient_kind.
    for (const [statement, params] of [
      [stmts.selectTakingReceiptsForOpenBalls, {}],
      [stmts.selectTakingReceiptsForPendingBalls, {}],
      [stmts.getOpenRequestStatus, { $name: "caller" }],
      [stmts.getOpenRequestStatusesForRefPrefix, { $prefix: "ball", $limit: 10 }],
    ] as const) {
      const queryPlan = plan(db, statement.toString(), params)
      expect(queryPlan).toContain("idx_messages_status_ref_retire")
      expect(queryPlan).toContain("idx_messages_archive_status_ref_retire")
      expect(queryPlan).not.toContain("idx_messages_recipient_kind")
      expect(queryPlan).not.toMatch(/\bSCAN\s+(?:r|messages|messages_archive)\b/i)
    }

    // 2. The 5th consumer (takingStatusProtectsOpenBallPredicateSql in archive-delete eligibility)
    // keeps its bounded idx_pending_sender seek and protects archive-taking while allowing too-early.
    for (const [sql, params] of [
      [stmts.selectArchiveDeleteBatch.toString(), { $cutoff: 10_000, $cursor_floor: 10_000, $limit: 50 }],
      [stmts.selectArchiveRowsForExport.toString(), { $cutoff: 10_000, $cursor_floor: 10_000, $limit: 50 }],
      [stmts.selectArchiveDeleteDiagnostics.toString(), { $cutoff: 10_000, $cursor_floor: 10_000 }],
    ] as const) {
      const queryPlan = plan(db, sql, params)
      expect(queryPlan).toContain("idx_pending_sender")
      expect(queryPlan).not.toContain("idx_messages_recipient_kind")
    }
    expect(plan(db, stmts.selectArchiveRowsByIdsSql("'archive-taking','too-early'"))).toContain("idx_pending_sender")
    const reVerifiedIds = (
      db
        .prepare(assertSingleStatement(stmts.selectArchiveRowsByIdsSql("?, ?")))
        .all("archive-taking", "too-early", 10_000, 10_000) as Array<{ id: string }>
    ).map((r) => r.id)
    expect(reVerifiedIds).toEqual(["too-early"])

    // 3. Exact result equality on the active ball (request_id + message_id equivalence, chronology, MAX/dedup).
    expect(stmts.selectTakingReceiptsForOpenBalls.all()).toEqual([
      { request_id: "ball", recipient: "owner", message_id: "original", taking_receipt_at_ms: 300 },
    ])
    expect(stmts.selectTakingReceiptsForPendingBalls.all()).toEqual([
      { request_id: "ball", recipient: "owner", message_id: "original", taking_receipt_at_ms: 300 },
    ])
    expect(stmts.getOpenRequestStatus.get({ $name: "caller" })).toEqual({
      open_request_status_count: 2,
      latest_open_request_status_seq: 104,
    })
    expect(stmts.getOpenRequestStatus.get({ $name: "owner" })).toEqual({
      open_request_status_count: 2,
      latest_open_request_status_seq: 104,
    })
    expect(
      (stmts.getOpenRequestStatusesForRefPrefix.all({ $prefix: "ball", $limit: 10 }) as Array<{ id: string }>).map(
        (r) => r.id,
      ),
    ).toEqual(["archive-taking", "hot-taking"])
    expect(
      (stmts.getOpenRequestStatusesForRefPrefix.all({ $prefix: "orig", $limit: 10 }) as Array<{ id: string }>).map(
        (r) => r.id,
      ),
    ).toEqual(["archive-taking", "hot-taking"])

    // 4. Strict missing-original vs explicit-zero fallback:
    // A pending ball whose original message is absent from both tiers has NULL originalSequence in
    // selectTakingReceiptsForOpenBalls (excluded) and getOpenRequestStatus (available=0 -> null counts),
    // but falls back to 0 in selectTakingReceiptsForPendingBalls (included).
    db.exec(
      assertSingleStatement(`
      INSERT INTO pending_request (request_id, recipient, sender, opened_at, expires_at, message_id, fanout, request_kind) VALUES
        ('ball-missing-orig', 'owner', 'other-caller', 120, 10000, 'missing-original-msg', 'first', 'request')
    `),
    )
    expect(stmts.selectTakingReceiptsForOpenBalls.all()).toEqual([
      { request_id: "ball", recipient: "owner", message_id: "original", taking_receipt_at_ms: 300 },
    ])
    expect(stmts.selectTakingReceiptsForPendingBalls.all()).toEqual([
      { request_id: "ball", recipient: "owner", message_id: "original", taking_receipt_at_ms: 300 },
      {
        request_id: "ball-missing-orig",
        recipient: "owner",
        message_id: "missing-original-msg",
        taking_receipt_at_ms: 250,
      },
    ])
    expect(stmts.getOpenRequestStatus.get({ $name: "owner" })).toEqual({
      open_request_status_count: null,
      latest_open_request_status_seq: null,
    })
    db.exec("DELETE FROM pending_request WHERE request_id = 'ball-missing-orig'")

    // 5. Meaningful seek / logical-read bound under unrelated-recipient traffic:
    // Flood `messages` with 2,000 unrelated direct status rows addressed to `caller` after rowid 101.
    // The old unforced plan (`idx_messages_recipient_kind`) scans every direct message to `caller`
    // after `originalSequence`, whereas the pinned `idx_messages_status_ref_retire` plan seeks only
    // matching `(sender, recipient, ref)` keys.
    db.exec("BEGIN")
    const insertUnrelated = db.prepare(
      assertSingleStatement(`
      INSERT INTO messages (rowid, id, type, sender, recipient, content, ts, kind, ref)
      VALUES ($rowid, $id, 'status', $sender, 'caller', $content, $ts, 'direct', $ref)
    `),
    )
    const payload = "x".repeat(500)
    for (let i = 0; i < 2000; i++) {
      insertUnrelated.run({
        $rowid: 1000 + i,
        $id: `unrelated-${i}`,
        $sender: `peer-${i % 10}`,
        $content: payload,
        $ts: 1000 + i,
        $ref: `unrelated-ref-${i}`,
      })
    }
    db.exec("COMMIT")
    db.exec("PRAGMA cache_size = 16")

    const readRchar = (): number => {
      const m = readFileSync("/proc/self/io", "utf8").match(/^rchar:\s+(\d+)/m)
      return m ? Number(m[1]) : 0
    }
    const measureRchar = <T>(fn: () => T): { result: T; rcharBytes: number } => {
      const before = readRchar()
      const result = fn()
      return { result, rcharBytes: readRchar() - before }
    }

    const legacyUnforcedOpenBallsSql = `
      SELECT request_id, recipient, message_id, MAX(taking_receipt_at_ms) AS taking_receipt_at_ms
      FROM (
        SELECT p.request_id AS request_id, p.recipient, p.message_id, r.ts AS taking_receipt_at_ms
        FROM pending_request p
        LEFT JOIN messages pending_message ON pending_message.id = p.message_id
        LEFT JOIN messages_archive pending_archive ON pending_archive.id = p.message_id
        CROSS JOIN messages r ON r.kind = 'direct' AND r.type = 'status'
          AND r.sender = p.recipient AND r.recipient = p.sender
          AND r.ref IS NOT NULL AND (r.ref = p.request_id OR r.ref = p.message_id)
          AND r.rowid > COALESCE(pending_message.rowid, pending_archive.seq)
        UNION ALL
        SELECT p.request_id AS request_id, p.recipient, p.message_id, r.ts AS taking_receipt_at_ms
        FROM pending_request p
        LEFT JOIN messages pending_message ON pending_message.id = p.message_id
        LEFT JOIN messages_archive pending_archive ON pending_archive.id = p.message_id
        CROSS JOIN messages_archive r ON r.kind = 'direct' AND r.type = 'status'
          AND r.sender = p.recipient AND r.recipient = p.sender
          AND r.ref IS NOT NULL AND (r.ref = p.request_id OR r.ref = p.message_id)
          AND r.seq > COALESCE(pending_message.rowid, pending_archive.seq)
      )
      GROUP BY request_id, recipient, message_id
    `
    expect(plan(db, legacyUnforcedOpenBallsSql)).toContain("idx_messages_recipient_kind")
    const legacyStmt = db.prepare(assertSingleStatement(legacyUnforcedOpenBallsSql))
    const legacyRun = measureRchar(() => legacyStmt.all())
    const boundedOpenRun = measureRchar(() => stmts.selectTakingReceiptsForOpenBalls.all())
    const boundedPendingRun = measureRchar(() => stmts.selectTakingReceiptsForPendingBalls.all())
    const boundedStatusRun = measureRchar(() => stmts.getOpenRequestStatus.get({ $name: "caller" }))
    const boundedPrefixRun = measureRchar(() =>
      stmts.getOpenRequestStatusesForRefPrefix.all({ $prefix: "ball", $limit: 10 }),
    )

    expect(boundedOpenRun.result).toEqual(legacyRun.result)
    expect(boundedPendingRun.result).toEqual(legacyRun.result)
    expect(boundedStatusRun.result).toEqual({
      open_request_status_count: 2,
      latest_open_request_status_seq: 104,
    })
    expect((boundedPrefixRun.result as Array<{ id: string }>).map((r) => r.id)).toEqual([
      "archive-taking",
      "hot-taking",
    ])
    // The unforced recipient_kind plan reads >500 KiB of unrelated table pages for 1 ball,
    // while each pinned status_ref_retire statement stays bounded (<64 KiB).
    expect(legacyRun.rcharBytes).toBeGreaterThan(500 * 1024)
    expect(boundedOpenRun.rcharBytes).toBeLessThan(64 * 1024)
    expect(boundedPendingRun.rcharBytes).toBeLessThan(64 * 1024)
    expect(boundedStatusRun.rcharBytes).toBeLessThan(64 * 1024)
    expect(boundedPrefixRun.rcharBytes).toBeLessThan(64 * 1024)

    // 6. Fresh and upgraded DB preparation proof: reopening an existing DB and opening a fresh DB
    // both prepare and run all four statements cleanly.
    const reopened = openDatabase(join(dir, "tribe.db"))
    try {
      const reopenedStmts = createStatements(reopened)
      expect(reopenedStmts.selectTakingReceiptsForOpenBalls.all()).toEqual(legacyRun.result)
    } finally {
      reopened.close()
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
        AND ${unsettledAttentionPredicateSql("m")}
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
