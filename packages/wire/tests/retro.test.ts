import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { formatMarkdown, generateRetro } from "../src/lib/retro.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE

// Minimal standalone schema — the wire retro module reads only `messages`
// (+ its request/reply/kind columns) and `sessions`. Keeping the schema inline
// keeps this test runnable from a standalone wire clone (vendor independence).
function makeDb(): Database {
  const db = new Database(":memory:")
  db.run(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, domains TEXT NOT NULL,
    started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`)
  db.run(`CREATE TABLE messages (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
    sender TEXT NOT NULL, recipient TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'direct',
    content TEXT NOT NULL, bead_id TEXT, ref TEXT, ts INTEGER NOT NULL,
    request TEXT, reply TEXT, summary TEXT, correlated_reply_requester TEXT
  )`)
  db.run(`CREATE TABLE pending_request (
    request_id TEXT NOT NULL, recipient TEXT NOT NULL, sender TEXT NOT NULL,
    opened_at INTEGER NOT NULL, expires_at INTEGER, message_id TEXT NOT NULL,
    fanout TEXT NOT NULL DEFAULT 'first', PRIMARY KEY (request_id, recipient)
  )`)
  return db
}

function insertSession(db: Database, name: string, role: string, now: number): void {
  db.prepare("INSERT INTO sessions (id, name, role, domains, started_at, updated_at) VALUES (?, ?, ?, '[]', ?, ?)").run(
    `sess-${name}`,
    name,
    role,
    now - 12 * HOUR,
    now,
  )
}

function insertMessage(
  db: Database,
  m: {
    id: string
    type: string
    sender: string
    recipient: string
    ts: number
    content?: string
    request?: string
    reply?: string
    summary?: string
    correlatedReplyRequester?: string
  },
): void {
  db.prepare(
    "INSERT INTO messages (id, type, sender, recipient, kind, content, ts, request, reply, summary, correlated_reply_requester) VALUES (?, ?, ?, ?, 'direct', ?, ?, ?, ?, ?, ?)",
  ).run(
    m.id,
    m.type,
    m.sender,
    m.recipient,
    m.content ?? m.id,
    m.ts,
    m.request ?? null,
    m.reply ?? null,
    m.summary ?? null,
    m.correlatedReplyRequester ?? null,
  )
}

function insertExpiry(db: Database, requestId: string, ts: number): void {
  db.prepare(
    "INSERT INTO messages (id, type, sender, recipient, kind, content, ref, ts, request, reply) VALUES (?, 'event.ball.expired', 'daemon', '*', 'event', ?, ?, ?, NULL, NULL)",
  ).run(`${requestId}-expired`, JSON.stringify({ request_id: requestId, settlement: "expired" }), requestId, ts)
}

function insertSettlement(
  db: Database,
  requestId: string,
  settlement: "answered" | "manual-close" | "incident-cleared" | "gc-expired" | "sender-withdrawn",
  ts: number,
  recipient = "@chief",
  openedAt = ts - MINUTE,
  messageId = requestId,
  settledBy?: string,
): void {
  db.prepare(
    "INSERT INTO messages (id, type, sender, recipient, kind, content, ref, ts, request, reply) VALUES (?, 'event.ball.settled', 'daemon', '*', 'event', ?, ?, ?, NULL, NULL)",
  ).run(
    `${requestId}-${recipient}-${messageId}-${settlement}`,
    JSON.stringify({
      schema_version: 1,
      request_id: requestId,
      recipient,
      sender: "@agent/1",
      opened_at: openedAt,
      expires_at: null,
      message_id: messageId,
      fanout: "first",
      summary: null,
      settlement,
      settled_at: ts,
      settled_by: settledBy ?? (settlement === "answered" ? recipient : "daemon"),
    }),
    requestId,
    ts,
  )
}

function insertPending(db: Database, requestId: string, from: string, to: string, openedAt: number): void {
  db.prepare(
    "INSERT INTO pending_request (request_id, recipient, sender, opened_at, expires_at, message_id, fanout) VALUES (?, ?, ?, ?, NULL, ?, 'first')",
  ).run(requestId, to, from, openedAt, requestId)
}

function insertBall(
  db: Database,
  ball: { id: string; from: string; to: string; openedAt: number; latencyMs: number },
): void {
  insertMessage(db, {
    id: ball.id,
    type: "request",
    sender: ball.from,
    recipient: ball.to,
    ts: ball.openedAt,
    request: ball.id,
  })
  insertMessage(db, {
    id: `${ball.id}-reply`,
    type: "response",
    sender: ball.to,
    recipient: ball.from,
    ts: ball.openedAt + ball.latencyMs,
    reply: ball.id,
  })
}

describe("21714 wire retro response latency", () => {
  let db: Database
  let now: number

  beforeEach(() => {
    db = makeDb()
    now = Date.now()
    insertSession(db, "@chief", "chief", now)
    insertSession(db, "@agent/1", "member", now)
  })

  afterEach(() => db.close())

  it("computes per-member avg + p50/p90 from request→reply pairs", () => {
    insertBall(db, { id: "b1", from: "@agent/1", to: "@chief", openedAt: now - 3 * HOUR, latencyMs: 2 * MINUTE })
    insertBall(db, { id: "b2", from: "@agent/1", to: "@chief", openedAt: now - 2 * HOUR, latencyMs: 4 * MINUTE })
    insertBall(db, { id: "b3", from: "@agent/1", to: "@chief", openedAt: now - 1 * HOUR, latencyMs: 6 * MINUTE })

    const report = generateRetro(db, 6 * HOUR)
    const chief = report.members.find((m) => m.name === "@chief")
    expect(chief?.avg_response).toBe("4m")
    expect(chief?.response_p50).toBe("4m")
    expect(chief?.response_p90).toBe("6m")
    expect(chief?.responses).toBe(3)
    expect(report.coordination.avg_response_time).toBe("4m")
    expect(report.coordination.unanswered_queries).toBe(0)

    const md = formatMarkdown(report)
    expect(md).not.toMatch(/Average response time/)
    expect(md).toMatch(/Response p50 \/ p90: 4m \/ 6m/)
  })

  it("excludes an unanswered ball from the average but counts it open", () => {
    insertBall(db, { id: "answered", from: "@agent/1", to: "@chief", openedAt: now - 2 * HOUR, latencyMs: 4 * MINUTE })
    insertMessage(db, {
      id: "open",
      type: "request",
      sender: "@agent/1",
      recipient: "@chief",
      ts: now - 20 * MINUTE,
      request: "open",
    })

    const report = generateRetro(db, 6 * HOUR)
    expect(report.members.find((m) => m.name === "@chief")?.avg_response).toBe("4m")
    expect(report.coordination.unanswered_queries).toBe(1)
  })

  it("keeps a deadline-passed obligation unanswered until a real settlement", () => {
    insertMessage(db, {
      id: "expired",
      type: "request",
      sender: "@agent/1",
      recipient: "@chief",
      ts: now - 20 * MINUTE,
      request: "expired",
    })
    insertExpiry(db, "expired", now - 10 * MINUTE)

    const report = generateRetro(db, 6 * HOUR)
    expect(report.coordination.unanswered_queries).toBe(1)
  })

  it("reports every terminal settlement reason without collapsing them", () => {
    const reasons = ["manual-close", "incident-cleared", "gc-expired", "sender-withdrawn"] as const
    for (const [index, reason] of reasons.entries()) {
      const requestId = `settled-${reason}`
      insertMessage(db, {
        id: requestId,
        type: "request",
        sender: "@agent/1",
        recipient: "@chief",
        ts: now - (index + 2) * MINUTE,
        request: requestId,
      })
      insertSettlement(db, requestId, reason, now - MINUTE)
    }

    const report = generateRetro(db, 6 * HOUR)
    expect(report.coordination.unanswered_queries).toBe(0)
    expect(report.coordination.settlements).toEqual({
      answered: 0,
      "manual-close": 1,
      "incident-cleared": 1,
      "gc-expired": 1,
      "sender-withdrawn": 1,
    })
    expect(formatMarkdown(report)).toContain(
      "Settlements: answered=0, manual-close=1, incident-cleared=1, gc-expired=1, sender-withdrawn=1",
    )
  })

  it("counts only session-backed people and keeps unknown transport activity visible once", () => {
    insertMessage(db, {
      id: "pending-status",
      type: "status",
      sender: "pending-00000000-0000-0000-0000-000000000000",
      recipient: "@chief",
      ts: now - MINUTE,
    })
    insertMessage(db, {
      id: "legacy-status",
      type: "status",
      sender: "old-renamed-seat",
      recipient: "@chief",
      ts: now - MINUTE,
    })

    const report = generateRetro(db, 6 * HOUR)
    expect(report.summary.members).toBe(1)
    expect(report.members.map((member) => member.name)).toEqual(["@chief"])
    expect(report.unattributed_activity).toEqual({ messages: 2, distinct_endpoints: 2 })
  })

  it("reports per-seat ball reliability from answered, mechanical, open, and unknown outcomes", () => {
    const answeredAt = now - 30 * MINUTE
    const answeredOpenedAt = answeredAt - 2 * MINUTE
    for (const [id, openedAt] of [
      ["answered", answeredOpenedAt],
      ["manual", now - 25 * MINUTE],
      ["open", now - 20 * MINUTE],
      ["legacy-unknown", now - 15 * MINUTE],
    ] as const) {
      insertMessage(db, {
        id,
        type: "request",
        sender: "@agent/1",
        recipient: "@chief",
        ts: openedAt,
        request: id,
      })
    }
    insertSettlement(db, "answered", "answered", answeredAt, "@chief", answeredOpenedAt)
    insertSettlement(db, "manual", "manual-close", now - 24 * MINUTE, "@chief", now - 25 * MINUTE)
    insertPending(db, "open", "@agent/1", "@chief", now - 20 * MINUTE)

    const report = generateRetro(db, 6 * HOUR)
    const balls = report.members.find((member) => member.name === "@chief")?.balls
    expect(balls).toEqual({
      arrivals: 4,
      answers: 1,
      answer_share: 0.25,
      response_p50: "2m",
      response_p90: "2m",
      response_max: "2m",
      endings: {
        answered: 1,
        "manual-close": 1,
        "incident-cleared": 0,
        "gc-expired": 0,
        "sender-withdrawn": 0,
        open: 1,
        unknown: 1,
      },
      oldest_unanswered: "20m",
      default_acceptance: null,
    })
    expect(report.coordination.settlements.answered).toBe(1)
  })

  it("keeps the full review corpus in JSON while bounding the human timeline", () => {
    for (let index = 0; index < 11; index++) {
      insertMessage(db, {
        id: `review-${index}`,
        type: "request",
        sender: "@agent/1",
        recipient: "@chief",
        content: index === 0 ? "Default: ship unless you object" : `request ${index}`,
        summary: `review ${index}`,
        ts: now - (11 - index) * MINUTE,
        request: `review-${index}`,
      })
      if (index === 0) {
        insertMessage(db, {
          id: "review-0-reply",
          type: "response",
          sender: "@chief",
          recipient: "@agent/1",
          content: "Accepted",
          ts: now - 10 * MINUTE + 1_000,
          reply: "review-0",
          correlatedReplyRequester: "@agent/1",
        })
      }
    }

    const report = generateRetro(db, 6 * HOUR)
    expect(report.review_corpus).toHaveLength(11)
    expect(report.review_corpus[0]).toMatchObject({
      request_id: "review-0",
      owner: "@chief",
      request: { content: "Default: ship unless you object" },
      reply: { content: "Accepted" },
      default_acceptance: null,
    })
    expect(report.timeline).toHaveLength(11)

    const markdown = formatMarkdown(report)
    expect(markdown).not.toContain("Default: ship unless you object")
    expect(markdown).toContain("1 older event omitted")
    expect(Buffer.byteLength(markdown, "utf8")).toBeLessThan(4_096)
  })

  it("matches recurring-incident replies to their actual episode and avoids negative latency", () => {
    const incidentId = "wait-watch:ball @dev/7:expired-unanswered"

    // Episode 1: opened 20m ago, answered 18m ago (latency 2m)
    insertMessage(db, {
      id: "ep1-msg",
      type: "request",
      sender: "wait-watch",
      recipient: "@chief",
      ts: now - 20 * MINUTE,
      request: incidentId,
    })
    insertMessage(db, {
      id: "ep1-reply",
      type: "response",
      sender: "@chief",
      recipient: "wait-watch",
      ts: now - 18 * MINUTE,
      reply: incidentId,
    })
    insertSettlement(db, incidentId, "answered", now - 18 * MINUTE, "@chief", now - 20 * MINUTE, "ep1-msg")

    // Episode 2: opened 10m ago, answered 7m ago (latency 3m)
    insertMessage(db, {
      id: "ep2-msg",
      type: "request",
      sender: "wait-watch",
      recipient: "@chief",
      ts: now - 10 * MINUTE,
      request: incidentId,
    })
    insertMessage(db, {
      id: "ep2-reply",
      type: "response",
      sender: "@chief",
      recipient: "wait-watch",
      ts: now - 7 * MINUTE,
      reply: incidentId,
    })
    insertSettlement(db, incidentId, "answered", now - 7 * MINUTE, "@chief", now - 10 * MINUTE, "ep2-msg")

    const report = generateRetro(db, 6 * HOUR)
    const ep1 = report.review_corpus.find((r) => r.request.id === "ep1-msg")
    const ep2 = report.review_corpus.find((r) => r.request.id === "ep2-msg")

    expect(ep1).toBeDefined()
    expect(ep1?.reply).toMatchObject({ id: "ep1-reply", ts: now - 18 * MINUTE })

    expect(ep2).toBeDefined()
    expect(ep2?.reply).toMatchObject({ id: "ep2-reply", ts: now - 7 * MINUTE })
    expect((ep2?.reply?.ts ?? 0) - (ep2?.request.ts ?? 0)).toBe(3 * MINUTE)
  })

  it("honors proven tracker settlement for hab-page opener replied to @hab", () => {
    const pageRequestId = "hab-page-req-123"

    insertMessage(db, {
      id: pageRequestId,
      type: "request",
      sender: "hab-page",
      recipient: "@chief",
      ts: now - 5 * MINUTE,
      request: pageRequestId,
    })
    insertMessage(db, {
      id: "hab-page-reply-123",
      type: "response",
      sender: "@chief",
      recipient: "@hab",
      ts: now - 2 * MINUTE,
      reply: pageRequestId,
    })
    insertSettlement(db, pageRequestId, "answered", now - 2 * MINUTE, "@chief", now - 5 * MINUTE, pageRequestId)

    const report = generateRetro(db, 6 * HOUR)
    const pageRecord = report.review_corpus.find((r) => r.request_id === pageRequestId)

    expect(pageRecord).toBeDefined()
    expect(pageRecord?.ending).toBe("answered")
    expect(pageRecord?.reply).toMatchObject({
      id: "hab-page-reply-123",
      sender: "@chief",
      ts: now - 2 * MINUTE,
    })
  })

  it("does not credit losing owners on fanout:first requests with replies", () => {
    insertSession(db, "@agent/2", "dev", now)
    insertSession(db, "@agent/3", "dev", now)
    const fanoutReqId = "fanout-req-1"

    insertMessage(db, {
      id: fanoutReqId,
      type: "query",
      sender: "@chief",
      recipient: "*",
      ts: now - 10 * MINUTE,
      request: fanoutReqId,
    })
    // Winning answer from @agent/2 at t = now - 8 * MINUTE
    insertMessage(db, {
      id: "fanout-reply-2",
      type: "response",
      sender: "@agent/2",
      recipient: "@chief",
      ts: now - 8 * MINUTE,
      reply: fanoutReqId,
    })
    // Late answer from loser @agent/3 at t = now - 8 * MINUTE + 500ms (within 1s race window)
    insertMessage(db, {
      id: "fanout-reply-3-late",
      type: "response",
      sender: "@agent/3",
      recipient: "@chief",
      ts: now - 8 * MINUTE + 500,
      reply: fanoutReqId,
    })
    // Production tracker writes settled_by: winner (@agent/2) for both released owner rows
    insertSettlement(
      db,
      fanoutReqId,
      "answered",
      now - 8 * MINUTE,
      "@agent/2",
      now - 10 * MINUTE,
      fanoutReqId,
      "@agent/2",
    )
    insertSettlement(
      db,
      fanoutReqId,
      "answered",
      now - 8 * MINUTE,
      "@agent/3",
      now - 10 * MINUTE,
      fanoutReqId,
      "@agent/2",
    )

    const report = generateRetro(db, 6 * HOUR)
    const entryWinner = report.review_corpus.find((r) => r.request_id === fanoutReqId && r.owner === "@agent/2")
    const entryLoser = report.review_corpus.find((r) => r.request_id === fanoutReqId && r.owner === "@agent/3")

    expect(entryWinner).toBeDefined()
    expect(entryWinner?.ending).toBe("answered")
    expect(entryWinner?.reply).toMatchObject({
      id: "fanout-reply-2",
      sender: "@agent/2",
    })

    expect(entryLoser).toBeDefined()
    expect(entryLoser?.ending).toBe("answered")
    expect(entryLoser?.reply).toBeNull()
  })

  it("does not match an unrelated later reply to an expired or cleared episode", () => {
    const expiredReqId = "expired-req-neg"

    insertMessage(db, {
      id: expiredReqId,
      type: "request",
      sender: "@agent/1",
      recipient: "@chief",
      ts: now - 30 * MINUTE,
      request: expiredReqId,
    })
    // Settled as gc-expired at 20m ago
    insertSettlement(db, expiredReqId, "gc-expired", now - 20 * MINUTE, "@chief", now - 30 * MINUTE, expiredReqId)

    // Unrelated later reply sent at 5m ago (long after gc-expired settlement)
    insertMessage(db, {
      id: "unrelated-late-reply",
      type: "response",
      sender: "@chief",
      recipient: "@agent/1",
      ts: now - 5 * MINUTE,
      reply: expiredReqId,
    })

    const report = generateRetro(db, 6 * HOUR)
    const entry = report.review_corpus.find((r) => r.request_id === expiredReqId)

    expect(entry).toBeDefined()
    expect(entry?.ending).toBe("gc-expired")
    expect(entry?.reply).toBeNull()
  })

  it("does not match a late second response sent after answered settlement", () => {
    const reqId = "req-settled-then-second-reply"

    insertMessage(db, {
      id: reqId,
      type: "request",
      sender: "@agent/1",
      recipient: "@chief",
      ts: now - 15 * MINUTE,
      request: reqId,
    })
    // Legitimate first reply that settled the ball at 10m ago
    insertMessage(db, {
      id: "reply-first",
      type: "response",
      sender: "@chief",
      recipient: "@agent/1",
      ts: now - 10 * MINUTE,
      reply: reqId,
    })
    insertSettlement(db, reqId, "answered", now - 10 * MINUTE, "@chief", now - 15 * MINUTE, reqId, "@chief")

    // Late second response sent after settlement (5m ago)
    insertMessage(db, {
      id: "reply-second-late",
      type: "response",
      sender: "@chief",
      recipient: "@agent/1",
      ts: now - 5 * MINUTE,
      reply: reqId,
    })

    const report = generateRetro(db, 6 * HOUR)
    const entry = report.review_corpus.find((r) => r.request_id === reqId)

    expect(entry).toBeDefined()
    expect(entry?.ending).toBe("answered")
    expect(entry?.reply).toMatchObject({
      id: "reply-first",
      sender: "@chief",
    })
    expect(entry!.reply!.ts - entry!.request.ts).toBe(5 * MINUTE)
  })
})

describe("25654 one ball with two settlement facts", () => {
  let db: Database
  const now = Date.now()

  beforeEach(() => {
    db = makeDb()
    insertSession(db, "@chief", "chief", now)
    insertSession(db, "@agent/1", "member", now)
  })
  afterEach(() => {
    db.close()
  })

  it("counts the ball once by its latest fact and names the conflict instead of throwing", () => {
    insertMessage(db, {
      id: "twice-req",
      type: "request",
      sender: "@agent/1",
      recipient: "@chief",
      ts: now - 5 * MINUTE,
      request: "twice-req",
    })
    insertSettlement(db, "twice-req", "manual-close", now - 4 * MINUTE, "@chief", now - 5 * MINUTE)
    insertSettlement(db, "twice-req", "answered", now - 2 * MINUTE, "@chief", now - 5 * MINUTE)
    insertBall(db, { id: "clean-req", from: "@agent/1", to: "@chief", openedAt: now - 3 * MINUTE, latencyMs: MINUTE })

    const report = generateRetro(db, 6 * HOUR)
    // twice-req counts ONCE, by its latest fact (answered), beside clean-req.
    expect(report.coordination.settlements).toEqual({
      answered: 2,
      "manual-close": 0,
      "incident-cleared": 0,
      "gc-expired": 0,
      "sender-withdrawn": 0,
    })
    expect(report.coordination.settlement_conflicts).toEqual([
      { request_id: "twice-req", settlements: ["manual-close", "answered"] },
    ])
    expect(formatMarkdown(report)).toContain("- Settlement conflicts: 1 (twice-req: manual-close, answered)")
  })

  it("prints zero conflicts when every ball carries one fact", () => {
    insertBall(db, { id: "clean-req", from: "@agent/1", to: "@chief", openedAt: now - 3 * MINUTE, latencyMs: MINUTE })
    const report = generateRetro(db, 6 * HOUR)
    expect(report.coordination.settlement_conflicts).toEqual([])
    expect(formatMarkdown(report)).toContain("- Settlement conflicts: 0")
  })
})
