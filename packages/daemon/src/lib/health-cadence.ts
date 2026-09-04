import type { Database } from "bun:sqlite"
import {
  ATTENTION_PREDICATE_SQL,
  noOpenIncidentAttentionPredicateSql,
  unretiredAttentionPredicateSql,
} from "./database.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const RESPONSE_WARNING_MS = 30 * MINUTE
/** Exported for retention.ts, whose live window must not undercut it (21757). */
export const CURSOR_WARNING_MS = 30 * MINUTE
const DEFAULT_SLA_TARGET_MS = MINUTE

// ---------------------------------------------------------------------------
// Actionable-response SLA — OPT-IN, host-agnostic.
//
// A coordination fleet (e.g. hh's chief/agent tribe) can track how promptly a
// specific coordinator seat answers actionable work by naming that seat in the
// `TRIBE_SLA_ROLE` env var (value is a session NAME, e.g. `@chief`). When it is
// unset the whole `role_actionable_response` projection — and its threshold
// warnings — are ABSENT from tribe.health(), so the daemon stays free of any
// project-specific workflow concept (matches packages/daemon/README.md §
// Boundary).
//
// `TRIBE_SLA_SECONDS` optionally overrides the default 60s target.
// ---------------------------------------------------------------------------
const INBOX_LAG_EVIDENCE = {
  source: "tribe-mailbox-cursors",
  scope: "connected-session cursor backlog",
  excludes: ["pane", "turn", "seat-liveness"],
  verdict: "projection-only",
} as const

export type HealthCadenceOptions = {
  now: number
  connectedSessionNames: string[]
  dbGrowthWarningBytes?: number | null
  /**
   * Session NAME whose actionable-response SLA to project (e.g. `@chief`).
   * `undefined` → fall back to `process.env.TRIBE_SLA_ROLE`; `null`/empty →
   * feature off. This is the injection seam that keeps tests deterministic
   * without touching the process environment.
   */
  slaRole?: string | null
  /** Explicit SLA target in ms; `undefined` → `TRIBE_SLA_SECONDS` or the 60s default. */
  slaTargetMs?: number | null
}

type ProjectionStamp = {
  as_of_ms: number
}

type LatencySummary = {
  count: number
  p50_ms: number | null
  p95_ms: number | null
  max_ms: number | null
}

type ResponseLatencyGroup = LatencySummary & {
  role: string
  message_type: string
}

type ActionableCompletedSummary = LatencySummary & {
  within_target: number
  missed_target: number
}

type ActionableOpenSummary = {
  count: number
  oldest_age_ms: number
  over_target_count: number
}

export type RoleActionableResponseProjection = ProjectionStamp & {
  role: string
  target_ms: number
  status: "ok" | "breached"
  completed: ActionableCompletedSummary
  open: ActionableOpenSummary
}

export type HealthCadenceProjection = ProjectionStamp & {
  /** Present only when an actionable-response SLA role is configured (opt-in). */
  role_actionable_response?: RoleActionableResponseProjection
  response_latency: ProjectionStamp &
    LatencySummary & {
      window_ms: number
      by_role_and_type: ResponseLatencyGroup[]
    }
  open_balls: ProjectionStamp & {
    count: number
    oldest_age_ms: number
  }
  inbox_lag: Array<
    ProjectionStamp & {
      session: string
      rows: number
      oldest_age_ms: number
      actionable_rows: number
      actionable_oldest_age_ms: number
      /** When this connected seat began being observable for read silence. */
      tracking_since_ms: number
      /** Null until the seat receives a canonical fetch/inbox-wait attention projection. */
      last_attention_read_at_ms: number | null
      last_attention_read_age_ms: number | null
      /** Bounded literal identity of the oldest unread actionable, never a log parse. */
      oldest_actionable: {
        id: string
        type: string
        sender: string
        summary: string | null
        ts_ms: number
      } | null
      evidence: typeof INBOX_LAG_EVIDENCE
    }
  >
  database: ProjectionStamp & {
    bytes: number
    message_rows: number
    archive_rows: number
    growth_7d: {
      estimated_bytes: number
      message_rows: number
      archive_rows: number
    }
    growth_warning_bytes: number | null
  }
  warnings: string[]
}

