/**
 * Claude Session indexer
 *
 * Parses JSONL session files and populates the SQLite database.
 */

import { Database } from "bun:sqlite"
import { createHash } from "crypto"
import { Glob } from "bun"
import * as path from "path"
import * as fs from "fs"
import * as readline from "readline"
import * as os from "os"
import { spawnSync } from "node:child_process"
import {
  indexCodexTranscripts,
  validateAgReadiness,
  type CodexFailureRecord,
  type CodexCatalog,
} from "./codex-indexer.ts"
import {
  PROJECTS_DIR,
  MAX_CONTENT_SIZE,
  upsertSession,
  updateSessionStatus,
  getSession,
  insertMessage,
  insertWrite,
  upsertContent,
  getSessionByPath,
  setIndexMeta,
  getIndexMeta,
  getAllSessionEntries,
  findPlanFiles,
  findTodoFiles,
  getCachedStatement,
} from "./db"
import type { TodoItem, BeadRecord, JsonlRecord, ToolUse, ClaudeFailureRecord } from "./types"
import { formatBead, extractMarkdownTitle } from "./formatters"

export interface IndexProgress {
  filesProcessed: number
  messagesIndexed: number
  writesIndexed: number
  currentFile: string
}

// Time window for indexing - sessions older than this are skipped.
// Per Chief Review requirement 3, index window is 180 days across Claude and Codex.
export const INDEX_WINDOW_DAYS = 180
export const INDEX_WINDOW_MS = INDEX_WINDOW_DAYS * 24 * 60 * 60 * 1000

// .recall-ignore — quarantine list for the session indexer.
//
// File: ~/.claude/.recall-ignore (one entry per line, # comments allowed,
// blank lines ignored). Each entry is a glob matched against the session
// file's absolute path AND its path relative to PROJECTS_DIR. Use `**`
// for recursive globs. Files matched here are skipped by findSessionFiles
// and therefore never enter the FTS5 index, never surface in recall
// results, and never feed cross-session compounding via search hits.
//
// Quarantine is for forensic content (smoking-gun JSONLs, role-prefix
// emission captures, adversarial corpora) whose mere presence in the
// recall index pumps trigger tokens into future sessions. See
// hub/silvercode/design/ambient-context-safety.md §9 (content quarantine).
let _ignoreCache: { mtime: number; matchers: ((p: string) => boolean)[] } | null = null

export function resetIgnoreCache(): void {
  _ignoreCache = null
}

function loadRecallIgnore(): ((p: string) => boolean)[] {
  const claudeDir = process.env.CLAUDE_DIR || path.join(os.homedir(), ".claude")
  const ignorePath = path.join(claudeDir, ".recall-ignore")
  let mtime = 0
  try {
    mtime = fs.statSync(ignorePath).mtime.getTime()
  } catch {
    // silent-fallback-allow: missing .recall-ignore means an empty recall ignore list.
    if (_ignoreCache && _ignoreCache.mtime === 0) return _ignoreCache.matchers
    _ignoreCache = { mtime: 0, matchers: [] }
    return []
  }
  if (_ignoreCache && _ignoreCache.mtime === mtime) return _ignoreCache.matchers

  const lines = fs
    .readFileSync(ignorePath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))

  const matchers = lines.map((pattern) => {
    // Expand ~ to homedir for absolute-path entries.
    const expanded = pattern.startsWith("~/") ? path.join(os.homedir(), pattern.slice(2)) : pattern
    const glob = new Glob(expanded)
    return (filePath: string): boolean => {
      // Match against absolute path AND currentProjectsDir()-relative path so users
      // can write both "foo.jsonl" and full absolute paths in .recall-ignore
      if (glob.match(filePath)) return true
      const rel = path.relative(currentProjectsDir(), filePath)
      if (rel && !rel.startsWith("..") && glob.match(rel)) return true
      return false
    }
  })

  _ignoreCache = { mtime, matchers }
  return matchers
}

export function isRecallIgnored(filePath: string): boolean {
  const matchers = loadRecallIgnore()
  for (const m of matchers) if (m(filePath)) return true
  return false
}

export interface IndexOptions {
  incremental?: boolean // Only index new/updated sessions
  messagesOnly?: boolean // Skip writes table (faster)
  projectRoot?: string // Project root for indexing project sources
  full?: boolean
  force?: boolean
  path?: string
  agBin?: string
  skipCodex?: boolean
  chunkSize?: number // Max files/sessions per chunked commit (default: 25)
  chunkTimeMs?: number // Max elapsed ms before committing a chunk (default: 2000)
  onProgress?: (progress: IndexProgress) => void
}

/**
 * Manages chunked transactions around per-file savepoints (A7).
 * Batches commits every N files or T milliseconds while preserving
 * savepoint-level failure isolation.
 */
export class ChunkedTransaction {
  private inTx = false
  private count = 0
  private chunkStartMs = Date.now()

  constructor(
    private db: Database,
    private maxChunkSize: number = 25,
    private maxChunkMs: number = 2000,
  ) {}

  ensureInTx(): void {
    if (!this.inTx) {
      this.db.run("BEGIN")
      this.inTx = true
      this.count = 0
      this.chunkStartMs = Date.now()
    }
  }

  recordItem(): void {
    this.count++
    if (this.inTx && (this.count >= this.maxChunkSize || Date.now() - this.chunkStartMs >= this.maxChunkMs)) {
      this.commit()
    }
  }

  commit(): void {
    if (this.inTx) {
      this.db.run("COMMIT")
      this.inTx = false
      this.count = 0
    }
  }

  rollback(): void {
    if (this.inTx) {
      try {
        this.db.run("ROLLBACK")
      } catch {
        // ignore rollback errors
      }
      this.inTx = false
      this.count = 0
    }
  }

  isActive(): boolean {
    return this.inTx
  }
}

export function currentProjectsDir(): string {
  return process.env.CLAUDE_DIR ? path.join(process.env.CLAUDE_DIR, "projects") : PROJECTS_DIR
}

/**
 * Restricts Claude transcript discovery to valid transcript shapes (A4):
 * 1. Root sessions: <project>/<uuid>.jsonl (no subdirectories)
 * 2. Subagents: <project>/<parentSessionId>/subagents/.../agent-*.jsonl
 *
 * This excludes non-transcript files such as <project>/memory/*.jsonl
 */
