/**
 * Prompt hook latency reader & paging
 *
 * Reads injection.jsonl log produced by Claude Code prompt hooks (recall:hook:prompt),
 * computes hourly latency metrics (p90, max, min, avg, kill count),
 * detects killed runs (started and never finished within timeout),
 * and pages the hook owner when p90 exceeds budget or any run was killed.
 *
 * Admission (27712): a run enters the hour only when a RECOGNIZED terminal is matched to its start and the
 * terminal's timestamp lands in the half-open [windowStartMs, windowEndMs). Warnings are inert; an unknown
 * terminal-shaped outcome is logged by name; an orphan or an unusable timing is excluded, never a fabricated zero;
 * a start whose terminal lands after the window is a completion in the NEXT hour, never a boundary kill.
 *
 * @consumer @ag/tribe/25304-nothing-reads-the-prompt-hooks-latency-log-so-a-30-s-kill-is-found-by-the-operator
 */
import { existsSync, readFileSync } from "node:fs"
import { createLogger } from "loggily"
import type { TribeClientApi } from "./plugin-api.ts"

const log = createLogger("tribe:hook-latency")

/**
 * The producer's terminal outcomes, a CLOSED list by ruling (@ag/tribe/27712, operator ruling 2044). A row that
 * looks like an outcome but is not named here is logged by name and never admitted: a producer rename must not
 * silently turn completions into kills.
 */
const TERMINAL_OUTCOMES = new Set([
  "library ok",
  "library skipped",
  "no prompt in stdin",
  "FATAL: invalid JSON on stdin",
  "FATAL: unhandled error",
  // Historical daemon-path outcomes: old rows still close their start.
  "daemon ok",
  "daemon skipped",
])

/**
 * The producer's own non-terminal narration (recall/src/lib/hooks.ts `warnSkippedSteps`). Inert by contract: it
 * never closes a start, never contributes steps, and is not an unrecognized outcome.
 */
const NON_TERMINAL_OUTCOMES = new Set(["step skipped rather than waited on"])

export interface KilledRun {
  session: string
  ts: string
  startTime: number
  pid?: number
}

export interface CompletedRun {
  session?: string
  ts: string
  startTime: number
  elapsedMs: number
  steps?: Record<string, number>
  pid?: number
}

export interface HookLatencyStats {
  windowStartMs: number
  windowEndMs: number
  totalRuns: number
  completedRuns: number
  killCount: number
  killedRuns: KilledRun[]
  p90Ms: number | null
  maxMs: number | null
  minMs: number | null
  avgMs: number | null
  slowestStepOverall: string | null
  stepMaxMs: Record<string, number>
  budgetMs: number
}

export interface ReadHookLatencyOptions {
  windowStartMs?: number
  windowEndMs?: number
  budgetMs?: number
  timeoutMs?: number
}

export const HOOK_LATENCY_EMITTER = "prompt-hook-latency"
export const HOOK_LATENCY_SUBJECT = "recall/hook/prompt"
export const DEFAULT_HOOK_LATENCY_OWNER = "@chief"
export const DEFAULT_HOOK_BUDGET_MS = 1500

export type HookLatencyCondition = "hook-kill" | "hook-budget-exceeded"

export interface PageHookLatencyOptions {
  owner?: string
  subject?: string
  budgetMs?: number
  condition?: HookLatencyCondition
}

export interface PageHookLatencyResult {
  paged: boolean
  reason?: "kill" | "budget-exceeded" | "ok"
}

/**
 * Compute nearest rank percentile for a list of values.
 * Returns null if values is empty.
 */
export function nearestRank(values: number[], percentile: number): number | null {
  if (values.length === 0) return null
  if (percentile < 0 || percentile > 1) {
    throw new Error(`Percentile must be between 0 and 1, got ${percentile}`)
  }
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil(percentile * sorted.length)
  const index = Math.max(0, Math.min(sorted.length - 1, rank === 0 ? 0 : rank - 1))
  return sorted[index] ?? null
}

interface OpenRun {
  pid?: number
  session: string
  startTime: number
  ts: string
}

interface RawHookLogRow {
  namespace?: unknown
  start_time?: unknown
  ts?: unknown
  pid?: unknown
  session?: unknown
  msg?: unknown
  elapsed_ms?: unknown
  steps?: unknown
}

interface ParsedHookEntry {
  msg: string
  tsNum: number
  tsStr: string
  pid?: number
  session: string
  elapsedMs?: number
  steps?: Record<string, number>
}

