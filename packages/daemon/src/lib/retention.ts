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
 *      day's row count and the sha256 of the whole file.
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
  const fd = openSync(tmp, "w")
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
 * manifest. Ordering is the whole point:
 *
 *   1. verify the COMMITTED prefix — the manifest's recorded byte length IS
 *      the commit point (@cto Q3) and its sha256 is the integrity proof of
 *      exactly those bytes; a prefix that no longer hashes to it is corrupt and
 *      fails loud, and the checksum is never recomputed over bad bytes;
 *   2. truncate any tail past the commit point — a crash between append and
 *      manifest leaves an unrecorded tail the next tick discards and rewrites;
 *   3. for every candidate id the manifest already records, verify the file
 *      holds that id's COMPLETE row, equal to the row being deleted (an id-only
 *      or content-changed member proves nothing about the bytes surviving);
 *   4. append only ids the manifest does not already cover, fsync the file;
 *   5. read the file BACK, decompress it, and verify it holds exactly the
 *      known ids plus the appended ids with no duplicates — on any mismatch,
 *      throw, so the caller deletes nothing;
 *   6. write the manifest atomically (tmp + fsync + rename + dir fsync).
 *
 * A row's bytes are therefore on disk, verified, and recorded before the
 * caller is allowed to delete it.
 */
