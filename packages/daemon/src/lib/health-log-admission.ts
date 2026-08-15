/**
 * Health-log admission — bounded, model-safe persistence for explicit daemon diagnostics.
 *
 * `createHealthLogAdmission()` owns one time window. It admits the first
 * occurrence of up to five signatures immediately and reserves the sixth
 * durable row for an observable suppression summary.
 */

import { truncateSurrogateSafe } from "./validation.ts"

interface HealthLogAdmission {
  accept(msg: string, type: string): void
  flush(): void
}

export function createHealthLogAdmission(emit: (body: string, type: string) => void): HealthLogAdmission {
  const sentFingerprints = new Set<string>()
  const suppressed = new Map<string, SuppressedHealthLog>()
  let emitted = 0
  let untrackedSuppressed = 0
  let sawSuppressedError = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let windowStartedAt = 0

  function reset(): void {
    sentFingerprints.clear()
    suppressed.clear()
    emitted = 0
    untrackedSuppressed = 0
    sawSuppressedError = false
    windowStartedAt = 0
  }

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    const tracked = Array.from(suppressed.values())
    const suppressedCount = tracked.reduce((total, entry) => total + entry.count, 0) + untrackedSuppressed
    if (suppressedCount === 0) {
      reset()
      return
    }

    const elapsedSeconds = Math.max(
      1,
      Math.min(HEALTH_LOG_WINDOW_MS / 1000, Math.ceil((Date.now() - windowStartedAt) / 1000)),
    )
    const details = tracked
      .sort((a, b) => b.count - a.count || a.body.localeCompare(b.body))
      .slice(0, HEALTH_LOG_SUMMARY_SIGNATURES)
      .map((entry) => {
        const severity = entry.type.endsWith(":error") ? "error" : "warn"
        return `${severity} ${healthLogPreview(entry.body)} ×${entry.count}`
      })
    if (untrackedSuppressed > 0) details.push(`${untrackedSuppressed} additional log(s) beyond signature cap`)
    const summary = `Daemon health logs coalesced: ×${suppressedCount} in ${elapsedSeconds}s; ${details.join("; ")}`
    const summaryType = sawSuppressedError ? "health:daemon:error" : "health:daemon:warn"

    reset()
    emit(summary, summaryType)
  }

  function ensureWindow(): void {
    if (timer !== null) return
    windowStartedAt = Date.now()
    timer = setTimeout(flush, HEALTH_LOG_WINDOW_MS)
    ;(timer as { unref?: () => void }).unref?.()
  }

  function recordSuppressed(body: string, type: string): void {
    sawSuppressedError ||= type.endsWith(":error")
    const fingerprint = healthLogKey(body, type)
    const existing = suppressed.get(fingerprint)
    if (existing) {
      existing.count++
      return
    }
    if (suppressed.size >= HEALTH_LOG_TRACKED_SIGNATURES) {
      untrackedSuppressed++
      return
    }
    suppressed.set(fingerprint, { body: healthLogPreview(body), count: 1, type })
  }

  return {
    accept(msg, type) {
      ensureWindow()
      const body = normalizeHealthLogBody(msg)
      if (!body) {
        recordSuppressed("fully-redacted or empty body", type)
        return
      }
      const fingerprint = healthLogKey(body, type)
      if (emitted < HEALTH_LOG_IMMEDIATE_BUDGET && !sentFingerprints.has(fingerprint)) {
        sentFingerprints.add(fingerprint)
        emitted++
        emit(body, type)
        return
      }
      recordSuppressed(body, type)
    },
    flush,
  }
}

const HEALTH_LOG_WINDOW_MS = 60_000
const HEALTH_LOG_TOTAL_BUDGET = 6
const HEALTH_LOG_IMMEDIATE_BUDGET = HEALTH_LOG_TOTAL_BUDGET - 1
const HEALTH_LOG_TRACKED_SIGNATURES = 20
const HEALTH_LOG_SUMMARY_SIGNATURES = 5
const HEALTH_LOG_SIGNATURE_PREVIEW_CHARS = 180
const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")
const FORMATTED_LOG_RE = /^\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?\s+(?:TRACE|DEBUG|INFO|WARN|ERROR)\s+(\S+)(?:\s+(.*))?$/s
const VOLATILE_DETAIL_SUFFIX_RE = /\s+\([^()\n]*\)\s*$/

type SuppressedHealthLog = {
  body: string
  count: number
  type: string
}

function normalizeHealthLogBody(msg: string): string | null {
  const clean = msg.replace(ANSI_ESCAPE_RE, "").trim()
  if (clean.length === 0 || clean === "[log-redacted]") return null
  const formatted = FORMATTED_LOG_RE.exec(clean)
  if (!formatted) return clean
  const namespace = formatted[1]!
  const message = formatted[2]?.trim()
  return message ? `${namespace}: ${message}` : namespace
}

function healthLogFingerprint(body: string): string {
  return body.replace(VOLATILE_DETAIL_SUFFIX_RE, "").trim()
}

function healthLogKey(body: string, type: string): string {
  return `${type}\0${healthLogPreview(healthLogFingerprint(body))}`
}

function healthLogPreview(body: string): string {
  if (body.length <= HEALTH_LOG_SIGNATURE_PREVIEW_CHARS) return body
  return truncateSurrogateSafe(body, HEALTH_LOG_SIGNATURE_PREVIEW_CHARS - 1) + "…"
}
