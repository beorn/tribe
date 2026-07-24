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
  let savedSlaRole: string | undefined
  let savedSlaSeconds: string | undefined

  beforeEach(() => {
    // The actionable-response SLA is opt-in via TRIBE_SLA_ROLE; neutralize any
    // ambient env so env-reading paths (tribe.health handler) stay deterministic.
    savedSlaRole = process.env.TRIBE_SLA_ROLE
    savedSlaSeconds = process.env.TRIBE_SLA_SECONDS
    delete process.env.TRIBE_SLA_ROLE
    delete process.env.TRIBE_SLA_SECONDS

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
    if (savedSlaRole === undefined) delete process.env.TRIBE_SLA_ROLE
    else process.env.TRIBE_SLA_ROLE = savedSlaRole
    if (savedSlaSeconds === undefined) delete process.env.TRIBE_SLA_SECONDS
    else process.env.TRIBE_SLA_SECONDS = savedSlaSeconds
  })

  it("projects deterministic latency, lag, ball, and growth evidence from existing tables", () => {
    const options = {
      now,
      connectedSessionNames: ["@agent/5"],
      dbGrowthWarningBytes: 1,
      slaRole: "@chief",
    }

    const first = projectHealthCadence(db, options)
    const second = projectHealthCadence(db, options)

    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(first.as_of_ms).toBe(now)
    expect(first.response_latency).toEqual({
      as_of_ms: now,
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
    expect(first.open_balls).toEqual({ as_of_ms: now, count: 1, oldest_age_ms: 3 * HOUR })
    expect(first.inbox_lag).toEqual([
      {
        as_of_ms: now,
        session: "@agent/5",
        rows: 6,
        oldest_age_ms: 8 * DAY,
        actionable_rows: 4,
        actionable_oldest_age_ms: 23 * HOUR,
        tracking_since_ms: now,
        last_attention_read_at_ms: null,
        last_attention_read_age_ms: null,
        oldest_actionable: {
          id: "request-1",
          type: "request",
          sender: "@chief",
          summary: "request-1",
          ts_ms: now - 23 * HOUR,
        },
        evidence: {
          source: "tribe-mailbox-cursors",
          scope: "connected-session cursor backlog",
          excludes: ["pane", "turn", "seat-liveness"],
          verdict: "projection-only",
        },
      },
    ])
    expect(first.database).toMatchObject({
      as_of_ms: now,
      message_rows: 10,
      archive_rows: 1,
      growth_7d: { message_rows: 10, archive_rows: 1 },
      growth_warning_bytes: 1,
    })
    expect(first.database.bytes).toBeGreaterThan(0)
    expect(first.database.growth_7d.estimated_bytes).toBeGreaterThan(1)
    expect(first.warnings).toEqual([
      expect.stringMatching(/member.*request.*p95.*60m/i),
      expect.stringMatching(/@chief actionable response.*completed.*2m.*target.*60s/i),
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

    const cadence = projectHealthCadence(db, {
      now,
      connectedSessionNames: ["@chief", "@agent/5"],
      slaRole: "@chief",
    })

    expect(cadence.role_actionable_response).toEqual({
      as_of_ms: now,
      role: "@chief",
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
        expect.stringMatching(/@chief actionable response.*completed.*2m.*target.*60s/i),
        expect.stringMatching(/@chief actionable response.*open.*2m.*target.*60s/i),
      ]),
    )
  })

  it("age-stamps a stale inbox projection and never turns it into a seat-liveness verdict", () => {
    const beforeDrain = projectHealthCadence(db, { now, connectedSessionNames: ["@agent/5"] })
    const oldWarning = beforeDrain.warnings.find((warning) => warning.includes("@agent/5"))

    expect(beforeDrain.inbox_lag[0]).toMatchObject({
      as_of_ms: now,
      evidence: {
        source: "tribe-mailbox-cursors",
        scope: "connected-session cursor backlog",
        excludes: ["pane", "turn", "seat-liveness"],
        verdict: "projection-only",
      },
    })
    expect(oldWarning).toContain(`as-of ${new Date(now).toISOString()}`)
    expect(oldWarning).toMatch(/projection-only.*pane\/turn liveness excluded/i)
    expect(oldWarning).not.toMatch(/\b(?:idle|dead|alive)\b/i)

    const afterDrain = projectHealthCadence(db, {
      now: now + MINUTE,
      connectedSessionNames: [],
    })

    expect(afterDrain.as_of_ms).toBe(now + MINUTE)
    expect(afterDrain.inbox_lag).toEqual([])
    expect(afterDrain.warnings.join("\n")).not.toContain("@agent/5")
  })

  it("projects literal attention-read and oldest-actionable facts for WATCH policy", () => {
    db.prepare(
      "INSERT INTO mailbox_cursors (recipient, last_actionable_seq, updated_at, last_attention_read_at) VALUES (?, 0, ?, ?)",
    ).run("@agent/5", now - 12 * MINUTE, now - 12 * MINUTE)

    const row = projectHealthCadence(db, { now, connectedSessionNames: ["@agent/5"] }).inbox_lag[0]
    expect(row).toMatchObject({
      session: "@agent/5",
      actionable_rows: 4,
      actionable_oldest_age_ms: 23 * HOUR,
      last_attention_read_at_ms: now - 12 * MINUTE,
      last_attention_read_age_ms: 12 * MINUTE,
      oldest_actionable: {
        id: "request-1",
        type: "request",
        sender: "@chief",
        summary: "request-1",
      },
    })
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
      hasActiveTransport: (sessionId) => sessionId === "sess-agent-5",
      getActiveSessionInfo: () => [activeSession("sess-agent-5", "@agent/5", "member", tmpDir, now)],
    }

    const health = parseToolResult(handleToolCall(ctx, "tribe.health", {}, opts)) as {
      cadence?: { as_of_ms?: number; response_latency?: { count?: number }; inbox_lag?: Array<{ session?: string }> }
      issues?: string[]
    }

    expect(health.cadence?.as_of_ms).toBeTypeOf("number")
    expect(health.cadence?.response_latency?.count).toBe(5)
    expect(health.cadence?.inbox_lag).toEqual([expect.objectContaining({ session: "@agent/5" })])
    expect(health.issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/1 stale pending ball.*1 owner/i),
        expect.stringMatching(/member.*request.*p95/i),
        expect.stringMatching(/inbox cursor projection.*@agent\/5.*as-of.*projection-only.*liveness excluded/i),
      ]),
    )
  })

  it("omits the actionable-response SLA projection and its warnings when no role is configured", () => {
    const cadence = projectHealthCadence(db, {
      now,
      connectedSessionNames: ["@chief", "@agent/5"],
      dbGrowthWarningBytes: 1,
      slaRole: null,
    })

    // Standalone purity: the daemon carries no @chief/SLA concept unless opted in.
    expect(cadence.role_actionable_response).toBeUndefined()
    expect(cadence.warnings.some((warning) => /actionable response/i.test(warning))).toBe(false)
    // The generic (host-agnostic) projections still report.
    expect(cadence.response_latency.count).toBe(5)
    expect(cadence.open_balls).toEqual({ as_of_ms: now, count: 1, oldest_age_ms: 3 * HOUR })
  })

  it("projects the actionable-response SLA against a custom role with a custom target when opted in", () => {
    // @agent/5 sent the four request replies (5m/10m/40m/60m) and owns the one
    // open ball; a 30m target splits them 2 within / 2 missed.
    const cadence = projectHealthCadence(db, {
      now,
      connectedSessionNames: ["@agent/5"],
      slaRole: "@agent/5",
      slaTargetMs: 30 * MINUTE,
    })

    expect(cadence.role_actionable_response).toEqual({
      as_of_ms: now,
      role: "@agent/5",
      target_ms: 30 * MINUTE,
      status: "breached",
      completed: {
        count: 4,
        p50_ms: 10 * MINUTE,
        p95_ms: 60 * MINUTE,
        max_ms: 60 * MINUTE,
        within_target: 2,
        missed_target: 2,
      },
      open: {
        count: 1,
        oldest_age_ms: 3 * HOUR,
        over_target_count: 1,
      },
    })
    expect(cadence.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/@agent\/5 actionable response.*completed.*1h.*target.*1800s.*missed=2\/4/i),
        expect.stringMatching(/@agent\/5 actionable response.*open.*3h.*target.*1800s.*overdue=1\/1/i),
      ]),
    )
  })

  it("reads TRIBE_SLA_ROLE from the environment when no explicit option is passed", () => {
    process.env.TRIBE_SLA_ROLE = "@chief"
    const cadence = projectHealthCadence(db, { now, connectedSessionNames: ["@chief", "@agent/5"] })
    expect(cadence.role_actionable_response?.role).toBe("@chief")
    expect(cadence.role_actionable_response?.target_ms).toBe(MINUTE)
  })
})
