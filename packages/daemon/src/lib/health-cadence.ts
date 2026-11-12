import { assertSingleStatement } from "@bearly/sqlite"
import type { Database } from "bun:sqlite"
import { BALL_OPENING_TYPES } from "tribe-wire/lib/wake-read-directive"
import {
  ATTENTION_PREDICATE_SQL,
  NON_EVENT_KINDS_SQL,
  noOpenIncidentAttentionPredicateSql,
  unretiredAttentionPredicateSql,
  unsettledAttentionPredicateSql,
  wakePredicateSql,
} from "./database.ts"
import { TRIBE_SLA_ROLE_ENV } from "tribe-wire/lib/session-identity-env"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const RESPONSE_WARNING_MS = 30 * MINUTE
/** Exported for retention.ts, whose live window must not undercut it (21757). */
export const CURSOR_WARNING_MS = 30 * MINUTE
/**
 * 26523 (@cto 55a8b9fc): a connected pull seat (`connected-no-consumer`) whose
 * last attention read is within the fleet's 10-minute in-progress ceiling
 * (AGENTS.md: a request older than ten minutes is broken) reports `online` in
 * `deliveryReport`; `null` or above the ceiling reports `offline`.
 */
export const CONNECTED_PULL_READ_CEILING_MS = 10 * MINUTE
/**
 * 33213 (@cto 52e27942): how long a direct row written to a push seat socket
 * WITH its body may go unfetched before it counts as attention lag.
 *
 * A socket write proves the adapter took the row, not that the model read it, so
 * the health reader must not page on delivery alone — that is the false page
 * 33213 reproduced (a verdict written to its socket 56 ms after send, paged within
 * minutes while the seat was still inside the turn it woke). Ten minutes is the
 * fleet's in-progress ceiling (AGENTS.md: a request older than ten minutes is
 * broken), so the grace cannot hide a row for longer than the ceiling that
 * already governs every other waiting seat. Directive rows (BALL_OPENING_TYPES,
 * written body-less) and never-written rows skip the grace entirely — their
 * transport state is unknown, so only the row's own age may speak for them.
 */
const INLINE_DELIVERY_LAG_GRACE_MS = 10 * MINUTE
const DEFAULT_SLA_TARGET_MS = MINUTE

/** SQL list for the ball-opening types, derived from their one definition. */
const BALL_OPENING_TYPES_SQL = [...BALL_OPENING_TYPES].map((type) => `'${type}'`).join(", ")

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

type DbGrowthWarning = { kind: "unset" } | { kind: "valid"; bytes: number } | { kind: "invalid"; raw: string }