export function isTranscriptShape(relativePath: string): boolean {
  const norm = relativePath.replace(/\\/g, "/")
  // Root transcript: <proj>/<name>.jsonl (exactly one slash)
  if (/^[^/]+\/[^/]+\.jsonl$/.test(norm)) {
    return true
  }
  // Subagent transcript: <proj>/<parent>/subagents/**/agent-*.jsonl
  if (/^[^/]+\/[^/]+\/subagents\/(?:.+\/)?agent-[^/]+\.jsonl$/.test(norm)) {
    return true
  }
  return false
}

export async function* findSessionFiles(): AsyncGenerator<string> {
  const pdir = currentProjectsDir()
  if (!fs.existsSync(pdir)) {
    throw new Error(`Recall session source is missing: ${pdir}`)
  }

  const glob = new Glob("**/*.jsonl")
  for await (const file of glob.scan({ cwd: pdir, absolute: true })) {
    const rel = path.relative(pdir, file)
    if (!isTranscriptShape(rel)) continue
    if (isRecallIgnored(file)) continue
    yield file
  }
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16)
}

export function projectPathFromRelative(relativePath: string): string {
  // Convert encoded path like "-Users-beorn-Code-pim-km" to "/Users/beorn/Code/pim/km"
  const first = relativePath.split(path.sep)[0] || relativePath
  return first.replace(/-/g, "/").replace(/^\//, "/")
}

export function extractTextContent(record: JsonlRecord): string | null {
  const parts: string[] = []

  // Handle user messages
  if (record.type === "user" && record.message) {
    const content = record.message.content
    if (typeof content === "string") {
      parts.push(content)
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item === "string") {
          parts.push(item)
        } else if (item && typeof item === "object" && "text" in item) {
          parts.push(String((item as { text: unknown }).text))
        }
      }
    }
  }

  // Handle assistant messages
  if (record.type === "assistant" && record.message) {
    const content = record.message.content
    if (typeof content === "string") {
      parts.push(content)
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>
          // Text blocks
          if (obj.type === "text" && typeof obj.text === "string") {
            parts.push(obj.text)
          }
          // Tool use - include the input as searchable text
          if (obj.type === "tool_use" && obj.input) {
            parts.push(JSON.stringify(obj.input))
          }
          // Thinking blocks
          if (obj.type === "thinking" && typeof obj.thinking === "string") {
            parts.push(obj.thinking)
          }
        }
      }
    }
  }

  // Handle tool results
  if (record.type === "tool_result" && record.content) {
    if (typeof record.content === "string") {
      parts.push(record.content)
    } else if (Array.isArray(record.content)) {
      for (const item of record.content) {
        if (typeof item === "string") {
          parts.push(item)
        } else if (item && typeof item === "object" && "text" in item) {
          parts.push(String((item as { text: unknown }).text))
        }
      }
    }
  }

  return parts.length > 0 ? parts.join("\n") : null
}

export function extractToolInfo(record: JsonlRecord): {
  toolName: string | null
  filePaths: string | null
} {
  let toolName: string | null = null
  const filePaths: string[] = []

  if (record.type === "assistant" && record.message?.content) {
    for (const item of record.message.content) {
      if (item && typeof item === "object" && (item as ToolUse).type === "tool_use") {
        const toolUse = item as ToolUse
        toolName = toolUse.name
        if (toolUse.input?.file_path) {
          filePaths.push(toolUse.input.file_path)
        }
      }
    }
  }

  if (record.toolName) {
    toolName = record.toolName
  }

  return {
    toolName,
    filePaths: filePaths.length > 0 ? filePaths.join(",") : null,
  }
}

export function parseSessionPath(
  relativePath: string,
  filePath?: string,
): { id: string; parentSessionId: string | null; agentId: string | null } {
  const normPath = (filePath ?? relativePath).replace(/\\/g, "/")
  const match = normPath.match(/(?:^|\/)([^/]+)\/subagents\/(?:.+\/)?([^/]+)\.jsonl$/)
  if (match && match[1] && match[2]) {
    const parent = match[1]
    const agent = match[2]
    return {
      id: `${parent}:${agent}`,
      parentSessionId: parent,
      agentId: agent,
    }
  }
  const id = path.basename(filePath ?? relativePath, ".jsonl")
  return {
    id,
    parentSessionId: null,
    agentId: null,
  }
}