type ResponseLatencyRow = {
  role: string
  sender: string
  message_type: string
  latency_ms: number
}

type LagRow = {
  rows: number
  oldest_ts: number | null
}

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null
}

function summarizeLatencies(values: number[]): LatencySummary {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: sorted.length,
    p50_ms: percentile(sorted, 0.5),
    p95_ms: percentile(sorted, 0.95),
    max_ms: sorted.at(-1) ?? null,
  }
}

function durationLabel(ms: number): string {
  if (ms >= DAY) return `${Math.floor(ms / DAY)}d`
  if (ms >= HOUR) return `${Math.floor(ms / HOUR)}h`
  if (ms >= MINUTE) return `${Math.floor(ms / MINUTE)}m`
  return `${Math.floor(ms / 1_000)}s`
}

/** SLA targets are naturally sub-minute, so render them in whole seconds. */
function targetLabel(ms: number): string {
  return `${Math.round(ms / 1_000)}s`
}

function ageFrom(now: number, oldestTs: number | null): number {
  return oldestTs === null ? 0 : Math.max(0, now - oldestTs)
}

/**
 * Recombines the messages/messages_archive halves of a `COUNT(*)`/`MIN(ts)`
 * pair that used to run once against the `journal` CTE. `MIN` over an empty
 * set is NULL in SQL, so a half with zero matching rows reports `oldest_ts:
 * null`; the combined oldest_ts is null only when BOTH halves are — matching
 * what `MIN(ts)` over the union would have produced.
 */
function combineJournalCount(messagesHalf: LagRow, archiveHalf: LagRow): LagRow {
  const oldestCandidates = [messagesHalf.oldest_ts, archiveHalf.oldest_ts].filter((ts): ts is number => ts !== null)
  return {
    rows: messagesHalf.rows + archiveHalf.rows,
    oldest_ts: oldestCandidates.length === 0 ? null : Math.min(...oldestCandidates),
  }
}

type OldestActionableCandidate = {
  id: string
  type: string
  sender: string
  summary: string | null
  ts: number
  /** messages.rowid or messages_archive.seq — one shared monotonic space. */
  seq: number
}

/**
 * Picks the candidate with the smaller seq/rowid — "oldest" is position in
 * the sequence space shared by messages.rowid and messages_archive.seq, the
 * same thing `ORDER BY m.seq ASC LIMIT 1` picked when both halves were one
 * statement against the CTE. This is deliberately NOT a `ts` comparison.
 */
function olderCandidate(
  a: OldestActionableCandidate | null,
  b: OldestActionableCandidate | null,
): OldestActionableCandidate | null {
  if (a === null) return b
  if (b === null) return a
  return a.seq <= b.seq ? a : b
}

function responseLatencyProjection(
  db: Database,
  now: number,
): {
  summary: HealthCadenceProjection["response_latency"]
  rows: ResponseLatencyRow[]
  warnings: string[]
} {
  const rows = db
    .prepare(`
      WITH journal AS (
        SELECT id, type, sender, recipient, ts, request, reply FROM messages
        UNION ALL
        SELECT id, type, sender, recipient, ts, request, reply FROM messages_archive
      )
      SELECT
        COALESCE(s.role, 'unknown') AS role,
        response_message.sender AS sender,
        request_message.type AS message_type,
        response_message.ts - request_message.ts AS latency_ms
      FROM journal response_message
      JOIN journal request_message
        ON response_message.reply IS NOT NULL
        AND request_message.request IS NOT NULL
        AND response_message.reply = request_message.request
      LEFT JOIN sessions s ON s.name = response_message.sender
      WHERE response_message.ts >= $cutoff
        AND response_message.ts <= $now
        AND response_message.ts >= request_message.ts
      ORDER BY role, message_type, latency_ms
    `)
    .all({ $cutoff: now - DAY, $now: now }) as ResponseLatencyRow[]

  const grouped = new Map<string, { role: string; messageType: string; values: number[] }>()
  for (const row of rows) {
    const key = JSON.stringify([row.role, row.message_type])
    const group = grouped.get(key) ?? { role: row.role, messageType: row.message_type, values: [] }
    group.values.push(row.latency_ms)
    grouped.set(key, group)
  }
  const byRoleAndType = [...grouped.values()]
    .sort((a, b) => a.role.localeCompare(b.role) || a.messageType.localeCompare(b.messageType))
    .map((group) => ({
      role: group.role,
      message_type: group.messageType,
      ...summarizeLatencies(group.values),
    }))
  const warnings = byRoleAndType.flatMap((group) => {
    const p95 = group.p95_ms
    return p95 !== null && p95 > RESPONSE_WARNING_MS
      ? [
          `response latency role=${group.role} type=${group.message_type} p95=${Math.floor(p95 / MINUTE)}m exceeds 30m (n=${group.count})`,
        ]
      : []
  })

  return {
    summary: {
      as_of_ms: now,
      window_ms: DAY,
      ...summarizeLatencies(rows.map((row) => row.latency_ms)),
      by_role_and_type: byRoleAndType,
    },
    rows,
    warnings,
  }
}

