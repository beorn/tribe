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
 *   3. archive-export (27889) runs INSIDE the archive-delete phase, before any
 *      row is removed: every eligible batch is copied to a per-day,
 *      append-only gzip file beside tribe.db (`archive-export/`, or
 *      TRIBE_RETENTION_EXPORT_DIR) with a manifest recording the day's
 *      ids/rows/bytes/sha256. A batch whose export did not verify is NOT
 *      deleted and the refusal is named at error level. The export exists so a
 *      cited tribe id (e.g. "…@cto 68b1ca87") never becomes dangling evidence
 *      after its row is gone: read one back with
 *      `zcat <exportDir>/messages-archive-YYYY-MM-DD.jsonl.gz | grep -F '"id":"<id>"'`
 *      — the day file is a MULTI-MEMBER gzip (one member per appended batch),
 *      and zcat concatenates the members, so the single grep reads them all.
 *      `cat <exportDir>/messages-archive-YYYY-MM-DD.manifest.json` gives the
 *      day's row count and the sha256 of the whole file. F3 (@cto 2026-10-11)
 *      bounds each tick's verification by the BATCH: the committed prefix is
 *      proven by its sha256 and is NEVER re-decoded on the normal tick, and
 *      only the bytes appended this tick are decompressed and required to
 *      deep-equal the rows being deleted — the earlier shape re-decoded the
 *      whole accumulated day file three times per tick (~324 ms on the largest
 *      day, synchronous on the wire daemon's event loop). One path does decode
 *      the prefix: a candidate the manifest ALREADY records is proven against
 *      it (step 2b below), and that path is normally empty.
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
 *     conservative — one LIVE seat's cursor can hold the floor down
 *     fleet-wide — but it is provably safe, cheap (a handful of rows, not
 *     158k), and observable. F3 (@cto 2026-10-11) bounded the conservatism
 *     two ways: a cursor that has NEVER advanced (0) is not a position and is
 *     ignored in both families (it would otherwise pin the floor at 0 and
 *     void retention fleet-wide — measured: the live probe @probe/28571), and
 *     whenever the floor actually EXCLUDES rows the live reader that sets it
 *     is named at warn, once per setter, so the next stuck reader is visible
 *     instead of silently voiding the promise. A tighter, per-recipient floor
 *     is the precise fix if that line shows a stuck NONZERO reader recurring;
 *     that is a policy/tuning question, not a correctness one.
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

import { createHash } from "node:crypto"
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  writeSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { gunzipSync, gzipSync } from "node:zlib"
import { assertSingleStatement } from "@bearly/sqlite"
import type { Database } from "bun:sqlite"
import { createLogger } from "loggily"
import { MESSAGE_ARCHIVE_COLUMNS, type TribeStatements } from "./database.ts"
import { CURSOR_WARNING_MS } from "./health-cadence.ts"

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
  /** 21757 — the retention live window. A recipient that read its mailbox
   *  inside this window is live: its unread direct actionables are never
   *  archived and its cursor holds the fleet-wide delete floor. A recipient
   *  outside it is dormant: it does not hold the floor, its unread rows
   *  archive by age, and the loss is recorded in mailbox_prunes so the seat
   *  is told on its next read. One fleet-wide constant (storage policy),
   *  deliberately NOT the per-seat inbox-stale threshold (attention policy):
   *  coupling them would let one seat's tuning change what the journal
   *  keeps. Must be at least CURSOR_WARNING_MS (asserted at resolve).
   *  Default 7d. */
  readonly liveWindowMs: number
  /** 27889 — where the cold export writes. Undefined means the default,
   *  `archive-export/` beside the live tribe.db (resolved from the open
   *  connection, never a temp dir — the export IS the durable copy of
   *  everything the delete removes). TRIBE_RETENTION_EXPORT_DIR overrides. */
  readonly exportDir?: string
}

const DEFAULT_ARCHIVE_WINDOW_MS = 14 * DAY_MS
const DEFAULT_DELETE_WINDOW_MS = 90 * DAY_MS
const DEFAULT_BATCH_SIZE = 500
export const DEFAULT_LIVE_WINDOW_MS = 7 * DAY_MS

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

/** Parse an optional path env var: unset or blank means "use the default".
 *  A declared path is taken verbatim — never silently relocated. */
function optionalPathEnv(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined
  return raw
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
    exportDir: optionalPathEnv(env.TRIBE_RETENTION_EXPORT_DIR),
    liveWindowMs: liveWindowEnv(env.TRIBE_RETENTION_LIVE_WINDOW_MS),
  }
}