export async function indexSessionFile(
  db: Database,
  filePath: string,
  options: IndexOptions = {},
  existingStats?: fs.Stats,
): Promise<{ messages: number; writes: number }> {
  const relativePath = path.relative(currentProjectsDir(), filePath)
  const projectPath = projectPathFromRelative(relativePath)
  let stats: fs.Stats
  if (existingStats) {
    stats = existingStats
  } else {
    try {
      stats = fs.statSync(filePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { messages: 0, writes: 0 }
      }
      throw err
    }
  }
  const mtime = stats.mtime.getTime()

  // Check if we can skip (incremental mode)
  if (options.incremental) {
    const existing = getSessionByPath(db, relativePath)
    if (
      existing &&
      (existing.status == null ||
        existing.status === "complete" ||
        existing.status === "stale-unreadable" ||
        existing.status === "unreadable") &&
      existing.mtime_ms != null &&
      existing.size_bytes != null &&
      existing.mtime_ms === mtime &&
      existing.size_bytes === stats.size
    ) {
      return { messages: 0, writes: 0 }
    }
  }

  const fileStream = fs.createReadStream(filePath)
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  })

  const sessionInfo = parseSessionPath(relativePath, filePath)
  const sessionId = sessionInfo.id
  const { parentSessionId, agentId } = sessionInfo
  const expectedSessionId = parentSessionId ?? sessionId
  let mismatchedRecords = 0
  let lastMismatchedSessionId: string | null = null

  let firstTimestamp: number | null = null
  let lastTimestamp: number | null = null
  let messageCount = 0
  let writeCount = 0
  const seenUuids = new Set<string>()
  const seenWriteHashes = new Set<string>()

  const touchedSessionIds = new Set<string>([sessionId])
  const spId = "sp_claude_" + Date.now() + "_" + Math.random().toString(36).slice(2)
  db.run(`SAVEPOINT ${spId}`)

  try {
    for (const sid of touchedSessionIds) {
      getCachedStatement(db, "DELETE FROM messages WHERE session_id = ?").run(sid)
      getCachedStatement(db, "DELETE FROM writes WHERE session_id = ?").run(sid)
    }

    let lineNum = 0
    for await (const line of rl) {
      lineNum++
      if (!line.trim()) continue

      let record: JsonlRecord
      try {
        record = JSON.parse(line) as JsonlRecord
      } catch (parseErr) {
        throw new Error(`Malformed JSON in Claude transcript at line ${lineNum}: ${(parseErr as Error).message}`, {
          cause: parseErr,
        })
      }

      if (record.sessionId && record.sessionId !== expectedSessionId) {
        mismatchedRecords++
        lastMismatchedSessionId = record.sessionId
      }

      // Use actual record timestamp for session date tracking;
      // fall back to Date.now() only for message insertion (not session bounds)
      const hasRecordTimestamp = !!record.timestamp
      const timestamp = record.timestamp ? new Date(record.timestamp).getTime() : Date.now()
      if (hasRecordTimestamp) {
        if (firstTimestamp === null) firstTimestamp = timestamp
        lastTimestamp = timestamp
      }

      // Skip if we've seen this UUID (incremental dedup)
      if (record.uuid) {
        if (seenUuids.has(record.uuid)) continue
        seenUuids.add(record.uuid)
      }

      // Index the message directly into SQLite
      const textContent = extractTextContent(record)
      const { toolName, filePaths } = extractToolInfo(record)

      if (textContent || toolName) {
        const msgUuid = record.uuid ? `${sessionId}:${record.uuid}` : null
        insertMessage(db, msgUuid, sessionId, record.type, textContent, toolName, filePaths, timestamp)
        messageCount++
      }

      // Also index writes for backwards compatibility directly into SQLite
      if (!options.messagesOnly && record.type === "assistant" && record.message?.content) {
        for (const item of record.message.content) {
          if (
            item &&
            typeof item === "object" &&
            (item as ToolUse).type === "tool_use" &&
            (item as ToolUse).name === "Write" &&
            (item as ToolUse).input?.file_path &&
            (item as ToolUse).input?.content
          ) {
            const toolUse = item as ToolUse
            const content = toolUse.input.content
            const filePath = toolUse.input.file_path
            if (!content || !filePath) continue
            const hash = hashContent(content)
            const uniqueKey = `${toolUse.input.file_path}:${hash}`

            // Skip exact duplicates
            if (seenWriteHashes.has(uniqueKey)) continue
            seenWriteHashes.add(uniqueKey)

            const contentSize = Buffer.byteLength(content, "utf8")

            insertWrite(
              db,
              sessionId,
              relativePath,
              toolUse.id,
              record.timestamp || new Date().toISOString(),
              filePath,
              hash,
              contentSize,
              contentSize <= MAX_CONTENT_SIZE ? content : null,
            )
            writeCount++
          }
        }
      }
    }

    if (mismatchedRecords > 0) {
      console.warn(
        `[recall] Warning: ${mismatchedRecords} record(s) in ${relativePath} had mismatched sessionId (last: "${lastMismatchedSessionId}", expected: "${expectedSessionId}"). Ignored.`,
      )
    }

    upsertSession(
      db,
      sessionId,
      projectPath,
      relativePath,
      firstTimestamp || mtime,
      lastTimestamp || mtime,
      messageCount,
      null,
      {
        status: "complete",
        sizeBytes: stats.size,
        mtimeMs: mtime,
        lastEventAtMs: lastTimestamp,
        parentSessionId,
        agentId,
      },
    )
    db.run(`RELEASE SAVEPOINT ${spId}`)
  } catch (err) {
    db.run(`ROLLBACK TO SAVEPOINT ${spId}`)
    db.run(`RELEASE SAVEPOINT ${spId}`)
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { messages: 0, writes: 0 }
    }
    throw err
  }

  return { messages: messageCount, writes: writeCount }
}

export interface IndexResult {
  files: number
  messages: number
  writes: number
  plans: number
  todos: number
  summaries: number
  firstPrompts: number
  skippedOld: number
  beads: number
  sessionMemory: number
  projectMemory: number
  docs: number
  claudeMd: number
  research: number
  codexSessions?: number
  codexMessages?: number
  codexSkipped?: number
  codexUnreadable?: number
  codexErrors?: number
  codexFailures?: CodexFailureRecord[]
  codexReasonCounts?: Record<string, number>
  claudeSkipped?: number
  claudeVanished?: number
  claudeFailures?: ClaudeFailureRecord[]
  pruned?: number
}

/**
 * Prune sessions and related data older than the cutoff time
 */
export function pruneOldSessions(
  db: Database,
  cutoffTime: number,
): { sessions: number; messages: number; writes: number } {
  // Get sessions to prune
  const oldSessions = db
    .prepare(`
    SELECT id FROM sessions WHERE updated_at < ?
  `)
    .all(cutoffTime) as { id: string }[]

  if (oldSessions.length === 0) {
    return { sessions: 0, messages: 0, writes: 0 }
  }

  const sessionIds = oldSessions.map((s) => s.id)

  // Batch delete for efficiency
  const placeholders = sessionIds.map(() => "?").join(",")

  const messagesResult = db.prepare(`DELETE FROM messages WHERE session_id IN (${placeholders})`).run(...sessionIds)
  const messagesDeleted = messagesResult.changes

  const writesResult = db.prepare(`DELETE FROM writes WHERE session_id IN (${placeholders})`).run(...sessionIds)
  const writesDeleted = writesResult.changes

  db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...sessionIds)

  // Rebuild FTS index to remove deleted data
  db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')").run()

  return {
    sessions: sessionIds.length,
    messages: messagesDeleted,
    writes: writesDeleted,
  }
}

/**
 * Prune sessions whose jsonl_path now matches a .recall-ignore entry.
 * Run on every rebuild (full or incremental) so quarantine takes effect
 * the first time the indexer runs after the ignore file is updated.
 */
