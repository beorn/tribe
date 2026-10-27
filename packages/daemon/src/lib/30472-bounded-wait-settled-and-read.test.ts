/**
 * @failure A bounded `tribe inbox-wait` or `tent await` wakes immediately on a
 *          request that its sender (or @chief, another fanout-first owner, or
 *          expiry) already settled before the wait was armed, because
 *          `getLatestInboxWaitMessage` checks only `unretiredAttentionPredicateSql`
 *          (recipient reply or TAKING status) and `incidentEdgeOpenSql` (#29289),
 *          never whether a non-incident request's ball is still open in
 *          `pending_request`; and `newestAttentionSeq` in `inbox-wait.ts` treats
 *          `settled: true` rows in `actionable_unread` (#29327) as deadline wakes.
 * @level   l1
 * @consumer #30472; `getLatestInboxWaitMessage`, `getLatestTrackedInboxWaitMessage`,
 *           and `createInboxWaitManager`
 * @testonly none
 */
import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, readAttentionProjection, type HandlerOpts } from "./handlers.ts"
import { createInboxWaitManager, readInboxWaitWokenBy, type InboxStatus } from "./inbox-wait.ts"
import { sendMessage, settlePendingRows, type PendingSettlementRow } from "./messaging.ts"
import { registerSession } from "./session.ts"

const SENDER = "@dev/3"
const RECIPIENT = "@dev/11"
const PEER = "@dev/7"
const CHIEF = "@chief"
const QUIET_MS = 40

type Fixture = {
  dir: string
  db: Database
  stmts: TribeStatements
  sender: TribeContext
  recipient: TribeContext
  peer: TribeContext
  chief: TribeContext
  manager: ReturnType<typeof createInboxWaitManager>
  latestDirectWakeSeq: (session: string, wakeOnCorrelatedReply: boolean, unacknowledgedOnly: boolean) => number
  latestTrackedWakeSeq: (session: string) => number
  latestWakeSeq: (session: string, wakeOnCorrelatedReply: boolean, unacknowledgedOnly: boolean) => number
}

const opened: Fixture[] = []

const handlerOpts = (): HandlerOpts => ({
  cleanup: () => {},
  userRenamed: false,
  setUserRenamed: () => {},
  getActiveSessionIds: () => new Set<string>(),
  hasActiveTransport: () => false,
  getActiveSessionInfo: () => [],
})

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tribe-30472-"))
  const db = openDatabase(join(dir, "tribe.db"))
  const stmts = createStatements(db)

  const makeCtx = (
    sessionId: string,
    name: string,
    onMessageInserted?: TribeContext["onMessageInserted"],
  ): TribeContext => {
    const ctx = createTribeContext({
      db,
      stmts,
      sessionId,
      sessionRole: "member",
      initialName: name,
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
      onMessageInserted,
    })
    registerSession(ctx, undefined, () => false, null, 0, "pull")
    return ctx
  }

  const reader = makeCtx("sess-reader", "@reader")

  const latestDirectWakeSeq = (
    session: string,
    wakeOnCorrelatedReply: boolean,
    unacknowledgedOnly: boolean,
  ): number => {
    const row = stmts.getLatestInboxWaitMessage.get({
      $name: session,
      $include_correlated_replies: wakeOnCorrelatedReply ? 1 : 0,
      $unacknowledged_only: unacknowledgedOnly ? 1 : 0,
    }) as { rowid: number } | null
    return row?.rowid ?? 0
  }

  const latestTrackedWakeSeq = (session: string): number => {
    const row = stmts.getLatestTrackedInboxWaitMessage.get({
      $name: session,
    }) as { rowid: number } | null
    return row?.rowid ?? 0
  }

  const latestWakeSeq = (session: string, wakeOnCorrelatedReply: boolean, unacknowledgedOnly: boolean): number => {
    return Math.max(
      latestDirectWakeSeq(session, wakeOnCorrelatedReply, unacknowledgedOnly),
      latestTrackedWakeSeq(session),
    )
  }

  const status = (session: string): InboxStatus => ({
    session,
    unread_count: 0,
    oldest_unread_age_min: 0,
    oldest_unread_ts: 0,
  })

  const manager = createInboxWaitManager(
    status,
    (session) => readAttentionProjection(reader, session, Date.now(), 0, handlerOpts()).attention,
    (session, wakeOnCorrelatedReply) => latestWakeSeq(session, wakeOnCorrelatedReply, false),
    (session, wakeOnCorrelatedReply) => latestWakeSeq(session, wakeOnCorrelatedReply, true),
    (session, seq, wakeOnCorrelatedReply) => readInboxWaitWokenBy(stmts, session, seq, wakeOnCorrelatedReply),
  )

  const sender = makeCtx("sess-sender", SENDER, manager.onMessageInserted)
  const recipient = makeCtx("sess-recipient", RECIPIENT, manager.onMessageInserted)
  const peer = makeCtx("sess-peer", PEER, manager.onMessageInserted)
  const chief = makeCtx("sess-chief", CHIEF, manager.onMessageInserted)

  const built: Fixture = {
    dir,
    db,
    stmts,
    sender,
    recipient,
    peer,
    chief,
    manager,
    latestDirectWakeSeq,
    latestTrackedWakeSeq,
    latestWakeSeq,
  }
  opened.push(built)
  return built
}

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.db.close()
    // raw-delete-allow: this test's own mkdtemp root under os.tmpdir()
    rmSync(item.dir, { recursive: true, force: true })
  }
})

