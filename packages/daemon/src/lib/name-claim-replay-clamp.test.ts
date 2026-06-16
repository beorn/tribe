/**
 * @km/tribe/20002 — name-claim replay must be bounded by a recent horizon.
 *
 * `replayUnreadForClaimedName` rewinds a reclaiming session's inbox cursor to
 * expose directs it missed. Unbounded, it rewound to the OLDEST unread direct
 * for the name — so a long-lived name (`@chief`, `@agent/N`) with days of
 * undrained directs replayed the entire stale backlog on every join/rename
 * (@km/tribe/19996). The clamp (`NAME_CLAIM_REPLAY_HORIZON_MS`) bounds the
 * rewind to directs within a recent window: the recent gap still surfaces;
 * ancient backlog does not. No message is deleted — only the cursor target moves.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createStatements, openDatabase } from "./database.ts"
import { NAME_CLAIM_REPLAY_HORIZON_MS, replayUnreadForClaimedName } from "./messaging.ts"

const NOW = 1_700_000_000_000
const NAME = "@agent/test"
const SELF = "sess-self"

describe("name-claim replay clamp (@km/tribe/20002)", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "name-claim-clamp-"))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function setup() {
    const db = openDatabase(join(tmpDir, "tribe.db"))
    const stmts = createStatements(db)
    // The reclaiming session itself — cursor parked at the log tail (the
    // register-time reset), which is what hides the gap directs until replay.
    db.prepare(
      "INSERT INTO sessions (id, name, role, pid, started_at, updated_at, last_inbox_pull_seq) VALUES (?,?,?,?,?,?,?)",
    ).run(SELF, NAME, "member", 1, NOW, NOW, 0)
    const ctx = { stmts, sessionId: SELF } as unknown as Parameters<typeof replayUnreadForClaimedName>[0]
    return { db, stmts, ctx }
  }

  /** Insert a direct TO `NAME` from chief at timestamp `ts`; returns its rowid. */
  function insertDirect(stmts: ReturnType<typeof createStatements>, ts: number): number {
    const res = stmts.insertMessage.run({
      $id: `m-${ts}`,
      $type: "status",
      $sender: "@chief",
      $recipient: NAME,
      $kind: "direct",
      $content: "x",
      $bead_id: null,
      $ref: null,
      $ts: ts,
      $delivery: "push",
      $topic: null,
      $room_id: null,
      $request: null,
      $reply: null,
    })
    return Number(res.lastInsertRowid)
  }

  /** Park the reclaiming session's cursor at the tail so a rewind can fire. */
  function parkCursorAtTail(db: ReturnType<typeof openDatabase>): void {
    const tail = (db.prepare("SELECT COALESCE(MAX(rowid), 0) AS t FROM messages").get() as { t: number }).t
    db.prepare("UPDATE sessions SET last_inbox_pull_seq = ? WHERE id = ?").run(tail, SELF)
  }

  it("rewinds only to the recent gap, not to ancient unread directs", () => {
    const { db, stmts, ctx } = setup()
    try {
      const ancient = insertDirect(stmts, NOW - NAME_CLAIM_REPLAY_HORIZON_MS - 60_000) // just outside the window
      const recent = insertDirect(stmts, NOW - 60_000) // 1 min ago — inside the window
      parkCursorAtTail(db)

      const target = replayUnreadForClaimedName(ctx, NAME, NOW)

      // The rewind exposes the RECENT direct (rowid-1), never the ancient one.
      expect(target).toBe(recent - 1)
      expect(target).not.toBe(ancient - 1)
    } finally {
      db.close()
    }
  })

  it("does not replay at all when every unread direct is older than the horizon", () => {
    const { db, stmts, ctx } = setup()
    try {
      insertDirect(stmts, NOW - NAME_CLAIM_REPLAY_HORIZON_MS - 60_000)
      insertDirect(stmts, NOW - NAME_CLAIM_REPLAY_HORIZON_MS - 5 * 60_000)
      parkCursorAtTail(db)

      // Nothing within the recent window → no rewind into stale backlog.
      expect(replayUnreadForClaimedName(ctx, NAME, NOW)).toBeNull()
    } finally {
      db.close()
    }
  })

  it("still surfaces a recent direct that arrived while the name was unheld", () => {
    const { db, stmts, ctx } = setup()
    try {
      const recent = insertDirect(stmts, NOW - 5 * 60_000)
      parkCursorAtTail(db)

      expect(replayUnreadForClaimedName(ctx, NAME, NOW)).toBe(recent - 1)
    } finally {
      db.close()
    }
  })
})
