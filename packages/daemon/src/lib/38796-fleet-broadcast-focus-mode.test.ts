/**
 * @failure A verified persona fleet broadcast (to="*", type=notify, topic=null, delivery=push)
 *          is dropped by focus-mode push and pull filters, omitted from attention.actionable_unread,
 *          ignored by inbox-wait, or lost across a daemon restart when sessions.last_inbox_pull_seq
 *          resets — or leaks historical broadcasts to a newly joined seat, wakes on topic/service
 *          broadcasts, or echoes back to its sender.
 * @level   l2
 * @bead    #38796 (@cto 7767f5fe)
 */

import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type MessageInsertedInfo, type TribeContext } from "./context.ts"
import { shouldDeliver } from "./compose/with-broadcast.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, readAttentionProjection, type HandlerOpts } from "./handlers.ts"
import { createInboxWaitManager, type InboxStatus } from "./inbox-wait.ts"
import { sendMessage } from "./messaging.ts"
import { registerSession } from "./session.ts"

type SyncToolResult = Exclude<ReturnType<typeof handleToolCall>, Promise<unknown>>

function parse(result: ReturnType<typeof handleToolCall>): Record<string, unknown> {
  return JSON.parse((result as SyncToolResult).content[0]!.text) as Record<string, unknown>
}

