/** Neutral replay contract for pending-ball deadline and settlement facts.
 *
 * The daemon writes these facts; daemon projections and wire reports both read
 * them. Keep validation here so every view fails loud on the same malformed
 * evidence and preserves the same settlement taxonomy.
 */

export const NON_REPLY_BALL_SETTLEMENT_REASONS = [
  "manual-close",
  "incident-cleared",
  "gc-expired",
  "sender-withdrawn",
] as const

export type BallSettlementReason = (typeof NON_REPLY_BALL_SETTLEMENT_REASONS)[number]

export type BallFactEvidence = {
  schema_version: 1 | 2
  request_id: string
  recipient: string
  sender: string
  opened_at: number
  expires_at: number | null
  message_id: string
  fanout: "first" | "all"
  summary: string | null
}

export type BallDeadlineObservationPayload = BallFactEvidence & {
  schema_version: 2
  expires_at: number
  observation: "deadline-passed"
  observed_at: number
}

export type BallDeadlineFact = BallFactEvidence & {
  kind: "deadline-passed"
  expires_at: number
  observed_at: number
}

export type BallSettlementFact = BallFactEvidence & {
  kind: "settled"
  schema_version: 1
  settlement: BallSettlementReason
  settled_at: number
  settled_by: string
}

export type BallOutcomeFactRow = {
  id: string
  type: "event.ball.expired" | "event.ball.settled"
  content: string
  ts: number
}

type BallOutcomeFactInput = Partial<BallFactEvidence> & {
  observation?: unknown
  observed_at?: unknown
  settlement?: unknown
  settled_at?: unknown
  settled_by?: unknown
}

export function parseBallOutcomeFact(row: BallOutcomeFactRow): BallDeadlineFact | BallSettlementFact {
  let value: unknown
  try {
    value = JSON.parse(row.content)
  } catch (error) {
    throw new Error(`invalid ball outcome fact ${row.id}: content is not JSON`, { cause: error })
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid ball outcome fact ${row.id}: replay evidence must be an object`)
  }
  const fact = value as BallOutcomeFactInput
  const identity = typeof fact.request_id === "string" ? fact.request_id : row.id
  const validString = (candidate: unknown): candidate is string => typeof candidate === "string" && candidate.length > 0
  const validTime = (candidate: unknown): candidate is number =>
    typeof candidate === "number" && Number.isFinite(candidate)
  const evidenceIsInvalid =
    (fact.schema_version !== 1 && fact.schema_version !== 2) ||
    !validString(fact.request_id) ||
    !validString(fact.recipient) ||
    !validString(fact.sender) ||
    !validTime(fact.opened_at) ||
    (fact.expires_at !== null && !validTime(fact.expires_at)) ||
    !validString(fact.message_id) ||
    (fact.fanout !== "first" && fact.fanout !== "all") ||
    (fact.summary !== null && typeof fact.summary !== "string")
  if (evidenceIsInvalid) {
    const factKind = row.type === "event.ball.expired" ? "expiry" : "settlement"
    throw new Error(`invalid ball ${factKind} fact ${identity}: required replay evidence is missing or malformed`)
  }
  if (row.type === "event.ball.expired") {
    if (fact.schema_version === 2) {
      if (!validTime(fact.expires_at) || fact.observation !== "deadline-passed" || !validTime(fact.observed_at)) {
        throw new Error(`invalid ball expiry fact ${identity}: required replay evidence is missing or malformed`)
      }
      return { ...fact, kind: "deadline-passed" } as BallDeadlineFact
    }
    if (!validTime(fact.expires_at) || fact.settlement !== "expired" || !validTime(fact.settled_at)) {
      throw new Error(`invalid ball expiry fact ${identity}: required replay evidence is missing or malformed`)
    }
    return { ...fact, kind: "deadline-passed", observed_at: fact.settled_at } as BallDeadlineFact
  }
  if (
    fact.schema_version !== 1 ||
    !validTime(fact.settled_at) ||
    !NON_REPLY_BALL_SETTLEMENT_REASONS.includes(fact.settlement as BallSettlementReason) ||
    !validString(fact.settled_by)
  ) {
    throw new Error(`invalid ball settlement fact ${identity}: required replay evidence is missing or malformed`)
  }
  return { ...fact, kind: "settled" } as BallSettlementFact
}
