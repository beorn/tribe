// Connection-time replay cap for the stdio adapter's daemon-inbox drain.
//
// On connect/wakeup the adapter drains its pending queue and forwards each event
// to Claude Code as a <channel> envelope. A large stale backlog used to be
// forwarded wholesale (tribe.fetch limit:500 looped until empty), which flooded
// long-running agent context on connect (km @km/tribe/19442-turn-start-fetch-context-flood).
//
// This module holds the pure forwarding policy: which drained events to surface.
// It is deliberately side-effect-free (no daemon, no I/O) so it can be unit-tested
// directly — the adapter module itself constructs an MCP server at import time.
//
// The caller still DRAINS every fetched row (the cursor advances regardless), so
// events not surfaced here never re-arrive — they are simply not replayed.

/** Max events surfaced as <channel> envelopes per drain pass. */
export const MAX_REPLAY_EVENTS = 100

/** Events older than this (by their `ts`) are drained but not replayed. 1 day. */
export const MAX_REPLAY_AGE_MS = 24 * 60 * 60 * 1000

export type ReplayCandidate = { ts?: string }

export type ReplaySelection<T> = {
  /** Events to surface, in input order, after age + count caps. */
  forward: T[]
  /** How many were dropped for being older than the age cap. */
  skippedOld: number
  /** How many were dropped for exceeding the count cap. */
  capped: number
}

/**
 * Decide which drained events to forward to the agent.
 *
 * - Drops events whose `ts` is older than `maxAgeMs` before `now`.
 * - Caps the surfaced count at `maxEvents` (excess counted in `capped`).
 * - Fails OPEN on a missing/unparseable `ts`: such events are kept, not silently
 *   dropped (a malformed timestamp must never hide a message).
 */
export function selectReplayEvents<T extends ReplayCandidate>(
  events: readonly T[],
  opts: { now: number; maxEvents?: number; maxAgeMs?: number },
): ReplaySelection<T> {
  const maxEvents = opts.maxEvents ?? MAX_REPLAY_EVENTS
  const maxAgeMs = opts.maxAgeMs ?? MAX_REPLAY_AGE_MS
  const cutoff = opts.now - maxAgeMs
  const forward: T[] = []
  let skippedOld = 0
  let capped = 0
  for (const event of events) {
    const ts = event.ts ? Date.parse(event.ts) : Number.NaN
    if (Number.isFinite(ts) && ts < cutoff) {
      skippedOld++
      continue
    }
    if (forward.length >= maxEvents) {
      capped++
      continue
    }
    forward.push(event)
  }
  return { forward, skippedOld, capped }
}

/**
 * How long after a (re)connect the legacy `channel` content-push burst is bounded.
 * The flood (km 19442) is a connect-time replay storm, so the window only needs to
 * cover the burst — steady-state live traffic arrives later and passes freely.
 */
export const CONNECT_REPLAY_WINDOW_MS = 5_000

/**
 * How long an UNCHANGED open-ball summary may go un-repeated before it is
 * re-surfaced. 10 minutes.
 */
export const PENDING_BALL_SUMMARY_WINDOW_MS = 10 * 60 * 1_000

/** Bound on remembered forwarded attention ids (insertion-ordered eviction). */
export const MAX_FORWARDED_ATTENTION_IDS = 10_000

/**
 * 27346 - "has THIS pane already been handed this attention row?"
 *
 * The daemon's `replay` flag cannot answer that. Registration tail-resets
 * `sessions.last_inbox_pull_seq` to the log tail (session.ts:620-627), and
 * `shownThrough = max(mailboxCursor, last_inbox_pull_seq)` (handlers.ts:4058-4076),
 * so a durable-mailbox RECOVERY row that predates this seat reads `replay:true`
 * on its FIRST-ever delivery (measured: fetched=2 replay=2 forwarded=0 on the
 * "claiming a parked name" journey). Delivery to this pane is an adapter-local
 * fact, so the adapter records it here: a row is admitted once, then suppressed
 * until this filter is recreated (process restart). A row with no id is always
 * admitted - never withhold a row we cannot key (fail open).
 */
export type ForwardedAttentionTracker = {
  /** Whether this id was already handed to this pane (an undefined id never is). */
  has(id: string | undefined): boolean
  /** Record a COMPLETED handoff; never call before the forward succeeded. */
  remember(id: string | undefined): void
  /** Seed the record from the durable ledger: a restart still suppresses. */
  restore(ids: Iterable<string>): void
}

