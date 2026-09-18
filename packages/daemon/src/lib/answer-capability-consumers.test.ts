/**
 * 24664 — a connected seat counts as able to answer only when something is
 * consuming its mailbox: push delivery with a registered client, or a live
 * inbox.wait by the mailbox owner. A pull seat between waits reads
 * `not-observed` / `connected-no-consumer` with its last read age, so a sender
 * can tell "reads at its next tick" from "unreachable".
 *
 * members, pending and the tracked-send delivery report all spread one
 * projection, so one fixture read those three ways must agree for every case.
 * The flip changes what is REPORTED, never where mail goes or whether a send
 * is admitted: refusal stays keyed on mailbox readability and on a connected,
 * PID-live transport.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import tribeHabModule from "../../../../hab.projects.ts"
import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { prefixFallbackDeliveryResolver } from "./delivery-resolution.ts"
import { handleToolCall, type ActiveSessionInfo, type HandlerOpts } from "./handlers.ts"
import { createInboxWaitManager } from "./inbox-wait.ts"
import { registerSession } from "./session.ts"

const PROJECT_ID = "answer-capability-consumers"
const NOW = 1_800_000_000_000
const MINUTE = 60_000

type Seat = {
  name: string
  delivery: "push" | "pull"
  connected: boolean
  readableMailbox: boolean
  ownerWaiting: boolean
  lastReadAgeMs: number | null
  expected: {
    capability: "observed" | "not-observed"
    reason: string
    state: "online" | "offline"
  }
}

const SEATS: readonly Seat[] = [
  {
    name: "@pull/idle",
    delivery: "pull",
    connected: true,
    readableMailbox: true,
    ownerWaiting: false,
    lastReadAgeMs: 4 * MINUTE,
    expected: { capability: "not-observed", reason: "connected-no-consumer", state: "offline" },
  },
  {
    name: "@pull/waiting",
    delivery: "pull",
    connected: true,
    readableMailbox: true,
    ownerWaiting: true,
    lastReadAgeMs: 30_000,
    expected: { capability: "observed", reason: "connected-pid-live-transport", state: "online" },
  },
  {
    name: "@push/joined",
    delivery: "push",
    connected: true,
    readableMailbox: true,
    ownerWaiting: false,
    lastReadAgeMs: null,
    expected: { capability: "observed", reason: "connected-pid-live-transport", state: "online" },
  },
  {
    name: "@pull/deaf",
    delivery: "pull",
    connected: true,
    readableMailbox: false,
    ownerWaiting: true,
    lastReadAgeMs: MINUTE,
    expected: { capability: "not-observed", reason: "mailbox-read-unavailable", state: "offline" },
  },
  {
    name: "@pull/gone",
    delivery: "pull",
    connected: false,
    readableMailbox: true,
    ownerWaiting: false,
    lastReadAgeMs: 180 * MINUTE,
    expected: { capability: "not-observed", reason: "owner-unknown-no-transport", state: "offline" },
  },
]

function toolJson(result: ReturnType<typeof handleToolCall>): Record<string, unknown> {
  if (result instanceof Promise) throw new Error("answer-capability test expected a synchronous tool result")
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>
}

describe("answer capability requires a mailbox consumer (24664)", () => {
  let dir: string
  let db: ReturnType<typeof openDatabase>
  let stmts: TribeStatements
  let sender: TribeContext
  const active: ActiveSessionInfo[] = []
  const manager = createInboxWaitManager(
    (session) => ({ session, unread_count: 0, oldest_unread_age_min: 0, oldest_unread_ts: 0 }),
    () => ({
      actionable_unread: [],
      pending_balls: [],
      pending_balls_summary: { total: 0, oldest_age_ms: 0, truncated: false },
    }),
  )

  function addSeat(seat: Omit<Seat, "expected">, index: number): TribeContext {
    const ctx = createTribeContext({
      db,
      stmts,
      sessionId: `sess-${index}`,
      sessionRole: "member",
      initialName: seat.name,
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    registerSession(
      ctx,
      PROJECT_ID,
      () => false,
      null,
      process.pid,
      seat.delivery,
      "/repo",
      null,
      "codex",
      null,
      null,
      seat.readableMailbox ? index.toString(16).padStart(2, "0").repeat(32) : null,
    )
    if (seat.connected) {
      active.push({
        id: ctx.sessionId,
        name: seat.name,
        pid: process.pid,
        cwd: "/repo",
        role: "member",
        claudeSessionId: null,
        registeredAt: NOW,
        launchId: null,
        launchParentPid: null,
        transportPids: [process.pid],
      })
    }
    if (seat.lastReadAgeMs !== null) {
      stmts.touchMailboxAttentionRead.run({ $recipient: seat.name, $now: NOW - seat.lastReadAgeMs })
    }
    if (seat.ownerWaiting) void manager.wait(seat.name, `conn-${index}`, 60 * MINUTE, { consumesMailbox: true })
    return ctx
  }

  function opts(overrides: Partial<HandlerOpts> = {}): HandlerOpts {
    return {
      cleanup: () => undefined,
      userRenamed: false,
      setUserRenamed: () => undefined,
      getActiveSessionIds: () => new Set(active.map((session) => session.id)),
      hasActiveTransport: (sessionId) => active.some((session) => session.id === sessionId),
      getActiveSessionInfo: () => active,
      inboxWait: manager,
      ...overrides,
    }
  }

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    dir = mkdtempSync(join(tmpdir(), "tribe-answer-capability-"))
    db = openDatabase(join(dir, "tribe.db"))
    stmts = createStatements(db)
    active.length = 0
    sender = addSeat(
      {
        name: "@sender",
        delivery: "pull",
        connected: true,
        readableMailbox: true,
        ownerWaiting: false,
        lastReadAgeMs: null,
      },
      1,
    )
  })

  afterEach(() => {
    manager.shutdown()
    vi.restoreAllMocks()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("members, pending and a tracked send agree on capability, reason and read age for each case", () => {
    SEATS.forEach((seat, index) => addSeat(seat, index + 2))

    const deliveries = new Map<string, unknown>()
    for (const seat of SEATS) {
      const sent = toolJson(
        handleToolCall(
          sender,
          "tribe.send",
          { to: seat.name, message: `answer ${seat.name}`, type: "request", request: `req-${seat.name}` },
          opts(),
        ),
      )
      if (seat.readableMailbox) {
        expect(sent, seat.name).toMatchObject({ sent: true, request_id: `req-${seat.name}` })
        deliveries.set(seat.name, sent.delivery)
        continue
      }
      expect(String(sent.error), seat.name).toContain(`tribe.send: failed to deliver to ${seat.name} - not online`)
      expect(String(sent.detail), seat.name).toContain("mailbox_read_capability.state is unavailable")
      stmts.openPendingRequest.run({
        $request_id: `req-${seat.name}`,
        $recipient: seat.name,
        $sender: "@sender",
        $opened_at: NOW,
        $expires_at: null,
        $message_id: `msg-${seat.name}`,
        $fanout: "first",
      })
      const notified = toolJson(
        handleToolCall(sender, "tribe.send", { to: seat.name, message: "fyi", type: "notify" }, opts()),
      )
      expect(notified, seat.name).toMatchObject({ sent: true })
      deliveries.set(seat.name, notified.delivery)
    }

    const pending = toolJson(handleToolCall(sender, "tribe.pending", { all: true }, opts())) as {
      pending: Array<Record<string, unknown>>
    }
    const pendingByOwner = new Map(pending.pending.map((row) => [row.recipient, row]))
    const members = toolJson(handleToolCall(sender, "tribe.members", { all: true }, opts())) as {
      sessions: Array<Record<string, unknown>>
    }
    const membersByName = new Map(members.sessions.map((row) => [row.name, row]))

    for (const seat of SEATS) {
      const { capability, reason, state } = seat.expected
      expect(membersByName.get(seat.name), `members ${seat.name}`).toMatchObject({
        answer_capability: capability,
        answer_reason: reason,
        last_mailbox_read_age_ms: seat.lastReadAgeMs,
      })
      expect(pendingByOwner.get(seat.name), `pending ${seat.name}`).toMatchObject({
        owner_answer_capability: capability,
        owner_transport_reason: reason,
        owner_last_mailbox_read_age_ms: seat.lastReadAgeMs,
      })
      expect(deliveries.get(seat.name), `delivery ${seat.name}`).toEqual({
        state,
        recipient: seat.name,
        reason,
        last_mailbox_read_age_ms: seat.lastReadAgeMs,
      })
    }
  })

  it("keeps routing and admission on the live transport: a pull seat between waits keeps its mail", () => {
    const resolveDelivery = prefixFallbackDeliveryResolver(tribeHabModule.services.wire.env.TRIBE_DELIVERY_FALLBACKS)
    const pullSeat = { delivery: "pull", connected: true, readableMailbox: true, ownerWaiting: false } as const
    addSeat({ ...pullSeat, name: "@ci", lastReadAgeMs: 2 * MINUTE }, 2)
    addSeat({ ...pullSeat, name: "@chief", lastReadAgeMs: 3 * MINUTE }, 3)

    // The hab table bounces @ci to @chief when @ci is unreachable. A connected
    // @ci that reads at its next tick is reachable: the tracked request stays
    // with @ci, the sender learns the reason and age, and nothing is refused.
    const sent = toolJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: "@ci", message: "run the gate", type: "request", request: "req-ci" },
        opts({ resolveDelivery }),
      ),
    )
    expect(sent).toMatchObject({ sent: true, request_id: "req-ci" })
    expect(sent.delivery).toEqual({
      state: "offline",
      recipient: "@ci",
      reason: "connected-no-consumer",
      last_mailbox_read_age_ms: 2 * MINUTE,
    })
    expect(db.prepare("SELECT recipient FROM pending_request WHERE request_id = 'req-ci'").get()).toEqual({
      recipient: "@ci",
    })
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE type = 'dead-letter'").get()).toEqual({ count: 0 })

    // A tracked broadcast still finds its owners among connected pull seats.
    const broadcast = toolJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: "*", message: "who can take this", type: "request", request: "req-broadcast" },
        opts({ resolveDelivery }),
      ),
    )
    expect(broadcast).toMatchObject({ sent: true, delivery: { state: "online", recipient: "*" } })
    expect(
      db.prepare("SELECT recipient FROM pending_request WHERE request_id = 'req-broadcast' ORDER BY recipient").all(),
    ).toEqual([{ recipient: "@chief" }, { recipient: "@ci" }])
  })
})
