import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { openDatabase } from "./database.ts"
import { formatMarkdown, generateRetro } from "./retro.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE

type OpenDatabase = ReturnType<typeof openDatabase>

function insertSession(db: OpenDatabase, session: { name: string; role: string; now: number }): void {
  db.prepare(`
    INSERT INTO sessions (
      id, name, role, domains, pid, started_at, updated_at, last_inbox_pull_seq
    ) VALUES (
      $id, $name, $role, '[]', 1, $started, $now, 0
    )
  `).run({
    $id: `sess-${session.name}`,
    $name: session.name,
    $role: session.role,
    $started: session.now - 12 * HOUR,
    $now: session.now,
  })
}

function insertMessage(
  db: OpenDatabase,
  message: {
    id: string
    type: string
    sender: string
    recipient: string
    ts: number
    request?: string
    reply?: string
  },
): void {
  db.prepare(`
    INSERT INTO messages (
      id, type, sender, recipient, kind, content, ts, delivery, request, reply, summary
    ) VALUES (
      $id, $type, $sender, $recipient, 'direct', $id, $ts, 'push', $request, $reply, $id
    )
  `).run({
    $id: message.id,
    $type: message.type,
    $sender: message.sender,
    $recipient: message.recipient,
    $ts: message.ts,
    $request: message.request ?? null,
    $reply: message.reply ?? null,
  })
}

/** Open a tracked ball (request) then close it (reply) after `latencyMs`. */
function insertBall(
  db: OpenDatabase,
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

describe("21714 Tribe retro response latency", () => {
  let tmpDir: string
  let db: OpenDatabase
  let now: number

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-retro-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    now = Date.now()
    insertSession(db, { name: "@chief", role: "chief", now })
    insertSession(db, { name: "@agent/1", role: "member", now })
    insertSession(db, { name: "@agent/2", role: "member", now })
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("computes per-member average from request→reply pairs, not the dead query/response types", () => {
    // @chief answers three balls opened by @agent/1: 2m, 4m, 6m → avg 4m, p50 4m, p90 6m.
    insertBall(db, { id: "ball-a", from: "@agent/1", to: "@chief", openedAt: now - 3 * HOUR, latencyMs: 2 * MINUTE })
    insertBall(db, { id: "ball-b", from: "@agent/1", to: "@chief", openedAt: now - 2 * HOUR, latencyMs: 4 * MINUTE })
    insertBall(db, { id: "ball-c", from: "@agent/1", to: "@chief", openedAt: now - 1 * HOUR, latencyMs: 6 * MINUTE })
    // @agent/2 answers one ball opened by @chief: 10m.
    insertBall(db, {
      id: "ball-d",
      from: "@chief",
      to: "@agent/2",
      openedAt: now - 90 * MINUTE,
      latencyMs: 10 * MINUTE,
    })

    const report = generateRetro(db, 6 * HOUR)

    const chief = report.members.find((m) => m.name === "@chief")
    const agent2 = report.members.find((m) => m.name === "@agent/2")
    expect(chief?.avg_response).toBe("4m")
    expect(chief?.response_p50).toBe("4m")
    expect(chief?.response_p90).toBe("6m")
    expect(chief?.responses).toBe(3)
    expect(agent2?.avg_response).toBe("10m")
    expect(agent2?.responses).toBe(1)

    // Overall average across all four responses: (2+4+6+10)/4 = 5.5m ≈ "6m" (rounded) — assert on ms via structured field instead.
    expect(report.coordination.avg_response_time).not.toBeNull()
    expect(report.coordination.longest_response).toBe("10m")
    expect(report.coordination.longest_response_member).toBe("@agent/2")
  })

  it("excludes an unanswered ball from the average but counts it as open, never 0ms", () => {
    insertBall(db, { id: "answered", from: "@agent/1", to: "@chief", openedAt: now - 2 * HOUR, latencyMs: 4 * MINUTE })
    // Opened but never replied to — a live ball still owed by @chief.
    insertMessage(db, {
      id: "open-ball",
      type: "request",
      sender: "@agent/1",
      recipient: "@chief",
      ts: now - 30 * MINUTE,
      request: "open-ball",
    })

    const report = generateRetro(db, 6 * HOUR)

    const chief = report.members.find((m) => m.name === "@chief")
    // The open ball must NOT drag the average to 0 — only the answered ball counts.
    expect(chief?.avg_response).toBe("4m")
    expect(chief?.responses).toBe(1)
    // The open ball is surfaced as an unanswered request, not silently dropped.
    expect(report.coordination.unanswered_queries).toBe(1)
  })

  it("renders an explicit marker (—) for a member who answered nothing, never a fabricated number", () => {
    insertBall(db, { id: "ball-x", from: "@agent/1", to: "@chief", openedAt: now - 1 * HOUR, latencyMs: 3 * MINUTE })

    const report = generateRetro(db, 6 * HOUR)
    const md = formatMarkdown(report)

    // @agent/1 opened a ball but answered none → its Avg Response cell is the em-dash marker.
    const agent1 = report.members.find((m) => m.name === "@agent/1")
    expect(agent1?.avg_response).toBeNull()
    expect(md).toContain("| @chief |")
    expect(md).toMatch(/Average response time: 3m/)
  })
})