export function createForwardedAttentionTracker(maxIds = MAX_FORWARDED_ATTENTION_IDS): ForwardedAttentionTracker {
  const forwarded = new Set<string>()
  const rememberId = (id: string | undefined): void => {
    if (id === undefined || forwarded.has(id)) return
    forwarded.add(id)
    if (forwarded.size > maxIds) {
      const oldest = forwarded.values().next().value
      if (oldest !== undefined) forwarded.delete(oldest)
    }
  }
  return {
    has(id) {
      return id !== undefined && forwarded.has(id)
    },
    remember(id) {
      rememberId(id)
    },
    restore(ids) {
      for (const id of ids) rememberId(id)
    },
  }
}

/** Whether one observation was the first of its kind or a repeat. */
export type DeliveryOutcome = "new" | "duplicate"

/** Per-pane counters for one 4h window (#27459). */
export type DeliveryCounters = {
  /** Every attention row exposed to this pane's adapter (forwarded or suppressed). */
  presentations: number
  newPresentations: number
  duplicatePresentations: number
  /** Successful pane handoffs. */
  deliveries: number
  newDeliveries: number
  duplicateDeliveries: number
  /** Content bytes over duplicate handoffs only (a token estimate). */
  duplicateBytes: number
  /** Presentations the once-per-row filter withheld. */
  suppressed: number
  /**
   * #27488 phase 0 cost block. Optional on the TYPE so a ledger from a
   * pre-costing adapter (v1) still type-checks and loads; delivery-ledger rolls
   * such a window rather than reporting a partial total as if it were whole.
   */
  cost?: DeliveryCost
}

/**
 * #27488 phase 0 - the cost half of the per-pane counter (@cto 6918f2b5).
 *
 * H13: the duplicate KPI read 0% while most of the window's tokens were waste,
 * so the counter must also measure, per seat and window: content bytes over
 * every handoff (the envelope half of the token estimate), the same by delivery
 * class, the no-action share, and the bodies a READ response returned twice
 * (must-hold A). Wrapper overhead is deliberately NOT counted here - the harness
 * wrapper is not ours to measure; the report applies @chief's measured constant.
 */
export type DeliveryClassStat = {
  deliveries: number
  /** Content bytes over every handoff of this class (not just duplicates). */
  bytes: number
  /** Handoffs of this class that changed nothing anyone would do (@chief's (J) rule). */
  noActionDeliveries: number
  noActionBytes: number
}

export type DeliveryCost = {
  /** Content bytes over EVERY successful handoff in this window. */
  deliveredBytes: number
  /** Successful handoffs by class key, bounded to DELIVERY_CLASS_MAX keys. */
  byClass: Record<string, DeliveryClassStat>
  /**
   * Bodies a MODEL-requested read returned twice in ONE response
   * (attention.actionable_unread and events; #27488 must-hold A) and their
   * bytes. Counts occurrences, so the read-side fix drives it to 0.
   */
  readRepeatBodies: number
  readRepeatBytes: number
  /** Model-requested reads served, and the content bytes they returned. */
  readPulls: number
  readPullBytes: number
}

/** The notification-only marker a channel envelope's type carries (shared with the adapter renderer). */
export const NOTIFICATION_ONLY_MARKER = "notification-only:do-not-acknowledge-or-respond-to"

/** A class key with no declared vocabulary slot (unbounded senders fold here). */
export const DELIVERY_CLASS_OTHER = "other"
/** Hard cap on distinct class keys per window; the vocabulary is bounded, not a second store. */
export const DELIVERY_CLASS_MAX = 32

export type DeliveryClassRow = { from?: string | null; type?: string | null; content?: string | null }

/** The composition report's sender kind (@chief flood-composition.py `kind`), unchanged. */
function deliverySenderKind(from: string): string {
  if (from === "telegram" || from.startsWith("@user/")) return "operator"
  if (from.startsWith("@")) return "seat"
  if (from.startsWith("pending-")) return "watch"
  return `machine:${from === "" ? "unknown" : from}`
}

/**
 * The class key the composition report groups by: `senderKind/type`, with the
 * notification-only marker folded to `status`. Pure - the ONE classifier, so the
 * adapter's counting and the report's reading cannot drift.
 */
export function deliveryClassKey(row: DeliveryClassRow): string {
  const raw = String(row.type ?? "")
  const type = raw.startsWith(NOTIFICATION_ONLY_MARKER) ? "status" : raw === "" ? "unknown" : raw
  return `${deliverySenderKind(String(row.from ?? ""))}/${type}`
}

