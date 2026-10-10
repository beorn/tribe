/**
 * Extract content from Claude Code session JSONL files.
 *
 * Provides structured extraction of session transcripts for summarization
 * and indexing. Samples from beginning, middle, and end of sessions to
 * capture goals, work, and outcomes.
 *
 * 27702: the transcript is never materialised and no raw sampled record is
 * retained. Both passes stream the file through the shared bounded reader
 * (`./qmd-export`), and the sampled messages are rendered incrementally into a
 * bounded 4000-character tail, so a multi-GB transcript costs a fixed read
 * buffer and one bounded output string. A record over the reader's raw-record
 * budget keeps its position and renders as a named placeholder instead of
 * skipping the whole session; an unsupported (non-Claude) sampled envelope is
 * named, never silently reclassified as a sub-agent.
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

/** Which bounded pass the caller needs: classification only, or classification plus content. */
export type ScanMode = "metadata" | "content"

/** Per-session extraction diagnostics: counts only, never raw record bytes. */
export interface ScanDiagnostics {
  /** N — the nonempty records pass one counted. */
  records: number
  /** How many of N the sample selected. */
  sampled: number
  /** Sampled records whose JSON did not parse. */
  malformed: number
  /** Sampled records the reader elided as over the raw-record budget. */
  oversized: number
  /** Sampled records carrying a recognised non-Claude (unsupported) envelope. */
  unsupported: number
}

/**
 * One identity-checked, bounded two-pass scan. No raw record survives it: in
 * `content` mode the sampled messages render incrementally into a bounded
 * 4000-character tail; in `metadata` mode only classification and the counts
 * are kept. Either way the caller decides, after cheap admission, whether the
 * content pass is worth a second bounded read.
 */
export interface SessionScan {
  id: string
  shortId: string
  title: string | null
  time: string
  isSubAgent: boolean
  sizeBytes: number
  /** Why no usable transcript remained (e.g. "changed-input", "unsupported-sampled-format"). */
  reason?: string
  /** The bounded rendered content; always "" in `metadata` mode. */
  content: string
  diagnostics: ScanDiagnostics
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
  payload?: unknown
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
 * Scan a session's transcript with bounded retention: identity-checked metadata
 * (sub-agent classification from the sampled records) plus, in `content` mode,
 * the incrementally rendered 4000-character tail. No raw record is kept.
 *
 * Two bounded streaming passes: the first counts records to fix the sampling
 * window, the second renders only the sampled records. A transcript that changes
 * mid-read (even with its mtime restored — ctime moves) yields a named
 * "changed-input" result and no retry. An unsupported (non-Claude) sampled
 * envelope yields a named "unsupported-sampled-format" reason rather than a
 * silent sub-agent classification.
 */
export function scanSessionTranscript(
  sessionId: string,
  opts?: { title?: string | null; createdAt?: number; mode?: ScanMode },
): SessionScan | null {
  const jsonlPath = findSessionJsonl(sessionId)
  if (!jsonlPath) return null

  const before = readFileIdentity(jsonlPath)
  if (!before) return null

  const shortId = sessionId.slice(0, 8)
  const title = opts?.title ?? null
  const time = formatTime(opts?.createdAt)
  const mode: ScanMode = opts?.mode ?? "content"
  const none = { records: 0, sampled: 0, malformed: 0, oversized: 0, unsupported: 0 }

  try {
    const total = countJsonlRecords(jsonlPath)
    const sampled = scanSampledRecords(jsonlPath, selectedRecordIndices(total), mode)

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
        content: "",
        diagnostics: none,
      }
    }

    return {
      id: sessionId,
      shortId,
      title,
      time,
      // A named reason (unsupported format, no usable content) is never a sub-agent; only the
      // supported Claude path can classify as one.
      isSubAgent: sampled.reason === undefined && !sampled.claudeUserText,
      sizeBytes: before.size,
      reason: sampled.reason,
      content: sampled.content,
      diagnostics: {
        records: total,
        sampled: sampled.sampled,
        malformed: sampled.malformed,
        oversized: sampled.oversized,
        unsupported: sampled.unsupported,
      },
    }
  } catch {
    // silent-fallback-allow: an unreadable transcript makes this session unavailable for extraction.
    return null
  }
}

/**
 * Compose the structured extract from a scan already taken. The scan built the
 * bounded content itself (content mode), so a caller that already paid for the
 * transcript I/O never re-reads it. Returns null when no usable content remains.
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

  if (scan.content.length === 0) return null

  return {
    id: scan.id,
    shortId: scan.shortId,
    title: scan.title,
    time: scan.time,
    isSubAgent: scan.isSubAgent,
    content: scan.content,
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
 * The bounded result of pass 2: classification signals plus (content mode only)
 * the incrementally rendered tail. Nothing here grows with the transcript.
 */