export function pruneIgnoredSessions(db: Database): { sessions: number; messages: number; writes: number } {
  const allSessions = db.prepare(`SELECT id, jsonl_path FROM sessions`).all() as {
    id: string
    jsonl_path: string
  }[]

  const ignoredIds: string[] = []
  for (const s of allSessions) {
    const abs = path.isAbsolute(s.jsonl_path) ? s.jsonl_path : path.join(currentProjectsDir(), s.jsonl_path)
    if (isRecallIgnored(abs)) ignoredIds.push(s.id)
  }

  if (ignoredIds.length === 0) return { sessions: 0, messages: 0, writes: 0 }

  const placeholders = ignoredIds.map(() => "?").join(",")
  const messagesResult = db.prepare(`DELETE FROM messages WHERE session_id IN (${placeholders})`).run(...ignoredIds)
  const writesResult = db.prepare(`DELETE FROM writes WHERE session_id IN (${placeholders})`).run(...ignoredIds)
  db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ignoredIds)
  db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')").run()

  return {
    sessions: ignoredIds.length,
    messages: messagesResult.changes,
    writes: writesResult.changes,
  }
}

/**
 * Read the first line of a file in a bounded memory buffer (default 4KB).
 * Avoids reading multi-gigabyte files into memory.
 */
export function readFirstLineBounded(filePath: string, maxBytes = 4096): string | null {
  const stat = fs.statSync(filePath)
  const len = Math.min(stat.size, maxBytes)
  if (len === 0) return null
  const fd = fs.openSync(filePath, "r")
  try {
    const buf = Buffer.alloc(len)
    const bytesRead = fs.readSync(fd, buf, 0, len, 0)
    if (bytesRead === 0) return null
    const text = buf.toString("utf8", 0, bytesRead)
    const newline = text.indexOf("\n")
    return newline !== -1 ? text.slice(0, newline) : text
  } finally {
    fs.closeSync(fd)
  }
}

function recordClaudeFailure(
  db: Database,
  sessionId: string,
  filePath: string,
  errMsg: string,
  meta?: { parentSessionId?: string | null; agentId?: string | null },
  stats?: fs.Stats,
): void {
  const existing = getSession(db, sessionId)
  const now = Date.now()
  let fileStats = stats
  if (!fileStats) {
    try {
      fileStats = fs.statSync(filePath)
    } catch {
      // ignore
    }
  }
  const mtime = fileStats ? fileStats.mtime.getTime() : now
  const size = fileStats ? fileStats.size : null
  if (existing) {
    updateSessionStatus(db, sessionId, "stale-unreadable", {
      failureReason: errMsg,
      failureTime: now,
      mtimeMs: mtime,
      sizeBytes: size,
    })
  } else {
    const relativePath = path.relative(currentProjectsDir(), filePath)
    const projectPath = projectPathFromRelative(relativePath)
    upsertSession(db, sessionId, projectPath, relativePath, mtime, mtime, 0, null, {
      status: "stale-unreadable",
      failureReason: errMsg,
      failureTime: now,
      mtimeMs: mtime,
      sizeBytes: size,
      parentSessionId: meta?.parentSessionId,
      agentId: meta?.agentId,
    })
  }
}

