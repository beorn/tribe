import type { MessageInsertedInfo } from "./context.ts"
import type { InboxWaitResult as WireInboxWaitResult } from "tribe-wire"
import {
  ACTIONABLE_TYPES_SET as ACTIONABLE_TYPES,
  CORRELATED_REPLY_TYPES_SET as CORRELATED_REPLY_TYPES,
} from "./database.ts"

export type InboxStatus = Pick<
  WireInboxWaitResult,
  "session" | "unread_count" | "oldest_unread_age_min" | "oldest_unread_ts"
>

type Waiter = {
  readonly connId: string
  readonly session: string
  readonly baselineSeq: number
  readonly startedAt: number
  readonly effectiveTimeoutMs: number
  readonly wakeOnCorrelatedReply: boolean
  readonly resolve: (result: InboxWaitChunkResult) => void
  timer: ReturnType<typeof setTimeout>
  done: boolean
}

export type InboxWaitChunkResult = WireInboxWaitResult & {
  /** Private CLI reconnect cursor; stripped before public MCP/CLI output. */
  readonly baseline_seq: number
}

export function createInboxWaitManager(
  readStatus: (session: string) => InboxStatus,
  readAttention: (session: string) => WireInboxWaitResult["attention"],
  readLatestQualifyingSeq: (session: string, wakeOnCorrelatedReply: boolean) => number = () => 0,
) {
  const waiters = new Set<Waiter>()

  function assembleResult(
    status: InboxStatus,
    waitedMs: number,
    effectiveTimeoutMs: number,
    baselineSeq: number,
    flags: { timedOut: boolean; aborted: boolean },
  ): InboxWaitChunkResult {
    return {
      status: flags.aborted ? "aborted" : flags.timedOut ? "timeout" : "woken",
      ...status,
      waited_ms: waitedMs,
      effective_timeout_ms: effectiveTimeoutMs,
      timed_out: flags.timedOut,
      aborted: flags.aborted,
      attention: readAttention(status.session),
      baseline_seq: baselineSeq,
    }
  }

  function settle(waiter: Waiter, flags: { timedOut: boolean; aborted: boolean }): void {
    if (waiter.done) return
    waiter.done = true
    clearTimeout(waiter.timer)
    waiters.delete(waiter)
    const status = readStatus(waiter.session)
    waiter.resolve(
      assembleResult(status, Date.now() - waiter.startedAt, waiter.effectiveTimeoutMs, waiter.baselineSeq, flags),
    )
  }

  function settleForShutdown(waiter: Waiter): void {
    if (waiter.done) return
    waiter.done = true
    clearTimeout(waiter.timer)
    waiters.delete(waiter)
    const status = readStatus(waiter.session)
    waiter.resolve({
      ...assembleResult(status, Date.now() - waiter.startedAt, waiter.effectiveTimeoutMs, waiter.baselineSeq, {
        timedOut: false,
        aborted: false,
      }),
      reconnect: true,
    })
  }

  function onMessageInserted(info: MessageInsertedInfo): void {
    if (info.kind !== "direct") return
    for (const waiter of Array.from(waiters)) {
      if (waiter.session !== info.recipient) continue
      if (info.rowid <= waiter.baselineSeq) continue
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

  function shutdown(): void {
    for (const waiter of Array.from(waiters)) settleForShutdown(waiter)
  }

  function wait(
    session: string,
    connId: string,
    timeoutMs: number,
    opts: { readonly wakeOnCorrelatedReply?: boolean; readonly afterSeq?: number } = {},
  ): Promise<InboxWaitChunkResult> {
    const effectiveTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0
    const snapshot = readStatus(session)
    const wakeOnCorrelatedReply = opts.wakeOnCorrelatedReply === true
    const latestSeq = readLatestQualifyingSeq(session, wakeOnCorrelatedReply)
    const baselineSeq = opts.afterSeq ?? latestSeq
    if (latestSeq > baselineSeq) {
      return Promise.resolve(
        assembleResult(snapshot, 0, effectiveTimeoutMs, baselineSeq, { timedOut: false, aborted: false }),
      )
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.resolve(
        assembleResult(snapshot, 0, effectiveTimeoutMs, baselineSeq, { timedOut: true, aborted: false }),
      )
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        connId,
        session,
        baselineSeq,
        startedAt: Date.now(),
        effectiveTimeoutMs,
        wakeOnCorrelatedReply,
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
    shutdown,
  }
}
