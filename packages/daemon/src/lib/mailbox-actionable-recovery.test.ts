/**
 * 19442 / 21757 — durable per-recipient attention mailbox.
 *
 * Name-claim recovery must select the EXACT missed durable-attention directs
 * (actionables plus newly classified responses addressed to the name) without
 * traversing unrelated history. The old mechanism — rewinding the session's
 * `last_inbox_pull_seq` — replayed every intervening ambient broadcast into
 * the model transcript (the 97-row flood: 49 joins + 48 health + 1 direct).
 *
 * The reframe: a `mailbox_cursors` row keyed by RECIPIENT (not session)
 * records the highest durable-attention rowid acknowledged for that mailbox.
 * The normal default-drain fetch injects unacked attention ahead of the
 * ambient window and acknowledges what it returns. Rename / rejoin /
 * takeover retain the mailbox; the ambient session cursor is never rewound.
 *
 * Real SQLite throughout (openDatabase on a tmp file) — no fakes.
 */

import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"

const NAME = "@agent/3"

type ToolJson = Record<string, unknown>
type FetchEvent = { id: string; rowid: number; type: string; from: string; content: string }
type AttentionBall = {
  request_id: string
  sender: string
  message_id: string
  fanout: string
}
type FetchJson = ToolJson & {
  attention?: {
    actionable_unread?: FetchEvent[]
    pending_balls?: AttentionBall[]
    pending_balls_summary?: { total: number; oldest_age_ms: number }
  }
  events?: FetchEvent[]
  cursor?: number
}

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
    hasActiveTransport: (sessionId) => activeIds().has(sessionId),
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

