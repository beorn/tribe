import { settlesRequestOpenedBy, type MessageInsertedInfo } from "./context.ts"
import { createLogger } from "loggily"
import type { InboxWaitResult as WireInboxWaitResult, InboxWaitWokenBy } from "tribe-wire"
import {
  ACTIONABLE_TYPES_SET as ACTIONABLE_TYPES,
  CORRELATED_REPLY_TYPES_SET,
  type TribeStatements,
} from "./database.ts"

const log = createLogger("tribe:inbox-wait")

/** 25662 row 17 — name the row a wait woke on. `settles_request_id` is set only when the wait opted into correlated
 *  replies and this row settled a request `session` opened, which is the only case where a reply is the wake. */
export function readInboxWaitWokenBy(
  stmts: TribeStatements,
  session: string,
  seq: number,
  wakeOnCorrelatedReply: boolean,
): InboxWaitWokenBy {
  const row = stmts.selectInboxWaitWakeRow.get({ $seq: seq }) as {
    id: string
    type: string
    sender: string
    summary: string | null
    ts: number
    request: string | null
    reply: string | null
    correlated_reply_requester: string | null
  } | null
  if (row === null) return { kind: "row-retired", seq }
  const settles =
    wakeOnCorrelatedReply && CORRELATED_REPLY_TYPES_SET.has(row.type) && row.correlated_reply_requester === session
  // 27407 - a wake must not read like a fresh instruction. The tracker keeps an
  // untaken ball actionable past the mailbox cursor (22203), so the wake is not
  // suppressed; it names the row's ORIGINAL send time and says it is a replay
  // when the mailbox has already been shown this row.
  const cursor = stmts.getMailboxCursor.get({ $recipient: session }) as { last_actionable_seq: number } | null
  const replay = cursor !== null && seq <= cursor.last_actionable_seq
  return {
    kind: "message",
    seq,
    message_id: row.id,
    type: row.type,
    sender: row.sender,
    summary: row.summary,
    request_id: row.request,
    settles_request_id: settles ? row.reply : null,
    sent_at: new Date(row.ts).toISOString(),
    replay,
  }
}

export type InboxStatus = Pick<
  WireInboxWaitResult,
  "session" | "unread_count" | "oldest_unread_age_min" | "oldest_unread_ts"
>

