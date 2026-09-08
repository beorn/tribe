import { dirname, join } from "node:path"
import {
  BoundedProcessCommandError,
  runBoundedProcessCommand,
  type BoundedProcessCommandResult,
} from "../../../recall/src/lib/bounded-process.ts"

const PROCESS_OBSERVATION_SCHEMA = "process-observation/1" as const
const HOST_SCALAR_OBSERVATION_SCHEMA = "host-scalar-observation/1" as const
const DEFAULT_MAX_AGE_MS = 90_000
const MAX_COMMAND_CHARS = 512
const MAX_DIAGNOSTIC_CHARS = 1_024
const MAX_ROUTING_TEXT_CHARS = 256
const EXCLUDED_FALLBACKS = ["standalone-os-resample", "cross-batch-attribution", "implicit-unowned"] as const
const OBSERVATION_QUERY = "latest exact process census with owner attribution"

/**
 * Bounds for the managed `hab sysmon snapshot` child.
 *
 * Live specimen 2026-08-13: health-monitor `sample()` every HEALTH_POLL_INTERVAL
 * (default 10s) called `createHealthProcessSource().read()` + `readScalars()` in
 * parallel. Each spawned `hab sysmon snapshot --state-root <sessions>` and then
 * the parent did unbounded `Response(stdout).text()`. Under a multi-GB
 * `run/sessions/habmod` habcp journal the child burned ~1.5GB rchar per spawn
 * for several seconds (State R), the parent slurped the same stream, and the
 * daemon event loop starved — every RPC (cli_health, pending, inbox-status)
 * timed out. Valid process-observation/1 is ONE JSON line (KB-scale). Anything
 * larger or slower is a pathological journal walk, not a useful census.
 *
 * These bounds are code-enforced (not config-optional): a knob that reopens the
 * multi-GB slurper is how the defect returns. HEALTH_POLL_INTERVAL only sets
 * how often we *attempt*; the circuit below stops re-attempting after failure.
 */
export const SYSMON_COMMAND_TIMEOUT_MS = 2_500
const SYSMON_KILL_GRACE_MS = 2_000
const SYSMON_REAP_GRACE_MS = 2_000
const SYSMON_DRAIN_GRACE_MS = 2_500
/** One JSON line of process-observation/1; 256 KiB is already generous. */
export const SYSMON_MAX_OUTPUT_BYTES = 256 * 1024
/** Consecutive hard failures (timeout / oversized output / uncertain settlement) before opening the circuit. */
export const SYSMON_CIRCUIT_FAILURES = 2
/** How long the circuit stays open — 6× default 10s poll, not forever. */
export const SYSMON_CIRCUIT_OPEN_MS = 60_000
const ROUTING_VIAS = new Set(["env", "reactive", "root", "tree"])
const SCALAR_PLATFORMS = new Set([
  "aix",
  "android",
  "cygwin",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "netbsd",
  "openbsd",
  "sunos",
  "win32",
])
const SCALAR_UNAVAILABLE_REASONS = new Set([
  "counter-reset",
  "mount-changed",
  "not-reported",
  "provider-error",
  "unsupported-on-filesystem",
  "unsupported-on-platform",
  "unresolvable-device",
  "warming-up",
])

export type ProcessRoutingAttribution =
  | { readonly kind: "exempt" | "owned"; readonly ownerId: string; readonly via: string }
  | { readonly kind: "unowned" }
  | {
      readonly evidence: {
        readonly ownerCount: number
        readonly ownerIds: readonly string[]
        readonly vias: readonly string[]
      }
      readonly kind: "unknown"
      readonly reason: string
    }

export interface ProcessObservationRow {
  readonly attribution: ProcessRoutingAttribution
  readonly process: {
    readonly command: string
    readonly cpuPercent?: number
    readonly pgid: number
    readonly pid: number
    readonly ppid: number
    readonly rssBytes?: number
    readonly startTime: string
    readonly startTimeResolutionMs?: number
  }
}

