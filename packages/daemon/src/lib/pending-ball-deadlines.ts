import type { Database } from "bun:sqlite"
import type { TribeStatements } from "./database.ts"
import {
  projectSessionTransportState,
  type OwnerState,
  type SessionTransportProjection,
} from "./session-transport-state.ts"

type PendingDeadlineRow = {
  request_id: string
  recipient: string
  sender: string
  opened_at: number
  expires_at: number | null
  message_id: string
}

export type PendingBallDeadlineResult = {
  nudged: number
  expired: number
  ownerStateWarnings: number
}

export type PendingBallDeadlineOptions = {
  db: Database
  stmts: TribeStatements
  now: number
  liveSessionNames: ReadonlySet<string>
  escalationTarget: string | null
  isPidAlive?: (pid: number) => boolean
  send: (recipient: string, content: string, type: string) => void
}

function stageKey(row: PendingDeadlineRow, stage: string): string {
  return `ball-deadline:${stage}:${encodeURIComponent(row.request_id)}:${encodeURIComponent(row.recipient)}`
}

function claimStage(opts: PendingBallDeadlineOptions, row: PendingDeadlineRow, stage: string): boolean {
  const claim = opts.stmts.claimDedup.run({
    $key: stageKey(row, stage),
    // Keep deadline claims tied to the source message while its ball remains
    // open; cleanupOldData retains these keys until the ball closes.
    $session_id: row.message_id,
    $ts: opts.now,
  })
  return Number(claim.changes ?? 0) > 0
}

function runClaimedStage<T>(
  opts: PendingBallDeadlineOptions,
  row: PendingDeadlineRow,
  stage: string,
  actuate: () => T,
): { claimed: false } | { claimed: true; value: T } {
  return opts.db.transaction(() => {
    if (!claimStage(opts, row, stage)) return { claimed: false as const }
    // The claim and its durable notification row are one commit. A thrown
    // delivery leaves the stage retryable after a restart instead of
    // preserving a claim for work that never completed.
    return { claimed: true as const, value: actuate() }
  })()
}

type OwnerLiveness = "live" | "dead" | "unknown"

function ownerTransport(opts: PendingBallDeadlineOptions, owner: string): SessionTransportProjection | null {
  const row = opts.db
    .prepare("SELECT pid FROM sessions WHERE name = ? ORDER BY updated_at DESC LIMIT 1")
    .get(owner) as { pid: number } | null
  if (!row && !opts.liveSessionNames.has(owner)) return null
  const probeOwner = opts.isPidAlive
    ? (pid: number): OwnerState => (opts.isPidAlive!(pid) ? "live" : "dead")
    : undefined
  return projectSessionTransportState({
    transportConnected: opts.liveSessionNames.has(owner),
    ownerPid: row?.pid ?? 0,
    probeOwner,
  })
}

function ownerLiveness(transport: SessionTransportProjection | null): OwnerLiveness {
  if (transport?.transport_state === "connected") return "live"
  if (transport?.owner_state === "dead") return "dead"
  return "unknown"
}

function deadOwnerContent(row: PendingDeadlineRow, target: string | null, targetIsDeadOwner: boolean): string {
  if (target) {
    return `Pending ball ${row.request_id} still targets dead owner ${row.recipient}. Ownership is retained; ${target} must use LLM judgment before any reassignment or closure.`
  }
  if (targetIsDeadOwner) {
    return `Pending ball ${row.request_id} still targets dead owner ${row.recipient}; the configured escalation target is that same dead owner, so no viable escalation target is available and ownership is retained.`
  }
  return `Pending ball ${row.request_id} still targets dead owner ${row.recipient}; no escalation target is configured, so ownership is retained.`
}

