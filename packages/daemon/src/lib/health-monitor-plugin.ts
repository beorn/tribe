/**
 * Tribe plugin: Health Monitor — samples machine health metrics and broadcasts
 * alerts when CPU load, memory pressure, or process counts exceed thresholds.
 *
 * Config via env vars:
 *   HEALTH_POLL_INTERVAL  — seconds between samples (default: 10)
 *   HEALTH_CPU_WARNING    — load avg multiplier for warning (default: 0.8)
 *   HEALTH_CPU_CRITICAL   — load avg multiplier for critical (default: 1.5)
 *   HEALTH_MEM_WARNING    — memory % for warning (default: 85)
 *   HEALTH_MEM_CRITICAL   — memory % for critical (default: 95)
 *   HEALTH_PROC_WARNING   — bun/node process count for warning (default: 50)
 *   HEALTH_DISK_WARNING   — disk usage % for warning (default: 85)
 *   HEALTH_DISK_CRITICAL   — disk usage % for critical (default: 95)
 *   HEALTH_WORKTREE_WARNING — open worktree count for warning (default: 5)
 *   HEALTH_GH_RATELIMIT_WARNING — GitHub API remaining % for warning (default: 20)
 *   HEALTH_FD_WARNING      — fd usage % for warning (default: 70)
 *   HEALTH_DISK_IO_WARNING — combined read+write MB/s for warning (default: 500)
 *   HEALTH_REAPER_ENABLED     — enable process reaper (default: "1")
 *   HEALTH_REAPER_CPU_THRESHOLD — CPU % threshold for suspect (default: 80)
 *   HEALTH_REAPER_AGE_MINUTES  — minimum process age in minutes (default: 30)
 *   HEALTH_REAPER_GRACE_SAMPLES — samples to wait after asking before kill (default: 6)
 */

import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { cpus, totalmem, freemem, loadavg } from "node:os"
import { createLogger } from "loggily"
import { isReaperExempt } from "tribe-wire"
import { createTimers } from "./timers.ts"
import type { TribePluginApi, TribeClientApi } from "./plugin-api.ts"
import {
  createHealthProcessSource,
  type CanonicalHostScalarObservation,
  type CanonicalProcessObservation,
  type HealthProcessSource,
} from "./health-process-source.ts"
import {
  checkCanonicalReaper,
  createCanonicalReaperState,
  type CanonicalReaperState,
} from "./health-monitor-canonical-reaper.ts"

const log = createLogger("tribe:health")
const CPU_ALERT_COOLDOWN_MS = 5 * 60_000
const CPU_OFFENDER_MIN_PERCENT = 3
const HEALTH_ALERT_ARGV_MAX_CHARS = 160
type CanonicalDiskCapacity = Extract<
  Extract<CanonicalHostScalarObservation, { kind: "available" }>["values"]["disk"],
  { kind: "supported" }
>["value"]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthMetrics {
  cpu: {
    loadAvg1m?: number
    loadAvg5m?: number
    coreCount?: number
    topProcesses: Array<{ pid: number; cpu: number; mem?: number; command: string }>
  }
  memory?: {
    totalMB: number
    usedMB: number
    availableMB: number
    pressurePercent: number
    swapUsedMB?: number
  }
  disk?: CanonicalDiskCapacity
  diskIo?: {
    readWriteMBps: number
  }
  fdCount?: {
    total: number
    perSession: Array<{ name: string; count: number }>
    limit: number
  }
  ghRateLimit?: {
    remaining: number
    limit: number
    resetAt: number // Unix timestamp
    usagePercent: number
  }
  bunProcesses?: number
  processObservation:
    | { readonly kind: "standalone-os" }
    | {
        readonly kind: "canonical-available"
        readonly observedAt: number
        readonly source: { readonly epoch: string; readonly sequence: number }
      }
    | {
        readonly diagnostic: Extract<CanonicalProcessObservation, { kind: "unavailable" }>["diagnostic"]
        readonly kind: "canonical-unavailable"
        readonly reason: string
      }
  scalarObservation:
    | { readonly kind: "standalone-os"; readonly unavailable: readonly ["disk.bytes", "disk.inodes"] }
    | {
        readonly kind: "canonical-available"
        readonly observedAt: number
        readonly source: { readonly epoch: string; readonly sequence: number }
        readonly unavailable: readonly string[]
      }
    | { readonly detail?: string; readonly kind: "canonical-unavailable"; readonly reason: string }
  worktrees: number
  timestamp: number
}

export interface HealthAlert {
  type:
    | "cpu"
    | "memory"
    | "process-count"
    | "git-lock"
    | "disk"
    | "disk-io"
    | "worktree"
    | "fd-count"
    | "gh-rate-limit"
    | "reaper"
    | "chief-absent"
  severity: "warning" | "critical"
  message: string
  metrics: Partial<HealthMetrics>
  topOffenders: Array<{ pid: number; cpu: number; mem?: number; command: string }>
}

export interface HealthProcess {
  pid: number
  ppid: number
  pgid: number
  cpu: number
  mem?: number
  command: string
}

