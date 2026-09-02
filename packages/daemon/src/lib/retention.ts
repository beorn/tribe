/**
 * Journal retention — bounded archive-then-prune sweep for `messages` /
 * `messages_archive`.
 *
 * Motivation (@cto journal-retention): tribe.db grows linearly forever.
 * Measured against a real reproduction journal (the same one behind
 * database.ts's attention-index fix): `messages` stays correctly bounded to
 * session.ts's cleanupOldData 7-day archive-move window (verified — its
 * oldest live row was ~7.0 days old), but `messages_archive` had 52,668 rows
 * spanning only ~13.5 days of history with NOTHING ever removing from it.
 * That table is the actual unbounded-growth vector: every read that unions
 * `messages` and `messages_archive` (the "journal" CTE — see database.ts's
 * `unretiredAttentionPredicateSql` comment, health-cadence.ts) pays for the
 * whole archive on every call, forever.
 *
 * This module is deliberately scoped to the missing half:
 *
 *   1. archive-move (live `messages` -> `messages_archive`) already exists,
 *      is tested, and works (session.ts's cleanupOldData, hardcoded 7d,
 *      always on, unbounded-per-tick since in steady state its per-tick
 *      volume is small). This module adds a SECOND, independently
 *      configurable, LIMIT-bounded archive-move as a defense-in-depth
 *      backstop — idempotent (INSERT OR IGNORE) and therefore harmless to
 *      run alongside the existing one. Under default config (14d) it is
 *      normally a no-op, because the existing 7d sweep already got there
 *      first; it only does real work if the existing mechanism is disabled,
 *      falls behind, or this module's window is configured tighter.
 *
 *   2. archive-delete (`messages_archive` -> gone) is net new. This is the
 *      actual fix for "grows forever". It ships DEFAULT OFF — set
 *      TRIBE_RETENTION_DELETE_ENABLED=1 to arm it. The window values and
 *      whether to enable delete in production are a POLICY decision left to
 *      a follow-up bead, not this change.
 *
 * Safety rules for archive-delete (never break the ball-tracker or
 * attention semantics):
 *
 *   - A messages_archive row referenced by any OPEN pending_request
 *     (message_id match) is never deleted, full stop, regardless of age.
 *     Every pending* read in database.ts resolves a ball's question body via
 *     `LEFT JOIN messages_archive a ON a.id = p.message_id` — deleting a
 *     still-open ball's row would silently turn `content` null out from
 *     under it (@km/tribe/22844's "a ball never outlives its question").
 *
 *   - A reciprocal `status + ref` TAKING receipt for an OPEN pending_request
 *     is likewise retained. The receipt is the durable authority that removes
 *     a taken ball from idle attention; deleting it while the ball remains
 *     open would silently make the obligation actionable again.
 *
 *   - A messages_archive row at or above the fleet's live-cursor floor is
 *     never deleted. Two cursor families reach into messages_archive
 *     through the `journal` UNION (health-cadence.ts): mailbox_cursors'
 *     `last_actionable_seq` (direct actionable messages — see
 *     unretiredAttentionPredicateSql) and sessions' `last_inbox_pull_seq`
 *     (ambient lag, which also counts broadcast rows). Rather than
 *     replicate each consumer's exact per-recipient WHERE clause here (and
 *     risk getting a downstream file's semantics subtly wrong), this module
 *     takes the single global MIN across both cursor families each sweep
 *     tick and refuses to delete anything past it. That is deliberately
 *     conservative — one dormant seat's cursor can hold the floor down
 *     fleet-wide — but it is provably safe, cheap (a handful of rows, not
 *     158k), and observable (logged every tick at debug). A tighter,
 *     per-recipient floor is a reasonable follow-up if the global floor
 *     proves too conservative in practice; that is a policy/tuning question,
 *     not a correctness one.
 *
 * Bounded work per tick: every phase is a SELECT candidates (indexed,
 * ORDER BY seq/rowid ASC, LIMIT batchSize) followed by a targeted
 * DELETE/INSERT ... WHERE id IN (...) over exactly those ids, wrapped in one
 * transaction — never a full-table scan or an unbounded DML statement. A
 * backlog larger than one batch simply takes more ticks to drain; see
 * with-runtime.ts's existing cleanupInterval for the timer this is wired
 * into (same cadence as cleanupOldData/reapStaleTransports).
 *
 * Config: self-contained env vars read directly in this module (no changes
 * to the shared TribeConfig/withConfig() surface — this follows
 * activity-log.ts's exact precedent for a retention knob that does not need
 * to be a CLI flag). See resolveRetentionConfig for names/defaults.
 */

