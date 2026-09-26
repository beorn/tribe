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
  formatHookLatencyReport,
  pageHookLatency,
  readHookLatencyStats,
  shouldPageHookLatency,
} from "./hook-latency-reader.ts"

const log = createLogger("tribe:plugin:hook-latency")

export function resolveHookLogPath(): string {
  return (
    process.env.INJECTION_DEBUG_LOG ??
    process.env.LOGGILY_FILE ??
    join(homedir(), ".local", "share", "bearly", "injection.jsonl")
  )
}

export const hookLatencyPlugin: TribePluginApi = {
  name: "hook-latency",

  available() {
    return true
  },

  start(api: TribeClientApi) {
    const ac = new AbortController()
    const timers = createTimers(ac.signal)

    const pollIntervalMs =
      parseInt(process.env.HOOK_LATENCY_POLL_INTERVAL_MS ?? "", 10) ||
      (parseInt(process.env.HOOK_LATENCY_POLL_INTERVAL_SEC ?? "", 10) * 1000) ||
      3600_000 // 1 hour default

    const budgetMs = parseInt(process.env.HOOK_BUDGET_MS ?? "1500", 10) || 1500
    const owner = process.env.HOOK_LATENCY_OWNER ?? "@dev/11"

    async function sample(): Promise<void> {
      try {
        const logPath = resolveHookLogPath()
        if (!existsSync(logPath)) {
          return
        }
        const now = Date.now()
        const stats = readHookLatencyStats(logPath, {
          windowStartMs: now - pollIntervalMs,
          windowEndMs: now,
          budgetMs,
        })

        if (stats.totalRuns === 0) {
          return
        }

        const report = formatHookLatencyReport(stats)
        log.info?.(report)

        if (shouldPageHookLatency(stats, budgetMs)) {
          pageHookLatency(api, stats, { owner, budgetMs })
        }
      } catch (err) {
        log.error?.(`hook latency check failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const sampleTicker = startSingleFlightTicker({
      name: "hook-latency-sample",
      intervalMs: pollIntervalMs,
      run: sample,
      timers,
      log: { warn: (msg) => log.warn?.(msg), error: (msg) => log.error?.(msg) },
    })

    // Initial check after 5s startup delay
    timers.setTimeout(() => void sampleTicker.tick(), 5000)

    return () => ac.abort()
  },

  instructions() {
    return "- Hook latency monitoring active: checks hourly prompt hook latency (p90, max, kills) from injection log and pages owner on kills or budget overruns."
  },
}