/**
 * @chief's (J) rule for the 2026-10-04 composition window as a bounded
 * predicate: the classes that changed nothing anyone would do. Machine pages,
 * watch notices/resolutions, the open-ball summary and system rows are no-action
 * outright; a seat status or response is no-action only when it names no
 * transition and no ask. Operator rows and seat requests are always actions.
 */
const TRANSITION_MARKERS =
  /\b(TAKING|SUBMITTED|MERGED|CLOSED|LANDED|DELIVERED|BLOCKED|DONE|READY|ASK|ASKING|QUESTION|REQUEST|REQUESTS|REPLY|REPLIES)\b/
const NO_ACTION_MACHINE_CLASSES: readonly string[] = [
  "machine:tribe/attention:pending-balls",
  "machine:page-mailbox-projection/request",
  "machine:dark-work/request",
  "machine:attention-watch/notify",
  "machine:tribe-startup/status",
  "machine:daemon/status",
]

export function isNoActionDelivery(row: DeliveryClassRow): boolean {
  const key = deliveryClassKey(row)
  if (key.startsWith("watch/")) return true
  if (NO_ACTION_MACHINE_CLASSES.includes(key)) return true
  if (key === "seat/status" || key === "seat/response") {
    return !TRANSITION_MARKERS.test(String(row.content ?? ""))
  }
  return false
}

export type DeliveryCounter = {
  /** The daemon exposed this id to this pane's adapter this drain. */
  present(id: string | undefined): DeliveryOutcome
  /**
   * A successful handoff of this id to the pane. `row` (when given) classifies
   * the handoff for the cost block; it is never used for identity.
   */
  deliver(id: string | undefined, bytes?: number, row?: DeliveryClassRow): DeliveryOutcome
  /** Record one MODEL-requested read: returned bytes and bodies it repeated. */
  recordReadPull(input: { bytes: number; repeatBodies: number; repeatBytes: number }): void
  snapshot(): DeliveryCounters
  /** Bounded first-successful-handoff ids, for the durable per-pane ledger. */
  firstHandoffIds(): string[]
  /** Seed presentation + handoff identity from a restored ledger. */
  /**
   * Seed presentation + handoff identity, and the cumulative same-window
   * totals, from a restored ledger (#27459 REVISE). Restoring identity alone
   * let the next persist overwrite a resumed window with a fresh zero while
   * windowStart stayed put — a silent under-count the report read as a clean 0.
   */
  restore(ids: Iterable<string>, counters?: DeliveryCounters): void
  /** Roll the 4h window: zero the counters, keep the identity. */
  resetCounters(): void
}

function boundedIdSet(maxIds: number): { has(id: string): boolean; add(id: string): void; ids(): string[] } {
  const set = new Set<string>()
  return {
    has: (id) => set.has(id),
    add: (id) => {
      if (set.has(id)) return
      set.add(id)
      if (set.size > maxIds) {
        const oldest = set.values().next().value
        if (oldest !== undefined) set.delete(oldest)
      }
    },
    ids: () => Array.from(set),
  }
}

/**
 * #27459 - the independent adapter/Tribe per-pane delivery counter (@cto 9a077460).
 *
 * Two named units, per recipient pane:
 *  - a DUPLICATE PRESENTATION is the daemon exposing the same message id to this
 *    pane's adapter again (forwarded or suppressed by the once-per-row filter);
 *  - a DUPLICATE DELIVERY is a successful same-id handoff after the first.
 *
 * The ruled alert threshold (>20% duplicates with >=100 deliveries) applies ONLY
 * to duplicateDelivery / deliveries; the presentation rate is a diagnostic and is
 * never called attention cost. Content bytes are counted only for duplicate
 * handoffs (a token estimate), and `suppressed` is reported separately.
 *
 * Pure: no clock, no I/O. The handoff identity set is the durable half - the
 * caller seeds it via `restore` from the per-pane first-successful-handoff
 * ledger - while the presentation set is adapter-process local. Both are bounded
 * by insertion-order eviction, the same fail-open discipline as
 * createForwardedAttentionTracker: a row with no id is never withheld or
 * de-duplicated.
 */
