/**
 * codex-indexer.ts - Ingests Codex transcripts exported via `ag transcript export`
 *
 * Adheres strictly to CTO Correction 1-4 rulings on `ag transcript list` and `ag transcript export`.
 */

import { Database } from "bun:sqlite"
import { spawn, spawnSync } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import { fileURLToPath } from "node:url"
import * as path from "path"
import * as fs from "fs"
import { getSession, upsertSession, insertMessage, updateSessionStatus } from "./db-queries.ts"

export const INDEX_WINDOW_DAYS = 180
export const INDEX_WINDOW_MS = INDEX_WINDOW_DAYS * 24 * 60 * 60 * 1000

export function safeRollback(db: Database): void {
  try {
    db.run("ROLLBACK")
  } catch (rollbackErr) {
    throw new Error(`CRITICAL: Database transaction rollback failed: ${(rollbackErr as Error).message}`, {
      cause: rollbackErr,
    })
  }
}

export interface CodexIndexOptions {
  incremental?: boolean
  full?: boolean
  force?: boolean
  path?: string
  projectRoot?: string
  agBin?: string
  cutoffTime?: number
  onProgress?: (progress: {
    sessionsProcessed: number
    messagesIndexed: number
    currentSession?: string
  }) => void
}

export interface CodexFailureRecord {
  kind: "unreadable" | "skipped" | "error"
  path?: string
  nativeId?: string
  reason: string
  timestamp: number
  oldRowCount?: number
  newRowCount?: number
  line?: number
}

export interface CodexIndexResult {
  discovered: number
  canonical: number
  ambiguous: number
  sessions: number
  rows: number
  skipped: number
  unreadable: number
  errors: number
  failures: CodexFailureRecord[]
  reasonCounts: Record<string, number>
  indexedSessionIds: string[]
  retainedSessionIds?: string[]
}

interface TranscriptCatalogSession {
  kind: "session"
  provider: "codex"
  nativeId: string
  canonicalPath: string | null
  copies: Array<{
    path: string
    home?: string
    account: string | null
    sizeBytes: number
    mtimeMs: number
    lastEventAtMs: number | null
    decision: "canonical" | "ambiguous" | "stale" | "invalid"
    key: string
  }>
  status: "canonical" | "ambiguous" | "stale" | "invalid"
  key: string | null
  sessionKey?: string | null
}

interface TranscriptExportSessionRecord {
  kind: "session"
  provider: "codex"
  nativeId: string
  sessionKey: string | null
  key: string | null
  path: string
  home: string
  account: string | null
  cwd: string | null
  createdAt: string | null
  sizeBytes: number
  mtimeMs: number | null
  lastEventAtMs: number | null
  keys: string[]
  copies: Array<{
    path: string
    home?: string
    account?: string | null
    sizeBytes: number
    mtimeMs?: number
    lastEventAtMs?: number | null
    decision: "canonical" | "stale" | "invalid" | "ambiguous"
    key: string
  }>
}

interface TranscriptExportRowRecord {
  kind: "row"
  sessionKey: string
  line: number
  role: "user" | "assistant"
  text: string
  timestamp: string | null
  recordKind: "event_msg" | "response_item"
  duplicateOf: number | null
}

interface TranscriptExportEndRecord {
  kind: "end"
  nativeId: string
  keys: string[]
  rows: number
  skipped: number
  status: "complete" | "incomplete-tail" | "bad-header" | "unreadable"
}

