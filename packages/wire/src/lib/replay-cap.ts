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

import { TRIBE_NAME_ENV, TRIBE_SESSION_NAME_ENV } from "./session-identity-env.ts"

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
   * pre-costing adapter (v1) still type-checks and loads; delivery-ledger
   * resumes such a window and records when cost measurement began, rather than
   * reporting a partial total as if it were whole.
   */
  cost?: DeliveryCost
}

/**
 * #27488 phase 0 - the cost half of the per-pane counter (@cto 6918f2b5).
 *
 * H13: the duplicate KPI read 0% while most of the window's tokens were waste,
 * so the counter must also measure, per seat and window, content bytes over
 * every successful handoff (the envelope half of the token estimate) and the
 * bodies a READ response returned twice (must-hold A). Wrapper overhead is
 * deliberately NOT counted here - the harness wrapper is not ours to measure;
 * the report applies @chief's measured constant over the SAME span.
 *
 * The per-class breakdown and the @chief (J) no-action share deliberately do NOT
 * live here (@cto 1f51f13d): they are the composition report's judgement, not a
 * transport library's measurement, and a copy would be a second derivation that
 * drifts from the report on the pilot seat.
 */
export type DeliveryCost = {
  /** Content bytes over EVERY successful handoff in the cost span. */
  deliveredBytes: number
  /**
   * Successful handoffs inside the cost span (matches deliveredBytes). Kept
   * separately from `deliveries`, which covers the WHOLE window: after a v1
   * resume the bytes and this count begin later than the window, so the report
   * must apply the wrapper estimate to the same span, never to the window total.
   */
  handoffs: number
  /**
   * Bodies a MODEL-requested read returned twice in ONE response
   * (attention.actionable_unread and events; #27488 must-hold A) and their
   * bytes. Counts occurrences, so the read-side fix drives it to 0.
   */
  readRepeatBodies: number
  readRepeatBytes: number
  /** Model-requested reads served, and the RESULT bytes they returned. */
  readPulls: number
  readPullBytes: number
}

export type DeliveryCounter = {
  /** The daemon exposed this id to this pane's adapter this drain. */
  present(id: string | undefined): DeliveryOutcome
  /** A successful handoff of this id to the pane; `bytes` is its content size. */
  deliver(id: string | undefined, bytes?: number): DeliveryOutcome
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
    handoffs: 0,
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
    deliver(id, bytes = 0) {
      counters.deliveries++
      const contentBytes = Math.max(0, Math.floor(bytes))
      const cost = (counters.cost ??= zeroCost())
      cost.handoffs++
      cost.deliveredBytes += contentBytes
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
        cost: { ...cost },
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
      // delivery-ledger resumes such a window and records when cost began, so
      // no partial total reads as whole.
      if (restored !== undefined) counters = { ...restored }
    },
    resetCounters() {
      counters = zero()
    },
  }
}

/** The preview slice of a ball the summary line is built from. */
export type PendingBallPreview = {
  request_id?: string | null
  /** The ball's reply deadline. A ball past it is overdue. */
  expires_at?: string | null
  /** The daemon's own verdict for a deadline-passed ball. */
  status?: string | null
}

export type PendingBallSummaryInput = {
  balls: readonly PendingBallPreview[]
  /**
   * The LATEST due time (epoch ms) among owned balls overdue at projection time,
   * from the daemon projection BEFORE its 10-row preview cap, or null when none
   * (wake removal 1). Absent from an older daemon: the decision then derives the
   * watermark from the bounded preview, its pre-fix coverage, and the adapter
   * names that gap once. When present it is authoritative — the preview alone
   * cannot see a due transition for a ball outside it, so an 11th newly-due ball
   * would be silent. One number, not the id list: this rides every model-facing
   * fetch, so an owner of many overdue balls must not pay a UUID per turn.
   */
  newestOverdueDueAt?: number | null
  summary?:
    | {
        total?: number
        /** Deliberately NOT part of the decision: it changes every minute. */
        oldest_age_ms?: number
        withheld?: { total?: number }
      }
    | undefined
}

/** In-memory adapter state for the open-ball summary. */
export type PendingBallSummaryState = {
  /** Latest overdue due time (epoch ms) seen at the last drain; the watermark
   *  never decreases, so a settlement cannot make an already-overdue ball read
   *  as newly due. Null before any ball has passed its due. */
  newestOverdueDueAt: number | null
}

export type PendingBallSummaryDecision = {
  /** Whether the caller should forward the summary line this drain. */
  send: boolean
  /** State to retain; the watermark carries across drains. */
  state: PendingBallSummaryState | null
  /** True when the daemon did not report `newestOverdueDueAt`, so the watermark
   *  was derived from the BOUNDED 10-row preview. That is a named coverage gap
   *  the adapter surfaces once, never a clean result (@dev/review2 REVISE). */
  readFromPreview: boolean
}