interface SampledScan {
  content: string
  sampled: number
  malformed: number
  oversized: number
  unsupported: number
  supported: number
  claudeUserText: boolean
  reason?: string
}

/**
 * Pass 2: process only the selected records, in order, without retaining any of
 * them. The reader reports one callback per non-blank record, so the running
 * index is the record's position in N — over-budget records included, which is
 * what preserves the sample's positions.
 *
 * Rendered messages are appended to a rolling tail trimmed to the legacy
 * MAX_CONTENT_CHARS after each append, so the joined-then-sliced result is
 * reproduced exactly while only the last 4000 characters are ever held.
 */
function scanSampledRecords(jsonlPath: string, selected: Set<number> | "all", mode: ScanMode): SampledScan {
  const acc: SampledScan = {
    content: "",
    sampled: 0,
    malformed: 0,
    oversized: 0,
    unsupported: 0,
    supported: 0,
    claudeUserText: false,
  }
  let tail = ""
  let tailStarted = false

  const appendMessage = (message: string): void => {
    if (mode !== "content") return
    tail = tailStarted ? `${tail}\n${message}` : message
    tailStarted = true
    if (tail.length > MAX_CONTENT_CHARS) tail = tail.slice(-MAX_CONTENT_CHARS)
  }

  const consume = (line: string | null, oversized?: OversizedJsonlRecord): void => {
    acc.sampled++
    if (line === null) {
      acc.oversized++
      appendMessage(oversizedPlaceholder(oversized))
      return
    }

    let entry: JsonlEntry
    try {
      entry = JSON.parse(line) as JsonlEntry
    } catch {
      // silent-fallback-allow: a malformed JSONL line carries no content; skipping it is the legacy behavior.
      acc.malformed++
      return
    }

    if (entry.type !== "user" && entry.type !== "assistant") {
      if (isUnsupportedSampledFormat(entry)) acc.unsupported++
      return
    }
    acc.supported++

    const content = entry.message?.content
    if (!Array.isArray(content)) return

    const parts: string[] = []
    for (const block of content) {
      if (typeof block === "string") {
        if (block.length > MIN_TEXT_LENGTH) parts.push(block)
        continue
      }
      if (!block || typeof block !== "object") continue

      const b = block as ContentBlock
      if (b.type === "text" && b.text && b.text.length > MIN_TEXT_LENGTH) {
        parts.push(truncStr(b.text, 1500))
        if (entry.type === "user") acc.claudeUserText = true
      } else if (b.type === "tool_use") {
        const summary = summarizeToolUse(b)
        if (summary) parts.push(summary)
      }
      // Skip tool_result (large file dumps, noise)
    }

    if (parts.length > 0) appendMessage(`[${entry.type}]: ${parts.join(" | ")}`)
  }

  let index = -1
  const consider = (line: string | null, oversized?: OversizedJsonlRecord): void => {
    index++
    if (selected !== "all" && !selected.has(index)) return
    consume(line, oversized)
  }
  forEachJsonlLine(jsonlPath, (line) => consider(line), {
    onOversized: (oversized) => consider(null, oversized),
  })

  acc.content = tail
  // Explain a no-content scan instead of defaulting it to a sub-agent: an unsupported
  // (non-Claude) envelope is named, and a sample carrying no usable Claude shape at all is
  // "no-usable-content". Mixed samples keep their valid Claude content and merely count these.
  if (acc.supported === 0 && !acc.claudeUserText) {
    acc.reason = acc.unsupported > 0 ? "unsupported-sampled-format" : "no-usable-content"
  }
  return acc
}

/** A named stand-in for a record the reader elided; its bytes never reach content. */
function oversizedPlaceholder(record: OversizedJsonlRecord | undefined): string {
  if (!record) return "[oversized record elided]"
  return `[oversized record elided: physical line ${record.physicalLine}, ${record.bytes} bytes over the ${record.limit}-byte record limit]`
}

/**
 * The known Codex rollout envelope types. Recognised ONLY to explain a
 * no-content scan as an unsupported sampled format — never decoded, and never
 * allowed to remove valid Claude content from a mixed sample.
 */
const UNSUPPORTED_SAMPLED_TYPES = new Set([
  "session_meta",
  "response_item",
  "turn_context",
  "event_msg",
  "compacted",
  "turn_aborted",
])

/** Whether a non-Claude sampled record is a recognised unsupported envelope. */
function isUnsupportedSampledFormat(entry: JsonlEntry): boolean {
  if (typeof entry.type === "string" && UNSUPPORTED_SAMPLED_TYPES.has(entry.type)) return true
  return typeof entry.payload === "object" && entry.payload !== null
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
