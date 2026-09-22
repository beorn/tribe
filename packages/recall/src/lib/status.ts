/**
 * Status dashboard — unified view of index health, activity, hooks, and recommendations.
 * Replaces: review, now, hour, day, stats commands.
 */

import * as fs from "fs"
import * as os from "os"
import type { Database } from "bun:sqlite"
import { getDb, closeDb, DB_PATH, getActiveSessionsInWindow, getActivitySummary, getIndexMeta } from "../history/db"
import { reviewMemorySystem } from "../history/recall"
import { formatCost } from "./llm-backend.ts"
import { discoverActiveSession, renderDiscoveryDiagnostics } from "./session-discovery.ts"
import { resolveHostProjectRoot } from "./project-root.ts"
import {
  BOLD,
  RESET,
  DIM,
  YELLOW,
  GREEN,
  RED,
  CHECK,
  WARN,
  CROSS,
  FIVE_MINUTES_MS,
  ONE_HOUR_MS,
  ONE_DAY_MS,
  formatBytes,
  formatRelativeTime,
  displayProjectPath,
} from "./format"
 
export interface PersistedFailedSession {
  id: string
  jsonl_path: string
  status: string
  failure_reason: string | null
  failure_time: number | null
  shrink_old_count: number | null
  shrink_new_count: number | null
}

export function getPersistedFailedSessions(db: Database): PersistedFailedSession[] {
  return db
    .prepare(
      `SELECT id, jsonl_path, status, failure_reason, failure_time, shrink_old_count, shrink_new_count
       FROM sessions
       WHERE failure_reason IS NOT NULL OR status IN ('stale-unreadable', 'stale-bad-header', 'shrunk')
       ORDER BY COALESCE(failure_time, updated_at) DESC`,
    )
    .all() as PersistedFailedSession[]
}