// silent-fallback-allow: non-prompt-hook log lines or malformed lines in jsonl log are ignored
function parseHookLogEntry(line: string): ParsedHookEntry | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  let parsed: RawHookLogRow
  try {
    parsed = JSON.parse(trimmed) as RawHookLogRow
  } catch {
    // silent-fallback-allow: malformed json line in jsonl log is ignored
    return null
  }

  if (!parsed || typeof parsed !== "object" || parsed.namespace !== "recall:hook:prompt") {
    return null
  }

  const tsNum =
    typeof parsed.start_time === "number"
      ? parsed.start_time
      : typeof parsed.ts === "string"
        ? new Date(parsed.ts).getTime()
        : 0
  const tsStr =
    typeof parsed.ts === "string" ? parsed.ts : tsNum ? new Date(tsNum).toISOString() : new Date().toISOString()
  const pid = typeof parsed.pid === "number" ? parsed.pid : undefined
  const session = typeof parsed.session === "string" ? parsed.session : "unknown"
  const elapsedMs = typeof parsed.elapsed_ms === "number" ? parsed.elapsed_ms : undefined
  const rawSteps =
    parsed.steps && typeof parsed.steps === "object" ? (parsed.steps as Record<string, unknown>) : undefined
  const steps: Record<string, number> | undefined = rawSteps
    ? Object.fromEntries(
        Object.entries(rawSteps).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
      )
    : undefined

  return {
    msg: typeof parsed.msg === "string" ? parsed.msg : "",
    tsNum,
    tsStr,
    pid,
    session,
    elapsedMs,
    steps,
  }
}

/**
 * Read prompt hook latency stats from the log file over a given time window.
 */