export function resolveAgBin(explicitBin?: string): string {
  if (explicitBin) {
    if (fs.existsSync(explicitBin)) {
      return explicitBin
    }
    throw new Error(`Specified ag binary does not exist: ${explicitBin}`)
  }
  if (process.env.AG_BIN && process.env.AG_BIN.trim().length > 0) {
    const envBin = process.env.AG_BIN.trim()
    if (fs.existsSync(envBin)) {
      return envBin
    }
    throw new Error(`Configured AG_BIN does not exist: ${envBin}`)
  }
  // Try locating ag by searching upwards for node_modules/.bin/ag from cwd
  let cur = process.cwd()
  while (cur !== "/" && cur !== ".") {
    const candidate = path.join(cur, "node_modules/.bin/ag")
    if (fs.existsSync(candidate)) {
      return candidate
    }
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  // Search relative to this file's worktree location
  try {
    const thisFile = fileURLToPath(import.meta.url)
    const wtRoot = path.resolve(path.dirname(thisFile), "../../../../../../")
    const wtBin = path.join(wtRoot, "node_modules/.bin/ag")
    if (fs.existsSync(wtBin)) {
      return wtBin
    }
    const wtTs = path.join(wtRoot, "ag/packages/ag-cli/src/bin/ag.ts")
    if (fs.existsSync(wtTs)) {
      return wtTs
    }
  } catch {
    // ignore URL resolution error
  }
  // Check system PATH
  const whichResult = spawnSync("which", ["ag"], { encoding: "utf8" })
  if (whichResult.status === 0 && whichResult.stdout.trim()) {
    return whichResult.stdout.trim()
  }
  throw new Error("Ag binary is not available on PATH and AG_BIN is not set; cannot export Codex transcripts.")
}

/**
 * Fetch the full catalog of Codex transcripts using `ag transcript list --provider codex --json`.
 */
export async function fetchCodexCatalog(agBin: string): Promise<{
  sessions: TranscriptCatalogSession[]
  discovered: number
  canonical: number
  ambiguous: number
  stale: number
  invalid: number
  failures: CodexFailureRecord[]
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(agBin, ["transcript", "list", "--provider", "codex", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    })

    const sessions: TranscriptCatalogSession[] = []
    const failures: CodexFailureRecord[] = []
    let doneRecord: Record<string, unknown> | null = null
    let isFirstLine = true
    let stderr = ""

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })

    child.on("error", (err) => {
      reject(new Error(`Failed to spawn ag: ${err.message}`))
    })

    let buffer = ""
    const handleLine = (line: string): boolean => {
      const trimmed = line.trim()
      if (!trimmed) return true

      let record: Record<string, unknown>
      try {
        record = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        reject(new Error(`Malformed JSON from ag transcript list: ${trimmed}`))
        child.kill()
        return false
      }

      if (isFirstLine) {
        isFirstLine = false
        if (record.kind !== "schema" || record.version !== 1) {
          reject(new Error(`Unsupported ag transcript schema version: expected 1, got ${record.version ?? "unknown"}`))
          child.kill()
          return false
        }
        return true
      }

      if (record.kind === "session") {
        sessions.push(record as unknown as TranscriptCatalogSession)
      } else if (record.kind === "unreadable" || record.kind === "skipped" || record.kind === "error") {
        failures.push({
          kind: record.kind as "unreadable" | "skipped" | "error",
          path: typeof record.path === "string" ? record.path : undefined,
          nativeId: typeof record.nativeId === "string" ? record.nativeId : undefined,
          reason: typeof record.reason === "string" ? record.reason : "unknown",
          timestamp: Date.now(),
        })
      } else if (record.kind === "done") {
        doneRecord = record
      }
      return true
    }

    const decoder = new StringDecoder("utf8")
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk)
      let idx: number
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (!handleLine(line)) return
      }
    })

    child.on("close", (code) => {
      buffer += decoder.end()
      if (buffer.trim()) {
        if (!handleLine(buffer)) return
      }
      if (code !== 0) {
        const failureDetails = failures.length > 0
          ? ` (recorded ${failures.length} catalog failures: ${failures.map((f) => `${f.kind}:${f.reason}${f.path ? ` [${f.path}]` : ""}${f.timestamp ? ` (at ${new Date(f.timestamp).toISOString()})` : ""}`).join(", ")})`
          : ""
        const err = new Error(`ag transcript list exited with code ${code}: ${stderr.trim()}${failureDetails}`)
        ;(err as any).failures = failures
        reject(err)
        return
      }
      if (!doneRecord) {
        reject(new Error("ag transcript list stream ended without done record"))
        return
      }
      resolve({
        sessions,
        discovered: Number(doneRecord.discovered ?? sessions.length),
        canonical: Number(doneRecord.canonical ?? 0),
        ambiguous: Number(doneRecord.ambiguous ?? 0),
        stale: Number(doneRecord.stale ?? 0),
        invalid: Number(doneRecord.invalid ?? 0),
        failures,
      })
    })
  })
}

/**
 * Preflight validation of Ag readiness before any index modification.
 * Ensures Ag binary exists, is executable, emits schema version 1, and can read transcripts.
 */
