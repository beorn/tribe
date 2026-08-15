/**
 * Migration v26 — message provenance, and the archive-carry bug it fixes.
 *
 * Two things are pinned here, and the second is the one that bit us:
 *
 * 1. `session_id` exists on BOTH `messages` and `messages_archive`, so a row
 *    can be traced to the connection that wrote it.
 * 2. Archiving CARRIES the columns rather than dropping them. `archiveExpiredMessages`
 *    uses explicit column lists on both sides, so a column added to `messages`
 *    and not to that statement is silently lost on archival with no error.
 *    That is exactly what happened to `attention_required` between v24 and v26:
 *    it was live on `messages` for two migrations while every archived row
 *    reverted to 0. There was no test crossing this boundary, which is why
 *    nobody noticed.
 */
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, realpathSync } from "node:fs"
import { safeRemoveSync } from "removely"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CURRENT_SCHEMA_VERSION, createStatements, openDatabase } from "./database.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) safeRemoveSync(dir, { within: realpathSync(tmpdir()), allowMissing: true })
})

function freshDb(label: string): { path: string; db: Database } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `msg-provenance-${label}-`)))
  dirs.push(dir)
  const path = join(dir, "tribe.db")
  return { path, db: openDatabase(path) }
}

const columnsOf = (db: Database, table: string) =>
  new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name))

describe("message provenance (migration v26)", () => {
  it("puts session_id on both the live table and the archive", () => {
    const { db } = freshDb("cols")
    try {
      expect(columnsOf(db, "messages").has("session_id")).toBe(true)
      expect(columnsOf(db, "messages_archive").has("session_id")).toBe(true)
      // v24 added this to `messages` only; the archive half was missing until v26.
      expect(columnsOf(db, "messages_archive").has("attention_required")).toBe(true)
      expect(db.prepare("SELECT value FROM _schema_meta WHERE key='version'").get()).toEqual({
        value: String(CURRENT_SCHEMA_VERSION),
      })
    } finally {
      db.close()
    }
  })

  it("carries session_id and attention_required across archival instead of dropping them", () => {
    const { db } = freshDb("archive")
    try {
      const stmts = createStatements(db)
      const old = Date.now() - 30 * 24 * 60 * 60 * 1000
      stmts.insertMessage.run({
        $id: "msg-old",
        $type: "request",
        $sender: "@chief",
        $recipient: "@dev/1",
        $kind: "direct",
        $content: "please do the thing",
        $bead_id: null,
        $ref: null,
        $ts: old,
        $delivery: "push",
        $topic: null,
        $room_id: null,
        $request: "msg-old",
        $reply: null,
        $correlated_reply_requester: null,
        $summary: null,
        $session_id: "sess-chief-42",
        $attention_required: 1,
      })

      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
      stmts.archiveExpiredMessages.run({ $cutoff: cutoff, $archived_at: Date.now() })
      stmts.deleteExpiredMessages.run({ $cutoff: cutoff })

      expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE id='msg-old'").get()).toEqual({ n: 0 })
      // The whole point: both values survive the move. Before v26 the archived
      // row read back attention_required = 0, silently.
      expect(
        db.prepare("SELECT session_id, attention_required FROM messages_archive WHERE id='msg-old'").get(),
      ).toEqual({ session_id: "sess-chief-42", attention_required: 1 })
    } finally {
      db.close()
    }
  })
})