export type CanonicalProcessObservation =
  | {
      readonly diagnostic: {
        readonly excluded: readonly string[]
        readonly location: string
        readonly query: string
      }
      readonly kind: "available"
      readonly observedAt: number
      readonly processes: readonly ProcessObservationRow[]
      readonly schema: typeof PROCESS_OBSERVATION_SCHEMA
      readonly source: { readonly epoch: string; readonly sequence: number }
    }
  | {
      readonly diagnostic: {
        readonly detail?: string
        readonly excluded: readonly string[]
        readonly location: string
        readonly query: string
      }
      readonly kind: "unavailable"
      readonly reason: string
      readonly schema: typeof PROCESS_OBSERVATION_SCHEMA
    }

type ScalarUnavailableMetric = {
  readonly detail?: string
  readonly kind: "unavailable"
  readonly metric: "cpu" | "disk" | "disk.inodes" | "diskIo" | "memory" | "swap"
  readonly platform: string
  readonly reason: string
}

type ScalarMetric<Name extends ScalarUnavailableMetric["metric"], Value> =
  | { readonly kind: "supported"; readonly value: Value }
  | (ScalarUnavailableMetric & { readonly metric: Name })

export type CanonicalHostScalarObservation =
  | {
      readonly kind: "available"
      readonly observedAt: number
      readonly schema: typeof HOST_SCALAR_OBSERVATION_SCHEMA
      readonly source: { readonly epoch: string; readonly sequence: number }
      readonly values: {
        readonly cpu: ScalarMetric<
          "cpu",
          {
            readonly busyPercent?: number
            readonly loadAverage1m: number
            readonly loadAverage5m: number
            readonly loadAverage15m: number
            readonly logicalCores: number
          }
        >
        readonly disk: ScalarMetric<
          "disk",
          {
            readonly availableBytes: number
            readonly freeBytes: number
            readonly inodes?: ScalarMetric<
              "disk.inodes",
              { readonly free: number; readonly total: number; readonly used: number }
            >
            readonly path: string
            readonly totalBytes: number
            readonly usedBytes: number
          }
        >
        readonly diskIo: ScalarMetric<"diskIo", { readonly readWriteBytesPerSecond: number }>
        readonly kind: "host:scalars"
        readonly memory: ScalarMetric<
          "memory",
          { readonly availableBytes: number; readonly totalBytes: number; readonly usedBytes: number }
        >
        readonly sampleBudgetMs: number
        readonly sampleDurationMs: number
        readonly sampleOverBudget: boolean
        readonly swap: ScalarMetric<
          "swap",
          { readonly freeBytes: number; readonly totalBytes: number; readonly usedBytes: number }
        >
      }
    }
  | {
      readonly detail?: string
      readonly kind: "unavailable"
      readonly reason: string
      readonly schema: typeof HOST_SCALAR_OBSERVATION_SCHEMA
    }

export type HealthProcessSource =
  | { readonly kind: "standalone-os" }
  /**
   * Under hab, but without the configuration needed to read its journal.
   *
   * This is NOT `standalone-os` and the difference is the whole defect it
   * exists to end: `standalone-os` means no journal EXISTS, which is honest and
   * must stay silent, while this means a journal probably exists and we cannot
   * reach it, which must be LOUD. One value naming both is why every
   * scalar-backed alert on this host was silent for the life of the monitor.
   */
  | { readonly kind: "misconfigured"; readonly reason: string }
  | {
      readonly kind: "managed"
      readonly read: () => Promise<CanonicalProcessObservation>
      readonly readScalars: () => Promise<CanonicalHostScalarObservation>
    }

export interface HealthProcessSourceOptions {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly maxAgeMs?: number
  /** Injected clock for circuit-breaker tests. */
  readonly now?: () => number
  readonly commandTimeoutMs?: number
  readonly maxOutputBytes?: number
  readonly circuitFailures?: number
  readonly circuitOpenMs?: number
  /**
   * Test seam. Production uses Tribe's shared bounded process-tree runner.
   * Injected doubles may throw BoundedProcessCommandError.
   */
  readonly runCommand?: (argv: readonly string[]) => Promise<BoundedProcessCommandResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isBoundedText(value: unknown, maxChars = MAX_ROUTING_TEXT_CHARS): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxChars
}