export interface ReaperSuspect {
  firstSeen: number
  samples: number
  asked: boolean
  /** One-shot flag: unclaimed escalation broadcast already sent (kill arm off). */
  escalated?: boolean
  command: string
  cpu: number
  etime: string
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export interface HealthThresholds {
  cpuWarningMultiplier: number
  cpuCriticalMultiplier: number
  memWarningPercent: number
  memCriticalPercent: number
  processCountWarning: number
  diskWarningPercent: number
  diskCriticalPercent: number
  worktreeWarning: number
  fdWarningPercent: number
  /** Alert when combined read+write exceeds this MB/s sustained */
  diskIoWarningMBps: number
  /** Alert when GitHub API remaining % drops below this (default: 20) */
  ghRateLimitWarning: number
  /** How many consecutive samples above threshold before alerting */
  sustainedSamples: number
  /** Reaper: enabled (default: true) */
  reaperEnabled: boolean
  /** Reaper: CPU % threshold for suspect detection (default: 80) */
  reaperCpuThreshold: number
  /** Reaper: minimum process age in minutes before suspect (default: 30) */
  reaperAgeMinutes: number
  /** Reaper: samples to wait after asking before escalating (default: 6, i.e. 60s at 10s interval) */
  reaperGraceSamples: number
}

export function defaultThresholds(): HealthThresholds {
  return {
    cpuWarningMultiplier: parseFloat(process.env.HEALTH_CPU_WARNING ?? "0.8"),
    cpuCriticalMultiplier: parseFloat(process.env.HEALTH_CPU_CRITICAL ?? "1.5"),
    memWarningPercent: parseInt(process.env.HEALTH_MEM_WARNING ?? "85", 10),
    memCriticalPercent: parseInt(process.env.HEALTH_MEM_CRITICAL ?? "95", 10),
    processCountWarning: parseInt(process.env.HEALTH_PROC_WARNING ?? "50", 10),
    diskWarningPercent: parseInt(process.env.HEALTH_DISK_WARNING ?? "85", 10),
    diskCriticalPercent: parseInt(process.env.HEALTH_DISK_CRITICAL ?? "95", 10),
    worktreeWarning: parseInt(process.env.HEALTH_WORKTREE_WARNING ?? "5", 10),
    fdWarningPercent: parseInt(process.env.HEALTH_FD_WARNING ?? "70", 10),
    diskIoWarningMBps: parseInt(process.env.HEALTH_DISK_IO_WARNING ?? "500", 10),
    ghRateLimitWarning: parseInt(process.env.HEALTH_GH_RATELIMIT_WARNING ?? "20", 10),
    // At 10s interval, 3 samples = 30s sustained
    sustainedSamples: 3,
    reaperEnabled: process.env.HEALTH_REAPER_ENABLED !== "0",
    reaperCpuThreshold: parseInt(process.env.HEALTH_REAPER_CPU_THRESHOLD ?? "80", 10),
    reaperAgeMinutes: parseInt(process.env.HEALTH_REAPER_AGE_MINUTES ?? "30", 10),
    reaperGraceSamples: parseInt(process.env.HEALTH_REAPER_GRACE_SAMPLES ?? "6", 10),
  }
}

// ---------------------------------------------------------------------------
// Alert delivery — pure helper
// ---------------------------------------------------------------------------

export type HealthAlertDeliveryPlan = { kind: "broadcast" } | { kind: "direct"; recipients: readonly string[] }
type HealthSession = { name: string; pid: number; role: string }

/** Choose one fleet broadcast or one DM per unique responsible session. */
export function planHealthAlertDelivery(args: {
  severity: "warning" | "critical"
  attributedSessions: Set<string>
  hasUnattributed: boolean
}): HealthAlertDeliveryPlan {
  const shouldBroadcast = args.severity === "critical" || args.attributedSessions.size === 0 || args.hasUnattributed
  if (shouldBroadcast) return { kind: "broadcast" }
  return {
    kind: "direct",
    recipients: [...args.attributedSessions].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
  }
}

/** Resolve sampled attribution through stable live PIDs immediately before a
 * direct send, so a session renamed after metrics collection receives the
 * alert under its current canonical name. */
export function resolveLiveHealthRecipients(
  attributedSessions: ReadonlySet<string>,
  sampledSessions: readonly HealthSession[],
  liveSessions: readonly HealthSession[],
): Set<string> {
  const resolved = new Set<string>()
  for (const attributedName of attributedSessions) {
    const sampled = sampledSessions.find((session) => session.name === attributedName)
    const byPid = sampled && sampled.pid > 0 ? liveSessions.find((session) => session.pid === sampled.pid) : undefined
    const live = byPid ?? liveSessions.find((session) => session.name === attributedName)
    if (live) resolved.add(live.name)
  }
  return resolved
}

function unresolvedHealthRecipients(
  attributedSessions: ReadonlySet<string>,
  sampledSessions: readonly HealthSession[],
  liveSessions: readonly HealthSession[],
): string[] {
  return [...attributedSessions].filter(
    (attributedName) =>
      resolveLiveHealthRecipients(new Set([attributedName]), sampledSessions, liveSessions).size === 0,
  )
}

/** Execute the delivery plan without per-client fleet fanout. */
export function deliverHealthAlert(
  api: Pick<TribeClientApi, "send" | "broadcast" | "getActiveSessions">,
  alert: Pick<HealthAlert, "type" | "severity">,
  message: string,
  attributedSessions: Set<string>,
  hasUnattributed: boolean,
  sampledSessions?: readonly HealthSession[],
): HealthAlertDeliveryPlan {
  const delivery = planHealthAlertDelivery({
    severity: alert.severity,
    attributedSessions,
    hasUnattributed,
  })
  const topic = `health:${alert.type}:${alert.severity}`
  if (delivery.kind === "broadcast") {
    api.broadcast(message, topic, undefined, {
      delivery: alert.severity === "critical" ? "push" : "pull",
      topic,
    })
    return delivery
  }
  const liveSessions = api.getActiveSessions()
  const recipients = [
    ...resolveLiveHealthRecipients(attributedSessions, sampledSessions ?? liveSessions, liveSessions),
  ].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
  const unresolved = unresolvedHealthRecipients(attributedSessions, sampledSessions ?? liveSessions, liveSessions)
  if (unresolved.length > 0) {
    api.broadcast(
      `${message}. routing diagnostic: attributed owner(s) are not live Tribe recipients: ${unresolved.join(",")}`,
      topic,
      undefined,
      { delivery: "push", topic },
    )
    return { kind: "broadcast" }
  }
  for (const recipient of recipients) {
    api.send(recipient, message, topic, undefined, { delivery: "push", topic })
  }
  return { kind: "direct", recipients }
}

// ---------------------------------------------------------------------------
// Metrics collection
// ---------------------------------------------------------------------------

/** Collect OS-level metrics (no child process needed). */
export function collectOsMetrics(): Omit<
  HealthMetrics,
  "bunProcesses" | "worktrees" | "disk" | "cpu" | "processObservation" | "scalarObservation"
> & {
  cpu: Omit<HealthMetrics["cpu"], "topProcesses">
} {
  const [load1 = 0, load5 = 0] = loadavg()
  const totalBytes = totalmem()
  const freeBytes = freemem()
  const totalMB = Math.round(totalBytes / 1024 / 1024)
  const availableMB = Math.round(freeBytes / 1024 / 1024)
  const usedMB = totalMB - availableMB
  const pressurePercent = Math.round((usedMB / totalMB) * 100)

  return {
    cpu: {
      loadAvg1m: Math.round(load1 * 100) / 100,
      loadAvg5m: Math.round(load5 * 100) / 100,
      coreCount: cpus().length,
    },
    memory: {
      totalMB,
      usedMB,
      availableMB,
      pressurePercent,
      swapUsedMB: 0, // Populated by collectSwapUsage on macOS
    },
    timestamp: Date.now(),
  }
}

/** Parse macOS `sysctl vm.swapusage` output. */
export function parseSwapUsage(output: string): number {
  // Format: "vm.swapusage: total = 2048.00M  used = 123.45M  free = 1924.55M"
  const match = output.match(/used\s*=\s*([\d.]+)M/)
  return match ? parseFloat(match[1] ?? "0") : 0
}

/**
 * Parse macOS `vm_stat` output into a count of pages by category, plus page size.
 *
 * On macOS, Node's os.freemem() returns ONLY pages from the "free" pool — it does
 * not count "inactive" or "speculative" pages even though those are reclaimable
 * on demand. So a healthy system with 10 GB free + 50 GB inactive is reported as
 * "96% used" by os.freemem()-based math, triggering false "memory critical"
 * alarms. The fix is to parse vm_stat directly and compute pressure from the
 * pages that are actually in use — matching what Activity Monitor reports as
 * "Memory Used" (app memory + wired + compressed) and treating inactive +
 * speculative as reclaimable. See km-tribe.reliability-sweep-0415.
 *
 * Typical output header:
 *   Mach Virtual Memory Statistics: (page size of 16384 bytes)
 *   Pages free:                               641676.
 *   Pages active:                            3502447.
 *   Pages inactive:                          3101917.
 *   Pages speculative:                        461909.
 *   Pages wired down:                        1234567.
 *   Pages occupied by compressor:             234567.
 *   ...
 */
export function parseVmStat(output: string): {
  pageSizeBytes: number
  free: number
  active: number
  inactive: number
  speculative: number
  wired: number
  compressed: number
} {
  const pageSizeMatch = output.match(/page size of (\d+) bytes/)
  const pageSizeBytes = pageSizeMatch ? parseInt(pageSizeMatch[1] ?? "16384", 10) : 16384

  const readPages = (label: string): number => {
    const re = new RegExp(`${label}:\\s*(\\d+)\\.?`)
    const m = output.match(re)
    return m ? parseInt(m[1] ?? "0", 10) : 0
  }

  return {
    pageSizeBytes,
    free: readPages("Pages free"),
    active: readPages("Pages active"),
    inactive: readPages("Pages inactive"),
    speculative: readPages("Pages speculative"),
    wired: readPages("Pages wired down"),
    compressed: readPages("Pages occupied by compressor"),
  }
}

/** Parse one atomic process snapshot from
 * `ps -axo pid=,ppid=,pgid=,%cpu=,%mem=,command=`. */
export function parseProcessSnapshot(psOutput: string): HealthProcess[] {
  const processes: HealthProcess[] = []
  for (const line of psOutput.trim().split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/u)
    if (!match) continue
    const [, pidRaw = "", ppidRaw = "", pgidRaw = "", cpuRaw = "", memRaw = "", command = ""] = match
    const pid = Number.parseInt(pidRaw, 10)
    const ppid = Number.parseInt(ppidRaw, 10)
    const pgid = Number.parseInt(pgidRaw, 10)
    const cpu = Number.parseFloat(cpuRaw)
    const mem = Number.parseFloat(memRaw)
    if (![pid, ppid, pgid, cpu, mem].every(Number.isFinite)) continue
    processes.push({ pid, ppid, pgid, cpu, mem, command })
  }
  return processes
}

function isDescendantOf(pid: number, ancestorPid: number, pidToParent: ReadonlyMap<number, number>): boolean {
  let current = pid
  const visited = new Set<number>()
  while (current > 1 && !visited.has(current)) {
    if (current === ancestorPid) return true
    visited.add(current)
    const parent = pidToParent.get(current)
    if (parent === undefined) return false
    current = parent
  }
  return false
}

/**
 * Derive CPU/process-count inputs from one coherent process snapshot. The
 * monitor's own process group is excluded in addition to its descendant tree:
 * probe children inherit the group, while a descendant may start a new group.
 */
export function deriveProcessMetricsFromSnapshot(
  psOutput: string,
  supervisorPid: number,
): {
  topProcesses: HealthMetrics["cpu"]["topProcesses"]
  bunProcesses: number
  pidToParent: Map<number, number>
} {
  const snapshot = parseProcessSnapshot(psOutput)
  const pidToParent = new Map(snapshot.map((process) => [process.pid, process.ppid]))
  const supervisorPgid = snapshot.find((process) => process.pid === supervisorPid)?.pgid
  const observed = snapshot.filter(
    (process) =>
      process.pid !== supervisorPid &&
      (supervisorPgid === undefined || process.pgid !== supervisorPgid) &&
      !isDescendantOf(process.pid, supervisorPid, pidToParent),
  )

  return {
    // Match the operator survey's definition of a real CPU offender. A quiet
    // process must never become a blame target merely because it filled slot 5.
    topProcesses: topCpuConsumers(observed.filter((process) => process.cpu > CPU_OFFENDER_MIN_PERCENT)),
    bunProcesses: countBunNodeProcesses(observed),
    pidToParent,
  }
}

/** Derive ranking and count inputs from the exact canonical observation that
 * also carries routing. No PID is ever joined to a separately sampled table. */
export function deriveProcessMetricsFromCanonical(
  observation: Extract<CanonicalProcessObservation, { kind: "available" }>,
  supervisorPid: number,
  totalBytes?: number,
): {
  topProcesses: HealthMetrics["cpu"]["topProcesses"]
  bunProcesses: number
  pidToParent: Map<number, number>
} {
  const snapshot: HealthProcess[] = observation.processes.map(({ process }) => ({
    command: process.command,
    cpu: process.cpuPercent ?? 0,
    ...(process.rssBytes === undefined || totalBytes === undefined || totalBytes <= 0
      ? {}
      : { mem: (process.rssBytes / totalBytes) * 100 }),
    pgid: process.pgid,
    pid: process.pid,
    ppid: process.ppid,
  }))
  const pidToParent = new Map(snapshot.map((process) => [process.pid, process.ppid]))
  const supervisorPgid = snapshot.find((process) => process.pid === supervisorPid)?.pgid
  const observed = snapshot.filter(
    (process) =>
      process.pid !== supervisorPid &&
      (supervisorPgid === undefined || process.pgid !== supervisorPgid) &&
      !isDescendantOf(process.pid, supervisorPid, pidToParent),
  )
  return {
    topProcesses: topCpuConsumers(observed.filter((process) => process.cpu > CPU_OFFENDER_MIN_PERCENT)),
    bunProcesses: countBunNodeProcesses(observed),
    pidToParent,
  }
}

/**
 * Attribute a process to a tribe session by walking the PPID chain.
 * Session PIDs are stdio-adapter PIDs — their parent is the Claude Code process.
 * High-CPU processes are siblings (other children of the same Claude Code parent).
 */