/** The live window must not be shorter than the daemon's own cursor-staleness
 *  warning: a seat the cadence facts still call merely late must never be
 *  treated as dormant by retention. Fails loud at resolve, never clamps. */
function liveWindowEnv(raw: string | undefined): number {
  const ms = positiveIntEnv(raw, DEFAULT_LIVE_WINDOW_MS, "TRIBE_RETENTION_LIVE_WINDOW_MS")
  if (ms < CURSOR_WARNING_MS) {
    throw new Error(
      `TRIBE_RETENTION_LIVE_WINDOW_MS=${ms} is shorter than the cursor-staleness warning (${CURSOR_WARNING_MS}ms): ` +
        `retention would archive unread rows of a seat the cadence facts still call live. Raise it to at least ${CURSOR_WARNING_MS}.`,
    )
  }
  return ms
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
  | "selectArchiveRowsForExport"
  | "selectArchiveRowsByIdsSql"
  | "selectArchiveMoveAttentionLossSql"
  | "upsertMailboxPrune"
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
  /** 21757 — unread direct actionables this batch took out of attention,
   *  per dormant recipient, recorded in mailbox_prunes. Live recipients'
   *  rows never enter the batch, so every entry here is a seat that will be
   *  told on its next read. */
  readonly attentionLoss: ReadonlyArray<{ recipient: string; lost: number; before_ts: number }>
}

/** 27889 — outcome of the cold export that gates the delete. Carried on the
 *  sweep result so a caller can log it (with-runtime does, at error) and a
 *  test can assert it without scraping log output. */
export interface ArchiveExportResult {
  /** "skipped" — delete disabled, or nothing eligible this tick; "ok" —
   *  every eligible row's bytes are verified in its day file; "failed" —
   *  export refused, so the batch was NOT deleted. */
  readonly status: "skipped" | "ok" | "failed"
  /** UTC day keys (YYYY-MM-DD) written or verified this tick. */
  readonly days: ReadonlyArray<string>
  /** Rows appended this tick. An id already in the day's manifest appends
   *  nothing and counts 0 (a crash between export and delete). */
  readonly rows: number
  /** Gzip bytes appended this tick. */
  readonly bytes: number
  /** Set only when status is "failed": the named reason the batch was kept. */
  readonly error: string | null
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
  /** 27889 — the export that ran (or was skipped) before this batch's delete. */
  readonly export: ArchiveExportResult
}

export interface RetentionSweepResult {
  readonly now: number
  readonly archiveMove: ArchiveMovePhaseResult
  readonly archiveDelete: ArchiveDeletePhaseResult
  /** 27889 — same value as archiveDelete.export, surfaced here because the
   *  export is the sweep's safety gate, not merely a delete-phase detail. */
  readonly export: ArchiveExportResult
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
      assertSingleStatement(`INSERT OR IGNORE INTO messages_archive (
				seq, ${MESSAGE_ARCHIVE_COLUMNS}, archived_at
			)
			SELECT
				rowid, ${MESSAGE_ARCHIVE_COLUMNS}, ?
			FROM messages WHERE id IN (${placeholders})`),
    ).run(archivedAt, ...ids)
    const res = db.prepare(assertSingleStatement(`DELETE FROM messages WHERE id IN (${placeholders})`)).run(...ids)
    return res.changes ?? 0
  })()
}

function archiveDeleteBatch(db: Database, ids: readonly string[]): number {
  if (ids.length === 0) return 0
  const placeholders = ids.map(() => "?").join(",")
  return db.transaction(() => {
    const res = db
      .prepare(assertSingleStatement(`DELETE FROM messages_archive WHERE id IN (${placeholders})`))
      .run(...ids)
    return res.changes ?? 0
  })()
}

// ---------------------------------------------------------------------------
// Cold export (27889) — the durable copy that gates the delete
// ---------------------------------------------------------------------------

const SKIPPED_EXPORT: ArchiveExportResult = { status: "skipped", days: [], rows: 0, bytes: 0, error: null }

/** Resolve the export directory: the declared env path, else `archive-export/`
 *  beside the live tribe.db. The db path is read from the open connection
 *  itself (PRAGMA database_list, `main`) — the same file with-database opened —
 *  so retention needs no new plumbing and cannot disagree with the daemon
 *  about where the store lives. An in-memory database with no declared dir has
 *  nowhere durable to write: refuse loudly, because deleting a row that could
 *  not be exported is exactly the dangling-evidence failure this gate exists
 *  to prevent. */
