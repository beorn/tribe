import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { projectHealthCadence } from "./health-cadence.ts"
import { sendMessage } from "./messaging.ts"
import { processPendingBallDeadlines } from "./pending-ball-deadlines.ts"
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
        expect.stringMatching(/open-agent-5.*@agent\/5|@agent\/5.*open-agent-5/),
        expect.stringMatching(/member.*request.*p95/i),
        expect.stringMatching(/@agent\/5.*inbox lag|inbox lag.*@agent\/5/i),
      ]),
    )
  })

  it("nudges at half-life and escalates once at expiry across repeated and restarted cadence ticks", () => {
    stmts.openPendingRequest.run({
      $request_id: "deadline-review",
      $recipient: "@agent/5",
      $sender: "@chief",
      $opened_at: now - 10 * MINUTE,
      $expires_at: now + 10 * MINUTE,
      $message_id: "deadline-review-message",
      $fanout: "first",
    })
    const sent: Array<{ recipient: string; content: string; type: string }> = []
    const send = (recipient: string, content: string, type: string) => sent.push({ recipient, content, type })

    processPendingBallDeadlines({
      db,
      stmts,
      now,
      liveSessionNames: new Set(["@agent/5"]),
      escalationTarget: "@ops",
      send,
    })
    expect(sent).toEqual([{ recipient: "@agent/5", content: expect.any(String), type: "ball:nudge" }])

    const restartedDb = openDatabase(join(tmpDir, "tribe.db"))
    try {
      processPendingBallDeadlines({
        db: restartedDb,
        stmts: createStatements(restartedDb),
        now,
        liveSessionNames: new Set(["@agent/5"]),
        escalationTarget: "@ops",
        send,
      })
    } finally {
      restartedDb.close()
    }
    expect(sent).toHaveLength(1)

    processPendingBallDeadlines({
      db,
      stmts,
      now: now + 10 * MINUTE,
      liveSessionNames: new Set(["@agent/5"]),
      escalationTarget: "@ops",
      send,
    })
    processPendingBallDeadlines({
      db,
      stmts,
      now: now + 10 * MINUTE,
      liveSessionNames: new Set(["@agent/5"]),
      escalationTarget: "@ops",
      send,
    })

    expect(sent).toEqual([
      { recipient: "@agent/5", content: expect.any(String), type: "ball:nudge" },
      {
        recipient: "@chief",
        content: expect.stringMatching(/re-ping.*ask.*decide.*mark.*moot/i),
        type: "ball:expired",
      },
      {
        recipient: "@ops",
        content: expect.stringMatching(/re-ping.*ask.*decide.*mark.*moot/i),
        type: "ball:expired",
      },
    ])
    expect(db.prepare("SELECT recipient FROM pending_request WHERE request_id = 'deadline-review'").get()).toEqual({
      recipient: "@agent/5",
    })
    db.prepare("UPDATE dedup SET ts = 0 WHERE key LIKE 'ball-deadline:%'").run()
    stmts.cleanupDedup.run({ $cutoff: now })
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM dedup WHERE key LIKE 'ball-deadline:%'").get() as { count: number })
        .count,
    ).toBe(2)
    db.prepare("DELETE FROM pending_request WHERE request_id = 'deadline-review'").run()
    stmts.cleanupDedup.run({ $cutoff: now })
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM dedup WHERE key LIKE 'ball-deadline:%'").get() as { count: number })
        .count,
    ).toBe(0)
  })

  it("warns the sender that expiry retains ownership when no escalation target is configured", () => {
    stmts.openPendingRequest.run({
      $request_id: "deadline-no-policy",
      $recipient: "@agent/6",
      $sender: "@author",
      $opened_at: now - 30 * MINUTE,
      $expires_at: now,
      $message_id: "deadline-no-policy-message",
      $fanout: "first",
    })
    const sent: Array<{ recipient: string; content: string; type: string }> = []

    processPendingBallDeadlines({
      db,
      stmts,
      now,
      liveSessionNames: new Set(["@agent/5", "@agent/6"]),
      escalationTarget: null,
      send: (recipient, content, type) => sent.push({ recipient, content, type }),
    })

    expect(sent).toEqual([
      {
        recipient: "@author",
        content: expect.stringMatching(/no escalation target is configured.*ownership remains with @agent\/6/i),
        type: "ball:expired",
      },
    ])
    expect(db.prepare("SELECT recipient FROM pending_request WHERE request_id = 'deadline-no-policy'").get()).toEqual({
      recipient: "@agent/6",
    })
  })

  it("retries an expiry after a failed send without stranding a durable stage claim", () => {
    stmts.openPendingRequest.run({
      $request_id: "deadline-retry",
      $recipient: "@agent/6",
      $sender: "@author",
      $opened_at: now - 10 * MINUTE,
      $expires_at: now,
      $message_id: "deadline-retry-message",
      $fanout: "first",
    })

    expect(() =>
      processPendingBallDeadlines({
        db,
        stmts,
        now,
        liveSessionNames: new Set(["@agent/5", "@agent/6"]),
        escalationTarget: null,
        send: () => {
          throw new Error("first delivery failed")
        },
      }),
    ).toThrow("first delivery failed")
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM dedup WHERE key LIKE '%deadline-retry%'").get() as { count: number })
        .count,
    ).toBe(0)

    const restartedDb = openDatabase(join(tmpDir, "tribe.db"))
    const sent: string[] = []
    try {
      const result = processPendingBallDeadlines({
        db: restartedDb,
        stmts: createStatements(restartedDb),
        now,
        liveSessionNames: new Set(["@agent/5", "@agent/6"]),
        escalationTarget: null,
        send: (_recipient, _content, type) => sent.push(type),
      })
      expect(result.expired).toBe(1)
    } finally {
      restartedDb.close()
    }
    expect(sent).toEqual(["ball:expired"])
  })

  it("retains a delivered sender warning while retrying a failed LLM escalation", () => {
    db.prepare("DELETE FROM pending_request WHERE request_id = 'open-agent-5'").run()
    insertSession(db, { id: "sess-dead-atomic", name: "@agent/dead-atomic", role: "member", now })
    db.prepare("UPDATE sessions SET pid = 474747 WHERE name = '@agent/dead-atomic'").run()
    stmts.openPendingRequest.run({
      $request_id: "dead-atomic",
      $recipient: "@agent/dead-atomic",
      $sender: "@author",
      $opened_at: now,
      $expires_at: now + 10 * MINUTE,
      $message_id: "dead-atomic-message",
      $fanout: "first",
    })
    const daemonCtx = createTribeContext({
      db,
      stmts,
      sessionId: "daemon-deadline-test",
      sessionRole: "daemon",
      initialName: "daemon",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    let delivery = 0

    expect(() =>
      processPendingBallDeadlines({
        db,
        stmts,
        now,
        liveSessionNames: new Set(),
        escalationTarget: "@ops",
        isPidAlive: () => false,
        send(recipient, content, type) {
          delivery += 1
          if (delivery === 2) throw new Error("second delivery failed")
          sendMessage(daemonCtx, recipient, content, type)
        },
      }),
    ).toThrow("second delivery failed")

    expect(db.prepare("SELECT recipient FROM pending_request WHERE request_id = 'dead-atomic'").get()).toEqual({
      recipient: "@agent/dead-atomic",
    })
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM messages WHERE type = 'ball:owner-dead'").get() as { count: number })
        .count,
    ).toBe(1)
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM dedup WHERE key LIKE '%dead-atomic%'").get() as { count: number })
        .count,
    ).toBe(1)

    const result = processPendingBallDeadlines({
      db,
      stmts,
      now,
      liveSessionNames: new Set(),
      escalationTarget: "@ops",
      isPidAlive: () => false,
      send: (recipient, content, type) => sendMessage(daemonCtx, recipient, content, type),
    })
    expect(result.deadOwnerWarnings).toBe(1)
    expect(db.prepare("SELECT recipient FROM pending_request WHERE request_id = 'dead-atomic'").get()).toEqual({
      recipient: "@agent/dead-atomic",
    })
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM messages WHERE type = 'ball:owner-dead'").get() as { count: number })
        .count,
    ).toBe(2)
  })

  it("lets only one reentrant cadence invocation actuate a deadline stage", () => {
    stmts.openPendingRequest.run({
      $request_id: "deadline-reentrant",
      $recipient: "@agent/6",
      $sender: "@author",
      $opened_at: now - 10 * MINUTE,
      $expires_at: now,
      $message_id: "deadline-reentrant-message",
      $fanout: "first",
    })
    let sends = 0
    let nestedExpired = -1
    const options = {
      db,
      stmts,
      now,
      liveSessionNames: new Set(["@agent/5", "@agent/6"]),
      escalationTarget: null,
      send: () => {
        sends += 1
        if (sends === 1) nestedExpired = processPendingBallDeadlines(options).expired
      },
    }

    expect(processPendingBallDeadlines(options).expired).toBe(1)
    expect(nestedExpired).toBe(0)
    expect(sends).toBe(1)
  })

  it("treats a permission-denied owner probe as unresolved and retains ownership", () => {
    db.prepare("DELETE FROM pending_request WHERE request_id = 'open-agent-5'").run()
    insertSession(db, { id: "sess-eperm", name: "@agent/eperm", role: "member", now })
    db.prepare("UPDATE sessions SET pid = 484848 WHERE name = '@agent/eperm'").run()
    stmts.openPendingRequest.run({
      $request_id: "owner-eperm",
      $recipient: "@agent/eperm",
      $sender: "@author",
      $opened_at: now,
      $expires_at: now + 10 * MINUTE,
      $message_id: "owner-eperm-message",
      $fanout: "first",
    })
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" })
    })
    const sent: string[] = []
    try {
      const result = processPendingBallDeadlines({
        db,
        stmts,
        now,
        liveSessionNames: new Set(),
        escalationTarget: "@ops",
        send: (_recipient, _content, type) => sent.push(type),
      })
      expect(result.deadOwnerWarnings).toBe(1)
    } finally {
      kill.mockRestore()
    }

    expect(sent).toEqual(["ball:owner-unresolved"])
    expect(db.prepare("SELECT recipient FROM pending_request WHERE request_id = 'owner-eperm'").get()).toEqual({
      recipient: "@agent/eperm",
    })
  })

  it("escalates a dead owner and reports an already-reached deadline without reassigning", () => {
    db.prepare("DELETE FROM pending_request WHERE request_id = 'open-agent-5'").run()
    insertSession(db, { id: "sess-dead-expired", name: "@agent/dead-expired", role: "member", now })
    db.prepare("UPDATE sessions SET pid = 454545 WHERE name = '@agent/dead-expired'").run()
    stmts.openPendingRequest.run({
      $request_id: "dead-and-expired",
      $recipient: "@agent/dead-expired",
      $sender: "@author",
      $opened_at: now - 30 * MINUTE,
      $expires_at: now,
      $message_id: "dead-and-expired-message",
      $fanout: "first",
    })
    const sent: Array<{ recipient: string; type: string }> = []

    processPendingBallDeadlines({
      db,
      stmts,
      now,
      liveSessionNames: new Set(["@ops"]),
      escalationTarget: "@ops",
      isPidAlive: () => false,
      send: (recipient, _content, type) => sent.push({ recipient, type }),
    })
    processPendingBallDeadlines({
      db,
      stmts,
      now,
      liveSessionNames: new Set(["@ops"]),
      escalationTarget: "@ops",
      isPidAlive: () => false,
      send: (recipient, _content, type) => sent.push({ recipient, type }),
    })

    expect(sent).toEqual([
      { recipient: "@author", type: "ball:owner-dead" },
      { recipient: "@ops", type: "ball:owner-dead" },
      { recipient: "@author", type: "ball:expired" },
      { recipient: "@ops", type: "ball:expired" },
    ])
    expect(db.prepare("SELECT recipient FROM pending_request WHERE request_id = 'dead-and-expired'").get()).toEqual({
      recipient: "@agent/dead-expired",
    })
  })

  it("does not repeat an already-actuated expiry when its owner is later detected dead", () => {
    db.prepare("DELETE FROM pending_request WHERE request_id = 'open-agent-5'").run()
    insertSession(db, { id: "sess-late-dead", name: "@agent/late-dead", role: "member", now })
    db.prepare("UPDATE sessions SET pid = 505050 WHERE name = '@agent/late-dead'").run()
    stmts.openPendingRequest.run({
      $request_id: "expired-before-death",
      $recipient: "@agent/late-dead",
      $sender: "@author",
      $opened_at: now - 20 * MINUTE,
      $expires_at: now,
      $message_id: "expired-before-death-message",
      $fanout: "first",
    })
    const sent: Array<{ recipient: string; type: string }> = []
    const send = (recipient: string, _content: string, type: string) => sent.push({ recipient, type })

    processPendingBallDeadlines({
      db,
      stmts,
      now,
      liveSessionNames: new Set(["@agent/late-dead"]),
      escalationTarget: "@ops",
      isPidAlive: () => false,
      send,
    })
    processPendingBallDeadlines({
      db,
      stmts,
      now: now + MINUTE,
      liveSessionNames: new Set(),
      escalationTarget: "@ops",
      isPidAlive: () => false,
      send,
    })

    expect(sent).toEqual([
      { recipient: "@author", type: "ball:expired" },
      { recipient: "@ops", type: "ball:expired" },
      { recipient: "@author", type: "ball:owner-dead" },
      { recipient: "@ops", type: "ball:owner-dead" },
    ])
  })

  it("escalates a dead owner without sending it a halfway nudge", () => {
    db.prepare("DELETE FROM pending_request WHERE request_id = 'open-agent-5'").run()
    insertSession(db, { id: "sess-dead-halfway", name: "@agent/dead-halfway", role: "member", now })
    db.prepare("UPDATE sessions SET pid = 515151 WHERE name = '@agent/dead-halfway'").run()
    stmts.openPendingRequest.run({
      $request_id: "dead-at-halfway",
      $recipient: "@agent/dead-halfway",
      $sender: "@author",
      $opened_at: now - 10 * MINUTE,
      $expires_at: now + 10 * MINUTE,
      $message_id: "dead-at-halfway-message",
      $fanout: "first",
    })
    const sent: Array<{ recipient: string; type: string }> = []

    processPendingBallDeadlines({
      db,
      stmts,
      now,
      liveSessionNames: new Set(),
      escalationTarget: "@ops",
      isPidAlive: () => false,
      send: (recipient, _content, type) => sent.push({ recipient, type }),
    })

    expect(sent).toEqual([
      { recipient: "@author", type: "ball:owner-dead" },
      { recipient: "@ops", type: "ball:owner-dead" },
    ])
  })

  it("preserves every owner row when the escalation target already owns the same request", () => {
    db.prepare("DELETE FROM pending_request WHERE request_id = 'open-agent-5'").run()
    insertSession(db, { id: "sess-dead-collision", name: "@agent/dead-collision", role: "member", now })
    db.prepare("UPDATE sessions SET pid = 464646 WHERE name = '@agent/dead-collision'").run()
    stmts.openPendingRequest.run({
      $request_id: "retained-collision",
      $recipient: "@agent/dead-collision",
      $sender: "@author",
      $opened_at: now - 31 * MINUTE,
      $expires_at: now,
      $message_id: "retained-collision-source",
      $fanout: "all",
    })
    stmts.openPendingRequest.run({
      $request_id: "retained-collision",
      $recipient: "@ops",
      $sender: "@author",
      $opened_at: now - 30 * MINUTE,
      $expires_at: now,
      $message_id: "retained-collision-target",
      $fanout: "all",
    })
    const sent: Array<{ recipient: string; type: string }> = []
    const tick = () =>
      processPendingBallDeadlines({
        db,
        stmts,
        now,
        liveSessionNames: new Set(["@ops"]),
        escalationTarget: "@ops",
        isPidAlive: () => false,
        send: (recipient, _content, type) => sent.push({ recipient, type }),
      })

    tick()
    expect(sent).toEqual([
      { recipient: "@author", type: "ball:owner-dead" },
      { recipient: "@ops", type: "ball:owner-dead" },
      { recipient: "@author", type: "ball:expired" },
      { recipient: "@ops", type: "ball:expired" },
      { recipient: "@author", type: "ball:expired" },
      { recipient: "@ops", type: "ball:expired" },
    ])
    expect(
      db
        .prepare(
          "SELECT recipient, message_id FROM pending_request WHERE request_id = 'retained-collision' ORDER BY recipient",
        )
        .all(),
    ).toEqual([
      { recipient: "@agent/dead-collision", message_id: "retained-collision-source" },
      { recipient: "@ops", message_id: "retained-collision-target" },
    ])

    db.prepare("UPDATE dedup SET ts = 0 WHERE key LIKE 'ball-deadline:%'").run()
    stmts.cleanupDedup.run({ $cutoff: now })
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM dedup WHERE key LIKE '%:expired:%'").get() as { count: number }).count,
    ).toBe(2)
    tick()
    expect(sent).toHaveLength(6)
  })

  it("detects positively-dead owners, escalates for LLM judgment, and retains ownership", () => {
    db.prepare("DELETE FROM pending_request WHERE request_id = 'open-agent-5'").run()
    db.prepare("UPDATE sessions SET pid = 424242 WHERE name = '@agent/5'").run()
    stmts.openPendingRequest.run({
      $request_id: "dead-owner",
      $recipient: "@agent/5",
      $sender: "@chief",
      $opened_at: now,
      $expires_at: now + 30 * MINUTE,
      $message_id: "dead-owner-message",
      $fanout: "first",
    })
    const sent: Array<{ recipient: string; type: string }> = []
    const send = (recipient: string, _content: string, type: string) => sent.push({ recipient, type })

    processPendingBallDeadlines({
      db,
      stmts,
      now,
      liveSessionNames: new Set(),
      escalationTarget: "@ops",
      isPidAlive: () => false,
      send,
    })

    insertSession(db, { id: "sess-dead-no-policy", name: "@agent/dead", role: "member", now })
    db.prepare("UPDATE sessions SET pid = 434343 WHERE name = '@agent/dead'").run()
    stmts.openPendingRequest.run({
      $request_id: "dead-without-policy",
      $recipient: "@agent/dead",
      $sender: "@author",
      $opened_at: now,
      $expires_at: now + 30 * MINUTE,
      $message_id: "dead-without-policy-message",
      $fanout: "first",
    })
    stmts.openPendingRequest.run({
      $request_id: "unknown-owner",
      $recipient: "@agent/unknown",
      $sender: "@author",
      $opened_at: now,
      $expires_at: now + 30 * MINUTE,
      $message_id: "unknown-owner-message",
      $fanout: "first",
    })
    processPendingBallDeadlines({
      db,
      stmts,
      now,
      liveSessionNames: new Set(["@ops"]),
      escalationTarget: null,
      isPidAlive: () => false,
      send,
    })

    expect(db.prepare("SELECT recipient FROM pending_request WHERE request_id = 'dead-owner'").get()).toEqual({
      recipient: "@agent/5",
    })
    expect(db.prepare("SELECT recipient FROM pending_request WHERE request_id = 'dead-without-policy'").get()).toEqual({
      recipient: "@agent/dead",
    })
    expect(db.prepare("SELECT recipient FROM pending_request WHERE request_id = 'unknown-owner'").get()).toEqual({
      recipient: "@agent/unknown",
    })
    expect(sent).toEqual([
      { recipient: "@chief", type: "ball:owner-dead" },
      { recipient: "@ops", type: "ball:owner-dead" },
      { recipient: "@author", type: "ball:owner-dead" },
      { recipient: "@author", type: "ball:owner-unresolved" },
    ])
  })
})