export async function cmdStatus(opts: { json?: boolean; bench?: boolean }): Promise<void> {
  // Resolve the project root from the CALLER's cwd, not this file's location.
  // recall is a vendored submodule, so a code-relative walk lands on
  // vendor/tribe and makes hook config always read "unknown" (19990); cwd-based
  // resolution inspects the real host repo's .claude/settings.json.
  const projectRoot = resolveHostProjectRoot(process.cwd())
  // Bounded by default: skip the LLM synthesis test + multi-model race so
  // chief recovery gets index/hook diagnostics promptly. `--bench` opts in.
  const skipLlm = !opts.bench

  // Active-session discovery diagnostics (@km/bearly/19943): a bounded
  // filesystem scan (mtime-windowed, codex-inspect-capped) — NO LLM. Makes the
  // searched roots, session-candidate counts, freshness, exclusions, and
  // unsupported providers visible, so a "refreshed index but found nothing"
  // recovery (the 19943 repro) is diagnosable instead of opaque.
  const sessionDiscovery = discoverActiveSession({ cwd: process.cwd() }).diagnostics

  if (opts.json) {
    const review = await reviewMemorySystem(projectRoot, { skipLlm })
    console.log(JSON.stringify({ ...review, sessionDiscovery }, null, 2))
    return
  }

  console.log()
  console.log(`${BOLD}Recall Status${RESET}`)
  console.log("\u2550".repeat(40))
  console.log()

  // ── Index Health ──────────────────────────────────────────────────────
  let db
  try {
    db = getDb()
  } catch {
    console.log(`${CROSS} No index found. Run \`recall index\` to build.`)
    return
  }

  try {
    const sessions = (db.prepare("SELECT COUNT(*) as n FROM sessions").get() as { n: number }).n ?? 0
    const messages = (db.prepare("SELECT COUNT(*) as n FROM messages").get() as { n: number }).n ?? 0
    const totalWrites = (
      db.prepare("SELECT COUNT(*) as count FROM writes").get() as {
        count: number
      }
    ).count

    let dbSizeBytes = 0
    try {
      dbSizeBytes = fs.statSync(DB_PATH).size
    } catch {
      // silent-fallback-allow: DB file may be in-memory or not yet created on disk; defaults to 0 bytes
    }

    const lastRebuild = getIndexMeta(db, "last_rebuild") ?? null
    const isStale = lastRebuild ? Date.now() - new Date(lastRebuild).getTime() > ONE_HOUR_MS : true

    // Content table counts by type
    const contentCounts = db.prepare("SELECT content_type, COUNT(*) as n FROM content GROUP BY content_type").all() as {
      content_type: string
      n: number
    }[]
    const countByType = new Map(contentCounts.map((r) => [r.content_type, r.n]))

    console.log(`${BOLD}Index Health${RESET}`)
    console.log(
      `  ${sessions.toLocaleString()} sessions  ${messages.toLocaleString()} messages  ${totalWrites.toLocaleString()} file writes`,
    )

    // Show content type counts
    const contentParts: string[] = []
    for (const [type, count] of countByType) {
      if (count > 0) contentParts.push(`${count} ${type}s`)
    }
    if (contentParts.length > 0) {
      console.log(`  Content: ${contentParts.join(", ")}`)
    }

    const statusCounts = db
      .prepare("SELECT status, COUNT(*) as n FROM sessions WHERE status IS NOT NULL GROUP BY status")
      .all() as { status: string; n: number }[]
    if (statusCounts.length > 0) {
      const statusParts = statusCounts.map((r) => `${r.n} ${r.status}`)
      console.log(`  Statuses: ${statusParts.join(", ")}`)
    }

    const providerCounts = db
      .prepare(
        "SELECT CASE WHEN id LIKE 'codex:%' THEN 'codex' ELSE 'claude' END as provider, COUNT(*) as n FROM sessions GROUP BY provider",
      )
      .all() as { provider: string; n: number }[]
    if (providerCounts.length > 0) {
      const providerParts = providerCounts.map((r) => `${r.n} ${r.provider}`)
      console.log(`  Providers: ${providerParts.join(", ")}`)
    }

    const lastCodexReasonCounts = getIndexMeta(db, "last_codex_reason_counts")
    if (lastCodexReasonCounts) {
      try {
        const rc = JSON.parse(lastCodexReasonCounts) as Record<string, number>
        if (Object.keys(rc).length > 0) {
          const rcParts = Object.entries(rc).map(([k, v]) => `${v} ${k}`)
          console.log(`  Codex wire records: ${rcParts.join(", ")}`)
        }
      } catch (err) {
        console.warn(`  Warning: unreadable last_codex_reason_counts: ${(err as Error).message}`)
      }
    }

    const failedSessions = getPersistedFailedSessions(db)
    if (failedSessions.length > 0) {
      console.log(`  Failed/stale sessions (${failedSessions.length}):`)
      for (const s of failedSessions.slice(0, 10)) {
        const timeStr = s.failure_time
          ? ` (${new Date(s.failure_time).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z")})`
          : ""
        const reasonStr = s.failure_reason ? `: ${s.failure_reason}` : ""
        const pathStr = s.jsonl_path ? ` [${s.jsonl_path}]` : ""
        const shrinkStr =
          s.shrink_old_count !== null && s.shrink_new_count !== null
            ? ` (rows: ${s.shrink_old_count} -> ${s.shrink_new_count})`
            : ""
        console.log(`    - [${s.id}] ${s.status}${reasonStr}${pathStr}${shrinkStr}${timeStr}`)
      }
      if (failedSessions.length > 10) {
        console.log(`    ... and ${failedSessions.length - 10} more`)
      }
    }

    const lastCodexFailures = getIndexMeta(db, "last_codex_failures")
    if (lastCodexFailures) {
      try {
        const failures = JSON.parse(lastCodexFailures) as Array<{
          kind: string
          path?: string
          nativeId?: string
          reason: string
          timestamp: number
          oldRowCount?: number
          newRowCount?: number
        }>
        if (failures.length > 0) {
          console.log(`  Codex failures (${failures.length}):`)
          for (const f of failures.slice(0, 5)) {
            const timeStr = new Date(f.timestamp).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z")
            const idStr = f.nativeId ? ` [${f.nativeId}]` : ""
            const pathStr = f.path ? ` ${f.path}` : ""
            const shrinkStr = f.oldRowCount !== undefined && f.newRowCount !== undefined ? ` (rows: ${f.oldRowCount} -> ${f.newRowCount})` : ""
            console.log(`    - ${f.kind}: ${f.reason}${idStr}${pathStr}${shrinkStr} (${timeStr})`)
          }
          if (failures.length > 5) {
            console.log(`    ... and ${failures.length - 5} more`)
          }
        }
      } catch (err) {
        console.warn(`  Warning: unreadable last_codex_failures: ${(err as Error).message}`)
      }
    }

    console.log(
      `  DB: ${formatBytes(dbSizeBytes)}  Last rebuild: ${lastRebuild ? formatRelativeTime(new Date(lastRebuild).getTime()) : `${RED}never${RESET}`}${isStale ? ` ${YELLOW}(stale)${RESET}` : ""}`,
    )
    console.log()

    // ── Active Now ────────────────────────────────────────────────────────
    const active = getActiveSessionsInWindow(db, FIVE_MINUTES_MS)

    if (active.length > 0) {
      console.log(`${BOLD}Active Now${RESET}`)
      for (const s of active) {
        const project = displayProjectPath(s.project_path)
        const relTime = formatRelativeTime(s.last_activity)
        console.log(`  ${project} ${DIM}(${s.message_count} msgs, ${relTime})${RESET}`)
      }
      console.log()
    }

    // ── Today's Activity ──────────────────────────────────────────────────
    const summary = getActivitySummary(db, ONE_DAY_MS)

    if (summary.length > 0) {
      console.log(`${BOLD}Today's Activity${RESET}`)
      for (const project of summary) {
        const displayProject = displayProjectPath(project.project_path)
        console.log(
          `  ${displayProject.padEnd(20)} ${project.message_count} msgs across ${project.session_count} session${project.session_count !== 1 ? "s" : ""}`,
        )
      }
      console.log()
    }

    // ── Stats ─────────────────────────────────────────────────────────────
    const userMessages = (
      db.prepare("SELECT COUNT(*) as count FROM messages WHERE type = 'user'").get() as {
        count: number
      }
    ).count
    const assistantMessages = (
      db.prepare("SELECT COUNT(*) as count FROM messages WHERE type = 'assistant'").get() as {
        count: number
      }
    ).count
    const uniqueFiles = (db.prepare("SELECT COUNT(DISTINCT file_path) as count FROM writes").get() as { count: number })
      .count

    console.log(`${BOLD}Message Breakdown${RESET}`)
    console.log(
      `  User: ${userMessages.toLocaleString()}  Assistant: ${assistantMessages.toLocaleString()}  Files written: ${uniqueFiles.toLocaleString()}`,
    )
    console.log()

    // ── Top written files ─────────────────────────────────────────────────
    const topFiles = db
      .prepare(`
      SELECT file_path, COUNT(*) as count FROM writes
      GROUP BY file_path ORDER BY count DESC LIMIT 5
    `)
      .all() as { file_path: string; count: number }[]

    if (topFiles.length > 0) {
      console.log(`${BOLD}Most Written Files${RESET}`)
      for (const f of topFiles) {
        const shortPath = f.file_path.replace(os.homedir(), "~")
        console.log(`  ${f.count.toString().padStart(4)}x  ${shortPath}`)
      }
      console.log()
    }
  } finally {
    closeDb()
  }

  // ── Hook Configuration ──────────────────────────────────────────────
  const review = await reviewMemorySystem(projectRoot, { skipLlm })
  const hk = review.hookConfig

  console.log(`${BOLD}Hook Configuration${RESET}`)
  if (!hk.localConfigPresent) {
    // No local .claude/settings.json at the checked root (the clean/temp-root
    // shape): the hook booleans are UNKNOWN-for-this-root, not absent — say so
    // instead of rendering a misleading row of ✗.
    console.log(`  ${WARN} hook config UNKNOWN — no local .claude/settings.json at this root`)
    console.log(`  ${DIM}  checked: ${hk.localConfigPath}${RESET}`)
    console.log(`  ${DIM}  ag/profile hooks may be configured elsewhere; run from the live repo root to check.${RESET}`)
  } else {
    console.log(`  ${hk.userPromptSubmitConfigured ? CHECK : CROSS} UserPromptSubmit hook configured`)
    console.log(`  ${hk.sessionEndConfigured ? CHECK : CROSS} SessionEnd hook configured`)
    console.log(`  ${hk.recallHookConfigured ? CHECK : CROSS} recall.ts hook command`)
    console.log(`  ${hk.rememberHookConfigured ? CHECK : CROSS} recall.ts remember command`)
  }
  console.log(
    `  ${hk.sessionMemoryFiles > 0 ? CHECK : WARN} ${hk.sessionMemoryFiles} session memory file${hk.sessionMemoryFiles !== 1 ? "s" : ""}`,
  )
  console.log()

  // ── Active Session Discovery ────────────────────────────────────────────
  console.log(`${BOLD}Active Session Discovery${RESET}`)
  for (const line of renderDiscoveryDiagnostics(sessionDiscovery).split("\n")) {
    console.log(`  ${line}`)
  }
  console.log()

  // ── LLM Race Benchmark ─────────────────────────────────────────────────
  if (review.llmRaceBenchmark) {
    const bench = review.llmRaceBenchmark
    console.log(`${BOLD}LLM Race Benchmark${RESET}`)
    console.log(`  Models: ${bench.models.join(" vs ")}  (${bench.queries} queries, 10s timeout)`)
    console.log()

    // Per-query results table
    for (const r of bench.results) {
      const winnerLabel = r.winner ? `${GREEN}${r.winner}${RESET}` : `${RED}TIMEOUT${RESET}`
      const modelParts = r.perModel
        .map((m) => {
          const ms = `${(m.ms / 1000).toFixed(1)}s`
          const costStr = m.cost ? ` ${formatCost(m.cost)}` : ""
          const tokStr = m.tokens ? ` ${m.tokens.input}+${m.tokens.output}tok` : ""
          if (m.status === "ok") return `${GREEN}${m.model}=${ms}${tokStr}${costStr}${RESET}`
          if (m.status === "timeout") return `${DIM}${m.model}=${ms}(timeout)${RESET}`
          return `${RED}${m.model}=${ms}(error)${RESET}`
        })
        .join("  ")
      console.log(`  "${r.query}" → ${winnerLabel}  search=${r.searchMs}ms  [${modelParts}]`)
    }
    console.log()

    // Summary
    const s = bench.summary
    const winEntries = Object.entries(s.winsByModel)
      .sort((a, b) => b[1] - a[1])
      .map(([model, wins]) => `${model}: ${wins}/${bench.queries}`)
      .join(", ")

    console.log(`  Wins: ${winEntries || "none"}`)
    console.log(`  Timeouts: ${s.timeoutCount}/${bench.queries} (${s.timeoutPct}%)`)
    console.log(
      `  Latency: P50=${(s.p50Ms / 1000).toFixed(1)}s  P95=${(s.p95Ms / 1000).toFixed(1)}s  avg=${(s.avgLlmMs / 1000).toFixed(1)}s`,
    )
    console.log(`  Avg search: ${s.avgSearchMs}ms`)
    console.log(
      `  Cost: ${formatCost(s.totalCost)} total  ${formatCost(s.costPerQuery)}/query  (racing ${bench.models.length} models = ${bench.models.length}x per query)`,
    )
    console.log()
  }

  // ── Recommendations ───────────────────────────────────────────────────
  if (review.recommendations.length > 0) {
    console.log(`${BOLD}Recommendations${RESET}`)
    for (const rec of review.recommendations) {
      const marker =
        rec.includes("good") || rec.includes("working") || rec.includes("winner")
          ? CHECK
          : rec.includes("stale") ||
              rec.includes("not found") ||
              rec.includes("failed") ||
              rec.includes("No ") ||
              rec.includes("not configured") ||
              rec.includes("NOT executable") ||
              rec.includes("error") ||
              rec.includes("empty") ||
              rec.includes("corrupt")
            ? CROSS
            : WARN
      console.log(`  ${marker} ${rec}`)
    }
    console.log()
  }
}