export function resolveArchiveExportDir(db: Database, config: RetentionConfig): string {
  if (config.exportDir !== undefined) return config.exportDir
  const main = (db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(
    (row) => row.name === "main",
  )
  const file = main?.file ?? ""
  if (file === "" || file.startsWith(":")) {
    throw new Error(
      "archive-export: no export directory — the main database is in-memory and TRIBE_RETENTION_EXPORT_DIR is unset; refusing to delete rows that cannot be exported",
    )
  }
  return join(dirname(file), "archive-export")
}

/** The UTC day a row belongs to — the day bucket @cto's Q2 accepted. */
function exportDayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

interface ExportManifest {
  readonly day: string
  readonly rows: number
  readonly bytes: number
  readonly sha256: string
  readonly ids: ReadonlyArray<string>
}

const SHA256_HEX = /^[0-9a-f]{64}$/

/** The proof an EMPTY day file hashes to — committed as a new day's first
 *  manifest so "missing" can never mean "lost over committed bytes" (F1). */
const EMPTY_SHA256 = createHash("sha256").update(Buffer.alloc(0)).digest("hex")

/** The manifest is the durable proof of what the day file holds, and therefore
 *  of what may be deleted. EVERY field is validated — its day, its byte length,
 *  its row count against its id list, its id element types and its checksum.
 *  A malformed manifest fails loud rather than degrading to "no ids recorded"
 *  (which would re-append and double-export) or to an unusable checksum. */
function readExportManifest(path: string, day: string): ExportManifest | null {
  if (!existsSync(path)) return null
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ExportManifest>
  if (typeof parsed.bytes !== "number" || !Number.isInteger(parsed.bytes) || parsed.bytes < 0) {
    throw new Error(`archive-export: ${path} is not a readable manifest (needs a non-negative integer bytes)`)
  }
  if (!Array.isArray(parsed.ids)) {
    throw new Error(`archive-export: ${path} is not a readable manifest (needs an array ids)`)
  }
  if (String(parsed.day ?? "") !== day) {
    throw new Error(`archive-export: ${path} names day ${String(parsed.day ?? "")} but was read for ${day}`)
  }
  // `rows` is a REQUIRED count, never defaulted from ids.length and never
  // coerced: a missing or string row count is a manifest that never proved how
  // many rows it recorded, and silently supplying one is accepting an invalid
  // proof. Same for duplicates — a Set would collapse them, so a manifest whose
  // ids repeat must fail loud rather than normalize to a shorter id list.
  if (typeof parsed.rows !== "number" || !Number.isInteger(parsed.rows) || parsed.rows < 0) {
    throw new Error(`archive-export: ${path} is not a readable manifest (needs a non-negative integer rows)`)
  }
  const ids = parsed.ids.map((id) => {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`archive-export: ${path} holds a non-string or empty id in its manifest`)
    }
    return id
  })
  if (new Set(ids).size !== ids.length) {
    throw new Error(`archive-export: ${path} holds duplicate ids in its manifest; refusing to trust it`)
  }
  if (parsed.rows !== ids.length) {
    throw new Error(
      `archive-export: ${path} records ${parsed.rows} rows against ${ids.length} ids; refusing to trust it`,
    )
  }
  if (typeof parsed.sha256 !== "string" || !SHA256_HEX.test(parsed.sha256)) {
    throw new Error(`archive-export: ${path} has no valid sha256 (${String(parsed.sha256 ?? "")})`)
  }
  return {
    day,
    rows: parsed.rows,
    bytes: parsed.bytes,
    sha256: parsed.sha256,
    ids,
  }
}

/** Parse the decompressed day file into its row objects. A gunzip failure or a
 *  line that is not a JSON object is a corrupt day file, and corrupt proof must
 *  fail loud: this file is the evidence that its rows may be deleted. */
