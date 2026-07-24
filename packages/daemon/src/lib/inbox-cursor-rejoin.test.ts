/**
 * @km/tribe/20032 - same-session join must not rewind a drained pull cursor.
 *
 * A pull client can re-run `tribe.join({ name })` during /up. That is a
 * refresh of the same named session, not a name claim. Replaying name-claim
 * gap directs here ignores the caller's own `last_inbox_pull_seq` and can
 * rewind default fetch into already-drained history.
 */

import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"
import { registerSession } from "./session.ts"

const NAME = "@chief"
const SESSION_ID = "sess-chief"
const PROJECT_ID = "cursor-rejoin-proj"

type ToolJson = Record<string, unknown>
type FetchJson = ToolJson & { events?: Array<{ id: string; rowid: number; content: string }>; cursor?: number }

function makeContext(db: Database, stmts: TribeStatements): TribeContext {
  return createTribeContext({
    db,
    stmts,
    sessionId: SESSION_ID,
    sessionRole: "member",
    initialName: NAME,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
}

function makeOpts(): HandlerOpts {
  return {
    cleanup: () => {},
    userRenamed: false,
    setUserRenamed: () => {},
    getActiveSessionIds: () => new Set([SESSION_ID]),
    hasActiveTransport: (sessionId) => sessionId === SESSION_ID,
    getActiveSessionInfo: () => [],
  }
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): ToolJson {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as ToolJson
}

function insertDirect(stmts: TribeStatements, content: string): number {
  const res = stmts.insertMessage.run({
    $id: `msg-${content}`,
    $type: "request",
    $sender: "@agent/1",
    $recipient: NAME,
    $kind: "direct",
    $content: content,
    $bead_id: null,
    $ref: null,
    $ts: Date.now() - 60_000,
    $delivery: "pull",
    $topic: null,
    $room_id: null,
    $request: null,
    $reply: null,
  })
  return Number(res.lastInsertRowid)
}

describe("@km/tribe/20032 - pull cursor monotonicity across same-session join", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "inbox-cursor-rejoin-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("does not replay already-drained ambient history after /up re-joins the same pull session", () => {
    const ctx = makeContext(db, stmts)
    const opts = makeOpts()

    registerSession(ctx, PROJECT_ID, () => true, null, 1234, "pull", "/repo", null, "codex")
    const drainedRowid = insertDirect(stmts, "already drained")

    const firstDrain = parseToolJson(handleToolCall(ctx, "tribe.fetch", { limit: 50 }, opts)) as FetchJson
    expect(firstDrain.events?.map((event) => event.content)).toEqual(["already drained"])
    expect(firstDrain.cursor).toBe(drainedRowid)

    const rejoin = parseToolJson(handleToolCall(ctx, "tribe.join", { name: NAME, delivery: "pull" }, opts))
    expect(rejoin.replayed_cursor).toBeUndefined()

    const afterRejoin = parseToolJson(handleToolCall(ctx, "tribe.fetch", { limit: 50 }, opts)) as FetchJson
    expect(afterRejoin.events).toEqual([])
    expect(afterRejoin.cursor).toBe(drainedRowid)
  })

  it("operator repair can advance a regressed named inbox cursor to the journal tail", () => {
    const ctx = makeContext(db, stmts)
    const opts = makeOpts()

    registerSession(ctx, PROJECT_ID, () => true, null, 1234, "pull", "/repo", null, "codex")
    const drainedRowid = insertDirect(stmts, "stale replay row")
    parseToolJson(handleToolCall(ctx, "tribe.fetch", { limit: 50 }, opts))

    db.prepare("UPDATE sessions SET last_inbox_pull_seq = ? WHERE id = ?").run(drainedRowid - 1, SESSION_ID)

    const repair = parseToolJson(handleToolCall(ctx, "tribe.repair", { session: NAME, inbox_cursor: "tail" }, opts))
    expect(repair).toMatchObject({
      repaired: true,
      session: NAME,
      cursor_before: drainedRowid - 1,
      cursor_after: drainedRowid,
      tail: drainedRowid,
    })

    const afterRepair = parseToolJson(handleToolCall(ctx, "tribe.fetch", { limit: 50 }, opts)) as FetchJson
    expect(afterRepair.events).toEqual([])
    expect(afterRepair.cursor).toBe(drainedRowid)
  })

  it("operator repair can create a cursor checkpoint for an absent named session", () => {
    const ctx = makeContext(db, stmts)
    const opts = makeOpts()
    const tail = insertDirect(stmts, "absent chief backlog")

    const repair = parseToolJson(handleToolCall(ctx, "tribe.repair", { session: NAME, inbox_cursor: "tail" }, opts))
    expect(repair).toMatchObject({
      repaired: true,
      created_session: true,
      session: NAME,
      cursor_before: 0,
      cursor_after: tail,
      tail,
    })

    const row = db
      .prepare("SELECT name, role, pid, delivery, last_inbox_pull_seq FROM sessions WHERE name = ?")
      .get(NAME) as { name: string; role: string; pid: number; delivery: string; last_inbox_pull_seq: number } | null
    expect(row).toMatchObject({
      name: NAME,
      role: "member",
      pid: 0,
      delivery: "pull",
      last_inbox_pull_seq: tail,
    })
  })
})
