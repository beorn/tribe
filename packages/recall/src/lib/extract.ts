/**
 * Extract content from Claude Code session JSONL files.
 *
 * Provides structured extraction of session transcripts for summarization
 * and indexing. Samples from beginning, middle, and end of sessions to
 * capture goals, work, and outcomes.
 *
 * 27702: the transcript is never materialised. Both the metadata scan and the
 * sampled content pass stream the file through the shared bounded reader
 * (`./qmd-export`), so a multi-GB transcript costs a fixed read buffer plus at
 * most the sampled records. A record over the reader's raw-record budget keeps
 * its position and renders as a named placeholder instead of skipping the whole
 * session.
 */

import * as fs from "fs"
import * as path from "path"
import { getDb, closeDb, PROJECTS_DIR } from "../history/db"
import { forEachJsonlLine, type OversizedJsonlRecord } from "../qmd-export"

// ============================================================================
// Types
// ============================================================================

export interface SessionExtract {
  id: string
  shortId: string // first 8 chars
  title: string | null
  time: string // formatted time string
  isSubAgent: boolean
  content: string // extracted text content
  sizeBytes: number // JSONL file size
  /** Why no usable content was produced (e.g. "changed-input"); absent when `content` is usable. */
  reason?: string
}

/** A raw record sampled from a transcript: its decoded line, or the account of an elided one. */
export interface SampledRecord {
  /** The record's JSON text, or null when the reader elided it as over-budget. */
  line: string | null
  /** Present only for an elided record — a named account, never its bytes. */
  oversized?: OversizedJsonlRecord
}

/**
 * One identity-checked, bounded two-pass scan: metadata plus the sampled raw
 * records, WITHOUT building the summary content string. The sole production
 * caller decides whether content is needed after cheap admission.
 */
export interface SessionScan {
  id: string
  shortId: string
  title: string | null
  time: string
  isSubAgent: boolean
  sizeBytes: number
  /** Why no usable transcript remained (e.g. "changed-input"); absent when the scan is usable. */
  reason?: string
  /** The sampled records in order; empty when `reason` is set. */
  records: SampledRecord[]
}

// ============================================================================
// Constants
// ============================================================================

/** Legacy sampling window: this many records from each of beginning, middle and end. */
const SAMPLE_PER_SECTION = 40
/** Legacy cap on the rendered summary input. */
const MAX_CONTENT_CHARS = 4000
/** Legacy threshold below which a text block is treated as noise, not content. */
const MIN_TEXT_LENGTH = 20
/** Legacy cap on the quick sub-agent probe's head scan. */
const QUICK_SCAN_RECORDS = 50

/** The transcript fields this extractor reads; everything else is left unread. */
interface JsonlEntry {
  type?: string
  message?: { content?: unknown }
}