function hasExactDiagnostic(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.query === OBSERVATION_QUERY &&
    isBoundedText(value.location, MAX_DIAGNOSTIC_CHARS) &&
    Array.isArray(value.excluded) &&
    value.excluded.length === EXCLUDED_FALLBACKS.length &&
    value.excluded.every((item, index) => item === EXCLUDED_FALLBACKS[index])
  )
}

function isAttribution(value: unknown): value is ProcessRoutingAttribution {
  if (!isRecord(value) || typeof value.kind !== "string") return false
  if (value.kind === "unowned") return true
  if (value.kind === "owned" || value.kind === "exempt") {
    return isBoundedText(value.ownerId) && typeof value.via === "string" && ROUTING_VIAS.has(value.via)
  }
  if (value.kind !== "unknown" || !isBoundedText(value.reason) || !isRecord(value.evidence)) return false
  return (
    Number.isSafeInteger(value.evidence.ownerCount) &&
    (value.evidence.ownerCount as number) >= 0 &&
    isStringArray(value.evidence.ownerIds) &&
    value.evidence.ownerIds.length <= 8 &&
    value.evidence.ownerIds.every((ownerId) => isBoundedText(ownerId)) &&
    (value.evidence.ownerCount as number) >= value.evidence.ownerIds.length &&
    new Set(value.evidence.ownerIds).size === value.evidence.ownerIds.length &&
    isStringArray(value.evidence.vias) &&
    value.evidence.vias.length <= ROUTING_VIAS.size &&
    value.evidence.vias.every((via) => ROUTING_VIAS.has(via)) &&
    new Set(value.evidence.vias).size === value.evidence.vias.length
  )
}

function isProcess(value: unknown): value is ProcessObservationRow["process"] {
  return (
    isRecord(value) &&
    isPositiveInteger(value.pid) &&
    Number.isSafeInteger(value.ppid) &&
    (value.ppid as number) >= 0 &&
    isPositiveInteger(value.pgid) &&
    typeof value.startTime === "string" &&
    value.startTime.length > 0 &&
    typeof value.command === "string" &&
    value.command.length > 0 &&
    value.command.length <= MAX_COMMAND_CHARS &&
    (value.cpuPercent === undefined || isFiniteNonNegative(value.cpuPercent)) &&
    (value.rssBytes === undefined || (Number.isSafeInteger(value.rssBytes) && (value.rssBytes as number) >= 0)) &&
    (value.startTimeResolutionMs === undefined ||
      (isFiniteNonNegative(value.startTimeResolutionMs) && value.startTimeResolutionMs > 0))
  )
}

function parseObservation(value: unknown): CanonicalProcessObservation | undefined {
  if (!isRecord(value) || value.schema !== PROCESS_OBSERVATION_SCHEMA || typeof value.kind !== "string") {
    return undefined
  }
  if (value.kind === "unavailable") {
    if (
      !isBoundedText(value.reason) ||
      !hasExactDiagnostic(value.diagnostic) ||
      (value.diagnostic.detail !== undefined &&
        (typeof value.diagnostic.detail !== "string" || value.diagnostic.detail.length > MAX_DIAGNOSTIC_CHARS))
    ) {
      return undefined
    }
    return value as CanonicalProcessObservation
  }
  if (
    value.kind !== "available" ||
    !hasExactDiagnostic(value.diagnostic) ||
    !isFiniteNonNegative(value.observedAt) ||
    !isRecord(value.source) ||
    typeof value.source.epoch !== "string" ||
    value.source.epoch.length === 0 ||
    !isPositiveInteger(value.source.sequence) ||
    !Array.isArray(value.processes)
  ) {
    return undefined
  }
  const identities = new Set<string>()
  const pids = new Set<number>()
  for (const row of value.processes) {
    if (!isRecord(row) || !isProcess(row.process) || !isAttribution(row.attribution)) return undefined
    const identity = `${row.process.pid}\0${row.process.startTime}`
    if (identities.has(identity) || pids.has(row.process.pid)) return undefined
    identities.add(identity)
    pids.add(row.process.pid)
  }
  return value as CanonicalProcessObservation
}

