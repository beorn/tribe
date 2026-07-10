/**
 * 19442 undead reframe — durable per-recipient actionable mailbox.
 *
 * Name-claim recovery must select the EXACT missed actionable directs
 * (request / query / verdict / assign addressed to the name) without
 * traversing unrelated history. The old mechanism — rewinding the session's
 * `last_inbox_pull_seq` — replayed every intervening ambient broadcast into
 * the model transcript (the 97-row flood: 49 joins + 48 health + 1 direct).
 *
 * The reframe: a `mailbox_cursors` row keyed by RECIPIENT (not session)
 * records the highest actionable rowid acknowledged for that mailbox. The
 * normal default-drain fetch injects unacked actionables ahead of the
 * ambient window and acknowledges what it returns. Rename / rejoin /
 * takeover retain the mailbox; the ambient session cursor is never rewound.
 *
 * Real SQLite throughout (openDatabase on a tmp file) — no fakes.
 */

import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"

const NAME = "@agent/3"

type ToolJson = Record<string, unknown>
type FetchEvent = { id: string; rowid: number; type: string; from: string; content: string }
type FetchJson = ToolJson & { events?: FetchEvent[]; cursor?: number }

function makeContext(db: Database, stmts: TribeStatements, sessionId: string, initialName: string): TribeContext {
  return createTribeContext({
    db,
    stmts,
    sessionId,
    sessionRole: "member",
    initialName,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
}

function makeOpts(activeIds: () => Set<string>): HandlerOpts {
  return {
    cleanup: () => {},
    userRenamed: false,
    setUserRenamed: () => {},
    getActiveSessionIds: activeIds,
    getActiveSessionInfo: () => [],
  }
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): ToolJson {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as ToolJson
}

type InsertSpec = {
  id: string
  type: string
  sender: string
  recipient: string
  kind: "direct" | "broadcast"
  content: string
  ts: number
}

function insertRow(stmts: TribeStatements, spec: InsertSpec): number {
  const res = stmts.insertMessage.run({
    $id: spec.id,
    $type: spec.type,
    $sender: spec.sender,
    $recipient: spec.recipient,
    $kind: spec.kind,
    $content: spec.content,
    $bead_id: null,
    $ref: null,
    $ts: spec.ts,
    $delivery: "push",
    $topic: null,
    $room_id: null,
    $request: null,
    $reply: null,
    $summary: null,
  })
  return Number(res.lastInsertRowid)
}

/** The verdict fixture: 49 join broadcasts + 48 health broadcasts. */
function insertAmbientFlood(stmts: TribeStatements, ts: number): void {
  for (let i = 0; i < 49; i++) {
    insertRow(stmts, {
      id: `join-${i}`,
      type: "notify",
      sender: "daemon",
      recipient: "*",
      kind: "broadcast",
      content: `unknown-${i} joined (member) pid=${1000 + i}`,
      ts: ts + i,
    })
  }
  for (let i = 0; i < 48; i++) {
    insertRow(stmts, {
      id: `health-${i}`,
      type: "health:daemon:warn",
      sender: "daemon",
      recipient: "*",
      kind: "broadcast",
      content: "[log-redacted]",
      ts: ts + 49 + i,
    })
  }
}

function fetchEvents(ctx: TribeContext, opts: HandlerOpts, args: Record<string, unknown> = {}): FetchEvent[] {
  const out = parseToolJson(handleToolCall(ctx, "tribe.fetch", { limit: 50, ...args }, opts)) as FetchJson
  return out.events ?? []
}

describe("19442 mailbox-cursor actionable recovery", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements
  let active: Set<string>
  let opts: HandlerOpts
  const now = Date.now()

  /**
   * Connect + claim a name the way a fresh adapter does. handleJoin's
   * fresh-row branch registers the session AND resets its delivery offsets to
   * the journal tail — the same tail-reset a real connect performs — so the
   * ambient window starts empty and anything older is reachable only through
   * the actionable mailbox.
   */
  function connectAs(sessionId: string, name: string): TribeContext {
    const ctx = makeContext(db, stmts, sessionId, `boot-${sessionId}`)
    active.add(sessionId)
    parseToolJson(handleToolCall(ctx, "tribe.join", { name, delivery: "pull" }, opts))
    return ctx
  }

  function disconnect(sessionId: string): void {
    active.delete(sessionId)
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mailbox-recovery-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
    active = new Set()
    opts = makeOpts(() => active)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("delivers ONLY the missed actionable after a name claim — 49 joins + 48 health + 1 direct → 1 event", () => {
    // Prior holder connects, claims the name, disconnects without draining.
    const a = connectAs("sess-a", NAME)
    disconnect("sess-a")
    void a

    // While the name is unheld: the ambient flood + one direct request.
    insertAmbientFlood(stmts, now - 30 * 60_000)
    const requestRowid = insertRow(stmts, {
      id: "the-assignment",
      type: "request",
      sender: "@chief",
      recipient: NAME,
      kind: "direct",
      content: "please pick up the wrapper-r4 assembly",
      ts: now - 20 * 60_000,
    })

    // Successor session claims the name (register → cursor at tail → join).
    const b = connectAs("sess-b", NAME)
    const events = fetchEvents(b, opts)

    expect(events.map((e) => e.id)).toEqual(["the-assignment"])
    expect(events[0]!.rowid).toBe(requestRowid)
    expect(events[0]!.type).toBe("request")
    // Zero ambient: no join lines, no health lines.
    expect(events.some((e) => e.content.includes("joined"))).toBe(false)
    expect(events.some((e) => e.content.includes("log-redacted"))).toBe(false)

    // Acked: the second default drain is empty.
    expect(fetchEvents(b, opts)).toEqual([])
  })

  it("reports the recovered count on the join result and never a rewound cursor", () => {
    const a = connectAs("sess-a", NAME)
    disconnect("sess-a")
    void a
    insertRow(stmts, {
      id: "q1",
      type: "query",
      sender: "@chief",
      recipient: NAME,
      kind: "direct",
      content: "status?",
      ts: now - 60_000,
    })

    const ctx = makeContext(db, stmts, "sess-b", "boot-sess-b")
    active.add("sess-b")
    const joined = parseToolJson(handleToolCall(ctx, "tribe.join", { name: NAME, delivery: "pull" }, opts))
    expect(joined.recovered_actionables).toBe(1)
    expect(joined.replayed_cursor).toBeUndefined()
  })

  it("retains the mailbox across repeated re-claims — an acked actionable never re-delivers", () => {
    const a = connectAs("sess-a", NAME)
    disconnect("sess-a")
    void a
    insertRow(stmts, {
      id: "r1",
      type: "request",
      sender: "@chief",
      recipient: NAME,
      kind: "direct",
      content: "first",
      ts: now - 60_000,
    })

    const b = connectAs("sess-b", NAME)
    expect(fetchEvents(b, opts).map((e) => e.id)).toEqual(["r1"])
    disconnect("sess-b")

    // New unheld-gap actionable, then a third claim: only the NEW one arrives.
    insertRow(stmts, {
      id: "r2",
      type: "verdict",
      sender: "@chief",
      recipient: NAME,
      kind: "direct",
      content: "second",
      ts: now - 30_000,
    })
    const c = connectAs("sess-c", NAME)
    expect(fetchEvents(c, opts).map((e) => e.id)).toEqual(["r2"])
    expect(fetchEvents(c, opts)).toEqual([])
  })

  it("recovers via rename (claiming an unheld loaded name)", () => {
    const a = connectAs("sess-a", NAME)
    disconnect("sess-a")
    void a
    insertRow(stmts, {
      id: "a1",
      type: "assign",
      sender: "@chief",
      recipient: NAME,
      kind: "direct",
      content: "take the lane",
      ts: now - 60_000,
    })

    const b = connectAs("sess-b", "@temp/1")
    const renamed = parseToolJson(handleToolCall(b, "tribe.rename", { new_name: NAME }, opts))
    expect(renamed.recovered_actionables).toBe(1)
    expect(fetchEvents(b, opts).map((e) => e.id)).toEqual(["a1"])
  })

  it("takeover of an ACTIVE holder retains the mailbox — an unacked actionable survives to the taker", () => {
    const b = connectAs("sess-b", NAME)
    void b
    // Request lands while b holds the name but never fetches.
    insertRow(stmts, {
      id: "r-live",
      type: "request",
      sender: "@chief",
      recipient: NAME,
      kind: "direct",
      content: "unacked while held",
      ts: now - 60_000,
    })
    // Explicit join takeover from a second live session (stale-adapter case).
    const d = connectAs("sess-d", NAME)
    expect(fetchEvents(d, opts).map((e) => e.id)).toEqual(["r-live"])
  })

  it("normal live fetch acknowledges in-window actionables so a successor does not re-recover them", () => {
    const b = connectAs("sess-b", NAME)
    insertRow(stmts, {
      id: "r-normal",
      type: "request",
      sender: "@chief",
      recipient: NAME,
      kind: "direct",
      content: "normal-window request",
      ts: now - 10_000,
    })
    // Live default drain returns it through the ordinary window…
    expect(fetchEvents(b, opts).map((e) => e.id)).toEqual(["r-normal"])
    disconnect("sess-b")
    // …and the mailbox remembers: the successor recovers nothing.
    const c = connectAs("sess-c", NAME)
    expect(fetchEvents(c, opts)).toEqual([])
  })

  it("recovery is lossless with NO age horizon — a 3-day-old missed request still arrives", () => {
    const a = connectAs("sess-a", NAME)
    disconnect("sess-a")
    void a
    insertRow(stmts, {
      id: "old-request",
      type: "request",
      sender: "@chief",
      recipient: NAME,
      kind: "direct",
      content: "ancient but actionable",
      ts: now - 3 * 24 * 60 * 60_000,
    })
    const b = connectAs("sess-b", NAME)
    expect(fetchEvents(b, opts).map((e) => e.id)).toEqual(["old-request"])
  })

  it("partial drains stay lossless — limit cuts the recovery batch, the ack follows only what was returned", () => {
    const a = connectAs("sess-a", NAME)
    disconnect("sess-a")
    void a
    for (const [i, id] of ["p1", "p2", "p3"].entries()) {
      insertRow(stmts, {
        id,
        type: "request",
        sender: "@chief",
        recipient: NAME,
        kind: "direct",
        content: `pending ${id}`,
        ts: now - 60_000 + i,
      })
    }
    const b = connectAs("sess-b", NAME)
    expect(fetchEvents(b, opts, { limit: 2 }).map((e) => e.id)).toEqual(["p1", "p2"])
    expect(fetchEvents(b, opts).map((e) => e.id)).toEqual(["p3"])
    expect(fetchEvents(b, opts)).toEqual([])
  })

  it("advance:false returns recovered actionables WITHOUT acknowledging them", () => {
    const a = connectAs("sess-a", NAME)
    disconnect("sess-a")
    void a
    insertRow(stmts, {
      id: "peek",
      type: "request",
      sender: "@chief",
      recipient: NAME,
      kind: "direct",
      content: "peeked",
      ts: now - 60_000,
    })
    const b = connectAs("sess-b", NAME)
    expect(fetchEvents(b, opts, { advance: false }).map((e) => e.id)).toEqual(["peek"])
    // Not acked — the next acknowledging drain still returns it.
    expect(fetchEvents(b, opts).map((e) => e.id)).toEqual(["peek"])
    expect(fetchEvents(b, opts)).toEqual([])
  })

  it("the actionable view is DIRECT-only: broadcast requests and self-sent requests never recover", () => {
    const a = connectAs("sess-a", NAME)
    disconnect("sess-a")
    void a
    insertRow(stmts, {
      id: "bcast-req",
      type: "request",
      sender: "@chief",
      recipient: "*",
      kind: "broadcast",
      content: "anyone: take this",
      ts: now - 60_000,
    })
    insertRow(stmts, {
      id: "self-req",
      type: "request",
      sender: NAME,
      recipient: NAME,
      kind: "direct",
      content: "note to self",
      ts: now - 50_000,
    })
    const b = connectAs("sess-b", NAME)
    expect(fetchEvents(b, opts)).toEqual([])
  })

  it("non-actionable directs (notify/status) are ambient — never recovered on claim", () => {
    const a = connectAs("sess-a", NAME)
    disconnect("sess-a")
    void a
    insertRow(stmts, {
      id: "fyi",
      type: "notify",
      sender: "@chief",
      recipient: NAME,
      kind: "direct",
      content: "fyi only",
      ts: now - 60_000,
    })
    insertRow(stmts, {
      id: "st",
      type: "status",
      sender: "@agent/2",
      recipient: NAME,
      kind: "direct",
      content: "status line",
      ts: now - 50_000,
    })
    const b = connectAs("sess-b", NAME)
    expect(fetchEvents(b, opts)).toEqual([])
  })

  it("same-name rejoin is a refresh: drained ambient history stays drained and nothing re-recovers", () => {
    const b = connectAs("sess-b", NAME)
    insertRow(stmts, {
      id: "seen",
      type: "request",
      sender: "@chief",
      recipient: NAME,
      kind: "direct",
      content: "seen once",
      ts: now - 60_000,
    })
    expect(fetchEvents(b, opts).map((e) => e.id)).toEqual(["seen"])
    const rejoin = parseToolJson(handleToolCall(b, "tribe.join", { name: NAME, delivery: "pull" }, opts))
    expect(rejoin.recovered_actionables).toBeUndefined()
    expect(fetchEvents(b, opts)).toEqual([])
  })
})