/** The content-block fields this extractor reads. */
interface ContentBlock {
  type?: string
  text?: string
  name?: string
  input?: Record<string, unknown>
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Find the JSONL file path for a session ID using the DB's jsonl_path.
 * Returns full path if the file exists, null otherwise.
 */
export function findSessionJsonl(sessionId: string): string | null {
  const db = getDb()
  try {
    const row = db.prepare("SELECT jsonl_path FROM sessions WHERE id = ?").get(sessionId) as
      | { jsonl_path: string }
      | undefined

    if (!row?.jsonl_path) return null

    const fullPath = row.jsonl_path.startsWith("/") ? row.jsonl_path : path.join(PROJECTS_DIR, row.jsonl_path)

    return fs.existsSync(fullPath) ? fullPath : null
  } catch {
    // silent-fallback-allow: missing session DB row means no transcript path for extraction.
    return null
  } finally {
    closeDb()
  }
}

/**
 * Scan a session's transcript without constructing content: identity-checked
 * metadata (sub-agent classification from the sampled records) plus the sampled
 * raw records, kept so the caller can render content later without re-reading.
 *
 * Two bounded streaming passes: the first counts records to fix the sampling
 * window, the second keeps only the sampled records. A transcript that changes
 * mid-read (even with its mtime restored — ctime moves) yields a named
 * "changed-input" result and no retry.
 */
export function scanSessionTranscript(
  sessionId: string,
  opts?: { title?: string | null; createdAt?: number },
): SessionScan | null {
  const jsonlPath = findSessionJsonl(sessionId)
  if (!jsonlPath) return null

  const before = readFileIdentity(jsonlPath)
  if (!before) return null

  const shortId = sessionId.slice(0, 8)
  const title = opts?.title ?? null
  const time = formatTime(opts?.createdAt)

  try {
    const total = countJsonlRecords(jsonlPath)
    const records = collectSampledRecords(jsonlPath, selectedRecordIndices(total))

    const after = readFileIdentity(jsonlPath)
    if (!after || !sameFileIdentity(before, after)) {
      return {
        id: sessionId,
        shortId,
        title,
        time,
        isSubAgent: false,
        sizeBytes: after?.size ?? before.size,
        reason: "changed-input",
        records: [],
      }
    }

    return {
      id: sessionId,
      shortId,
      title,
      time,
      isSubAgent: !recordsCarryUserText(records),
      sizeBytes: before.size,
      records,
    }
  } catch {
    // silent-fallback-allow: an unreadable transcript makes this session unavailable for extraction.
    return null
  }
}

/**
 * Render sampled records into the bounded summary content string.
 * Preserved from the legacy extractor: 120 sampled records maximum, a ~4 KB
 * tail, and the same block/tool-use filtering.
 */
export function renderSessionContent(records: SampledRecord[]): { content: string; hasUserText: boolean } {
  const messages: string[] = []
  let hasUserText = false

  for (const record of records) {
    if (record.line === null) {
      messages.push(oversizedPlaceholder(record.oversized))
      continue
    }
    try {
      const entry = JSON.parse(record.line) as JsonlEntry
      if (entry.type !== "user" && entry.type !== "assistant") continue

      const parts: string[] = []
      const content = entry.message?.content
      if (!Array.isArray(content)) continue

      for (const block of content) {
        if (typeof block === "string") {
          if (block.length > MIN_TEXT_LENGTH) parts.push(block)
          continue
        }
        if (!block || typeof block !== "object") continue

        const b = block as ContentBlock
        if (b.type === "text" && b.text && b.text.length > MIN_TEXT_LENGTH) {
          parts.push(truncStr(b.text, 1500))
          if (entry.type === "user") hasUserText = true
        } else if (b.type === "tool_use") {
          const summary = summarizeToolUse(b)
          if (summary) parts.push(summary)
        }
        // Skip tool_result (large file dumps, noise)
      }

      if (parts.length > 0) {
        messages.push(`[${entry.type}]: ${parts.join(" | ")}`)
      }
    } catch {
      // silent-fallback-allow: a malformed JSONL line carries no content; skipping it is the legacy behavior.
    }
  }

  let joined = messages.join("\n")
  if (joined.length > MAX_CONTENT_CHARS) {
    joined = joined.slice(-MAX_CONTENT_CHARS)
  }
  return { content: joined, hasUserText }
}

/**
 * Compose the structured extract from a scan already taken: the sampled
 * records are rendered here, so a caller that already paid for the transcript
 * I/O (the summary caller, after cheap admission) never re-reads it.
 * Returns null when no usable content remains.
 */
export function extractSessionContent(scan: SessionScan): SessionExtract | null {
  if (scan.reason) {
    return {
      id: scan.id,
      shortId: scan.shortId,
      title: scan.title,
      time: scan.time,
      isSubAgent: scan.isSubAgent,
      content: "",
      sizeBytes: scan.sizeBytes,
      reason: scan.reason,
    }
  }

  const { content } = renderSessionContent(scan.records)
  if (content.length === 0) return null

  return {
    id: scan.id,
    shortId: scan.shortId,
    title: scan.title,
    time: scan.time,
    isSubAgent: scan.isSubAgent,
    content,
    sizeBytes: scan.sizeBytes,
  }
}

/**
 * Quick check if a session is likely a sub-agent (no user text content).
 * Streams at most the first 50 records and stops early.
 */
export function isSubAgent(sessionId: string): boolean {
  const jsonlPath = findSessionJsonl(sessionId)
  if (!jsonlPath) return false

  let scanned = 0
  let sawUserText = false
  try {
    forEachJsonlLine(jsonlPath, (line) => {
      scanned++
      try {
        if (userRecordHasAnyText(JSON.parse(line))) {
          sawUserText = true
          return false
        }
      } catch {
        // silent-fallback-allow: a malformed JSONL line carries no content; skipping it is the legacy behavior.
      }
      return scanned >= QUICK_SCAN_RECORDS
    })
  } catch {
    return false
  }

  return !sawUserText
}

// ============================================================================
// Helpers
// ============================================================================

interface FileIdentity {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

/** The transcript's identity fields, all of which must hold across a read. */
function readFileIdentity(filePath: string): FileIdentity | null {
  try {
    const stat = fs.statSync(filePath)
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }
  } catch {
    // silent-fallback-allow: an unreadable transcript stat makes this session unavailable for extraction.
    return null
  }
}

/**
 * ctime is the field mtime cannot fake: a same-size in-place rewrite with the
 * mtime restored still moves ctime, so the pair of passes cannot silently
 * summarize a mix of two file versions.
 */
function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

function formatTime(createdAt?: number): string {
  return createdAt
    ? new Date(createdAt).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : ""
}

/** Pass 1: count the records the reader will report, without retaining them. */
function countJsonlRecords(jsonlPath: string): number {
  let count = 0
  const tally = (): void => {
    count++
  }
  forEachJsonlLine(jsonlPath, tally, { onOversized: tally })
  return count
}

/**
 * The legacy first/middle/last selection, computed from the record count: all
 * records when there are `SAMPLE_PER_SECTION * 3` or fewer, otherwise the first
 * 40, the 40 around the midpoint, and the last 40.
 */
function selectedRecordIndices(total: number): Set<number> | "all" {
  const per = SAMPLE_PER_SECTION
  if (total <= per * 3) return "all"

  const midPoint = Math.floor(total / 2)
  const half = Math.floor(per / 2)
  const selected = new Set<number>()
  for (let i = 0; i < per; i++) selected.add(i)
  for (let i = midPoint - half; i < midPoint + half; i++) selected.add(i)
  for (let i = total - per; i < total; i++) selected.add(i)
  return selected
}

/**
 * Pass 2: keep only the selected records. The reader reports one callback per
 * non-blank record, in file order, so the running index is the record's
 * position in N — over-budget records included, which is what preserves the
 * sample's positions.
 */
function collectSampledRecords(jsonlPath: string, selected: Set<number> | "all"): SampledRecord[] {
  const records: SampledRecord[] = []
  let index = -1
  const consider = (record: SampledRecord): void => {
    index++
    if (selected === "all" || selected.has(index)) records.push(record)
  }
  forEachJsonlLine(jsonlPath, (line) => consider({ line }), {
    onOversized: (oversized) => consider({ line: null, oversized }),
  })
  return records
}

/** A named stand-in for a record the reader elided; its bytes never reach content. */
function oversizedPlaceholder(record: OversizedJsonlRecord | undefined): string {
  if (!record) return "[oversized record elided]"
  return `[oversized record elided: physical line ${record.physicalLine}, ${record.bytes} bytes over the ${record.limit}-byte record limit]`
}

/**
 * The legacy sub-agent signal: a sampled user record carrying real text. Only
 * object text blocks count, exactly as the legacy extractor counted them.
 */
function recordsCarryUserText(records: SampledRecord[]): boolean {
  for (const record of records) {
    if (record.line === null) continue
    try {
      const entry = JSON.parse(record.line) as JsonlEntry
      if (entry.type !== "user") continue
      const content = entry.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (!block || typeof block !== "object") continue
        const b = block as ContentBlock
        if (b.type === "text" && b.text && b.text.length > MIN_TEXT_LENGTH) return true
      }
    } catch {
      // silent-fallback-allow: a malformed JSONL line carries no content; skipping it is the legacy behavior.
    }
  }
  return false
}

