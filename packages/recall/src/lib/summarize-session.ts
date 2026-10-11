/**
 * Per-session LLM summarization with file-based caching.
 *
 * First pass of a two-pass hierarchical summarization system:
 * extract single session → send to cheap LLM → cache result.
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { createHash } from "crypto"
import { atomicWriteFileSync } from "@bearly/durable-file"
import { extractSessionContent, scanSessionTranscript, type ScanDiagnostics } from "./extract"
import { loadLlm, resolveAvailableCheapModel } from "./llm-backend.ts"

// ============================================================================
// Types
// ============================================================================

export interface SessionSummary {
  id: string
  shortId: string
  title: string | null
  time: string
  isSubAgent: boolean
  summary: string | null // null if skipped
  cached: boolean
  /** Actionable explanation when model selection exhausts every candidate. */
  reason?: string
}

// ============================================================================
// Constants
// ============================================================================

const SESSION_SUMMARY_PROMPT = `You are summarizing a single Claude Code coding session. Be specific and concise.

Produce a 3-8 line summary covering:
- What was the goal/task?
- What was done? (specific files, functions, packages)
- What was the outcome? (bugs fixed, features added, decisions made)
- Any mistakes, failed approaches, or wrong turns? Tag each with [minor], [moderate], or [major] based on time wasted (<5min, 5-30min, 30+min). Format: "[severity] Tried X because Y, but Z was the actual fix." If nothing went wrong, OMIT this line entirely.
- Any non-obvious lessons learned? (OMIT if nothing genuinely novel — routine outcomes don't count)

Rules:
- Be specific: include file names, function names, package names
- Each line should be a complete thought, 1-2 sentences
- Skip routine operations (file reads, test runs, linting)
- If truly nothing noteworthy, respond with just: NONE
- Do NOT invent information not present in the session data

Example output:
Goal: Fix race condition causing missing TUI header on startup.
Done: Added isReady state gate with 50ms mount delay in Board.tsx; updated useLayoutEffect to defer first render.
Outcome: Header now renders consistently; verified with createBoardDriver test.
[moderate] Tried adjusting getPathSegments and renderPath logic assuming a layout bug, but root cause was a timing race — the mount delay was the actual fix.
Lesson: Short deterministic delays can stabilize race-prone UI init more reliably than chasing layout hypotheses.`

const MIN_CONTENT_LENGTH = 100

/**
 * The counts-only diagnostic tail for one session (27702 plan §5): the per-session counts plus the
 * affected input, so a first reason cannot hide the other skip causes. It rides the existing verbose
 * log channel — no new report field or ledger.
 */
function diagnosticsLine(d: ScanDiagnostics): string {
  const fields = [
    `records=${d.records}`,
    `sampled=${d.sampled}`,
    `malformed=${d.malformed}`,
    `oversized=${d.oversized}`,
    `unsupported=${d.unsupported}`,
    `rendered=${d.rendered}`,
    `source=${d.source}`,
  ]
  if (d.oversizedSample) {
    const s = d.oversizedSample
    fields.push(`oversized@line=${s.physicalLine} bytes=${s.bytes} limit=${s.limit}`)
  }
  return fields.join(" ")
}

// ============================================================================
// Cache
// ============================================================================

function getCacheDir(): string {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const encodedPath = projectDir.replace(/\//g, "-")
  return path.join(os.homedir(), ".claude", "projects", encodedPath, "memory", "session-summaries")
}

// The cache file for one session. The key is a digest of the FULL session id: keying on its first
// 8 characters collapsed every Codex session (all sharing the "codex:01" prefix) onto a single
// file, so one session's summary was served for another (28490). The digest is also a portable
// filename where the id is not — ids carry ':' (codex:<uuid>).
export function getSessionSummaryCachePath(sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 32)
  return path.join(getCacheDir(), `${key}.md`)
}

export function getSessionSummaryCache(sessionId: string): string | null {
  try {
    return fs.readFileSync(getSessionSummaryCachePath(sessionId), "utf8")
  } catch {
    // silent-fallback-allow: absent summary cache falls through to live summarization.
    return null
  }
}