function isUnavailableScalarMetric(value: unknown, metric: string): boolean {
  return (
    isRecord(value) &&
    value.kind === "unavailable" &&
    value.metric === metric &&
    isBoundedText(value.platform) &&
    SCALAR_PLATFORMS.has(value.platform) &&
    isBoundedText(value.reason) &&
    SCALAR_UNAVAILABLE_REASONS.has(value.reason) &&
    (value.detail === undefined || typeof value.detail === "string")
  )
}

function isSupportedScalarMetric(value: unknown, validate: (metric: Record<string, unknown>) => boolean): boolean {
  return isRecord(value) && value.kind === "supported" && isRecord(value.value) && validate(value.value)
}

function isScalarMetric(value: unknown, metric: ScalarUnavailableMetric["metric"]): boolean {
  if (isUnavailableScalarMetric(value, metric)) return true
  if (metric === "disk.inodes") {
    return isSupportedScalarMetric(
      value,
      ({ free, total, used }) =>
        isNonNegativeInteger(free) && isNonNegativeInteger(used) && isPositiveInteger(total) && free + used === total,
    )
  }
  if (metric === "cpu") {
    return isSupportedScalarMetric(
      value,
      (item) =>
        (item.busyPercent === undefined || (isFiniteNonNegative(item.busyPercent) && item.busyPercent <= 100)) &&
        isFiniteNonNegative(item.loadAverage1m) &&
        isFiniteNonNegative(item.loadAverage5m) &&
        isFiniteNonNegative(item.loadAverage15m) &&
        isPositiveInteger(item.logicalCores),
    )
  }
  if (metric === "disk") {
    return isSupportedScalarMetric(
      value,
      (item) =>
        isNonNegativeInteger(item.availableBytes) &&
        isNonNegativeInteger(item.freeBytes) &&
        isBoundedText(item.path, MAX_DIAGNOSTIC_CHARS) &&
        isNonNegativeInteger(item.totalBytes) &&
        item.totalBytes > 0 &&
        isNonNegativeInteger(item.usedBytes) &&
        item.availableBytes <= item.totalBytes &&
        item.availableBytes <= item.freeBytes &&
        item.freeBytes <= item.totalBytes &&
        item.usedBytes <= item.totalBytes &&
        item.freeBytes + item.usedBytes === item.totalBytes &&
        (item.inodes === undefined || isScalarMetric(item.inodes, "disk.inodes")),
    )
  }
  if (metric === "diskIo") {
    return isSupportedScalarMetric(value, (item) => isFiniteNonNegative(item.readWriteBytesPerSecond))
  }
  if (metric === "memory") {
    return isSupportedScalarMetric(
      value,
      (item) =>
        isNonNegativeInteger(item.availableBytes) &&
        isNonNegativeInteger(item.totalBytes) &&
        item.totalBytes > 0 &&
        isNonNegativeInteger(item.usedBytes) &&
        item.availableBytes <= item.totalBytes &&
        item.usedBytes <= item.totalBytes &&
        item.availableBytes + item.usedBytes === item.totalBytes,
    )
  }
  return isSupportedScalarMetric(
    value,
    (item) =>
      isFiniteNonNegative(item.freeBytes) &&
      isFiniteNonNegative(item.totalBytes) &&
      isFiniteNonNegative(item.usedBytes) &&
      item.freeBytes <= item.totalBytes &&
      item.usedBytes <= item.totalBytes &&
      Math.abs(item.totalBytes - item.freeBytes - item.usedBytes) <= 1,
  )
}

