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

export const BALL_SETTLEMENT_REASONS = ["answered", ...NON_REPLY_BALL_SETTLEMENT_REASONS] as const

export type BallSettlementReason = (typeof BALL_SETTLEMENT_REASONS)[number]

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
    !BALL_SETTLEMENT_REASONS.includes(fact.settlement as BallSettlementReason) ||
    !validString(fact.settled_by)
  ) {
    throw new Error(`invalid ball settlement fact ${identity}: required replay evidence is missing or malformed`)
  }
  return { ...fact, kind: "settled" } as BallSettlementFact
}

/** One ball's settlement facts as a reader reports them: the taxonomy reason,
 * when, and by whom. `settled_at` stays a number here; the daemon's pending
 * view renders it ISO like every other timestamp on its rows. */
export type BallSettlementConflictEntry = Pick<BallSettlementFact, "settlement" | "settled_at" | "settled_by">

export type SettlementFold = {
  /** The fact that stands for each key — the latest by settled_at. */
  latest: Map<string, BallSettlementFact>
  /** Keys whose facts disagree, each with every fact in settled_at order.
   * @i/21-wire/25654: yrd closed by hand on one day and its records replay
   * re-sent the same request and message id fourteen days later, which was
   * answered — two facts, one key. A throw here blinded every seat's expired
   * view; a conflict is REPORTED on that one ball and folds like any other. */
  conflicts: Map<string, BallSettlementFact[]>
}

export function ballFactKey(fact: Pick<BallFactEvidence, "request_id" | "recipient" | "message_id">): string {
  return JSON.stringify([fact.request_id, fact.recipient, fact.message_id])
}

export function foldSettlementFacts(facts: Iterable<BallSettlementFact>): SettlementFold {
  const byKey = new Map<string, BallSettlementFact[]>()
  for (const fact of facts) {
    const key = ballFactKey(fact)
    const rows = byKey.get(key) ?? []
    rows.push(fact)
    byKey.set(key, rows)
  }
  const latest = new Map<string, BallSettlementFact>()
  const conflicts = new Map<string, BallSettlementFact[]>()
  for (const [key, rows] of byKey) {
    const ordered = [...rows].sort((left, right) => left.settled_at - right.settled_at)
    const last = ordered.at(-1)
    const first = ordered[0]
    if (last === undefined || first === undefined) continue
    latest.set(key, last)
    if (ordered.some((fact) => fact.settlement !== first.settlement)) conflicts.set(key, ordered)
  }
  return { latest, conflicts }
}

export function settlementConflictEntries(facts: readonly BallSettlementFact[]): BallSettlementConflictEntry[] {
  return facts.map(({ settlement, settled_at, settled_by }) => ({ settlement, settled_at, settled_by }))
}

/** `manual-close by @dev/6 at 2026-09-10T08:33:42.762Z; answered by @dev/6 at …` */
export function describeSettlementConflict(
  facts: ReadonlyArray<Omit<BallSettlementConflictEntry, "settled_at"> & { settled_at: number | string }>,
): string {
  return facts
    .map((fact) => `${fact.settlement} by ${fact.settled_by} at ${new Date(fact.settled_at).toISOString()}`)
    .join("; ")
}