function writeCache(sessionId: string, content: string): void {
  const cacheDir = getCacheDir()
  fs.mkdirSync(cacheDir, { recursive: true })
  // 27702: publish the summary atomically — a concurrent reader must never see a prefix.
  atomicWriteFileSync(getSessionSummaryCachePath(sessionId), content)
}

// ============================================================================
// Summarize a single session
// ============================================================================

export async function summarizeSession(
  sessionId: string,
  opts?: { title?: string | null; createdAt?: number; verbose?: boolean },
): Promise<SessionSummary> {
  const log = opts?.verbose ? (msg: string) => console.error(`[summarize-session] ${msg}`) : () => {}

  // Cheap admission first: a cached summary needs no LLM backend, and the
  // bounded metadata scan below is the only transcript I/O it pays.
  const cached = getSessionSummaryCache(sessionId)

  // Bounded metadata-only scan (two streaming passes): classification, identity
  // and the named reason, before ANY content is constructed. A transcript that
  // changes mid-read is a named skip, not a silent mix of two versions.
  const scan = scanSessionTranscript(sessionId, {
    title: opts?.title,
    createdAt: opts?.createdAt,
    mode: "metadata",
  })

  if (!scan) {
    // 27702 plan §2: name the unavailable path. A missing row or transcript is not "changed-input".
    log(`${sessionId.slice(0, 8)}: unavailable-path (no readable transcript)`)
    return {
      id: sessionId,
      shortId: sessionId.slice(0, 8),
      title: opts?.title ?? null,
      time: "",
      isSubAgent: false,
      summary: null,
      cached: false,
      reason: "unavailable-path",
    }
  }

  // Counts for the cheap metadata pass, so the content pass below is not the only evidence.
  log(`${scan.shortId}: metadata scan — ${diagnosticsLine(scan.diagnostics)}`)

  // Cache hit: return the cached summary with the scan's real classification,
  // and never load the backend (27702 §3).
  if (cached) {
    log(`${scan.shortId}: cached — ${diagnosticsLine(scan.diagnostics)}`)
    return {
      id: scan.id,
      shortId: scan.shortId,
      title: scan.title,
      time: scan.time,
      isSubAgent: scan.isSubAgent,
      summary: cached,
      cached: true,
    }
  }

  if (scan.reason) {
    log(`${scan.shortId}: ${scan.reason} — ${diagnosticsLine(scan.diagnostics)}`)
    return {
      id: scan.id,
      shortId: scan.shortId,
      title: scan.title,
      time: scan.time,
      isSubAgent: scan.isSubAgent,
      summary: null,
      cached: false,
      reason: scan.reason,
    }
  }

  // Skip sub-agent sessions
  if (scan.isSubAgent) {
    log(`${scan.shortId}: sub-agent, skipping — ${diagnosticsLine(scan.diagnostics)}`)
    return {
      id: scan.id,
      shortId: scan.shortId,
      title: scan.title,
      time: scan.time,
      isSubAgent: true,
      summary: null,
      cached: false,
    }
  }

  // Check LLM availability BEFORE constructing content: an unsummarisable
  // session must not pay for the content string (27702 §3).
  const resolution = resolveAvailableCheapModel(await loadLlm())
  if (!resolution.model) {
    log(`${scan.shortId}: ${resolution.failure} — ${diagnosticsLine(scan.diagnostics)}`)
    return {
      id: scan.id,
      shortId: scan.shortId,
      title: scan.title,
      time: scan.time,
      isSubAgent: false,
      summary: null,
      cached: false,
      reason: resolution.failure,
    }
  }
  const model = resolution.model
  const llm = resolution.backend

  // Cheap admission passed: now pay for the bounded content pass (a second
  // streaming pair) and build the summary input from it.
  const contentScan = scanSessionTranscript(sessionId, {
    title: opts?.title,
    createdAt: opts?.createdAt,
    mode: "content",
  })
  if (!contentScan || contentScan.reason) {
    // An absent content scan is a READ FAILURE, not proof the transcript changed (27702 plan §2):
    // "changed-input" is reserved for a scan that actually observed a different identity.
    const reason = contentScan ? contentScan.reason : "read-failure"
    log(`${scan.shortId}: ${reason} — ${diagnosticsLine(contentScan?.diagnostics ?? scan.diagnostics)}`)
    return {
      id: scan.id,
      shortId: scan.shortId,
      title: scan.title,
      time: scan.time,
      isSubAgent: contentScan?.isSubAgent ?? false,
      summary: null,
      cached: false,
      reason,
    }
  }
  const extract = extractSessionContent(contentScan)
  if (!extract) {
    log(`${scan.shortId}: no content extracted — ${diagnosticsLine(contentScan.diagnostics)}`)
    return {
      id: scan.id,
      shortId: scan.shortId,
      title: scan.title,
      time: scan.time,
      isSubAgent: false,
      summary: null,
      cached: false,
    }
  }

  // Skip content that's too short
  if (extract.content.length < MIN_CONTENT_LENGTH) {
    log(
      `${scan.shortId}: content too short (${extract.content.length} chars) — ${diagnosticsLine(contentScan.diagnostics)}`,
    )
    return {
      id: scan.id,
      shortId: scan.shortId,
      title: scan.title,
      time: scan.time,
      isSubAgent: false,
      summary: null,
      cached: false,
    }
  }

  // Build context for LLM
  let context = extract.content
  if (context.length > 30000) {
    context = context.slice(0, 30000) + "\n\n[...truncated]"
  }

  log(`${scan.shortId}: sending to LLM (${context.length} chars) — ${diagnosticsLine(contentScan.diagnostics)}`)
  const startTime = Date.now()

  const result = await llm.queryModel({
    question: context,
    model,
    systemPrompt: SESSION_SUMMARY_PROMPT,
  })

  const summary = result.response.content
  log(`${scan.shortId}: LLM responded in ${Date.now() - startTime}ms`)

  // Handle empty / NONE responses
  if (!summary || /^NONE$/im.test(summary.trim())) {
    log(`${scan.shortId}: nothing noteworthy`)
    return {
      id: scan.id,
      shortId: scan.shortId,
      title: scan.title,
      time: scan.time,
      isSubAgent: false,
      summary: null,
      cached: false,
    }
  }

  // Cache the result
  writeCache(scan.id, summary)
  log(`${scan.shortId}: cached summary`)

  return {
    id: scan.id,
    shortId: scan.shortId,
    title: scan.title,
    time: scan.time,
    isSubAgent: false,
    summary,
    cached: false,
  }
}

