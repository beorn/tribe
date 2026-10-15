/**
 * @failure Git facts or their source frontier survive alone after a failed publication, or a changed replay reuses an event ID.
 * @level l1
 * @consumer the Git connector and its future Km feeder reading Wire's journal.
 * @testonly none
 */
import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createTribeContext } from "./context.ts"
import { createStatements, openDatabase } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"
import { publishConnectorBatch } from "./messaging.ts"
import { runRetentionSweep, type RetentionConfig } from "./retention.ts"
import { registerSession } from "./session.ts"
import { withBroadcast } from "./compose/with-broadcast.ts"
import { withClientRegistry } from "./compose/with-client-registry.ts"

const open: Array<{ dir: string; db: Database }> = []
afterEach(() => {
  for (const item of open.splice(0)) {
    item.db.close()
    rmSync(item.dir, { recursive: true, force: true })
  }
})

function fixture(onWake?: (db: Database, id: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "tribe-connector-journal-"))
  const db = openDatabase(join(dir, "tribe.db"))
  const wake: string[] = []
  const ctx = createTribeContext({
    db,
    stmts: createStatements(db),
    sessionId: "connector-test",
    sessionRole: "daemon",
    initialName: "daemon",
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
    onMessageInserted: (message) => {
      wake.push(message.id)
      onWake?.(db, message.id)
    },
  })
  open.push({ dir, db })
  return { dir, db, ctx, wake }
}

const first = {
  sourceId: "code",
  expectedFrontier: null,
  nextFrontier: '{"version":1,"tips":["a"]}',
  schemaDigest: "schema-v1",
  events: [
    {
      id: "git:v1:a",
      kind: "git.commit",
      content: '{"oid":"a","subject":"first"}',
      topic: "git:commit",
      summary: "git a: first",
    },
  ],
} as const

