import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { safeRemoveSync } from "removely"

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
    attentionRequired?: number
  },
): void {
  db.prepare(`
    INSERT INTO messages (
      id, type, sender, recipient, kind, content, ts, delivery, request, reply, summary, attention_required
    ) VALUES (
      $id, $type, $sender, $recipient, 'direct', $id, $ts, 'push', $request, $reply, $id, $attention_required
    )
  `).run({
    $id: message.id,
    $type: message.type,
    $sender: message.sender,
    $recipient: message.recipient,
    $ts: message.ts,
    $request: message.request ?? null,
    $reply: message.reply ?? null,
    $attention_required: message.attentionRequired ?? 0,
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
    safeRemoveSync(tmpDir, { within: tmpdir(), allowMissing: true })
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
        actionable_rows: 0,
        actionable_oldest_age_ms: 0,
        tracking_since_ms: now,
        last_attention_read_at_ms: null,
        last_attention_read_age_ms: null,
        oldest_actionable: null,
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
      actionable_rows: 0,
      actionable_oldest_age_ms: 0,
      last_attention_read_at_ms: now - 12 * MINUTE,
      last_attention_read_age_ms: 12 * MINUTE,
      oldest_actionable: null,
    })
  })

  it("projects attention-required responses for the fleet WATCH consumer", () => {
    insertSession(db, { id: "sess-dev-5", name: "@dev/5", role: "member", now })
    insertMessage(db, {
      id: "dev-5-verdict-response",
      type: "response",
      sender: "@cto",
      recipient: "@dev/5",
      ts: now - 12 * MINUTE,
      attentionRequired: 1,
    })

    const row = projectHealthCadence(db, { now, connectedSessionNames: ["@dev/5"] }).inbox_lag[0]
    expect(row).toMatchObject({
      session: "@dev/5",
      actionable_rows: 1,
      actionable_oldest_age_ms: 12 * MINUTE,
      oldest_actionable: {
        id: "dev-5-verdict-response",
        type: "response",
        sender: "@cto",
      },
    })
  })

  it("retires replied actionables from cadence without hiding an unrelated older request", () => {
    insertSession(db, { id: "sess-dev-2", name: "@dev/2", role: "member", now })
    insertMessage(db, {
      id: "dev-2-older-open",
      type: "request",
      sender: "@chief",
      recipient: "@dev/2",
      ts: now - 2 * HOUR,
      request: "dev-2-older-open",
    })
    insertResponsePair(db, {
      id: "dev-2-newer-replied",
      type: "request",
      sender: "@chief",
      recipient: "@dev/2",
      requestAt: now - HOUR,
      latencyMs: MINUTE,
    })

    const row = projectHealthCadence(db, { now, connectedSessionNames: ["@dev/2"] }).inbox_lag[0]
    expect(row).toMatchObject({
      session: "@dev/2",
      actionable_rows: 1,
      actionable_oldest_age_ms: 2 * HOUR,
      oldest_actionable: {
        id: "dev-2-older-open",
        type: "request",
        sender: "@chief",
      },
    })
  })

  it("combines a live actionable with an archived one for the same session, picking the oldest by sequence rather than timestamp", () => {
    // Regression for the health-cadence union split (residual to 20876/c4e2526f):
    // inboxLagProjection's three journal-CTE queries now run as a messages
    // half plus a messages_archive half, recombined in TypeScript. This case
    // is built so a wrong recombine would be visible two different ways:
    //  - actionable_rows must SUM across both halves (1 + 1 = 2), not just
    //    report whichever half happened to be checked.
    //  - oldest_actionable must be picked by the smaller SEQ (messages.rowid
    //    vs messages_archive.seq — one shared sequence space), which here is
    //    deliberately the LIVE row even though the ARCHIVED row has the
    //    smaller (older) ts. `actionable_oldest_age_ms` is a separate
    //    MIN(ts) aggregate, unchanged by the split, so it correctly reports
    //    the archived row's older ts — the two fields use different sort
    //    keys in the pre-split original, and the split must keep them that
    //    way rather than collapsing to a single "oldest" notion.
    insertSession(db, { id: "sess-dev-9", name: "@dev/9", role: "member", now })

    insertMessage(db, {
      id: "dev9-live-small-seq",
      type: "request",
      sender: "@chief",
      recipient: "@dev/9",
      ts: now - HOUR,
      request: "dev9-live-small-seq",
    })
    const liveRowid = (
      db.prepare("SELECT rowid FROM messages WHERE id = 'dev9-live-small-seq'").get() as { rowid: number }
    ).rowid

    db.prepare(`
      INSERT INTO messages_archive (
        seq, id, type, sender, recipient, kind, content, ts, delivery, archived_at, request, summary
      ) VALUES (
        $seq, 'dev9-archived-large-seq', 'request', '@chief', '@dev/9', 'direct',
        'archived actionable', $ts, 'push', $archived_at, 'dev9-archived-large-seq', 'dev9-archived-large-seq'
      )
    `).run({ $seq: liveRowid + 1000, $ts: now - 10 * HOUR, $archived_at: now - HOUR })

    const row = projectHealthCadence(db, { now, connectedSessionNames: ["@dev/9"] }).inbox_lag[0]
    expect(row).toMatchObject({
      session: "@dev/9",
      actionable_rows: 2,
      actionable_oldest_age_ms: 10 * HOUR,
      oldest_actionable: {
        id: "dev9-live-small-seq",
        type: "request",
        sender: "@chief",
      },
    })
  })

  it("retires a live actionable whose reply already landed in the archive", () => {
    // The retirement predicate (unretiredAttentionPredicateSql) always probes
    // both messages AND messages_archive regardless of which table the
    // OUTER candidate came from — that's what `relation: "journal"` selects,
    // preserved by both new split statements. A recombine that accidentally
    // passed `relation: "messages"` for the messages-half outer query would
    // only probe messages for a reply, miss this archived one, and
    // (wrongly) keep counting the request as open.
    insertSession(db, { id: "sess-dev-11", name: "@dev/11", role: "member", now })

    insertMessage(db, {
      id: "dev11-request",
      type: "request",
      sender: "@chief",
      recipient: "@dev/11",
      ts: now - 2 * HOUR,
      request: "dev11-request",
    })
    const requestRowid = (
      db.prepare("SELECT rowid FROM messages WHERE id = 'dev11-request'").get() as { rowid: number }
    ).rowid

    db.prepare(`
      INSERT INTO messages_archive (
        seq, id, type, sender, recipient, kind, content, ts, delivery, archived_at, reply
      ) VALUES (
        $seq, 'dev11-reply', 'response', '@dev/11', '@chief', 'direct',
        'archived reply', $ts, 'push', $archived_at, 'dev11-request'
      )
    `).run({ $seq: requestRowid + 1000, $ts: now - HOUR, $archived_at: now - 10 * MINUTE })

    const row = projectHealthCadence(db, { now, connectedSessionNames: ["@dev/11"] }).inbox_lag[0]
    expect(row).toMatchObject({
      session: "@dev/11",
      actionable_rows: 0,
      oldest_actionable: null,
    })
  })

  // 22733 — a snapshot read (ids, with/from/to) that DELIVERS the mailbox's
  // own actionable rows into the model's context acknowledges them, under the
  // one rule a monotonic cursor allows: never past an unacknowledged row the
  // snapshot did not deliver. Specimen 2026-09-05: a seat read a settling
  // response by id, acted on it, and stayed "1 actionable unread" for 57
  // minutes until the fleet watch paged it busy-not-draining.
  function fetchAs(sessionId: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
    const ctx = createTribeContext({
      db,
      stmts,
      sessionId,
      sessionRole: "member",
      initialName: name,
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    const opts: HandlerOpts = {
      cleanup: () => undefined,
      userRenamed: false,
      setUserRenamed: () => undefined,
      getActiveSessionIds: () => new Set([sessionId]),
      hasActiveTransport: (id) => id === sessionId,
      getActiveSessionInfo: () => [activeSession(sessionId, name, "member", tmpDir, now)],
    }
    return parseToolResult(handleToolCall(ctx, "tribe.fetch", args, opts) as ReturnType<typeof handleToolCall>)
  }

  it("a snapshot read by ids acknowledges the settling response it delivered, so cadence stops counting it", () => {
    insertSession(db, { id: "sess-dev-6", name: "@dev/6", role: "member", now })
    insertMessage(db, {
      id: "ci-held",
      type: "response",
      sender: "@ci",
      recipient: "@dev/6",
      ts: now - 57 * MINUTE,
      reply: "dev-6-own-request",
      attentionRequired: 1,
    })
    expect(projectHealthCadence(db, { now, connectedSessionNames: ["@dev/6"] }).inbox_lag[0]).toMatchObject({
      actionable_rows: 1,
      oldest_actionable: { id: "ci-held" },
    })

    const result = fetchAs("sess-dev-6", "@dev/6", { ids: ["ci-held"] })
    expect((result.events as Array<{ id: string }>).map((event) => event.id)).toEqual(["ci-held"])

    const row = projectHealthCadence(db, { now, connectedSessionNames: ["@dev/6"] }).inbox_lag[0]
    // Acknowledged, and the 21626 staleness stamp is untouched: a narrow read
    // never counts as checking the owned inbox.
    expect(row).toMatchObject({ actionable_rows: 0, oldest_actionable: null, last_attention_read_at_ms: null })
  })

  it("a snapshot read that skips an older unacknowledged row acknowledges nothing", () => {
    insertSession(db, { id: "sess-dev-6", name: "@dev/6", role: "member", now })
    insertMessage(db, {
      id: "older-request",
      type: "request",
      sender: "@chief",
      recipient: "@dev/6",
      ts: now - 2 * HOUR,
      request: "older-request",
    })
    insertMessage(db, {
      id: "newer-response",
      type: "response",
      sender: "@ci",
      recipient: "@dev/6",
      ts: now - HOUR,
      attentionRequired: 1,
    })

    fetchAs("sess-dev-6", "@dev/6", { ids: ["newer-response"] })

    const row = projectHealthCadence(db, { now, connectedSessionNames: ["@dev/6"] }).inbox_lag[0]
    expect(row).toMatchObject({ actionable_rows: 2, oldest_actionable: { id: "older-request" } })
  })

  it("a with: snapshot that delivers every unacknowledged row acknowledges all of them", () => {
    insertSession(db, { id: "sess-dev-6", name: "@dev/6", role: "member", now })
    insertMessage(db, {
      id: "ci-request",
      type: "request",
      sender: "@ci",
      recipient: "@dev/6",
      ts: now - 2 * HOUR,
      request: "ci-request",
    })
    insertMessage(db, {
      id: "ci-response",
      type: "response",
      sender: "@ci",
      recipient: "@dev/6",
      ts: now - HOUR,
      attentionRequired: 1,
    })
    expect(projectHealthCadence(db, { now, connectedSessionNames: ["@dev/6"] }).inbox_lag[0]).toMatchObject({
      actionable_rows: 2,
    })

    const result = fetchAs("sess-dev-6", "@dev/6", { with: "@ci" })
    expect((result.events as Array<{ id: string }>).map((event) => event.id)).toEqual(["ci-request", "ci-response"])

    const row = projectHealthCadence(db, { now, connectedSessionNames: ["@dev/6"] }).inbox_lag[0]
    expect(row).toMatchObject({ actionable_rows: 0, oldest_actionable: null })
  })

  it("a receipt:false snapshot read acknowledges nothing (21757: no model is behind it)", () => {
    insertSession(db, { id: "sess-dev-6", name: "@dev/6", role: "member", now })
    insertMessage(db, {
      id: "ci-held-relayed",
      type: "response",
      sender: "@ci",
      recipient: "@dev/6",
      ts: now - 10 * MINUTE,
      attentionRequired: 1,
    })

    fetchAs("sess-dev-6", "@dev/6", { ids: ["ci-held-relayed"], receipt: false })

    const row = projectHealthCadence(db, { now, connectedSessionNames: ["@dev/6"] }).inbox_lag[0]
    expect(row).toMatchObject({ actionable_rows: 1, oldest_actionable: { id: "ci-held-relayed" } })
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
