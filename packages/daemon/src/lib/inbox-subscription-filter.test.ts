/**
 * The stored subscription must govern the PULL drain, not just the push wakeup.
 *
 * Measured on the live journal 2026-08-14: broadcast rows are 5.3% of storage
 * and 79.3% of everything agents read, because one row addressed to `*` is read
 * by every draining seat. `tribe.filter` existed to fix exactly that and could
 * not: `shouldDeliver` has one call site, inside the push pipeline, and 62 of 63
 * sessions are `delivery=pull`. `@cto` had `mode: focus` persisted on a pull
 * session — accepted, stored, and removing nothing.
 *
 * Even on push it would not have helped, because that filter gates the wakeup
 * notification rather than the fetch: "the durable message log is the bus; push
 * only tells clients to fetch it."
 *
 * @failure A seat's subscription is accepted and silently ignored on the path
 *          that actually carries content.
 * @level   l2
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

const NAME = "@cto"
const SESSION_ID = "sess-cto"
const PROJECT_ID = "subscription-filter-proj"

type ToolJson = Record<string, unknown>
type FetchJson = ToolJson & { events?: Array<{ content: string; rowid: number; type: string }>; cursor?: number }

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

function parse(result: ReturnType<typeof handleToolCall>): ToolJson {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as ToolJson
}

let seq = 0
function insert(
  stmts: TribeStatements,
  opts: { content: string; kind?: string; recipient?: string; topic?: string | null; type?: string },
): number {
  seq += 1
  const res = stmts.insertMessage.run({
    $id: `msg-${seq}-${opts.content}`,
    $type: opts.type ?? "status",
    $sender: "@daemon",
    $recipient: opts.recipient ?? "*",
    $kind: opts.kind ?? "broadcast",
    $content: opts.content,
    $bead_id: null,
    $ref: null,
    $ts: Date.now() - 60_000,
    $delivery: "pull",
    $topic: opts.topic ?? null,
    $room_id: null,
    $request: null,
    $reply: null,
  })
  return Number(res.lastInsertRowid)
}

/**
 * The production broadcast mix, in miniature.
 *
 * Topics are deliberately outside the registered trust set (`health:*` is tier
 * `daemon` and needs roster authorisation) so these tests measure the
 * subscription and nothing else. The trust interaction is pinned separately
 * below, so a later reader does not mistake one filter for the other.
 */
function seedFleetTraffic(stmts: TribeStatements): void {
  insert(stmts, { content: "reaper unknown", topic: "ops:reaper:unknown", type: "ops:reaper:unknown" })
  insert(stmts, { content: "someone pushed", topic: "github:push", type: "github:push" })
  insert(stmts, { content: "cpu warning", topic: "ops:cpu:warning", type: "ops:cpu:warning" })
  insert(stmts, { content: "please do the thing", type: "request" })
}