function parseScalarObservation(value: unknown): CanonicalHostScalarObservation | undefined {
  if (!isRecord(value) || value.schema !== HOST_SCALAR_OBSERVATION_SCHEMA || typeof value.kind !== "string") {
    return undefined
  }
  if (value.kind === "unavailable") {
    return isBoundedText(value.reason) &&
      (value.detail === undefined || (typeof value.detail === "string" && value.detail.length <= MAX_DIAGNOSTIC_CHARS))
      ? (value as CanonicalHostScalarObservation)
      : undefined
  }
  if (
    value.kind !== "available" ||
    !isFiniteNonNegative(value.observedAt) ||
    !isRecord(value.source) ||
    !isBoundedText(value.source.epoch) ||
    !isPositiveInteger(value.source.sequence) ||
    !isRecord(value.values) ||
    value.values.kind !== "host:scalars" ||
    !isFiniteNonNegative(value.values.sampleBudgetMs) ||
    !isFiniteNonNegative(value.values.sampleDurationMs) ||
    typeof value.values.sampleOverBudget !== "boolean" ||
    !isScalarMetric(value.values.cpu, "cpu") ||
    !isScalarMetric(value.values.disk, "disk") ||
    !isScalarMetric(value.values.diskIo, "diskIo") ||
    !isScalarMetric(value.values.memory, "memory") ||
    !isScalarMetric(value.values.swap, "swap")
  ) {
    return undefined
  }
  return value as CanonicalHostScalarObservation
}

function unavailable(
  sessionDir: string,
  reason: string,
  detail?: string,
): Extract<CanonicalProcessObservation, { kind: "unavailable" }> {
  return {
    diagnostic: {
      ...(detail === undefined || detail === "" ? {} : { detail: detail.slice(0, MAX_DIAGNOSTIC_CHARS) }),
      excluded: EXCLUDED_FALLBACKS,
      location: sessionDir,
      query: OBSERVATION_QUERY,
    },
    kind: "unavailable",
    reason,
    schema: PROCESS_OBSERVATION_SCHEMA,
  }
}

function scalarUnavailable(
  checkedPath: string,
  reason: string,
  detail?: string,
): Extract<CanonicalHostScalarObservation, { kind: "unavailable" }> {
  // GATE 3: blindness NAMES THE PATH IT CHECKED. The process-side `unavailable`
  // has carried `location` all along; the scalar side carried only a reason, so
  // a scalar outage could say it found nothing and never say WHERE it looked.
  // That mattered less while the location was derived in-process from a
  // variable the reader could inspect themselves. Now that the journal root is
  // INJECTED, "where did you look" is the first question a reader has, and an
  // answer that omits it sends them back to guessing — the failure this whole
  // change exists to end (@i/4-supervision/24248, @cto gate 3).
  const located = `at=${checkedPath}${detail === undefined || detail === "" ? "" : ` ${detail}`}`
  return {
    detail: located.slice(0, MAX_DIAGNOSTIC_CHARS),
    kind: "unavailable",
    reason,
    schema: HOST_SCALAR_OBSERVATION_SCHEMA,
  }
}

function mapCommandError(error: unknown): { reason: string; detail: string } {
  if (error instanceof BoundedProcessCommandError) {
    if (error.failure.kind === "timeout") {
      return { reason: "source-command-timeout", detail: error.failure.message }
    }
    if (error.failure.kind === "output-too-large") {
      return { reason: "source-output-too-large", detail: error.failure.message }
    }
    if (error.failure.kind === "settlement-failed") {
      return { reason: "source-command-settlement-failed", detail: error.failure.message }
    }
    return { reason: "source-command-failed", detail: error.failure.message }
  }
  return { reason: "source-command-failed", detail: error instanceof Error ? error.message : String(error) }
}

/** Hard failures that mean "do not re-pay multi-GB journal walks every poll". */
function isCircuitFailure(reason: string): boolean {
  return (
    reason === "source-command-timeout" ||
    reason === "source-output-too-large" ||
    reason === "source-command-settlement-failed"
  )
}

/**
 * Variables that prove hab launched this process, WITHOUT proving it is
 * hab-managed. `sanitizeStandaloneDaemonEnvironment` deliberately strips the
 * management markers (`HAB_SESSION_DIR`, `HAB_SERVICE_KIND`, `HAB_SERVICE_NAME`)
 * and leaves these, so these are exactly the evidence that hab is present when
 * the management markers are gone.
 */
export const HAB_SESSION_MARKERS = [
  "HAB_SESSION_HABITAT_ROOT",
  "HAB_SESSION_LAUNCH_ID",
  "HAB_SESSION_INSTRUCTION_ANCHOR",
] as const