export function attributeToSession(
  pid: number,
  pidToParent: Map<number, number>,
  sessions: Array<{ name: string; pid: number }>,
): string | null {
  // Build session parent PID map: Claude Code PID → session name
  const sessionParentToName = new Map<number, string>()
  for (const s of sessions) {
    const parentPid = pidToParent.get(s.pid)
    if (parentPid !== undefined) {
      sessionParentToName.set(parentPid, s.name)
    }
    // Also match the session PID itself
    sessionParentToName.set(s.pid, s.name)
  }

  // Walk up the PPID chain from the target process
  let current = pid
  const visited = new Set<number>()
  while (current > 1 && !visited.has(current)) {
    visited.add(current)
    const parent = pidToParent.get(current)
    if (parent === undefined) break

    // Check if the parent is a known Claude Code process
    const sessionName = sessionParentToName.get(parent)
    if (sessionName) return sessionName

    current = parent
  }

  return null
}

/** Count bun/node processes from a parsed process list. */
export function countBunNodeProcesses(processes: Array<{ command: string }>): number {
  return processes.filter((p) => /\b(bun|node)\b/.test(p.command)).length
}

/** Get top N CPU consumers from a parsed process list. */
export function topCpuConsumers(
  processes: Array<{ pid: number; cpu: number; mem?: number; command: string }>,
  n = 5,
): Array<{ pid: number; cpu: number; mem?: number; command: string }> {
  return [...processes]
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, n)
    .map((p) => ({
      pid: p.pid,
      cpu: p.cpu,
      ...(p.mem === undefined ? {} : { mem: p.mem }),
      command: p.command.slice(0, HEALTH_ALERT_ARGV_MAX_CHARS),
    }))
}

export function formatHealthAlertForDelivery(
  alert: Pick<HealthAlert, "type" | "message" | "topOffenders">,
  pidToParent: Map<number, number>,
  sessions: Array<{ name: string; pid: number; role: string }>,
): { message: string; attributedSessions: Set<string>; hasUnattributed: boolean } {
  const sessionLoad = new Map<string, string[]>()
  for (const process of alert.topOffenders) {
    const session = attributeToSession(process.pid, pidToParent, sessions)
    const key = session ?? "unattributed"
    const offenders = sessionLoad.get(key) ?? []
    const argv = process.command.slice(0, HEALTH_ALERT_ARGV_MAX_CHARS)
    offenders.push(`pid=${process.pid} cpu=${process.cpu}% argv=${argv}`)
    sessionLoad.set(key, offenders)
  }

  const attribution = [...sessionLoad].map(([name, offenders]) => `${name}: ${offenders.join(", ")}`).join(" | ")
  const attributedSessions = new Set([...sessionLoad.keys()].filter((name) => name !== "unattributed"))

  return {
    message:
      attribution !== ""
        ? `${alert.message}. ${attribution}`
        : alert.type === "cpu"
          ? `${alert.message}. offenders=none above ${CPU_OFFENDER_MIN_PERCENT}% after supervisor exclusion`
          : alert.message,
    attributedSessions,
    hasUnattributed: sessionLoad.has("unattributed"),
  }
}

/** Format process blame from the same canonical observation that produced the
 * offender ranking. Unknown and unowned remain operator-routed states. */
export function formatCanonicalHealthAlertForDelivery(
  alert: Pick<HealthAlert, "type" | "message" | "topOffenders">,
  observation: Extract<CanonicalProcessObservation, { kind: "available" }>,
): { message: string; attributedSessions: Set<string>; hasUnattributed: boolean } {
  const byPid = new Map(observation.processes.map((row) => [row.process.pid, row]))
  const attributedSessions = new Set<string>()
  const offenders: string[] = []
  let hasUnattributed = false
  for (const process of alert.topOffenders) {
    const row = byPid.get(process.pid)
    const argv = process.command.slice(0, HEALTH_ALERT_ARGV_MAX_CHARS)
    const prefix = `pid=${process.pid} cpu=${process.cpu}% argv=${argv}`
    if (row?.attribution.kind === "owned" || row?.attribution.kind === "exempt") {
      attributedSessions.add(row.attribution.ownerId)
      offenders.push(`${row.attribution.ownerId} via=${row.attribution.via}: ${prefix}`)
      continue
    }
    hasUnattributed = true
    if (row?.attribution.kind === "unknown") {
      const evidence = row.attribution.evidence
      offenders.push(
        `unknown(${row.attribution.reason}; owners=${evidence.ownerIds.join(",") || "none"}; ownerCount=${evidence.ownerCount}; via=${evidence.vias.join(",") || "none"}; queried=${observation.diagnostic.query}; location=${observation.diagnostic.location}; excluded=${observation.diagnostic.excluded.join(",")}): ${prefix}`,
      )
    } else {
      offenders.push(`unowned: ${prefix}`)
    }
  }
  return {
    message:
      offenders.length > 0
        ? `${alert.message}. ${offenders.join(" | ")}`
        : alert.type === "cpu"
          ? `${alert.message}. offenders=none above ${CPU_OFFENDER_MIN_PERCENT}% after supervisor exclusion`
          : alert.message,
    attributedSessions,
    hasUnattributed,
  }
}

type CollectedProcessObservation = CanonicalProcessObservation | { readonly kind: "standalone-os" }

function formatCollectedHealthAlert(
  alert: Pick<HealthAlert, "type" | "message" | "topOffenders">,
  observation: CollectedProcessObservation,
  pidToParent: Map<number, number>,
  sessions: HealthSession[],
): { message: string; attributedSessions: Set<string>; hasUnattributed: boolean } {
  if (observation.kind === "standalone-os") return formatHealthAlertForDelivery(alert, pidToParent, sessions)
  if (observation.kind === "available") return formatCanonicalHealthAlertForDelivery(alert, observation)
  return {
    attributedSessions: new Set<string>(),
    hasUnattributed: true,
    message: `${alert.message}. process attribution unavailable (${observation.reason}); queried ${observation.diagnostic.query} in ${observation.diagnostic.location}; excluded ${observation.diagnostic.excluded.join(",")}`,
  }
}

export function ownerForLockHolder(
  holderPid: number,
  observation: CollectedProcessObservation,
  pidToParent: Map<number, number>,
  sessions: HealthSession[],
): string | null {
  // lsof observes the holder after the canonical batch and supplies only a
  // PID. Without the holder's start time, joining it to an older incarnation
  // would be cross-batch attribution and can misroute after PID reuse.
  if (observation.kind === "available") return null
  if (observation.kind === "standalone-os") return attributeToSession(holderPid, pidToParent, sessions)
  return null
}

async function checkCollectedProcessReaper(
  observation: CollectedProcessObservation,
  metrics: HealthMetrics,
  pidToParent: Map<number, number>,
  sessions: HealthSession[],
  thresholds: HealthThresholds,
  state: AlertState,
  api: TribeClientApi,
): Promise<void> {
  if (observation.kind === "standalone-os") {
    await checkReaper(metrics.cpu.topProcesses, pidToParent, sessions, thresholds, state, api)
    return
  }
  checkCanonicalReaper(observation, thresholds, state.canonicalReaper, api, sessions)
}

/** Parse `git worktree list` output to count worktrees. */
export function parseWorktreeList(output: string): number {
  const trimmed = output.trim()
  if (trimmed === "") return 0
  return trimmed.split("\n").length
}

// ---------------------------------------------------------------------------
// GitHub API rate limit
// ---------------------------------------------------------------------------

/** Parse `gh api rate_limit` JSON output. */
export function parseGhRateLimit(jsonOutput: string): { remaining: number; limit: number; resetAt: number } | null {
  try {
    const data = JSON.parse(jsonOutput) as Record<string, unknown>
    const resources = data?.resources as Record<string, unknown> | undefined
    const core = resources?.core as Record<string, unknown> | undefined
    if (
      core &&
      typeof core.remaining === "number" &&
      typeof core.limit === "number" &&
      typeof core.reset === "number"
    ) {
      return { remaining: core.remaining, limit: core.limit, resetAt: core.reset }
    }
    return null
  } catch {
    // silent-fallback-allow: malformed gh rate-limit JSON disables optional GitHub quota telemetry.
    return null
  }
}

// ---------------------------------------------------------------------------
// File descriptor monitoring
// ---------------------------------------------------------------------------

/** Parse the system file descriptor limit from `ulimit -n` output. */
export function parseUlimitOutput(output: string): number {
  const n = parseInt(output.trim(), 10)
  return isNaN(n) ? 0 : n
}

/** Compute fd usage info from a total count and ulimit. */
export function parseFdInfo(
  lsofCount: number,
  ulimitN: number,
): { total: number; limit: number; usagePercent: number } {
  const limit = ulimitN > 0 ? ulimitN : 1 // Avoid division by zero
  return {
    total: lsofCount,
    limit,
    usagePercent: Math.round((lsofCount / limit) * 100),
  }
}

// ---------------------------------------------------------------------------
// Disk I/O monitoring
// ---------------------------------------------------------------------------

/** Parse macOS `iostat -d -c 2 -w 1` output to extract current disk throughput */
export function parseIostatOutput(output: string): { readWriteMBps: number } | null {
  const lines = output.trim().split("\n")
  // iostat -d -c 2 -w 1 output:
  //               disk0
  //     KB/t  tps  MB/s
  //    52.57   95  4.88    <- historical average (ignore)
  //    64.00  150  9.38    <- current sample (use this)
  //
  // We want the LAST data line (second sample = current rate).
  // Data lines have numeric values; skip headers.
  let lastMBps: number | null = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    // Match lines that look like data: numbers separated by whitespace
    const parts = trimmed.split(/\s+/)
    if (parts.length < 3) continue
    const mbps = parseFloat(parts.at(-1) ?? "")
    if (isNaN(mbps)) continue
    // Verify it's a data line by checking the first column is also numeric
    const first = parseFloat(parts[0] ?? "")
    if (isNaN(first)) continue
    lastMBps = mbps
  }
  if (lastMBps === null) return null
  return { readWriteMBps: lastMBps }
}

// ---------------------------------------------------------------------------
// Git lock detection
// ---------------------------------------------------------------------------

export interface GitLockInfo {
  /** Absolute path to the lock file */
  path: string
  /** Short label: "main" for .git/index.lock, submodule name for modules lock */
  label: string
  /** PID and command of the process holding the lock (null if stale/unknown) */
  holder: { pid: number; command: string } | null
}