function parseExportRows(file: string, raw: Buffer): Array<Record<string, unknown>> {
  let text: string
  try {
    text = gunzipSync(raw).toString("utf8")
  } catch (error) {
    throw new Error(
      `archive-export: ${file} could not be decompressed (${error instanceof Error ? error.message : String(error)}); refusing to trust it`,
    )
  }
  const rows: Array<Record<string, unknown>> = []
  for (const line of text.split("\n")) {
    if (line.length === 0) continue
    const parsed = JSON.parse(line) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`archive-export: ${file} holds a non-object row line: ${line.slice(0, 80)}`)
    }
    rows.push(parsed as Record<string, unknown>)
  }
  return rows
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function writeExportManifest(dir: string, path: string, manifest: ExportManifest): void {
  const tmp = `${path}.tmp`
  // The manifest names the ids whose rows may be deleted; it is created 0o600
  // like the day file it proves (F2, @cto 2026-10-11).
  const fd = openSync(tmp, "w", 0o600)
  try {
    writeSync(fd, JSON.stringify(manifest))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
  fsyncPath(dir)
}

/**
 * Append one gzip member (one JSON row per line) for `day` and commit the
 * manifest. Ordering is the whole point, and every verification is bounded by
 * THIS tick's batch rather than by the day file it appends to (F3, @cto
 * 2026-10-11): a day file grows across ticks, so re-decoding the accumulated
 * file on every tick made a tick's cost grow with the day (three full decodes
 * of the largest archived day measured ~324 ms, synchronous, on the wire
 * daemon's event loop).
 *
 *   1. verify the COMMITTED prefix — the manifest's recorded byte length IS
 *      the commit point (@cto Q3) and its sha256 is the integrity proof of
 *      exactly those bytes; a prefix that no longer hashes to it is corrupt and
 *      fails loud, and the checksum is never recomputed over bad bytes. The
 *      prefix is PROVEN BY ITS HASH and never re-decoded: every byte of it was
 *      written AND decoded by an earlier tick's step 4, and any change to it
 *      since (bit rot, an in-place edit, a partial write) moves this checksum;
 *   2. truncate any tail past the commit point — a crash between append and
 *      manifest leaves an unrecorded tail the next tick discards;
 *   2b. ONLY when a candidate is already recorded in the manifest, decode the
 *      committed prefix and require each such candidate to be backed by an
 *      EQUAL COMPLETE row; a recorded candidate the prefix does not hold, or
 *      holds differently, refuses the whole batch and names the id and the
 *      file. The manifest's id list is NOT bound to the file's bytes (the
 *      sha256 covers only the gzip prefix), so without this a manifest-only
 *      edit can name a row that was never exported and the delete discards it
 *      (@dev/2 NO-GO, 2026-10-11, reproduced at fb229c0b). The path is normally
 *      empty — an id stays recorded only when a crash landed between export and
 *      delete — so the normal tick stays O(batch) and pays no decode.
 *      messages_archive being INSERT-ONLY is still why a deleted candidate
 *      cannot have changed under its copy; an UPDATE path is exactly what this
 *      check catches;
 *   3. append only ids the manifest does not already cover, fsync the file;
 *   4. read the appended bytes BACK, decompress and decode ONLY that member,
 *      and verify it holds exactly the rows about to be deleted: the same ids
 *      in the same order, no duplicates, and each a COMPLETE row equal to the
 *      row being deleted (an id-only, truncated or content-changed member
 *      proves nothing about the bytes surviving). The batch is the bound, so
 *      this is O(batchSize), never O(day);
 *   5. write the manifest atomically (tmp + fsync + rename + dir fsync) with
 *      the checksum of the whole file, computed over prefix (+) appended —
 *      both buffers already in hand, so no re-read and no re-parse.
 *
 * A row's bytes are therefore on disk, verified, and recorded before the
 * caller is allowed to delete it. The read-back is bounded by the
 * appended member; the accumulated prefix is bounded by one sha256.
 */
function appendExportRows(
  dir: string,
  day: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): { rows: number; bytes: number } {
  // The export directory and both files hold full message content, so they are
  // created 0o700/0o600 rather than by umask (F2, @cto 2026-10-11).
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `messages-archive-${day}.jsonl.gz`)
  const manifestPath = join(dir, `messages-archive-${day}.manifest.json`)

  const manifest = readExportManifest(manifestPath, day)
  const recordedBytes = manifest?.bytes ?? 0
  const known = new Set(manifest?.ids ?? [])

  // F1 (@cto 2026-10-11): a MISSING manifest must always mean "never started",
  // never "lost proof over committed bytes". Two rules enforce it. First, a
  // missing manifest over a NON-EMPTY day file REFUSES — truncating to 0 here
  // would destroy the only copy of rows the DB may already have deleted, and a
  // lost manifest is indistinguishable from a crash before the first manifest.
  if (manifest === null && existsSync(file) && statSync(file).size > 0) {
    throw new Error(
      `archive-export: ${file} is non-empty but its manifest ${manifestPath} is missing; refusing to truncate or append — a missing manifest means "never started", and its loss over committed bytes would destroy the day file's only copy. Cure: restore the manifest, or move ${file} aside if it is known to hold no committed rows`,
    )
  }
  // Second, commit an EMPTY manifest BEFORE the first append of a new day, so
  // from the first byte the day file is always accompanied by its proof.
  if (manifest === null) {
    writeExportManifest(dir, manifestPath, { day, rows: 0, bytes: 0, sha256: EMPTY_SHA256, ids: [] })
  }

  let raw = Buffer.alloc(0)
  if (existsSync(file)) {
    const size = statSync(file).size
    if (size < recordedBytes) {
      throw new Error(
        `archive-export: ${file} is ${size} bytes, shorter than its manifest's recorded ${recordedBytes}; refusing to append to a truncated day file`,
      )
    }
    raw = readFileSync(file).subarray(0, recordedBytes)
    if (manifest !== null && recordedBytes > 0) {
      // Verify the committed prefix BEFORE any append or manifest rewrite. A
      // changed-but-still-valid gzip under the commit point (same ids, altered
      // contents, an incomplete row) must not be silently re-blessed: rewriting
      // the manifest with the checksum of whatever was read would make the
      // manifest prove the corruption instead of catching it, and the delete
      // would then discard the only good copy of the row.
      //
      // This is the WHOLE of the prefix's verification (F3): the sha256 is the
      // integrity anchor, and the prefix is never re-decoded. Its bytes were
      // decoded by the append-time read-back when they were written (step 4),
      // and any change to them since moves this checksum — so re-decoding the
      // accumulated day file here (and again to build a per-id comparison) only
      // made a tick's cost grow with the day.
      const committed = createHash("sha256").update(raw).digest("hex")
      if (committed !== manifest.sha256) {
        throw new Error(
          `archive-export: ${file} committed prefix (${recordedBytes} bytes) hashes to ${committed}, not the manifest's ${manifest.sha256}; refusing to append to or rewrite a corrupted day file`,
        )
      }
    }
    if (size > recordedBytes) truncateSync(file, recordedBytes)
  } else if (recordedBytes > 0) {
    throw new Error(
      `archive-export: ${file} is missing but its manifest records ${recordedBytes} bytes; refusing to proceed`,
    )
  }

  const fresh = rows.filter((row) => !known.has(String(row.id)))

  // A candidate the manifest ALREADY records is not proven by the manifest
  // alone: its id list is not bound to the file's bytes, so a manifest-only
  // edit can name a row that was never exported (@dev/2 NO-GO 7915d994,
  // 2026-10-11). When any such candidate exists, decode the committed prefix
  // ONCE and require each to be backed by an EQUAL COMPLETE row; a missing or
  // unequal recorded candidate refuses the whole batch. Normally there is none
  // — an id stays recorded only when a crash landed between export and delete
  // — so the normal tick never pays for this decode (step 2b).
  const recorded = rows.filter((row) => known.has(String(row.id)))
  if (recorded.length > 0) {
    const stored = new Map<string, Record<string, unknown>>()
    if (raw.length > 0) {
      for (const exported of parseExportRows(file, raw)) stored.set(String(exported.id), exported)
    }
    for (const row of recorded) {
      const id = String(row.id)
      const exported = stored.get(id)
      if (exported === undefined) {
        throw new Error(
          `archive-export: ${file} records id ${id} in its manifest but its committed prefix holds no such row; refusing to delete a row that was never exported`,
        )
      }
      if (!isDeepStrictEqual(exported, JSON.parse(JSON.stringify(row)))) {
        throw new Error(
          `archive-export: ${file} committed prefix holds id ${id} whose exported row does not match the row being deleted; refusing to delete it`,
        )
      }
    }
  }

  let appended = Buffer.alloc(0)
  let appendedIds: string[] = []
  if (fresh.length > 0) {
    const payload = Buffer.from(fresh.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8")
    const member = gzipSync(payload)
    const fd = openSync(file, "a", 0o600)
    try {
      writeSync(fd, member)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    // Read back ONLY the bytes this tick appended — its own gzip member — and
    // prove they decode to exactly the rows about to be deleted: the same ids
    // in the same order, no duplicates, and each a COMPLETE row equal to the
    // row being deleted. An id-only, truncated or content-changed member
    // refuses the delete. Bounded by the batch, never by the day (F3).
    //
    // This covers the rows appended THIS tick; a candidate already recorded in
    // the manifest is covered by the committed-prefix check above (step 2b),
    // which is what binds the manifest's id list to the file's bytes — the
    // checksum alone does not.
    appended = readFileSync(file).subarray(recordedBytes)
    if (appended.length !== member.length) {
      throw new Error(
        `archive-export: ${file} read back ${appended.length} bytes where ${member.length} were appended; refusing to delete`,
      )
    }
    const decoded = parseExportRows(file, appended)
    appendedIds = decoded.map((row) => String(row.id))
    if (appendedIds.length !== fresh.length) {
      throw new Error(
        `archive-export: ${file} appended member decodes to ${appendedIds.length} row(s), not the ${fresh.length} written; refusing to delete`,
      )
    }
    if (new Set(appendedIds).size !== appendedIds.length) {
      throw new Error(
        `archive-export: ${file} appended member holds duplicate ids (${appendedIds.length} lines, ${new Set(appendedIds).size} unique); refusing to delete`,
      )
    }
    for (let index = 0; index < fresh.length; index += 1) {
      const written = fresh[index] as Record<string, unknown>
      const id = String(written.id)
      if (appendedIds[index] !== id) {
        throw new Error(
          `archive-export: ${file} appended member row ${index} is id ${appendedIds[index]}, not the written ${id}; refusing to delete`,
        )
      }
      if (!isDeepStrictEqual(decoded[index], JSON.parse(JSON.stringify(written)))) {
        throw new Error(
          `archive-export: ${file} appended member holds id ${id} whose exported row does not match the row being deleted; refusing to delete it`,
        )
      }
    }
  }

  // The file is now prefix (+) appended, and the manifest's recorded ids are
  // exactly the prefix's. Whole-file invariants therefore hold by construction:
  // an id already in `known` is never appended, the member was just proven
  // duplicate-free and complete, a recorded candidate was just proven present
  // and equal in the prefix (step 2b), and `known` itself was validated
  // duplicate-free when read. Only an actual append changes the manifest; a
  // tick that appended nothing (a crash between export and delete) leaves it
  // byte-identical.
  //
  // STATED RESIDUAL (@cto 2026-10-11): a CONSISTENT rewrite of BOTH the day
  // file and its manifest has no anchor — neither shape can detect it, because
  // the old whole-file decode trusted the same manifest. A MANIFEST-ONLY edit
  // is caught, on the recorded-candidate path (step 2b).
  const bytes = recordedBytes + appended.length
  if (appended.length > 0) {
    writeExportManifest(dir, manifestPath, {
      day,
      rows: known.size + appendedIds.length,
      bytes,
      sha256: createHash("sha256").update(raw).update(appended).digest("hex"),
      ids: [...known, ...appendedIds],
    })
  }
  return { rows: fresh.length, bytes: bytes - recordedBytes }
}

/** Export a candidate batch: bucket by UTC day, write one day file per bucket,
 *  and return the verified outcome. Throws on any failure — the caller keeps
 *  the batch. */
function exportArchiveRows(dir: string, rows: ReadonlyArray<Record<string, unknown>>): ArchiveExportResult {
  const byDay = new Map<string, Array<Record<string, unknown>>>()
  for (const row of rows) {
    const day = exportDayKey(Number(row.ts))
    const bucket = byDay.get(day)
    if (bucket) bucket.push(row)
    else byDay.set(day, [row])
  }
  const days: string[] = []
  let appendedRows = 0
  let appendedBytes = 0
  for (const day of [...byDay.keys()].sort()) {
    const written = appendExportRows(dir, day, byDay.get(day) ?? [])
    days.push(day)
    appendedRows += written.rows
    appendedBytes += written.bytes
  }
  log.info?.(
    `archive-export: verified ${rows.length} row(s) across ${days.length} day file(s) at ${dir} (${appendedRows} appended, ${appendedBytes} gzip bytes)`,
  )
  return { status: "ok", days, rows: appendedRows, bytes: appendedBytes, error: null }
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
  const liveCutoff = now - config.liveWindowMs
  const candidates = stmts.selectMessagesToArchiveBatch.all({
    $cutoff: cutoff,
    $limit: config.batchSize,
    $live_cutoff: liveCutoff,
  }) as Array<{
    rowid: number
    id: string
  }>
  if (candidates.length === 0) {
    log.debug?.(`archive-move: nothing eligible (cutoff=${new Date(cutoff).toISOString()})`)
    return { cutoff, candidates: 0, moved: 0, attentionLoss: [] }
  }
  const ids = candidates.map((c) => c.id)
  // Record the attention loss BEFORE the move, while the rows are still in
  // `messages`: selectAttention's untracked branch reads that table only, so
  // once moved these rows are invisible to their recipient's projection.
  const attentionLoss = recordArchiveAttentionLoss(db, stmts, ids, now)
  const moved = archiveMoveBatch(db, ids, now)
  const lossNote =
    attentionLoss.length === 0
      ? ""
      : `; attention loss recorded for ${attentionLoss.length} dormant recipient(s): ${attentionLoss
          .map((l) => `${l.recipient}=${l.lost}`)
          .join(", ")}`
  log.info?.(
    `archive-move: moved ${moved}/${candidates.length} message(s) older than ${config.archiveWindowMs}ms to messages_archive (batch cap ${config.batchSize})${lossNote}`,
  )
  return { cutoff, candidates: candidates.length, moved, attentionLoss }
}

/** 21757 — for every dormant recipient whose unread direct actionables are
 *  in this batch, upsert a prune notice (count accumulates across batches,
 *  before_ts keeps the newest lost row's timestamp). Exported for the
 *  cleanupOldData mover in session.ts, which archives on the same rule. */
export function recordArchiveAttentionLoss(
  db: Database,
  stmts: Pick<RetentionStatements, "selectArchiveMoveAttentionLossSql" | "upsertMailboxPrune">,
  ids: readonly string[],
  now: number,
): Array<{ recipient: string; lost: number; before_ts: number }> {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => "?").join(",")
  const loss = db
    .prepare(assertSingleStatement(stmts.selectArchiveMoveAttentionLossSql(placeholders)))
    .all(...ids) as Array<{
    recipient: string
    lost: number
    before_ts: number
  }>
  for (const row of loss) {
    stmts.upsertMailboxPrune.run({ $recipient: row.recipient, $count: row.lost, $before: row.before_ts, $now: now })
  }
  return loss
}

/** A live cursor that SETS the fleet-wide floor — named so retention can log
 *  who is holding deletion down when that actually excludes rows. */
interface LiveCursorFloor {
  /** The lowest acknowledged position across live readers that have advanced
   *  at all. Number.MAX_SAFE_INTEGER when no live reader has advanced. */
  readonly floor: number
  readonly setter: { family: "mailbox" | "session"; name: string; value: number; readAt: number } | null
}

/**
 * 21757 — the floor is taken over LIVE recipients only (read inside the live
 * window). A dormant seat's cursor no longer holds deletion down for the
 * fleet; its unread rows are archived by age with a prune notice.
 *
 * F3 (@cto 2026-10-11): a cursor that has NEVER advanced is NOT a position —
 * `last_actionable_seq`/`last_inbox_pull_seq` of 0 means the reader has
 * acknowledged nothing, and `seq <= 0` admits no archived row, so one such
 * LIVE reader voids retention fleet-wide forever (measured: @probe/28571, a
 * live probe with cursor 0). Both families therefore carry
 * `... > 0` in the statement itself. The residual class — a live reader
 * stuck at a low NONZERO position — is real but bounded, so instead of
 * silently voiding the promise it is made visible: the setter is returned
 * here and named by the caller whenever the floor actually excludes rows.
 */
function computeCursorFloor(stmts: RetentionStatements, liveCutoff: number): LiveCursorFloor {
  const mailbox = stmts.selectMailboxCursorFloor.get({ $live_cutoff: liveCutoff }) as {
    floor: number
    setter: string
    setter_read_at: number
  } | null
  const session = stmts.selectSessionInboxCursorFloor.get({ $live_cutoff: liveCutoff }) as {
    floor: number
    setter: string
    setter_read_at: number
  } | null
  const advanced: Array<{ family: "mailbox" | "session"; floor: number; name: string; readAt: number }> = []
  if (mailbox) {
    advanced.push({ family: "mailbox", floor: mailbox.floor, name: mailbox.setter, readAt: mailbox.setter_read_at })
  }
  if (session) {
    advanced.push({ family: "session", floor: session.floor, name: session.setter, readAt: session.setter_read_at })
  }
  // No live reader has advanced (fresh DB, or every live cursor still at 0) —
  // there is no position to protect, so this exclusion contributes nothing.
  if (advanced.length === 0) return { floor: Number.MAX_SAFE_INTEGER, setter: null }
  const lowest = advanced.reduce((a, b) => (b.floor < a.floor ? b : a))
  return {
    floor: lowest.floor,
    setter: { family: lowest.family, name: lowest.name, value: lowest.floor, readAt: lowest.readAt },
  }
}

/** The last floor-setter this process logged. The note is rate-limited to once
 *  per setter: a tick that does not exclude rows clears it, so a reader that
 *  sticks again (or a different one that takes the floor) is logged afresh.
 *  A repeated identical line every 6h for the same stuck reader is noise, not
 *  signal. */
let lastFloorSetterNote: string | null = null

/** Name the reader whose live cursor is holding the fleet-wide floor down,
 *  once per setter, whenever the floor actually excluded archived rows
 *  (F3/@cto 2026-10-11). Never silent: a floor that voids retention must be
 *  attributable from the log without querying the DB. */
function noteFloorSetter(setter: LiveCursorFloor["setter"], floor: number): void {
  if (setter === null) return
  const key = `${setter.family}:${setter.name}:${setter.value}`
  if (key === lastFloorSetterNote) return
  lastFloorSetterNote = key
  log.warn?.(
    `archive-delete: cursor floor ${floor} is set by the ${setter.family} cursor of ${setter.name} ` +
      `(last read ${new Date(setter.readAt).toISOString()}); it excludes archived rows from deletion. ` +
      `A live reader that never advances past this position holds the fleet-wide floor and voids the ` +
      `journal-retention promise until it does.`,
  )
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
      export: SKIPPED_EXPORT,
    }
  }

  const cursor = computeCursorFloor(stmts, now - config.liveWindowMs)
  const cursorFloor = cursor.floor
  const diag = stmts.selectArchiveDeleteDiagnostics.get({ $cutoff: cutoff, $cursor_floor: cursorFloor }) as {
    eligible_by_age: number | null
    excluded_by_cursor: number | null
    excluded_by_pending: number | null
  } | null
  const eligibleByAge = diag?.eligible_by_age ?? 0
  const excludedByCursor = diag?.excluded_by_cursor ?? 0
  const excludedByPending = diag?.excluded_by_pending ?? 0

  // F3 (@cto 2026-10-11): when the floor actually excluded rows, NAME the live
  // reader that holds it — the floor is fleet-wide, so one stuck reader voids
  // the promise for everyone, and that must be attributable from the log.
  if (excludedByCursor > 0) noteFloorSetter(cursor.setter, cursorFloor)
  else lastFloorSetterNote = null

  const candidates = stmts.selectArchiveRowsForExport.all({
    $cutoff: cutoff,
    $cursor_floor: cursorFloor,
    $limit: config.batchSize,
  }) as Array<Record<string, unknown> & { id: string; seq: number }>

  if (candidates.length === 0) {
    log.debug?.(
      `archive-delete: nothing eligible (eligible_by_age=${eligibleByAge}, excluded_by_cursor=${excludedByCursor}, excluded_by_pending=${excludedByPending}, cursor_floor=${cursorFloor})`,
    )
    return {
      enabled: true,
      cutoff,
      cursorFloor,
      eligibleByAge,
      excludedByCursor,
      excludedByPending,
      deleted: 0,
      export: SKIPPED_EXPORT,
    }
  }

  // Cold export BEFORE any delete (27889). A batch whose bytes are not on
  // disk and verified is not deleted: the archive IS the durable copy, so an
  // unexported delete turns a cited id into dangling evidence.
  let exportDir = config.exportDir ?? "(beside tribe.db)"
  let exportResult: ArchiveExportResult
  try {
    exportDir = resolveArchiveExportDir(db, config)
    exportResult = exportArchiveRows(exportDir, candidates)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error?.(
      `archive-delete: cold export FAILED for ${candidates.length} row(s) past the ${config.deleteWindowMs}ms window; ` +
        `REFUSING to delete them. exportDir=${exportDir} batchSize=${config.batchSize} error=${message}`,
    )
    return {
      enabled: true,
      cutoff,
      cursorFloor,
      eligibleByAge,
      excludedByCursor,
      excludedByPending,
      deleted: 0,
      export: { status: "failed", days: [], rows: candidates.length, bytes: 0, error: message },
    }
  }

  // Re-verify at the delete moment: between the export select and here a row
  // can gain a pending_request or a TAKING receipt. Delete only what is STILL
  // eligible; an over-exported row is harmless (the file is a superset).
  const placeholders = candidates.map(() => "?").join(",")
  const stillEligible = db
    .prepare(assertSingleStatement(stmts.selectArchiveRowsByIdsSql(placeholders)))
    .all(...candidates.map((c) => c.id), cutoff, cursorFloor) as Array<{ id: string }>
  const deleted = archiveDeleteBatch(
    db,
    stillEligible.map((c) => c.id),
  )

  if (deleted > 0) {
    log.info?.(
      `archive-delete: deleted ${deleted} archived message(s) older than ${config.deleteWindowMs}ms ` +
        `(cursor_floor=${cursorFloor}, eligible_by_age=${eligibleByAge}, excluded_by_cursor=${excludedByCursor}, excluded_by_pending=${excludedByPending}, batch cap ${config.batchSize}, exported=${exportResult.rows} rows across ${exportResult.days.length} day file(s) at ${exportDir})`,
    )
  } else {
    log.debug?.(
      `archive-delete: nothing deleted (exported ${candidates.length} row(s) but the re-verify found ${stillEligible.length} still eligible; cursor_floor=${cursorFloor})`,
    )
  }

  return {
    enabled: true,
    cutoff,
    cursorFloor,
    eligibleByAge,
    excludedByCursor,
    excludedByPending,
    deleted,
    export: exportResult,
  }
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
  return { now, archiveMove, archiveDelete, export: archiveDelete.export }
}