// ============================================================================
// Batch summarize
// ============================================================================

export async function summarizeSessionBatch(
  sessions: Array<{ id: string; title?: string | null; createdAt?: number }>,
  opts?: { verbose?: boolean; concurrency?: number },
): Promise<SessionSummary[]> {
  const log = opts?.verbose ? (msg: string) => console.error(`[summarize-session] ${msg}`) : () => {}
  const concurrency = opts?.concurrency ?? 8

  log(`processing ${sessions.length} sessions (concurrency=${concurrency})`)

  // Run with bounded concurrency
  const results: SessionSummary[] = []
  let nextIdx = 0
  let completed = 0

  async function worker(): Promise<void> {
    while (nextIdx < sessions.length) {
      const idx = nextIdx++
      const session = sessions[idx]
      if (!session) throw new Error(`Session batch index ${idx} is outside ${sessions.length} inputs`)
      log(`[${idx + 1}/${sessions.length}] ${session.id.slice(0, 8)}`)
      results[idx] = await summarizeSession(session.id, {
        title: session.title,
        createdAt: session.createdAt,
        verbose: opts?.verbose,
      })
      completed++
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, sessions.length) }, () => worker())
  await Promise.all(workers)

  const summarized = results.filter((r) => r.summary !== null).length
  const cached = results.filter((r) => r.cached).length
  log(`done: ${summarized} summarized (${cached} from cache), ${results.length - summarized} skipped`)

  return results
}