describe("stored subscription governs the pull drain", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "inbox-subscription-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function drain(ctx: TribeContext, opts: HandlerOpts): FetchJson {
    return parse(handleToolCall(ctx, "tribe.fetch", { limit: 50 }, opts)) as FetchJson
  }

  it("focus keeps actionable fleet traffic and drops the rest — the @cto specimen", () => {
    const ctx = makeContext(db, stmts)
    const opts = makeOpts()
    registerSession(ctx, PROJECT_ID, () => true, null, 1234, "pull", "/repo", null, "codex")

    parse(handleToolCall(ctx, "tribe.filter", { mode: "focus" }, opts))
    seedFleetTraffic(stmts)

    const events = drain(ctx, opts).events ?? []
    expect(events.map((e) => e.content)).toEqual(["please do the thing"])
  })

  it("normal delivers the same traffic — the diet is opt-in, not imposed", () => {
    const ctx = makeContext(db, stmts)
    const opts = makeOpts()
    registerSession(ctx, PROJECT_ID, () => true, null, 1234, "pull", "/repo", null, "codex")

    seedFleetTraffic(stmts)

    expect((drain(ctx, opts).events ?? []).length).toBe(4)
  })

  it("a topic mute removes matching broadcasts while the window is active", () => {
    const ctx = makeContext(db, stmts)
    const opts = makeOpts()
    registerSession(ctx, PROJECT_ID, () => true, null, 1234, "pull", "/repo", null, "codex")

    parse(handleToolCall(ctx, "tribe.filter", { mute: ["ops:*"], until: Date.now() + 3_600_000 }, opts))
    seedFleetTraffic(stmts)

    const contents = (drain(ctx, opts).events ?? []).map((e) => e.content)
    expect(contents).not.toContain("reaper unknown")
    expect(contents).not.toContain("cpu warning")
    expect(contents).toContain("someone pushed")
  })

  it("leaves the pre-existing trust filter alone — daemon-tier topics still need a roster", () => {
    const ctx = makeContext(db, stmts)
    const opts = makeOpts()
    registerSession(ctx, PROJECT_ID, () => true, null, 1234, "pull", "/repo", null, "codex")

    // `health:*` is trust tier `daemon`. An unauthorised sender's row is dropped
    // by filterRowsByTrust regardless of subscription — that filter answers
    // "may this sender claim this topic", which the subscription never does.
    insert(stmts, { content: "spoofed health", topic: "health:cpu:warning", type: "health:cpu:warning" })
    insert(stmts, { content: "ordinary news", topic: "ops:whatever", type: "status" })

    expect((drain(ctx, opts).events ?? []).map((e) => e.content)).toEqual(["ordinary news"])
  })

  it("never filters a message addressed to this seat by name", () => {
    const ctx = makeContext(db, stmts)
    const opts = makeOpts()
    registerSession(ctx, PROJECT_ID, () => true, null, 1234, "pull", "/repo", null, "codex")

    parse(handleToolCall(ctx, "tribe.filter", { mute: ["*"], until: Date.now() + 3_600_000 }, opts))
    insert(stmts, { content: "for you only", kind: "direct", recipient: NAME, topic: "anything", type: "notify" })

    const raw = JSON.stringify(drain(ctx, opts))
    expect(raw).toContain("for you only")
  })

  it("advances the cursor over excluded rows instead of re-scanning them forever", () => {
    const ctx = makeContext(db, stmts)
    const opts = makeOpts()
    registerSession(ctx, PROJECT_ID, () => true, null, 1234, "pull", "/repo", null, "codex")

    parse(handleToolCall(ctx, "tribe.filter", { mode: "focus" }, opts))
    let last = 0
    for (let i = 0; i < 20; i++) {
      last = insert(stmts, { content: `noise ${i}`, topic: "health:cpu:warning", type: "health:cpu:warning" })
    }

    // Every row is excluded, so the drain is empty — but the cursor must still
    // move past them. Parking it would re-scan a tail that grows without bound,
    // which is the shape of the query that cost 590k page reads.
    const first = drain(ctx, opts)
    expect(first.events ?? []).toEqual([])
    expect(first.cursor).toBe(last)

    const cursorRow = db.prepare("SELECT last_inbox_pull_seq AS seq FROM sessions WHERE id = ?").get(SESSION_ID) as {
      seq: number
    }
    expect(cursorRow.seq).toBe(last)
  })

  it("never advances past a row it would have delivered, even behind a wall of excluded ones", () => {
    const ctx = makeContext(db, stmts)
    const opts = makeOpts()
    registerSession(ctx, PROJECT_ID, () => true, null, 1234, "pull", "/repo", null, "codex")

    parse(handleToolCall(ctx, "tribe.filter", { mode: "focus" }, opts))
    const noise = () => insert(stmts, { content: "noise", topic: "ops:noise", type: "status" })
    for (let i = 0; i < 5; i++) noise()
    insert(stmts, { content: "first real", type: "request" })
    for (let i = 0; i < 5; i++) noise()
    insert(stmts, { content: "second real", type: "request" })

    // A FULL window means there may be more behind it, so the cursor must stop
    // at the last row it returned. Jumping to the high-water mark here would
    // consume "second real" unread — the 19785 message-loss class, which is why
    // the jump is gated on the window coming back short.
    const first = parse(handleToolCall(ctx, "tribe.fetch", { limit: 1 }, opts)) as FetchJson
    expect((first.events ?? []).map((e) => e.content)).toEqual(["first real"])

    const second = parse(handleToolCall(ctx, "tribe.fetch", { limit: 1 }, opts)) as FetchJson
    expect((second.events ?? []).map((e) => e.content)).toEqual(["second real"])
  })

  it("survives malformed mute JSON by muting rather than by taking the drain down", () => {
    const ctx = makeContext(db, stmts)
    const opts = makeOpts()
    registerSession(ctx, PROJECT_ID, () => true, null, 1234, "pull", "/repo", null, "codex")

    db.prepare("UPDATE sessions SET filter_mode = 'normal', filter_until = ?, filter_mute = ? WHERE id = ?").run(
      Date.now() + 3_600_000,
      "{not json",
      SESSION_ID,
    )
    seedFleetTraffic(stmts)

    // Matches safeJsonArray + shouldDeliver: unparseable mute means "mute
    // everything", never a raised error that would strand the seat entirely.
    const events = drain(ctx, opts).events ?? []
    expect(events.map((e) => e.content)).toEqual([])
  })
})