export function createDeliveryCounter(opts?: { maxIds?: number }): DeliveryCounter {
  const maxIds = opts?.maxIds ?? MAX_FORWARDED_ATTENTION_IDS
  const presented = boundedIdSet(maxIds)
  const handedOff = boundedIdSet(maxIds)
  const zeroCost = (): DeliveryCost => ({
    deliveredBytes: 0,
    byClass: {},
    readRepeatBodies: 0,
    readRepeatBytes: 0,
    readPulls: 0,
    readPullBytes: 0,
  })
  const zero = (): DeliveryCounters => ({
    cost: zeroCost(),
    presentations: 0,
    newPresentations: 0,
    duplicatePresentations: 0,
    deliveries: 0,
    newDeliveries: 0,
    duplicateDeliveries: 0,
    duplicateBytes: 0,
    suppressed: 0,
  })
  let counters = zero()
  return {
    present(id) {
      counters.presentations++
      if (id === undefined || !presented.has(id)) {
        counters.newPresentations++
        if (id !== undefined) presented.add(id)
        return "new"
      }
      counters.duplicatePresentations++
      return "duplicate"
    },
    deliver(id, bytes = 0, row) {
      counters.deliveries++
      const contentBytes = Math.max(0, Math.floor(bytes))
      const cost = (counters.cost ??= zeroCost())
      let key = row === undefined ? DELIVERY_CLASS_OTHER : deliveryClassKey(row)
      if (cost.byClass[key] === undefined && Object.keys(cost.byClass).length >= DELIVERY_CLASS_MAX) {
        key = DELIVERY_CLASS_OTHER
      }
      const stat = (cost.byClass[key] ??= { deliveries: 0, bytes: 0, noActionDeliveries: 0, noActionBytes: 0 })
      stat.deliveries++
      stat.bytes += contentBytes
      cost.deliveredBytes += contentBytes
      if (row !== undefined && isNoActionDelivery(row)) {
        stat.noActionDeliveries++
        stat.noActionBytes += contentBytes
      }
      if (id === undefined || !handedOff.has(id)) {
        counters.newDeliveries++
        if (id !== undefined) handedOff.add(id)
        return "new"
      }
      counters.duplicateDeliveries++
      counters.duplicateBytes += contentBytes
      return "duplicate"
    },
    recordReadPull(input) {
      const cost = (counters.cost ??= zeroCost())
      cost.readPulls++
      cost.readPullBytes += Math.max(0, Math.floor(input.bytes))
      cost.readRepeatBodies += Math.max(0, Math.floor(input.repeatBodies))
      cost.readRepeatBytes += Math.max(0, Math.floor(input.repeatBytes))
    },
    snapshot() {
      const cost = counters.cost ?? zeroCost()
      return {
        ...counters,
        suppressed: counters.presentations - counters.deliveries,
        cost: {
          ...cost,
          byClass: Object.fromEntries(Object.entries(cost.byClass).map(([key, stat]) => [key, { ...stat }])),
        },
      }
    },
    firstHandoffIds() {
      return handedOff.ids()
    },
    restore(ids, restored) {
      for (const id of ids) {
        presented.add(id)
        handedOff.add(id)
      }
      // A legacy counters object (no `cost`) is kept verbatim: cost then begins
      // at the first handoff of THIS process, never back-filled with a zero.
      // delivery-ledger rolls such a window so no partial total reads as whole.
      if (restored !== undefined) counters = { ...restored }
    },
    resetCounters() {
      counters = zero()
    },
  }
}

/** The preview slice of a ball the summary line is built from. */
export type PendingBallPreview = { request_id?: string | null }

export type PendingBallSummaryInput = {
  balls: readonly PendingBallPreview[]
  summary?:
    | {
        total?: number
        /** Deliberately NOT part of the fingerprint: it changes every minute. */
        oldest_age_ms?: number
        withheld?: { total?: number }
      }
    | undefined
}

/** In-memory adapter state for the open-ball summary throttle. */
export type PendingBallSummaryState = {
  /** Sorted request_ids the last summary previewed. */
  previewIds: string
  total: number
  withheld: number
  sentAt: number
}

export type PendingBallSummaryDecision = {
  /** Whether the caller should forward the summary line this drain. */
  send: boolean
  /** State to retain; null when there is nothing to summarize (reset on empty). */
  state: PendingBallSummaryState | null
}

/**
 * 27346 - throttle the open-ball summary line.
 *
 * Every wakeup drain re-forwarded the same "You own N balls ..." line, so a push
 * seat's pane repeated it on every arrival. Re-surface an unchanged set only when
 * it actually changed (preview request_id set, total, withheld count) or when the
 * window has elapsed. The AGE is deliberately excluded: it always changes, so it
 * would defeat the throttle. An EMPTY set resets the state, so the next ball is a
 * first send. `now`/`state` are passed in - pure, no timer, no second store.
 */