export function readHookLatencyStats(logPath: string, options?: ReadHookLatencyOptions): HookLatencyStats {
  const windowEndMs = options?.windowEndMs ?? Date.now()
  const windowStartMs = options?.windowStartMs ?? windowEndMs - 3600_000
  const timeoutMs = options?.timeoutMs ?? 30_000
  const budgetMs = options?.budgetMs ?? 1500

  const emptyStats: HookLatencyStats = {
    windowStartMs,
    windowEndMs,
    totalRuns: 0,
    completedRuns: 0,
    killCount: 0,
    killedRuns: [],
    p90Ms: null,
    maxMs: null,
    minMs: null,
    avgMs: null,
    slowestStepOverall: null,
    stepMaxMs: {},
    budgetMs,
  }

  if (!existsSync(logPath)) {
    return emptyStats
  }

  let content: string
  try {
    content = readFileSync(logPath, "utf8")
  } catch {
    return emptyStats
  }

  const lines = content.split("\n")
  // Every start is collected, not only the in-window ones: a terminal that lands after windowEnd still closes its
  // start, so it is never read as a boundary kill and counts as a completion in the hour it lands in (27712).
  const openRuns: OpenRun[] = []
  const matchedRuns: Array<{ start: OpenRun; terminal: ParsedHookEntry }> = []
  const unrecognizedOutcomes: ParsedHookEntry[] = []

  for (const line of lines) {
    const entry = parseHookLogEntry(line)
    if (!entry) continue

    if (entry.msg === "start") {
      openRuns.push({
        pid: entry.pid,
        session: entry.session,
        startTime: entry.tsNum,
        ts: entry.tsStr,
      })
      continue
    }

    // Non-terminal narration and empty rows are inert: they never close a start.
    if (entry.msg === "" || NON_TERMINAL_OUTCOMES.has(entry.msg)) continue

    // A row that looks like an outcome but is not named in the closed list is said out loud, never a silent kill.
    if (!TERMINAL_OUTCOMES.has(entry.msg)) {
      unrecognizedOutcomes.push(entry)
      continue
    }

    let matchedIndex = -1
    if (entry.pid !== undefined) {
      matchedIndex = openRuns.findIndex((r) => r.pid === entry.pid)
    }
    if (matchedIndex === -1 && entry.session !== "unknown") {
      matchedIndex = openRuns.findIndex((r) => r.session === entry.session)
    }
    if (matchedIndex === -1) {
      // An orphan terminal in THIS hour is excluded from latency — never a fabricated zero — and named with where it
      // came from. One outside the window belongs to no hour here and is out of scope, not silently dropped.
      if (entry.tsNum >= windowStartMs && entry.tsNum < windowEndMs) {
        log.warn?.(
          `prompt hook latency: excluded terminal with no matching start (path=${logPath}, pid=${entry.pid ?? "unknown"}, session=${entry.session}, msg="${entry.msg}")`,
        )
      }
      continue
    }
    const matched = openRuns.splice(matchedIndex, 1)[0]
    if (matched !== undefined) matchedRuns.push({ start: matched, terminal: entry })
  }

  for (const entry of unrecognizedOutcomes) {
    // Same scope rule: only an outcome that lands in this hour is this hour's to report; an un-timestamped or
    // out-of-window row belongs to no hour and is not silently read as an event either way.
    if (entry.tsNum < windowStartMs || entry.tsNum >= windowEndMs) continue
    log.warn?.(
      `prompt hook latency: unrecognized terminal outcome "${entry.msg}" (path=${logPath}, pid=${entry.pid ?? "unknown"}, session=${entry.session})`,
    )
  }

  // Completions and step maxima share ONE admission: a recognized terminal, matched to its start, whose terminal
  // timestamp lands in this half-open hour. An out-of-window terminal's steps cannot contaminate the hour.
  const completedRuns: CompletedRun[] = []
  const stepMaxMs: Record<string, number> = {}
  for (const { start, terminal } of matchedRuns) {
    if (terminal.tsNum < windowStartMs || terminal.tsNum >= windowEndMs) continue
    const elapsedMs = terminal.elapsedMs ?? terminal.tsNum - start.startTime
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
      log.warn?.(
        `prompt hook latency: excluded completion with unusable timing (path=${logPath}, pid=${start.pid ?? "unknown"}, session=${start.session}, reason=elapsed ${elapsedMs})`,
      )
      continue
    }
    completedRuns.push({
      session: start.session,
      ts: start.ts,
      startTime: start.startTime,
      elapsedMs,
      steps: terminal.steps,
      pid: start.pid,
    })
    if (terminal.steps) {
      for (const [stepName, duration] of Object.entries(terminal.steps)) {
        stepMaxMs[stepName] = Math.max(stepMaxMs[stepName] ?? 0, duration)
      }
    }
  }

  // A start in this hour is killed only when its deadline passed before the cutoff and no terminal ever closed it.
  const killedRuns: KilledRun[] = []
  for (const open of openRuns) {
    if (open.startTime < windowStartMs || open.startTime >= windowEndMs) continue
    if (windowEndMs - open.startTime >= timeoutMs) {
      killedRuns.push({
        session: open.session,
        ts: open.ts,
        startTime: open.startTime,
        pid: open.pid,
      })
    }
  }

  const elapsedList = completedRuns
    .map((r) => r.elapsedMs)
    .filter((e): e is number => typeof e === "number" && !isNaN(e))

  const maxMs = elapsedList.length > 0 ? Math.max(...elapsedList) : null
  const minMs = elapsedList.length > 0 ? Math.min(...elapsedList) : null
  const avgMs =
    elapsedList.length > 0 ? Math.round(elapsedList.reduce((acc, v) => acc + v, 0) / elapsedList.length) : null
  const p90Ms = nearestRank(elapsedList, 0.9)

  let slowestStepOverall: string | null = null
  let maxStepDuration = -1
  for (const [stepName, duration] of Object.entries(stepMaxMs)) {
    if (duration > maxStepDuration) {
      maxStepDuration = duration
      slowestStepOverall = stepName
    }
  }

  const totalRuns = completedRuns.length + killedRuns.length

  return {
    windowStartMs,
    windowEndMs,
    totalRuns,
    completedRuns: completedRuns.length,
    killCount: killedRuns.length,
    killedRuns,
    p90Ms,
    maxMs,
    minMs,
    avgMs,
    slowestStepOverall,
    stepMaxMs,
    budgetMs,
  }
}

/**
 * Format hourly human-readable report string.
 */
export function formatHookLatencyReport(stats: HookLatencyStats): string {
  const p90Str = stats.p90Ms !== null ? `${stats.p90Ms}ms` : "n/a"
  const maxStr = stats.maxMs !== null ? `${stats.maxMs}ms` : "n/a"
  return `Prompt hook latency (last hour): runs=${stats.totalRuns} completed=${stats.completedRuns} kills=${stats.killCount} p90=${p90Str} max=${maxStr}`
}

/**
 * Check if the stats warrant paging the owner.
 */
export function shouldPageHookLatency(stats: HookLatencyStats, budgetMs?: number): boolean {
  const effectiveBudget = budgetMs ?? stats.budgetMs
  if (stats.killCount > 0) return true
  if (stats.p90Ms !== null && stats.p90Ms > effectiveBudget) return true
  return false
}

/**
 * Format page message content, summary, and condition.
 */
