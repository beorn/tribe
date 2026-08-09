import { dirname, join } from "node:path"

const PROCESS_OBSERVATION_SCHEMA = "process-observation/1" as const
const DEFAULT_MAX_AGE_MS = 90_000
const MAX_COMMAND_CHARS = 512
const MAX_DIAGNOSTIC_CHARS = 1_024
const MAX_ROUTING_TEXT_CHARS = 256
const EXCLUDED_FALLBACKS = ["standalone-os-resample", "cross-batch-attribution", "implicit-unowned"] as const
const OBSERVATION_QUERY = "latest exact process census with owner attribution"
const ROUTING_VIAS = new Set(["env", "reactive", "root", "tree"])

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

export type HealthProcessSource =
  | { readonly kind: "standalone-os" }
  | { readonly kind: "managed"; readonly read: () => Promise<CanonicalProcessObservation> }

export interface HealthProcessSourceOptions {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly maxAgeMs?: number
  readonly runCommand?: (argv: readonly string[]) => Promise<{
    readonly exitCode: number
    readonly stderr: string
    readonly stdout: string
  }>
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

async function runProcessCommand(argv: readonly string[]): Promise<{
  exitCode: number
  stderr: string
  stdout: string
}> {
  const child = Bun.spawn([...argv], { stderr: "pipe", stdout: "pipe" })
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ])
  return { exitCode, stderr, stdout }
}

export function createHealthProcessSource(options: HealthProcessSourceOptions = {}): HealthProcessSource {
  const env = options.env ?? process.env
  const sessionDir = env.HAB_SESSION_DIR?.trim()
  if (!sessionDir || !env.HAB_SERVICE_KIND?.trim()) return { kind: "standalone-os" }
  const stateRoot = dirname(sessionDir)
  const controllerSessionDir = join(stateRoot, "habmod")
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const runCommand = options.runCommand ?? runProcessCommand
  return {
    kind: "managed",
    async read() {
      const argv = ["hab", "sysmon", "snapshot", "--state-root", stateRoot, "--max-age-ms", String(maxAgeMs), "--json"]
      let result: Awaited<ReturnType<typeof runCommand>>
      try {
        result = await runCommand(argv)
      } catch (error) {
        return unavailable(
          controllerSessionDir,
          "source-command-failed",
          error instanceof Error ? error.message : String(error),
        )
      }
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
  }
}