export function createHealthProcessSource(options: HealthProcessSourceOptions = {}): HealthProcessSource {
  const env = options.env ?? process.env
  const sessionDir = env.HAB_SESSION_DIR?.trim()
  // THE JOURNAL ROOT, INJECTED, and deliberately not a member of the
  // `HAB_SESSION_*` family. `HAB_SESSION_DIR` answered two unrelated questions
  // — "am I hab-MANAGED" (lifecycle) and "where is the journal" (access) — and
  // the standalone sanitizer strips it for the lifecycle answer, correctly, so
  // a daemon cannot inherit hab's idle-quit and never retire. Severing journal
  // access was the side effect. Hab now derives this value through
  // `habdSessionPaths`, the same owner habmod uses to decide where to WRITE,
  // and hands it over; the consumer resolves nothing and spells no layout.
  const injectedJournalDir = env.HAB_SCALAR_JOURNAL_DIR?.trim()
  if (!sessionDir && injectedJournalDir) {
    return managedProcessSource(injectedJournalDir, options, env)
  }
  if (!sessionDir) {
    // CONTRADICTORY ENVIRONMENT. hab session markers are present and the one
    // variable this source needs is not. That is never a healthy standalone,
    // whatever put it in that state, so it is reported rather than absorbed.
    //
    // Measured 2026-09-07: the live daemon carried HAB_SESSION_HABITAT_ROOT,
    // HAB_SESSION_LAUNCH_ID and HAB_SESSION_INSTRUCTION_ANCHOR and no
    // HAB_SESSION_DIR among 84 variables, because
    // `sanitizeStandaloneDaemonEnvironment` strips it before minting a
    // standalone supervisor — CORRECTLY, so the daemon cannot inherit hab's
    // idle-quit marker and never retire. The strip is right. Reading a
    // LIFECYCLE answer as the answer to a JOURNAL-ACCESS question is the bug.
    const present = HAB_SESSION_MARKERS.filter((name) => env[name]?.trim())
    if (present.length > 0) {
      return {
        kind: "misconfigured",
        reason:
          `hab session markers are set (${present.join(", ")}) but HAB_SESSION_DIR is not, ` +
          "so this daemon is under hab and cannot locate its journal. It is NOT standalone: " +
          "standalone means no journal exists. Host scalars — disk, memory, cpu, fd-count — are " +
          "all unreadable for this one reason (@i/4-supervision/24233).",
      }
    }
    return { kind: "standalone-os" }
  }
  if (!env.HAB_SERVICE_KIND?.trim()) return { kind: "standalone-os" }
  // The legacy path keeps its own derivation, per the precedence rule: an
  // environment that still carries `HAB_SESSION_DIR` behaves exactly as it did
  // before this change. The `habmod` literal survives HERE and only here; it
  // leaves the moment this branch can be retired, once every launcher injects.
  return managedProcessSource(join(dirname(sessionDir), "habmod"), options, env)
}

/**
 * The managed source, given the controller session directory it should read.
 *
 * Taking the RESOLVED directory as a parameter is what lets the injected path
 * and the legacy path share one implementation: there is no second copy of the
 * read logic to drift, and the caller decides where the journal is.
 */
