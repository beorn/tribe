/**
 * Session list, show, and index commands.
 */

import { assertSingleStatement } from "@bearly/sqlite"
import * as path from "path"
import * as fs from "fs"
import * as readline from "readline"
import { getDb, closeDb, PROJECTS_DIR, getAllSessionTitles, getSessionTitle, getSession } from "../history/db"
import { rebuildIndex, findSessionFiles } from "../history/indexer"
import type { JsonlRecord } from "../history/types"
import { THIRTY_DAYS_MS, formatBytes, displayProjectPath, matchProjectGlob } from "./format"
import { findSessionTranscriptById } from "./session-discovery"
import * as os from "os"
import { acquireIndexWriter, IndexWriterBusyError } from "../history/db.ts"

// ============================================================================
// Index
// ============================================================================

/** Index writer already active: the scheduled index tick has nothing to do. */
export const RECALL_INDEX_BUSY_EXIT = 4
/** The incremental share-cap prune was refused: report the incomplete provenance (25462). */
export const RECALL_INDEX_PRUNE_REFUSED_EXIT = 5

export async function cmdIndex(opts: {
  incremental?: boolean
  projectRoot?: string
  full?: boolean
  allowLargePrune?: boolean
  force?: boolean
  path?: string
  migrate?: boolean
}): Promise<void> {
  const db = getDb({ allowMigration: opts.migrate })
  if (opts.migrate && !opts.incremental && !opts.full && !opts.path) {
    console.log("Database schema migration complete.")
    closeDb()
    return
  }
  try {
    using _lock = acquireIndexWriter(db)

    console.log(opts.incremental ? "Updating session index..." : "Building session index...")
    console.log("(indexing sessions from the last 180 days)\n")

    let lastProgressUpdate = 0
    const result = await rebuildIndex(db, {
      incremental: opts.incremental,
      projectRoot: opts.projectRoot,
      full: opts.full,
      allowLargePrune: opts.allowLargePrune,
      force: opts.force,
      path: opts.path,
      onProgress: (progress) => {
        if (progress.filesProcessed - lastProgressUpdate >= 50) {
          lastProgressUpdate = progress.filesProcessed
          process.stdout.write(`\r${progress.filesProcessed} files, ${progress.messagesIndexed} messages...`)
        }
      },
    })
    process.stdout.write("\r" + " ".repeat(60) + "\r")

    console.log(`\n\n\u2713 Indexed content:`)
    console.log(`  ${result.messages.toLocaleString()} messages from ${result.files} session files`)
    if (result.codexSessions !== undefined && result.codexSessions > 0) {
      console.log(
        `  ${result.codexMessages?.toLocaleString()} messages from ${result.codexSessions} provider transcripts`,
      )
    }
    if (result.codexSkipped !== undefined && result.codexSkipped > 0) {
      console.log(`  (skipped ${result.codexSkipped} unchanged provider transcripts)`)
    }
    if (result.codexUnreadable !== undefined && result.codexUnreadable > 0) {
      console.log(`  (${result.codexUnreadable} unreadable provider transcripts)`)
    }
    if (result.codexReasonCounts && Object.keys(result.codexReasonCounts).length > 0) {
      const breakdown = Object.entries(result.codexReasonCounts)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ")
      console.log(`  (Codex wire status: ${breakdown})`)
    }
    if (result.codexFailures && result.codexFailures.length > 0) {
      console.log(`  (${result.codexFailures.length} provider transcript issues):`)
      for (const f of result.codexFailures.slice(0, 5)) {
        const pathPart = f.path ? ` [${f.path}]` : ""
        console.log(`    - ${f.kind}: ${f.reason}${pathPart}`)
      }
      if (result.codexFailures.length > 5) {
        console.log(`    ... and ${result.codexFailures.length - 5} more`)
      }
    }
    if (result.writes > 0) {
      console.log(`  ${result.writes.toLocaleString()} file writes`)
    }
    if (result.beads > 0) {
      console.log(`  ${result.beads.toLocaleString()} beads (issues)`)
    }
    if (result.sessionMemory > 0) {
      console.log(`  ${result.sessionMemory.toLocaleString()} session memory files`)
    }
    if (result.projectMemory > 0) {
      console.log(`  ${result.projectMemory.toLocaleString()} project memory files`)
    }
    if (result.docs > 0) {
      console.log(`  ${result.docs.toLocaleString()} documentation files`)
    }
    if (result.claudeMd > 0) {
      console.log(`  ${result.claudeMd.toLocaleString()} CLAUDE.md files`)
    }
    if (result.skippedOld > 0) {
      console.log(`  (skipped ${result.skippedOld} sessions older than 180 days)`)
    }
    if (result.claudeSkipped !== undefined && result.claudeSkipped > 0) {
      console.log(`  (skipped ${result.claudeSkipped} unchanged Claude sessions)`)
    }
    if (result.claudeVanished !== undefined && result.claudeVanished > 0) {
      console.log(`  (skipped ${result.claudeVanished} vanished files)`)
    }
    if (result.claudeFailures && result.claudeFailures.length > 0) {
      console.log(`  (${result.claudeFailures.length} Claude transcript issues):`)
      for (const f of result.claudeFailures.slice(0, 5)) {
        console.log(`    - ${f.file}: ${f.reason}`)
      }
      if (result.claudeFailures.length > 5) {
        console.log(`    ... and ${result.claudeFailures.length - 5} more`)
      }
    }

    // 25462: a refused incremental share-cap prune stays a non-zero REPORT (never a failure)
    // so the unattended recall-index service still sees the incomplete provenance.
    // 27458 (@cto 842ca9df): every other outcome of a COMPLETED index — one that committed,
    // even with ledgered skips — exits 0. Those skips are already a durable ledger (the
    // counts and per-file lines printed above, plus the persisted failed-session status),
    // so the exit code stops carrying the provenance and a timer whose only signal was
    // "skips fired" can no longer read as a fire with no PASS. The busy lock
    // (RECALL_INDEX_BUSY_EXIT) below still reports non-zero, because the index did not run.
    process.exitCode = result.pruneRefused !== undefined ? RECALL_INDEX_PRUNE_REFUSED_EXIT : 0
  } catch (error) {
    if (error instanceof IndexWriterBusyError) {
      console.error(error.message)
      process.exitCode = RECALL_INDEX_BUSY_EXIT
      return
    }
    throw error
  } finally {
    closeDb()
  }
}