/** Parse lsof output to extract PID and command of file holder */
export function parseLsofOutput(output: string): { pid: number; command: string } | null {
  const lines = output.trim().split("\n")
  // Skip header line; parse first data line
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i]?.trim().split(/\s+/) ?? []
    // lsof columns: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
    if (parts.length < 2) continue
    const command = parts[0] ?? ""
    const pid = parseInt(parts[1] ?? "", 10)
    if (!isNaN(pid)) return { pid, command }
  }
  return null
}

/**
 * Find all git lock files: main repo + submodules.
 * Checks .git/index.lock and .git/modules/{name}/index.lock.
 */
export function findGitLockPaths(gitDir: string): Array<{ path: string; label: string }> {
  const locks: Array<{ path: string; label: string }> = []

  // Main repo lock
  const mainLock = `${gitDir}/index.lock`
  if (existsSync(mainLock)) {
    locks.push({ path: mainLock, label: "main" })
  }

  // Submodule locks: .git/modules/*/index.lock
  const modulesDir = `${gitDir}/modules`
  if (existsSync(modulesDir)) {
    try {
      const entries = readdirSync(modulesDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const subLock = `${modulesDir}/${entry.name}/index.lock`
        if (existsSync(subLock)) {
          locks.push({ path: subLock, label: entry.name })
        }
      }
    } catch {
      // Can't read modules dir — skip
    }
  }

  return locks
}

/**
 * Check if .git/index.lock exists and identify who holds it.
 * Returns null if no lock, or { pid, command } of the lock holder.
 */
export async function detectGitLock(gitDir: string): Promise<{ pid: number; command: string } | null> {
  const lockPath = `${gitDir}/index.lock`
  if (!existsSync(lockPath)) return null

  try {
    const proc = Bun.spawn(["lsof", lockPath], { stdout: "pipe", stderr: "ignore" })
    const output = await new Response(proc.stdout).text()
    return parseLsofOutput(output)
  } catch {
    // silent-fallback-allow: lsof failed, so the existing lock is reported without holder details.
    return null
  }
}

/**
 * Detect all git locks (main repo + submodules) and identify holders via lsof.
 * Returns an array of lock info objects with path, label, and holder details.
 */
export async function detectGitLocks(gitDir: string): Promise<GitLockInfo[]> {
  const lockPaths = findGitLockPaths(gitDir)
  if (lockPaths.length === 0) return []

  const results: GitLockInfo[] = []
  for (const { path, label } of lockPaths) {
    let holder: { pid: number; command: string } | null = null
    try {
      const proc = Bun.spawn(["lsof", path], { stdout: "pipe", stderr: "ignore" })
      const output = await new Response(proc.stdout).text()
      holder = parseLsofOutput(output)
    } catch {
      // lsof failed — lock exists but we can't determine holder
    }
    results.push({ path, label, holder })
  }
  return results
}

/**
 * Threshold in ms before alerting about a git lock with a live holder.
 *
 * Holderless locks never reach this threshold — they're reaped silently
 * after LOCK_REAP_AGE_MS (see below). This threshold applies only to locks
 * with an attributable holder via lsof: a slow git op, a hook running
 * lint/format/tsc, or a genuinely stuck process.
 *
 * 15s = 1.5x the default 10s poll interval, so the lock must genuinely
 * span more than one poll cycle before warning. Attribution (the holder's
 * session name when known) further filters noise.
 */
export const LOCK_ALERT_THRESHOLD_MS = 15_000

/** Threshold in ms for escalating a lock to a stale warning */
export const LOCK_STALE_THRESHOLD_MS = 30_000

/**
 * Minimum age in ms before auto-reaping a holderless lock.
 *
 * Git acquires `.git/index.lock` via `open(O_CREAT|O_EXCL)` and an active
 * holder is always visible via `lsof`. A lock with no holder is stale by
 * definition — there's no process to atomically rename it into place.
 *
 * The TOCTOU race between O_EXCL succeeding and the kernel registering the
 * FD visibly to lsof is sub-millisecond. A 1s guard closes it with zero
 * practical cost; real git ops complete in milliseconds.
 */
export const LOCK_REAP_AGE_MS = 1_000

/**
 * Attempt to reap a stale lock if it has no holder and has aged past the
 * race-guard threshold. Returns true if the lock was removed.
 *
 * Uses file mtime (when the lock was created) for age, not poll-based
 * "first-seen" — a fresh lock gets the full 1s grace regardless of when
 * the daemon noticed it.
 */
export function reapStaleLock(lock: GitLockInfo, nowMs: number = Date.now()): boolean {
  if (lock.holder) return false
  let fileMtimeMs: number
  try {
    fileMtimeMs = statSync(lock.path).mtimeMs
  } catch {
    // Already gone — treat as reaped.
    return true
  }
  if (nowMs - fileMtimeMs < LOCK_REAP_AGE_MS) return false
  try {
    unlinkSync(lock.path)
    return true
  } catch {
    // Race: another process reaped it, or we lack permissions.
    return false
  }
}

// ---------------------------------------------------------------------------
// Alert evaluation
// ---------------------------------------------------------------------------

export interface AlertState {
  cpuAboveCritical: number
  cpuAboveWarning: number
  memAboveCritical: number
  memAboveWarning: number
  /** Consecutive high disk I/O readings */
  ioAboveWarning: number
  /** Track which alerts have been fired to avoid repeating */
  firedAlerts: Set<string>
  /** Per-alert last-fire timestamps (used by rate-limited alerts like chief:expired) */
  firedAt: Map<string, number>
  /** Track if we've already alerted about a git lock (dedup) */
  gitLockDetected: boolean
  /** Track when each lock was first seen — key is lock path, value is timestamp */
  lockFirstSeen: Map<string, number>
  /** Track which locks have had their stale warning sent */
  lockStaleWarned: Set<string>
  /** Reaper: tracked suspect PIDs with detection state */
  reaperSuspects: Map<number, ReaperSuspect>
  /** Managed reaper state is incarnation-keyed and never shared with the standalone ps path. */
  canonicalReaper: CanonicalReaperState
  /** Last canonical scalar fact evaluated for sustained thresholds. */
  lastScalarFact?: string
}

export function createAlertState(): AlertState {
  return {
    cpuAboveCritical: 0,
    cpuAboveWarning: 0,
    memAboveCritical: 0,
    memAboveWarning: 0,
    ioAboveWarning: 0,
    firedAlerts: new Set(),
    firedAt: new Map(),
    gitLockDetected: false,
    lockFirstSeen: new Map(),
    lockStaleWarned: new Set(),
    reaperSuspects: new Map(),
    canonicalReaper: createCanonicalReaperState(),
  }
}

/**
 * Format a git lock message for tribe broadcast.
 * Returns short plain-text messages suitable for tribe protocol.
 */
export function formatLockMessage(lock: GitLockInfo, sessionName: string | null, durationSec: number): string {
  const holder = formatLockHolder(lock, sessionName)
  const lockTarget = lock.label === "main" ? ".git/index.lock" : `.git/modules/${lock.label}/index.lock`
  return `git lock: ${lockTarget} held by ${holder} for ${durationSec}s`
}

/**
 * Format a stale lock warning message (>30s).
 */
export function formatStaleLockMessage(lock: GitLockInfo, sessionName: string | null, durationSec: number): string {
  const holder = formatLockHolder(lock, sessionName)
  const lockTarget = lock.label === "main" ? ".git/index.lock" : `.git/modules/${lock.label}/index.lock`
  return `git lock WARNING: ${lockTarget} held >${Math.floor(durationSec)}s by ${holder} -- may be stale`
}

/**
 * Chief-authority watchdog: fail loud immediately when actionable DMs have no
 * live @chief recipient. Online inbox staleness is deliberately absent here:
 * the generic Tribe cadence facts + Hab policy + WATCH reducer own it for
 * every managed seat, including @chief.
 *
 * Returns null when no alert should fire. Side-effects on `state.firedAlerts`
 * so each absence episode only emits once: the key is cleared when the unread
 * count drops to 0 or a live chief returns.
 *
 * Generic staleness owner: @ag/tribe/21626-per-seat-inbox-staleness-alarm.
 */
export function checkChiefAbsent(
  unread: { count: number; oldestTs: number },
  chiefOnline: boolean,
  state: AlertState,
): HealthAlert | null {
  const absentKey = "chief-absent:critical"
  if (unread.count === 0) {
    state.firedAlerts.delete(absentKey)
    return null
  }
  if (!chiefOnline) {
    if (state.firedAlerts.has(absentKey)) return null
    state.firedAlerts.add(absentKey)
    return {
      type: "chief-absent",
      severity: "critical",
      message:
        `STOP-THE-LINE: @chief is absent with ${unread.count} actionable DM${unread.count === 1 ? "" : "s"} ` +
        `waiting. Delivery has no live authority; a live @cto or @fleet must assume authority, ` +
        `or notify the user, then reconcile @chief attention before work continues.`,
      metrics: {},
      topOffenders: [],
    }
  }
  state.firedAlerts.delete(absentKey)
  return null
}

/**
 * Format the lock holder — prefer "<session> (PID <pid>)" when both are known,
 * since the session name is what a human remembers but the PID is still the
 * useful handle for `kill`/`ps`. Fall back to one or the other, or "unknown".
 */
function formatLockHolder(lock: GitLockInfo, sessionName: string | null): string {
  const pid = lock.holder?.pid
  if (sessionName && pid !== undefined) return `${sessionName} (PID ${pid})`
  if (sessionName) return sessionName
  if (pid !== undefined) return `PID ${pid}`
  return "unknown"
}

/**
 * Evaluate metrics against thresholds and return any new alerts.
 * Mutates `state` to track sustained conditions.
 */