/** A preview ball's due time in epoch ms when it is overdue, else null. */
function previewBallDueAt(ball: PendingBallPreview, now: number): number | null {
  // The daemon's own verdict wins: a deadline-passed ball with an unparseable
  // (or absent) deadline still counts, at `now` as the conservative watermark.
  if (ball.status === "expired") {
    if (ball.expires_at) {
      const due = Date.parse(ball.expires_at)
      if (Number.isFinite(due)) return due
    }
    return now
  }
  if (!ball.expires_at) return null
  const due = Date.parse(ball.expires_at)
  return Number.isFinite(due) && due <= now ? due : null
}

/** The preview-derived watermark: the latest overdue due time the bounded
 *  10-row preview can see. Incomplete only when more than ten balls are
 *  overdue — the case the adapter names once when the daemon field is absent. */
function previewWatermark(balls: readonly PendingBallPreview[], now: number): number | null {
  let latest: number | null = null
  for (const ball of balls) {
    const due = previewBallDueAt(ball, now)
    if (due !== null && (latest === null || due > latest)) latest = due
  }
  return latest
}

/** The larger of two watermarks, treating null as "none seen yet". */
function maxWatermark(left: number | null, right: number | null): number | null {
  if (left === null) return right
  if (right === null) return left
  return Math.max(left, right)
}

/**
 * 27346, wake removal 1 - the open-ball summary line re-surfaces ONLY when a
 * ball the seat owns NEWLY passes its due, plus once when the adapter starts.
 *
 * A changed set sends nothing: a newly arrived ball already reaches the pane as
 * its own pushed request, so repeating "You own N balls ..." for it is the
 * duplicate wake this removes. The window re-send of an unchanged set is gone
 * with it. A settled ball only shrinks the remembered overdue set.
 *
 * `now`/`state` are passed in - pure, no timer, no second store. State is null
 * only before the first decision; the durable ledger restores it across a
 * restart, so a restart does not re-present an unchanged line.
 */
export function decidePendingBallSummary(
  input: PendingBallSummaryInput,
  opts: { now: number; state: PendingBallSummaryState | null },
): PendingBallSummaryDecision {
  const daemonWatermark = input.newestOverdueDueAt
  const readFromPreview = daemonWatermark === undefined
  const current: number | null = readFromPreview ? previewWatermark(input.balls, opts.now) : daemonWatermark
  const previous = opts.state
  // The watermark never decreases: any due time at or below the stored value was
  // already overdue when that value was recorded, so settling a preview row
  // cannot expose an already-overdue hidden row as falsely new.
  const retained: PendingBallSummaryState = {
    newestOverdueDueAt: maxWatermark(previous?.newestOverdueDueAt ?? null, current),
  }
  const total = input.summary?.total ?? input.balls.length
  if (total <= 0) {
    // Nothing to summarize. Keep the remembered floor, never reset to null: a
    // reset would make the NEXT ball a "first send" though it never passed due.
    return { send: false, state: previous === null ? null : retained, readFromPreview }
  }
  if (previous === null) {
    // Adapter start with a restored (or absent) ledger: the one non-overdue send.
    return { send: true, state: retained, readFromPreview }
  }
  // Send only when the watermark RISES past what the adapter has already shown.
  // A re-due by TAKING sets a later deadline, so it raises the watermark again
  // even with no decision in between.
  const send = current !== null && (previous.newestOverdueDueAt === null || current > previous.newestOverdueDueAt)
  return { send, state: retained, readFromPreview }
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
const SENT_AT_TIME_ZONE = "America/Los_Angeles"
const SENT_AT_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: SENT_AT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
})

/**
 * 31111 (@cto 88bd9852) — render `sent_at` in zoned local time (`YYYY-MM-DD HH:MM PDT`)
 * so the model never has to mentally convert UTC to local time when comparing against
 * zoned deadlines in the body. Fails open on an unparseable timestamp.
 */
export function formatZonedSentAt(ts: string): string {
  const parsed = new Date(ts)
  if (Number.isNaN(parsed.getTime())) return ts
  const parts = SENT_AT_FORMATTER.formatToParts(parsed)
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? ""
  const date = `${part("year")}-${part("month")}-${part("day")}`
  const time = `${part("hour")}:${part("minute")}`
  const zone = part("timeZoneName")
  return zone ? `${date} ${time} ${zone}` : `${date} ${time}`
}

/**
 * 31111 (@cto 88bd9852 / 481a6af2 / f49f779d) — omit `authority` when verified
 * (absence = verified). Present `unverified="TRIBE_NAME|TRIBE_SESSION_NAME|bearer|unknown"`
 * only when the sender's name is unverified, rendered from the existing `from_authority`
 * with no new stored field.
 */
export function unverifiedEnvelopeMeta(event: { from_authority?: string | null }): {
  unverified?: typeof TRIBE_NAME_ENV | typeof TRIBE_SESSION_NAME_ENV | "bearer" | "unknown"
} {
  const auth = event.from_authority
  if (!auth || auth === "verified") return {}
  if (auth === "bearer" || auth === TRIBE_NAME_ENV || auth === TRIBE_SESSION_NAME_ENV) {
    return { unverified: auth }
  }
  return { unverified: "unknown" }
}