export async function validateAgReadiness(agBin?: string): Promise<void> {
  const bin = resolveAgBin(agBin)
  await fetchCodexCatalog(bin)
}

/**
 * Ingest Codex transcripts into SQLite database using `ag transcript export`.
 */
export async function indexCodexTranscripts(db: Database, options: CodexIndexOptions = {}): Promise<CodexIndexResult> {
  const agBin = resolveAgBin(options.agBin)

  let catalogSessions: TranscriptCatalogSession[] = []
  let discovered = 0
  let canonical = 0
  let ambiguous = 0
  const failures: CodexFailureRecord[] = []
  const reasonCounts: Record<string, number> = {}

  if (!options.path) {
    const catalog = await fetchCodexCatalog(agBin)
    catalogSessions = catalog.sessions
    discovered = catalog.discovered
    canonical = catalog.canonical
    ambiguous = catalog.ambiguous
    if (catalog.failures.length > 0) {
      failures.push(...catalog.failures)
      for (const f of catalog.failures) {
        reasonCounts[f.reason] = (reasonCounts[f.reason] ?? 0) + 1
      }
    }
  }

  // Filter which transcripts need export
  const pathsToExport: string[] = []
  const skippedSessionIds: string[] = []
  let skipped = 0

  if (options.path) {
    pathsToExport.push(options.path)
  } else {
    for (const session of catalogSessions) {
      if (options.full) {
        if (session.status === "ambiguous") {
          for (const copy of session.copies) {
            if (copy.path) pathsToExport.push(copy.path)
          }
        } else if (session.canonicalPath) {
          pathsToExport.push(session.canonicalPath)
        } else if (session.copies[0]?.path) {
          pathsToExport.push(session.copies[0].path)
        }
        continue
      }

      // Check time window: sessions older than cutoffTime are skipped if specified
      const copy = (session.canonicalPath ? session.copies.find((c) => c.path === session.canonicalPath) : null) ?? session.copies[0]
      if (!copy || !copy.path) {
        failures.push({
          kind: "unreadable",
          nativeId: session.nativeId,
          reason: "missing-path",
          timestamp: Date.now(),
        })
        reasonCounts["missing-path"] = (reasonCounts["missing-path"] ?? 0) + 1
        continue
      }

      if (options.cutoffTime !== undefined) {
        const eventTime = copy.lastEventAtMs ?? copy.mtimeMs
        if (eventTime && eventTime < options.cutoffTime) {
          skipped++
          continue
        }
      }

      // Check skip key using real copy metadata and copy keys
      if (session.status === "ambiguous") {
        let allCopiesSkipped = true
        for (const c of session.copies) {
          if (!c.path) continue
          const copyKey = c.key ?? `codex:${session.nativeId}`
          const stored = getSession(db, copyKey)
          if (
            stored &&
            stored.status === "complete" &&
            stored.jsonl_path === c.path &&
            stored.size_bytes === c.sizeBytes &&
            stored.mtime_ms === c.mtimeMs &&
            stored.last_event_at_ms === c.lastEventAtMs
          ) {
            // this copy unchanged
            skippedSessionIds.push(copyKey)
          } else {
            allCopiesSkipped = false
            pathsToExport.push(c.path)
          }
        }
        if (allCopiesSkipped) {
          skipped++
        }
      } else {
        const targetPath = session.canonicalPath ?? copy.path
        const copyKey = session.key ?? session.sessionKey ?? `codex:${session.nativeId}`
        const stored = getSession(db, copyKey)
        if (
          stored &&
          stored.status === "complete" &&
          stored.jsonl_path === targetPath &&
          stored.size_bytes === copy.sizeBytes &&
          stored.mtime_ms === copy.mtimeMs &&
          stored.last_event_at_ms === copy.lastEventAtMs
        ) {
          skipped++
          skippedSessionIds.push(copyKey)
          continue
        }
        if (targetPath) {
          pathsToExport.push(targetPath)
        }
      }
    }
  }

  if (pathsToExport.length === 0 && (!options.full || options.path)) {
    return {
      discovered,
      canonical,
      ambiguous,
      sessions: 0,
      rows: 0,
      skipped,
      unreadable: 0,
      errors: 0,
      failures,
      reasonCounts,
      indexedSessionIds: skippedSessionIds,
    }
  }

  // Pass ALL changed paths in ONE call (CTO ruling: "Recall must pass ALL changed paths in ONE call, never one call per file")
  const exportArgs = ["transcript", "export", "--provider", "codex", "--json"]
  if (options.full && !options.path) {
    // empty --path flags = ag transcript export exports everything
  } else {
    for (const p of pathsToExport) {
      exportArgs.push("--path", p)
    }
  }

  const batchResult = await new Promise<{
    sessions: number
    rows: number
    unreadable: number
    errors: number
    failures: CodexFailureRecord[]
    reasonCounts: Record<string, number>
    indexedSessionIds: string[]
    retainedSessionIds: string[]
  }>((resolve, reject) => {
    const child = spawn(agBin, exportArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    })

    const batchIndexedSessionIds: string[] = []
    const batchRetainedSessionIds: string[] = []
    let currentSession: TranscriptExportSessionRecord | null = null
    const currentExistingCounts = new Map<string, number>()
    const currentRowCounts = new Map<string, number>()
    let totalRowsThisSession = 0
    let inTx = false
    let isFirstLine = true
    let doneRecord: Record<string, unknown> | null = null
    let stderr = ""
    let batchSessionCount = 0
    let batchRowCount = 0
    let batchUnreadableCount = 0
    let batchErrorCount = 0

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })

    child.on("error", (err) => {
      if (inTx) {
        safeRollback(db)
        inTx = false
      }
      reject(new Error(`Failed to spawn ag transcript export: ${err.message}`))
    })

    let buffer = ""
    const handleLine = (line: string): boolean => {
      const trimmed = line.trim()
      if (!trimmed) return true

      let record: Record<string, unknown>
      try {
        record = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        if (inTx) {
          safeRollback(db)
          inTx = false
        }
        reject(new Error(`Malformed JSON from ag transcript export: ${trimmed}`))
        child.kill()
        return false
      }

      if (isFirstLine) {
        isFirstLine = false
        if (record.kind !== "schema" || record.version !== 1) {
          reject(new Error(`Unsupported ag transcript schema version: expected 1, got ${record.version ?? "unknown"}`))
          child.kill()
          return false
        }
        return true
      }

      if (record.kind === "session") {
        if (inTx) {
          safeRollback(db)
          inTx = false
          reject(
            new Error(
              `Protocol error: received session record for ${record.nativeId} while previous session was active`,
            ),
          )
          child.kill()
          return false
        }
        currentSession = record as unknown as TranscriptExportSessionRecord
        const nativeId = currentSession.nativeId
        const keys =
          currentSession.keys && currentSession.keys.length > 0
            ? currentSession.keys
            : currentSession.sessionKey
              ? [currentSession.sessionKey]
              : [`codex:${nativeId}`]

        currentExistingCounts.clear()
        for (const key of keys) {
          const existing = getSession(db, key)
          if (existing) {
            currentExistingCounts.set(key, existing.message_count)
          }
        }

        try {
          db.run("BEGIN")
          inTx = true
        } catch (e) {
          reject(e)
          child.kill()
          return false
        }

        try {
          // Delete old rows for this native id inside the transaction
          db.prepare("DELETE FROM messages WHERE session_id = ? OR session_id LIKE ?").run(
            `codex:${nativeId}`,
            `codex:${nativeId}@%`,
          )
          db.prepare("DELETE FROM sessions WHERE id = ? OR id LIKE ?").run(
            `codex:${nativeId}`,
            `codex:${nativeId}@%`,
          )
        } catch (err) {
          safeRollback(db)
          inTx = false
          reject(err)
          child.kill()
          return false
        }

        currentRowCounts.clear()
        totalRowsThisSession = 0
      } else if (record.kind === "row") {
        if (!currentSession || !inTx) {
          if (inTx) safeRollback(db)
          inTx = false
          reject(new Error(`Protocol error: received row record without active session transaction`))
          child.kill()
          return false
        }
        const row = record as unknown as TranscriptExportRowRecord
        const key = row.sessionKey
        const createdAtMs = currentSession.createdAt ? new Date(currentSession.createdAt).getTime() : Date.now()
        const rowTimestamp = row.timestamp ? new Date(row.timestamp).getTime() : createdAtMs

        try {
          insertMessage(
            db,
            `${key}:${row.line}`,
            key,
            row.role,
            row.text,
            null,
            null,
            rowTimestamp,
            row.duplicateOf ?? null,
            row.line ?? null,
          )
        } catch (err) {
          safeRollback(db)
          inTx = false
          reject(err)
          child.kill()
          return false
        }

        currentRowCounts.set(key, (currentRowCounts.get(key) ?? 0) + 1)
        totalRowsThisSession++
      } else if (record.kind === "skipped") {
        const reason = String(record.reason ?? "unknown-skip")
        reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1
        failures.push({
          kind: "skipped",
          path: (record.path as string) || (currentSession?.path ?? ""),
          reason,
          line: typeof record.line === "number" ? record.line : undefined,
          timestamp: Date.now(),
        })
      } else if (record.kind === "unreadable") {
        const reason = String(record.reason ?? "unknown-unreadable")
        reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1
        failures.push({
          kind: "unreadable",
          path: (record.path as string) || (currentSession?.path ?? ""),
          reason,
          timestamp: Date.now(),
        })
        batchUnreadableCount++
      } else if (record.kind === "error") {
        const reason = String(record.reason ?? record.message ?? "unknown-error")
        reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1
        failures.push({
          kind: "error",
          path: (record.path as string) || (currentSession?.path ?? ""),
          reason,
          timestamp: Date.now(),
        })
        batchErrorCount++
      } else if (record.kind === "end") {
        if (!currentSession || !inTx) {
          if (inTx) safeRollback(db)
          inTx = false
          reject(new Error(`Protocol error: received end record without active session`))
          child.kill()
          return false
        }

        const endRecord = record as unknown as TranscriptExportEndRecord
        const status = endRecord.status
        const nativeId = endRecord.nativeId
        const keys =
          currentSession.keys && currentSession.keys.length > 0
            ? currentSession.keys
            : currentSession.sessionKey
              ? [currentSession.sessionKey]
              : [`codex:${nativeId}`]
        const createdAtMs = currentSession.createdAt ? new Date(currentSession.createdAt).getTime() : Date.now()

        if (status === "bad-header" || status === "unreadable") {
          safeRollback(db)
          inTx = false
          batchUnreadableCount++
          const reason = status
          reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1
          const now = Date.now()
          failures.push({
            kind: "unreadable",
            path: currentSession.path,
            nativeId: currentSession.nativeId,
            reason,
            timestamp: now,
          })

          for (const key of keys) {
            const existing = getSession(db, key)
            if (existing) {
              updateSessionStatus(db, key, `stale-${status}`, {
                failureReason: reason,
                failureTime: now,
              })
            } else {
              upsertSession(
                db,
                key,
                currentSession.cwd || "",
                currentSession.path,
                createdAtMs,
                Date.now(),
                0,
                null,
                {
                  status: status,
                  failureReason: reason,
                  failureTime: now,
                },
              )
            }
          }
          batchRetainedSessionIds.push(...keys)
        } else if (status === "complete" || status === "incomplete-tail") {
          // Check shrink condition (D1)
          let isShrunk = false
          let shrinkOldCount = 0
          let shrinkNewCount = 0
          for (const key of keys) {
            const oldCount = currentExistingCounts.get(key) ?? 0
            const newCount = currentRowCounts.get(key) ?? 0
            if (oldCount > newCount && !options.force) {
              isShrunk = true
              shrinkOldCount = oldCount
              shrinkNewCount = newCount
            }
          }

          if (isShrunk) {
            safeRollback(db)
            inTx = false
            const reason = "shrunk"
            reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1
            const now = Date.now()
            const shrinkReason = `shrunk: prior count ${shrinkOldCount} > new count ${shrinkNewCount}`
            failures.push({
              kind: "skipped",
              path: currentSession.path,
              nativeId: currentSession.nativeId,
              reason: shrinkReason,
              timestamp: now,
              oldRowCount: shrinkOldCount,
              newRowCount: shrinkNewCount,
            })
            for (const key of keys) {
              updateSessionStatus(db, key, "shrunk", {
                failureReason: shrinkReason,
                failureTime: now,
                shrinkOldCount,
                shrinkNewCount,
              })
            }
            batchRetainedSessionIds.push(...keys)
          } else {
            try {
              const session = currentSession
              for (const key of keys) {
                const count = currentRowCounts.get(key) ?? 0
                const matchedCopy =
                  session.copies?.find((c) => c.key === key) ??
                  (session.copies && keys.length === session.copies.length
                    ? session.copies[keys.indexOf(key)]
                    : session.copies?.find((c) => c.path === session.path))
                const copyPath = matchedCopy?.path ?? session.path
                const copySize = matchedCopy?.sizeBytes ?? session.sizeBytes
                const copyMtime = matchedCopy?.mtimeMs ?? session.mtimeMs ?? Date.now()
                const copyLastEvent = matchedCopy?.lastEventAtMs ?? session.lastEventAtMs ?? null

                upsertSession(
                  db,
                  key,
                  session.cwd || "",
                  copyPath,
                  createdAtMs,
                  copyMtime,
                  count,
                  null,
                  {
                    status: status,
                    sizeBytes: copySize,
                    mtimeMs: copyMtime,
                    lastEventAtMs: copyLastEvent,
                  },
                )
              }

              db.run("COMMIT")
              inTx = false
              batchRowCount += totalRowsThisSession
              batchSessionCount++
              batchIndexedSessionIds.push(...keys)
            } catch (err) {
              safeRollback(db)
              inTx = false
              reject(err)
              child.kill()
              return false
            }
          }
        }

        options.onProgress?.({
          sessionsProcessed: batchSessionCount,
          messagesIndexed: batchRowCount,
          currentSession: nativeId,
        })

        currentSession = null
        currentExistingCounts.clear()
        currentRowCounts.clear()
        totalRowsThisSession = 0
      } else if (record.kind === "done") {
        doneRecord = record
      }
      return true
    }

    const decoder = new StringDecoder("utf8")
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk)
      let idx: number
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (!handleLine(line)) return
      }
    })

    child.on("close", (code) => {
      buffer += decoder.end()
      if (buffer.trim()) {
        if (!handleLine(buffer)) return
      }
      if (inTx) {
        safeRollback(db)
        inTx = false
        reject(
          new Error(
            `ag transcript export stream ended abruptly during active transaction for session ${currentSession?.nativeId ?? "unknown"} (committed ${batchSessionCount} sessions [${batchIndexedSessionIds.join(", ")}], ${batchRowCount} rows prior to interruption)`,
          ),
        )
        return
      }
      if (code !== 0) {
        const failureDetails = failures.length > 0
          ? ` (recorded ${failures.length} failures: ${failures.map((f) => `${f.kind}:${f.reason}${f.path ? ` [${f.path}]` : ""}${f.timestamp ? ` (at ${new Date(f.timestamp).toISOString()})` : ""}${f.oldRowCount !== undefined ? ` [rows: ${f.oldRowCount} -> ${f.newRowCount}]` : ""}`).join(", ")})`
          : ""
        const committedProgress = ` (committed ${batchSessionCount} sessions [${batchIndexedSessionIds.join(", ")}], ${batchRowCount} rows prior to error)`
        const err = new Error(`ag transcript export exited with code ${code}: ${stderr.trim()}${failureDetails}${committedProgress}`)
        ;(err as any).failures = failures
        reject(err)
        return
      }
      if (!doneRecord) {
        reject(
          new Error(
            `ag transcript export stream ended without done record (committed ${batchSessionCount} sessions [${batchIndexedSessionIds.join(", ")}], ${batchRowCount} rows prior to exit)`,
          ),
        )
        return
      }
      resolve({
        sessions: batchSessionCount,
        rows: batchRowCount,
        unreadable: batchUnreadableCount,
        errors: batchErrorCount,
        failures,
        reasonCounts,
        indexedSessionIds: batchIndexedSessionIds,
        retainedSessionIds: batchRetainedSessionIds,
      })
    })
  })

  return {
    discovered,
    canonical,
    ambiguous,
    sessions: batchResult.sessions,
    rows: batchResult.rows,
    skipped,
    unreadable: batchResult.unreadable,
    errors: batchResult.errors,
    failures: batchResult.failures,
    reasonCounts: batchResult.reasonCounts,
    indexedSessionIds: [...skippedSessionIds, ...batchResult.indexedSessionIds],
    retainedSessionIds: batchResult.retainedSessionIds,
  }
}
