/**
 * codex-indexer.ts - Ingests Codex transcripts exported via `ag transcript export`
 *
 * Adheres strictly to CTO Correction 1-4 rulings on `ag transcript list` and `ag transcript export`.
 */

import { Database } from "bun:sqlite"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import * as readline from "readline"
import * as path from "path"
import * as fs from "fs"
import { getSession, upsertSession, insertMessage, updateSessionStatus } from "./db-queries.ts"

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export interface CodexIndexOptions {
  incremental?: boolean
  full?: boolean
  force?: boolean
  path?: string
  projectRoot?: string
  agBin?: string
  cutoffTime?: number
  onProgress?: (info: { sessionsProcessed: number; messagesIndexed: number; currentSession: string }) => void
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
}

interface TranscriptCatalogSession {
  kind: "session"
  provider: "codex"
  nativeId: string
  canonicalPath: string
  copies: Array<{
    path: string
    account: string | null
    sizeBytes: number
    mtimeMs: number
    lastEventAtMs: number | null
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
    sizeBytes: number
    decision: "canonical" | "stale" | "invalid" | "ambiguous"
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
  if (process.env.AG_BIN && fs.existsSync(process.env.AG_BIN)) {
    return process.env.AG_BIN
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
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(agBin, ["transcript", "list", "--provider", "codex", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    })

    const sessions: TranscriptCatalogSession[] = []
    let doneRecord: Record<string, unknown> | null = null
    let isFirstLine = true
    let stderr = ""

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })

