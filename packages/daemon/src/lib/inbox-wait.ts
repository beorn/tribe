import type { MessageInsertedInfo } from "./context.ts"
import { normalizeInboxWaitResult, type InboxWaitResult as WireInboxWaitResult } from "tribe-wire"
import { ACTIONABLE_TYPES_SET as ACTIONABLE_TYPES } from "./database.ts"

const CORRELATED_REPLY_TYPES = new Set(["response", "status"])

export type InboxStatus = Pick<
  WireInboxWaitResult,
  "session" | "unread_count" | "oldest_unread_age_min" | "oldest_unread_ts"
>

type Waiter = {
  readonly connId: string
  readonly session: string
  readonly startedAt: number
  readonly effectiveTimeoutMs: number
  readonly wakeOnCorrelatedReply: boolean
  readonly resolve: (result: WireInboxWaitResult) => void
  timer: ReturnType<typeof setTimeout>
  done: boolean
}

export function createInboxWaitManager(
  readStatus: (session: string) => InboxStatus,
  readAttention: (session: string) => WireInboxWaitResult["attention"],
) {
  const waiters = new Set<Waiter>()

  function assembleResult(
    status: InboxStatus,
    waitedMs: number,
    effectiveTimeoutMs: number,
    flags: { timedOut: boolean; aborted: boolean },
  ): WireInboxWaitResult {
    return normalizeInboxWaitResult({
      status: flags.aborted ? "aborted" : flags.timedOut ? "timeout" : "woken",
      ...status,
      waited_ms: waitedMs,
      effective_timeout_ms: effectiveTimeoutMs,
      timed_out: flags.timedOut,
      aborted: flags.aborted,
      attention: readAttention(status.session),
    })
  }

  function settle(waiter: Waiter, flags: { timedOut: boolean; aborted: boolean }): void {
    if (waiter.done) return
    waiter.done = true
    clearTimeout(waiter.timer)
    waiters.delete(waiter)
    const status = readStatus(waiter.session)
    waiter.resolve(assembleResult(status, Date.now() - waiter.startedAt, waiter.effectiveTimeoutMs, flags))
  }

  function onMessageInserted(info: MessageInsertedInfo): void {
    if (info.kind !== "direct") return
    for (const waiter of Array.from(waiters)) {
      if (waiter.session !== info.recipient) continue
      if (
        waiter.wakeOnCorrelatedReply &&
        CORRELATED_REPLY_TYPES.has(info.type) &&
        info.correlatedReply !== null &&
        info.correlatedReply.requester === waiter.session
      ) {
        settle(waiter, { timedOut: false, aborted: false })
        continue
      }
      // Default-wake on every actionable direct addressed to this waiter.
      // Do NOT require readStatus().unread_count > 0 here: that projection can
      // lag the insert (cursor race / concurrent ack) and swallow a live assign
      // while the seat remains armed — CTO residual 2026-07-25 on 21420
      // (@dev/3 sat in inbox-wait while type=assign had already landed).
      // Self-sends are excluded (same filter as getUnreadDms: sender != name).
      if (ACTIONABLE_TYPES.has(info.type) && info.sender !== waiter.session) {
        settle(waiter, { timedOut: false, aborted: false })
      }
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
    opts: { readonly wakeOnCorrelatedReply?: boolean } = {},
  ): Promise<WireInboxWaitResult> {
    const effectiveTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0
    const snapshot = readStatus(session)
    if (snapshot.unread_count > 0) {
      return Promise.resolve(assembleResult(snapshot, 0, effectiveTimeoutMs, { timedOut: false, aborted: false }))
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.resolve(assembleResult(snapshot, 0, effectiveTimeoutMs, { timedOut: true, aborted: false }))
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        connId,
        session,
        startedAt: Date.now(),
        effectiveTimeoutMs,
        wakeOnCorrelatedReply: opts.wakeOnCorrelatedReply === true,
        resolve,
        done: false,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      }
      waiter.timer = setTimeout(() => settle(waiter, { timedOut: true, aborted: false }), effectiveTimeoutMs)
      waiters.add(waiter)
    })
  }

  return {
    wait,
    onMessageInserted,
    cancelConnection,
  }
}