// Process-count baseline assumes ~10 bun/node child procs per active agent
// (accountly wrapper + stdio-adapter + tribe MCP + claude proc + transient
// bd-CLI invocations all add up) plus a fixed chief/daemon constant. Tunable
// via env vars when a new agent shape changes the baseline.
const N_PER_AGENT = parseInt(process.env.HEALTH_PROC_PER_AGENT ?? "10", 10)
const CHIEF_CONSTANT = parseInt(process.env.HEALTH_PROC_CHIEF_CONST ?? "6", 10)
const SAFETY_MARGIN = parseFloat(process.env.HEALTH_PROC_SAFETY_MARGIN ?? "1.5")

/** Dynamic process-count threshold that scales with active-agent count.
 *  When 0 active agents, falls back to the static `processCountWarning`
 *  so the daemon still alerts in standalone deployments. When the dynamic
 *  number exceeds the static floor, the dynamic one wins — alarms shouldn't
 *  fire just because a healthy 4-agent baseline is over the old 50 bar. */
export function dynamicProcessThreshold(staticThreshold: number, activeAgentCount: number): number {
  if (activeAgentCount <= 0) return staticThreshold
  const dynamic = Math.ceil(CHIEF_CONSTANT + N_PER_AGENT * activeAgentCount * SAFETY_MARGIN)
  return Math.max(staticThreshold, dynamic)
}

function scalarFactIdentity(observation: HealthMetrics["scalarObservation"]): string | undefined {
  return observation.kind === "canonical-available"
    ? `${observation.source.epoch}\0${observation.source.sequence}`
    : undefined
}

function describeDiskCapacity(capacity: CanonicalDiskCapacity): { detail: string; usagePercent: number } {
  const byteUsage = Math.round((capacity.usedBytes / capacity.totalBytes) * 100)
  const inodes = capacity.inodes
  const inodeUsage =
    inodes?.kind === "supported" ? Math.round((inodes.value.used / inodes.value.total) * 100) : undefined
  const inodeDetail =
    inodes?.kind === "supported"
      ? `${inodeUsage}% inodes (${inodes.value.used}/${inodes.value.total})`
      : `inodes unavailable (${inodes?.reason ?? "not-reported"})`
  const detail =
    `${capacity.path}: ${inodeDetail}; ${byteUsage}% bytes ` +
    `(${capacity.usedBytes}/${capacity.totalBytes}, ${capacity.availableBytes} available)` +
    (capacity.path === "/" ? "" : "; root filesystem not covered")
  return { detail, usagePercent: Math.max(byteUsage, inodeUsage ?? Number.NEGATIVE_INFINITY) }
}

export function evaluateAlerts(
  metrics: HealthMetrics,
  thresholds: HealthThresholds,
  state: AlertState,
  activeAgentCount = 0,
): HealthAlert[] {
  const alerts: HealthAlert[] = []
  const scalarFact = scalarFactIdentity(metrics.scalarObservation)
  const evaluateScalarMetrics = scalarFact === undefined || scalarFact !== state.lastScalarFact
  if (scalarFact !== undefined && evaluateScalarMetrics) state.lastScalarFact = scalarFact
  const cores = metrics.cpu.coreCount
  const load = metrics.cpu.loadAvg1m

  // --- CPU ---
  if (evaluateScalarMetrics && cores !== undefined && load !== undefined) {
    const cpuCriticalThreshold = cores * thresholds.cpuCriticalMultiplier
    const cpuWarningThreshold = cores * thresholds.cpuWarningMultiplier
    const cpuCriticalCoolingDown =
      metrics.timestamp - (state.firedAt.get("cpu:critical") ?? Number.NEGATIVE_INFINITY) < CPU_ALERT_COOLDOWN_MS
    const cpuWarningCoolingDown =
      metrics.timestamp - (state.firedAt.get("cpu:warning") ?? Number.NEGATIVE_INFINITY) < CPU_ALERT_COOLDOWN_MS

    if (load > cpuCriticalThreshold) {
      state.cpuAboveCritical++
      state.cpuAboveWarning++
    } else if (load > cpuWarningThreshold) {
      state.cpuAboveCritical = 0
      state.cpuAboveWarning++
    } else {
      state.cpuAboveCritical = 0
      state.cpuAboveWarning = 0
      state.firedAlerts.delete("cpu:critical")
      state.firedAlerts.delete("cpu:warning")
    }

    if (
      state.cpuAboveCritical >= thresholds.sustainedSamples &&
      !state.firedAlerts.has("cpu:critical") &&
      !cpuCriticalCoolingDown
    ) {
      state.firedAlerts.add("cpu:critical")
      state.firedAlerts.delete("cpu:warning") // Supersedes warning
      state.firedAt.set("cpu:critical", metrics.timestamp)
      state.firedAt.set("cpu:warning", metrics.timestamp)
      alerts.push({
        type: "cpu",
        severity: "critical",
        message: `CPU critical: load ${load} exceeds ${cpuCriticalThreshold.toFixed(1)} (${cores} cores x ${thresholds.cpuCriticalMultiplier}) for ${thresholds.sustainedSamples * 10}s`,
        metrics: { cpu: metrics.cpu },
        topOffenders: metrics.cpu.topProcesses.slice(0, 5),
      })
    } else if (
      state.cpuAboveWarning >= thresholds.sustainedSamples &&
      !state.firedAlerts.has("cpu:warning") &&
      !state.firedAlerts.has("cpu:critical") &&
      !cpuWarningCoolingDown
    ) {
      state.firedAlerts.add("cpu:warning")
      state.firedAt.set("cpu:warning", metrics.timestamp)
      alerts.push({
        type: "cpu",
        severity: "warning",
        message: `CPU warning: load ${load} exceeds ${cpuWarningThreshold.toFixed(1)} (${cores} cores x ${thresholds.cpuWarningMultiplier}) for ${thresholds.sustainedSamples * 10}s`,
        metrics: { cpu: metrics.cpu },
        topOffenders: metrics.cpu.topProcesses.slice(0, 5),
      })
    }
  } else if (evaluateScalarMetrics) {
    state.cpuAboveCritical = 0
    state.cpuAboveWarning = 0
    state.firedAlerts.delete("cpu:critical")
    state.firedAlerts.delete("cpu:warning")
  }

  // --- Memory ---
  const memory = metrics.memory
  if (evaluateScalarMetrics && memory !== undefined) {
    const memPressure = memory.pressurePercent

    if (memPressure > thresholds.memCriticalPercent) {
      state.memAboveCritical++
      state.memAboveWarning++
    } else if (memPressure > thresholds.memWarningPercent) {
      state.memAboveCritical = 0
      state.memAboveWarning++
    } else {
      state.memAboveCritical = 0
      state.memAboveWarning = 0
      state.firedAlerts.delete("memory:critical")
      state.firedAlerts.delete("memory:warning")
    }

    if (state.memAboveCritical >= 1 && !state.firedAlerts.has("memory:critical")) {
      state.firedAlerts.add("memory:critical")
      state.firedAlerts.delete("memory:warning")
      alerts.push({
        type: "memory",
        severity: "critical",
        message: `Memory critical: ${memPressure}% used (${memory.usedMB}MB / ${memory.totalMB}MB)${memory.swapUsedMB === undefined ? "" : `, swap: ${memory.swapUsedMB}MB`}`,
        metrics: { memory },
        topOffenders: metrics.cpu.topProcesses.slice(0, 5),
      })
    } else if (
      state.memAboveWarning >= 1 &&
      !state.firedAlerts.has("memory:warning") &&
      !state.firedAlerts.has("memory:critical")
    ) {
      state.firedAlerts.add("memory:warning")
      alerts.push({
        type: "memory",
        severity: "warning",
        message: `Memory warning: ${memPressure}% used (${memory.usedMB}MB / ${memory.totalMB}MB)`,
        metrics: { memory },
        topOffenders: metrics.cpu.topProcesses.slice(0, 5),
      })
    }
  } else if (evaluateScalarMetrics) {
    state.memAboveCritical = 0
    state.memAboveWarning = 0
    state.firedAlerts.delete("memory:critical")
    state.firedAlerts.delete("memory:warning")
  }

  // --- Process count ---
  // Threshold scales with active agents — 4 agents × ~10 procs each + chief
  // overhead easily exceeds a static 50 bar in normal operation. The
  // dynamicProcessThreshold helper falls back to the static value when no
  // agents are connected (standalone deployments), so the bar never goes
  // BELOW the configured static threshold.
  const processThreshold = dynamicProcessThreshold(thresholds.processCountWarning, activeAgentCount)
  if (metrics.bunProcesses !== undefined && metrics.bunProcesses > processThreshold) {
    if (!state.firedAlerts.has("process-count:warning")) {
      state.firedAlerts.add("process-count:warning")
      const thresholdDetail =
        activeAgentCount > 0
          ? `${processThreshold} dynamic for ${activeAgentCount} agents (static floor: ${thresholds.processCountWarning})`
          : `${processThreshold}`
      alerts.push({
        type: "process-count",
        severity: "warning",
        message: `Process count warning: ${metrics.bunProcesses} bun/node processes (threshold: ${thresholdDetail})`,
        metrics: { bunProcesses: metrics.bunProcesses },
        topOffenders: metrics.cpu.topProcesses.slice(0, 5),
      })
    }
  } else if (metrics.bunProcesses !== undefined) {
    state.firedAlerts.delete("process-count:warning")
  }

  // --- Disk ---
  if (evaluateScalarMetrics && metrics.disk) {
    const disk = describeDiskCapacity(metrics.disk)
    if (disk.usagePercent > thresholds.diskCriticalPercent) {
      if (!state.firedAlerts.has("disk:critical")) {
        state.firedAlerts.add("disk:critical")
        state.firedAlerts.delete("disk:warning") // Supersedes warning
        alerts.push({
          type: "disk",
          severity: "critical",
          message: `Disk critical: ${disk.detail}`,
          metrics: { disk: metrics.disk },
          topOffenders: [],
        })
      }
    } else if (disk.usagePercent > thresholds.diskWarningPercent) {
      if (!state.firedAlerts.has("disk:warning") && !state.firedAlerts.has("disk:critical")) {
        state.firedAlerts.add("disk:warning")
        alerts.push({
          type: "disk",
          severity: "warning",
          message: `Disk warning: ${disk.detail}`,
          metrics: { disk: metrics.disk },
          topOffenders: [],
        })
      }
    } else {
      state.firedAlerts.delete("disk:critical")
      state.firedAlerts.delete("disk:warning")
    }
  } else if (evaluateScalarMetrics) {
    state.firedAlerts.delete("disk:critical")
    state.firedAlerts.delete("disk:warning")
  }

  // --- Worktrees ---
  if (metrics.worktrees > thresholds.worktreeWarning) {
    if (!state.firedAlerts.has("worktree:warning")) {
      state.firedAlerts.add("worktree:warning")
      alerts.push({
        type: "worktree",
        severity: "warning",
        message: `Worktree count warning: ${metrics.worktrees} open worktrees (threshold: ${thresholds.worktreeWarning}). Run 'bun worktree clean' to remove stale ones.`,
        metrics: {},
        topOffenders: [],
      })
    }
  } else {
    state.firedAlerts.delete("worktree:warning")
  }

  // --- File descriptors ---
  if (metrics.fdCount) {
    const usagePercent = (metrics.fdCount.total / metrics.fdCount.limit) * 100
    if (usagePercent > thresholds.fdWarningPercent) {
      if (!state.firedAlerts.has("fd-count:warning")) {
        state.firedAlerts.add("fd-count:warning")
        alerts.push({
          type: "fd-count",
          severity: "warning",
          message: `FD count warning: ${metrics.fdCount.total} open fds (${Math.round(usagePercent)}% of ${metrics.fdCount.limit} limit)`,
          metrics: {},
          topOffenders: [],
        })
      }
    } else {
      state.firedAlerts.delete("fd-count:warning")
    }
  }

  return alerts
}

