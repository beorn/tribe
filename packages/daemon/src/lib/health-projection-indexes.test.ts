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
  noOpenIncidentAttentionPredicateSql,
  openDatabase,
  unretiredAttentionPredicateSql,
} from "./database.ts"

/** A seat with no mail is the shape that paid the whole-archive walk. */
const SEAT = "@seat-with-no-mail"
const NOW = 1_800_000_000_000

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
  return (
    db.prepare(assertSingleStatement(`EXPLAIN QUERY PLAN ${sql}`)).all(params) as Array<{ detail: string }>
  )
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
