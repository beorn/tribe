/**
 * Journal retention (@cto journal-retention) — see retention.ts's module
 * header for the full design rationale. This file proves:
 *
 *   - config parsing / window math (resolveRetentionConfig)
 *   - archive-move correctness, including across the messages/messages_archive
 *     union queries a ball's content resolves through (@km/tribe/22844)
 *   - archive-delete ships inert by default (no env vars -> zero deletions)
 *   - archive-delete NEVER removes a row an open pending_request still needs
 *   - archive-delete NEVER removes a row a live cursor (mailbox_cursors /
 *     sessions.last_inbox_pull_seq) has not yet passed
 *   - every phase is LIMIT-bounded per tick, never a full-table pass
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { sendMessage } from "./messaging.ts"
import { resolveRetentionConfig, runRetentionSweep, type RetentionConfig } from "./retention.ts"

const DAY = 24 * 60 * 60 * 1000

describe("resolveRetentionConfig", () => {
  it("defaults to a generous always-on archive window and an off-by-default delete window", () => {
    const config = resolveRetentionConfig({})
    expect(config).toEqual({
      archiveWindowMs: 14 * DAY,
      deleteWindowMs: 90 * DAY,
      deleteEnabled: false,
      batchSize: 500,
    })
  })

  it("reads every knob from its own env var", () => {
    const config = resolveRetentionConfig({
      TRIBE_RETENTION_ARCHIVE_WINDOW_MS: String(3 * DAY),
      TRIBE_RETENTION_DELETE_WINDOW_MS: String(30 * DAY),
      TRIBE_RETENTION_DELETE_ENABLED: "1",
      TRIBE_RETENTION_BATCH_SIZE: "50",
    })
    expect(config).toEqual({
      archiveWindowMs: 3 * DAY,
      deleteWindowMs: 30 * DAY,
      deleteEnabled: true,
      batchSize: 50,
    })
  })

  it.each(["1", "true", "TRUE", "on", "yes"])("treats %j as delete-enabled", (raw) => {
    expect(resolveRetentionConfig({ TRIBE_RETENTION_DELETE_ENABLED: raw }).deleteEnabled).toBe(true)
  })

  it.each(["0", "false", "off", "no", undefined])("treats %j as delete-disabled", (raw) => {
    const env = raw === undefined ? {} : { TRIBE_RETENTION_DELETE_ENABLED: raw }
    expect(resolveRetentionConfig(env).deleteEnabled).toBe(false)
  })

  it("fails loud on an unparseable window instead of silently coercing to NaN", () => {
    expect(() => resolveRetentionConfig({ TRIBE_RETENTION_ARCHIVE_WINDOW_MS: "not-a-number" })).toThrow(
      /TRIBE_RETENTION_ARCHIVE_WINDOW_MS/,
    )
    expect(() => resolveRetentionConfig({ TRIBE_RETENTION_DELETE_WINDOW_MS: "-5" })).toThrow(
      /TRIBE_RETENTION_DELETE_WINDOW_MS/,
    )
    expect(() => resolveRetentionConfig({ TRIBE_RETENTION_BATCH_SIZE: "0" })).toThrow(/TRIBE_RETENTION_BATCH_SIZE/)
  })

  it("fails loud on an unparseable delete-enabled flag", () => {
    expect(() => resolveRetentionConfig({ TRIBE_RETENTION_DELETE_ENABLED: "maybe" })).toThrow(
      /TRIBE_RETENTION_DELETE_ENABLED/,
    )
  })
})

describe("journal retention sweep", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "retention-"))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function setup() {
    const db = openDatabase(join(tmpDir, "tribe.db"))
    const stmts = createStatements(db)
    return { db, stmts }
  }

  function makeContext(db: ReturnType<typeof openDatabase>, stmts: TribeStatements, initialName = "@fable/1") {
    return createTribeContext({
      db,
      stmts,
      sessionId: `sess-${initialName.slice(1).replaceAll("/", "-")}`,
      sessionRole: "member",
      initialName,
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
  }

  function setMessageTs(db: ReturnType<typeof openDatabase>, id: string, ts: number): void {
    db.prepare("UPDATE messages SET ts = ? WHERE id = ?").run(ts, id)
  }

  /** Insert a row directly into messages_archive with full control over
   *  ts/seq/recipient — batch and cursor-floor tests need many precisely
   *  aged, precisely sequenced rows that would be slow and indirect to build
   *  by sending + archiving real messages one at a time. */
  function insertArchived(
    db: ReturnType<typeof openDatabase>,
    o: { id: string; seq: number; ts: number; recipient?: string; sender?: string },
  ): void {
    db.prepare(
      `INSERT INTO messages_archive
        (seq, id, type, sender, recipient, kind, content, ts, delivery, archived_at)
       VALUES (?, ?, 'notify', ?, ?, 'direct', 'body', ?, 'push', ?)`,
    ).run(o.seq, o.id, o.sender ?? "@sender", o.recipient ?? "@chief", o.ts, Date.now())
  }

  function archivedIds(db: ReturnType<typeof openDatabase>): string[] {
    return (db.prepare("SELECT id FROM messages_archive ORDER BY seq ASC").all() as Array<{ id: string }>).map(
      (r) => r.id,
    )
  }

  function liveIds(db: ReturnType<typeof openDatabase>): string[] {
    return (db.prepare("SELECT id FROM messages ORDER BY rowid ASC").all() as Array<{ id: string }>).map((r) => r.id)
  }

  const enabledConfig = (overrides: Partial<RetentionConfig> = {}): RetentionConfig => ({
    archiveWindowMs: 14 * DAY,
    deleteWindowMs: 90 * DAY,
    deleteEnabled: true,
    batchSize: 500,
    ...overrides,
  })

  // -------------------------------------------------------------------
  // Archive-move phase
  // -------------------------------------------------------------------

  describe("archive-move phase", () => {
    it("moves a live message older than the archive window into messages_archive", () => {
      const { db, stmts } = setup()
      try {
        const ctx = makeContext(db, stmts)
        const sent = sendMessage(ctx, "@chief", "old enough to archive", "notify")
        setMessageTs(db, sent.id, Date.now() - 20 * DAY)

        const result = runRetentionSweep(db, stmts, enabledConfig({ archiveWindowMs: 14 * DAY }))

        expect(result.archiveMove.moved).toBe(1)
        expect(liveIds(db)).toEqual([])
        expect(archivedIds(db)).toEqual([sent.id])
        const archived = db
          .prepare("SELECT content, sender, recipient FROM messages_archive WHERE id = ?")
          .get(sent.id) as { content: string; sender: string; recipient: string }
        expect(archived).toMatchObject({ content: "old enough to archive", sender: "@fable/1", recipient: "@chief" })
      } finally {
        db.close()
      }
    })

    it("leaves a message younger than the archive window in the live table", () => {
      const { db, stmts } = setup()
      try {
        const ctx = makeContext(db, stmts)
        const sent = sendMessage(ctx, "@chief", "fresh", "notify")
        setMessageTs(db, sent.id, Date.now() - 2 * DAY)

        const result = runRetentionSweep(db, stmts, enabledConfig({ archiveWindowMs: 14 * DAY }))

        expect(result.archiveMove.moved).toBe(0)
        expect(liveIds(db)).toEqual([sent.id])
        expect(archivedIds(db)).toEqual([])
      } finally {
        db.close()
      }
    })

    it("preserves a ball's question body across the union query after a batched archive-move (@km/tribe/22844)", () => {
      const { db, stmts } = setup()
      try {
        const sender = makeContext(db, stmts, "@fable/1")
        const body = "Archived-by-retention question whose ball is still active."
        sendMessage(
          sender,
          "@chief",
          body,
          "request",
          undefined,
          undefined,
          "direct",
          { summary: "archived active question" },
          { request: "archived-active-question" },
        )
        const msgRow = db.prepare("SELECT ts, id FROM messages WHERE request = 'archived-active-question'").get() as {
          ts: number
          id: string
        }
        setMessageTs(db, msgRow.id, Date.now() - 20 * DAY)

        runRetentionSweep(db, stmts, enabledConfig({ archiveWindowMs: 14 * DAY }))
        expect(archivedIds(db)).toContain(msgRow.id)

        const pending = stmts.selectAllPendingRequestsWithContent.all() as Array<{
          request_id: string
          content: string | null
        }>
        expect(pending).toEqual([expect.objectContaining({ request_id: "archived-active-question", content: body })])
      } finally {
        db.close()
      }
    })

    it("bounds one sweep tick to batchSize and drains the rest on the next tick", () => {
      const { db, stmts } = setup()
      try {
        const ctx = makeContext(db, stmts)
        const ids: string[] = []
        for (let i = 0; i < 12; i += 1) {
          const sent = sendMessage(ctx, "@chief", `msg-${i}`, "notify")
          setMessageTs(db, sent.id, Date.now() - 20 * DAY)
          ids.push(sent.id)
        }

        const config = enabledConfig({ archiveWindowMs: 14 * DAY, batchSize: 5 })
        const first = runRetentionSweep(db, stmts, config)
        expect(first.archiveMove.candidates).toBe(5)
        expect(first.archiveMove.moved).toBe(5)
        expect(liveIds(db)).toHaveLength(7)
        expect(archivedIds(db)).toHaveLength(5)

        const second = runRetentionSweep(db, stmts, config)
        expect(second.archiveMove.moved).toBe(5)
        expect(liveIds(db)).toHaveLength(2)
        expect(archivedIds(db)).toHaveLength(10)

        const third = runRetentionSweep(db, stmts, config)
        expect(third.archiveMove.moved).toBe(2)
        expect(liveIds(db)).toHaveLength(0)
        expect(archivedIds(db)).toHaveLength(12)
        expect(archivedIds(db).sort()).toEqual([...ids].sort())
      } finally {
        db.close()
      }
    })

    it("coexists with the existing session.ts cleanupOldData archive-move without duplication or error", () => {
      const { db, stmts } = setup()
      try {
        const ctx = makeContext(db, stmts)
        const sent = sendMessage(ctx, "@chief", "already archived by the existing mechanism", "notify")
        setMessageTs(db, sent.id, Date.now() - 20 * DAY)

        // Simulate the existing unbounded cleanupOldData archive-move having
        // already moved this row (session.ts, untouched by this change).
        const cutoff = Date.now() - 7 * DAY
        stmts.archiveExpiredMessages.run({ $cutoff: cutoff, $archived_at: Date.now() })
        stmts.deleteExpiredMessages.run({ $cutoff: cutoff })
        expect(archivedIds(db)).toEqual([sent.id])
        expect(liveIds(db)).toEqual([])

        // This module's own batched archive-move must find nothing to do
        // (idempotent INSERT OR IGNORE, and the row is already gone from the
        // live table it selects candidates from) and must not error.
        const result = runRetentionSweep(db, stmts, enabledConfig({ archiveWindowMs: 14 * DAY }))
        expect(result.archiveMove.moved).toBe(0)
        expect(archivedIds(db)).toEqual([sent.id])
      } finally {
        db.close()
      }
    })
  })

  // -------------------------------------------------------------------
  // Archive-delete phase — default-off proof
  // -------------------------------------------------------------------

  describe("archive-delete phase — default-off", () => {
    it("deletes nothing when deleteEnabled is false, even for clearly-eligible rows", () => {
      const { db, stmts } = setup()
      try {
        insertArchived(db, { id: "ancient-1", seq: 1, ts: Date.now() - 200 * DAY })
        insertArchived(db, { id: "ancient-2", seq: 2, ts: Date.now() - 200 * DAY })

        const config = resolveRetentionConfig({}) // real defaults: deleteEnabled=false
        const result = runRetentionSweep(db, stmts, config)

        expect(result.archiveDelete).toMatchObject({ enabled: false, deleted: 0 })
        expect(archivedIds(db).sort()).toEqual(["ancient-1", "ancient-2"])
      } finally {
        db.close()
      }
    })

    it("still reports enabled:false when explicitly configured off", () => {
      const { db, stmts } = setup()
      try {
        insertArchived(db, { id: "ancient", seq: 1, ts: Date.now() - 200 * DAY })
        const result = runRetentionSweep(db, stmts, enabledConfig({ deleteEnabled: false }))
        expect(result.archiveDelete.enabled).toBe(false)
        expect(result.archiveDelete.deleted).toBe(0)
        expect(archivedIds(db)).toEqual(["ancient"])
      } finally {
        db.close()
      }
    })
  })

  // -------------------------------------------------------------------
  // Archive-delete phase — open-ball exclusion (explicitly required)
  // -------------------------------------------------------------------

  describe("archive-delete phase — open-ball exclusion", () => {
    it("an old-but-open pending request's archived row survives a sweep that deletes its unreferenced peer", () => {
      const { db, stmts } = setup()
      try {
        insertArchived(db, { id: "owed-msg", seq: 1, ts: Date.now() - 200 * DAY })
        insertArchived(db, { id: "unreferenced-msg", seq: 2, ts: Date.now() - 200 * DAY })
        stmts.openPendingRequest.run({
          $request_id: "still-open",
          $recipient: "@chief",
          $sender: "@fable/1",
          $opened_at: Date.now() - 200 * DAY,
          $expires_at: null,
          $message_id: "owed-msg",
          $fanout: "first",
        })

        const config = enabledConfig({ deleteWindowMs: 90 * DAY })
        const result = runRetentionSweep(db, stmts, config)

        expect(archivedIds(db)).toEqual(["owed-msg"])
        expect(result.archiveDelete.deleted).toBe(1)
        expect(result.archiveDelete.excludedByPending).toBe(1)
        // The ball itself is untouched — still open, still resolvable.
        const pending = stmts.selectPendingForRecipientWithContent.all({ $recipient: "@chief" }) as Array<{
          request_id: string
          content: string | null
        }>
        expect(pending).toEqual([expect.objectContaining({ request_id: "still-open", content: "body" })])
      } finally {
        db.close()
      }
    })

    it("deletes the previously-protected row once its ball closes", () => {
      const { db, stmts } = setup()
      try {
        insertArchived(db, { id: "owed-msg", seq: 1, ts: Date.now() - 200 * DAY })
        stmts.openPendingRequest.run({
          $request_id: "closing-soon",
          $recipient: "@chief",
          $sender: "@fable/1",
          $opened_at: Date.now() - 200 * DAY,
          $expires_at: null,
          $message_id: "owed-msg",
          $fanout: "first",
        })
        const config = enabledConfig({ deleteWindowMs: 90 * DAY })

        const first = runRetentionSweep(db, stmts, config)
        expect(first.archiveDelete.deleted).toBe(0)
        expect(archivedIds(db)).toEqual(["owed-msg"])

        stmts.closePendingRequest.run({ $request_id: "closing-soon", $recipient: "@chief" })
        const second = runRetentionSweep(db, stmts, config)
        expect(second.archiveDelete.deleted).toBe(1)
        expect(archivedIds(db)).toEqual([])
      } finally {
        db.close()
      }
    })
  })

  // -------------------------------------------------------------------
  // Archive-delete phase — live-cursor exclusion
  // -------------------------------------------------------------------

  describe("archive-delete phase — live-cursor exclusion", () => {
    it("protects a row a recipient's actionable mailbox cursor has not passed yet", () => {
      const { db, stmts } = setup()
      try {
        insertArchived(db, { id: "unread-msg", seq: 100, ts: Date.now() - 200 * DAY, recipient: "@chief" })
        db.prepare(
          `INSERT INTO mailbox_cursors (recipient, last_actionable_seq, updated_at)
           VALUES ('@chief', 50, ?)
           ON CONFLICT(recipient) DO UPDATE SET last_actionable_seq = 50`,
        ).run(Date.now())

        const result = runRetentionSweep(db, stmts, enabledConfig({ deleteWindowMs: 90 * DAY }))

        expect(result.archiveDelete.deleted).toBe(0)
        expect(result.archiveDelete.excludedByCursor).toBe(1)
        expect(result.archiveDelete.cursorFloor).toBe(50)
        expect(archivedIds(db)).toEqual(["unread-msg"])
      } finally {
        db.close()
      }
    })

    it("allows deletion once the mailbox cursor advances past the row's seq", () => {
      const { db, stmts } = setup()
      try {
        insertArchived(db, { id: "now-read-msg", seq: 100, ts: Date.now() - 200 * DAY, recipient: "@chief" })
        db.prepare(
          `INSERT INTO mailbox_cursors (recipient, last_actionable_seq, updated_at) VALUES ('@chief', 150, ?)`,
        ).run(Date.now())

        const result = runRetentionSweep(db, stmts, enabledConfig({ deleteWindowMs: 90 * DAY }))

        expect(result.archiveDelete.deleted).toBe(1)
        expect(archivedIds(db)).toEqual([])
      } finally {
        db.close()
      }
    })

    it("protects a row via the ambient sessions.last_inbox_pull_seq floor", () => {
      const { db, stmts } = setup()
      try {
        insertArchived(db, { id: "broadcast-msg", seq: 100, ts: Date.now() - 200 * DAY, recipient: "*" })
        db.prepare(
          `INSERT INTO sessions (id, name, role, domains, pid, started_at, updated_at, last_inbox_pull_seq)
           VALUES ('sess-lagging', '@agent/lagging', 'member', '[]', 1, ?, ?, 10)`,
        ).run(Date.now(), Date.now())

        const result = runRetentionSweep(db, stmts, enabledConfig({ deleteWindowMs: 90 * DAY }))

        expect(result.archiveDelete.deleted).toBe(0)
        expect(result.archiveDelete.excludedByCursor).toBe(1)
        expect(result.archiveDelete.cursorFloor).toBe(10)
        expect(archivedIds(db)).toEqual(["broadcast-msg"])
      } finally {
        db.close()
      }
    })

    it("imposes no cursor constraint at all on a database with no cursor rows", () => {
      const { db, stmts } = setup()
      try {
        insertArchived(db, { id: "no-cursors-anywhere", seq: 1, ts: Date.now() - 200 * DAY })

        const result = runRetentionSweep(db, stmts, enabledConfig({ deleteWindowMs: 90 * DAY }))

        expect(result.archiveDelete.cursorFloor).toBe(Number.MAX_SAFE_INTEGER)
        expect(result.archiveDelete.deleted).toBe(1)
      } finally {
        db.close()
      }
    })
  })

  // -------------------------------------------------------------------
  // Archive-delete phase — batch bounding
  // -------------------------------------------------------------------

  describe("archive-delete phase — batch bounding", () => {
    it("deletes at most batchSize rows per tick and reports the true eligible total", () => {
      const { db, stmts } = setup()
      try {
        for (let i = 0; i < 9; i += 1) {
          insertArchived(db, { id: `bulk-${i}`, seq: i + 1, ts: Date.now() - 200 * DAY })
        }
        const config = enabledConfig({ deleteWindowMs: 90 * DAY, batchSize: 4 })

        const first = runRetentionSweep(db, stmts, config)
        expect(first.archiveDelete.deleted).toBe(4)
        expect(first.archiveDelete.eligibleByAge).toBe(9) // not batch-capped — the true count
        expect(archivedIds(db)).toHaveLength(5)

        const second = runRetentionSweep(db, stmts, config)
        expect(second.archiveDelete.deleted).toBe(4)
        expect(archivedIds(db)).toHaveLength(1)

        const third = runRetentionSweep(db, stmts, config)
        expect(third.archiveDelete.deleted).toBe(1)
        expect(archivedIds(db)).toHaveLength(0)
      } finally {
        db.close()
      }
    })
  })

  // -------------------------------------------------------------------
  // Archive-delete phase — diagnostics accounting (backs the debug/info logs)
  // -------------------------------------------------------------------

  describe("archive-delete phase — diagnostics accounting", () => {
    it("counts eligible/excluded/deleted correctly across a mixed batch", () => {
      const { db, stmts } = setup()
      try {
        // Deletable: old, unreferenced, below the cursor floor.
        insertArchived(db, { id: "deletable", seq: 10, ts: Date.now() - 200 * DAY, recipient: "@chief" })
        // Pending-excluded: old, but an open ball still points at it.
        insertArchived(db, { id: "pending-protected", seq: 20, ts: Date.now() - 200 * DAY, recipient: "@chief" })
        stmts.openPendingRequest.run({
          $request_id: "req-1",
          $recipient: "@chief",
          $sender: "@fable/1",
          $opened_at: Date.now() - 200 * DAY,
          $expires_at: null,
          $message_id: "pending-protected",
          $fanout: "first",
        })
        // Cursor-excluded: old, unreferenced, but past the mailbox cursor.
        insertArchived(db, { id: "cursor-protected", seq: 30, ts: Date.now() - 200 * DAY, recipient: "@chief" })
        db.prepare(
          `INSERT INTO mailbox_cursors (recipient, last_actionable_seq, updated_at) VALUES ('@chief', 25, ?)`,
        ).run(Date.now())
        // Too fresh to be eligible by age at all — must not appear in any count.
        insertArchived(db, { id: "too-fresh", seq: 40, ts: Date.now() - 1 * DAY, recipient: "@chief" })

        const result = runRetentionSweep(db, stmts, enabledConfig({ deleteWindowMs: 90 * DAY }))

        expect(result.archiveDelete.eligibleByAge).toBe(3) // excludes too-fresh
        expect(result.archiveDelete.excludedByPending).toBe(1)
        expect(result.archiveDelete.excludedByCursor).toBe(1)
        expect(result.archiveDelete.deleted).toBe(1)
        expect(archivedIds(db).sort()).toEqual(["cursor-protected", "pending-protected", "too-fresh"].sort())
      } finally {
        db.close()
      }
    })
  })

  // -------------------------------------------------------------------
  // Whole-sweep smoke test
  // -------------------------------------------------------------------

  it("runs both phases in one call and returns a complete, consistent result", () => {
    const { db, stmts } = setup()
    try {
      const ctx = makeContext(db, stmts)
      const toArchive = sendMessage(ctx, "@chief", "will be archived this tick", "notify")
      setMessageTs(db, toArchive.id, Date.now() - 20 * DAY)
      insertArchived(db, { id: "will-be-deleted", seq: 1, ts: Date.now() - 200 * DAY })

      const result = runRetentionSweep(
        db,
        stmts,
        enabledConfig({ archiveWindowMs: 14 * DAY, deleteWindowMs: 90 * DAY }),
      )

      expect(result.archiveMove.moved).toBe(1)
      expect(result.archiveDelete.deleted).toBe(1)
      expect(liveIds(db)).toEqual([])
      expect(archivedIds(db)).toEqual([toArchive.id])
    } finally {
      db.close()
    }
  })
})