describe("#38796 — verified persona fleet broadcasts reach focus and pull seats via attention", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-38796-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeSeat(
    id: string,
    name: string,
    opts: {
      verified?: boolean
      delivery?: "push" | "pull"
      filterMode?: "focus" | "normal" | "ambient"
      onMessageInserted?: (info: MessageInsertedInfo) => void
    } = {},
  ): TribeContext {
    const ctx = createTribeContext({
      db,
      stmts,
      sessionId: id,
      initialName: name,
      sessionRole: "member",
      domains: ["silvercode"],
      claudeSessionId: null,
      claudeSessionName: null,
      onMessageInserted: opts.onMessageInserted,
    })
    registerSession(ctx, name, () => true, undefined, process.pid, opts.delivery ?? "push", tmpDir)
    if (opts.verified !== false) {
      db.prepare("UPDATE sessions SET identity_sid = ? WHERE id = ?").run(`sid-${id}`, id)
    }
    if (opts.filterMode) {
      stmts.setSessionFilter.run({
        $id: id,
        $mode: opts.filterMode,
        $until: null,
        $mute: null,
        $now: Date.now(),
      })
    }
    return ctx
  }

  function makeOpts(activeIds: readonly string[], inboxWait?: ReturnType<typeof createInboxWaitManager>): HandlerOpts {
    const active = new Set(activeIds)
    return {
      getActiveSessionIds: () => new Set(active),
      getActiveSessionInfo: () =>
        [...active].map((id) => {
          const row = db.prepare("SELECT name, pid, cwd, delivery FROM sessions WHERE id = ?").get(id) as {
            name: string
            pid: number
            cwd: string
            delivery: "push" | "pull"
          } | null
          const pid = row?.pid ?? process.pid
          const isPush = (row?.delivery ?? "push") === "push"
          return {
            id,
            name: row?.name ?? id,
            pid,
            cwd: row?.cwd ?? tmpDir,
            role: "member",
            claudeSessionId: null,
            registeredAt: Date.now(),
            launchId: null,
            launchParentPid: null,
            transportDelivery: row?.delivery ?? "push",
            transportPids: [pid],
            pushTransportPids: isPush ? [pid] : [],
          }
        }),
      hasActiveTransport: (id) => active.has(id),
      cleanup: () => {},
      userRenamed: false,
      isReconnectGraceProtected: () => false,
      setUserRenamed: () => {},
      declareTransportDelivery: (delivery) => ({
        delivery: delivery ?? "push",
        transportDelivery: delivery ?? "push",
      }),
      inboxWait,
    }
  }

  function makeInboxWait(ctx: TribeContext) {
    const readStatus = (session: string): InboxStatus => {
      const projected = readAttentionProjection(ctx, session)
      return {
        session,
        unread_count: projected.actionableCount,
        oldest_unread_age_min: 0,
        oldest_unread_ts: 0,
      }
    }
    const readAttention = (session: string) => readAttentionProjection(ctx, session).attention
    const readSeq = (session: string, wakeOnCorrelatedReply: boolean, unackedOnly: boolean): number => {
      const row = stmts.getLatestInboxWaitMessage.get({
        $name: session,
        $include_correlated_replies: wakeOnCorrelatedReply ? 1 : 0,
        $unacknowledged_only: unackedOnly ? 1 : 0,
      }) as { rowid: number } | null
      return row?.rowid ?? 0
    }
    return createInboxWaitManager(
      readStatus,
      readAttention,
      (session, wake) => readSeq(session, wake, false),
      (session, wake) => readSeq(session, wake, true),
    )
  }

  it("delivers a verified persona notify broadcast to both focus/push and normal/pull seats via attention without opening a ball", async () => {
    const inserted: MessageInsertedInfo[] = []
    let inboxWait!: ReturnType<typeof createInboxWaitManager>
    const onInsert = (info: MessageInsertedInfo): void => {
      inserted.push(info)
      inboxWait?.onMessageInserted(info)
    }

    const coordinator = makeSeat("s-coord", "@chief", {
      filterMode: "focus",
      delivery: "push",
      onMessageInserted: onInsert,
    })
    const focusSeat = makeSeat("s-focus", "@dev/12", {
      filterMode: "focus",
      delivery: "push",
      onMessageInserted: onInsert,
    })
    const pullSeat = makeSeat("s-pull", "@dev/1", {
      filterMode: "normal",
      delivery: "pull",
      onMessageInserted: onInsert,
    })
    inboxWait = makeInboxWait(coordinator)
    const opts = makeOpts(["s-coord", "s-focus", "s-pull"], inboxWait)

    // Seed cursors by doing an initial fetch for both existing seats.
    parse(handleToolCall(focusSeat, "tribe.fetch", {}, opts))
    parse(handleToolCall(pullSeat, "tribe.fetch", {}, opts))

    // Start a pull inbox-wait before the broadcast arrives.
    const waitPromise = inboxWait.wait("@dev/1", "conn-pull", 500, { consumesMailbox: true })

    const sendRes = parse(
      handleToolCall(
        coordinator,
        "tribe.send",
        {
          to: "*",
          type: "notify",
          message: "ALL-CLEAR: km writes open again.",
          summary: "ALL-CLEAR: km writes open again",
        },
        opts,
      ),
    )

    expect(sendRes.sent).toBe(true)
    expect(sendRes.request_id).toBeUndefined()
    // Truthful receipt: live recipients exist, so delivery state is online, not hardcoded offline.
    expect(sendRes.delivery).toMatchObject({ state: "online", recipient: "*" })

    // No ball opened in pending_request.
    const pendingRows = db.prepare("SELECT * FROM pending_request WHERE message_id = ?").all(sendRes.id as string)
    expect(pendingRows).toEqual([])

    // Focus/push seat: push predicate admits the broadcast.
    const broadcastEvent = inserted.find((ev) => ev.id === sendRes.id)
    expect(broadcastEvent).toBeDefined()
    expect(
      shouldDeliver(
        {
          kind: broadcastEvent!.kind,
          type: broadcastEvent!.type,
          replyHint: "no",
          topic: broadcastEvent!.topic,
          settlesOwnRequest: false,
          attentionRequired: broadcastEvent!.attentionRequired,
        },
        { filter_mode: "focus", filter_mute: null, filter_until: null },
      ),
    ).toBe(true)

    // Pull seat: inbox-wait wakes immediately on the broadcast.
    const waitOutcome = await waitPromise
    expect(waitOutcome.timed_out).toBe(false)
    expect(waitOutcome.unread_count).toBeGreaterThanOrEqual(1)
    expect(waitOutcome.attention.actionable_unread.map((r) => (r as { id: string }).id)).toContain(sendRes.id)

    // Both focus/push and normal/pull see it in attention.actionable_unread (not duplicated in events).
    const focusFetch = parse(handleToolCall(focusSeat, "tribe.fetch", {}, opts)) as {
      attention: { actionable_unread: Array<{ id: string }>; pending_balls: unknown[] }
      events: Array<{ id: string }>
    }
    expect(focusFetch.attention.actionable_unread.map((r) => r.id)).toContain(sendRes.id)
    expect(focusFetch.attention.pending_balls).toEqual([])
    expect(focusFetch.events.map((r) => r.id)).not.toContain(sendRes.id)

    const pullFetch = parse(handleToolCall(pullSeat, "tribe.fetch", {}, opts)) as {
      attention: { actionable_unread: Array<{ id: string }>; pending_balls: unknown[] }
      events: Array<{ id: string }>
    }
    expect(pullFetch.attention.actionable_unread.map((r) => r.id)).toContain(sendRes.id)
    expect(pullFetch.attention.pending_balls).toEqual([])
    expect(pullFetch.events.map((r) => r.id)).not.toContain(sendRes.id)

    // Sender never sees its own broadcast in attention or events.
    const senderFetch = parse(handleToolCall(coordinator, "tribe.fetch", {}, opts)) as {
      attention: { actionable_unread: Array<{ id: string }> }
      events: Array<{ id: string }>
    }
    expect(senderFetch.attention.actionable_unread.map((r) => r.id)).not.toContain(sendRes.id)
    expect(senderFetch.events.map((r) => r.id)).not.toContain(sendRes.id)

    // Second fetch after acknowledgement retires the broadcast cleanly for both seats.
    const focusFetch2 = parse(handleToolCall(focusSeat, "tribe.fetch", {}, opts)) as {
      attention: { actionable_unread: Array<{ id: string }> }
    }
    expect(focusFetch2.attention.actionable_unread).toEqual([])

    inboxWait.shutdown()
  })

  it("survives a daemon restart that resets ephemeral sessions.last_inbox_pull_seq past the broadcast", () => {
    const coordinator = makeSeat("s-coord", "@chief", { filterMode: "focus", delivery: "push" })
    const seatBeforeRestart = makeSeat("s-dev15-old", "@dev/15", { filterMode: "normal", delivery: "push" })
    const optsBefore = makeOpts(["s-coord", "s-dev15-old"])

    // Existing seat had an earlier fetch before the broadcast.
    parse(handleToolCall(seatBeforeRestart, "tribe.fetch", {}, optsBefore))

    const sendRes = parse(
      handleToolCall(
        coordinator,
        "tribe.send",
        {
          to: "*",
          type: "notify",
          message: "ALL-CLEAR: writes resumed.",
          summary: "ALL-CLEAR: writes resumed",
        },
        optsBefore,
      ),
    )

    // Simulate daemon restart: old session row is gone, a new session re-joins and resets
    // last_inbox_pull_seq and last_delivered_seq to the current tail (past the broadcast).
    db.prepare("DELETE FROM sessions WHERE id = ?").run("s-dev15-old")
    const seatAfterRestart = makeSeat("s-dev15-new", "@dev/15", { filterMode: "normal", delivery: "push" })
    const tail = (stmts.getMessageTailSeq.get() as { seq: number }).seq
    stmts.resetSessionDeliveryOffsets.run({ $id: "s-dev15-new", $seq: tail, $ts: Date.now() })
    const optsAfter = makeOpts(["s-coord", "s-dev15-new"])

    const fetched = parse(handleToolCall(seatAfterRestart, "tribe.fetch", {}, optsAfter)) as {
      attention: { actionable_unread: Array<{ id: string }> }
    }
    expect(fetched.attention.actionable_unread.map((r) => r.id)).toContain(sendRes.id)
  })

  it("seeds mailbox_cursors on first join so a brand-new seat does not inherit historical broadcasts", () => {
    const coordinator = makeSeat("s-coord", "@chief", { filterMode: "focus", delivery: "push" })
    const opts1 = makeOpts(["s-coord"])

    // Historical broadcast sent BEFORE @dev/new ever existed.
    const oldBroadcast = parse(
      handleToolCall(
        coordinator,
        "tribe.send",
        {
          to: "*",
          type: "notify",
          message: "Old broadcast before new seat existed.",
          summary: "Old broadcast before new seat",
        },
        opts1,
      ),
    )

    // Brand-new seat joins via registerSession + handleJoin.
    const newSeat = createTribeContext({
      db,
      stmts,
      sessionId: "s-new",
      initialName: "unknown-fresh",
      sessionRole: "member",
      domains: ["silvercode"],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    const opts2 = makeOpts(["s-coord", "s-new"])
    const joinRes = parse(handleToolCall(newSeat, "tribe.join", { name: "@dev/new", delivery: "pull" }, opts2))
    expect(joinRes.joined).toBe(true)
    expect(joinRes.recovered_actionables).toBeUndefined()

    // New seat does NOT inherit oldBroadcast.
    const firstFetch = parse(handleToolCall(newSeat, "tribe.fetch", {}, opts2)) as {
      attention: { actionable_unread: Array<{ id: string }> }
    }
    expect(firstFetch.attention.actionable_unread.map((r) => r.id)).not.toContain(oldBroadcast.id)

    // A NEW broadcast sent AFTER @dev/new joined IS delivered to @dev/new.
    const newBroadcast = parse(
      handleToolCall(
        coordinator,
        "tribe.send",
        {
          to: "*",
          type: "notify",
          message: "New broadcast after new seat joined.",
          summary: "New broadcast after new seat",
        },
        opts2,
      ),
    )
    const secondFetch = parse(handleToolCall(newSeat, "tribe.fetch", {}, opts2)) as {
      attention: { actionable_unread: Array<{ id: string }> }
    }
    expect(secondFetch.attention.actionable_unread.map((r) => r.id)).toContain(newBroadcast.id)
  })

  it("keeps topic-bearing daemon broadcasts, non-persona service broadcasts, unverified broadcasts, and direct ref-bound statuses filtered", () => {
    const focusSeat = makeSeat("s-focus", "@dev/12", { filterMode: "focus", delivery: "push" })
    const serviceSender = makeSeat("s-landing", "landing-batch", { verified: true, delivery: "push" })
    const unverifiedPersona = makeSeat("s-spoof", "@dev/spoof", { verified: false, delivery: "push" })
    const daemonCtx = createTribeContext({
      db,
      stmts,
      sessionId: "daemon-self",
      initialName: "daemon",
      sessionRole: "daemon",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    const opts = makeOpts(["s-focus", "s-landing", "s-spoof"])

    parse(handleToolCall(focusSeat, "tribe.fetch", {}, opts))

    // 1. Topic-bearing daemon broadcast (health:cpu:warning)
    const daemonRow = sendMessage(
      daemonCtx,
      "*",
      "CPU warning",
      "health:cpu:warning",
      undefined,
      undefined,
      "broadcast",
      {
        delivery: "push",
        topic: "health:cpu:warning",
      },
    )
    expect(daemonRow.attentionRequired).toBe(false)

    // 2. Non-persona verified service broadcast (landing-batch)
    const serviceRes = parse(
      handleToolCall(
        serviceSender,
        "tribe.send",
        {
          to: "*",
          type: "notify",
          message: "shared-main landing changes the habitat plan",
          summary: "shared-main landing changes habitat plan",
        },
        opts,
      ),
    )

    // 3. Unverified persona broadcast (claimed authority)
    const unverifiedRes = parse(
      handleToolCall(
        unverifiedPersona,
        "tribe.send",
        {
          to: "*",
          type: "notify",
          message: "Unverified persona broadcast should stay ambient.",
          summary: "Unverified persona broadcast",
        },
        opts,
      ),
    )

    // None of the three enter focus seat's attention or events.
    const focusFetch = parse(handleToolCall(focusSeat, "tribe.fetch", {}, opts)) as {
      attention: { actionable_unread: Array<{ id: string }> }
      events: Array<{ id: string }>
    }
    const seenIds = [...focusFetch.attention.actionable_unread.map((r) => r.id), ...focusFetch.events.map((r) => r.id)]
    expect(seenIds).not.toContain(daemonRow.id)
    expect(seenIds).not.toContain(serviceRes.id)
    expect(seenIds).not.toContain(unverifiedRes.id)

    // Direct ref-bound status with attentionRequired=true must STILL stay quiet in focus push (#29535).
    expect(
      shouldDeliver(
        {
          kind: "direct",
          type: "status",
          replyHint: "no",
          topic: null,
          settlesOwnRequest: false,
          attentionRequired: true,
        },
        { filter_mode: "focus", filter_mute: null, filter_until: null },
      ),
    ).toBe(false)
  })
})