export type HealthCadenceOptions = {
  now: number
  connectedSessionNames: string[]
  requestedSessionNames?: string[]
  dbGrowthWarning?: DbGrowthWarning
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
      transport_state?: "connected" | "disconnected"
      rows: number
      oldest_age_ms: number
      actionable_rows: number
      actionable_oldest_age_ms: number
      /** 33213: actionable rows written to this push seat socket and still inside the grace. */
      actionable_held_rows: number
      /** Which case put each counted row in `actionable_rows` — never-delivered, directive-unread, or delivered-inline-unfetched. */
      actionable_causes: Array<{ cause: ActionableLagCause; rows: number; oldest_age_ms: number }>
      /** The subset of the actionable rows that wakes the seat's inbox-wait (`wakePredicateSql`); quiet direct
       * responses and ref-bound statuses count above but not here (27735). */
      waking_rows: number
      waking_oldest_age_ms: number
      /** When this connected seat began being observable for read silence. */
      tracking_since_ms: number
      /** Null until the seat receives a canonical fetch/inbox-wait attention projection. */
      last_attention_read_at_ms: number | null
      last_attention_read_age_ms: number | null
      /** Latest current-table non-event send by this exact name; archive is excluded. Zero is observed. */
      last_non_event_send_at_ms: number | null
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
  /** Known service principals without an observed canonical READ; excluded from lag, not reported as zero. */
  inbox_lag_excluded?: Array<{ session: string; reason: "service-never-read" }>
  unknown_sessions?: string[]
  // 33643 (@cto f7202cee): no whole-history row counts. Each was a COUNT(*) over a whole journal, read on every
  // health call, growing with history; `bytes` (page count) and the 7-day window carry the size signal.
  database: ProjectionStamp & {
    bytes: number
    growth_7d: {
      message_rows: number
      archive_rows: number
    } & (
      | { estimated_bytes: number }
      | {
          estimated_bytes: null
          estimated_bytes_not_collected: {
            reason: "warning-threshold-unset" | "warning-threshold-invalid"
            setting: "TRIBE_HEALTH_DB_GROWTH_WARN_BYTES"
            observed: string | null
          }
        }
    )
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

/**
 * One attention-lag shape, two readings (27735): every unacknowledged direct attention row, and the subset
 * that wakes the seat's inbox-wait. `wakePredicateSql` is the one home for "waking"; nothing here lists types.
 */
function attentionWhereSql(table: "messages" | "messages_archive", extraPredicate: string): string {
  const sequence = table === "messages" ? "rowid" : "seq"
  return `m.${sequence} > COALESCE(
      (SELECT last_actionable_seq FROM mailbox_cursors WHERE recipient = $session),
      0
    )
      AND m.recipient = $session
      AND m.kind = 'direct'
      AND m.sender != $session
      AND ${ATTENTION_PREDICATE_SQL}
      AND ${noOpenIncidentAttentionPredicateSql("m")}
      AND ${unsettledAttentionPredicateSql("m")}
      AND ${unretiredAttentionPredicateSql("m", { relation: "journal", sequence })}${extraPredicate}`
}

export function attentionLagSql(
  table: "messages" | "messages_archive",
  extraPredicate: string,
  options: { excludeInlineGrace?: boolean } = {},
): string {
  const sequence = table === "messages" ? "rowid" : "seq"
  // 33213: a subset reading of the actionable count must drop the same grace-held
  // rows, or it can exceed the count it is a subset of (`waking_rows` vs
  // `actionable_rows` — coordination-watch refuses that shape as malformed).
  const grace = options.excludeInlineGrace === true ? `\n      AND NOT (${inlineGraceExemptSql(sequence)})` : ""
  return `
    SELECT COUNT(*) AS rows, MIN(ts) AS oldest_ts
    FROM ${table} AS m
    WHERE ${attentionWhereSql(table, `${extraPredicate}${grace}`)}
  `
}

/**
 * A direct row covered by a completed socket write to this seat: `last_delivered_seq`
 * is written after a successful `socket.write()`, in the rowid/seq space shared by
 * both journal halves (`with-broadcast.ts` `persistDeliveredCursor`). `delivery = 'push'`
 * keeps an inbox-only row out of it — that row was never fanned out, whatever a
 * later delivery raised the high-water mark to.
 */
function deliveredInlineRowSql(sequence: string): string {
  return `m.${sequence} <= $deliveredSeq
      AND m.delivery = 'push'
      AND m.type NOT IN (${BALL_OPENING_TYPES_SQL})`
}

/**
 * Inside the grace: written to its socket with its body and still younger than the window, so
 * the seat still has time to read it. `m.ts` (send time) is the bound, not the
 * delivery write, because the journal keeps no per-row delivery timestamp —
 * `sessions.last_delivered_ts` is the newest delivery for the whole seat and would
 * make an older row look fresher every time another one landed. Send time is never
 * later than delivery, so the grace can only end early, never late.
 */
function inlineGraceExemptSql(sequence: string): string {
  return `${deliveredInlineRowSql(sequence)}
      AND m.ts > $graceCutoff`
}

/** Written to its socket with its body, and the grace is over: this row counts, as today. */
function inlineGraceExpiredSql(sequence: string): string {
  return `${deliveredInlineRowSql(sequence)}
      AND m.ts <= $graceCutoff`
}

/** What the page names as the reason: the three disjoint ways a row reaches the count. */
export type ActionableLagCause = "never-delivered" | "directive-unread" | "delivered-inline-unfetched"

export type ActionableLagReading = LagRow & {
  /** Rows inside the inline-delivery grace: not counted, and not yet a page. */
  grace_exempt_rows: number
  /** Oldest counted row; null when every actionable row is inside the grace. */
  paged_oldest_ts: number | null
  causes: Array<{ cause: ActionableLagCause; rows: number; oldest_ts: number | null }>
}

/**
 * 33213 (@cto 52e27942): the actionable reading the health projection pages on.
 * Same attention set as `attentionLagSql`, plus the grace split — the count is
 * returned whole so a caller can show both "counts now" and "held", and the
 * three causes partition it: directive, delivered-inline-past-grace, and
 * everything else (never written to this seat, or inbox-only by class).
 */
function actionableLagSql(table: "messages" | "messages_archive"): string {
  const sequence = table === "messages" ? "rowid" : "seq"
  const graceExempt = inlineGraceExemptSql(sequence)
  const directive = `m.type IN (${BALL_OPENING_TYPES_SQL})`
  const expiredInline = inlineGraceExpiredSql(sequence)
  const neverDelivered = `NOT (${directive}) AND NOT (${deliveredInlineRowSql(sequence)})`
  return `
    SELECT
      COUNT(*) AS rows,
      MIN(m.ts) AS oldest_ts,
      COALESCE(SUM(CASE WHEN ${graceExempt} THEN 1 ELSE 0 END), 0) AS grace_exempt_rows,
      MIN(CASE WHEN ${graceExempt} THEN NULL ELSE m.ts END) AS paged_oldest_ts,
      COALESCE(SUM(CASE WHEN ${directive} THEN 1 ELSE 0 END), 0) AS cause_directive_rows,
      MIN(CASE WHEN ${directive} THEN m.ts END) AS cause_directive_oldest_ts,
      COALESCE(SUM(CASE WHEN ${expiredInline} THEN 1 ELSE 0 END), 0) AS cause_inline_rows,
      MIN(CASE WHEN ${expiredInline} THEN m.ts END) AS cause_inline_oldest_ts,
      COALESCE(SUM(CASE WHEN ${neverDelivered} THEN 1 ELSE 0 END), 0) AS cause_undelivered_rows,
      MIN(CASE WHEN ${neverDelivered} THEN m.ts END) AS cause_undelivered_oldest_ts
    FROM ${table} AS m
    WHERE ${attentionWhereSql(table, "")}
  `
}

const preparedActionableLagQueries = new WeakMap<
  Database,
  { messages: ReturnType<Database["prepare"]>; archive: ReturnType<Database["prepare"]> }
>()

type ActionableLagHalf = LagRow & {
  grace_exempt_rows: number
  paged_oldest_ts: number | null
  cause_directive_rows: number
  cause_directive_oldest_ts: number | null
  cause_inline_rows: number
  cause_inline_oldest_ts: number | null
  cause_undelivered_rows: number
  cause_undelivered_oldest_ts: number | null
}

/** `MIN` across two halves that each report NULL for "no such row" (see combineJournalCount). */
function olderTs(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}

function combineActionableLag(messagesHalf: ActionableLagHalf, archiveHalf: ActionableLagHalf): ActionableLagReading {
  const parts: Array<[ActionableLagCause, number, number | null]> = [
    [
      "directive-unread",
      messagesHalf.cause_directive_rows + archiveHalf.cause_directive_rows,
      olderTs(messagesHalf.cause_directive_oldest_ts, archiveHalf.cause_directive_oldest_ts),
    ],
    [
      "delivered-inline-unfetched",
      messagesHalf.cause_inline_rows + archiveHalf.cause_inline_rows,
      olderTs(messagesHalf.cause_inline_oldest_ts, archiveHalf.cause_inline_oldest_ts),
    ],
    [
      "never-delivered",
      messagesHalf.cause_undelivered_rows + archiveHalf.cause_undelivered_rows,
      olderTs(messagesHalf.cause_undelivered_oldest_ts, archiveHalf.cause_undelivered_oldest_ts),
    ],
  ]
  return {
    rows: messagesHalf.rows + archiveHalf.rows,
    oldest_ts: olderTs(messagesHalf.oldest_ts, archiveHalf.oldest_ts),
    grace_exempt_rows: messagesHalf.grace_exempt_rows + archiveHalf.grace_exempt_rows,
    paged_oldest_ts: olderTs(messagesHalf.paged_oldest_ts, archiveHalf.paged_oldest_ts),
    causes: parts.filter(([, rows]) => rows > 0).map(([cause, rows, oldest_ts]) => ({ cause, rows, oldest_ts })),
  }
}

/**
 * `grace` is the seat's delivery state at `now`. Omitted (the receipt path) binds
 * `$deliveredSeq = 0`, which makes `deliveredInlineRowSql` false for every row, so
 * the reading is the whole attention set with no row held back.
 */
function inlineGraceBindParams(
  session: string,
  grace?: { now: number; delivery: string; lastDeliveredSeq: number },
): { $session: string; $deliveredSeq: number; $graceCutoff: number } {
  return {
    $session: session,
    // Only an acknowledged push seat can have been handed a body over the socket.
    $deliveredSeq: grace !== undefined && grace.delivery === "push" ? grace.lastDeliveredSeq : 0,
    $graceCutoff: grace === undefined ? 0 : grace.now - INLINE_DELIVERY_LAG_GRACE_MS,
  }
}

function readActionableLag(
  db: Database,
  session: string,
  grace?: { now: number; delivery: string; lastDeliveredSeq: number },
): ActionableLagReading {
  let queries = preparedActionableLagQueries.get(db)
  if (queries === undefined) {
    queries = {
      messages: db.prepare(assertSingleStatement(actionableLagSql("messages"))),
      archive: db.prepare(assertSingleStatement(actionableLagSql("messages_archive"))),
    }
    preparedActionableLagQueries.set(db, queries)
  }
  const params = inlineGraceBindParams(session, grace)
  return combineActionableLag(
    queries.messages.get(params) as ActionableLagHalf,
    queries.archive.get(params) as ActionableLagHalf,
  )
}

/**
 * 26523 (@cto 55a8b9fc binding 1, 6ebb2ba3): the `inbox_lag.actionable_rows` count
 * that `health:inbox-stale` reads (`attentionLagSql` across `messages` and
 * `messages_archive`), as the `cli_inbox_status_by_launch_v1` zero-unread attention
 * receipt reads it. The projection itself pages on the grace-split reading below.
 *
 * 33213 keeps this reading UNSPLIT on purpose: the receipt path below writes
 * `mailbox_cursors.last_attention_read_at`, so a row the 33213 grace is holding
 * back must never make it fire — that would record a read the model may not have
 * performed, which is the failure the grace exists to stop happening in the other
 * direction. The projection calls `readActionableLag` with the grace instead; the
 * two agree on every row the grace cannot cover (directive, undelivered, pull seat)
 * and the projection is the stricter of the pair whenever they differ.
 */
export function readActionableLagRows(db: Database, session: string): number {
  return readActionableLag(db, session).rows
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

/**
 * Exported for the 24284 equivalence test, which compares its rows against the
 * pre-fix `journal` UNION ALL query kept there as a frozen oracle. Bucketing,
 * percentile and warning logic below are unchanged. Not part of the daemon
 * package's public surface (package.json maps only `./src/daemon.ts`).
 */
export function responseLatencyProjection(
  db: Database,
  now: number,
): {
  summary: HealthCadenceProjection["response_latency"]
  rows: ResponseLatencyRow[]
  warnings: string[]
} {
  // 24284 (@cto ruling 2026-10-03): the response half of the journal is
  // bounded by the window this projection REPORTS, inside each physical arm,
  // so each arm walks its existing `ts` index instead of unioning the whole
  // live+archive journal into one materialized CTE (measured 470,867 page
  // reads / ~1.9 GB for ONE call with zero connected sessions, which blocked
  // the single-threaded daemon past the wire client's 10 s deadline).
  //
  // The request half is NOT windowed — a request older than $cutoff must still
  // pair with an in-window response — so it is joined once per physical table
  // through the partial `request IS NOT NULL` indexes (migration v39), the two
  // joins combined with UNION ALL. Deliberately NOT one join against a second
  // journal CTE, and NOT dual LEFT JOIN + COALESCE: `request` is not unique, so
  // a request key present in BOTH tables must keep contributing one row per
  // physical row, exactly as the old two-sided journal join did. Two separate
  // indexed joins preserve that multiplicity, role, message_type and pairing.
  const rows = db
    .prepare(
      assertSingleStatement(`
      WITH response_journal AS (
        SELECT sender, ts, reply FROM messages INDEXED BY idx_messages_reply_cover
        WHERE reply IS NOT NULL AND ts >= $cutoff AND ts <= $now
        UNION ALL
        SELECT sender, ts, reply FROM messages_archive INDEXED BY idx_messages_archive_reply_cover
        WHERE reply IS NOT NULL AND ts >= $cutoff AND ts <= $now
      )
      SELECT
        COALESCE(s.role, 'unknown') AS role,
        r.sender AS sender,
        q.type AS message_type,
        r.ts - q.ts AS latency_ms
      FROM response_journal r
      JOIN messages q INDEXED BY idx_messages_request_cover
        ON q.request IS NOT NULL AND q.request = r.reply AND r.ts >= q.ts
      LEFT JOIN sessions s ON s.name = r.sender
      UNION ALL
      SELECT
        COALESCE(s.role, 'unknown') AS role,
        r.sender AS sender,
        q.type AS message_type,
        r.ts - q.ts AS latency_ms
      FROM response_journal r
      JOIN messages_archive q INDEXED BY idx_messages_archive_request_cover
        ON q.request IS NOT NULL AND q.request = r.reply AND r.ts >= q.ts
      LEFT JOIN sessions s ON s.name = r.sender
      ORDER BY role, message_type, latency_ms
    `),
    )
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

/**
 * 33213 (@cto 52e27942 item 4): the page names the case that fired, so its reader
 * knows whether to look at the transport (never written to a socket, directive
 * unread) or at the seat (written to its socket and unfetched).
 */
function actionableCauseLabel(entry: { cause: ActionableLagCause; rows: number; oldest_age_ms: number }): string {
  const age = durationLabel(entry.oldest_age_ms)
  switch (entry.cause) {
    case "directive-unread":
      return `${entry.rows} directive unread (oldest ${age})`
    case "delivered-inline-unfetched":
      return `${entry.rows} written to its socket, unfetched for ${age}`
    case "never-delivered":
      return `${entry.rows} never written to its socket (oldest ${age})`
  }
}

function inboxLagProjection(
  db: Database,
  now: number,
  connectedSessionNames: string[],
  requestedSessionNames?: string[],
): {
  rows: HealthCadenceProjection["inbox_lag"]
  warnings: string[]
  unknownSessions: string[]
  excluded: NonNullable<HealthCadenceProjection["inbox_lag_excluded"]>
} {
  const cursorQuery = db.prepare(`
    SELECT last_inbox_pull_seq, started_at, delivery, last_delivered_seq, principal_class
    FROM sessions
    WHERE name = $session
    ORDER BY updated_at DESC
    LIMIT 1
  `)
  const attentionReceiptQuery = db.prepare(
    "SELECT last_attention_read_at FROM mailbox_cursors WHERE recipient = $session",
  )
  const lastNonEventSendQuery = db.prepare(`
    SELECT ts FROM messages
    WHERE sender = $session AND kind != 'event'
    ORDER BY ts DESC LIMIT 1
  `)

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
  const lagPredicate = `kind IN (${NON_EVENT_KINDS_SQL})
    AND sender != $session
    AND recipient IN ($session, '*')`
  const lagQueryMessages = db.prepare(
    assertSingleStatement(`
    SELECT COUNT(*) AS rows, MIN(ts) AS oldest_ts
    FROM messages
    WHERE rowid > $cursor
      AND ${lagPredicate}
  `),
  )
  const lagQueryArchive = db.prepare(
    assertSingleStatement(`
    SELECT COUNT(*) AS rows, MIN(ts) AS oldest_ts
    FROM messages_archive
    WHERE seq > $cursor
      AND ${lagPredicate}
  `),
  )
  const waking = `\n      AND ${wakePredicateSql("m")}`
  const wakingLagQueryMessages = db.prepare(
    assertSingleStatement(attentionLagSql("messages", waking, { excludeInlineGrace: true })),
  )
  const wakingLagQueryArchive = db.prepare(
    assertSingleStatement(attentionLagSql("messages_archive", waking, { excludeInlineGrace: true })),
  )
  // Selects the shared seq/rowid position too (absent from the original
  // SELECT list, which only ever needed it in ORDER BY against the single
  // CTE) so olderCandidate() below can compare the two halves' candidates the
  // same way `ORDER BY m.seq ASC LIMIT 1` did against the union.
  const oldestActionableQueryMessages = db.prepare(
    assertSingleStatement(`
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
      AND ${noOpenIncidentAttentionPredicateSql("m")}
      AND ${unsettledAttentionPredicateSql("m")}
      AND ${unretiredAttentionPredicateSql("m", { relation: "journal", sequence: "rowid" })}
      AND NOT (${inlineGraceExemptSql("rowid")})
    ORDER BY m.rowid ASC
    LIMIT 1
  `),
  )
  const oldestActionableQueryArchive = db.prepare(
    assertSingleStatement(`
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
      AND ${noOpenIncidentAttentionPredicateSql("m")}
      AND ${unsettledAttentionPredicateSql("m")}
      AND ${unretiredAttentionPredicateSql("m", { relation: "journal", sequence: "seq" })}
      AND NOT (${inlineGraceExemptSql("seq")})
    ORDER BY m.seq ASC
    LIMIT 1
  `),
  )

  const unknownSessions: string[] = []
  const excluded: NonNullable<HealthCadenceProjection["inbox_lag_excluded"]> = []
  const rows = [...new Set([...connectedSessionNames, ...(requestedSessionNames ?? [])])].sort().flatMap((session) => {
    const cursor = cursorQuery.get({ $session: session }) as {
      last_inbox_pull_seq: number
      started_at: number
      delivery: string
      last_delivered_seq: number | null
      principal_class: string
    } | null
    const receipt = attentionReceiptQuery.get({ $session: session }) as {
      last_attention_read_at: number | null
    } | null
    if (cursor == null && receipt == null && requestedSessionNames?.includes(session)) {
      unknownSessions.push(session)
      return []
    }
    if (cursor?.principal_class === "service" && receipt?.last_attention_read_at == null) {
      excluded.push({ session, reason: "service-never-read" })
      return []
    }
    const lagParams = { $cursor: cursor?.last_inbox_pull_seq ?? 0, $session: session }
    const lag = combineJournalCount(lagQueryMessages.get(lagParams) as LagRow, lagQueryArchive.get(lagParams) as LagRow)
    const grace = { now, delivery: cursor?.delivery ?? "pull", lastDeliveredSeq: cursor?.last_delivered_seq ?? 0 }
    const graceParams = inlineGraceBindParams(session, grace)
    const actionableLag = readActionableLag(db, session, grace)
    const wakingLag = combineJournalCount(
      wakingLagQueryMessages.get(graceParams) as LagRow,
      wakingLagQueryArchive.get(graceParams) as LagRow,
    )
    const oldestCandidate = olderCandidate(
      oldestActionableQueryMessages.get(graceParams) as OldestActionableCandidate | null,
      oldestActionableQueryArchive.get(graceParams) as OldestActionableCandidate | null,
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
    const lastNonEventSend = lastNonEventSendQuery.get({ $session: session }) as { ts: number } | null
    return [
      {
        as_of_ms: now,
        session,
        ...(requestedSessionNames === undefined
          ? {}
          : {
              transport_state: connectedSessionNames.includes(session)
                ? ("connected" as const)
                : ("disconnected" as const),
            }),
        rows: lag.rows,
        oldest_age_ms: ageFrom(now, lag.oldest_ts),
        actionable_rows: actionableLag.rows - actionableLag.grace_exempt_rows,
        actionable_oldest_age_ms: ageFrom(now, actionableLag.paged_oldest_ts),
        actionable_held_rows: actionableLag.grace_exempt_rows,
        actionable_causes: actionableLag.causes.map((entry) => ({
          cause: entry.cause,
          rows: entry.rows,
          oldest_age_ms: ageFrom(now, entry.oldest_ts),
        })),
        waking_rows: wakingLag.rows,
        waking_oldest_age_ms: ageFrom(now, wakingLag.oldest_ts),
        tracking_since_ms: cursor?.started_at ?? now,
        last_attention_read_at_ms: lastAttentionReadAt,
        last_attention_read_age_ms: lastAttentionReadAt === null ? null : Math.max(0, now - lastAttentionReadAt),
        last_non_event_send_at_ms: lastNonEventSend?.ts ?? null,
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
      },
    ]
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
        `${row.actionable_rows} actionable row(s)` +
        `${row.actionable_rows > 0 ? ` [${row.actionable_causes.map(actionableCauseLabel).join("; ")}]` : ""}` +
        `, oldest ${durationLabel(row.actionable_oldest_age_ms)}` +
        `${row.actionable_held_rows > 0 ? `; ${row.actionable_held_rows} written to its socket and held under the ${durationLabel(INLINE_DELIVERY_LAG_GRACE_MS)} grace` : ""}` +
        `; ` +
        `projection-only, pane/turn liveness excluded (threshold 30m)`,
    )
  return { rows, warnings, unknownSessions, excluded }
}

function databaseProjection(
  db: Database,
  now: number,
  growthWarning: DbGrowthWarning,
): {
  projection: HealthCadenceProjection["database"]
  warnings: string[]
} {
  const pageCount = (db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count
  const pageSize = (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size
  const growth = db
    .prepare(
      assertSingleStatement(`
      SELECT
        (SELECT COUNT(*) FROM messages WHERE ts >= $cutoff AND ts <= $now) AS message_rows,
        (
          SELECT COUNT(*) FROM messages_archive
          WHERE archived_at >= $cutoff AND archived_at <= $now
        ) AS archive_rows,
        ${
          growthWarning.kind === "valid"
            ? `COALESCE((
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
        ), 0)`
            : "NULL"
        } AS estimated_bytes
    `),
    )
    .get({ $cutoff: now - 7 * DAY, $now: now }) as {
    message_rows: number
    archive_rows: number
    estimated_bytes: number | null
  }
  const growthMeasurement: HealthCadenceProjection["database"]["growth_7d"] = {
    message_rows: growth.message_rows,
    archive_rows: growth.archive_rows,
    ...(growthWarning.kind === "valid"
      ? // The valid SQL arm COALESCEs each sum to zero, so it cannot return NULL.
        { estimated_bytes: growth.estimated_bytes as number }
      : {
          estimated_bytes: null,
          estimated_bytes_not_collected: {
            reason: growthWarning.kind === "unset" ? "warning-threshold-unset" : "warning-threshold-invalid",
            setting: "TRIBE_HEALTH_DB_GROWTH_WARN_BYTES",
            observed: growthWarning.kind === "invalid" ? growthWarning.raw.slice(0, 64) : null,
          },
        }),
  }
  const projection: HealthCadenceProjection["database"] = {
    as_of_ms: now,
    bytes: pageCount * pageSize,
    growth_7d: growthMeasurement,
    growth_warning_bytes: growthWarning.kind === "valid" ? growthWarning.bytes : null,
  }
  const warnings =
    growthWarning.kind === "invalid"
      ? [
          `Invalid TRIBE_HEALTH_DB_GROWTH_WARN_BYTES=${JSON.stringify(growthWarning.raw.slice(0, 64))}; expected a non-negative finite number; growth bytes not collected`,
        ]
      : growthWarning.kind === "valid" &&
          growth.estimated_bytes !== null &&
          growth.estimated_bytes > growthWarning.bytes
        ? [
            `7d DB growth estimate ${growth.estimated_bytes}B exceeds configured ${growthWarning.bytes}B; ` +
              `suggest archive/GC (messages=${growth.message_rows}, archive=${growth.archive_rows})`,
          ]
        : []
  return { projection, warnings }
}

export function parseDbGrowthWarningBytes(raw: string | undefined): DbGrowthWarning {
  if (raw === undefined || raw.trim() === "") return { kind: "unset" }
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? { kind: "valid", bytes: Math.floor(value) } : { kind: "invalid", raw }
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
  return parseSlaRole(process.env[TRIBE_SLA_ROLE_ENV])
}

function resolveSlaTargetMs(option: number | null | undefined): number {
  if (option !== undefined && option !== null) return option
  return parseSlaTargetMs(process.env.TRIBE_SLA_SECONDS) ?? DEFAULT_SLA_TARGET_MS
}

export function projectHealthCadence(db: Database, options: HealthCadenceOptions): HealthCadenceProjection {
  const { now } = options
  const responseLatency = responseLatencyProjection(db, now)
  const inboxLag = inboxLagProjection(db, now, options.connectedSessionNames, options.requestedSessionNames)
  const database = databaseProjection(db, now, options.dbGrowthWarning ?? { kind: "unset" })

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
    ...(inboxLag.excluded.length === 0 ? {} : { inbox_lag_excluded: inboxLag.excluded }),
    ...(options.requestedSessionNames === undefined ? {} : { unknown_sessions: inboxLag.unknownSessions }),
    database: database.projection,
    warnings: [...responseLatency.warnings, ...(sla ? sla.warnings : []), ...inboxLag.warnings, ...database.warnings],
  }
}