/**
 * Completed actionable responses SENT BY the SLA role in the 24h window.
 *
 * Keyed on the responder's session NAME (`row.sender === role`) so the completed
 * and open halves both pivot on the single `TRIBE_SLA_ROLE` name — the open half
 * matches `recipient = role`. (The pre-parameterization code keyed completed on
 * the `sessions.role` column string `"chief"` while open matched the recipient
 * name `"@chief"`; those two encodings can't be driven by one env var, so they
 * are reconciled onto the name. For `@chief` this yields identical numbers,
 * since the chief seat both is named `@chief` and holds role `chief`.)
 */
function actionableCompletedSummary(
  rows: ResponseLatencyRow[],
  role: string,
  targetMs: number,
): ActionableCompletedSummary {
  const latencies = rows.filter((row) => row.sender === role).map((row) => row.latency_ms)
  return {
    ...summarizeLatencies(latencies),
    within_target: latencies.filter((latency) => latency < targetMs).length,
    missed_target: latencies.filter((latency) => latency >= targetMs).length,
  }
}

function actionableOpenSummary(db: Database, now: number, role: string, targetMs: number): ActionableOpenSummary {
  const row = db
    .prepare(`
      SELECT
        COUNT(*) AS count,
        MIN(opened_at) AS oldest_opened_at,
        COALESCE(SUM(
          CASE WHEN $now - opened_at >= $target THEN 1 ELSE 0 END
        ), 0) AS over_target_count
      FROM pending_request
      WHERE recipient = $role
    `)
    .get({ $now: now, $target: targetMs, $role: role }) as {
    count: number
    oldest_opened_at: number | null
    over_target_count: number
  }
  return {
    count: row.count,
    oldest_age_ms: ageFrom(now, row.oldest_opened_at),
    over_target_count: row.over_target_count,
  }
}

function roleActionableResponseProjection(
  db: Database,
  now: number,
  rows: ResponseLatencyRow[],
  role: string,
  targetMs: number,
): {
  projection: RoleActionableResponseProjection
  warnings: string[]
} {
  const completed = actionableCompletedSummary(rows, role, targetMs)
  const open = actionableOpenSummary(db, now, role, targetMs)
  const warnings: string[] = []
  const target = targetLabel(targetMs)
  if (completed.missed_target > 0) {
    warnings.push(
      `${role} actionable response completed p95=${durationLabel(completed.p95_ms ?? 0)}; ` +
        `target <${target} missed=${completed.missed_target}/${completed.count}`,
    )
  }
  if (open.over_target_count > 0) {
    warnings.push(
      `${role} actionable response open oldest=${durationLabel(open.oldest_age_ms)}; ` +
        `target <${target} overdue=${open.over_target_count}/${open.count}`,
    )
  }
  return {
    projection: {
      as_of_ms: now,
      role,
      target_ms: targetMs,
      status: warnings.length === 0 ? "ok" : "breached",
      completed,
      open,
    },
    warnings,
  }
}

function openBallProjection(db: Database, now: number): HealthCadenceProjection["open_balls"] {
  const row = db
    .prepare(`
      SELECT COUNT(*) AS count, MIN(opened_at) AS oldest_opened_at
      FROM pending_request
    `)
    .get() as {
    count: number
    oldest_opened_at: number | null
  }
  return {
    as_of_ms: now,
    count: row.count,
    oldest_age_ms: ageFrom(now, row.oldest_opened_at),
  }
}