// ---------------------------------------------------------------------------
// Process reaper — auto-kill stuck bun/node processes
// ---------------------------------------------------------------------------

/**
 * Parse `ps` etime field to minutes.
 * Formats: "MM:SS", "HH:MM:SS", "D-HH:MM:SS", or just seconds.
 */
export function parseEtime(etime: string): number {
  const trimmed = etime.trim()
  if (!trimmed) return 0

  // Format: D-HH:MM:SS
  const dayMatch = trimmed.match(/^(\d+)-(\d+):(\d+):(\d+)$/)
  if (dayMatch) {
    const days = parseInt(dayMatch[1] ?? "0", 10)
    const hours = parseInt(dayMatch[2] ?? "0", 10)
    const mins = parseInt(dayMatch[3] ?? "0", 10)
    return days * 24 * 60 + hours * 60 + mins
  }

  // Format: HH:MM:SS
  const hmsMatch = trimmed.match(/^(\d+):(\d+):(\d+)$/)
  if (hmsMatch) {
    const hours = parseInt(hmsMatch[1] ?? "0", 10)
    const mins = parseInt(hmsMatch[2] ?? "0", 10)
    return hours * 60 + mins
  }

  // Format: MM:SS
  const msMatch = trimmed.match(/^(\d+):(\d+)$/)
  if (msMatch) {
    return parseInt(msMatch[1] ?? "0", 10)
  }

  return 0
}

/**
 * Check for stuck bun/node processes and manage the reaper lifecycle:
 * 1. Detect suspects (>cpuThreshold% CPU, >ageMinutes old, bun/node)
 * 2. Track for 3 consecutive samples before asking
 * 3. Ask sessions to claim ownership (broadcast query)
 * 4. Kill unclaimed after graceSamples more samples
 */
export async function checkReaper(
  topProcesses: Array<{ pid: number; cpu: number; command: string }>,
  pidToParent: Map<number, number>,
  sessions: Array<{ name: string; pid: number; role: string }>,
  thresholds: HealthThresholds,
  state: AlertState,
  api: TribeClientApi,
  // gap 1: a PID an operator marked exempt (a live #undead repro) is never reaped.
  // Injected for tests; production reads the on-disk exempt markers.
  isExempt: (pid: number) => boolean = isReaperExempt,
): Promise<void> {
  if (!thresholds.reaperEnabled) return

  const now = Date.now()
  const seenPids = new Set<number>()

  // Find high-CPU bun/node processes
  const highCpuProcs = topProcesses.filter(
    (p) => p.cpu > thresholds.reaperCpuThreshold && /\b(bun|node)\b/.test(p.command),
  )

  for (const proc of highCpuProcs) {
    seenPids.add(proc.pid)

    // Skip processes owned by active sessions
    const owner = attributeToSession(proc.pid, pidToParent, sessions)
    if (owner) continue

    // gap 1: never even track an operator-exempted PID as a reaper suspect.
    if (isExempt(proc.pid)) continue

    // Check process age via ps -p <pid> -o etime=
    let etime = ""
    let ageMinutes = 0
    try {
      const etimeProc = Bun.spawn(["ps", "-p", String(proc.pid), "-o", "etime="], {
        stdout: "pipe",
        stderr: "ignore",
      })
      etime = (await new Response(etimeProc.stdout).text()).trim()
      ageMinutes = parseEtime(etime)
    } catch {
      continue // Can't determine age — skip
    }

    if (ageMinutes < thresholds.reaperAgeMinutes) continue

    // Track or update suspect
    const existing = state.reaperSuspects.get(proc.pid)
    if (existing) {
      existing.samples++
      existing.cpu = proc.cpu
      existing.etime = etime
    } else {
      state.reaperSuspects.set(proc.pid, {
        firstSeen: now,
        samples: 1,
        asked: false,
        command: proc.command.slice(0, 80),
        cpu: proc.cpu,
        etime,
      })
    }
  }

  // Prune suspects no longer in the high-CPU list
  for (const [pid] of state.reaperSuspects) {
    if (!seenPids.has(pid)) {
      state.reaperSuspects.delete(pid)
    }
  }

  // Process suspects through the lifecycle
  for (const [pid, suspect] of state.reaperSuspects) {
    // gap 1: an exemption can land AFTER a PID was tracked — honor it at the
    // decision point too, so an exempt repro is never asked about or escalated.
    if (isExempt(pid)) {
      log.info?.(`reaper: PID ${pid} is reaper-exempt — skipping (live repro / under investigation)`)
      state.reaperSuspects.delete(pid)
      continue
    }

    // After 3 samples: ask sessions to claim
    if (suspect.samples >= 3 && !suspect.asked) {
      suspect.asked = true
      const consequence = "Reply to claim it; unclaimed processes are escalated to the operator."
      const msg = `health:reaper: PID ${pid} (${suspect.command}) at ${suspect.cpu}% CPU for ${suspect.etime}. Is this yours? ${consequence}`
      log.info?.(`reaper: asking about PID ${pid}`)
      api.broadcast(msg, "health:reaper:query", undefined, {
        delivery: "push",
        topic: "health:reaper:query",
      })
    }

    // After 3 + graceSamples: check for claims, then escalate
    if (suspect.asked && suspect.samples >= 3 + thresholds.reaperGraceSamples) {
      // Check if anyone claimed this PID
      const claimed = api.hasRecentMessage(`reaper:claim PID ${pid}`)
      if (claimed) {
        log.info?.(`reaper: PID ${pid} claimed by a session, removing from suspects`)
        state.reaperSuspects.delete(pid)
        continue
      }

      // Verify the process still exists before escalating.
      let stillAlive = false
      try {
        const checkProc = Bun.spawn(["ps", "-p", String(pid), "-o", "pid="], {
          stdout: "pipe",
          stderr: "ignore",
        })
        const checkOutput = (await new Response(checkProc.stdout).text()).trim()
        stillAlive = checkOutput.length > 0
      } catch {
        stillAlive = false
      }

      if (!stillAlive) {
        state.reaperSuspects.delete(pid)
        continue
      }

      // Intervention is an operator decision, never automatic. Escalate ONCE
      // per suspect and keep tracking so a later claim or exit still clears it.
      if (!suspect.escalated) {
        suspect.escalated = true
        const escMsg = `health:reaper: PID ${pid} (${suspect.command}) unclaimed after ${thresholds.reaperGraceSamples * 10}s at ${suspect.cpu}% CPU for ${suspect.etime} — operator decision required (reply "reaper:claim PID ${pid}" to clear)`
        log.info?.(`reaper: escalating unclaimed PID ${pid}`)
        api.broadcast(escMsg, "health:reaper:unclaimed", undefined, {
          delivery: "push",
          topic: "health:reaper:unclaimed",
        })
      }
      continue
    }
  }
}

// ---------------------------------------------------------------------------
// Full metrics collection
// ---------------------------------------------------------------------------

interface CollectFullMetricsDeps {
  readonly collectOsMetrics?: typeof collectOsMetrics
}

function metricUnavailableNames(observation: Extract<CanonicalHostScalarObservation, { kind: "available" }>): string[] {
  const unavailable: string[] = (["cpu", "disk", "diskIo", "memory", "swap"] as const).filter(
    (name) => observation.values[name].kind === "unavailable",
  )
  if (observation.values.disk.kind === "supported" && observation.values.disk.value.inodes?.kind !== "supported") {
    unavailable.push("disk.inodes")
  }
  return unavailable
}