describe("30472 bounded wait does not wake on settled requests or receipted open balls", () => {
  it("AC1 + AC2: a request settled by its sender before a fresh wait is armed stays labeled settled in attention and times out on wait", async () => {
    const { sender, recipient, manager, latestDirectWakeSeq, latestTrackedWakeSeq } = fixture()

    // Specimen 1 (9e933fa7): @dev/3 sends a request to @dev/11, then settles it as sender before @dev/11 waits.
    const sent = sendMessage(sender, RECIPIENT, "please check this", "request")
    expect(latestDirectWakeSeq(RECIPIENT, true, true)).toBe(sent.rowid)
    expect(latestTrackedWakeSeq(RECIPIENT)).toBe(sent.rowid)

    const closed = JSON.parse(
      (
        handleToolCall(
          sender,
          "tribe.pending",
          {
            owner: RECIPIENT,
            close: sent.id,
          },
          handlerOpts(),
        ) as { content: Array<{ text: string }> }
      ).content[0]!.text,
    ) as { closed: number }
    expect(closed.closed).toBe(1)

    // #29327: the unread row remains visible in actionable_unread with settled: true.
    const projection = readAttentionProjection(recipient, RECIPIENT, Date.now(), 0, handlerOpts()).attention
    expect(projection.actionable_unread).toMatchObject([{ id: sent.id, settled: true, settled_by: SENDER }])

    // AC2: neither the tracked query nor the fresh ($unacknowledged_only = 1) direct wake query may qualify it.
    expect(latestTrackedWakeSeq(RECIPIENT)).toBe(0)
    expect(latestDirectWakeSeq(RECIPIENT, false, true)).toBe(0)
    expect(latestDirectWakeSeq(RECIPIENT, true, true)).toBe(0)

    const result = await manager.wait(RECIPIENT, "conn-sender-settled", QUIET_MS, {
      consumesMailbox: true,
      wakeOnCorrelatedReply: true,
    })
    expect(result.status).toBe("timeout")
    expect(result.timed_out).toBe(true)
    expect(result.woken_by).toBeUndefined()
    expect(result.waited_ms).toBeGreaterThanOrEqual(QUIET_MS - 15)
  })

  it.each(["chief-manual-close", "other-owner-fanout-first", "gc-expired"] as const)(
    "AC2: a request settled by %s before a fresh wait is armed does not wake it",
    async (mode) => {
      const { stmts, sender, chief, manager, latestWakeSeq } = fixture()
      const sent = sendMessage(sender, RECIPIENT, "please take this", "request")
      expect(latestWakeSeq(RECIPIENT, true, true)).toBe(sent.rowid)

      if (mode === "chief-manual-close") {
        const rows = stmts.selectPendingSettlementsForRequest.all({
          $request_id: sent.id,
        }) as PendingSettlementRow[]
        expect(settlePendingRows(chief, rows, "manual-close", CHIEF)).toBe(1)
        stmts.closePendingRequestAll.run({ $request_id: sent.id })
      } else if (mode === "other-owner-fanout-first") {
        const rows = stmts.selectPendingSettlementsForRequest.all({
          $request_id: sent.id,
        }) as PendingSettlementRow[]
        expect(settlePendingRows(sender, rows, "answered", PEER)).toBe(1)
        stmts.closePendingRequestAll.run({ $request_id: sent.id })
      } else {
        const rows = stmts.selectPendingSettlementsForRequest.all({
          $request_id: sent.id,
        }) as PendingSettlementRow[]
        expect(settlePendingRows(sender, rows, "gc-expired", "gc-expired")).toBe(1)
        stmts.closePendingRequestAll.run({ $request_id: sent.id })
      }

      expect(latestWakeSeq(RECIPIENT, true, true)).toBe(0)

      const result = await manager.wait(RECIPIENT, `conn-${mode}`, QUIET_MS, {
        consumesMailbox: true,
        wakeOnCorrelatedReply: true,
      })
      expect(result.status).toBe("timeout")
      expect(result.timed_out).toBe(true)
      expect(result.woken_by).toBeUndefined()
    },
  )

  it("AC1 + AC3: an untaken read open ball wakes via getLatestTrackedInboxWaitMessage, and a TAKING status receipt quiets a fresh wait before due", async () => {
    const { chief, recipient, manager, latestDirectWakeSeq, latestTrackedWakeSeq } = fixture()

    // Specimen 3 & 4 (9b6ae19e / #28542): @chief sends a request; recipient reads via fetch (advances cursor) without TAKING or reply.
    const req = sendMessage(chief, RECIPIENT, "please investigate #30472", "request")
    handleToolCall(recipient, "tribe.fetch", {}, handlerOpts())

    // AC1 measurement: cursor gate suppresses getLatestInboxWaitMessage ($unacknowledged_only = 1),
    // while getLatestTrackedInboxWaitMessage still returns req.rowid because the ball is untaken (#22203).
    expect(latestDirectWakeSeq(RECIPIENT, true, true)).toBe(0)
    expect(latestTrackedWakeSeq(RECIPIENT)).toBe(req.rowid)

    const untakenWait = await manager.wait(RECIPIENT, "conn-untaken", QUIET_MS, {
      consumesMailbox: true,
      wakeOnCorrelatedReply: true,
    })
    expect(untakenWait.status).toBe("woken")
    expect(untakenWait.woken_by).toMatchObject({
      kind: "message",
      message_id: req.id,
      replay: true,
    })

    // AC3: recipient receipts the open ball with a TAKING status (--type status --ref <id>).
    sendMessage(
      recipient,
      CHIEF,
      `TAKING ${req.id} · owner ${RECIPIENT} · ETA 15:00 PDT · todo #30472`,
      "status",
      undefined,
      req.id,
    )

    // The ball stays open in pending_balls until settled or due, but no longer wakes a fresh wait.
    const projection = readAttentionProjection(recipient, RECIPIENT, Date.now(), 0, handlerOpts()).attention
    expect(projection.pending_balls.map((b) => b.request_id)).toContain(req.id)
    expect(projection.actionable_unread).toEqual([])
    expect(latestDirectWakeSeq(RECIPIENT, true, true)).toBe(0)
    expect(latestTrackedWakeSeq(RECIPIENT)).toBe(0)

    const receiptedWait = await manager.wait(RECIPIENT, "conn-receipted", QUIET_MS, {
      consumesMailbox: true,
      wakeOnCorrelatedReply: true,
    })
    expect(receiptedWait.status).toBe("timeout")
    expect(receiptedWait.timed_out).toBe(true)
    expect(receiptedWait.woken_by).toBeUndefined()
  })

  it("AC1 + AC4 (F05): a correlated-reply settlement wakes until a consuming fetch advances last_actionable_seq, then idles to timeout", async () => {
    const { recipient, chief, manager, latestDirectWakeSeq } = fixture()

    // Specimen 2 / F05 (e6bb0dbd): seat opens a request to @chief; @chief settles it with a response.
    const openedReq = sendMessage(recipient, CHIEF, "requesting review", "request")
    const settlementReply = sendMessage(
      chief,
      RECIPIENT,
      "approved",
      "response",
      undefined,
      undefined,
      "direct",
      {},
      { reply: openedReq.id },
    )

    expect(latestDirectWakeSeq(RECIPIENT, true, true)).toBe(settlementReply.rowid)

    // AC4: inbox-wait is non-retiring (#28542); waking returns the settling response without advancing last_actionable_seq.
    const firstWake = await manager.wait(RECIPIENT, "conn-f05-1", QUIET_MS, {
      consumesMailbox: true,
      wakeOnCorrelatedReply: true,
    })
    expect(firstWake.status).toBe("woken")
    expect(firstWake.woken_by).toMatchObject({
      kind: "message",
      message_id: settlementReply.id,
      settles_request_id: openedReq.id,
      replay: false,
    })

    // Re-arming without a consuming fetch wakes again on the same unconsumed settlement row (F05 reproduction).
    const secondWake = await manager.wait(RECIPIENT, "conn-f05-2", QUIET_MS, {
      consumesMailbox: true,
      wakeOnCorrelatedReply: true,
    })
    expect(secondWake.status).toBe("woken")
    expect(secondWake.woken_by).toMatchObject({
      kind: "message",
      message_id: settlementReply.id,
      settles_request_id: openedReq.id,
      replay: false,
    })

    // Once the seat runs the required follow-up consuming fetch (#28542), last_actionable_seq advances and a fresh wait idles.
    handleToolCall(recipient, "tribe.fetch", {}, handlerOpts())
    expect(latestDirectWakeSeq(RECIPIENT, true, true)).toBe(0)

    const quietWait = await manager.wait(RECIPIENT, "conn-f05-after-fetch", QUIET_MS, {
      consumesMailbox: true,
      wakeOnCorrelatedReply: true,
    })
    expect(quietWait.status).toBe("timeout")
    expect(quietWait.timed_out).toBe(true)
    expect(quietWait.woken_by).toBeUndefined()
  })

  it("31132: a correlated-reply settlement answered by the requester with a later direct CLI message does not re-wake a fresh wait", async () => {
    const { recipient, chief, manager, latestDirectWakeSeq } = fixture()

    // Specimen 92c2d6d8 (tent-await-live8.log -> tent-await-live9.log) and b02fab12:
    // requester opens a request; @chief settles it with a response (request = null);
    // requester answers @chief directly via CLI send without running tribe inbox --consume.
    const openedReq = sendMessage(recipient, CHIEF, "need ruling on 31101", "request")
    const settlementReply = sendMessage(
      chief,
      RECIPIENT,
      "approved — ship it",
      "response",
      undefined,
      undefined,
      "direct",
      {},
      { reply: openedReq.id },
    )
    expect(latestDirectWakeSeq(RECIPIENT, true, true)).toBe(settlementReply.rowid)

    // Requester sends a later direct message back to @chief (without --reply, since settlementReply opened no ball).
    sendMessage(recipient, CHIEF, "shipped on task/31101", "response")

    expect(latestDirectWakeSeq(RECIPIENT, true, true)).toBe(0)

    const waitAfterAnswer = await manager.wait(RECIPIENT, "conn-31132-after-cli-answer", QUIET_MS, {
      consumesMailbox: true,
      wakeOnCorrelatedReply: true,
    })
    expect(waitAfterAnswer.status).toBe("timeout")
    expect(waitAfterAnswer.timed_out).toBe(true)
    expect(waitAfterAnswer.woken_by).toBeUndefined()
  })
})
