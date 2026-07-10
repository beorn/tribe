import type { MessageInsertedInfo } from "./context.ts"
import { ACTIONABLE_TYPES_SET as ACTIONABLE_TYPES } from "./database.ts"

export type InboxStatus = {
  session: string
  unread_count: number
  oldest_unread_age_min: number
  oldest_unread_ts: number
}

export type InboxWaitResult = InboxStatus & {
  waited_ms: number
  timed_out: boolean
  aborted: boolean
}

type Waiter = {
  readonly connId: string
  readonly session: string
  readonly startedAt: number
  readonly resolve: (result: InboxWaitResult) => void
  timer: ReturnType<typeof setTimeout>
  done: boolean
}

export function createInboxWaitManager(readStatus: (session: string) => InboxStatus) {
  const waiters = new Set<Waiter>()

  function settle(waiter: Waiter, flags: { timedOut: boolean; aborted: boolean }): void {
    if (waiter.done) return
    waiter.done = true
    clearTimeout(waiter.timer)
    waiters.delete(waiter)
    const status = readStatus(waiter.session)
    waiter.resolve({
      ...status,
      waited_ms: Date.now() - waiter.startedAt,
      timed_out: flags.timedOut,
      aborted: flags.aborted,
    })
  }

  function onMessageInserted(info: MessageInsertedInfo): void {
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

  function wait(session: string, connId: string, timeoutMs: number): Promise<InboxWaitResult> {
    const snapshot = readStatus(session)
    if (snapshot.unread_count > 0) {
      return Promise.resolve({
        ...snapshot,
        waited_ms: 0,
        timed_out: false,
        aborted: false,
      })
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.resolve({
        ...snapshot,
        waited_ms: 0,
        timed_out: true,
        aborted: false,
      })
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        connId,
        session,
        startedAt: Date.now(),
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
