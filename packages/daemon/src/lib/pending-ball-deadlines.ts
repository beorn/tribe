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
  rerouted: number
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
    // The claim, any ownership mutation, and every durable notification row
    // are one commit. A thrown delivery leaves the stage retryable after a
    // restart instead of preserving a claim for work that never completed.
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

function transferDeadlineStageClaims(
  opts: PendingBallDeadlineOptions,
  source: PendingDeadlineRow,
  target: PendingDeadlineRow,
): void {
  for (const stage of ["halfway", "expired"]) {
    const sourceKey = stageKey(source, stage)
    const targetKey = stageKey(target, stage)
    if (sourceKey === targetKey) continue
    const claim = opts.db.prepare("SELECT ts FROM dedup WHERE key = ?").get(sourceKey) as { ts: number } | null
    if (!claim) continue
    opts.stmts.claimDedup.run({
      $key: targetKey,
      $session_id: target.message_id,
      $ts: claim.ts,
    })
    opts.db.prepare("DELETE FROM dedup WHERE key = ?").run(sourceKey)
  }
}

function reroutePendingRow(
  opts: PendingBallDeadlineOptions,
  row: PendingDeadlineRow,
  target: string,
): { messageId: string } | null {
  const current = opts.db
    .prepare("SELECT 1 AS present FROM pending_request WHERE request_id = ? AND recipient = ?")
    .get(row.request_id, row.recipient) as { present: number } | null
  if (!current) return null
  const targetAlreadyOwns = opts.db
    .prepare("SELECT message_id FROM pending_request WHERE request_id = ? AND recipient = ?")
    .get(row.request_id, target) as { message_id: string } | null
  if (targetAlreadyOwns) {
    const targetRow = { ...row, recipient: target, message_id: targetAlreadyOwns.message_id }
    transferDeadlineStageClaims(opts, row, targetRow)
    opts.db
      .prepare("DELETE FROM pending_request WHERE request_id = ? AND recipient = ?")
      .run(row.request_id, row.recipient)
    return { messageId: targetAlreadyOwns.message_id }
  }
  const moved = opts.db
    .prepare("UPDATE pending_request SET recipient = ? WHERE request_id = ? AND recipient = ?")
    .run(target, row.request_id, row.recipient)
  if (Number(moved.changes ?? 0) === 0) return null
  transferDeadlineStageClaims(opts, row, { ...row, recipient: target })
  return { messageId: row.message_id }
}

/** Actuate pending-ball deadlines from the existing health-monitor cadence.
 * The tracker row remains the sole ownership authority; dedup claims provide
 * durable restart/concurrency idempotency without another queue. */
export function processPendingBallDeadlines(opts: PendingBallDeadlineOptions): PendingBallDeadlineResult {
  const result: PendingBallDeadlineResult = { nudged: 0, expired: 0, rerouted: 0, deadOwnerWarnings: 0 }
  const rows = opts.db
    .prepare(
      "SELECT request_id, recipient, sender, opened_at, expires_at, message_id FROM pending_request ORDER BY opened_at, request_id, recipient",
    )
    .all() as PendingDeadlineRow[]

  for (const row of rows) {
    let deadlineRow = row
    const liveness = ownerLiveness(opts, row.recipient)
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
      const target = opts.escalationTarget?.trim() || null
      const stage = `owner-dead:${target ?? "sender-only"}`
      const ownerStage = runClaimedStage(opts, row, stage, () => {
        const rerouted = target && target !== row.recipient ? reroutePendingRow(opts, row, target) : null
        if (!target || !rerouted) {
          opts.send(
            row.sender,
            `Pending ball ${row.request_id} still targets dead owner ${row.recipient}; no reroute target is configured.`,
            "ball:owner-dead",
          )
          return { kind: "warning" as const }
        }
        const nextRow = { ...row, recipient: target, message_id: rerouted.messageId }
        const content = `Pending ball ${row.request_id} was rerouted from dead owner ${row.recipient} to ${target}.`
        for (const recipient of new Set([row.sender, target])) {
          opts.send(recipient, content, "ball:rerouted")
        }
        return { kind: "rerouted" as const, row: nextRow }
      })
      if (ownerStage.claimed) {
        if (ownerStage.value.kind === "rerouted") {
          deadlineRow = ownerStage.value.row
          result.rerouted += 1
        } else {
          result.deadOwnerWarnings += 1
        }
      }
    }

    if (row.expires_at === null) continue
    if (opts.now >= row.expires_at) {
      const expiryStage = runClaimedStage(opts, deadlineRow, "expired", () => {
        const target = opts.escalationTarget?.trim()
        const actions = target
          ? `Sender options: re-ping ${deadlineRow.recipient}; escalate or reroute through ${target}; or mark the ball moot with the pending-close operation.`
          : `Sender options: re-ping ${deadlineRow.recipient}; configure an escalation target before rerouting; or mark the ball moot with the pending-close operation.`
        const content = target
          ? `Pending ball ${row.request_id} owned by ${deadlineRow.recipient} reached its sender-declared deadline. ${actions}`
          : `Pending ball ${row.request_id} reached its sender-declared deadline; no escalation target is configured, so ownership remains with ${deadlineRow.recipient}. ${actions}`
        const recipients = new Set([row.sender])
        if (target) recipients.add(target)
        for (const recipient of recipients) opts.send(recipient, content, "ball:expired")
      })
      if (expiryStage.claimed) result.expired += 1
      continue
    }

    const halfwayAt = row.opened_at + Math.floor((row.expires_at - row.opened_at) / 2)
    if (opts.now >= halfwayAt) {
      const halfwayStage = runClaimedStage(opts, deadlineRow, "halfway", () => {
        opts.send(
          deadlineRow.recipient,
          `You own pending ball ${row.request_id}; its sender-declared deadline is approaching.`,
          "ball:nudge",
        )
      })
      if (halfwayStage.claimed) result.nudged += 1
    }
  }

  return result
}