import type { Database } from "bun:sqlite"
import { createLogger } from "loggily"
import type { TribeStatements } from "./database.ts"

const log = createLogger("tribe:retention")

const DAY_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RetentionConfig {
  /** Live messages older than this move to messages_archive. Default 14d. */
  readonly archiveWindowMs: number
  /** Archived rows older than this are hard-deleted, IF deleteEnabled.
   *  Default 90d — the "second, longer window" from the design brief. */
  readonly deleteWindowMs: number
  /** Master switch for the delete phase. Default FALSE — the archive-move
   *  phase always runs (it is idempotent and redundant-safe with the
   *  existing session.ts mechanism); hard deletion requires an explicit,
   *  reviewed opt-in. */
  readonly deleteEnabled: boolean
  /** Max rows moved/deleted per phase per sweep tick. Default 500. */
  readonly batchSize: number
}

const DEFAULT_ARCHIVE_WINDOW_MS = 14 * DAY_MS
const DEFAULT_DELETE_WINDOW_MS = 90 * DAY_MS
const DEFAULT_BATCH_SIZE = 500

/** Parse a required-positive-integer env var. Throws on garbage rather than
 *  silently coercing to NaN/0 — an unparseable retention window must fail
 *  loud at startup, not quietly disarm the sweep or archive everything
 *  (mirrors with-config.ts's parseIdleQuitAfterSec philosophy). */
function positiveIntEnv(raw: string | undefined, fallback: number, surface: string): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`${surface} must be a positive integer (milliseconds), received ${JSON.stringify(raw)}`)
  }
  return n
}

function boolEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback
  const v = raw.trim().toLowerCase()
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true
  if (v === "0" || v === "false" || v === "off" || v === "no") return false
  throw new Error(
    `TRIBE_RETENTION_DELETE_ENABLED must be a boolean-ish value (1/0, true/false), received ${JSON.stringify(raw)}`,
  )
}

/**
 * Resolve the retention sweep's config from the environment. Every knob has
 * a safe default; the whole mechanism is inert with zero env vars set except
 * for the archive-move phase, which runs at a generous 14d window that is
 * normally a no-op (see module header — the existing 7d cleanupOldData sweep
 * already got there first).
 */
export function resolveRetentionConfig(env: NodeJS.ProcessEnv = process.env): RetentionConfig {
  return {
    archiveWindowMs: positiveIntEnv(
      env.TRIBE_RETENTION_ARCHIVE_WINDOW_MS,
      DEFAULT_ARCHIVE_WINDOW_MS,
      "TRIBE_RETENTION_ARCHIVE_WINDOW_MS",
    ),
    deleteWindowMs: positiveIntEnv(
      env.TRIBE_RETENTION_DELETE_WINDOW_MS,
      DEFAULT_DELETE_WINDOW_MS,
      "TRIBE_RETENTION_DELETE_WINDOW_MS",
    ),
    deleteEnabled: boolEnv(env.TRIBE_RETENTION_DELETE_ENABLED, false),
    batchSize: positiveIntEnv(env.TRIBE_RETENTION_BATCH_SIZE, DEFAULT_BATCH_SIZE, "TRIBE_RETENTION_BATCH_SIZE"),
  }
}

