/**
 * Standing-incident reconciliation shared by dark-work and longproc-reading (#27710).
 * Only confirmed sends advance the ledger; an unmeasured family preserves its incidents.
 * The serialized `class` field is the caller's family, kept for dark-work's existing alerts.json contract.
 */
import { incidentKey, type EmitterIncidentSnapshot } from "../barrels/records.ts"
import {
  tribeIncidentSendFailure,
  type readTribeIncidents,
  type sendTribeIncident,
  type TribeIncidentSend,
} from "./incident-send.ts"

export type LedgerEntry<Family extends string = string> = Readonly<{ class: Family; to: string; revision: string }>
export type AlertLedger<Family extends string = string> = Readonly<{
  reassertedAt: string | null
  open: Readonly<Record<string, LedgerEntry<Family>>>
}>
export const EMPTY_LEDGER: AlertLedger<never> = { reassertedAt: null, open: {} }
export const REASSERT_EVERY_MS = 24 * 3_600_000

/**
 * Read-only metric-policy projection of accepted observations. This never
 * grants CLEAR authority: conditional writes still need the full snapshot.
 * Missing/unsupported legacy metadata cannot manufacture an accepted revision.
 */
export function alertLedgerFromSnapshot(snapshot: EmitterIncidentSnapshot): {
  ledger: AlertLedger
  unknowns: string[]
} {
  const open: Record<string, LedgerEntry> = {}
  const unknowns: string[] = []
  for (const row of snapshot.pending) {
    const data = row.incident_data
    const metadata = data !== null && typeof data === "object" ? (data as Record<string, unknown>) : null
    const known =
      metadata?.version === 1 &&
      typeof metadata.class === "string" &&
      metadata.class.length > 0 &&
      typeof metadata.revision === "string" &&
      metadata.revision.length > 0
    const entry: LedgerEntry = known
      ? { class: metadata.class as string, to: row.recipient, revision: metadata.revision as string }
      : { class: row.identity.condition, to: row.recipient, revision: "" }
    if (!known) {
      unknowns.push(
        `${row.request_id}: observation ${row.message_id} metadata revision is unknown; awaiting a fresh measured observation`,
      )
    }
    const prior = open[row.request_id]
    if (prior === undefined) open[row.request_id] = entry
    else if (prior.class !== entry.class || prior.revision !== entry.revision) {
      open[row.request_id] = { class: row.identity.condition, to: prior.to, revision: "" }
      unknowns.push(`${row.request_id}: recipient observations disagree; accepted metric revision is unknown`)
    }
  }
  return { ledger: { reassertedAt: null, open }, unknowns }
}

export type IncidentAlert<Family extends string = string> = Readonly<{
  type?: "notify"
  key: string
  class: Family
  subject: string
  condition: string
  to: string
  revision: string
  summary: string
  body: string
}>
export type AlertSend<Family extends string = string> = IncidentAlert<Family> & Readonly<{ cleared: boolean }>

export function reassertDue(ledger: AlertLedger, now: number): boolean {
  return ledger.reassertedAt === null || now - Date.parse(ledger.reassertedAt) >= REASSERT_EVERY_MS
}

/** Caller-built keys and family classifications; no metric or watchdog policy lives here. */
export function planAlertSends<Family extends string>(
  emitter: string,
  alerts: readonly IncidentAlert<Family>[],
  ledger: AlertLedger<Family>,
  unmeasured: ReadonlySet<Family>,
  reassert = false,
  holdings?: EmitterIncidentSnapshot["pending"],
  heldKeys?: ReadonlySet<string>,
): AlertSend<Family>[] {
  const wanted = new Map(alerts.filter((alert) => alert.type !== "notify").map((alert) => [alert.key, alert]))
  const sends: AlertSend<Family>[] = []
  for (const [key, entry] of Object.entries(ledger.open)) {
    if (heldKeys?.has(key)) continue
    const alert = wanted.get(key)
    if (alert === undefined && unmeasured.has(entry.class)) continue
    const recipient =
      alert === undefined
        ? entry.to
        : (holdings?.find((row) => row.request_id === key && row.recipient !== alert.to)?.recipient ?? entry.to)
    if (alert !== undefined && alert.to === recipient) continue
    const prefix = `${emitter}:`
    if (!key.startsWith(prefix)) throw new Error(`incident ledger key ${key} does not belong to emitter ${emitter}`)
    const split = key.indexOf(":", prefix.length)
    if (split < 0) throw new Error(`incident ledger key ${key} has no condition`)
    const subject = key.slice(prefix.length, split)
    const condition = key.slice(split + 1)
    sends.push({
      key,
      class: entry.class,
      subject,
      condition,
      to: recipient,
      cleared: true,
      revision: entry.revision,
      summary: `${emitter} ${subject}: ${condition} ${alert === undefined ? "cleared" : `moved to ${alert.to}`}`,
      body: alert === undefined ? "The finding went away." : `This finding now belongs to ${alert.to}.`,
    })
  }
  for (const [key, alert] of wanted) {
    if (heldKeys?.has(key)) continue
    const entry = ledger.open[key]
    if (
      !reassert &&
      entry !== undefined &&
      entry.to === alert.to &&
      entry.revision === alert.revision &&
      !sends.some((send) => send.key === key && send.cleared)
    ) {
      continue
    }
    sends.push({ ...alert, key, cleared: false })
  }
  for (const alert of alerts) {
    if (alert.type === "notify") sends.push({ ...alert, cleared: false })
  }
  return sends
}

