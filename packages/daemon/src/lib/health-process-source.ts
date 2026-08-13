import { dirname, join } from "node:path"

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
/** One JSON line of process-observation/1; 256 KiB is already generous. */
export const SYSMON_MAX_OUTPUT_BYTES = 256 * 1024
/** Consecutive hard failures (timeout / oversized output) before opening the circuit. */
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
  | {
      readonly kind: "managed"
      readonly read: () => Promise<CanonicalProcessObservation>
      readonly readScalars: () => Promise<CanonicalHostScalarObservation>
    }

export type ManagedSysmonCommandResult = {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

export type ManagedSysmonCommandFailure = {
  readonly kind: "timeout" | "output-too-large" | "spawn-failed"
  readonly message: string
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
   * Test seam. Production uses `runBoundedProcessCommand` which kills the child
   * on timeout/oversize. Injected doubles may throw `ManagedSysmonCommandError`.
   */
  readonly runCommand?: (argv: readonly string[]) => Promise<ManagedSysmonCommandResult>
}

/** Thrown by the bounded runner (and accepted from injects) so callers map to typed unavailable reasons. */
export class ManagedSysmonCommandError extends Error {
  readonly failure: ManagedSysmonCommandFailure
  constructor(failure: ManagedSysmonCommandFailure) {
    super(failure.message)
    this.name = "ManagedSysmonCommandError"
    this.failure = failure
  }
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
  reason: string,
  detail?: string,
): Extract<CanonicalHostScalarObservation, { kind: "unavailable" }> {
  return {
    ...(detail === undefined || detail === "" ? {} : { detail: detail.slice(0, MAX_DIAGNOSTIC_CHARS) }),
    kind: "unavailable",
    reason,
    schema: HOST_SCALAR_OBSERVATION_SCHEMA,
  }
}

async function readStreamBounded(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  if (stream === null) return { text: "", truncated: false }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        return { text: "", truncated: true }
      }
      chunks.push(value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // already cancelled or released
    }
  }
  if (chunks.length === 0) return { text: "", truncated: false }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { text: new TextDecoder().decode(merged), truncated: false }
}

/**
 * Spawn `argv`, kill on wall-clock timeout or stdout/stderr oversize, never
 * materialise multi-GB streams into a single string.
 */
export async function runBoundedProcessCommand(
  argv: readonly string[],
  bounds: { readonly timeoutMs: number; readonly maxOutputBytes: number } = {
    timeoutMs: SYSMON_COMMAND_TIMEOUT_MS,
    maxOutputBytes: SYSMON_MAX_OUTPUT_BYTES,
  },
): Promise<ManagedSysmonCommandResult> {
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn([...argv], { stderr: "pipe", stdout: "pipe" })
  } catch (error) {
    throw new ManagedSysmonCommandError({
      kind: "spawn-failed",
      message: error instanceof Error ? error.message : String(error),
    })
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      child.kill()
    } catch {
      // already exited
    }
  }, bounds.timeoutMs)
  ;(timer as { unref?: () => void }).unref?.()

  try {
    const [exitCode, stdoutRead, stderrRead] = await Promise.all([
      child.exited,
      readStreamBounded(child.stdout, bounds.maxOutputBytes),
      readStreamBounded(child.stderr, bounds.maxOutputBytes),
    ])
    if (timedOut) {
      throw new ManagedSysmonCommandError({
        kind: "timeout",
        message: `sysmon snapshot exceeded ${bounds.timeoutMs}ms (killed)`,
      })
    }
    if (stdoutRead.truncated || stderrRead.truncated) {
      try {
        child.kill()
      } catch {
        // already exited
      }
      throw new ManagedSysmonCommandError({
        kind: "output-too-large",
        message: `sysmon snapshot exceeded ${bounds.maxOutputBytes} byte stdout/stderr bound (killed)`,
      })
    }
    return { exitCode, stdout: stdoutRead.text, stderr: stderrRead.text }
  } finally {
    clearTimeout(timer)
  }
}

function mapCommandError(error: unknown): { reason: string; detail: string } {
  if (error instanceof ManagedSysmonCommandError) {
    if (error.failure.kind === "timeout") {
      return { reason: "source-command-timeout", detail: error.failure.message }
    }
    if (error.failure.kind === "output-too-large") {
      return { reason: "source-output-too-large", detail: error.failure.message }
    }
    return { reason: "source-command-failed", detail: error.failure.message }
  }
  return { reason: "source-command-failed", detail: error instanceof Error ? error.message : String(error) }
}

/** Hard failures that mean "do not re-pay multi-GB journal walks every poll". */
function isCircuitFailure(reason: string): boolean {
  return reason === "source-command-timeout" || reason === "source-output-too-large"
}

export function createHealthProcessSource(options: HealthProcessSourceOptions = {}): HealthProcessSource {
  const env = options.env ?? process.env
  const sessionDir = env.HAB_SESSION_DIR?.trim()
  if (!sessionDir || !env.HAB_SERVICE_KIND?.trim()) return { kind: "standalone-os" }
  const stateRoot = dirname(sessionDir)
  const controllerSessionDir = join(stateRoot, "habmod")
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const now = options.now ?? Date.now
  const timeoutMs = options.commandTimeoutMs ?? SYSMON_COMMAND_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? SYSMON_MAX_OUTPUT_BYTES
  const circuitFailures = options.circuitFailures ?? SYSMON_CIRCUIT_FAILURES
  const circuitOpenMs = options.circuitOpenMs ?? SYSMON_CIRCUIT_OPEN_MS
  const runCommand =
    options.runCommand ??
    ((argv: readonly string[]) => runBoundedProcessCommand(argv, { timeoutMs, maxOutputBytes }))

  // Shared across read() and readScalars(): both walk the same state-root.
  let consecutiveHardFailures = 0
  let circuitOpenUntilMs = 0

  function circuitBlocks(): string | null {
    const t = now()
    if (t < circuitOpenUntilMs) {
      return `sysmon circuit open for ${Math.max(0, circuitOpenUntilMs - t)}ms after hard failures (timeout/oversize)`
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
  ): Promise<{ ok: true; result: ManagedSysmonCommandResult } | { ok: false; reason: string; detail: string }> {
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
          // The typed unavailable below preserves the source boundary.
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
      if (!invoked.ok) return scalarUnavailable(invoked.reason, invoked.detail)
      const result = invoked.result
      const lines = result.stdout.trim().split("\n").filter(Boolean)
      if (lines.length === 1) {
        try {
          const line = lines[0]
          if (line === undefined) return scalarUnavailable("source-protocol-invalid")
          const parsed = parseScalarObservation(JSON.parse(line))
          if (parsed !== undefined && (result.exitCode === 0 || parsed.kind === "unavailable")) return parsed
        } catch {
          // The typed unavailable below preserves the source boundary.
        }
      }
      if (result.exitCode !== 0) {
        return scalarUnavailable(
          "source-command-failed",
          `exit=${result.exitCode}${result.stderr.trim() === "" ? "" : ` stderr=${result.stderr.trim()}`}`,
        )
      }
      return scalarUnavailable(
        "source-protocol-invalid",
        "command did not emit one valid host-scalar-observation/1 row",
      )
    },
  }
}