function managedProcessSource(
  controllerSessionDir: string,
  options: HealthProcessSourceOptions,
  env: NodeJS.ProcessEnv,
): HealthProcessSource {
  const stateRoot = dirname(controllerSessionDir)
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const now = options.now ?? Date.now
  const timeoutMs = options.commandTimeoutMs ?? SYSMON_COMMAND_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? SYSMON_MAX_OUTPUT_BYTES
  const circuitFailures = options.circuitFailures ?? SYSMON_CIRCUIT_FAILURES
  const circuitOpenMs = options.circuitOpenMs ?? SYSMON_CIRCUIT_OPEN_MS
  const runCommand =
    options.runCommand ?? ((argv: readonly string[]) => runHealthProcessCommand(argv, timeoutMs, maxOutputBytes))

  // Shared across read() and readScalars(): both walk the same state-root.
  let consecutiveHardFailures = 0
  let circuitOpenUntilMs = 0

  function circuitBlocks(): string | null {
    const t = now()
    if (t < circuitOpenUntilMs) {
      return `sysmon circuit open for ${Math.max(0, circuitOpenUntilMs - t)}ms after hard failures (timeout/oversize/settlement)`
    }
    return null
  }

  function noteSuccess(): void {
    consecutiveHardFailures = 0
    circuitOpenUntilMs = 0
  }

  function noteFailure(reason: string): void {
    if (!isCircuitFailure(reason)) return
    consecutiveHardFailures += 1
    if (consecutiveHardFailures >= circuitFailures) {
      circuitOpenUntilMs = now() + circuitOpenMs
      consecutiveHardFailures = 0
    }
  }

  async function invoke(
    argv: readonly string[],
  ): Promise<{ ok: true; result: BoundedProcessCommandResult } | { ok: false; reason: string; detail: string }> {
    const blocked = circuitBlocks()
    if (blocked !== null) return { ok: false, reason: "source-circuit-open", detail: blocked }
    try {
      const result = await runCommand(argv)
      noteSuccess()
      return { ok: true, result }
    } catch (error) {
      const mapped = mapCommandError(error)
      noteFailure(mapped.reason)
      return { ok: false, ...mapped }
    }
  }

  return {
    kind: "managed",
    async read() {
      const argv = ["hab", "sysmon", "snapshot", "--state-root", stateRoot, "--max-age-ms", String(maxAgeMs), "--json"]
      const invoked = await invoke(argv)
      if (!invoked.ok) return unavailable(controllerSessionDir, invoked.reason, invoked.detail)
      const result = invoked.result
      const lines = result.stdout.trim().split("\n").filter(Boolean)
      if (lines.length === 1) {
        try {
          const line = lines[0]
          if (line === undefined) return unavailable(controllerSessionDir, "source-protocol-invalid")
          const parsed = parseObservation(JSON.parse(line))
          if (parsed !== undefined && (result.exitCode === 0 || parsed.kind === "unavailable")) return parsed
        } catch {
          // silent-fallback-allow: parse failure falls through to typed unavailable
        }
      }
      if (result.exitCode !== 0) {
        return unavailable(
          controllerSessionDir,
          "source-command-failed",
          `exit=${result.exitCode}${result.stderr.trim() === "" ? "" : ` stderr=${result.stderr.trim()}`}`,
        )
      }
      return unavailable(
        controllerSessionDir,
        "source-protocol-invalid",
        "command did not emit one valid process-observation/1 row",
      )
    },
    async readScalars() {
      const argv = [
        "hab",
        "sysmon",
        "snapshot",
        "--state-root",
        stateRoot,
        "--kind",
        "scalars",
        "--max-age-ms",
        String(maxAgeMs),
        "--json",
      ]
      const invoked = await invoke(argv)
      if (!invoked.ok) return scalarUnavailable(controllerSessionDir, invoked.reason, invoked.detail)
      const result = invoked.result
      const lines = result.stdout.trim().split("\n").filter(Boolean)
      if (lines.length === 1) {
        try {
          const line = lines[0]
          if (line === undefined) return scalarUnavailable(controllerSessionDir, "source-protocol-invalid")
          const parsed = parseScalarObservation(JSON.parse(line))
          if (parsed !== undefined && (result.exitCode === 0 || parsed.kind === "unavailable")) return parsed
        } catch {
          // silent-fallback-allow: parse failure falls through to typed unavailable
        }
      }
      if (result.exitCode !== 0) {
        return scalarUnavailable(
          controllerSessionDir,
          "source-command-failed",
          `exit=${result.exitCode}${result.stderr.trim() === "" ? "" : ` stderr=${result.stderr.trim()}`}`,
        )
      }
      return scalarUnavailable(
        controllerSessionDir,
        "source-protocol-invalid",
        "command did not emit one valid host-scalar-observation/1 row",
      )
    },
  }
}

function runHealthProcessCommand(
  argv: readonly string[],
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<BoundedProcessCommandResult> {
  return runBoundedProcessCommand(argv, {
    timeoutMs,
    maxOutputBytes,
    killGraceMs: SYSMON_KILL_GRACE_MS,
    reapGraceMs: SYSMON_REAP_GRACE_MS,
    drainGraceMs: SYSMON_DRAIN_GRACE_MS,
  })
}