type Waiter = {
  readonly connId: string
  readonly session: string
  /** The mailbox owner is the one waiting, so this wait consumes `session`'s mailbox. */
  readonly consumesMailbox: boolean
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
  readCurrentQualifyingSeq: (session: string, wakeOnCorrelatedReply: boolean, status: InboxStatus) => number = () => 0,
  /** Names the row a wake fired on. Rigs that do not pass it get no `woken_by`; the daemon always passes it. */
  readWokenBy?: (session: string, seq: number, wakeOnCorrelatedReply: boolean) => InboxWaitWokenBy,
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
    wokenBy?: InboxWaitWokenBy,
  ): InboxWaitChunkResult {
    return {
      status: flags.aborted ? "aborted" : flags.timedOut ? "timeout" : "woken",
      ...snapshot.status,
      // The list is the actionable contract; the scalar is only its projection.
      // Taking a max across two reads produced an impossible payload — a positive
      // count beside no rows the caller could inspect or discharge.
      unread_count: snapshot.attention.actionable_unread.length,
      waited_ms: waitedMs,
      effective_timeout_ms: effectiveTimeoutMs,
      timed_out: flags.timedOut,
      aborted: flags.aborted,
      attention: snapshot.attention,
      ...(wokenBy === undefined ? {} : { woken_by: wokenBy }),
      baseline_seq: baselineSeq,
    }
  }

  /** The waking row for a woken result; undefined for a timeout or an abort, which no row caused. */
  function wokenBy(
    session: string,
    wakeOnCorrelatedReply: boolean,
    seq: number,
    flags: { timedOut: boolean; aborted: boolean },
  ): InboxWaitWokenBy | undefined {
    if (flags.timedOut || flags.aborted || readWokenBy === undefined) return undefined
    const woken = readWokenBy(session, seq, wakeOnCorrelatedReply)
    // 27407 - a wake that names a row the mailbox cursor is already past is a
    // REPLAY, not news. Say so in the daemon log so the showing path is
    // observable: the settled specimens surfaced exactly this way, named by the
    // durable qualifying tail on a resumed chunk rather than by a fresh wait.
    if (woken.kind === "message" && woken.replay === true) {
      log.info?.(
        `inbox-wait: waking ${session} on a REPLAY of row ${woken.seq} (${woken.message_id ?? "unknown"}) first sent ${woken.sent_at}`,
      )
    }
    return woken
  }

  /** The sequence a snapshot wake fired on: a fresh wait wakes on the newest unacknowledged row, a resumed wait on
   *  the newest row past its baseline. */
  function snapshotWakeSeq(snapshot: InboxWaitSnapshot, freshLogicalWait: boolean): number {
    return freshLogicalWait && snapshot.currentQualifyingSeq > 0
      ? snapshot.currentQualifyingSeq
      : snapshot.latestQualifyingSeq
  }

  /**
   * 28911: the baseline a settled chunk HANDS BACK must cover every row that
   * chunk delivered — the row it woke on and the newest rows in its snapshot
   * (qualifying tail + actionable_unread). Returning the chunk's STARTING
   * baseline made both resumers re-derive latest > baseline and wake again
   * on the same row, even after the seat read it and the mailbox cursor
   * advanced past it: tent await's watch factory (seat-await.ts, resuming
   * after a WOKEN reply with after_seq = the returned baseline) and the
   * wire CLI loop (cli/read.ts, resuming after a TIMED-OUT chunk). An aborted chunk keeps its
   * starting baseline: nothing it carried was reliably delivered. Fresh
   * waits are unaffected (they key on the cursor-aware tail), and a resumed
   * chunk with an explicit older baseline still names a past-cursor row a
   * replay (27407) — it just cannot loop on it.
   */
  function deliveredBaselineSeq(snapshot: InboxWaitSnapshot, baselineSeq: number, wakeSeq: number): number {
    let delivered = Math.max(baselineSeq, wakeSeq, snapshot.latestQualifyingSeq)
    for (const row of snapshot.attention.actionable_unread) {
      if (typeof row.rowid === "number" && row.rowid > delivered) delivered = row.rowid
    }
    return delivered
  }

  /** The newest actionable attention row past `pastSeq`, or 0 when none is. */
  function newestAttentionSeq(snapshot: InboxWaitSnapshot, pastSeq: number): number {
    let newest = 0
    for (const row of snapshot.attention.actionable_unread) {
      if (typeof row.rowid === "number" && row.rowid > pastSeq && row.rowid > newest) newest = row.rowid
    }
    return newest
  }

  /**
   * 30414 (recurrence of 22378): the terminal outcome of a deadline, timer or 0 ms poll. The wake predicate
   * (actionable types, incidents, and under the opt-in a correlated reply) can leave an actionable attention row
   * unwoken — every direct response is attention, and a response wakes only when it settles or names an OPEN
   * ball. Such a row that ARRIVED during the window is not a quiet deadline: it settles `woken` naming the
   * newest one, so a caller reading `status` alone never sleeps on real work. A row at or below the baseline
   * predates the wait and keeps `timeout` with the attention listed, exactly as a15abfb7 ruled: old attention
   * stays visible without manufacturing a wake, and nothing loops on it.
   */
  function deadlineOutcome(
    snapshot: InboxWaitSnapshot,
    baselineSeq: number,
  ): { flags: { timedOut: boolean; aborted: boolean }; wakeSeq: number } {
    const wakeSeq = newestAttentionSeq(snapshot, baselineSeq)
    return wakeSeq > 0
      ? { flags: { timedOut: false, aborted: false }, wakeSeq }
      : { flags: { timedOut: true, aborted: false }, wakeSeq: 0 }
  }

  function settleAtDeadline(waiter: Waiter): void {
    if (waiter.done) return
    const snapshot = readSnapshot(waiter.session, waiter.wakeOnCorrelatedReply)
    const outcome = deadlineOutcome(snapshot, waiter.baselineSeq)
    if (outcome.wakeSeq > 0) {
      log.info?.(
        `inbox-wait: deadline for ${waiter.session} settles woken on retained attention row ${outcome.wakeSeq}, which arrived during the window past baseline ${waiter.baselineSeq} (30414)`,
      )
    }
    settle(waiter, outcome.flags, outcome.wakeSeq, snapshot)
  }

  function settle(
    waiter: Waiter,
    flags: { timedOut: boolean; aborted: boolean },
    wakeSeq = 0,
    snapshot = readSnapshot(waiter.session, waiter.wakeOnCorrelatedReply),
  ): void {
    if (waiter.done) return
    waiter.done = true
    clearTimeout(waiter.timer)
    waiters.delete(waiter)
    waiter.resolve(
      assembleResult(
        snapshot,
        Date.now() - waiter.startedAt,
        waiter.effectiveTimeoutMs,
        flags.aborted ? waiter.baselineSeq : deliveredBaselineSeq(snapshot, waiter.baselineSeq, wakeSeq),
        flags,
        wokenBy(waiter.session, waiter.wakeOnCorrelatedReply, wakeSeq, flags),
      ),
    )
  }

  function settleForShutdown(waiter: Waiter): void {
    if (waiter.done) return
    waiter.done = true
    clearTimeout(waiter.timer)
    waiters.delete(waiter)
    const snapshot = readSnapshot(waiter.session, waiter.wakeOnCorrelatedReply)
    waiter.resolve({
      ...assembleResult(
        snapshot,
        Date.now() - waiter.startedAt,
        waiter.effectiveTimeoutMs,
        waiter.baselineSeq,
        { timedOut: false, aborted: false },
        readWokenBy === undefined ? undefined : { kind: "daemon-shutdown" },
      ),
      reconnect: true,
    })
  }

  function onMessageInserted(info: MessageInsertedInfo): void {
    if (info.kind === "event") return
    for (const waiter of Array.from(waiters)) {
      const directForWaiter = info.kind === "direct" && waiter.session === info.recipient
      const trackedBroadcastForWaiter = info.pendingOwners?.includes(waiter.session) === true
      if (!directForWaiter && !trackedBroadcastForWaiter) continue
      if (info.rowid <= waiter.baselineSeq) continue
      // SQL excludes quiet incidents even from opt-in correlated replies; match that durable qualification.
      // 29541: under the opt-in this is the same union the SQL tail arm computes under
      // $include_correlated_replies — a structured reply that settled the waiter's request, OR a
      // progress status whose ref names the still-open ball the waiter REQUESTED. Requester side
      // only, so an owner-side precision stays quiet. Focus-mode push keeps the settlement-only
      // question (settlesRequestOpenedBy); this arm is the opt-in alone, and widens no default.
      if (
        (info.isIncident !== true || info.wakesOwner === true) &&
        waiter.wakeOnCorrelatedReply &&
        CORRELATED_REPLY_TYPES_SET.has(info.type) &&
        (settlesRequestOpenedBy(info, waiter.session) || info.refBoundOpenRequest?.requester === waiter.session)
      ) {
        settle(waiter, { timedOut: false, aborted: false }, info.rowid)
        continue
      }
      // Default-wake on every actionable direct or owned tracked actionable message.
      // Do NOT require readStatus().unread_count > 0 here: that projection can
      // lag the insert (cursor race / concurrent ack) and swallow a live assign
      // while the seat remains armed — CTO residual 2026-07-25 on 21420
      // (@dev/3 sat in inbox-wait while type=assign had already landed).
      // Self-sends are excluded (same filter as getUnreadDms: sender != name).
      // 25662 P3 3: an incident edge wakes the same way (wakePredicateSql is the SQL half of this test).
      if (
        (info.wakesOwner === true ||
          info.pendingOwners?.includes(waiter.session) === true ||
          (ACTIONABLE_TYPES.has(info.type) && info.isIncident !== true)) &&
        info.sender !== waiter.session
      ) {
        settle(waiter, { timedOut: false, aborted: false }, info.rowid)
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

  /**
   * Consumer evidence for answer capability (24664): the mailbox owner has a
   * wait parked on `session` right now. A wait an operator parks on another
   * seat's mailbox never counts, exactly as it never writes that seat's read
   * receipt.
   */
  function hasLiveWaiter(session: string): boolean {
    for (const waiter of waiters) {
      if (waiter.session === session && waiter.consumesMailbox) return true
    }
    return false
  }

  function wait(
    session: string,
    connId: string,
    timeoutMs: number,
    opts: {
      readonly wakeOnCorrelatedReply?: boolean
      readonly afterSeq?: number
      readonly consumesMailbox?: boolean
    } = {},
  ): Promise<InboxWaitChunkResult> {
    const effectiveTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0
    const wakeOnCorrelatedReply = opts.wakeOnCorrelatedReply === true
    const snapshot = readSnapshot(session, wakeOnCorrelatedReply)
    const freshLogicalWait = opts.afterSeq === undefined
    // 30414: a fresh logical wait's baseline also covers the actionable attention present at its start, so a
    // deadline can tell a row that ARRIVED during the window from one that predates the wait (a15abfb7). Every
    // settled chunk already hands back a baseline past its attention rows (deliveredBaselineSeq); this aligns
    // the first chunk with the later ones.
    const baselineSeq = opts.afterSeq ?? Math.max(snapshot.latestQualifyingSeq, newestAttentionSeq(snapshot, 0))
    const shouldWake = freshLogicalWait ? snapshot.currentQualifyingSeq > 0 : snapshot.latestQualifyingSeq > baselineSeq
    if (shouldWake) {
      const flags = { timedOut: false, aborted: false }
      const wakeSeq = snapshotWakeSeq(snapshot, freshLogicalWait)
      return Promise.resolve(
        assembleResult(
          snapshot,
          0,
          effectiveTimeoutMs,
          deliveredBaselineSeq(snapshot, baselineSeq, wakeSeq),
          flags,
          wokenBy(session, wakeOnCorrelatedReply, wakeSeq, flags),
        ),
      )
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      const outcome = deadlineOutcome(snapshot, baselineSeq)
      return Promise.resolve(
        assembleResult(
          snapshot,
          0,
          effectiveTimeoutMs,
          deliveredBaselineSeq(snapshot, baselineSeq, outcome.wakeSeq),
          outcome.flags,
          wokenBy(session, wakeOnCorrelatedReply, outcome.wakeSeq, outcome.flags),
        ),
      )
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        connId,
        session,
        consumesMailbox: opts.consumesMailbox === true,
        baselineSeq,
        startedAt: Date.now(),
        effectiveTimeoutMs,
        wakeOnCorrelatedReply,
        resolve,
        done: false,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      }
      waiter.timer = setTimeout(() => settleAtDeadline(waiter), effectiveTimeoutMs)
      waiters.add(waiter)

      // Condition-variable discipline: check, subscribe, then recheck. A row
      // inserted between the first snapshot and waiter registration must not
      // need a second message to wake the receive rail.
      const afterSubscribe = readSnapshot(session, wakeOnCorrelatedReply)
      const raced = freshLogicalWait
        ? afterSubscribe.currentQualifyingSeq > 0 || afterSubscribe.latestQualifyingSeq > baselineSeq
        : afterSubscribe.latestQualifyingSeq > baselineSeq
      if (raced) {
        settle(
          waiter,
          { timedOut: false, aborted: false },
          snapshotWakeSeq(afterSubscribe, freshLogicalWait),
          afterSubscribe,
        )
      }
    })
  }

  return {
    wait,
    hasLiveWaiter,
    onMessageInserted,
    cancelConnection,
    shutdown,
  }
}
