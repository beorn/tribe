/**
 * @failure a default tribe.fetch returns each actionable message's body TWICE
 *          in one response — once under `attention.actionable_unread` and again
 *          under `events` — so a pane that forwards both lists forwards the
 *          same body twice and the model pays for it twice (#27488 must-hold A).
 * @level   l1
 * @consumer 27488 phase 1 read side; @tribe/wire's drainDaemonInbox, which
 *           forwards every attention AND ambient row as a <channel> envelope.
 * @testonly none
 *
 * 27488 must-hold A — one body per read.
 *
 * @cto's ruling (/hh/var/@cto/2026-10-04-ruling-27488-flood-endstate.md) made
 * this a phase-1 must-hold: "within one read response a body appears once."
 * The default drain builds `attention.actionable_unread` from the owned
 * attention projection and `events` from the chronological window; the same
 * message satisfies both, so its body is duplicated inside one response.
 *
 * RED-first: the first case fails before the fix (the id is in both lists).
 */
import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"
import { registerSession } from "./session.ts"

const SEAT = "@dev/3"
const SENDER = "@chief"
const TS_MS = Date.UTC(2026, 9, 5, 6, 0, 0)

type Fixture = { dir: string; db: Database; stmts: TribeStatements; ctx: TribeContext }
const opened: Fixture[] = []

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tribe-27488-"))
  const db = openDatabase(join(dir, "tribe.db"))
  const stmts = createStatements(db)
  const ctx = createTribeContext({
    db,
    stmts,
    sessionId: "sess-27488",
    sessionRole: "member",
    initialName: SEAT,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
  registerSession(ctx, undefined, () => false, null, 0, "pull")
  const built = { dir, db, stmts, ctx }
  opened.push(built)
  return built
}

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.db.close()
    rmSync(item.dir, { recursive: true, force: true })
  }
})

const handlerOpts = (): HandlerOpts => ({
  cleanup: () => {},
  userRenamed: false,
  setUserRenamed: () => {},
  getActiveSessionIds: () => new Set<string>(),
  hasActiveTransport: () => false,
  getActiveSessionInfo: () => [],
})

type Row = { id: string }
type Drain = { attention?: { actionable_unread?: Row[] }; events?: Row[] }

async function drain(ctx: TribeContext): Promise<Drain> {
  const result = await handleToolCall(ctx, "tribe.fetch", { limit: 500 }, handlerOpts())
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Drain
}

/** A direct request to SEAT with an open pending row: actionable, owned, untaken. */
function openBall(stmts: TribeStatements, id: string): void {
  stmts.insertMessage.run({
    $id: id,
    $type: "request",
    $sender: SENDER,
    $recipient: SEAT,
    $kind: "direct",
    $content: "please take this",
    $bead_id: null,
    $ref: null,
    $ts: TS_MS,
    $delivery: "push",
    $topic: null,
    $room_id: null,
    $request: id,
    $reply: null,
    $summary: null,
  })
  stmts.openPendingRequest.run({
    $request_id: id,
    $recipient: SEAT,
    $sender: SENDER,
    $opened_at: TS_MS,
    $expires_at: TS_MS + 60_000,
    $message_id: id,
    $fanout: "first",
  })
}

/** An ambient notify with no pending row: a body that belongs ONLY in events. */
function ambient(stmts: TribeStatements, id: string): void {
  stmts.insertMessage.run({
    $id: id,
    $type: "notify",
    $sender: SENDER,
    $recipient: SEAT,
    $kind: "direct",
    $content: "fyi",
    $bead_id: null,
    $ref: null,
    $ts: TS_MS + 1,
    $delivery: "push",
    $topic: null,
    $room_id: null,
    $request: null,
    $reply: null,
    $summary: null,
  })
}

describe("27488 must-hold A — one body per read", () => {
  it("returns an actionable row's body in attention ONLY, never also in events", async () => {
    const { stmts, ctx } = fixture()
    openBall(stmts, "req-a")
    const result = await drain(ctx)
    const inAttention = (result.attention?.actionable_unread ?? []).filter((row) => row.id === "req-a")
    const inEvents = (result.events ?? []).filter((row) => row.id === "req-a")
    expect(inAttention).toHaveLength(1)
    expect(inEvents).toHaveLength(0)
  })

  it("control: a non-actionable ambient row still arrives exactly once, in events", async () => {
    const { stmts, ctx } = fixture()
    ambient(stmts, "note-a")
    const result = await drain(ctx)
    const inAttention = (result.attention?.actionable_unread ?? []).filter((row) => row.id === "note-a")
    const inEvents = (result.events ?? []).filter((row) => row.id === "note-a")
    expect(inAttention).toHaveLength(0)
    expect(inEvents).toHaveLength(1)
  })

  it("control: two actionable rows each appear exactly once across the whole response", async () => {
    const { stmts, ctx } = fixture()
    openBall(stmts, "req-b1")
    openBall(stmts, "req-b2")
    const result = await drain(ctx)
    const all = [...(result.attention?.actionable_unread ?? []), ...(result.events ?? [])]
    expect(all.filter((row) => row.id === "req-b1")).toHaveLength(1)
    expect(all.filter((row) => row.id === "req-b2")).toHaveLength(1)
  })
})