function canonicalScalarMetrics(
  observation: CanonicalHostScalarObservation,
): Pick<HealthMetrics, "cpu" | "disk" | "diskIo" | "memory" | "scalarObservation" | "timestamp"> {
  if (observation.kind === "unavailable") {
    return {
      cpu: { topProcesses: [] },
      scalarObservation: {
        ...(observation.detail === undefined ? {} : { detail: observation.detail }),
        kind: "canonical-unavailable",
        reason: observation.reason,
      },
      timestamp: Date.now(),
    }
  }
  const { values } = observation
  const bytesPerMB = 1024 * 1024
  const cpu =
    values.cpu.kind === "supported"
      ? {
          coreCount: values.cpu.value.logicalCores,
          loadAvg1m: values.cpu.value.loadAverage1m,
          loadAvg5m: values.cpu.value.loadAverage5m,
          topProcesses: [],
        }
      : { topProcesses: [] }
  const memory =
    values.memory.kind === "supported"
      ? {
          availableMB: Math.round(values.memory.value.availableBytes / bytesPerMB),
          pressurePercent: Math.round((values.memory.value.usedBytes / values.memory.value.totalBytes) * 100),
          ...(values.swap.kind === "supported"
            ? { swapUsedMB: Math.round(values.swap.value.usedBytes / bytesPerMB) }
            : {}),
          totalMB: Math.round(values.memory.value.totalBytes / bytesPerMB),
          usedMB: Math.round(values.memory.value.usedBytes / bytesPerMB),
        }
      : undefined
  const disk = values.disk.kind === "supported" ? values.disk.value : undefined
  const diskIo =
    values.diskIo.kind === "supported"
      ? { readWriteMBps: values.diskIo.value.readWriteBytesPerSecond / bytesPerMB }
      : undefined
  return {
    cpu,
    ...(disk === undefined ? {} : { disk }),
    ...(diskIo === undefined ? {} : { diskIo }),
    ...(memory === undefined ? {} : { memory }),
    scalarObservation: {
      kind: "canonical-available",
      observedAt: observation.observedAt,
      source: observation.source,
      unavailable: metricUnavailableNames(observation),
    },
    timestamp: observation.observedAt,
  }
}

async function readDiskIoMetric(
  processSource: HealthProcessSource,
  metrics: HealthMetrics,
): Promise<HealthMetrics["diskIo"]> {
  if (processSource.kind === "managed") return metrics.diskIo
  const ioProc = Bun.spawn(["iostat", "-d", "-c", "2", "-w", "1"], { stdout: "pipe", stderr: "ignore" })
  return parseIostatOutput(await new Response(ioProc.stdout).text()) ?? undefined
}

function updateDiskIoAlert(
  io: HealthMetrics["diskIo"],
  thresholds: HealthThresholds,
  state: AlertState,
  api: TribeClientApi,
): void {
  if (io && io.readWriteMBps > thresholds.diskIoWarningMBps) {
    state.ioAboveWarning++
    if (state.ioAboveWarning >= 2 && !state.firedAlerts.has("disk-io:warning")) {
      state.firedAlerts.add("disk-io:warning")
      const message = `Disk I/O warning: ${io.readWriteMBps.toFixed(0)} MB/s sustained (threshold: ${thresholds.diskIoWarningMBps} MB/s). Multiple agents may be running tests simultaneously.`
      log.info?.(`alert: ${message}`)
      api.broadcast(message, "health:disk-io:warning", undefined, {
        delivery: "pull",
        topic: "health:disk-io:warning",
      })
    }
    return
  }
  state.ioAboveWarning = 0
  state.firedAlerts.delete("disk-io:warning")
}