function appendExportRows(
  dir: string,
  day: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): { rows: number; bytes: number } {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `messages-archive-${day}.jsonl.gz`)
  const manifestPath = join(dir, `messages-archive-${day}.manifest.json`)

  const manifest = readExportManifest(manifestPath, day)
  const recordedBytes = manifest?.bytes ?? 0
  const known = new Set(manifest?.ids ?? [])

  let raw = Buffer.alloc(0)
  if (existsSync(file)) {
    const size = statSync(file).size
    if (size < recordedBytes) {
      throw new Error(
        `archive-export: ${file} is ${size} bytes, shorter than its manifest's recorded ${recordedBytes}; refusing to append to a truncated day file`,
      )
    }
    raw = readFileSync(file)
    if (manifest !== null) {
      // Verify the committed prefix BEFORE any append or manifest rewrite. A
      // changed-but-still-valid gzip under the commit point (same ids, altered
      // contents, an incomplete row) must not be silently re-blessed: rewriting
      // the manifest with the checksum of whatever was read would make the
      // manifest prove the corruption instead of catching it, and the delete
      // would then discard the only good copy of the row.
      const committed = createHash("sha256").update(raw.subarray(0, recordedBytes)).digest("hex")
      if (committed !== manifest.sha256) {
        throw new Error(
          `archive-export: ${file} committed prefix (${recordedBytes} bytes) hashes to ${committed}, not the manifest's ${manifest.sha256}; refusing to append to or rewrite a corrupted day file`,
        )
      }
      // The manifest's own recorded count and ids must agree with the bytes its
      // checksum proves. A manifest that states a different row count or different
      // ids than the committed prefix decodes to is an invalid proof — a default
      // or coerced count, or duplicate ids — and must never be re-blessed with a
      // fresh manifest over the same bytes.
      if (recordedBytes > 0) {
        const committedRows = parseExportRows(file, raw.subarray(0, recordedBytes))
        const committedIds = committedRows.map((row) => String(row.id))
        if (committedRows.length !== manifest.rows) {
          throw new Error(
            `archive-export: ${file} committed prefix decodes to ${committedRows.length} row(s), not the ${manifest.rows} its manifest records; refusing to append`,
          )
        }
        if (
          committedIds.length !== manifest.ids.length ||
          committedIds.some((id, index) => id !== manifest.ids[index])
        ) {
          throw new Error(
            `archive-export: ${file} committed prefix ids do not match its manifest's recorded ids; refusing to append`,
          )
        }
      }
    }
    if (size > recordedBytes) {
      truncateSync(file, recordedBytes)
      raw = raw.subarray(0, recordedBytes)
    }
  } else if (recordedBytes > 0) {
    throw new Error(
      `archive-export: ${file} is missing but its manifest records ${recordedBytes} bytes; refusing to proceed`,
    )
  }

  // Every candidate the manifest already records must be backed on disk by the
  // COMPLETE row, matching the row we are about to delete. An id-only gzip
  // member, or one whose contents changed under a matching manifest, proves an
  // id was seen and never that the row's bytes survived.
  if (raw.length > 0) {
    const stored = new Map<string, Record<string, unknown>>()
    for (const row of parseExportRows(file, raw)) {
      if (typeof row.id !== "string") {
        throw new Error(`archive-export: ${file} holds a row with no string id; refusing to trust it`)
      }
      stored.set(row.id, row)
    }
    for (const row of rows) {
      const id = String(row.id)
      if (!known.has(id)) continue
      const existing = stored.get(id)
      if (existing === undefined) {
        throw new Error(`archive-export: ${file} records id ${id} but holds no row for it; refusing to delete it`)
      }
      if (!isDeepStrictEqual(existing, JSON.parse(JSON.stringify(row)))) {
        throw new Error(
          `archive-export: ${file} holds id ${id} whose exported row does not match the row being deleted; refusing to delete it`,
        )
      }
    }
  }

  const fresh = rows.filter((row) => !known.has(String(row.id)))
  if (fresh.length > 0) {
    const payload = Buffer.from(fresh.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8")
    const fd = openSync(file, "a")
    try {
      writeSync(fd, gzipSync(payload))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  const bytes = existsSync(file) ? statSync(file).size : 0
  const finalRaw = bytes > 0 ? readFileSync(file) : Buffer.alloc(0)
  const parsedIds = (finalRaw.length > 0 ? parseExportRows(file, finalRaw) : []).map((row) => String(row.id))
  const unique = new Set(parsedIds)
  const expected = new Set([...known, ...fresh.map((row) => String(row.id))])
  if (unique.size !== parsedIds.length) {
    throw new Error(
      `archive-export: ${file} holds duplicate ids after append (${parsedIds.length} lines, ${unique.size} unique)`,
    )
  }
  for (const id of expected) {
    if (!unique.has(id)) {
      throw new Error(`archive-export: ${file} is missing id ${id} after append; refusing to delete it`)
    }
  }
  for (const id of unique) {
    if (!expected.has(id)) throw new Error(`archive-export: ${file} holds an unrecorded id ${id}; refusing to proceed`)
  }

  writeExportManifest(dir, manifestPath, {
    day,
    rows: parsedIds.length,
    bytes,
    sha256: createHash("sha256").update(finalRaw).digest("hex"),
    ids: [...unique],
  })
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

/** 21757 — the floor is taken over LIVE recipients only (read inside the
 *  live window). A dormant seat's cursor no longer holds deletion down for
 *  the fleet; its unread rows are archived by age with a prune notice. */
function computeCursorFloor(stmts: RetentionStatements, liveCutoff: number): number {
  const mailbox = stmts.selectMailboxCursorFloor.get({ $live_cutoff: liveCutoff }) as { floor: number | null } | null
  const session = stmts.selectSessionInboxCursorFloor.get({ $live_cutoff: liveCutoff }) as {
    floor: number | null
  } | null
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
      export: SKIPPED_EXPORT,
    }
  }

  const cursorFloor = computeCursorFloor(stmts, now - config.liveWindowMs)
  const diag = stmts.selectArchiveDeleteDiagnostics.get({ $cutoff: cutoff, $cursor_floor: cursorFloor }) as {
    eligible_by_age: number | null
    excluded_by_cursor: number | null
    excluded_by_pending: number | null
  } | null
  const eligibleByAge = diag?.eligible_by_age ?? 0
  const excludedByCursor = diag?.excluded_by_cursor ?? 0
  const excludedByPending = diag?.excluded_by_pending ?? 0

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
