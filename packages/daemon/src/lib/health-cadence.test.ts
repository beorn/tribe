import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { projectHealthCadence } from "./health-cadence.ts"
import { handleToolCall, type ActiveSessionInfo, type HandlerOpts } from "./handlers.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

type OpenDatabase = ReturnType<typeof openDatabase>

function insertSession(
  db: OpenDatabase,
  session: { id: string; name: string; role: string; now: number; cursor?: number },
): void {
  db.prepare(`
    INSERT INTO sessions (
      id, name, role, domains, pid, started_at, updated_at, last_inbox_pull_seq
    ) VALUES (
      $id, $name, $role, '[]', 1, $now, $now, $cursor
    )
  `).run({
    $id: session.id,
    $name: session.name,
    $role: session.role,
    $now: session.now,
    $cursor: session.cursor ?? 0,
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

function insertResponsePair(
  db: OpenDatabase,
  pair: {
    id: string
    type: string
    sender: string
    recipient: string
    requestAt: number
    latencyMs: number
  },
): void {
  insertMessage(db, {
    id: pair.id,
    type: pair.type,
    sender: pair.sender,
    recipient: pair.recipient,
    ts: pair.requestAt,
    request: pair.id,
  })
  insertMessage(db, {
    id: `${pair.id}-reply`,
    type: "response",
    sender: pair.recipient,
    recipient: pair.sender,
    ts: pair.requestAt + pair.latencyMs,
    reply: pair.id,
  })
}

function activeSession(id: string, name: string, role: string, cwd: string, now: number): ActiveSessionInfo {
  return {
    id,
    name,
    role,
    pid: process.pid,
    cwd,
    claudeSessionId: null,
    registeredAt: now,
    launchId: null,
    launchParentPid: null,
    transportPids: [],
  }
}

function parseToolResult(result: ReturnType<typeof handleToolCall>): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Record<string, unknown>
}

describe("20876 Tribe health cadence", () => {
  let tmpDir: string
  let db: OpenDatabase
  let stmts: TribeStatements
  let now: number

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-health-cadence-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
    now = Date.now()

    insertSession(db, { id: "sess-chief", name: "@chief", role: "chief", now })
    insertSession(db, { id: "sess-agent-5", name: "@agent/5", role: "member", now })

    for (const [index, latencyMs] of [5 * MINUTE, 10 * MINUTE, 40 * MINUTE, 60 * MINUTE].entries()) {
      insertResponsePair(db, {
        id: `request-${index + 1}`,
        type: "request",
        sender: "@chief",
        recipient: "@agent/5",
        requestAt: now - [23 * HOUR, 3 * HOUR, 2 * HOUR, 70 * MINUTE][index]!,
        latencyMs,
      })
    }
    insertResponsePair(db, {
      id: "query-chief",
      type: "query",
      sender: "@agent/5",
      recipient: "@chief",
      requestAt: now - 20 * MINUTE,
      latencyMs: 2 * MINUTE,
    })

    stmts.openPendingRequest.run({
      $request_id: "open-agent-5",
      $recipient: "@agent/5",
      $sender: "@chief",
      $opened_at: now - 3 * HOUR,
      $expires_at: null,
      $message_id: "request-2",
      $fanout: "first",
    })

    db.prepare(`
      INSERT INTO messages_archive (
        seq, id, type, sender, recipient, kind, content, ts, delivery, archived_at
      ) VALUES (
        1000, 'archived-broadcast', 'notify', '@ci', '*', 'broadcast',
        'archived cadence evidence', $ts, 'pull', $archived_at
      )
    `).run({ $ts: now - 8 * DAY, $archived_at: now - DAY })
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("projects deterministic latency, lag, ball, and growth evidence from existing tables", () => {
    const options = {
      now,
      liveSessionNames: ["@agent/5"],
      dbGrowthWarningBytes: 1,
    }

    const first = projectHealthCadence(db, options)
    const second = projectHealthCadence(db, options)

    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(first.response_latency).toEqual({
      window_ms: DAY,
      count: 5,
      p50_ms: 10 * MINUTE,
      p95_ms: 60 * MINUTE,
      max_ms: 60 * MINUTE,
      by_role_and_type: [
        {
          role: "chief",
          message_type: "query",
          count: 1,
          p50_ms: 2 * MINUTE,
          p95_ms: 2 * MINUTE,
          max_ms: 2 * MINUTE,
        },
        {
          role: "member",
          message_type: "request",
          count: 4,
          p50_ms: 10 * MINUTE,
          p95_ms: 60 * MINUTE,
          max_ms: 60 * MINUTE,
        },
      ],
    })
    expect(first.open_balls).toEqual({ count: 1, oldest_age_ms: 3 * HOUR })
    expect(first.inbox_lag).toEqual([
      {
        session: "@agent/5",
        rows: 6,
        oldest_age_ms: 8 * DAY,
        actionable_rows: 4,
        actionable_oldest_age_ms: 23 * HOUR,
      },
    ])
    expect(first.database).toMatchObject({
      message_rows: 10,
      archive_rows: 1,
      growth_7d: { message_rows: 10, archive_rows: 1 },
      growth_warning_bytes: 1,
    })
    expect(first.database.bytes).toBeGreaterThan(0)
    expect(first.database.growth_7d.estimated_bytes).toBeGreaterThan(1)
    expect(first.warnings).toEqual([
      expect.stringMatching(/member.*request.*p95.*60m/i),
      expect.stringMatching(/Chief actionable response.*completed.*2m.*target.*60s/i),
      expect.stringMatching(/@agent\/5.*6.*8d/i),
      expect.stringMatching(/7d.*growth.*archive\/GC/i),
    ])
  })

  it("enforces a sub-minute Chief actionable-response target for completed and open work", () => {
    insertResponsePair(db, {
      id: "query-chief-fast",
      type: "query",
      sender: "@agent/5",
      recipient: "@chief",
      requestAt: now - 10 * MINUTE,
      latencyMs: 30_000,
    })
    stmts.openPendingRequest.run({
      $request_id: "query-chief-open",
      $recipient: "@chief",
      $sender: "@agent/5",
      $opened_at: now - 2 * MINUTE,
      $expires_at: null,
      $message_id: "query-chief-open",
      $fanout: "first",
    })

    const cadence = projectHealthCadence(db, { now, liveSessionNames: ["@chief", "@agent/5"] })

    expect(cadence.chief_actionable_response).toEqual({
      target_ms: MINUTE,
      status: "breached",
      completed: {
        count: 2,
        p50_ms: 30_000,
        p95_ms: 2 * MINUTE,
        max_ms: 2 * MINUTE,
        within_target: 1,
        missed_target: 1,
      },
      open: {
        count: 1,
        oldest_age_ms: 2 * MINUTE,
        over_target_count: 1,
      },
    })
    expect(cadence.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Chief actionable response.*completed.*2m.*target.*60s/i),
        expect.stringMatching(/Chief actionable response.*open.*2m.*target.*60s/i),
      ]),
    )
  })

  it("surfaces the cadence projection and evidence-bearing warnings through tribe.health", () => {
    const ctx = createTribeContext({
      db,
      stmts,
      sessionId: "sess-chief",
      sessionRole: "member",
      initialName: "@chief",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    const opts: HandlerOpts = {
      cleanup: () => undefined,
      userRenamed: false,
      setUserRenamed: () => undefined,
      getActiveSessionIds: () => new Set(["sess-agent-5"]),
      getActiveSessionInfo: () => [activeSession("sess-agent-5", "@agent/5", "member", tmpDir, now)],
    }

    const health = parseToolResult(handleToolCall(ctx, "tribe.health", {}, opts)) as {
      cadence?: { response_latency?: { count?: number }; inbox_lag?: Array<{ session?: string }> }
      issues?: string[]
    }

    expect(health.cadence?.response_latency?.count).toBe(5)
    expect(health.cadence?.inbox_lag).toEqual([expect.objectContaining({ session: "@agent/5" })])
    expect(health.issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/1 stale pending ball.*1 owner/i),
        expect.stringMatching(/member.*request.*p95/i),
        expect.stringMatching(/@agent\/5.*inbox lag|inbox lag.*@agent\/5/i),
      ]),
    )
  })
})