export function formatHookLatencyConditionPage(
  condition: HookLatencyCondition,
  stats: HookLatencyStats,
  options?: PageHookLatencyOptions,
): { summary: string; content: string } {
  const budgetMs = options?.budgetMs ?? stats.budgetMs ?? DEFAULT_HOOK_BUDGET_MS
  if (condition === "hook-kill") {
    const summary = `Prompt hook kill detected: ${stats.killCount} run(s) killed`
    const killedLines = stats.killedRuns
      .map((r) => `- session: ${r.session}, started: ${r.ts} (${r.startTime})`)
      .join("\n")
    const content = [
      `Prompt hook run(s) killed by timeout (started and never finished).`,
      `Hourly kill count: ${stats.killCount}`,
      `Total runs: ${stats.totalRuns}, Completed: ${stats.completedRuns}`,
      `Killed runs:`,
      killedLines,
    ].join("\n")
    return { summary, content }
  } else {
    const slowestStep = stats.slowestStepOverall ?? "unknown"
    const summary = `Prompt hook p90 latency ${stats.p90Ms}ms exceeded budget ${budgetMs}ms (slowest step: ${slowestStep})`
    const content = [
      `Prompt hook p90 latency ${stats.p90Ms}ms exceeded stated budget ${budgetMs}ms (max: ${stats.maxMs}ms).`,
      `Slowest step: ${slowestStep}`,
      `Hourly completed runs: ${stats.completedRuns}, Kills: ${stats.killCount}`,
      stats.slowestStepOverall && stats.stepMaxMs[stats.slowestStepOverall]
        ? `Slowest step max duration: ${stats.stepMaxMs[stats.slowestStepOverall]}ms`
        : "",
    ]
      .filter(Boolean)
      .join("\n")
    return { summary, content }
  }
}

export function formatHookLatencyPage(
  stats: HookLatencyStats,
  options?: PageHookLatencyOptions,
): { summary: string; content: string; condition: HookLatencyCondition } {
  const isKill = stats.killCount > 0
  const condition: HookLatencyCondition = options?.condition ?? (isKill ? "hook-kill" : "hook-budget-exceeded")
  const { summary, content } = formatHookLatencyConditionPage(condition, stats, options)
  return { summary, content, condition }
}

/**
 * Page the hook owner via TribeClientApi.send with incident identity.
 */
export function pageHookLatency(
  api: TribeClientApi,
  stats: HookLatencyStats,
  options?: PageHookLatencyOptions,
): PageHookLatencyResult {
  const owner = options?.owner ?? DEFAULT_HOOK_LATENCY_OWNER
  const rawSubject = options?.subject ?? HOOK_LATENCY_SUBJECT
  const subject = rawSubject.replaceAll(":", "/")
  const budgetMs = options?.budgetMs ?? stats.budgetMs ?? DEFAULT_HOOK_BUDGET_MS

  const targetCondition = options?.condition
  if (targetCondition === "hook-kill") {
    if (stats.killCount === 0) return { paged: false, reason: "ok" }
  } else if (targetCondition === "hook-budget-exceeded") {
    if (stats.p90Ms === null || stats.p90Ms <= budgetMs) return { paged: false, reason: "ok" }
  } else {
    if (!shouldPageHookLatency(stats, budgetMs)) {
      return { paged: false, reason: "ok" }
    }
  }

  const { summary, content, condition } = formatHookLatencyPage(stats, options)
  const isKill = condition === "hook-kill"

  api.send(
    owner,
    content,
    isKill ? "alert:prompt-hook:kill" : "alert:prompt-hook:latency",
    undefined,
    {
      delivery: "push",
      topic: isKill ? "prompt-hook-latency:kill" : "prompt-hook-latency:warning",
      summary,
    },
    {
      emitter: HOOK_LATENCY_EMITTER,
      subject,
      condition,
      active: true,
    },
  )

  return { paged: true, reason: isKill ? "kill" : "budget-exceeded" }
}

/**
 * Send incident clearing edge (active: false) when condition recovers.
 */
export function clearHookLatencyIncident(
  api: TribeClientApi,
  condition: HookLatencyCondition,
  options?: PageHookLatencyOptions,
): void {
  const owner = options?.owner ?? DEFAULT_HOOK_LATENCY_OWNER
  const rawSubject = options?.subject ?? HOOK_LATENCY_SUBJECT
  const subject = rawSubject.replaceAll(":", "/")
  const summary = `Prompt hook condition cleared: ${condition} for ${subject}`
  const content = `Prompt hook condition '${condition}' for ${subject} has recovered and is now clear.`

  api.send(
    owner,
    content,
    "notify",
    undefined,
    {
      delivery: "push",
      topic: "prompt-hook-latency:clear",
      summary,
    },
    {
      emitter: HOOK_LATENCY_EMITTER,
      subject,
      condition,
      active: false,
    },
  )
}
