import type { MessageInsertedInfo } from "./context.ts"
import type { InboxDrainEvent, InboxDrainResult } from "./inbox-drain.ts"

const ACTIONABLE_TYPES = new Set(["request", "query", "verdict", "assign"])

export type InboxStatus = {
  session: string
  unread_count: number
  oldest_unread_age_min: number
  oldest_unread_ts: number
}

/**
 * Wait-and-drain result (20843 S1). Every non-aborted return atomically
 * drains the inbox — a return can never leave its own wake condition
 * standing (the busy-loop / immediate-re-wake class).
 *
 * `aborted: true` is the one exception: the connection died, the response is
 * undeliverable, so draining would silently consume rows nobody received.
 */
export type InboxWaitResult = {
  session: string
  events: InboxDrainEvent[]
  cursor: number
  /** Why the wait returned — stable vocabulary shared with `tent await` (and
   *  the future Habwire recv rebind): actionable | timeout | aborted. */
  wakeReason: "actionable" | "timeout" | "aborted"
  waited_ms: number
  timed_out: boolean
  aborted: boolean
}

/** Observer shape — `peek: true` preserves the pre-20843 status-only contract
 *  for watchers (seat-await internals, chief-silent watchdog). Never drains. */
export type InboxPeekResult = InboxStatus & {
  waited_ms: number
  timed_out: boolean
  aborted: boolean
}

type Waiter = {
  readonly connId: string
  readonly session: string
  readonly startedAt: number
  readonly peek: boolean
  readonly resolve: (result: InboxWaitResult | InboxPeekResult) => void
  timer: ReturnType<typeof setTimeout>
  done: boolean
}

export function createInboxWaitManager(
  readStatus: (session: string) => InboxStatus,
  drain: (session: string) => InboxDrainResult,
  /** Arm-time hook: make the session drainable BEFORE blocking, so a wake on
   *  a never-joined name drains the row that woke it (see
   *  `ensureDrainableSession`). Optional for status-only test harnesses. */
  ensure?: (session: string) => void,
) {
  const waiters = new Set<Waiter>()

  function drainResult(
    session: string,
    startedAt: number,
    flags: { timedOut: boolean; aborted: boolean },
  ): InboxWaitResult {
    // Aborted returns must NOT drain — see InboxWaitResult docs.
    const batch = flags.aborted ? { events: [], cursor: -1 } : drain(session)
    return {
      session,
      events: batch.events,
      cursor: batch.cursor,
      wakeReason: flags.aborted ? "aborted" : flags.timedOut ? "timeout" : "actionable",
      waited_ms: Date.now() - startedAt,
      timed_out: flags.timedOut,
      aborted: flags.aborted,
    }
  }

  function peekResult(session: string, startedAt: number, flags: { timedOut: boolean; aborted: boolean }): InboxPeekResult {
    return {
      ...readStatus(session),
      waited_ms: Date.now() - startedAt,
      timed_out: flags.timedOut,
      aborted: flags.aborted,
    }
  }

  function settle(waiter: Waiter, flags: { timedOut: boolean; aborted: boolean }): void {
    if (waiter.done) return
    waiter.done = true
    clearTimeout(waiter.timer)
    waiters.delete(waiter)
    waiter.resolve(
      waiter.peek ? peekResult(waiter.session, waiter.startedAt, flags) : drainResult(waiter.session, waiter.startedAt, flags),
    )
  }

  function onMessageInserted(info: MessageInsertedInfo): void {
    // Wake filter stays actionable-only (20843): ambient notify/status/health
    // rows never wake a wait — they are delivered on the timeout drain.
    if (info.kind !== "direct") return
    if (!ACTIONABLE_TYPES.has(info.type)) return
    for (const waiter of Array.from(waiters)) {
      if (waiter.session === info.recipient) settle(waiter, { timedOut: false, aborted: false })
    }
  }

  function cancelConnection(connId: string): void {
    for (const waiter of Array.from(waiters)) {
      if (waiter.connId === connId) settle(waiter, { timedOut: false, aborted: true })
    }
  }

  function wait(
    session: string,
    connId: string,
    timeoutMs: number,
    opts: { peek?: boolean } = {},
  ): Promise<InboxWaitResult | InboxPeekResult> {
    const peek = opts.peek === true
    const startedAt = Date.now()
    if (!peek) ensure?.(session)
    const snapshot = readStatus(session)

    // Stale actionable rows at arm-time: return (and, unless peeking, drain)
    // immediately — never block while work is already waiting.
    if (snapshot.unread_count > 0) {
      return Promise.resolve(
        peek
          ? { ...snapshot, waited_ms: 0, timed_out: false, aborted: false }
          : drainResult(session, startedAt, { timedOut: false, aborted: false }),
      )
    }
    // timeout <= 0 is the plain-drain alias (`tribe fetch`, 20843 S2): one
    // atomic drain, timed_out flagged so loop callers re-arm normally.
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.resolve(
        peek
          ? { ...snapshot, waited_ms: 0, timed_out: true, aborted: false }
          : drainResult(session, startedAt, { timedOut: true, aborted: false }),
      )
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        connId,
        session,
        startedAt,
        peek,
        resolve,
        done: false,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      }
      waiter.timer = setTimeout(() => settle(waiter, { timedOut: true, aborted: false }), timeoutMs)
      waiters.add(waiter)
    })
  }

  return {
    wait,
    onMessageInserted,
    cancelConnection,
  }
}