export async function rebuildIndex(db: Database, options: IndexOptions = {}): Promise<IndexResult> {
  const startTime = Date.now()
  const cutoffTime = options.full ? undefined : Date.now() - INDEX_WINDOW_MS

  if (options.force && !options.path) {
    throw new Error("--force is only permitted when an explicit --path is specified")
  }

  // Commit invalidation before any corpus write. A failure or killed process
  // must not leave the prior success timestamp over partially updated data.
  if (!options.path) {
    setIndexMeta(db, "last_rebuild", "")
  }

  if (options.projectRoot && !fs.statSync(options.projectRoot).isDirectory()) {
    throw new Error(`Recall project source is not a directory: ${options.projectRoot}`)
  }

  const seenSessionIds = new Set<string>()

  let isClaudeTarget = false
  if (options.path) {
    const absPath = path.resolve(options.path)
    if (!fs.existsSync(absPath)) {
      throw new Error(`Specified path does not exist: ${absPath}`)
    }
    if (absPath.startsWith(path.resolve(currentProjectsDir()))) {
      isClaudeTarget = true
    } else {
      try {
        const firstLine = readFirstLineBounded(absPath, 4096)
        if (firstLine) {
          const parsed = JSON.parse(firstLine) as { type?: unknown }
          if (parsed.type === "user" || parsed.type === "assistant") {
            isClaudeTarget = true
          }
        }
      } catch (err) {
        if (err instanceof SyntaxError) {
          // not JSON in first line -> not a Claude transcript
        } else {
          const sessionInfo = parseSessionPath(path.relative(currentProjectsDir(), absPath), absPath)
          const baseSessionId = sessionInfo.id
          const existing = getSession(db, baseSessionId)
          if (existing) {
            updateSessionStatus(db, baseSessionId, "stale-unreadable", {
              failureReason: (err as Error).message,
              failureTime: Date.now(),
            })
            seenSessionIds.add(baseSessionId)
            isClaudeTarget = true
          } else {
            throw new Error(`Failed to read path ${absPath}: ${(err as Error).message}`, { cause: err })
          }
        }
      }
    }
  }

  // Pre-flight ag binary and schema readiness before any index modification (A3: reuse catalog)
  let preloadedCatalog: CodexCatalog | undefined
  if (!options.skipCodex && process.env.RECALL_SKIP_CODEX !== "1" && (!options.path || !isClaudeTarget)) {
    preloadedCatalog = await validateAgReadiness(options.agBin)
  }

  // Performance pragmas for index runs (A7)
  db.run("PRAGMA synchronous = NORMAL")
  db.run("PRAGMA cache_size = -64000")

  let totalFiles = 0
  let totalMessages = 0
  let totalWrites = 0
  let totalPlans = 0
  let totalTodos = 0
  let totalSummaries = 0
  let totalFirstPrompts = 0
  let skippedOld = 0
  let claudeSkipped = 0
  let claudeVanished = 0
  let prunedCount = 0
  const claudeFailures: ClaudeFailureRecord[] = []

  // Index Claude session files
  if (!options.path) {
    const existingSessionMap = new Map<
      string,
      { status: string | null; mtime_ms: number | null; size_bytes: number | null }
    >()
    if (options.incremental) {
      const rows = db
        .prepare("SELECT jsonl_path, status, mtime_ms, size_bytes FROM sessions WHERE jsonl_path IS NOT NULL")
        .all() as Array<{
        jsonl_path: string
        status: string | null
        mtime_ms: number | null
        size_bytes: number | null
      }>
      for (const r of rows) {
        existingSessionMap.set(r.jsonl_path, r)
      }
    }

    const chunkTx = new ChunkedTransaction(db, options.chunkSize ?? 25, options.chunkTimeMs ?? 2000)

    try {
      for await (const sessionFile of findSessionFiles()) {
        // Skip sessions older than 180 days
        let stats: fs.Stats
        try {
          stats = fs.statSync(sessionFile)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            claudeVanished++
            continue
          }
          throw err
        }
        if (cutoffTime !== undefined && stats.mtime.getTime() < cutoffTime) {
          skippedOld++
          continue
        }

        totalFiles++
        const relativePath = path.relative(currentProjectsDir(), sessionFile)
        const sessionInfo = parseSessionPath(relativePath, sessionFile)
        seenSessionIds.add(sessionInfo.id)

        if (options.incremental) {
          const existing = existingSessionMap.get(relativePath)
          if (
            existing &&
            (existing.status == null ||
              existing.status === "complete" ||
              existing.status === "stale-unreadable" ||
              existing.status === "unreadable") &&
            existing.mtime_ms != null &&
            existing.size_bytes != null &&
            existing.mtime_ms === stats.mtime.getTime() &&
            existing.size_bytes === stats.size
          ) {
            claudeSkipped++
            continue
          }
        }

        options.onProgress?.({
          filesProcessed: totalFiles,
          messagesIndexed: totalMessages,
          writesIndexed: totalWrites,
          currentFile: relativePath,
        })

        chunkTx.ensureInTx()
        try {
          const { messages, writes } = await indexSessionFile(db, sessionFile, options, stats)
          totalMessages += messages
          totalWrites += writes
          chunkTx.recordItem()
        } catch (err) {
          const errMsg = (err as Error).message || String(err)
          recordClaudeFailure(
            db,
            sessionInfo.id,
            sessionFile,
            errMsg,
            {
              parentSessionId: sessionInfo.parentSessionId,
              agentId: sessionInfo.agentId,
            },
            stats,
          )
          seenSessionIds.add(sessionInfo.id)
          claudeFailures.push({
            id: sessionInfo.id,
            file: relativePath,
            reason: errMsg,
          })
          chunkTx.recordItem()
        }
      }
    } finally {
      chunkTx.commit()
    }
  } else if (isClaudeTarget) {
    totalFiles++
    const relativePath = path.relative(currentProjectsDir(), options.path)
    const sessionInfo = parseSessionPath(relativePath, options.path)
    seenSessionIds.add(sessionInfo.id)
    options.onProgress?.({
      filesProcessed: totalFiles,
      messagesIndexed: totalMessages,
      writesIndexed: totalWrites,
      currentFile: relativePath,
    })

    try {
      const { messages, writes } = await indexSessionFile(db, options.path, options)
      totalMessages += messages
      totalWrites += writes
    } catch (err) {
      const errMsg = (err as Error).message || String(err)
      recordClaudeFailure(db, sessionInfo.id, options.path, errMsg, {
        parentSessionId: sessionInfo.parentSessionId,
        agentId: sessionInfo.agentId,
      })
      seenSessionIds.add(sessionInfo.id)
      claudeFailures.push({
        id: sessionInfo.id,
        file: relativePath,
        reason: errMsg,
      })
    }
  }

  // Index Codex transcripts via ag transcript export
  let codexSessions = 0
  let codexMessages = 0
  let codexSkipped = 0
  let codexUnreadable = 0
  let codexErrors = 0
  let codexFailures: CodexFailureRecord[] = []
  let codexReasonCounts: Record<string, number> = {}

  if (!options.skipCodex && process.env.RECALL_SKIP_CODEX !== "1" && (!options.path || !isClaudeTarget)) {
    const codexResult = await indexCodexTranscripts(db, {
      incremental: options.incremental,
      full: options.full,
      force: options.force,
      path: options.path,
      projectRoot: options.projectRoot,
      agBin: options.agBin,
      catalog: preloadedCatalog,
      cutoffTime: options.full ? undefined : cutoffTime,
      onProgress: (p) => {
        options.onProgress?.({
          filesProcessed: totalFiles + p.sessionsProcessed,
          messagesIndexed: totalMessages + p.messagesIndexed,
          writesIndexed: totalWrites,
          currentFile: p.currentSession ?? "",
        })
      },
    })
    codexSessions = codexResult.sessions
    codexMessages = codexResult.rows
    codexSkipped = codexResult.skipped
    codexUnreadable = codexResult.unreadable
    codexErrors = codexResult.errors
    codexFailures = codexResult.failures
    codexReasonCounts = codexResult.reasonCounts
    totalFiles += codexSessions
    totalMessages += codexMessages
    if (codexResult.indexedSessionIds) {
      for (const sid of codexResult.indexedSessionIds) {
        seenSessionIds.add(sid)
      }
    }
    if (codexResult.retainedSessionIds) {
      for (const sid of codexResult.retainedSessionIds) {
        seenSessionIds.add(sid)
      }
    }
  }

  // Index session summaries, plans, todos, and project sources only during corpus rebuilds
  let projectSourceResult = {
    beads: 0,
    sessionMemory: 0,
    projectMemory: 0,
    docs: 0,
    claudeMd: 0,
    research: 0,
  }

  if (!options.path) {
    const sessionEntries = getAllSessionEntries()
    const metaTx = new ChunkedTransaction(db, 50, 2000)
    try {
      for (const entry of sessionEntries) {
        if (entry.summary) {
          metaTx.ensureInTx()
          upsertContent(
            db,
            "summary",
            entry.sessionId,
            entry.projectPath || null,
            entry.customTitle || null,
            entry.summary,
            entry.modified ? new Date(entry.modified).getTime() : Date.now(),
          )
          totalSummaries++
          metaTx.recordItem()
        }
      }

      // Index session first prompts (enables topic-level recall)
      for (const entry of sessionEntries) {
        if (entry.firstPrompt) {
          metaTx.ensureInTx()
          upsertContent(
            db,
            "first_prompt",
            entry.sessionId,
            entry.projectPath || null,
            entry.customTitle || null,
            entry.firstPrompt,
            entry.created ? new Date(entry.created).getTime() : Date.now(),
          )
          totalFirstPrompts++
          metaTx.recordItem()
        }
      }

      // Index plan files
      for (const planFile of findPlanFiles()) {
        try {
          const stats = fs.statSync(planFile)
          const content = fs.readFileSync(planFile, "utf8")
          const filename = path.basename(planFile, ".md")

          // Extract title from first heading or filename
          const titleMatch = content.match(/^#\s+(.+)$/m)
          const title = titleMatch?.[1] ?? filename

          metaTx.ensureInTx()
          upsertContent(
            db,
            "plan",
            filename,
            null, // Plans aren't project-specific
            title,
            content,
            stats.mtime.getTime(),
          )
          totalPlans++
          metaTx.recordItem()
        } catch (error) {
          throw new Error(`Recall plan indexing failed: ${planFile}`, { cause: error })
        }
      }

      // Index todo files
      for (const todoFile of findTodoFiles()) {
        try {
          const stats = fs.statSync(todoFile)
          const content = fs.readFileSync(todoFile, "utf8")
          const todos = JSON.parse(content) as TodoItem[]
          const filename = path.basename(todoFile, ".json")

          // Combine all todos into searchable content
          const todoContent = todos
            .map((t) => `[${t.status}] ${t.content}${t.activeForm ? ` (${t.activeForm})` : ""}`)
            .join("\n")

          if (todoContent.trim()) {
            metaTx.ensureInTx()
            upsertContent(
              db,
              "todo",
              filename,
              null,
              `Todo list (${todos.length} items)`,
              todoContent,
              stats.mtime.getTime(),
            )
            totalTodos++
            metaTx.recordItem()
          }
        } catch (error) {
          throw new Error(`Recall todo indexing failed: ${todoFile}`, { cause: error })
        }
      }
    } finally {
      metaTx.commit()
    }

    // Index project sources if projectRoot is provided
    if (options.projectRoot) {
      const projectPath = options.projectRoot
      projectSourceResult = indexProjectSources(db, projectPath)
    }

    // Prune vanished sessions safely (A8):
    // A session row whose file is gone is marked 'stale-missing' on first miss.
    // If it is missed on a second consecutive run (already 'stale-missing'), its row, messages, and writes are pruned.
    prunedCount = 0
    const allDbSessions = db
      .prepare("SELECT id, jsonl_path, status FROM sessions WHERE jsonl_path IS NOT NULL")
      .all() as Array<{ id: string; jsonl_path: string; status: string | null }>

    for (const s of allDbSessions) {
      if (seenSessionIds.has(s.id)) continue
      if (s.id.startsWith("codex:") && (options.skipCodex || process.env.RECALL_SKIP_CODEX === "1")) {
        continue
      }

      const fullPath = path.isAbsolute(s.jsonl_path) ? s.jsonl_path : path.join(currentProjectsDir(), s.jsonl_path)
      if (!fs.existsSync(fullPath)) {
        if (s.status === "stale-missing") {
          // Second consecutive miss: prune
          db.prepare("DELETE FROM messages WHERE session_id = ?").run(s.id)
          db.prepare("DELETE FROM writes WHERE session_id = ?").run(s.id)
          db.prepare("DELETE FROM sessions WHERE id = ?").run(s.id)
          prunedCount++
        } else {
          // First miss: mark stale-missing (stays searchable)
          db.prepare("UPDATE sessions SET status = 'stale-missing', failure_time = ? WHERE id = ?").run(
            Date.now(),
            s.id,
          )
        }
      }
    }

    if (cutoffTime !== undefined) {
      pruneOldSessions(db, cutoffTime)
    }
    pruneIgnoredSessions(db)

    // Store metadata
    const duration = Date.now() - startTime
    setIndexMeta(db, "rebuild_duration_ms", String(duration))
    setIndexMeta(db, "total_files", String(totalFiles))
    setIndexMeta(db, "total_messages", String(totalMessages))
    setIndexMeta(db, "total_plans", String(totalPlans))
    setIndexMeta(db, "total_todos", String(totalTodos))
    setIndexMeta(db, "total_summaries", String(totalSummaries))
    setIndexMeta(db, "total_first_prompts", String(totalFirstPrompts))
    setIndexMeta(db, "total_beads", String(projectSourceResult.beads))
    setIndexMeta(db, "total_session_memory", String(projectSourceResult.sessionMemory))
    setIndexMeta(db, "total_project_memory", String(projectSourceResult.projectMemory))
    setIndexMeta(db, "total_docs", String(projectSourceResult.docs))
    setIndexMeta(db, "total_claude_md", String(projectSourceResult.claudeMd))
    setIndexMeta(db, "total_research", String(projectSourceResult.research))
    // Publish success last, including after completion metadata writes.
    setIndexMeta(db, "last_rebuild", new Date().toISOString())
  }

  setIndexMeta(db, "last_codex_failures", JSON.stringify(codexFailures))
  setIndexMeta(db, "last_codex_reason_counts", JSON.stringify(codexReasonCounts))

  // Advisory optimize at end of indexing run (A7)
  try {
    db.run("PRAGMA optimize")
  } catch {
    // Ignore optimize errors
  }

  return {
    files: totalFiles,
    messages: totalMessages,
    writes: totalWrites,
    plans: totalPlans,
    todos: totalTodos,
    summaries: totalSummaries,
    firstPrompts: totalFirstPrompts,
    skippedOld,
    codexSessions,
    codexMessages,
    codexSkipped,
    codexUnreadable,
    codexErrors,
    codexFailures,
    codexReasonCounts,
    claudeSkipped,
    claudeVanished,
    claudeFailures,
    pruned: prunedCount,
    ...projectSourceResult,
  }
}