function inboxLagProjection(
  db: Database,
  now: number,
  connectedSessionNames: string[],
): {
  rows: HealthCadenceProjection["inbox_lag"]
  warnings: string[]
} {
  const cursorQuery = db.prepare(`
    SELECT last_inbox_pull_seq, started_at
    FROM sessions
    WHERE name = $session
    ORDER BY updated_at DESC
    LIMIT 1
  `)
  const attentionReceiptQuery = db.prepare(
    "SELECT last_attention_read_at FROM mailbox_cursors WHERE recipient = $session",
  )

  // Below, three statements that used to run once each against
  // `WITH journal AS (messages UNION ALL messages_archive)` are split into a
  // messages half and a messages_archive half, recombined in TypeScript by
  // combineJournalCount()/olderCandidate() below. A CTE carries no indexes,
  // so SQLite materialised the full union on every call — linear in journal
  // size, and paid once per connected seat since this whole function runs
  // inside the per-session map() below. Each half here is a plain indexed
  // lookup against one physical table instead. See database.ts's
  // `unretiredAttentionPredicateSql` (commit c4e2526f) for the retirement-
  // check half of this same split, and for the measured numbers that first
  // fix left as this file's residual.
  //
  // Both halves of a pair always share the identical WHERE clause, differing
  // only in which physical table (and which column supplies the shared
  // seq/rowid position) they read from.
  const lagQueryMessages = db.prepare(`
    SELECT COUNT(*) AS rows, MIN(ts) AS oldest_ts
    FROM messages
    WHERE rowid > $cursor
      AND kind != 'event'
      AND sender != $session
      AND (recipient = $session OR recipient = '*')
  `)
  const lagQueryArchive = db.prepare(`
    SELECT COUNT(*) AS rows, MIN(ts) AS oldest_ts
    FROM messages_archive
    WHERE seq > $cursor
      AND kind != 'event'
      AND sender != $session
      AND (recipient = $session OR recipient = '*')
  `)
  const actionableLagQueryMessages = db.prepare(`
    SELECT COUNT(*) AS rows, MIN(ts) AS oldest_ts
    FROM messages AS m
    WHERE m.rowid > COALESCE(
      (SELECT last_actionable_seq FROM mailbox_cursors WHERE recipient = $session),
      0
    )
      AND m.recipient = $session
      AND m.kind = 'direct'
      AND m.sender != $session
      AND ${ATTENTION_PREDICATE_SQL}
      AND ${noOpenIncidentAttentionPredicateSql("m", "$session")}
      AND ${unretiredAttentionPredicateSql("m", { relation: "journal", sequence: "rowid" })}
  `)
  const actionableLagQueryArchive = db.prepare(`
    SELECT COUNT(*) AS rows, MIN(ts) AS oldest_ts
    FROM messages_archive AS m
    WHERE m.seq > COALESCE(
      (SELECT last_actionable_seq FROM mailbox_cursors WHERE recipient = $session),
      0
    )
      AND m.recipient = $session
      AND m.kind = 'direct'
      AND m.sender != $session
      AND ${ATTENTION_PREDICATE_SQL}
      AND ${noOpenIncidentAttentionPredicateSql("m", "$session")}
      AND ${unretiredAttentionPredicateSql("m", { relation: "journal", sequence: "seq" })}
  `)
  // Selects the shared seq/rowid position too (absent from the original
  // SELECT list, which only ever needed it in ORDER BY against the single
  // CTE) so olderCandidate() below can compare the two halves' candidates the
  // same way `ORDER BY m.seq ASC LIMIT 1` did against the union.
  const oldestActionableQueryMessages = db.prepare(`
    SELECT m.id, m.type, m.sender, m.summary, m.ts, m.rowid AS seq
    FROM messages AS m
    WHERE m.rowid > COALESCE(
      (SELECT last_actionable_seq FROM mailbox_cursors WHERE recipient = $session),
      0
    )
      AND m.recipient = $session
      AND m.kind = 'direct'
      AND m.sender != $session
      AND ${ATTENTION_PREDICATE_SQL}
      AND ${noOpenIncidentAttentionPredicateSql("m", "$session")}
      AND ${unretiredAttentionPredicateSql("m", { relation: "journal", sequence: "rowid" })}
    ORDER BY m.rowid ASC
    LIMIT 1
  `)
  const oldestActionableQueryArchive = db.prepare(`
    SELECT m.id, m.type, m.sender, m.summary, m.ts, m.seq AS seq
    FROM messages_archive AS m
    WHERE m.seq > COALESCE(
      (SELECT last_actionable_seq FROM mailbox_cursors WHERE recipient = $session),
      0
    )
      AND m.recipient = $session
      AND m.kind = 'direct'
      AND m.sender != $session
      AND ${ATTENTION_PREDICATE_SQL}
      AND ${noOpenIncidentAttentionPredicateSql("m", "$session")}
      AND ${unretiredAttentionPredicateSql("m", { relation: "journal", sequence: "seq" })}
    ORDER BY m.seq ASC
    LIMIT 1
  `)

  const rows = [...new Set(connectedSessionNames)].sort().map((session) => {
    const cursor = cursorQuery.get({ $session: session }) as {
      last_inbox_pull_seq: number
      started_at: number
    } | null
    const receipt = attentionReceiptQuery.get({ $session: session }) as {
      last_attention_read_at: number | null
    } | null
    const lagParams = { $cursor: cursor?.last_inbox_pull_seq ?? 0, $session: session }
    const lag = combineJournalCount(lagQueryMessages.get(lagParams) as LagRow, lagQueryArchive.get(lagParams) as LagRow)
    const actionableLag = combineJournalCount(
      actionableLagQueryMessages.get({ $session: session }) as LagRow,
      actionableLagQueryArchive.get({ $session: session }) as LagRow,
    )
    const oldestCandidate = olderCandidate(
      oldestActionableQueryMessages.get({ $session: session }) as OldestActionableCandidate | null,
      oldestActionableQueryArchive.get({ $session: session }) as OldestActionableCandidate | null,
    )
    const oldestActionable =
      oldestCandidate === null
        ? null
        : {
            id: oldestCandidate.id,
            type: oldestCandidate.type,
            sender: oldestCandidate.sender,
            summary: oldestCandidate.summary,
            ts: oldestCandidate.ts,
          }
    const lastAttentionReadAt = receipt?.last_attention_read_at ?? null
    return {
      as_of_ms: now,
      session,
      rows: lag.rows,
      oldest_age_ms: ageFrom(now, lag.oldest_ts),
      actionable_rows: actionableLag.rows,
      actionable_oldest_age_ms: ageFrom(now, actionableLag.oldest_ts),
      tracking_since_ms: cursor?.started_at ?? now,
      last_attention_read_at_ms: lastAttentionReadAt,
      last_attention_read_age_ms: lastAttentionReadAt === null ? null : Math.max(0, now - lastAttentionReadAt),
      oldest_actionable:
        oldestActionable === null
          ? null
          : {
              id: oldestActionable.id,
              type: oldestActionable.type,
              sender: oldestActionable.sender,
              summary: oldestActionable.summary,
              ts_ms: oldestActionable.ts,
            },
      evidence: INBOX_LAG_EVIDENCE,
    }
  })
  const warnings = rows
    .filter(
      (row) =>
        (row.rows > 0 && row.oldest_age_ms > CURSOR_WARNING_MS) ||
        (row.actionable_rows > 0 && row.actionable_oldest_age_ms > CURSOR_WARNING_MS),
    )
    .map(
      (row) =>
        `inbox cursor projection ${row.session} as-of ${new Date(row.as_of_ms).toISOString()}: ` +
        `${row.rows} row(s), oldest ${durationLabel(row.oldest_age_ms)}; ` +
        `${row.actionable_rows} actionable row(s), oldest ${durationLabel(row.actionable_oldest_age_ms)}; ` +
        `projection-only, pane/turn liveness excluded (threshold 30m)`,
    )
  return { rows, warnings }
}

