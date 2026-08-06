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
    request TEXT, reply TEXT
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
  m: { id: string; type: string; sender: string; recipient: string; ts: number; request?: string; reply?: string },
): void {
  db.prepare(
    "INSERT INTO messages (id, type, sender, recipient, kind, content, ts, request, reply) VALUES (?, ?, ?, ?, 'direct', ?, ?, ?, ?)",
  ).run(m.id, m.type, m.sender, m.recipient, m.id, m.ts, m.request ?? null, m.reply ?? null)
}

function insertExpiry(db: Database, requestId: string, ts: number): void {
  db.prepare(
    "INSERT INTO messages (id, type, sender, recipient, kind, content, ref, ts, request, reply) VALUES (?, 'event.ball.expired', 'daemon', '*', 'event', ?, ?, ?, NULL, NULL)",
  ).run(`${requestId}-expired`, JSON.stringify({ request_id: requestId, settlement: "expired" }), requestId, ts)
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
    expect(md).toMatch(/Average response time: 4m/)
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

  it("does not report an explicitly expired obligation as unanswered", () => {
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
    expect(report.coordination.unanswered_queries).toBe(0)
  })
})