// ============================================================================
// Project source indexing
// ============================================================================

/**
 * Check if a source file has changed since last indexing.
 * Uses index_meta with a key like "mtime:<type>:<sourceId>".
 */
function hasChanged(db: Database, metaKey: string, currentMtime: number): boolean {
  const stored = getIndexMeta(db, metaKey)
  return !stored || parseInt(stored, 10) < currentMtime
}

function recordMtime(db: Database, metaKey: string, mtime: number): void {
  setIndexMeta(db, metaKey, String(mtime))
}

/**
 * Encode a project path the way Claude Code does: /Users/beorn/Code/pim/km → -Users-beorn-Code-pim-km
 */
function encodeProjectPath(projectRoot: string): string {
  return projectRoot.replace(/\//g, "-")
}

/**
 * Index beads from .beads/issues.jsonl
 */
function indexBeads(db: Database, projectRoot: string, projectPath: string): number {
  const issuesPath = path.join(projectRoot, ".beads", "issues.jsonl")
  if (!fs.existsSync(issuesPath)) return 0

  const stats = fs.statSync(issuesPath)
  const metaKey = `mtime:beads:${projectPath}`
  if (!hasChanged(db, metaKey, stats.mtime.getTime())) return 0

  const content = fs.readFileSync(issuesPath, "utf8")
  const lines = content.split("\n").filter(Boolean)
  let count = 0

  for (const line of lines) {
    try {
      const bead = JSON.parse(line) as BeadRecord
      const { title, content: beadContent } = formatBead(bead)
      const timestamp = bead.updated_at
        ? new Date(bead.updated_at).getTime()
        : bead.created_at
          ? new Date(bead.created_at).getTime()
          : Date.now()

      upsertContent(db, "bead", bead.id, projectPath, title, beadContent, timestamp)
      count++
    } catch {
      // Skip malformed lines
    }
  }

  recordMtime(db, metaKey, stats.mtime.getTime())
  return count
}

/**
 * Index session memory files from ~/.claude/projects/<encoded>/memory/sessions/*.md
 * (Falls back to <projectRoot>/memory/sessions/ for legacy files)
 */
function indexSessionMemory(db: Database, projectRoot: string, projectPath: string): number {
  const encodedPath = encodeProjectPath(projectRoot)
  const primaryDir = path.join(os.homedir(), ".claude", "projects", encodedPath, "memory", "sessions")
  const legacyDir = path.join(projectRoot, "memory", "sessions")
  const memoryDir = fs.existsSync(primaryDir) ? primaryDir : legacyDir
  if (!fs.existsSync(memoryDir)) return 0

  let count = 0
  for (const entry of fs.readdirSync(memoryDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue

    const filePath = path.join(memoryDir, entry.name)
    const stats = fs.statSync(filePath)
    const sourceId = `session-memory:${entry.name}`
    const metaKey = `mtime:session_memory:${sourceId}`

    if (!hasChanged(db, metaKey, stats.mtime.getTime())) continue

    try {
      const content = fs.readFileSync(filePath, "utf8")
      if (!content.trim()) continue

      const title = `Session memory: ${entry.name.replace(/\.md$/, "")}`
      upsertContent(db, "session_memory", sourceId, projectPath, title, content, stats.mtime.getTime())
      recordMtime(db, metaKey, stats.mtime.getTime())
      count++
    } catch {
      // Skip unreadable files
    }
  }
  return count
}

/**
 * Index project memory files from ~/.claude/projects/<encoded>/memory/*.md
 */
function indexProjectMemory(db: Database, projectRoot: string, projectPath: string): number {
  const encodedPath = encodeProjectPath(projectRoot)
  const memoryDir = path.join(os.homedir(), ".claude", "projects", encodedPath, "memory")
  if (!fs.existsSync(memoryDir)) return 0

  let count = 0
  for (const entry of fs.readdirSync(memoryDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue

    const filePath = path.join(memoryDir, entry.name)
    const stats = fs.statSync(filePath)
    const sourceId = `project-memory:${entry.name}`
    const metaKey = `mtime:project_memory:${sourceId}`

    if (!hasChanged(db, metaKey, stats.mtime.getTime())) continue

    try {
      const content = fs.readFileSync(filePath, "utf8")
      if (!content.trim()) continue

      const title = extractMarkdownTitle(content, `Project memory: ${entry.name.replace(/\.md$/, "")}`)
      upsertContent(db, "project_memory", sourceId, projectPath, title, content, stats.mtime.getTime())
      recordMtime(db, metaKey, stats.mtime.getTime())
      count++
    } catch {
      // Skip unreadable files
    }
  }
  return count
}

interface ProjectDocumentationRoot {
  readonly root: string
  readonly sourcePrefix: "doc:" | "doc:container:"
  readonly displayPrefix: "" | "container:"
}

function projectDocumentationSourceId(
  sourcePrefix: ProjectDocumentationRoot["sourcePrefix"],
  projectPath: string,
  relativePath: string,
): string {
  const projectScope = createHash("sha256").update(path.resolve(projectPath)).digest("hex")
  return `${sourcePrefix}${projectScope}:${relativePath}`
}

function gitEnvironmentWithoutRootOverrides(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  return env
}

function gitAbsolutePath(directory: string, args: readonly string[]): string | null {
  const result = spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    env: gitEnvironmentWithoutRootOverrides(),
  })
  if (result.status !== 0) return null
  const output = (result.stdout ?? "").trim()
  return output === "" ? null : output
}

/**
 * Discover documentation owned by this project and by an enclosing container
 * repository. The latter is the general nested-repository shape used by hh:
 * a code Git worktree lives below a separate Git repository that owns agent
 * documentation. Requiring both Git identities prevents an arbitrary ancestor
 * `docs/` directory from entering Recall.
 */
function projectDocumentationRoots(projectRoot: string): readonly ProjectDocumentationRoot[] {
  const roots: ProjectDocumentationRoot[] = []
  const projectDocs = path.join(projectRoot, "docs")
  if (fs.existsSync(projectDocs)) roots.push({ root: projectDocs, sourcePrefix: "doc:", displayPrefix: "" })

  const commonDir = gitAbsolutePath(projectRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  if (commonDir === null) {
    if (fs.existsSync(path.join(projectRoot, ".git"))) {
      throw new Error(`recall docs index: cannot resolve Git common directory for project ${projectRoot}`)
    }
    return roots
  }
  const codeMainRoot = path.dirname(commonDir)
  const containerRoot = path.dirname(codeMainRoot)
  if (containerRoot === codeMainRoot) return roots
  const containerGitRoot = gitAbsolutePath(containerRoot, ["rev-parse", "--show-toplevel"])
  const containerDocs = path.join(containerRoot, "docs")
  if (fs.existsSync(containerDocs) && fs.existsSync(path.join(containerRoot, ".git")) && containerGitRoot === null) {
    throw new Error(`recall docs index: cannot resolve enclosing container Git root at ${containerRoot}`)
  }
  if (
    containerGitRoot !== null &&
    path.resolve(containerGitRoot) === path.resolve(containerRoot) &&
    fs.existsSync(containerDocs) &&
    path.resolve(containerDocs) !== path.resolve(projectDocs)
  ) {
    roots.push({ root: containerDocs, sourcePrefix: "doc:container:", displayPrefix: "container:" })
  }
  return roots
}

/** Index code-owned and enclosing-container documentation without source-id collisions. */
function indexDocs(db: Database, projectRoot: string, projectPath: string): number {
  let count = 0
  const activeSourceIds = new Set<string>()

  function indexDir(source: ProjectDocumentationRoot, dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        indexDir(source, path.join(dir, entry.name))
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue

      const filePath = path.join(dir, entry.name)
      const relPath = `docs/${path.relative(source.root, filePath)}`
      const stats = fs.statSync(filePath)
      // The content table's identity is globally unique on
      // (content_type, source_id), while project_path is only searchable
      // metadata. Scope every doc identity (and therefore its mtime key) to
      // the nested code project so two worktrees/projects that share one
      // container docs tree cannot steal each other's rows.
      const sourceId = projectDocumentationSourceId(source.sourcePrefix, projectPath, relPath)
      const metaKey = `mtime:doc:${sourceId}`
      activeSourceIds.add(sourceId)

      if (!hasChanged(db, metaKey, stats.mtime.getTime())) continue

      try {
        const content = fs.readFileSync(filePath, "utf8")
        if (!content.trim()) continue

        const title = extractMarkdownTitle(content, `${source.displayPrefix}${relPath}`)
        upsertContent(db, "doc", sourceId, projectPath, title, content, stats.mtime.getTime())
        recordMtime(db, metaKey, stats.mtime.getTime())
        count++
      } catch (error) {
        throw new Error(`recall docs index: cannot read or index ${filePath}`, { cause: error })
      }
    }
  }

  for (const source of projectDocumentationRoots(projectRoot)) indexDir(source, source.root)

  // Incremental indexing used to leave deleted/moved docs searchable forever.
  // Reconcile only this project's doc rows after every successful complete walk.
  const existing = db
    .query("SELECT source_id FROM content WHERE content_type = 'doc' AND project_path = ?")
    .all(projectPath) as Array<{ source_id: string }>
  const remove = db.prepare("DELETE FROM content WHERE content_type = 'doc' AND source_id = ? AND project_path = ?")
  for (const { source_id: sourceId } of existing) {
    if (!activeSourceIds.has(sourceId)) remove.run(sourceId, projectPath)
  }
  return count
}

/**
 * Index CLAUDE.md files (root + vendor/*)
 */
function indexClaudeMd(db: Database, projectRoot: string, projectPath: string): number {
  let count = 0

  const candidates: string[] = [path.join(projectRoot, "CLAUDE.md")]

  // Add vendor/*/CLAUDE.md
  const vendorDir = path.join(projectRoot, "vendor")
  if (fs.existsSync(vendorDir)) {
    for (const entry of fs.readdirSync(vendorDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(path.join(vendorDir, entry.name, "CLAUDE.md"))
      }
    }
  }

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue

    const relPath = path.relative(projectRoot, filePath)
    const stats = fs.statSync(filePath)
    const sourceId = `claude-md:${relPath}`
    const metaKey = `mtime:claude_md:${sourceId}`

    if (!hasChanged(db, metaKey, stats.mtime.getTime())) continue

    try {
      const content = fs.readFileSync(filePath, "utf8")
      if (!content.trim()) continue

      const title = extractMarkdownTitle(content, relPath)
      upsertContent(db, "claude_md", sourceId, projectPath, title, content, stats.mtime.getTime())
      recordMtime(db, metaKey, stats.mtime.getTime())
      count++
    } catch {
      // Skip unreadable files
    }
  }
  return count
}