/** Failed sends remain pending; a complete reassert alone advances its timestamp. */
export function nextLedger<Family extends string>(
  ledger: AlertLedger<Family>,
  delivered: readonly AlertSend<Family>[],
  reasserted: Readonly<{ at: string; complete: boolean }> | null,
): AlertLedger<Family> {
  const next: Record<string, LedgerEntry<Family>> = { ...ledger.open }
  for (const send of delivered.filter((s) => s.cleared)) {
    if (next[send.key]?.to === send.to) delete next[send.key]
  }
  for (const send of delivered.filter((s) => !s.cleared && s.type !== "notify")) {
    next[send.key] = { class: send.class, to: send.to, revision: send.revision }
  }
  return { reassertedAt: reasserted?.complete === true ? reasserted.at : ledger.reassertedAt, open: next }
}

/** One conditional attempt loop for metric and ordered repair planners. A conflict always replans from a fresh read. */
export async function reconcileIncidentSend<Send extends TribeIncidentSend>(input: {
  emitter: string
  snapshot: EmitterIncidentSnapshot
  readIncidents: typeof readTribeIncidents
  sendIncident: typeof sendTribeIncident
  sendOptions?: Parameters<typeof sendTribeIncident>[1]
  plan(snapshot: EmitterIncidentSnapshot): Send | undefined
}): Promise<{
  snapshot: EmitterIncidentSnapshot
  send?: Send
  failure?: string
  readFailed?: true
}> {
  let snapshot = input.snapshot
  for (let attempt = 0; attempt < 3; attempt++) {
    const send = input.plan(snapshot)
    if (send === undefined) return { snapshot }
    const key = incidentKey(send.identity)
    const result = await input.sendIncident(
      {
        ...send,
        ifCurrent: snapshot.pending
          .filter((row) => row.request_id === key)
          .map((row) => ({ recipient: row.recipient, message_id: row.message_id })),
      },
      input.sendOptions,
    )
    if (result.conflict === undefined) {
      const failure = tribeIncidentSendFailure(result)
      return failure === undefined ? { snapshot, send } : { snapshot, failure }
    }
    if (attempt === 2) {
      return { snapshot, failure: `${key}: incident holdings contention after three attempts; evidence retained` }
    }
    try {
      snapshot = await input.readIncidents(input.emitter, input.sendOptions)
    } catch (error) {
      return {
        snapshot,
        failure: `${key}: authoritative emitter re-read unavailable: ${String(error)}`,
        readFailed: true,
      }
    }
  }
  throw new Error("conditional incident attempt loop exhausted without an outcome")
}

/** Execute the existing planner against complete daemon holdings, never a private ACK. */
export async function reconcileAlertSends(input: {
  emitter: string
  alerts: readonly IncidentAlert[]
  unmeasured: ReadonlySet<string>
  /** Historical measurement policy can preserve an identity but cannot reopen it. */
  heldKeys?: ReadonlySet<string>
  snapshot: EmitterIncidentSnapshot
  readIncidents: typeof readTribeIncidents
  sendIncident: typeof sendTribeIncident
  sendOptions?: Parameters<typeof sendTribeIncident>[1]
  prepare?: (send: AlertSend) => AlertSend
  accepted?: (send: AlertSend) => void
}) {
  let snapshot = input.snapshot
  const attempted: AlertSend[] = [],
    confirmed: AlertSend[] = [],
    failures: string[] = [],
    unknowns: string[] = []
  const keys = new Set([...snapshot.pending.map((row) => row.request_id), ...input.alerts.map((alert) => alert.key)])
  for (const key of keys) {
    for (;;) {
      let planned: AlertSend | undefined
      const result = await reconcileIncidentSend({
        ...input,
        snapshot,
        plan(current) {
          const projection = alertLedgerFromSnapshot(current)
          unknowns.push(...projection.unknowns)
          const next = planAlertSends(
            input.emitter,
            input.alerts,
            projection.ledger,
            input.unmeasured,
            false,
            current.pending,
            input.heldKeys,
          ).find((send) => send.key === key)
          if (next === undefined) return undefined
          planned = input.prepare?.(next) ?? next
          attempted.push(planned)
          return {
            to: planned.to,
            identity: { emitter: input.emitter, subject: planned.subject, condition: planned.condition },
            cleared: planned.cleared,
            summary: planned.summary,
            body: planned.body,
            incidentData: { version: 1, class: planned.class, revision: planned.revision },
          }
        },
      })
      snapshot = result.snapshot
      if (result.failure !== undefined) failures.push(result.failure)
      if (result.readFailed) return { attempted, confirmed, failures, unknowns: [...new Set(unknowns)] }
      if (result.send === undefined || planned === undefined) {
        break
      }
      const send = planned
      confirmed.push(send)
      input.accepted?.(send)
      if (!send.cleared) break
      // Accepted CLEAR settled exactly these holdings. Re-plan any replacement
      // from that empty identity, so failed CLEAR can never fall through to RAISE.
      const pending = snapshot.pending.filter((row) => row.request_id !== key)
      snapshot = { ...snapshot, count: pending.length, pending }
    }
  }
  return { attempted, confirmed, failures, unknowns: [...new Set(unknowns)] }
}