/**
 * 31111 (@cto 88bd9852) — one-line startup banner:
 * `tribe <seat> <delivery> · <up> [· missing <seats>]`
 * The prefix is capped at 100 characters; the missing list stays complete even past 100 chars.
 */
export function formatStartupBanner(input: {
  name: string
  deliveryClause: string
  connectedCount: number
  headline?: string
  membershipDiscrepancy?: {
    expected_count?: number
    connected_expected_count?: number
    connected_durable_launches: number
    known_durable_launches: number
    missing: ReadonlyArray<{ name: string }>
  }
}): string {
  let upClause = `${input.connectedCount} up`
  let missingClause = ""
  if (input.membershipDiscrepancy !== undefined) {
    const d = input.membershipDiscrepancy
    upClause =
      d.expected_count !== undefined
        ? `${d.connected_expected_count ?? d.connected_durable_launches}/${d.expected_count} up`
        : `${d.connected_durable_launches}/${d.known_durable_launches} up`
    if (d.missing.length > 0) {
      missingClause = ` · missing ${d.missing.map((r) => r.name).join(" ")}`
    }
  } else if (typeof input.headline === "string" && input.headline.length > 0) {
    const match = /—\s*(\d+\/\d+)\s+[^;]+(?:;\s*missing:\s*(.+))?$/u.exec(input.headline)
    if (match !== null) {
      upClause = `${match[1]} up`
      const names = match[2]
        ?.split(/,\s*/u)
        .map((n) => n.trim())
        .filter(Boolean)
      if (names && names.length > 0) {
        missingClause = ` · missing ${names.join(" ")}`
      }
    } else {
      missingClause = ` · ${input.headline}`
    }
  }
  const rawHead = `tribe ${input.name} ${input.deliveryClause} · ${upClause}`
  const cappedHead = rawHead.length > 100 ? `${rawHead.slice(0, 99)}…` : rawHead
  return `${cappedHead}${missingClause}`
}

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
    ...(event.ts ? { sent_at: formatZonedSentAt(String(event.ts)) } : {}),
  }
}

/**
 * 29327 — the settlement facts ride the envelope META beside the replay facts.
 *
 * A settled ball is not owed work, and the daemon knows that at drain time.
 * Dropping the facts at the pane boundary is what let a request settled 78 ms
 * after it was sent open a turn looking owed (live specimen 5e8b, 2026-10-17).
 * `settled` is the flag that decides the type marker; `settled_by` names the
 * seat when the daemon's own settlement record has one. Both are absent on an
 * unsettled row, so an ordinary envelope is byte-for-byte what it was.
 */
export function settledEnvelopeMeta(event: { settled?: boolean; settled_by?: string | null }): {
  settled?: string
  settled_by?: string
} {
  if (event.settled !== true) return {}
  const by = typeof event.settled_by === "string" && event.settled_by.length > 0 ? event.settled_by : undefined
  return { settled: "true", ...(by ? { settled_by: by } : {}) }
}

/**
 * 29327 row 5 (@cto 1eb4c66c req 1) — a ball-opening row's directive names only
 * the message it re-presents, so the facts a reader would have got from the
 * body travel in the envelope META: `from`, `type`, `message_id` and `sent_at`
 * are set by the caller, and the sender's SUMMARY rides here.
 *
 * Free text in an attribute is the one value the host renders verbatim; it is
 * escaped for that context by `escapeEnvelopeMeta`, the single place the meta
 * is assembled before it leaves the wire. Absent on every row that is not a
 * directive, so those envelopes stay byte-for-byte what they were.
 */
export function directiveEnvelopeMeta(event: { summary?: string | null }): { summary?: string } {
  const summary = typeof event.summary === "string" ? event.summary.trim() : ""
  if (summary.length === 0) return {}
  return { summary }
}

/**
 * 29327 row 5 (@cto 66ffa581 req 2, amended by @cto 51217743 GO (a)) — ONE
 * attribute escaper, applied where the envelope meta is assembled, to every
 * value that reaches the host: summary, bead and topic are sender-set, and
 * `from`/`type`/`message_id`/`sent_at` pass through unchanged because they can
 * never contain an attribute-breaking character.
 *
 * The host escapes attributes, so the wire does not. Measured in the installed
 * Claude Code 2.1.302 channel renderer: every attribute is built as
 * ` ${key}="${Ks(value)}"`, where `Ks` escapes `&` `<` `>` `"` `'`, so the
 * host escapes `& < > " '` in meta values before the envelope reaches the pane.
 * Probe `c5bd4ebb` showed the old entities arriving double-escaped (`&quot;`
 * read back as `&amp;quot;`), which is the same fact from the other side: the
 * host was escaping what we had already escaped. One home per truth — rendering
 * and escaping belong to the host, so the wire only folds newlines, which an
 * attribute cannot carry.
 */
export function escapeEnvelopeMeta(meta: Record<string, string | undefined>): Record<string, string | undefined> {
  const safe: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(meta)) {
    safe[key] = value === undefined ? undefined : attributeSafe(value)
  }
  return safe
}

function attributeSafe(text: string): string {
  return text.replace(/[\r\n]+/g, " ")
}