// ---------------------------------------------------------------------------
// Statements this module needs — a narrow slice of TribeStatements so the
// dependency is explicit and this file stays reviewable in isolation.
// ---------------------------------------------------------------------------

export type RetentionStatements = Pick<
  TribeStatements,
  | "selectMessagesToArchiveBatch"
  | "selectMailboxCursorFloor"
  | "selectSessionInboxCursorFloor"
  | "selectArchiveDeleteBatch"
  | "selectArchiveDeleteDiagnostics"
>

// ---------------------------------------------------------------------------
// Result shape — carries the "what was considered and why" evidence the
// caller can log or assert on (NO SILENT ERRORS: a skipped/no-op sweep is
// distinguishable from a broken one by inspecting this, not by guessing).
// ---------------------------------------------------------------------------

export interface ArchiveMovePhaseResult {
  readonly cutoff: number
  readonly candidates: number
  readonly moved: number
}

export interface ArchiveDeletePhaseResult {
  readonly enabled: boolean
  readonly cutoff: number
  /** MAX_SAFE_INTEGER when no cursor rows exist anywhere (nothing to protect
   *  against yet — e.g. a fresh DB). */
  readonly cursorFloor: number
  readonly eligibleByAge: number
  readonly excludedByCursor: number
  readonly excludedByPending: number
  readonly deleted: number
}

export interface RetentionSweepResult {
  readonly now: number
  readonly archiveMove: ArchiveMovePhaseResult
  readonly archiveDelete: ArchiveDeletePhaseResult
}

// ---------------------------------------------------------------------------
// Batch DML — variable-length `WHERE id IN (...)` statements are built at
// call time (ids-per-batch varies), mirroring session.ts's
// reapStaleTransportRows placeholder pattern. Not in createStatements()
// because a fixed-arity prepared statement can't express a variable IN list.
// ---------------------------------------------------------------------------

