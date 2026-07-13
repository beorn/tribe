/**
 * @km/bearly/17018 (Fix 1, data-lifecycle slice) — sessions-table GC +
 * messages_archive retention inside `cleanupOldData`.
 *
 * Two unbounded-growth gaps found in the 2026-07-13 20703 review:
 *  - `sessions` was never GC'd (4,908 rows measured; cleanupOldData swept only
 *    messages/dedup/pending balls). We now delete rows idle >= 7d by updated_at.
 *    Recency is the liveness fence: a live session bumps updated_at on every
 *    authenticated tool call (touchSessionPresence) + at registration, so a
 *    7-day-idle row cannot be a connected session, and 7d is well outside every
 *    reconnect-adoption window (adoptByPidCwd needs the same *live* client pid;
 *    adoptIdentity / launch-identity / project-role only restore a *disconnected*
 *    session's friendly name on reconnect — after 7d that is equivalent to a
 *    cold-daemon fresh start, which the resolver explicitly treats as acceptable).
 *  - `messages_archive` held 211,315 rows (~75MB, half the DB) with ZERO
 *    production readers — write-only forensic plaster. We now delete archive
 *    rows older than 30 days (the forensic window), keeping the archive INSERT
 *    path unchanged.
 *
 * The 21052 tombstone GC (`sweepDeadSessionRows`, name-anchored, run at daemon
 * startup in with-database) must be unchanged by this slice.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { cleanupOldData, sweepDeadSessionRows } from "./session.ts"

const DAY = 24 * 60 * 60 * 1000

/** Shape of the cleanup summary the log line is derived from. Declared inline
 *  so this test needs no import coupling to the (impl-commit) exported type. */
type CleanupSummaryShape = {
  archived: number
  msgsDeleted: number
  pendingGcd: number
  sessionsGcd: number
  archivePruned: number
}

describe("data-lifecycle GC (@km/bearly/17018)", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "data-lifecycle-gc-"))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function setup() {
    const db = openDatabase(join(tmpDir, "tribe.db"))
    const stmts = createStatements(db)
    return { db, stmts }
  }

  /** Seed a session row with an explicit updated_at (= started_at) via the
   *  production upsert statement, so the test exercises the real column. */
  function seedSession(stmts: TribeStatements, name: string, updatedAt: number): void {
    stmts.upsertSession.run({
      $id: `id-${name}`,
      $name: name,
      $role: "member",
      $domains: "[]",
      $pid: 0,
      $cwd: "/tmp",
      $project_id: null,
      $claude_session_id: null,
      $claude_session_name: null,
      $identity_token: null,
      $launch_id: null,
      $launch_parent_pid: null,
      $now: updatedAt,
      $delivery: "pull",
      $account: null,
      $provider: null,
    })
  }

  function sessionNames(db: import("bun:sqlite").Database): string[] {
    return (db.prepare("SELECT name FROM sessions ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name)
  }

  /** Seed a messages_archive row with an explicit archived_at. */
  function seedArchive(db: import("bun:sqlite").Database, id: string, archivedAt: number): void {
    db.prepare(
      `INSERT INTO messages_archive (seq, id, type, sender, recipient, kind, content, ts, delivery, archived_at)
       VALUES ($seq, $id, 'direct', 'a', 'b', 'direct', 'hi', $ts, 'push', $archived_at)`,
    ).run({ $seq: 1, $id: id, $ts: archivedAt, $archived_at: archivedAt })
  }

  function archiveIds(db: import("bun:sqlite").Database): string[] {
    return (db.prepare("SELECT id FROM messages_archive ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id)
  }

  it("sessions GC deletes rows idle >= 7d by updated_at, keeps recent + fresh", () => {
    const { db, stmts } = setup()
    try {
      const now = Date.now()
      seedSession(stmts, "idle-old", now - 8 * DAY) // > 7d idle -> swept
      seedSession(stmts, "idle-boundary", now - 6 * DAY) // < 7d -> kept (protect recency)
      seedSession(stmts, "recent", now - 1 * DAY) // recently active -> kept
      seedSession(stmts, "fresh", now) // just registered -> kept

      cleanupOldData({ stmts } as unknown as Parameters<typeof cleanupOldData>[0])

      expect(sessionNames(db)).toEqual(["fresh", "idle-boundary", "recent"])
    } finally {
      db.close()
    }
  })

  it("archive retention prunes rows older than 30d by archived_at, keeps the forensic window", () => {
    const { db, stmts } = setup()
    try {
      const now = Date.now()
      seedArchive(db, "arch-ancient", now - 31 * DAY) // > 30d -> pruned
      seedArchive(db, "arch-boundary", now - 29 * DAY) // < 30d -> kept
      seedArchive(db, "arch-fresh", now - 1 * DAY) // recent -> kept

      cleanupOldData({ stmts } as unknown as Parameters<typeof cleanupOldData>[0])

      expect(archiveIds(db)).toEqual(["arch-boundary", "arch-fresh"])
    } finally {
      db.close()
    }
  })

  it("returns a summary whose counts feed the cleanup log line", () => {
    const { db, stmts } = setup()
    try {
      const now = Date.now()
      seedSession(stmts, "idle-a", now - 10 * DAY)
      seedSession(stmts, "idle-b", now - 9 * DAY)
      seedSession(stmts, "live", now)
      seedArchive(db, "old-1", now - 40 * DAY)
      seedArchive(db, "old-2", now - 35 * DAY)
      seedArchive(db, "old-3", now - 31 * DAY)
      seedArchive(db, "keep", now - 5 * DAY)

      const summary = cleanupOldData(
        { stmts } as unknown as Parameters<typeof cleanupOldData>[0],
      ) as unknown as CleanupSummaryShape

      expect(summary.sessionsGcd).toBe(2)
      expect(summary.archivePruned).toBe(3)
    } finally {
      db.close()
    }
  })

  it("21052 tombstone GC (sweepDeadSessionRows) is unchanged — name-anchored, not touched by this slice", () => {
    const { db, stmts } = setup()
    try {
      const now = Date.now()
      // A live-named row idle >7d: the cleanupOldData sessions GC owns it, but
      // the tombstone sweep must NOT (it is anchored to the -dead- convention).
      seedSession(stmts, "live-name-idle", now - 10 * DAY)
      seedSession(stmts, "member-1-dead-abcd1234", now - 10 * DAY) // stale tombstone -> swept
      seedSession(stmts, "member-2-dead-ef567890", now - 1 * DAY) // fresh tombstone -> kept

      const swept = sweepDeadSessionRows(db, 7 * DAY, now)

      expect(swept).toBe(1) // only the stale tombstone
      // sweepDeadSessionRows leaves the live-named idle row + the fresh tombstone.
      expect(sessionNames(db)).toEqual(["live-name-idle", "member-2-dead-ef567890"])
    } finally {
      db.close()
    }
  })
})