    child.on("error", (err) => {
      reject(new Error(`Failed to spawn ag: ${err.message}`))
    })

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    })

    rl.on("line", (line) => {
      const trimmed = line.trim()
      if (!trimmed) return

      let record: Record<string, unknown>
      try {
        record = JSON.parse(trimmed) as Record<string, unknown>
      } catch (err) {
        reject(new Error(`Malformed JSON from ag transcript list: ${trimmed}`))
        child.kill()
        return
      }

      if (isFirstLine) {
        isFirstLine = false
        if (record.kind !== "schema" || record.version !== 1) {
          reject(new Error(`Unsupported ag transcript schema version: expected 1, got ${record.version ?? "unknown"}`))
          child.kill()
          return
        }
        return
      }

      if (record.kind === "session") {
        sessions.push(record as unknown as TranscriptCatalogSession)
      } else if (record.kind === "done") {
        doneRecord = record
      }
    })

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ag transcript list exited with code ${code}: ${stderr.trim()}`))
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
      })
    })
  })
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

  if (!options.path) {
    const catalog = await fetchCodexCatalog(agBin)
    catalogSessions = catalog.sessions
    discovered = catalog.discovered
    canonical = catalog.canonical
    ambiguous = catalog.ambiguous
  }

  // Filter which transcripts need export
  const pathsToExport: string[] = []
  let skipped = 0

  if (options.path) {
    pathsToExport.push(options.path)
  } else {
    for (const session of catalogSessions) {
      if (options.full) {
        if (session.status === "ambiguous") {
          for (const copy of session.copies) pathsToExport.push(copy.path)
        } else {
          pathsToExport.push(session.canonicalPath)
        }
        continue
      }

      // Check time window: sessions older than cutoffTime are skipped if specified
      const copy = session.copies.find((c) => c.path === session.canonicalPath) ?? session.copies[0]
      if (!copy) continue

      if (options.cutoffTime !== undefined) {
        const eventTime = copy.lastEventAtMs ?? copy.mtimeMs
        if (eventTime && eventTime < options.cutoffTime) {
          skipped++
          continue
        }
      }

      // Check skip key
      if (session.status === "ambiguous") {
        let allCopiesSkipped = true
        for (const c of session.copies) {
          const hash = createHash("sha256").update(c.path).digest("hex")
          const copyKey = `codex:${session.nativeId}@${hash}`
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
          } else {
            allCopiesSkipped = false
            pathsToExport.push(c.path)
          }
        }
        if (allCopiesSkipped) {
          skipped++
        }
      } else {
        const stored = session.key ? getSession(db, session.key) : null
        if (
          stored &&
          stored.status === "complete" &&
          stored.jsonl_path === session.canonicalPath &&
          stored.size_bytes === copy.sizeBytes &&
          stored.mtime_ms === copy.mtimeMs &&
          stored.last_event_at_ms === copy.lastEventAtMs
        ) {
          skipped++
          continue
        }
        pathsToExport.push(session.canonicalPath)
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
  }>((resolve, reject) => {
    const child = spawn(agBin, exportArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    })

    let currentSession: TranscriptExportSessionRecord | null = null
    let currentRows: TranscriptExportRowRecord[] = []
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
        try {
          db.run("ROLLBACK")
        } catch {
          // ignore
        }
        inTx = false
      }
      reject(new Error(`Failed to spawn ag transcript export: ${err.message}`))
    })

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    })

    rl.on("line", (line) => {
      const trimmed = line.trim()
      if (!trimmed) return

      let record: Record<string, unknown>
      try {
        record = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        if (inTx) {
          try {
            db.run("ROLLBACK")
          } catch {
            // ignore
          }
          inTx = false
        }
        reject(new Error(`Malformed JSON from ag transcript export: ${trimmed}`))
        child.kill()
        return
      }

      if (isFirstLine) {
        isFirstLine = false
        if (record.kind !== "schema" || record.version !== 1) {
          reject(new Error(`Unsupported ag transcript schema version: expected 1, got ${record.version ?? "unknown"}`))
          child.kill()
          return
        }
        return
      }

      if (record.kind === "session") {
        if (inTx) {
          try {
            db.run("ROLLBACK")
          } catch {
            // ignore
          }
          inTx = false
          reject(
            new Error(
              `Protocol error: received session record for ${record.nativeId} while previous session was active`,
            ),
          )
          child.kill()
          return
        }
        currentSession = record as unknown as TranscriptExportSessionRecord
        currentRows = []
        try {
          db.run("BEGIN")
          inTx = true
        } catch (e) {
          reject(e)
          child.kill()
          return
        }
      } else if (record.kind === "row") {
        currentRows.push(record as unknown as TranscriptExportRowRecord)
      } else if (record.kind === "end") {
        if (!currentSession || !inTx) {
          reject(new Error(`Protocol error: received end record without active session`))
          child.kill()
          return
        }

        const endRecord = record as unknown as TranscriptExportEndRecord
        const status = endRecord.status
        const nativeId = endRecord.nativeId
        const keys = currentSession.keys || [currentSession.sessionKey]

        if (status === "bad-header" || status === "unreadable") {
          try {
            db.run("ROLLBACK")
            inTx = false
          } catch {
            // ignore
          }
          batchUnreadableCount++
          for (const key of keys) {
            const existing = getSession(db, key)
            if (existing) {
              updateSessionStatus(db, key, `stale-${status}`)
            } else {
              upsertSession(
                db,
                key,
                currentSession.cwd || "",
                currentSession.path,
                currentSession.createdAt ? new Date(currentSession.createdAt).getTime() : Date.now(),
                Date.now(),
                0,
                null,
                { status: status },
              )
            }
          }
        } else if (status === "complete" || status === "incomplete-tail") {
          // Check shrink condition (D1)
          let isShrunk = false
          for (const key of keys) {
            const existing = getSession(db, key)
            const newRowsCount = currentRows.filter((r) => r.sessionKey === key).length
            if (existing && existing.message_count > newRowsCount && !options.force) {
              isShrunk = true
            }
          }

          if (isShrunk) {
            try {
              db.run("ROLLBACK")
              inTx = false
            } catch {
              // ignore
            }
            for (const key of keys) {
              updateSessionStatus(db, key, "shrunk")
            }
          } else {
            try {
              // Delete old rows for this native id
              db.prepare("DELETE FROM messages WHERE session_id = ? OR session_id LIKE ?").run(
                `codex:${nativeId}`,
                `codex:${nativeId}@%`,
              )
              db.prepare("DELETE FROM sessions WHERE id = ? OR id LIKE ?").run(
                `codex:${nativeId}`,
                `codex:${nativeId}@%`,
              )

              // Insert sessions and rows
              for (const key of keys) {
                const keyRows = currentRows.filter((r) => r.sessionKey === key)
                const createdAtMs = currentSession.createdAt ? new Date(currentSession.createdAt).getTime() : Date.now()
                const updatedAtMs = currentSession.mtimeMs ?? Date.now()

                let copyPath = currentSession.path
                let copySize = currentSession.sizeBytes
                if (currentSession.copies && currentSession.copies.length > 0) {
                  const matchedCopy = currentSession.copies.find((c) => {
                    const hash = createHash("sha256").update(c.path).digest("hex")
                    return key.includes(hash)
                  })
                  if (matchedCopy) {
                    copyPath = matchedCopy.path
                    copySize = matchedCopy.sizeBytes
                  }
                }

                upsertSession(
                  db,
                  key,
                  currentSession.cwd || "",
                  copyPath,
                  createdAtMs,
                  updatedAtMs,
                  keyRows.length,
                  null,
                  {
                    status: status,
                    sizeBytes: copySize,
                    mtimeMs: currentSession.mtimeMs,
                    lastEventAtMs: currentSession.lastEventAtMs,
                  },
                )

                for (const row of keyRows) {
                  insertMessage(
                    db,
                    `${key}:${row.line}`,
                    key,
                    row.role,
                    row.text,
                    null,
                    null,
                    row.timestamp ? new Date(row.timestamp).getTime() : createdAtMs,
                  )
                }

                batchRowCount += keyRows.length
              }

              db.run("COMMIT")
              inTx = false
              batchSessionCount++
            } catch (err) {
              try {
                db.run("ROLLBACK")
              } catch {
                // ignore
              }
              inTx = false
              reject(err)
              child.kill()
              return
            }
          }
        }

        options.onProgress?.({
          sessionsProcessed: batchSessionCount,
          messagesIndexed: batchRowCount,
          currentSession: nativeId,
        })

        currentSession = null
        currentRows = []
      } else if (record.kind === "error") {
        batchErrorCount++
      } else if (record.kind === "done") {
        doneRecord = record
      }
    })

    child.on("close", (code) => {
      if (inTx) {
        try {
          db.run("ROLLBACK")
        } catch {
          // ignore
        }
        inTx = false
        reject(new Error("ag transcript export stream ended abruptly during active transaction"))
        return
      }
      if (code !== 0) {
        reject(new Error(`ag transcript export exited with code ${code}: ${stderr.trim()}`))
        return
      }
      if (!doneRecord) {
        reject(new Error("ag transcript export stream ended without done record"))
        return
      }
      resolve({
        sessions: batchSessionCount,
        rows: batchRowCount,
        unreadable: batchUnreadableCount,
        errors: batchErrorCount,
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
  }
}