/** The quick probe's legacy test: any user text block, empty string included. */
function userRecordHasAnyText(entry: unknown): boolean {
  const e = entry as JsonlEntry
  if (e?.type !== "user") return false
  const content = e.message?.content
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (typeof block === "string" && block.length > 0) return true
    if (block && typeof block === "object") {
      const b = block as ContentBlock
      if (b.type === "text" && b.text) return true
    }
  }
  return false
}

/** Truncate text to max length. */
function truncStr(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "..." : text
}

/** Summarize a tool_use block into a brief description. */
function summarizeToolUse(block: ContentBlock): string | null {
  const name = block.name
  const input = block.input
  if (!name || !input) return null

  switch (name) {
    case "Edit":
    case "MultiEdit":
      return `[Edit] ${fileBasename(input.file_path as string)}`
    case "Write":
      return `[Write] ${fileBasename(input.file_path as string)}`
    case "Read":
      return null // too noisy
    case "Bash": {
      const cmd = input.command as string | undefined
      return cmd ? `[Bash] ${truncStr(cmd, 120)}` : null
    }
    case "Grep":
      return `[Search] "${truncStr(String(input.pattern || ""), 50)}"`
    case "Glob":
      return null // too noisy
    case "Task":
      return `[Task] ${truncStr(String(input.description || input.prompt || ""), 80)}`
    default:
      return `[${name}]`
  }
}

function fileBasename(filePath: string | undefined): string {
  if (!filePath) return "?"
  return filePath.split("/").pop() || filePath
}