function databaseProjection(
  db: Database,
  now: number,
  growthWarningBytes: number | null,
): {
  projection: HealthCadenceProjection["database"]
  warnings: string[]
} {
  const pageCount = (db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count
  const pageSize = (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size
  const counts = db
    .prepare(`
    SELECT
      (SELECT COUNT(*) FROM messages) AS message_rows,
      (SELECT COUNT(*) FROM messages_archive) AS archive_rows
  `)
    .get() as { message_rows: number; archive_rows: number }
  const growth = db
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM messages WHERE ts >= $cutoff AND ts <= $now) AS message_rows,
        (
          SELECT COUNT(*) FROM messages_archive
          WHERE archived_at >= $cutoff AND archived_at <= $now
        ) AS archive_rows,
        COALESCE((
          SELECT SUM(
            length(CAST(id AS BLOB)) + length(CAST(type AS BLOB)) +
            length(CAST(sender AS BLOB)) + length(CAST(recipient AS BLOB)) +
            length(CAST(content AS BLOB)) + COALESCE(length(CAST(summary AS BLOB)), 0) + 16
          )
          FROM messages
          WHERE ts >= $cutoff AND ts <= $now
        ), 0) + COALESCE((
          SELECT SUM(
            length(CAST(id AS BLOB)) + length(CAST(type AS BLOB)) +
            length(CAST(sender AS BLOB)) + length(CAST(recipient AS BLOB)) +
            length(CAST(content AS BLOB)) + COALESCE(length(CAST(summary AS BLOB)), 0) + 24
          )
          FROM messages_archive
          WHERE archived_at >= $cutoff AND archived_at <= $now
        ), 0) AS estimated_bytes
    `)
    .get({ $cutoff: now - 7 * DAY, $now: now }) as {
    message_rows: number
    archive_rows: number
    estimated_bytes: number
  }
  const projection = {
    as_of_ms: now,
    bytes: pageCount * pageSize,
    message_rows: counts.message_rows,
    archive_rows: counts.archive_rows,
    growth_7d: {
      estimated_bytes: growth.estimated_bytes,
      message_rows: growth.message_rows,
      archive_rows: growth.archive_rows,
    },
    growth_warning_bytes: growthWarningBytes,
  }
  const warnings =
    growthWarningBytes !== null && growth.estimated_bytes > growthWarningBytes
      ? [
          `7d DB growth estimate ${growth.estimated_bytes}B exceeds configured ${growthWarningBytes}B; ` +
            `suggest archive/GC (messages=${growth.message_rows}, archive=${growth.archive_rows})`,
        ]
      : []
  return { projection, warnings }
}

export function parseDbGrowthWarningBytes(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

/** Parse the opt-in `TRIBE_SLA_ROLE` env value into a session name or null. */
export function parseSlaRole(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const trimmed = raw.trim()
  return trimmed === "" ? null : trimmed
}

/** Parse the optional `TRIBE_SLA_SECONDS` override into a positive ms target, else null. */
export function parseSlaTargetMs(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds * 1_000) : null
}

function resolveSlaRole(option: string | null | undefined): string | null {
  if (option !== undefined) return parseSlaRole(option ?? undefined)
  return parseSlaRole(process.env.TRIBE_SLA_ROLE)
}

function resolveSlaTargetMs(option: number | null | undefined): number {
  if (option !== undefined && option !== null) return option
  return parseSlaTargetMs(process.env.TRIBE_SLA_SECONDS) ?? DEFAULT_SLA_TARGET_MS
}

export function projectHealthCadence(db: Database, options: HealthCadenceOptions): HealthCadenceProjection {
  const { now } = options
  const responseLatency = responseLatencyProjection(db, now)
  const inboxLag = inboxLagProjection(db, now, options.connectedSessionNames)
  const database = databaseProjection(db, now, options.dbGrowthWarningBytes ?? null)

  const slaRole = resolveSlaRole(options.slaRole)
  const sla =
    slaRole === null
      ? null
      : roleActionableResponseProjection(
          db,
          now,
          responseLatency.rows,
          slaRole,
          resolveSlaTargetMs(options.slaTargetMs),
        )

  return {
    as_of_ms: now,
    ...(sla ? { role_actionable_response: sla.projection } : {}),
    response_latency: responseLatency.summary,
    open_balls: openBallProjection(db, now),
    inbox_lag: inboxLag.rows,
    database: database.projection,
    warnings: [...responseLatency.warnings, ...(sla ? sla.warnings : []), ...inboxLag.warnings, ...database.warnings],
  }
}