function fetchJson(
  ctx: TribeContext,
  opts: HandlerOpts,
  args: Record<string, unknown> = {},
): { json: FetchJson; raw: string } {
  const result = handleToolCall(ctx, "tribe.fetch", { limit: 50, ...args }, opts)
  const raw = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return { json: JSON.parse(raw) as FetchJson, raw }
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
   * the attention mailbox.
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

  it("recovers a response that closed its tracked ball while the requester was parked", () => {
    const requester = connectAs("sess-requester", NAME)
    const chief = connectAs("sess-chief", "@chief")
    const request = parseToolJson(
      handleToolCall(
        requester,
        "tribe.send",
        {
          to: "@chief",
          message: "choose the implementation seam",
          type: "request",
          request: true,
        },
        opts,
      ),
    ) as { id: string }

    disconnect("sess-requester")
    const response = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        {
          to: NAME,
          message: "use the durable attention seam",
          type: "response",
          reply: request.id,
        },
        opts,
      ),
    ) as { id: string; tracker?: { request_id: string; closed: number } }

    expect(response.tracker).toEqual({ request_id: request.id, closed: 1 })
    expect(db.prepare("SELECT id, attention_required FROM messages WHERE id = ?").get(response.id)).toEqual({
      id: response.id,
      attention_required: 1,
    })
    expect(stmts.getUnreadDms.get({ $name: NAME })).toMatchObject({ count: 0 })

    // A real reconnect resets the successor's chronological cursor to the
    // journal tail. The semantic response must therefore ride durable
    // attention/recovery even though it intentionally stays quiet for the
    // default actionable-only inbox wait.
    const successor = connectAs("sess-successor", NAME)
    const first = fetchJson(successor, opts).json
    expect(first.attention?.actionable_unread).toEqual([
      expect.objectContaining({
        id: response.id,
        type: "response",
        from: "@chief",
        content: "use the durable attention seam",
      }),
    ])
    expect(first.events?.map((event) => event.id)).toEqual([response.id])

    const second = fetchJson(successor, opts).json
    expect(second.attention?.actionable_unread).toEqual([])
    expect(second.events).toEqual([])
  })

  it("keeps a push-delivered response in attention until the parked seat fetches it", () => {
    const requester = connectAs("sess-push-parked", NAME)
    const chief = connectAs("sess-push-chief", "@chief")
    const request = parseToolJson(
      handleToolCall(requester, "tribe.send", { to: "@chief", message: "choose", type: "request" }, opts),
    ) as { id: string }
    const response = parseToolJson(
      handleToolCall(
        chief,
        "tribe.send",
        { to: NAME, message: "use seam B", type: "response", reply: request.id },
        opts,
      ),
    ) as { id: string }
    const persisted = db.prepare("SELECT rowid FROM messages WHERE id = ?").get(response.id) as { rowid: number }

    // Socket fanout records transport delivery, not model surfacing. A parked
    // provider has not acknowledged attention until its canonical fetch.
    stmts.updateLastDelivered.run({ $id: "sess-push-parked", $ts: now, $seq: persisted.rowid })
    expect(stmts.getLastDelivered.get({ $id: "sess-push-parked" })).toMatchObject({
      last_delivered_seq: persisted.rowid,
    })

    const fetched = fetchJson(requester, opts).json
    expect(fetched.attention?.actionable_unread).toEqual([
      expect.objectContaining({ id: response.id, type: "response", content: "use seam B" }),
    ])
    expect(fetchJson(requester, opts).json.attention?.actionable_unread).toEqual([])
  })

  it("projects a response ahead of a full ambient page without replaying it after acknowledgement", () => {
    const live = connectAs("sess-live-response", NAME)
    for (let i = 0; i < 75; i++) {
      insertRow(stmts, {
        id: `response-flood-${i}`,
        type: "health:daemon:warn",
        sender: "daemon",
        recipient: "*",
        kind: "broadcast",
        content: `ambient health ${i}`,
        ts: now + i,
      })
    }
    const responseRowid = insertRow(stmts, {
      id: "decision-response",
      type: "response",
      sender: "@chief",
      recipient: NAME,
      kind: "direct",
      content: "take seam B",
      ts: now + 100,
    })

    const first = fetchJson(live, opts).json
    expect(first.events).toHaveLength(50)
    expect(first.events?.some((event) => event.id === "decision-response")).toBe(false)
    expect(first.attention?.actionable_unread).toEqual([
      expect.objectContaining({ id: "decision-response", rowid: responseRowid, type: "response" }),
    ])

    const second = fetchJson(live, opts).json
    expect(second.attention?.actionable_unread).toEqual([])
    expect(second.events).toHaveLength(25)
    expect(second.events?.some((event) => event.id === "decision-response")).toBe(false)
  })

  it("acknowledges every attention row returned by an explicit advancing fetch", () => {
    const live = connectAs("sess-explicit-advance", NAME)
    const requestRowid = insertRow(stmts, {
      id: "explicit-request",
      type: "request",
      sender: "@chief",
      recipient: NAME,
      kind: "direct",
      content: "pick a seam",
      ts: now + 1,
    })
    const responseRowid = insertRow(stmts, {
      id: "explicit-response",
      type: "response",
      sender: "@chief",
      recipient: NAME,
      kind: "direct",
      content: "use seam B",
      ts: now + 2,
    })

    const explicit = fetchJson(live, opts, { since: requestRowid - 1, advance: true }).json
    expect(explicit.attention).toBeUndefined()
    expect(explicit.events?.map((event) => event.id)).toEqual(["explicit-request", "explicit-response"])
    expect(db.prepare("SELECT last_actionable_seq FROM mailbox_cursors WHERE recipient = ?").get(NAME)).toEqual({
      last_actionable_seq: responseRowid,
    })

    const canonical = fetchJson(live, opts).json
    expect(canonical.attention?.actionable_unread).toEqual([])
  })

  it("projects a later actionable plus owed ball ahead of a full ambient page", () => {
    const live = connectAs("sess-live", NAME)

    // Literal 17199 recurrence shape: the actor performs one bounded default
    // drain while enough ambient health traffic precedes a critical verdict to
    // keep the verdict outside that chronological page.
    for (let i = 0; i < 75; i++) {
      insertRow(stmts, {
        id: `ambient-health-${i}`,
        type: "health:daemon:warn",
        sender: "daemon",
        recipient: "*",
        kind: "broadcast",
        content: `ambient health ${i}`,
        ts: now + i,
      })
    }
    const verdictRowid = insertRow(stmts, {
      id: "critical-revise",
      type: "verdict",
      sender: "@ci",
      recipient: NAME,
      kind: "direct",
      content: "REVISE exact candidate before continuing composition",
      ts: now + 100,
    })
    stmts.openPendingRequest.run({
      $request_id: "review-r3",
      $recipient: NAME,
      $sender: "@ci",
      $opened_at: now + 100,
      $expires_at: null,
      $message_id: "critical-revise",
      $fanout: "first",
    })

    const filteredSnapshot = fetchJson(live, opts, { from: "@ci" }).json
    expect(filteredSnapshot.attention).toBeUndefined()
    expect(filteredSnapshot.events?.map((event) => event.id)).toEqual(["critical-revise"])

    const { json, raw } = fetchJson(live, opts)

    expect(json.events).toHaveLength(50)
    expect(json.events?.some((event) => event.id === "critical-revise")).toBe(false)
    expect(json.attention?.actionable_unread).toEqual([
      expect.objectContaining({
        id: "critical-revise",
        rowid: verdictRowid,
        type: "verdict",
        from: "@ci",
      }),
    ])
    expect(json.attention?.pending_balls).toEqual([
      expect.objectContaining({
        request_id: "review-r3",
        sender: "@ci",
        message_id: "critical-revise",
        fanout: "first",
      }),
    ])
    expect(json.attention?.actionable_unread?.some((event) => event.type.startsWith("health:"))).toBe(false)
    expect(raw.indexOf('"attention"')).toBeLessThan(raw.indexOf('"events"'))

    // The actionable mailbox is the single unread authority. Projecting and
    // acknowledging the verdict must re-arm inbox.wait immediately even though
    // the chronological ambient cursor has not paged through all 75 health rows.
    const unreadAfterAttention = stmts.getUnreadDms.get({ $name: NAME }) as {
      count: number
      oldest_ts: number
    }
    expect(unreadAfterAttention.count).toBe(0)
    const healthAfterAttention = parseToolJson(handleToolCall(live, "tribe.health", {}, opts)) as {
      unread?: Array<{ recipient: string; count: number }>
    }
    expect(healthAfterAttention.unread?.some((row) => row.recipient === NAME)).toBe(false)

    const afterDelivery = fetchJson(live, opts).json
    expect(afterDelivery.attention?.actionable_unread).toEqual([])
    expect(afterDelivery.events?.some((event) => event.id === "critical-revise")).toBe(false)
    expect(afterDelivery.attention?.pending_balls).toEqual([
      expect.objectContaining({ request_id: "review-r3", message_id: "critical-revise" }),
    ])
  })

  it("caps pending-ball attention to the oldest 10 with a lossless summary while explicit pending stays complete", () => {
    const live = connectAs("sess-cap", NAME)
    const total = 320

    for (let i = 0; i < total; i++) {
      stmts.openPendingRequest.run({
        $request_id: `cap-${i}`,
        $recipient: NAME,
        $sender: "@chief",
        $opened_at: now - (total - i) * 1_000,
        $expires_at: null,
        $message_id: `cap-message-${i}`,
        $fanout: "first",
      })
    }

    const fetched = fetchJson(live, opts).json
    expect(fetched.attention?.pending_balls?.map((ball) => ball.request_id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `cap-${i}`),
    )
    expect(fetched.attention?.pending_balls_summary).toEqual({
      total,
      oldest_age_ms: expect.any(Number),
    })
    expect(fetched.attention?.pending_balls_summary?.oldest_age_ms).toBeGreaterThanOrEqual(total * 1_000)
    expect(new TextEncoder().encode(JSON.stringify(fetched.attention)).byteLength).toBeLessThan(4_096)

    const explicit = parseToolJson(handleToolCall(live, "tribe.pending", {}, opts)) as {
      count?: number
      pending?: AttentionBall[]
    }
    expect(explicit.count).toBe(total)
    expect(explicit.pending).toHaveLength(total)
  })

  it("delivery acknowledgement cannot erase an explicitly tracked verdict obligation", () => {
    const author = connectAs("sess-author", NAME)
    const reviewer = connectAs("sess-reviewer", "@ci")
    const review = parseToolJson(
      handleToolCall(author, "tribe.send", { to: "@ci", message: "review immutable candidate", type: "request" }, opts),
    )

    for (let i = 0; i < 75; i++) {
      insertRow(stmts, {
        id: `verdict-flood-${i}`,
        type: "health:daemon:warn",
        sender: "daemon",
        recipient: "*",
        kind: "broadcast",
        content: `ambient health ${i}`,
        ts: now + i,
      })
    }
    const verdict = parseToolJson(
      handleToolCall(
        reviewer,
        "tribe.send",
        {
          to: NAME,
          message: "REVISE exact candidate before the next execute step",
          type: "verdict",
          reply: review.id,
          request: true,
        },
        opts,
      ),
    )

    const first = fetchJson(author, opts).json
    expect(first.events).toHaveLength(50)
    expect(first.events?.some((event) => event.id === verdict.id)).toBe(false)
    expect(first.attention?.actionable_unread).toEqual([
      expect.objectContaining({ id: verdict.id, type: "verdict", from: "@ci" }),
    ])

    const afterDeliveryAck = fetchJson(author, opts).json
    expect(afterDeliveryAck.attention?.actionable_unread).toEqual([])
    expect(afterDeliveryAck.attention?.pending_balls).toEqual([
      expect.objectContaining({
        request_id: verdict.id,
        sender: "@ci",
        message_id: verdict.id,
      }),
    ])
    const reviewerPending = parseToolJson(handleToolCall(reviewer, "tribe.pending", {}, opts)) as {
      count?: number
    }
    expect(reviewerPending.count).toBe(0)
  })

  it("records an empty canonical attention read without advancing the actionable cursor", () => {
    const live = connectAs("sess-attention-read", NAME)
    const receiptAt = now + 5_000
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(receiptAt)
    try {
      const filtered = fetchJson(live, opts, { from: "@chief" }).json
      expect(filtered.attention).toBeUndefined()
      expect(db.prepare("SELECT last_attention_read_at FROM mailbox_cursors WHERE recipient = ?").get(NAME)).toBeNull()

      const canonical = fetchJson(live, opts, { advance: false }).json
      expect(canonical.attention?.actionable_unread).toEqual([])
      expect(
        db
          .prepare("SELECT last_actionable_seq, last_attention_read_at FROM mailbox_cursors WHERE recipient = ?")
          .get(NAME),
      ).toEqual({ last_actionable_seq: 0, last_attention_read_at: receiptAt })
    } finally {
      nowSpy.mockRestore()
    }
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

  it("an ACTIVE holder keeps both its name and mailbox when a second live session tries to join", () => {
    const b = connectAs("sess-b", NAME)
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
    // A second connected session cannot DB-tombstone the holder behind its
    // live context/socket. Explicit whole-transport takeover is a dispatcher
    // operation; ordinary tribe.join fails loud and leaves the mailbox put.
    const d = makeContext(db, stmts, "sess-d", "boot-sess-d")
    active.add("sess-d")
    const joined = parseToolJson(handleToolCall(d, "tribe.join", { name: NAME, delivery: "pull" }, opts))

    expect(joined.error).toContain(`Name "${NAME}" is already taken`)
    expect(fetchEvents(d, opts)).toEqual([])
    expect(fetchEvents(b, opts).map((e) => e.id)).toEqual(["r-live"])
    expect(db.prepare("SELECT name FROM sessions WHERE id = 'sess-b'").get()).toEqual({ name: NAME })
    expect(db.prepare(`SELECT name FROM sessions WHERE name LIKE '${NAME}-dead-%'`).all()).toEqual([])
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

  it("a bounded event page stays lossless because attention returns every actionable before acknowledgement", () => {
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
    const first = fetchJson(b, opts, { limit: 2 }).json
    expect(first.events?.map((event) => event.id)).toEqual(["p1", "p2"])
    expect(first.attention?.actionable_unread?.map((event) => event.id)).toEqual(["p1", "p2", "p3"])
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
    expect((stmts.getUnreadDms.get({ $name: NAME }) as { count: number }).count).toBe(0)
    const health = parseToolJson(handleToolCall(b, "tribe.health", {}, opts)) as {
      unread?: Array<{ recipient: string; count: number }>
    }
    expect(health.unread?.some((row) => row.recipient === NAME)).toBe(false)
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