// ============================================================================
// List sessions
// ============================================================================

export async function cmdSessions(id?: string, opts?: { project?: string }): Promise<void> {
  if (id) {
    await showSession(id)
    return
  }

  const projectFilter = opts?.project
  console.log("Scanning sessions...\n")

  interface SessionInfo {
    file: string
    sessionId: string
    project: string
    size: number
    mtime: Date
  }

  const sessions: SessionInfo[] = []

  for await (const sessionFile of findSessionFiles()) {
    const relativePath = path.relative(PROJECTS_DIR, sessionFile)
    const project = relativePath.split(path.sep)[0] || ""

    if (projectFilter) {
      if (projectFilter.includes("*")) {
        if (!matchProjectGlob(project, projectFilter)) continue
      } else if (!project.toLowerCase().includes(projectFilter.toLowerCase())) {
        continue
      }
    }

    const stats = fs.statSync(sessionFile)
    sessions.push({
      file: relativePath,
      sessionId: path.basename(sessionFile, ".jsonl"),
      project,
      size: stats.size,
      mtime: stats.mtime,
    })
  }

  sessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

  const cutoffTime = Date.now() - THIRTY_DAYS_MS
  const recentSessions = sessions.filter((s) => s.mtime.getTime() >= cutoffTime)
  const olderSessions = sessions.filter((s) => s.mtime.getTime() < cutoffTime)

  const sessionTitles = getAllSessionTitles()

  if (recentSessions.length === 0) {
    console.log("No sessions in the last 30 days")
  } else {
    const maxNameLen = Math.min(
      40,
      Math.max(
        ...recentSessions.map((s) => {
          const title = sessionTitles.get(s.sessionId)
          return (title || displayProjectPath(s.project)).length
        }),
      ),
    )

    for (const s of recentSessions) {
      const title = sessionTitles.get(s.sessionId)
      const displayProject = displayProjectPath(s.project)
      const date = s.mtime.toLocaleDateString() + " " + s.mtime.toLocaleTimeString()
      const size = formatBytes(s.size).padStart(8)
      const nameDisplay = (title || displayProject).slice(0, 40).padEnd(maxNameLen)
      console.log(`${nameDisplay}  ${s.sessionId}  ${size}  ${date}`)
    }
  }

  const recentTotalSize = recentSessions.reduce((sum, s) => sum + s.size, 0)
  console.log(`Showing ${recentSessions.length} sessions (${formatBytes(recentTotalSize)}) from the last 30 days`)

  if (olderSessions.length > 0) {
    const olderTotalSize = olderSessions.reduce((sum, s) => sum + s.size, 0)
    console.log(`\nNot shown: ${olderSessions.length} sessions (${formatBytes(olderTotalSize)}) older than 30 days`)
  }
}

// ============================================================================
// Show session details
// ============================================================================

