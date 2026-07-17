import type { Database } from "bun:sqlite"
import { ACTIONABLE_TYPES_SQL } from "./database.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const RESPONSE_WARNING_MS = 30 * MINUTE
const CURSOR_WARNING_MS = 30 * MINUTE
const CHIEF_ACTIONABLE_RESPONSE_TARGET_MS = MINUTE
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

export type HealthCadenceProjection = ProjectionStamp & {
  chief_actionable_response: ProjectionStamp & {
    target_ms: number
    status: "ok" | "breached"
    completed: LatencySummary & {
      within_target: number
      missed_target: number
    }
    open: {
      count: number
      oldest_age_ms: number
      over_target_count: number
    }
  }
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

function ageFrom(now: number, oldestTs: number | null): number {
  return oldestTs === null ? 0 : Math.max(0, now - oldestTs)
}

function responseLatencyProjection(
  db: Database,
  now: number,
): {
  summary: HealthCadenceProjection["response_latency"]
  chiefCompleted: HealthCadenceProjection["chief_actionable_response"]["completed"]
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
  const warnings = byRoleAndType
    .filter((group) => group.p95_ms !== null && group.p95_ms > RESPONSE_WARNING_MS)
    .map(
      (group) =>
        `response latency role=${group.role} type=${group.message_type} p95=${Math.floor(group.p95_ms! / MINUTE)}m exceeds 30m (n=${group.count})`,
    )
  const chiefLatencies = rows.filter((row) => row.role === "chief").map((row) => row.latency_ms)

  return {
    summary: {
      as_of_ms: now,
      window_ms: DAY,
      ...summarizeLatencies(rows.map((row) => row.latency_ms)),
      by_role_and_type: byRoleAndType,
    },
    chiefCompleted: {
      ...summarizeLatencies(chiefLatencies),
      within_target: chiefLatencies.filter((latency) => latency < CHIEF_ACTIONABLE_RESPONSE_TARGET_MS).length,
      missed_target: chiefLatencies.filter((latency) => latency >= CHIEF_ACTIONABLE_RESPONSE_TARGET_MS).length,
    },
    warnings,
  }
}

function chiefOpenActionableProjection(
  db: Database,
  now: number,
): HealthCadenceProjection["chief_actionable_response"]["open"] {
  const row = db
    .prepare(`
      SELECT
        COUNT(*) AS count,
        MIN(opened_at) AS oldest_opened_at,
        COALESCE(SUM(
          CASE WHEN $now - opened_at >= $target THEN 1 ELSE 0 END
        ), 0) AS over_target_count
      FROM pending_request
      WHERE recipient = '@chief'
    `)
    .get({ $now: now, $target: CHIEF_ACTIONABLE_RESPONSE_TARGET_MS }) as {
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

function chiefActionableResponseProjection(
  db: Database,
  now: number,
  completed: HealthCadenceProjection["chief_actionable_response"]["completed"],
): {
  projection: HealthCadenceProjection["chief_actionable_response"]
  warnings: string[]
} {
  const open = chiefOpenActionableProjection(db, now)
  const warnings: string[] = []
  if (completed.missed_target > 0) {
    warnings.push(
      `Chief actionable response completed p95=${durationLabel(completed.p95_ms ?? 0)}; ` +
        `target <60s missed=${completed.missed_target}/${completed.count}`,
    )
  }
  if (open.over_target_count > 0) {
    warnings.push(
      `Chief actionable response open oldest=${durationLabel(open.oldest_age_ms)}; ` +
        `target <60s overdue=${open.over_target_count}/${open.count}`,
    )
  }
  return {
    projection: {
      as_of_ms: now,
      target_ms: CHIEF_ACTIONABLE_RESPONSE_TARGET_MS,
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
  const cursorQuery = db.prepare(
    "SELECT last_inbox_pull_seq FROM sessions WHERE name = $session ORDER BY updated_at DESC LIMIT 1",
  )
  const lagQuery = db.prepare(`
    WITH journal AS (
      SELECT rowid AS seq, type, sender, recipient, kind, ts FROM messages
      UNION ALL
      SELECT seq, type, sender, recipient, kind, ts FROM messages_archive
    )
    SELECT COUNT(*) AS rows, MIN(ts) AS oldest_ts
    FROM journal
    WHERE seq > $cursor
      AND kind != 'event'
      AND sender != $session
      AND (recipient = $session OR recipient = '*')
  `)
  const actionableLagQuery = db.prepare(`
    WITH journal AS (
      SELECT rowid AS seq, type, sender, recipient, kind, ts FROM messages
      UNION ALL
      SELECT seq, type, sender, recipient, kind, ts FROM messages_archive
    )
    SELECT COUNT(*) AS rows, MIN(ts) AS oldest_ts
    FROM journal
    WHERE seq > COALESCE(
      (SELECT last_actionable_seq FROM mailbox_cursors WHERE recipient = $session),
      0
    )
      AND recipient = $session
      AND kind = 'direct'
      AND sender != $session
      AND type IN (${ACTIONABLE_TYPES_SQL})
  `)

  const rows = [...new Set(connectedSessionNames)].sort().map((session) => {
    const cursor = cursorQuery.get({ $session: session }) as { last_inbox_pull_seq: number } | null
    const lag = lagQuery.get({ $cursor: cursor?.last_inbox_pull_seq ?? 0, $session: session }) as LagRow
    const actionableLag = actionableLagQuery.get({ $session: session }) as LagRow
    return {
      as_of_ms: now,
      session,
      rows: lag.rows,
      oldest_age_ms: ageFrom(now, lag.oldest_ts),
      actionable_rows: actionableLag.rows,
      actionable_oldest_age_ms: ageFrom(now, actionableLag.oldest_ts),
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

export function projectHealthCadence(db: Database, options: HealthCadenceOptions): HealthCadenceProjection {
  const responseLatency = responseLatencyProjection(db, options.now)
  const chiefActionableResponse = chiefActionableResponseProjection(db, options.now, responseLatency.chiefCompleted)
  const inboxLag = inboxLagProjection(db, options.now, options.connectedSessionNames)
  const database = databaseProjection(db, options.now, options.dbGrowthWarningBytes ?? null)
  return {
    as_of_ms: options.now,
    chief_actionable_response: chiefActionableResponse.projection,
    response_latency: responseLatency.summary,
    open_balls: openBallProjection(db, options.now),
    inbox_lag: inboxLag.rows,
    database: database.projection,
    warnings: [
      ...responseLatency.warnings,
      ...chiefActionableResponse.warnings,
      ...inboxLag.warnings,
      ...database.warnings,
    ],
  }
}