export async function collectFullMetrics(
  processSource: HealthProcessSource = createHealthProcessSource(),
  deps: CollectFullMetricsDeps = {},
): Promise<{
  metrics: HealthMetrics
  pidToParent: Map<number, number>
  processObservation: CollectedProcessObservation
}> {
  const [processObservation, scalarObservation] =
    processSource.kind === "managed"
      ? await Promise.all([processSource.read(), processSource.readScalars()])
      : ([{ kind: "standalone-os" }, { kind: "standalone-os" }] as const)
  const hostMetrics: Pick<HealthMetrics, "cpu" | "disk" | "diskIo" | "memory" | "scalarObservation" | "timestamp"> =
    scalarObservation.kind === "standalone-os"
      ? (() => {
          const sampled = (deps.collectOsMetrics ?? collectOsMetrics)()
          return {
            ...sampled,
            cpu: { ...sampled.cpu, topProcesses: [] },
            scalarObservation: {
              kind: "standalone-os" as const,
              unavailable: ["disk.bytes", "disk.inodes"] as const,
            },
          }
        })()
      : canonicalScalarMetrics(scalarObservation)

  let topProcesses: Array<{ pid: number; cpu: number; mem?: number; command: string }> = []
  let bunProcesses: number | undefined
  let swapUsedMB = 0
  let pidToParent = new Map<number, number>()
  let worktrees = 0
  let fdCount: HealthMetrics["fdCount"]
  if (processObservation.kind === "available") {
    const totalBytes =
      scalarObservation.kind === "available" && scalarObservation.values.memory.kind === "supported"
        ? scalarObservation.values.memory.value.totalBytes
        : undefined
    const processMetrics = deriveProcessMetricsFromCanonical(processObservation, process.pid, totalBytes)
    topProcesses = processMetrics.topProcesses
    bunProcesses = processMetrics.bunProcesses
    pidToParent = processMetrics.pidToParent
  }

  try {
    const wtProc = Bun.spawn(["git", "worktree", "list"], { stdout: "pipe", stderr: "ignore" })
    const fdCountOutputPromise =
      processObservation.kind === "standalone-os"
        ? new Response(
            Bun.spawn(["sh", "-c", "lsof -n 2>/dev/null | wc -l"], {
              stdout: "pipe",
              stderr: "ignore",
            }).stdout,
          ).text()
        : Promise.resolve("0")
    const ulimitOutputPromise =
      processObservation.kind === "standalone-os"
        ? new Response(Bun.spawn(["sh", "-c", "ulimit -n"], { stdout: "pipe", stderr: "ignore" }).stdout).text()
        : Promise.resolve("0")
    const psOutput =
      processObservation.kind === "standalone-os"
        ? new Response(
            Bun.spawn(["ps", "-axo", "pid=,ppid=,pgid=,%cpu=,%mem=,command="], {
              stdout: "pipe",
              stderr: "ignore",
            }).stdout,
          ).text()
        : Promise.resolve("")
    const [observedPs, wtOutput, fdCountOutput, ulimitOutput] = await Promise.all([
      psOutput,
      new Response(wtProc.stdout).text().catch(() => ""),
      fdCountOutputPromise.catch(() => "0"),
      ulimitOutputPromise.catch(() => "0"),
    ])
    if (processObservation.kind === "standalone-os") {
      const processMetrics = deriveProcessMetricsFromSnapshot(observedPs, process.pid)
      topProcesses = processMetrics.topProcesses
      bunProcesses = processMetrics.bunProcesses
      pidToParent = processMetrics.pidToParent
    }
    worktrees = parseWorktreeList(wtOutput)

    // File descriptor count
    const lsofCount = parseInt(fdCountOutput.trim(), 10) || 0
    const ulimitN = parseUlimitOutput(ulimitOutput)
    if (ulimitN > 0) {
      const fdInfo = parseFdInfo(lsofCount, ulimitN)
      fdCount = { total: fdInfo.total, perSession: [], limit: fdInfo.limit }
    }
  } catch (err) {
    log.debug?.(`health metric collection failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // macOS swap detection + accurate memory pressure via vm_stat.
  // os.freemem() on Darwin reports only truly-free pages and misses the
  // ~50 GB of inactive/compressed memory that is reclaimable on demand, so
  // it systematically over-reports pressure ("96% used" with 60 GB actually
  // available). Override with vm_stat-derived numbers matching Activity
  // Monitor semantics. See km-tribe.reliability-sweep-0415.
  let memoryOverride: { usedMB: number; availableMB: number; pressurePercent: number } | null = null
  if (processObservation.kind === "standalone-os" && process.platform === "darwin") {
    try {
      const swapProc = Bun.spawn(["sysctl", "vm.swapusage"], { stdout: "pipe", stderr: "ignore" })
      const swapOutput = await new Response(swapProc.stdout).text()
      swapUsedMB = parseSwapUsage(swapOutput)
    } catch {
      // Swap info unavailable — not critical
    }
    try {
      const vmStatProc = Bun.spawn(["vm_stat"], { stdout: "pipe", stderr: "ignore" })
      const vmStatOutput = await new Response(vmStatProc.stdout).text()
      const vm = parseVmStat(vmStatOutput)
      const bytesPerMB = 1024 * 1024
      const toMB = (pages: number): number => Math.round((pages * vm.pageSizeBytes) / bytesPerMB)

      // "Genuinely used" = active + wired + compressed. This is what
      // Activity Monitor shows as "Memory Used".
      const usedMB = toMB(vm.active + vm.wired + vm.compressed)
      // "Available" = free + inactive + speculative. Inactive pages are
      // reclaimable on demand without pressure; speculative is page cache.
      const availableMB = toMB(vm.free + vm.inactive + vm.speculative)
      const totalMB = usedMB + availableMB
      const pressurePercent = totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : 0
      memoryOverride = { usedMB, availableMB, pressurePercent }
    } catch {
      // Fall back to os.freemem() values if vm_stat is unavailable
    }
  }

  return {
    metrics: {
      cpu: {
        ...hostMetrics.cpu,
        topProcesses,
      },
      ...(hostMetrics.memory === undefined
        ? {}
        : {
            memory: {
              ...hostMetrics.memory,
              ...memoryOverride,
              ...(processObservation.kind === "standalone-os" ? { swapUsedMB } : {}),
            },
          }),
      disk: hostMetrics.disk,
      diskIo: hostMetrics.diskIo,
      fdCount,
      ...(bunProcesses === undefined ? {} : { bunProcesses }),
      processObservation:
        processObservation.kind === "standalone-os"
          ? processObservation
          : processObservation.kind === "available"
            ? {
                kind: "canonical-available",
                observedAt: processObservation.observedAt,
                source: processObservation.source,
              }
            : {
                diagnostic: processObservation.diagnostic,
                kind: "canonical-unavailable",
                reason: processObservation.reason,
              },
      scalarObservation: hostMetrics.scalarObservation,
      worktrees,
      timestamp: hostMetrics.timestamp,
    },
    pidToParent,
    processObservation,
  }
}

// ---------------------------------------------------------------------------
// On-demand health snapshot (for tribe_health_check requests)
// ---------------------------------------------------------------------------

export async function getHealthSnapshot(
  processSource: HealthProcessSource = createHealthProcessSource(),
): Promise<HealthMetrics> {
  const { metrics } = await collectFullMetrics(processSource)
  return metrics
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export const healthMonitorPlugin: TribePluginApi = {
  name: "health-monitor",

  available() {
    // Always available — uses only OS APIs
    return true
  },

  start(api: TribeClientApi) {
    const pollIntervalSec = parseInt(process.env.HEALTH_POLL_INTERVAL ?? "10", 10) || 10
    const thresholds = defaultThresholds()
    const alertState = createAlertState()
    const processSource = createHealthProcessSource()

    const ac = new AbortController()
    const timers = createTimers(ac.signal)

    let ghRateSampleCount = 0
    let ioSampleCount = 0
    let chiefPresenceSampleCount = 0
    let lastIoScalarFact: string | undefined

    log.info?.(
      `starting: poll=${pollIntervalSec}s, cpu warn=${thresholds.cpuWarningMultiplier}x crit=${thresholds.cpuCriticalMultiplier}x, mem warn=${thresholds.memWarningPercent}% crit=${thresholds.memCriticalPercent}%`,
    )

    async function sample(): Promise<void> {
      try {
        const { metrics, pidToParent, processObservation } = await collectFullMetrics(processSource)
        const sessions = api.getActiveSessions()
        // Pass active-agent count so process-count threshold scales with the
        // number of connected sessions; alarms tuned for solo dev shouldn't
        // fire on a healthy 4-agent baseline.
        const activeAgentCount = new Set(sessions.map((session) => session.name)).size
        const scalarFact = scalarFactIdentity(metrics.scalarObservation)
        const alerts = evaluateAlerts(metrics, thresholds, alertState, activeAgentCount)

        for (const alert of alerts) {
          const formatted = formatCollectedHealthAlert(alert, processObservation, pidToParent, sessions)
          log.info?.(`alert: ${formatted.message}`)
          deliverHealthAlert(
            api,
            alert,
            formatted.message,
            formatted.attributedSessions,
            formatted.hasUnattributed,
            sessions,
          )
        }

        // --- Chief-authority watchdog (every 3rd sample — ~30s) ---
        // Only the no-live-authority stop-line remains here. Generic online
        // inbox staleness is projected by health cadence and consumed by WATCH.
        chiefPresenceSampleCount++
        if (chiefPresenceSampleCount % 3 === 0) {
          try {
            const unread = api.getUnreadDms("@chief")
            const chiefOnline = sessions.some((s) => s.name === "@chief")
            const chiefAlert = checkChiefAbsent(unread, chiefOnline, alertState)
            if (chiefAlert) {
              log.info?.(`alert: ${chiefAlert.message}`)
              api.broadcast(chiefAlert.message, `health:${chiefAlert.type}:${chiefAlert.severity}`, undefined, {
                delivery: "push",
                topic: `health:${chiefAlert.type}:${chiefAlert.severity}`,
              })
            }
          } catch (err) {
            log.error?.(`chief-absence check failed: ${err instanceof Error ? err.message : String(err)}`)
          }
        }

        // --- Process reaper ---
        await checkCollectedProcessReaper(
          processObservation,
          metrics,
          pidToParent,
          sessions,
          thresholds,
          alertState,
          api,
        )

        // --- Git lock detection (main repo + submodules) ---
        const gitDir = `${process.cwd()}/.git`
        const locks = await detectGitLocks(gitDir)
        const now = Date.now()
        const activeLockPaths = new Set<string>()

        for (const lock of locks) {
          activeLockPaths.add(lock.path)

          // Auto-reap holderless locks: git uses O_EXCL, no holder = stale.
          // Silent + logged on daemon (not broadcast) so reaps are observable
          // for incident analysis without flooding agent channels.
          if (!lock.holder && reapStaleLock(lock, now)) {
            log.info?.(`git-lock reaped: path=${lock.path} label=${lock.label} (no holder)`)
            // Drop tracking for this lock — it's gone.
            alertState.lockFirstSeen.delete(lock.path)
            alertState.lockStaleWarned.delete(lock.path)
            alertState.firedAlerts.delete(`git-lock:${lock.path}`)
            activeLockPaths.delete(lock.path)
            continue
          }

          // Track when we first saw this lock
          if (!alertState.lockFirstSeen.has(lock.path)) {
            alertState.lockFirstSeen.set(lock.path, now)
          }
          const firstSeen = alertState.lockFirstSeen.get(lock.path) ?? now
          const durationMs = now - firstSeen
          const durationSec = Math.round(durationMs / 1000)

          // Attribute to a session if possible
          const sessionName = lock.holder
            ? ownerForLockHolder(lock.holder.pid, processObservation, pidToParent, sessions)
            : null

          // First detection: broadcast lock info. Suppress unattributed locks
          // under the stale threshold — "held by unknown for 10s" is almost
          // always concurrent commits across sessions briefly overlapping the
          // poll window, not a real stuck process. If we CAN attribute the
          // holder (lsof found a known session's PID), warn at the shorter
          // threshold so the owner knows they're blocking the tribe.
          const lockKey = `git-lock:${lock.path}`
          const shouldAlert =
            !alertState.firedAlerts.has(lockKey) &&
            durationMs >= LOCK_ALERT_THRESHOLD_MS &&
            (sessionName != null || durationMs >= LOCK_STALE_THRESHOLD_MS)
          if (shouldAlert) {
            alertState.gitLockDetected = true
            alertState.firedAlerts.add(lockKey)
            const lockMsg = formatLockMessage(lock, sessionName, durationSec)
            log.info?.(`alert: ${lockMsg}`)

            // km-tribe.event-classification: first-detect git-lock is ambient
            // (most are concurrent commits resolving in <30s). The session
            // attributed to the lock still gets a DM so the holder can act —
            // the channel envelope's reply hint is derived at delivery time.
            if (sessionName) {
              for (const recipient of resolveLiveHealthRecipients(
                new Set([sessionName]),
                sessions,
                api.getActiveSessions(),
              )) {
                api.send(recipient, lockMsg, "health:git-lock:warning", undefined, {
                  delivery: "push",
                  topic: "health:git-lock:warning",
                })
              }
            }
            api.broadcast(lockMsg, "health:git-lock:warning", undefined, {
              delivery: "pull",
              topic: "health:git-lock:warning",
            })
          }

          // Stale lock escalation: >30s — actionable, the lock is stuck.
          if (durationMs > LOCK_STALE_THRESHOLD_MS && !alertState.lockStaleWarned.has(lock.path)) {
            alertState.lockStaleWarned.add(lock.path)
            const staleMsg = formatStaleLockMessage(lock, sessionName, durationMs / 1000)
            log.info?.(`alert: ${staleMsg}`)
            api.broadcast(staleMsg, "health:git-lock:warning", undefined, {
              delivery: "push",
              topic: "health:git-lock:stale",
            })
          }
        }

        // Clean up tracking for released locks
        for (const [path] of alertState.lockFirstSeen) {
          if (!activeLockPaths.has(path)) {
            alertState.lockFirstSeen.delete(path)
            alertState.lockStaleWarned.delete(path)
            alertState.firedAlerts.delete(`git-lock:${path}`)
          }
        }
        if (locks.length === 0 && alertState.gitLockDetected) {
          alertState.gitLockDetected = false
        }

        // --- Disk I/O saturation (every 3rd sample — ~30s) ---
        ioSampleCount++
        if (ioSampleCount % 3 === 0) {
          try {
            const evaluateIo = scalarFact === undefined || scalarFact !== lastIoScalarFact
            if (scalarFact !== undefined && evaluateIo) lastIoScalarFact = scalarFact
            if (evaluateIo) {
              updateDiskIoAlert(await readDiskIoMetric(processSource, metrics), thresholds, alertState, api)
            }
          } catch {
            // iostat not available — skip silently
          }
        }

        // --- GitHub API rate limit (every 5th sample — ~50s) ---
        ghRateSampleCount++
        if (ghRateSampleCount % 5 === 0) {
          try {
            const ghProc = Bun.spawn(["gh", "api", "rate_limit"], { stdout: "pipe", stderr: "ignore" })
            const ghOutput = await new Response(ghProc.stdout).text()
            const rateLimit = parseGhRateLimit(ghOutput)
            if (rateLimit) {
              const usagePercent = ((rateLimit.limit - rateLimit.remaining) / rateLimit.limit) * 100
              const remainingPercent = 100 - usagePercent
              if (
                remainingPercent < thresholds.ghRateLimitWarning &&
                !alertState.firedAlerts.has("gh-rate-limit:warning")
              ) {
                alertState.firedAlerts.add("gh-rate-limit:warning")
                const resetIn = Math.max(0, Math.round((rateLimit.resetAt * 1000 - Date.now()) / 60000))
                const msg = `GitHub API rate limit warning: ${rateLimit.remaining}/${rateLimit.limit} remaining (${Math.round(remainingPercent)}%). Resets in ${resetIn}min.`
                log.info?.(`alert: ${msg}`)
                api.broadcast(msg, "health:gh-rate-limit:warning", undefined, {
                  delivery: "push",
                  topic: "health:gh-rate-limit:warning",
                })
              } else if (remainingPercent >= thresholds.ghRateLimitWarning) {
                alertState.firedAlerts.delete("gh-rate-limit:warning")
              }
            }
          } catch {
            // gh not available — skip silently
          }
        }
      } catch (err) {
        log.error?.(`sample failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // Initial sample after a short delay (let daemon finish startup)
    timers.setTimeout(() => void sample(), 2_000)

    // Regular sampling
    timers.setInterval(() => void sample(), pollIntervalSec * 1000)

    return () => ac.abort()
  },

  instructions() {
    return "- Health monitoring active: CPU, memory, process count, disk space, disk I/O, worktree count, file descriptor count, GitHub API rate limit, git lock alerts, and process reaper are broadcast automatically. To claim a process the reaper is targeting, reply with 'reaper:claim PID <pid>'."
  },
}