async function showSession(sessionIdOrFile: string): Promise<void> {
  const bareTarget = sessionIdOrFile.replace(/^(codex|grok|agy|claude):/, "")
  let sessionFile: string | undefined
  let discoveredMeta: { sessionId: string; format: "claude" | "codex"; cwd: string | null } | undefined

  for await (const file of findSessionFiles()) {
    const basename = path.basename(file, ".jsonl")
    if (basename.startsWith(bareTarget) || file.includes(bareTarget)) {
      sessionFile = file
      break
    }
  }

  if (!sessionFile) {
    const found = findSessionTranscriptById(sessionIdOrFile)
    if (found) {
      sessionFile = found.path
      discoveredMeta = { sessionId: found.sessionId, format: found.format, cwd: found.cwd }
    }
  }

  const db = getDb()
  if (!sessionFile) {
    const dbRow = db
      .prepare(
        assertSingleStatement(
          "SELECT id, jsonl_path, cwd, project_path FROM sessions WHERE id = ? OR id = ? OR id LIKE ? OR id LIKE ? ORDER BY updated_at DESC LIMIT 1",
        ),
      )
      .get(sessionIdOrFile, `codex:${bareTarget}`, `codex:${bareTarget}%`, `${bareTarget}%`) as
      | { id: string; jsonl_path: string; cwd: string | null; project_path: string }
      | undefined
    if (dbRow?.jsonl_path && fs.existsSync(dbRow.jsonl_path)) {
      sessionFile = dbRow.jsonl_path
      discoveredMeta = {
        sessionId: dbRow.id.replace(/^(codex|grok|agy|claude):/, ""),
        format: dbRow.id.startsWith("codex:") ? "codex" : "claude",
        cwd: dbRow.cwd || dbRow.project_path || null,
      }
    }
  }

  if (!sessionFile) {
    closeDb()
    console.error(`Session not found: ${sessionIdOrFile}`)
    process.exit(1)
  }

  const homeDir = process.env.HOME || os.homedir()
  const displayFile = sessionFile.startsWith(PROJECTS_DIR + path.sep)
    ? path.relative(PROJECTS_DIR, sessionFile)
    : sessionFile.startsWith(homeDir)
      ? "~" + sessionFile.slice(homeDir.length)
      : sessionFile
  console.log(`Session: ${displayFile}\n`)

  const stats = fs.statSync(sessionFile)
  const relativePath = path.relative(PROJECTS_DIR, sessionFile)
  let project = sessionFile.startsWith(PROJECTS_DIR + path.sep)
    ? relativePath.split(path.sep)[0] || "unknown"
    : discoveredMeta?.cwd || "unknown"
  let sessionId = discoveredMeta?.sessionId ?? path.basename(sessionFile, ".jsonl")

  let messageCount = 0
  let firstTimestamp: string | undefined
  let lastTimestamp: string | undefined

  const fileStream = fs.createReadStream(sessionFile)
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as JsonlRecord & {
        payload?: { id?: string; cwd?: string; timestamp?: string; type?: string; role?: string }
      }
      const ts = record.timestamp ?? record.payload?.timestamp
      if (ts) {
        if (!firstTimestamp) firstTimestamp = ts
        lastTimestamp = ts
      }
      if (record.type === "session_meta" && record.payload) {
        if (typeof record.payload.id === "string") sessionId = record.payload.id
        if (typeof record.payload.cwd === "string") project = record.payload.cwd
      } else if (record.type === "assistant" || record.type === "user") {
        messageCount++
      } else if (
        record.type === "response_item" &&
        record.payload?.type === "message" &&
        (record.payload?.role === "user" || record.payload?.role === "assistant")
      ) {
        messageCount++
      } else if (
        record.type === "event_msg" &&
        (record.payload?.type === "user_message" || record.payload?.type === "agent_message")
      ) {
        messageCount++
      }
    } catch {
      // Skip malformed lines
    }
  }

  const storedSession = getSession(db, sessionId) ?? getSession(db, `codex:${sessionId}`)
  if (storedSession && storedSession.message_count > messageCount) {
    messageCount = storedSession.message_count
  }
  const title = getSessionTitle(db, sessionId) ?? getSessionTitle(db, `codex:${sessionId}`)
  const projectDisplay = project.startsWith("/") ? project : displayProjectPath(project)

  console.log(`Session ID:    ${sessionId}`)
  if (title) console.log(`Title:         ${title}`)
  console.log(`Project:       ${projectDisplay}`)
  console.log(`Size:          ${formatBytes(stats.size)}`)
  console.log(`Messages:      ${messageCount}`)
  if (firstTimestamp) {
    console.log(`Started:       ${new Date(firstTimestamp).toLocaleString()}`)
  }
  if (lastTimestamp) {
    console.log(`Last activity: ${new Date(lastTimestamp).toLocaleString()}`)
  }

  const writes = db
    .prepare("SELECT file_path, timestamp, content_size FROM writes WHERE session_id = ? ORDER BY timestamp")
    .all(sessionId) as {
    file_path: string
    timestamp: string
    content_size: number
  }[]

  if (writes.length > 0) {
    console.log(`\nFile writes (${writes.length}):`)
    for (const w of writes.slice(0, 20)) {
      const time = new Date(w.timestamp).toLocaleTimeString()
      const size = formatBytes(w.content_size)
      const shortPath = w.file_path.replace(os.homedir(), "~")
      console.log(`  ${time}  ${size.padStart(8)}  ${shortPath}`)
    }
    if (writes.length > 20) {
      console.log(`  ... and ${writes.length - 20} more writes`)
    }
  }

  closeDb()
}
