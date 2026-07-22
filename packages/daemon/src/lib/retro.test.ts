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

describe("21753 Tribe retro ball-SLA breaches", () => {
  const SLA = 10 * MINUTE
  let tmpDir: string
  let db: OpenDatabase
  let now: number

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-retro-sla-"))
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

  it("counts an unanswered ball aged past the threshold as open-stale, attributed to the owner", () => {
    // @chief owes an open ball 30m old (> 10m SLA) → one open-stale breach for @chief.
    insertMessage(db, {
      id: "stale",
      type: "request",
      sender: "@agent/1",
      recipient: "@chief",
      ts: now - 30 * MINUTE,
      request: "stale",
    })
    // A fresh open ball (2m old) is NOT stale — it stays under the threshold.
    insertMessage(db, {
      id: "fresh",
      type: "request",
      sender: "@agent/1",
      recipient: "@agent/2",
      ts: now - 2 * MINUTE,
      request: "fresh",
    })

    const report = generateRetro(db, 6 * HOUR, SLA)

    const chief = report.members.find((m) => m.name === "@chief")
    const agent2 = report.members.find((m) => m.name === "@agent/2")
    expect(chief?.sla_open_stale).toBe(1)
    expect(chief?.sla_answered_late).toBe(0)
    expect(chief?.sla_breaches).toBe(1)
    expect(agent2?.sla_open_stale).toBe(0)
    expect(report.coordination.sla_open_stale).toBe(1)
    expect(report.coordination.sla_answered_late).toBe(0)
    expect(report.coordination.sla_threshold_ms).toBe(SLA)
  })

  it("counts a ball answered slower than the threshold as answered-late, attributed to the responder", () => {
    // @chief answers one ball in 15m (> 10m → late) and one in 4m (on time).
    insertBall(db, { id: "slow", from: "@agent/1", to: "@chief", openedAt: now - 2 * HOUR, latencyMs: 15 * MINUTE })
    insertBall(db, { id: "quick", from: "@agent/1", to: "@chief", openedAt: now - 1 * HOUR, latencyMs: 4 * MINUTE })

    const report = generateRetro(db, 6 * HOUR, SLA)

    const chief = report.members.find((m) => m.name === "@chief")
    expect(chief?.sla_answered_late).toBe(1)
    expect(chief?.sla_open_stale).toBe(0)
    expect(chief?.sla_breaches).toBe(1)
    expect(chief?.responses).toBe(2) // both still count as answered
    expect(report.coordination.sla_answered_late).toBe(1)
  })

  it("counts a reply whose opener is outside the window as unmeasurable, never a breach or 0ms", () => {
    // A reply to a ball whose opening request was never loaded (opener outside
    // the window). It must not be timed against a fabricated start, must not
    // count as a response, and must never be a breach.
    insertMessage(db, {
      id: "orphan-reply",
      type: "response",
      sender: "@chief",
      recipient: "@agent/1",
      ts: now - 20 * MINUTE,
      reply: "opener-outside-window",
    })

    const report = generateRetro(db, 6 * HOUR, SLA)

    const chief = report.members.find((m) => m.name === "@chief")
    expect(report.coordination.sla_unmeasurable).toBe(1)
    expect(report.coordination.sla_answered_late).toBe(0)
    expect(report.coordination.sla_open_stale).toBe(0)
    // The orphan reply is not scored as a 0ms response.
    expect(chief?.responses ?? 0).toBe(0)
    expect(chief?.avg_response ?? null).toBeNull()
  })

  it("is configurable: raising the threshold above the latency clears the answered-late breach", () => {
    insertBall(db, { id: "b", from: "@agent/1", to: "@chief", openedAt: now - 1 * HOUR, latencyMs: 15 * MINUTE })

    // 10m threshold → the 15m answer is late.
    const strict = generateRetro(db, 6 * HOUR, 10 * MINUTE)
    expect(strict.members.find((m) => m.name === "@chief")?.sla_answered_late).toBe(1)
    expect(strict.coordination.sla_threshold_ms).toBe(10 * MINUTE)

    // 20m threshold → the same 15m answer is on time.
    const lax = generateRetro(db, 6 * HOUR, 20 * MINUTE)
    expect(lax.members.find((m) => m.name === "@chief")?.sla_answered_late).toBe(0)
    expect(lax.coordination.sla_answered_late).toBe(0)
    expect(lax.coordination.sla_threshold_ms).toBe(20 * MINUTE)
  })

  it("renders a Breaches column and a Ball SLA breaches line, including the unmeasurable suffix", () => {
    // One open-stale (@chief, 30m) + one unmeasurable reply.
    insertMessage(db, {
      id: "stale",
      type: "request",
      sender: "@agent/1",
      recipient: "@chief",
      ts: now - 30 * MINUTE,
      request: "stale",
    })
    insertMessage(db, {
      id: "orphan-reply",
      type: "response",
      sender: "@agent/2",
      recipient: "@agent/1",
      ts: now - 20 * MINUTE,
      reply: "opener-outside-window",
    })

    const md = formatMarkdown(generateRetro(db, 6 * HOUR, SLA))

    expect(md).toContain("| Breaches |")
    expect(md).toMatch(/Ball SLA breaches: 1 open-stale, 0 answered-late \(threshold 10m\); 1 unmeasurable/)
  })
})