describe("connector journal publication", () => {
  it("keeps a 100-event burst out of ordinary fetch and push while a positioned reader sees all rows", () => {
    const { db, ctx } = fixture()
    const seat = createTribeContext({
      db,
      stmts: ctx.stmts,
      sessionId: "ordinary-seat",
      sessionRole: "member",
      initialName: "@ordinary",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    registerSession(seat, "connector-test", () => true, null, 1234, "push", "/repo", null, "codex")
    const deferred: Array<() => void> = []
    const scope = { defer: (fn: () => void) => deferred.push(fn) }
    const { registry } = withClientRegistry()({ scope, startedAt: 0 } as never)
    const writes: string[] = []
    registry.attachTransport("ordinary", {
      id: "ordinary",
      name: "@ordinary",
      role: "member",
      delivery: "push",
      ctx: seat,
      socket: { destroyed: false, writable: true, write: (text: string) => writes.push(text) },
    } as never)
    withBroadcast()({ scope, stmts: ctx.stmts, daemonCtx: ctx, registry } as never)
    try {
      const events = Array.from({ length: 100 }, (_, index) => ({
        id: `git:v1:burst-${String(index).padStart(3, "0")}`,
        kind: "git.commit",
        content: JSON.stringify({ oid: `burst-${index}`, subject: `commit ${index}` }),
        topic: "git:commit",
        summary: `git burst-${index}: commit ${index}`,
      }))
      expect(publishConnectorBatch(ctx, { ...first, events }).kind).toBe("committed")
      const opts: HandlerOpts = {
        cleanup: () => {},
        userRenamed: false,
        setUserRenamed: () => {},
        getActiveSessionIds: () => new Set([seat.sessionId]),
        hasActiveTransport: (id) => id === seat.sessionId,
        getActiveSessionInfo: () => [],
      }
      const result = handleToolCall(seat, "tribe.fetch", {}, opts) as { content: Array<{ text: string }> }
      const fetched = JSON.parse(result.content[0]?.text ?? "{}") as { events?: Array<{ id: string }> }
      expect(fetched.events?.some((event) => event.id.startsWith("git:v1:burst-")) ?? false).toBe(false)
      expect(writes).toEqual([])
      const positioned = db
        .query("SELECT id FROM messages WHERE kind='event' AND type='event.git.commit' ORDER BY rowid")
        .all() as Array<{ id: string }>
      expect(positioned.map((row) => row.id)).toEqual(events.map((event) => event.id))
      expect(db.query("SELECT delivery, topic, summary FROM messages WHERE id=?").get(events[0]!.id)).toEqual({
        delivery: "pull",
        topic: "git:commit",
        summary: events[0]!.summary,
      })
    } finally {
      for (const dispose of deferred.reverse()) dispose()
    }
  })

  it("advances an empty frontier without a wake and refuses a stale writer without partial rows", () => {
    const { db, ctx, wake } = fixture()
    const empty = { ...first, events: [] }
    expect(publishConnectorBatch(ctx, empty)).toMatchObject({ kind: "committed", inserted: 0, replayed: 0 })
    expect(wake).toEqual([])
    expect(publishConnectorBatch(ctx, empty).kind).toBe("already-held")
    expect(
      publishConnectorBatch(ctx, {
        ...first,
        nextFrontier: '{"version":1,"tips":["other"]}',
        events: [
          {
            id: "git:v1:other",
            kind: "git.commit",
            content: '{"oid":"other"}',
            topic: "git:commit",
            summary: "git other",
          },
        ],
      }).kind,
    ).toBe("frontier-conflict")
    expect(db.query("SELECT id FROM messages WHERE id='git:v1:other'").get()).toBeNull()
  })

  it("wakes readers only after the event and frontier have both committed", () => {
    let observed: unknown
    const { ctx } = fixture((db, id) => {
      observed = {
        event: db.query("SELECT id FROM messages WHERE id=?").get(id),
        frontier: db
          .query("SELECT value FROM coordination WHERE project_id='connector:code' AND key='frontier.v1'")
          .get(),
      }
    })
    expect(publishConnectorBatch(ctx, first).kind).toBe("committed")
    expect(observed).toMatchObject({ event: { id: first.events[0].id }, frontier: { value: first.nextFrontier } })
  })

  it("commits event rows with the frontier, replays equal bytes, and rejects changed bytes", () => {
    const { db, ctx, wake } = fixture()
    const committed = publishConnectorBatch(ctx, first)
    expect(committed.kind).toBe("committed")
    expect(db.query("SELECT id, content FROM messages WHERE kind='event'").all()).toMatchObject([
      { id: "git:v1:a", content: first.events[0].content },
    ])
    expect(
      db.query("SELECT value FROM coordination WHERE project_id='connector:code' AND key='frontier.v1'").get(),
    ).toMatchObject({
      value: first.nextFrontier,
    })
    expect(wake).toEqual(["git:v1:a"])

    expect(publishConnectorBatch(ctx, first).kind).toBe("already-held")
    expect(wake).toEqual(["git:v1:a"])
    expect(
      publishConnectorBatch(ctx, {
        ...first,
        events: [{ ...first.events[0], content: '{"oid":"a","subject":"changed"}' }],
      }).kind,
    ).toBe("payload-conflict")
  })

  it("rolls back a newly inserted event if frontier persistence fails", () => {
    const { db, ctx, wake } = fixture()
    expect(publishConnectorBatch(ctx, first).kind).toBe("committed")
    db.run(`CREATE TRIGGER refuse_connector_frontier BEFORE UPDATE ON coordination
      WHEN NEW.project_id='connector:code' BEGIN SELECT RAISE(ABORT, 'injected frontier failure'); END`)

    expect(
      publishConnectorBatch(ctx, {
        ...first,
        expectedFrontier: first.nextFrontier,
        nextFrontier: '{"version":1,"tips":["b"]}',
        events: [
          {
            id: "git:v1:b",
            kind: "git.commit",
            content: '{"oid":"b","subject":"second"}',
            topic: "git:commit",
            summary: "git b: second",
          },
        ],
      }),
    ).toMatchObject({ kind: "publication-unknown", detail: "injected frontier failure" })
    expect(db.query("SELECT id FROM messages WHERE id='git:v1:b'").all()).toEqual([])
    expect(
      db.query("SELECT value FROM coordination WHERE project_id='connector:code' AND key='frontier.v1'").get(),
    ).toMatchObject({
      value: first.nextFrontier,
    })
    expect(wake).toEqual(["git:v1:a"])
  })

  it("rolls back the first insert when a later event in the same batch fails", () => {
    const { db, ctx, wake } = fixture()
    db.run(`CREATE TRIGGER refuse_second_event BEFORE INSERT ON messages
      WHEN NEW.id='git:v1:c' BEGIN SELECT RAISE(ABORT, 'injected second insert failure'); END`)
    const result = publishConnectorBatch(ctx, {
      ...first,
      events: [
        first.events[0],
        { id: "git:v1:c", kind: "git.commit", content: '{"oid":"c"}', topic: "git:commit", summary: "git c" },
      ],
    })
    expect(result).toMatchObject({ kind: "publication-unknown", detail: "injected second insert failure" })
    expect(db.query("SELECT id FROM messages WHERE id LIKE 'git:v1:%'").all()).toEqual([])
    expect(db.query("SELECT value FROM coordination WHERE project_id='connector:code'").get()).toBeNull()
    expect(wake).toEqual([])
  })

  it("replays from the archive and names the gap after cold export deletes its row", () => {
    const { dir, db, ctx } = fixture()
    const day = 24 * 60 * 60 * 1000
    const now = Date.now()
    expect(publishConnectorBatch(ctx, first).kind).toBe("committed")
    db.query("UPDATE messages SET ts = ? WHERE id = ?").run(now - 100 * day, first.events[0].id)
    const config: RetentionConfig = {
      archiveWindowMs: 14 * day,
      deleteWindowMs: 90 * day,
      deleteEnabled: false,
      batchSize: 500,
      liveWindowMs: 7 * day,
      exportDir: join(dir, "archive-export"),
    }
    expect(runRetentionSweep(db, ctx.stmts, config, now).archiveMove.moved).toBe(1)
    expect(publishConnectorBatch(ctx, first).kind).toBe("already-held")
    expect(
      publishConnectorBatch(ctx, { ...first, events: [{ ...first.events[0], content: '{"oid":"changed"}' }] }).kind,
    ).toBe("payload-conflict")

    const oldEnabled = process.env.TRIBE_RETENTION_DELETE_ENABLED
    const oldDir = process.env.TRIBE_RETENTION_EXPORT_DIR
    try {
      process.env.TRIBE_RETENTION_DELETE_ENABLED = "1"
      process.env.TRIBE_RETENTION_EXPORT_DIR = config.exportDir
      expect(runRetentionSweep(db, ctx.stmts, { ...config, deleteEnabled: true }, now).archiveDelete.deleted).toBe(1)
      expect(publishConnectorBatch(ctx, first)).toMatchObject({ kind: "source-gap", eventId: first.events[0].id })
      expect(db.query("SELECT id FROM messages WHERE id = ?").get(first.events[0].id)).toBeNull()
    } finally {
      if (oldEnabled === undefined) delete process.env.TRIBE_RETENTION_DELETE_ENABLED
      else process.env.TRIBE_RETENTION_DELETE_ENABLED = oldEnabled
      if (oldDir === undefined) delete process.env.TRIBE_RETENTION_EXPORT_DIR
      else process.env.TRIBE_RETENTION_EXPORT_DIR = oldDir
    }
  })
})
