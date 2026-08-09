import type { TribeClientApi } from "./plugin-api.ts"
import type { CanonicalProcessObservation, ProcessObservationRow } from "./health-process-source.ts"

interface CanonicalReaperThresholds {
  readonly reaperAgeMinutes: number
  readonly reaperCpuThreshold: number
  readonly reaperEnabled: boolean
  readonly reaperGraceSamples: number
}

interface CanonicalReaperSession {
  readonly name: string
  readonly pid: number
  readonly role: string
}

export interface CanonicalReaperSuspect {
  firstSeen: number
  readonly pid: number
  readonly startTime: string
  asked: boolean
  attributionSignature: string
  command: string
  cpu: number
  escalated: boolean
  lastUnknownSignature?: string
  notifiedOwner?: string
  samples: number
}

export interface CanonicalReaperState {
  readonly suspects: Map<string, CanonicalReaperSuspect>
  lastObservation?: { readonly epoch: string; readonly observedAt: number; readonly sequence: number }
  lastSourceDiagnostic?: string
}

export function createCanonicalReaperState(): CanonicalReaperState {
  return { suspects: new Map() }
}

function identityKey(row: ProcessObservationRow): string {
  return `${row.process.pid}\0${row.process.startTime}`
}

function attributionSignature(row: ProcessObservationRow): string {
  const attribution = row.attribution
  if (attribution.kind === "owned" || attribution.kind === "exempt") {
    return `${attribution.kind}\0${attribution.ownerId}\0${attribution.via}`
  }
  if (attribution.kind === "unknown") return `unknown\0${attribution.reason}`
  return "unowned"
}

function diagnosticContext(observation: CanonicalProcessObservation): string {
  const { diagnostic } = observation
  return `queried ${diagnostic.query} in ${diagnostic.location}; excluded ${diagnostic.excluded.join(",")}`
}

function resetDecisionClock(suspect: CanonicalReaperSuspect, observedAt: number): void {
  suspect.firstSeen = observedAt
  suspect.samples = 0
  suspect.asked = false
  suspect.escalated = false
  suspect.notifiedOwner = undefined
}

function sendUnknown(api: TribeClientApi, message: string): void {
  api.broadcast(message, "health:reaper:unknown", undefined, {
    delivery: "push",
    topic: "health:reaper:unknown",
  })
}

function unavailableDiagnostic(observation: Extract<CanonicalProcessObservation, { kind: "unavailable" }>): string {
  return [observation.reason, observation.diagnostic.detail, diagnosticContext(observation)].filter(Boolean).join("; ")
}

function updateSuspect(
  row: ProcessObservationRow,
  thresholds: CanonicalReaperThresholds,
  state: CanonicalReaperState,
  observedAt: number,
): CanonicalReaperSuspect {
  const key = identityKey(row)
  const signature = attributionSignature(row)
  let suspect = state.suspects.get(key)
  if (suspect === undefined) {
    suspect = {
      firstSeen: observedAt,
      pid: row.process.pid,
      startTime: row.process.startTime,
      asked: false,
      attributionSignature: signature,
      command: row.process.command.slice(0, 80),
      cpu: row.process.cpuPercent ?? 0,
      escalated: false,
      samples: 0,
    }
    state.suspects.set(key, suspect)
  } else if (suspect.attributionSignature !== signature) {
    suspect.attributionSignature = signature
    suspect.lastUnknownSignature = undefined
    resetDecisionClock(suspect, observedAt)
  }
  suspect.command = row.process.command.slice(0, 80)
  suspect.cpu = row.process.cpuPercent ?? 0
  const oldEnough = observedAt - suspect.firstSeen >= thresholds.reaperAgeMinutes * 60_000
  if (oldEnough) suspect.samples++
  return suspect
}

/**
 * Consume one exact process+attribution observation. Managed mode never probes
 * the OS independently: current presence is liveness, `(pid,startTime)` is the
 * lifecycle key, and the configured minimum age is accumulated as canonical
 * observation time.
 */
