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
}

export function createForwardedAttentionTracker(maxIds = MAX_FORWARDED_ATTENTION_IDS): ForwardedAttentionTracker {
  const forwarded = new Set<string>()
  return {
    has(id) {
      return id !== undefined && forwarded.has(id)
    },
    remember(id) {
      if (id === undefined || forwarded.has(id)) return
      forwarded.add(id)
      if (forwarded.size > maxIds) {
        const oldest = forwarded.values().next().value
        if (oldest !== undefined) forwarded.delete(oldest)
      }
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