export function decidePendingBallSummary(
  input: PendingBallSummaryInput,
  opts: { now: number; windowMs?: number; state: PendingBallSummaryState | null },
): PendingBallSummaryDecision {
  const total = input.summary?.total ?? input.balls.length
  if (total <= 0) return { send: false, state: null }
  const previewIds = Array.from(
    new Set(input.balls.map((ball) => ball.request_id).filter((id): id is string => Boolean(id))),
  )
    .sort()
    .join(",")
  const withheld = input.summary?.withheld?.total ?? 0
  const previous = opts.state
  if (previous === null) {
    return { send: true, state: { previewIds, total, withheld, sentAt: opts.now } }
  }
  const changed = previous.previewIds !== previewIds || previous.total !== total || previous.withheld !== withheld
  const windowMs = opts.windowMs ?? PENDING_BALL_SUMMARY_WINDOW_MS
  if (changed || opts.now - previous.sentAt >= windowMs) {
    return { send: true, state: { previewIds, total, withheld, sentAt: opts.now } }
  }
  return { send: false, state: previous }
}

export type ConnectReplayGate = {
  /** Reset the window — call on every (re)connect. */
  reset(now: number): void
  /** Decide whether a `channel`-pushed event should be forwarded right now. */
  admit(now: number): boolean
  /** Events dropped within the current window (for a summary log). */
  readonly dropped: number
}

/**
 * 27346 - channel-envelope metadata for one forwarded attention row.
 *
 * The tracked branch of the daemon's `selectAttention` keeps an untaken ball
 * visible past the mailbox cursor on purpose (22203), so the same row is
 * surfaced again on later drains. EVERY attention envelope carries the row's
 * ORIGINAL send time (`sent_at`): the envelope is built once at drain time and
 * settlement cannot revise it, so an envelope already queued in the host when
 * the ball settles must still be readable as old. A re-presented row (the
 * daemon marked `replay`) additionally names itself a replay. A row with no
 * timestamp carries no age claim.
 */
export function replayEnvelopeMeta(event: { ts?: string; replay?: boolean }): {
  replay?: string
  sent_at?: string
} {
  // Every attention envelope carries the row's ORIGINAL send time, not just a
  // re-presented one: the envelope is built once at drain time and settlement
  // cannot revise it, so an envelope already queued in the host when the ball
  // settles must still be readable as old. A re-presented row additionally
  // names itself a replay. A row with no timestamp carries no age claim
  // (fail open — a malformed row is never hidden).
  return {
    ...(event.replay === true ? { replay: "true" } : {}),
    ...(event.ts ? { sent_at: String(event.ts) } : {}),
  }
}

/**
 * Bound the legacy `channel` content-push burst a pre-`wakeup` daemon dumps
 * right after (re)connect (km 19442).
 *
 * In the wakeup-only delivery model the daemon never pushes content — it sends
 * `wakeup` nudges and the client drains via the (already capped) `selectReplayEvents`
 * path. This gate is the compat backstop for the OTHER path: a stale/old daemon
 * that still pushes message bodies as `channel` notifications. Within `windowMs`
 * of a (re)connect it forwards at most `maxEvents` and drops the rest — the dropped
 * rows stay durable in the daemon journal and remain fetchable via `tribe.fetch`.
 *
 * Outside the window — steady state — it forwards freely so a live actionable DM
 * is NEVER withheld. The gate only fires on the connect-burst it is named for.
 */
export function createConnectReplayGate(opts?: { maxEvents?: number; windowMs?: number }): ConnectReplayGate {
  const maxEvents = opts?.maxEvents ?? MAX_REPLAY_EVENTS
  const windowMs = opts?.windowMs ?? CONNECT_REPLAY_WINDOW_MS
  let connectAt = Number.NEGATIVE_INFINITY
  let forwarded = 0
  let droppedInWindow = 0
  return {
    reset(now: number): void {
      connectAt = now
      forwarded = 0
      droppedInWindow = 0
    },
    admit(now: number): boolean {
      // Steady state (outside the connect window, or before the first connect):
      // never withhold a live message.
      if (now - connectAt >= windowMs) return true
      if (forwarded >= maxEvents) {
        droppedInWindow++
        return false
      }
      forwarded++
      return true
    },
    get dropped(): number {
      return droppedInWindow
    },
  }
}