export function checkCanonicalReaper(
  observation: CanonicalProcessObservation,
  thresholds: CanonicalReaperThresholds,
  state: CanonicalReaperState,
  api: TribeClientApi,
  sessions: readonly CanonicalReaperSession[],
  options: { readonly now?: () => number } = {},
): void {
  if (!thresholds.reaperEnabled) return
  if (observation.kind === "unavailable") {
    const diagnostic = unavailableDiagnostic(observation)
    if (state.lastSourceDiagnostic !== diagnostic) {
      state.lastSourceDiagnostic = diagnostic
      sendUnknown(api, `health:reaper: canonical process source unavailable; ${diagnostic}`)
    }
    state.suspects.clear()
    return
  }

  void options
  const previous = state.lastObservation
  if (previous?.epoch === observation.source.epoch) {
    if (observation.source.sequence === previous.sequence) {
      state.lastSourceDiagnostic = undefined
      return
    }
    if (observation.source.sequence < previous.sequence || observation.observedAt < previous.observedAt) {
      const diagnostic = `canonical process source regressed from ${previous.epoch}/${previous.sequence}@${previous.observedAt} to ${observation.source.epoch}/${observation.source.sequence}@${observation.observedAt}; ${diagnosticContext(observation)}`
      if (state.lastSourceDiagnostic !== diagnostic) {
        state.lastSourceDiagnostic = diagnostic
        sendUnknown(api, `health:reaper: ${diagnostic}`)
      }
      state.suspects.clear()
      return
    }
  } else if (previous !== undefined) {
    state.suspects.clear()
  }
  state.lastObservation = {
    epoch: observation.source.epoch,
    observedAt: observation.observedAt,
    sequence: observation.source.sequence,
  }
  state.lastSourceDiagnostic = undefined

  const seen = new Set<string>()
  const rowsByKey = new Map<string, ProcessObservationRow>()
  for (const row of observation.processes) {
    const cpu = row.process.cpuPercent ?? 0
    const command = row.process.command
    if (cpu <= thresholds.reaperCpuThreshold || !/\b(bun|node)\b/u.test(command)) continue
    const key = identityKey(row)
    seen.add(key)
    rowsByKey.set(key, row)
    if (row.attribution.kind === "exempt") {
      state.suspects.delete(key)
      continue
    }
    const suspect = updateSuspect(row, thresholds, state, observation.observedAt)
    if (row.attribution.kind !== "unknown") continue
    resetDecisionClock(suspect, observation.observedAt)
    const evidence = row.attribution.evidence
    const unknownSignature = [
      row.attribution.reason,
      evidence.ownerCount,
      evidence.ownerIds.join(","),
      evidence.vias.join(","),
      observation.diagnostic.query,
      observation.diagnostic.location,
      observation.diagnostic.excluded.join(","),
    ].join("\0")
    if (suspect.lastUnknownSignature === unknownSignature) continue
    suspect.lastUnknownSignature = unknownSignature
    sendUnknown(
      api,
      `health:reaper: PID ${row.process.pid} (${suspect.command}) ownership unknown (${row.attribution.reason}); owners=${evidence.ownerIds.join(",") || "none"} ownerCount=${evidence.ownerCount} via=${evidence.vias.join(",") || "none"}; ${diagnosticContext(observation)}`,
    )
  }

  for (const key of state.suspects.keys()) {
    if (!seen.has(key)) state.suspects.delete(key)
  }

  const liveNames = new Set(sessions.map(({ name }) => name))
  for (const [key, suspect] of state.suspects) {
    const row = rowsByKey.get(key)
    if (row === undefined || row.attribution.kind === "unknown" || row.attribution.kind === "exempt") continue
    const observedSeconds = Math.floor((observation.observedAt - suspect.firstSeen) / 1_000)
    if (row.attribution.kind === "owned") {
      if (suspect.samples < 3 || suspect.notifiedOwner === row.attribution.ownerId) continue
      if (!liveNames.has(row.attribution.ownerId)) {
        const signature = `owner-not-live\0${row.attribution.ownerId}`
        if (suspect.lastUnknownSignature !== signature) {
          suspect.lastUnknownSignature = signature
          sendUnknown(
            api,
            `health:reaper: PID ${suspect.pid} canonical owner ${row.attribution.ownerId} is not a live recipient; ${diagnosticContext(observation)}`,
          )
        }
        continue
      }
      api.send(
        row.attribution.ownerId,
        `health:reaper: PID ${suspect.pid} (${suspect.command}) at ${suspect.cpu}% CPU, observed for ${observedSeconds}s; canonical owner ${row.attribution.ownerId} via=${row.attribution.via}.`,
        "health:reaper:owned",
        undefined,
        { delivery: "push", topic: "health:reaper:owned" },
      )
      suspect.notifiedOwner = row.attribution.ownerId
      continue
    }

    const claim = `reaper:claim PID ${suspect.pid} START ${JSON.stringify(suspect.startTime)}`
    if (suspect.samples >= 3 && !suspect.asked) {
      suspect.asked = true
      api.broadcast(
        `health:reaper: PID ${suspect.pid} (${suspect.command}) at ${suspect.cpu}% CPU, observed for ${observedSeconds}s. Canonical attribution is unowned. Is this yours? Reply exactly: ${claim} to claim this exact incarnation; unclaimed processes are escalated to the operator.`,
        "health:reaper:query",
        undefined,
        { delivery: "push", topic: "health:reaper:query" },
      )
    }
    if (!suspect.asked || suspect.samples < 3 + thresholds.reaperGraceSamples) continue
    if (api.hasRecentMessage(claim)) {
      state.suspects.delete(key)
      continue
    }
    if (suspect.escalated) continue
    suspect.escalated = true
    api.broadcast(
      `health:reaper: PID ${suspect.pid} (${suspect.command}) canonically unowned after ${thresholds.reaperGraceSamples} grace samples at ${suspect.cpu}% CPU — operator decision required (reply exactly: ${claim} to clear this exact incarnation)`,
      "health:reaper:unclaimed",
      undefined,
      { delivery: "push", topic: "health:reaper:unclaimed" },
    )
  }
}
