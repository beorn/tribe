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

type InboxWaitSnapshot = {
  readonly status: InboxStatus
  readonly attention: WireInboxWaitResult["attention"]
  readonly currentQualifyingSeq: number
  readonly latestQualifyingSeq: number
}

export function createInboxWaitManager(
  readStatus: (session: string) => InboxStatus,
  readAttention: (session: string) => WireInboxWaitResult["attention"],
  readLatestQualifyingSeq: (session: string, wakeOnCorrelatedReply: boolean) => number = () => 0,
  readCurrentQualifyingSeq: (session: string, wakeOnCorrelatedReply: boolean, status: InboxStatus) => number = (
    _session,
    _wakeOnCorrelatedReply,
    status,
  ) => (status.unread_count > 0 ? 1 : 0),
) {
  const waiters = new Set<Waiter>()

  function readSnapshot(session: string, wakeOnCorrelatedReply: boolean): InboxWaitSnapshot {
    const status = readStatus(session)
    return {
      status,
      attention: readAttention(session),
      currentQualifyingSeq: readCurrentQualifyingSeq(session, wakeOnCorrelatedReply, status),
      latestQualifyingSeq: readLatestQualifyingSeq(session, wakeOnCorrelatedReply),
    }
  }

  function assembleResult(
    snapshot: InboxWaitSnapshot,
    waitedMs: number,
    effectiveTimeoutMs: number,
    baselineSeq: number,
    flags: { timedOut: boolean; aborted: boolean },
  ): InboxWaitChunkResult {
    return {
      status: flags.aborted ? "aborted" : flags.timedOut ? "timeout" : "woken",
      ...snapshot.status,
      // unread_count reconciles TWO independent reads instead of trusting one.
      // The status projection and the attention projection are separate queries and
      // nothing made them agree, so a payload could report unread_count: 0 beside a
      // non-empty actionable_unread — measured four times in one seat's waits. The
      // seat reads the count, concludes nothing arrived, and sleeps on top of work
      // it was just handed.
      //
      // Neither source is authoritative, and each is empty when the other is not:
      // the status projection lags an insert (the cursor race onMessageInserted
      // below already refuses to trust), while attention can be empty for a live
      // assign the status read can see. Taking the max is the only combination that
      // never UNDER-reports, and under-reporting is the harmful direction — it is
      // what puts a seat back to sleep on top of real work.
      //
      // Deriving purely from actionable_unread was tried and is wrong: it returns
      // zero for a landed assign whose row attention has not projected yet.
      unread_count: Math.max(snapshot.status.unread_count, snapshot.attention.actionable_unread.length),
      waited_ms: waitedMs,
      effective_timeout_ms: effectiveTimeoutMs,
      timed_out: flags.timedOut,
      aborted: flags.aborted,
      attention: snapshot.attention,
      baseline_seq: baselineSeq,
    }
  }

  function settle(
    waiter: Waiter,
    flags: { timedOut: boolean; aborted: boolean },
    snapshot = readSnapshot(waiter.session, waiter.wakeOnCorrelatedReply),
  ): void {
    if (waiter.done) return
    waiter.done = true
    clearTimeout(waiter.timer)
    waiters.delete(waiter)
    waiter.resolve(
      assembleResult(snapshot, Date.now() - waiter.startedAt, waiter.effectiveTimeoutMs, waiter.baselineSeq, flags),
    )
  }

  function settleForShutdown(waiter: Waiter): void {
    if (waiter.done) return
    waiter.done = true
    clearTimeout(waiter.timer)
    waiters.delete(waiter)
    const snapshot = readSnapshot(waiter.session, waiter.wakeOnCorrelatedReply)
    waiter.resolve({
      ...assembleResult(snapshot, Date.now() - waiter.startedAt, waiter.effectiveTimeoutMs, waiter.baselineSeq, {
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
    const wakeOnCorrelatedReply = opts.wakeOnCorrelatedReply === true
    const snapshot = readSnapshot(session, wakeOnCorrelatedReply)
    const freshLogicalWait = opts.afterSeq === undefined
    const baselineSeq = opts.afterSeq ?? snapshot.latestQualifyingSeq
    const shouldWake = freshLogicalWait ? snapshot.currentQualifyingSeq > 0 : snapshot.latestQualifyingSeq > baselineSeq
    if (shouldWake) {
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

      // Condition-variable discipline: check, subscribe, then recheck. A row
      // inserted between the first snapshot and waiter registration must not
      // need a second message to wake the receive rail.
      const afterSubscribe = readSnapshot(session, wakeOnCorrelatedReply)
      const raced = freshLogicalWait
        ? afterSubscribe.currentQualifyingSeq > 0 || afterSubscribe.latestQualifyingSeq > baselineSeq
        : afterSubscribe.latestQualifyingSeq > baselineSeq
      if (raced) settle(waiter, { timedOut: false, aborted: false }, afterSubscribe)
    })
  }

  return {
    wait,
    onMessageInserted,
    cancelConnection,
    shutdown,
  }
}
