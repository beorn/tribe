/**
 * Broadcast coalescer — merges multiple `broadcast`-kind messages to the same
 * recipient within a short window into one wakeup notification.
 *
 * Why: the daemon's socket push is wakeup-only. Coalescing bursts prevents
 * redundant wakeups while preserving every message in the durable SQLite log
 * for the client to drain with `tribe.fetch`.
 *
 * Design:
 *  - Per-connection queue + single flush timer.
 *  - Default window 400ms (override via `batchMs` constructor arg).
 *  - 0 = disabled (enqueue writes through immediately).
 *  - Cap at `maxEventsPerBatch` events per flush; excess is truncated with a
 *    "+N more events truncated" marker so one burst can't itself become
 *    context-saturating.
 *  - Single event and N>1 bursts both use the notification shape supplied by
 *    the caller.
 *  - Direct messages are NEVER batched — the caller is responsible for
 *    routing direct messages around the coalescer.
 */

export type PendingBroadcast = {
  id: string
  ts: number
  rowid: number
  type: string
  sender: string
  content: string // already scrubbed by caller
  bead_id: string | null
  /** Per-event reply hint derived at delivery time from kind + sender role +
   *  recipient (km-tribe.filter-collapse). Used by the focus-mode filter and
   *  by the batched-broadcast aggregator; not surfaced on the wire. */
  replyHint: "yes" | "no" | "optional"
  /** Originating event topic (e.g. `git:commit`); null for human messages. */
  topic: string | null
}

export type Notification = string // pre-serialized JSON-RPC line

export type CoalescerDeps = {
  /** Build a single-event notification in the wire format the caller expects. */
  singleEvent: (ev: PendingBroadcast) => Notification
  /** Build a consolidated notification for N>1 events. */
  batched: (events: PendingBroadcast[], droppedCount: number) => Notification
  /** Write to a live client. Returns false if the write failed (caller usually ignores). */
  write: (connId: string, payload: Notification) => boolean
  /** Advance per-event delivery cursor. Called once per event after a successful write. */
  onDelivered: (connId: string, ev: PendingBroadcast) => void
  /** setTimeout indirection so tests can use fake timers without leaking real ones. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  /** #38676: a flush write failed and its events were kept for retry. Called once per failure, never once per event. */
  onWriteFailed?: (connId: string, events: readonly PendingBroadcast[], attempt: number) => void
  /** #38676: the retry ceiling, so a wedged transport retries on a slow beat instead of a hot loop. */
  maxRetryMs?: number
}

export type Coalescer = {
  enqueue(connId: string, ev: PendingBroadcast): void
  flush(connId: string): void
  flushAll(): void
  /** Drop a connection's queue and hand back the wakes it still held, so the caller can say which rows
   *  the transport took with it instead of letting them disappear with no line (#38676). */
  discard(connId: string): PendingBroadcast[]
  pendingCount(connId: string): number
}

type TimerHandle = unknown // platform-varying: NodeJS.Timeout | number | bun TimerID
type Queue = {
  events: PendingBroadcast[]
  timer: TimerHandle | null
}

export function createCoalescer(opts: {
  batchMs: number
  maxEventsPerBatch: number
  deps: CoalescerDeps
  /** #38676: retry ceiling for a failed write; defaults to 5 s. */
  maxRetryMs?: number
}): Coalescer {
  const { batchMs, maxEventsPerBatch, maxRetryMs = 5_000 } = opts
  const { singleEvent, batched, write, onDelivered, onWriteFailed } = opts.deps
  const setTimer: (fn: () => void, ms: number) => unknown = opts.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer: (t: unknown) => void =
    opts.deps.clearTimer ?? ((t) => clearTimeout(t as Parameters<typeof clearTimeout>[0]))
  const queues = new Map<string, Queue>()

  /** Consecutive failed flushes per connection; reset by the first write that succeeds (#38676). */
  const failures = new Map<string, number>()

  function retryDelayMs(attempt: number): number {
    // Bounded backoff: a transport that is re-attaching comes back in seconds, so the ceiling stays short and the
    // queue never grows a long-lived timer (the 400 ms window is the floor, not a schedule).
    const base = batchMs === 0 ? 400 : batchMs
    return Math.min(base * 2 ** Math.min(attempt, 5), maxRetryMs)
  }

  function flushOne(connId: string): void {
    const q = queues.get(connId)
    if (!q) return
    if (q.timer) {
      clearTimer(q.timer)
      q.timer = null
    }
    const events = q.events
    if (events.length === 0) return

    const kept = events.length > maxEventsPerBatch ? events.slice(0, maxEventsPerBatch) : events
    const dropped = events.length - kept.length

    const payload = kept.length === 1 ? singleEvent(kept[0]!) : batched(kept, dropped)
    const ok = write(connId, payload)
    if (!ok) {
      // #38676: a failed write must not lose the wake. The events stay at the head, in order, and a bounded retry is
      // armed. Before this, the queue was emptied before the write and the timer cleared, so one failed socket write
      // discarded our own copy with nothing retrying and no line saying so: the row then read "never written to its
      // socket" until a process restart.
      q.events = events
      const attempt = (failures.get(connId) ?? 0) + 1
      failures.set(connId, attempt)
      onWriteFailed?.(connId, kept, attempt)
      q.timer = setTimer(() => flushOne(connId), retryDelayMs(attempt))
      return
    }
    failures.delete(connId)
    q.events = events.slice(kept.length)
    // Every event the payload accounted for has been written, including the ones past the per-batch cap: the batched
    // marker tells the client to drain, so leaving their cursors behind would report them held when they were covered.
    for (const ev of events) onDelivered(connId, ev)
  }

  return {
    enqueue(connId, ev) {
      if (batchMs === 0) {
        // Batching disabled - write through immediately, and on failure keep the event queued for the retry path (#38676).
        const ok = write(connId, singleEvent(ev))
        if (ok) {
          failures.delete(connId)
          onDelivered(connId, ev)
          return
        }
        let q = queues.get(connId)
        if (!q) {
          q = { events: [], timer: null }
          queues.set(connId, q)
        }
        q.events.push(ev)
        const attempt = (failures.get(connId) ?? 0) + 1
        failures.set(connId, attempt)
        onWriteFailed?.(connId, [ev], attempt)
        if (!q.timer) q.timer = setTimer(() => flushOne(connId), retryDelayMs(attempt))
        return
      }
      let q = queues.get(connId)
      if (!q) {
        q = { events: [], timer: null }
        queues.set(connId, q)
      }
      q.events.push(ev)
      if (!q.timer) {
        q.timer = setTimer(() => flushOne(connId), batchMs)
      }
    },
    flush(connId) {
      flushOne(connId)
    },
    flushAll() {
      for (const connId of queues.keys()) flushOne(connId)
    },
    discard(connId) {
      const q = queues.get(connId)
      failures.delete(connId)
      if (!q) return []
      if (q.timer) clearTimer(q.timer)
      queues.delete(connId)
      return q.events
    },
    pendingCount(connId) {
      return queues.get(connId)?.events.length ?? 0
    },
  }
}