function expiredBallContent(row: PendingDeadlineRow, target: string | null, targetIsDeadOwner: boolean): string {
  if (target) {
    return `Pending ball ${row.request_id} owned by ${row.recipient} reached its sender-declared deadline. Sender options: re-ping ${row.recipient}; ask ${target} to decide whether to reassign or close; or mark the ball moot with the pending-close operation.`
  }
  if (targetIsDeadOwner) {
    return `Pending ball ${row.request_id} reached its sender-declared deadline; the configured escalation target is the dead owner, so no viable escalation target is available and ownership remains with ${row.recipient}. Sender options: configure a viable escalation target other than the dead owner; or mark the ball moot with the pending-close operation.`
  }
  return `Pending ball ${row.request_id} reached its sender-declared deadline; no escalation target is configured, so ownership remains with ${row.recipient}. Sender options: re-ping ${row.recipient}; configure an escalation target for LLM judgment; or mark the ball moot with the pending-close operation.`
}

/** Actuate pending-ball deadlines from the existing health-monitor cadence.
 * The tracker row remains the sole ownership authority; dedup claims provide
 * durable restart/concurrency idempotency without another queue. */
export function processPendingBallDeadlines(opts: PendingBallDeadlineOptions): PendingBallDeadlineResult {
  const result: PendingBallDeadlineResult = { nudged: 0, expired: 0, ownerStateWarnings: 0 }
  const rows = opts.db
    .prepare(
      "SELECT request_id, recipient, sender, opened_at, expires_at, message_id FROM pending_request ORDER BY opened_at, request_id, recipient",
    )
    .all() as PendingDeadlineRow[]

  for (const row of rows) {
    const transport = ownerTransport(opts, row.recipient)
    const liveness = ownerLiveness(transport)
    const configuredTarget = opts.escalationTarget?.trim() || null
    const targetIsDeadOwner = liveness === "dead" && configuredTarget === row.recipient
    const target = targetIsDeadOwner ? null : configuredTarget
    if (liveness === "unknown") {
      const unresolvedStage = runClaimedStage(opts, row, "owner-unresolved", () => {
        const evidence = transport
          ? ` transport_state=${transport.transport_state} owner_state=${transport.owner_state} reason=${transport.transport_reason};`
          : ""
        opts.send(
          row.sender,
          `Pending ball ${row.request_id} targets owner ${row.recipient}, who is not currently active;${evidence} no positive death evidence exists, so ownership is retained.`,
          "ball:owner-unresolved",
        )
      })
      if (unresolvedStage.claimed) result.ownerStateWarnings += 1
    }
    if (liveness === "dead") {
      const content = deadOwnerContent(row, target, targetIsDeadOwner)
      const senderStage = runClaimedStage(opts, row, "owner-dead:sender", () => {
        opts.send(row.sender, content, target === row.sender ? "verdict" : "ball:owner-dead")
      })
      if (senderStage.claimed) result.ownerStateWarnings += 1
      if (target && target !== row.sender) {
        const escalationStage = runClaimedStage(opts, row, `owner-dead:escalation:${target}`, () => {
          // `verdict` is wakeable but deliberately excluded from AUTO_TRACK_TYPES:
          // an LLM judge sees the escalation without manufacturing another ball.
          opts.send(target, content, "verdict")
        })
        if (escalationStage.claimed) result.ownerStateWarnings += 1
      }
    }

    if (row.expires_at === null) continue
    if (opts.now >= row.expires_at) {
      const content = expiredBallContent(row, target, targetIsDeadOwner)
      const senderStage = runClaimedStage(opts, row, "expired:sender", () => {
        opts.send(row.sender, content, target === row.sender ? "verdict" : "ball:expired")
      })
      let escalationClaimed = false
      if (target && target !== row.sender) {
        const escalationStage = runClaimedStage(opts, row, `expired:escalation:${target}`, () => {
          opts.send(target, content, "verdict")
        })
        escalationClaimed = escalationStage.claimed
      }
      if (senderStage.claimed || escalationClaimed) result.expired += 1
      continue
    }

    if (liveness === "dead") continue

    const halfwayAt = row.opened_at + Math.floor((row.expires_at - row.opened_at) / 2)
    if (opts.now >= halfwayAt) {
      const halfwayStage = runClaimedStage(opts, row, "halfway", () => {
        opts.send(
          row.recipient,
          `You own pending ball ${row.request_id}; its sender-declared deadline is approaching.`,
          "ball:nudge",
        )
      })
      if (halfwayStage.claimed) result.nudged += 1
    }
  }

  return result
}