/**
 * Index LLM research outputs from ~/.claude/projects/<encoded>/memory/research/*.md
 */
function indexResearch(db: Database, projectRoot: string, projectPath: string): number {
  const encodedPath = encodeProjectPath(projectRoot)
  const researchDir = path.join(os.homedir(), ".claude", "projects", encodedPath, "memory", "research")
  if (!fs.existsSync(researchDir)) return 0

  let count = 0
  for (const entry of fs.readdirSync(researchDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue

    const filePath = path.join(researchDir, entry.name)
    const stats = fs.statSync(filePath)
    const sourceId = `llm-research:${entry.name}`
    const metaKey = `mtime:llm_research:${sourceId}`

    if (!hasChanged(db, metaKey, stats.mtime.getTime())) continue

    try {
      const content = fs.readFileSync(filePath, "utf8")
      if (!content.trim()) continue

      const title = extractMarkdownTitle(content, `LLM research: ${entry.name.replace(/\.md$/, "")}`)
      upsertContent(db, "llm_research", sourceId, projectPath, title, content, stats.mtime.getTime())
      recordMtime(db, metaKey, stats.mtime.getTime())
      count++
    } catch {
      // Skip unreadable files
    }
  }
  return count
}

/**
 * Index all project sources (beads, memory, docs, CLAUDE.md).
 * Uses mtime checks for incremental updates — fast when nothing changed.
 */
export function indexProjectSources(
  db: Database,
  projectRoot: string,
): {
  beads: number
  sessionMemory: number
  projectMemory: number
  docs: number
  claudeMd: number
  research: number
} {
  const projectPath = projectRoot

  return {
    beads: indexBeads(db, projectRoot, projectPath),
    sessionMemory: indexSessionMemory(db, projectRoot, projectPath),
    projectMemory: indexProjectMemory(db, projectRoot, projectPath),
    docs: indexDocs(db, projectRoot, projectPath),
    claudeMd: indexClaudeMd(db, projectRoot, projectPath),
    research: indexResearch(db, projectRoot, projectPath),
  }
}
