import type { Database } from "bun:sqlite"
import type { TribeStatements } from "./database.ts"
import { isPidAlive as defaultIsPidAlive } from "./session.ts"

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
  deadOwnerWarnings: number
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

function ownerLiveness(opts: PendingBallDeadlineOptions, owner: string): OwnerLiveness {
  if (opts.liveSessionNames.has(owner)) return "live"
  const row = opts.db
    .prepare("SELECT pid FROM sessions WHERE name = ? ORDER BY updated_at DESC LIMIT 1")
    .get(owner) as { pid: number } | null
  if (!row || row.pid <= 0) return "unknown"
  return (opts.isPidAlive ?? defaultIsPidAlive)(row.pid) ? "unknown" : "dead"
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
    return `Pending ball ${row.request_id} owned by ${row.recipient} expired unanswered and was dropped from active responsibility. This typed exception was sent to the sender, and ${target} receives the configured escalation verdict.`
  }
  if (targetIsDeadOwner) {
    return `Pending ball ${row.request_id} owned by ${row.recipient} expired unanswered and was dropped from active responsibility. The configured escalation target is that same dead owner, so no viable escalation delivery was possible.`
  }
  return `Pending ball ${row.request_id} owned by ${row.recipient} expired unanswered and was dropped from active responsibility. No escalation target is configured; this typed sender exception is the terminal audit event.`
}

/** Actuate pending-ball deadlines from the existing health-monitor cadence.
 * The tracker row remains the sole active-ownership authority until all
 * required typed notifications commit; dedup claims provide durable
 * restart/concurrency idempotency without another queue. */
export function processPendingBallDeadlines(opts: PendingBallDeadlineOptions): PendingBallDeadlineResult {
  const result: PendingBallDeadlineResult = { nudged: 0, expired: 0, deadOwnerWarnings: 0 }
  // A delivery callback can synchronously re-enter the cadence on the same
  // connection. The outer stage transaction owns that work; a nested sweep
  // must not observe its uncommitted dedup claim and settle the row early.
  if (opts.db.inTransaction) return result
  const rows = opts.db
    .prepare(
      "SELECT request_id, recipient, sender, opened_at, expires_at, message_id FROM pending_request ORDER BY opened_at, request_id, recipient",
    )
    .all() as PendingDeadlineRow[]

  for (const row of rows) {
    const liveness = ownerLiveness(opts, row.recipient)
    const configuredTarget = opts.escalationTarget?.trim() || null
    const targetIsDeadOwner = liveness === "dead" && configuredTarget === row.recipient
    const target = targetIsDeadOwner ? null : configuredTarget
    if (liveness === "unknown") {
      const unresolvedStage = runClaimedStage(opts, row, "owner-unresolved", () => {
        opts.send(
          row.sender,
          `Pending ball ${row.request_id} targets owner ${row.recipient}, who is not currently active; no positive death evidence exists, so ownership is retained.`,
          "ball:owner-unresolved",
        )
      })
      if (unresolvedStage.claimed) result.deadOwnerWarnings += 1
    }
    if (liveness === "dead") {
      const content = deadOwnerContent(row, target, targetIsDeadOwner)
      const senderStage = runClaimedStage(opts, row, "owner-dead:sender", () => {
        opts.send(row.sender, content, target === row.sender ? "verdict" : "ball:owner-dead")
      })
      if (senderStage.claimed) result.deadOwnerWarnings += 1
      if (target && target !== row.sender) {
        const escalationStage = runClaimedStage(opts, row, `owner-dead:escalation:${target}`, () => {
          // `verdict` is wakeable but deliberately excluded from AUTO_TRACK_TYPES:
          // an LLM judge sees the escalation without manufacturing another ball.
          opts.send(target, content, "verdict")
        })
        if (escalationStage.claimed) result.deadOwnerWarnings += 1
      }
    }

    if (row.expires_at === null) continue
    if (opts.now >= row.expires_at) {
      const content = expiredBallContent(row, target, targetIsDeadOwner)
      runClaimedStage(opts, row, "expired:sender", () => {
        opts.send(row.sender, content, "ball:expired")
      })
      if (target) {
        runClaimedStage(opts, row, `expired:escalation:${target}`, () => {
          opts.send(target, content, "verdict")
        })
      }
      const settled = opts.stmts.closePendingRequest.run({
        $request_id: row.request_id,
        $recipient: row.recipient,
      })
      result.expired += Number(settled.changes ?? 0)
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
