/**
 * Hook Latency Plugin
 *
 * Scheduled daemon plugin that periodically checks prompt hook latency from the
 * injection debug log, logs hourly p90/max/kills, and pages the hook owner
 * on kills or budget overruns.
 *
 * @consumer @ag/tribe/25304-nothing-reads-the-prompt-hooks-latency-log-so-a-30-s-kill-is-found-by-the-operator
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createLogger } from "loggily"
import type { TribeClientApi, TribePluginApi } from "./plugin-api.ts"
import { createTimers } from "./timers.ts"
import { startSingleFlightTicker } from "./single-flight-ticker.ts"
import {
  clearHookLatencyIncident,
  DEFAULT_HOOK_BUDGET_MS,
  DEFAULT_HOOK_LATENCY_OWNER,
  formatHookLatencyReport,
  HOOK_LATENCY_EMITTER,
  HOOK_LATENCY_SUBJECT,
  type HookLatencyCondition,
  pageHookLatency,
  readHookLatencyStats,
} from "./hook-latency-reader.ts"

const log = createLogger("tribe:plugin:hook-latency")

export function parseStrictPositiveInt(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined
  }
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid ${name}: "${value}" is not a positive integer`)
  }
  const parsed = Number(trimmed)
  if (parsed <= 0 || !Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid ${name}: "${value}" must be greater than 0`)
  }
  return parsed
}

export interface HookLogResolution {
  path: string
  sources: {
    injectionDebugLog: string | undefined
    loggilyFile: string | undefined
    defaultPath: string
  }
}

export function resolveHookLogPathDetails(): HookLogResolution {
  const injectionDebugLog = process.env.INJECTION_DEBUG_LOG
  const loggilyFile = process.env.LOGGILY_FILE
  const defaultPath = join(homedir(), ".local", "share", "bearly", "injection.jsonl")
  const path = injectionDebugLog ?? loggilyFile ?? defaultPath
  return {
    path,
    sources: {
      injectionDebugLog,
      loggilyFile,
      defaultPath,
    },
  }
}

export function resolveHookLogPath(): string {
  return resolveHookLogPathDetails().path
}

export interface HookLatencySamplerOptions {
  pollIntervalMs?: number
  budgetMs?: number
  owner?: string
  subject?: string
}

export function createHookLatencySampler(
  api: TribeClientApi,
  options?: HookLatencySamplerOptions,
): { sample: () => void; activeConditions: Set<HookLatencyCondition> } {
  const pollIntervalMs = options?.pollIntervalMs ?? 3600_000
  const budgetMs = options?.budgetMs ?? DEFAULT_HOOK_BUDGET_MS
  const owner = options?.owner ?? DEFAULT_HOOK_LATENCY_OWNER
  const subject = options?.subject ?? HOOK_LATENCY_SUBJECT

  const activeConditions = new Set<HookLatencyCondition>()

  function isConditionOpen(condition: HookLatencyCondition): boolean {
    if (api.listOpenIncidents) {
      const open = api.listOpenIncidents(HOOK_LATENCY_EMITTER, condition)
      return open.some((i) => i.subject === subject)
    }
    return activeConditions.has(condition)
  }

  function sample(): void {
    try {
      const resolution = resolveHookLogPathDetails()
      const logPath = resolution.path
      if (!existsSync(logPath)) {
        const sources = resolution.sources
        log.warn?.(
          `Prompt hook latency log not found at ${logPath} (sources considered: INJECTION_DEBUG_LOG=${sources.injectionDebugLog ?? "<unset>"}, LOGGILY_FILE=${sources.loggilyFile ?? "<unset>"}, default=${sources.defaultPath})`,
        )
        const dedupKey = `health:hook-latency:missing-log:${logPath}`
        if (api.claimDedup ? api.claimDedup(dedupKey) : true) {
          api.broadcast(
            `Prompt hook latency log not found at ${logPath} (sources considered: INJECTION_DEBUG_LOG=${sources.injectionDebugLog ?? "<unset>"}, LOGGILY_FILE=${sources.loggilyFile ?? "<unset>"}, default=${sources.defaultPath})`,
            "health",
            undefined,
            {
              delivery: "pull",
              topic: "health:hook-latency:missing-log",
              summary: `Prompt hook latency log missing: ${logPath}`,
            },
          )
        }
        return
      }
      const now = Date.now()
      const stats = readHookLatencyStats(logPath, {
        windowStartMs: now - pollIntervalMs,
        windowEndMs: now,
        budgetMs,
      })

      if (stats.totalRuns === 0) {
        log.info?.(`Prompt hook latency: no rows in ${logPath} for window (${pollIntervalMs}ms)`)
        return
      }

      const report = formatHookLatencyReport(stats)
      log.info?.(report)

      const currentActive = new Set<HookLatencyCondition>()
      if (stats.killCount > 0) {
        currentActive.add("hook-kill")
      }
      if (stats.p90Ms !== null && stats.p90Ms > budgetMs) {
        currentActive.add("hook-budget-exceeded")
      }

      const ALL_CONDITIONS: HookLatencyCondition[] = ["hook-kill", "hook-budget-exceeded"]
      for (const condition of ALL_CONDITIONS) {
        if (currentActive.has(condition)) {
          pageHookLatency(api, stats, { owner, subject, budgetMs, condition })
          activeConditions.add(condition)
        } else {
          if (isConditionOpen(condition)) {
            clearHookLatencyIncident(api, condition, { owner, subject, budgetMs })
            activeConditions.delete(condition)
          }
        }
      }
    } catch (err) {
      log.error?.(`hook latency check failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { sample, activeConditions }
}

export const hookLatencyPlugin: TribePluginApi = {
  name: "hook-latency",

  available() {
    return true
  },

  start(api: TribeClientApi) {
    const ac = new AbortController()
    const timers = createTimers(ac.signal)

    const intervalMsEnv = parseStrictPositiveInt(
      "HOOK_LATENCY_POLL_INTERVAL_MS",
      process.env.HOOK_LATENCY_POLL_INTERVAL_MS,
    )
    const intervalSecEnv = parseStrictPositiveInt(
      "HOOK_LATENCY_POLL_INTERVAL_SEC",
      process.env.HOOK_LATENCY_POLL_INTERVAL_SEC,
    )
    const pollIntervalMs =
      intervalMsEnv ?? (intervalSecEnv !== undefined ? intervalSecEnv * 1000 : undefined) ?? 3600_000 // 1 hour default

    const budgetMs = parseStrictPositiveInt("HOOK_BUDGET_MS", process.env.HOOK_BUDGET_MS) ?? DEFAULT_HOOK_BUDGET_MS

    const owner = process.env.HOOK_LATENCY_OWNER ?? DEFAULT_HOOK_LATENCY_OWNER

    const sampler = createHookLatencySampler(api, {
      pollIntervalMs,
      budgetMs,
      owner,
      subject: HOOK_LATENCY_SUBJECT,
    })

    const sampleTicker = startSingleFlightTicker({
      name: "hook-latency-sample",
      intervalMs: pollIntervalMs,
      run: () => Promise.resolve().then(() => sampler.sample()),
      timers,
      log: { warn: (msg) => log.warn?.(msg), error: (msg) => log.error?.(msg) },
    })

    // Initial check after 5s startup delay
    timers.setTimeout(() => {
      sampleTicker.tick()
    }, 5000)

    return () => ac.abort()
  },

  instructions() {
    return "- Hook latency monitoring active: checks hourly prompt hook latency (p90, max, kills) from injection log and pages owner on kills or budget overruns."
  },
}