function archiveMoveBatch(db: Database, ids: readonly string[], archivedAt: number): number {
  if (ids.length === 0) return 0
  const placeholders = ids.map(() => "?").join(",")
  return db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO messages_archive (
				seq, id, type, sender, recipient, kind, content, bead_id, ref, ts,
				delivery, topic, room_id, request, reply, correlated_reply_requester, summary, archived_at
			)
			SELECT
				rowid, id, type, sender, recipient, kind, content, bead_id, ref, ts,
				delivery, topic, room_id, request, reply, correlated_reply_requester, summary, ?
			FROM messages WHERE id IN (${placeholders})`,
    ).run(archivedAt, ...ids)
    const res = db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids)
    return res.changes ?? 0
  })()
}

function archiveDeleteBatch(db: Database, ids: readonly string[]): number {
  if (ids.length === 0) return 0
  const placeholders = ids.map(() => "?").join(",")
  return db.transaction(() => {
    const res = db.prepare(`DELETE FROM messages_archive WHERE id IN (${placeholders})`).run(...ids)
    return res.changes ?? 0
  })()
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

function runArchiveMovePhase(
  db: Database,
  stmts: RetentionStatements,
  config: RetentionConfig,
  now: number,
): ArchiveMovePhaseResult {
  const cutoff = now - config.archiveWindowMs
  const candidates = stmts.selectMessagesToArchiveBatch.all({ $cutoff: cutoff, $limit: config.batchSize }) as Array<{
    rowid: number
    id: string
  }>
  if (candidates.length === 0) {
    log.debug?.(`archive-move: nothing eligible (cutoff=${new Date(cutoff).toISOString()})`)
    return { cutoff, candidates: 0, moved: 0 }
  }
  const moved = archiveMoveBatch(
    db,
    candidates.map((c) => c.id),
    now,
  )
  log.info?.(
    `archive-move: moved ${moved}/${candidates.length} message(s) older than ${config.archiveWindowMs}ms to messages_archive (batch cap ${config.batchSize})`,
  )
  return { cutoff, candidates: candidates.length, moved }
}

function computeCursorFloor(stmts: RetentionStatements): number {
  const mailbox = stmts.selectMailboxCursorFloor.get() as { floor: number | null } | null
  const session = stmts.selectSessionInboxCursorFloor.get() as { floor: number | null } | null
  const values = [mailbox?.floor, session?.floor].filter((v): v is number => v !== null && v !== undefined)
  // No cursor rows anywhere (fresh DB, or a DB with no mailbox/session
  // history at all) — nothing to protect against, so this half of the
  // exclusion contributes no constraint.
  return values.length === 0 ? Number.MAX_SAFE_INTEGER : Math.min(...values)
}

function runArchiveDeletePhase(
  db: Database,
  stmts: RetentionStatements,
  config: RetentionConfig,
  now: number,
): ArchiveDeletePhaseResult {
  const cutoff = now - config.deleteWindowMs
  if (!config.deleteEnabled) {
    log.debug?.(
      `archive-delete: skipped (disabled — set TRIBE_RETENTION_DELETE_ENABLED=1 to enable; would use cutoff=${new Date(cutoff).toISOString()})`,
    )
    return {
      enabled: false,
      cutoff,
      cursorFloor: Number.MAX_SAFE_INTEGER,
      eligibleByAge: 0,
      excludedByCursor: 0,
      excludedByPending: 0,
      deleted: 0,
    }
  }

  const cursorFloor = computeCursorFloor(stmts)
  const diag = stmts.selectArchiveDeleteDiagnostics.get({ $cutoff: cutoff, $cursor_floor: cursorFloor }) as {
    eligible_by_age: number | null
    excluded_by_cursor: number | null
    excluded_by_pending: number | null
  } | null
  const eligibleByAge = diag?.eligible_by_age ?? 0
  const excludedByCursor = diag?.excluded_by_cursor ?? 0
  const excludedByPending = diag?.excluded_by_pending ?? 0

  const candidates = stmts.selectArchiveDeleteBatch.all({
    $cutoff: cutoff,
    $cursor_floor: cursorFloor,
    $limit: config.batchSize,
  }) as Array<{ id: string; seq: number }>
  const deleted = archiveDeleteBatch(
    db,
    candidates.map((c) => c.id),
  )

  if (deleted > 0) {
    log.info?.(
      `archive-delete: deleted ${deleted} archived message(s) older than ${config.deleteWindowMs}ms ` +
        `(cursor_floor=${cursorFloor}, eligible_by_age=${eligibleByAge}, excluded_by_cursor=${excludedByCursor}, excluded_by_pending=${excludedByPending}, batch cap ${config.batchSize})`,
    )
  } else {
    log.debug?.(
      `archive-delete: nothing deleted (eligible_by_age=${eligibleByAge}, excluded_by_cursor=${excludedByCursor}, excluded_by_pending=${excludedByPending}, cursor_floor=${cursorFloor})`,
    )
  }

  return { enabled: true, cutoff, cursorFloor, eligibleByAge, excludedByCursor, excludedByPending, deleted }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run one bounded retention sweep tick: archive-move then archive-delete.
 * Safe to call on any cadence — each phase is independently LIMIT-bounded
 * and idempotent, so calling this more or less often only changes how fast a
 * backlog drains, never correctness. Wired into with-runtime.ts's existing
 * cleanupInterval (see that file) at the same cadence as
 * cleanupOldData/reapStaleTransports.
 */
export function runRetentionSweep(
  db: Database,
  stmts: RetentionStatements,
  config: RetentionConfig = resolveRetentionConfig(),
  now: number = Date.now(),
): RetentionSweepResult {
  const archiveMove = runArchiveMovePhase(db, stmts, config, now)
  const archiveDelete = runArchiveDeletePhase(db, stmts, config, now)
  return { now, archiveMove, archiveDelete }
}
