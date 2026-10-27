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
import { parseDeliveryFallbackPolicy } from "./delivery-resolution.ts"
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
    expected: { capability: "not-observed", reason: "connected-no-consumer", state: "online" },
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
    registerSession(ctx, PROJECT_ID, () => false, null, process.pid, seat.delivery, "/repo", null, "codex", null, null)
    // A readable mailbox is a session its verified identity token keyed: the sid on its row (25074 3d-3).
    if (seat.readableMailbox) {
      db.prepare("UPDATE sessions SET identity_sid = ?, identity_gen = 1 WHERE id = ?").run(
        `sid-${index}`,
        ctx.sessionId,
      )
    }
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
        pushTransportPids: seat.delivery === "push" ? [process.pid] : [],
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

  it("members reports read facts while pending and tracked send retain admission and delivery policy", () => {
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
        transport_state: seat.connected ? "connected" : "disconnected",
        mailbox_read_capability: expect.objectContaining({ state: seat.readableMailbox ? "available" : "unavailable" }),
        mailbox_progress:
          seat.lastReadAgeMs === null
            ? {
                state: "unobserved",
                scope: "mailbox-name",
                observed_at_ms: NOW,
                last_attention_read_at_ms: null,
                last_attention_read_age_ms: null,
                reason: "no-canonical-read-receipt",
              }
            : {
                state: "observed",
                scope: "mailbox-name",
                observed_at_ms: NOW,
                last_attention_read_at_ms: NOW - seat.lastReadAgeMs,
                last_attention_read_age_ms: seat.lastReadAgeMs,
              },
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
    const resolveDelivery = parseDeliveryFallbackPolicy(
      tribeHabModule.habitants.wire.env.TRIBE_DELIVERY_FALLBACKS,
    )?.resolveDelivery
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
      state: "online",
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

  /**
   * 24526, 26522 (@cto 8a135bdb + 00:53 PDT correction): sender guidance must
   * describe what the daemon will actually do with the row. A connected push seat in
   * normal/ambient mode gets direct rows inline (`shouldDeliver === true`) and needs
   * no note; a connected push seat in `focus` mode skips the push wakeup while the
   * row stays in their inbox until they fetch; a connected seat with no live push
   * client is not woken and reads the row on its next drain (even in focus mode).
   */
  it("warns on untracked named sends when the recipient has no live transport, filters to focus, or has no live push client (24526, 26522)", () => {
    SEATS.forEach((seat, index) => addSeat(seat, index + 2))
    const send = (to: string, type = "notify", request?: true, ref?: string, fromCtx: TribeContext = sender) =>
      toolJson(
        handleToolCall(
          fromCtx,
          "tribe.send",
          { to, message: "please inspect", type, summary: "inspection", request, ...(ref ? { ref } : {}) },
          opts(),
        ),
      )

    // 1. Push recipient in normal mode: handed inline by shouldDeliver -> no note.
    expect(send("@push/joined").warning).toBeUndefined()

    // 2. Push recipient in focus mode: push skips wakeup, row stays fetchable in inbox -> focus note.
    db.prepare("UPDATE sessions SET filter_mode = 'focus' WHERE name = '@push/joined'").run()
    const focusNote = send("@push/joined")
    expect(String(focusNote.warning)).toContain(
      "delivery note — @push/joined is in focus mode: no wakeup for this notify; it stays in their inbox until they fetch",
    )
    expect(String(focusNote.warning)).toContain("--ref <open-request-id>")
    expect(String(send("@push/joined", "status").warning)).toContain(
      "@push/joined is in focus mode: no wakeup for this status; it stays in their inbox until they fetch",
    )
    // Prove the focus-mode wording's claim against getInboxRows in focus mode (@cto 8a135bdb correction, B1).
    const focusDrainedIds = (
      stmts.getInboxRows.all({
        $since: 0,
        $name: "@push/joined",
        $limit: 50,
        $filter_mode: "focus",
        $filter_mute: null,
        $filter_until: null,
        $now: NOW,
      }) as Array<{ id: string }>
    ).map((r) => r.id)
    expect(focusDrainedIds).toContain(focusNote.id)
    db.prepare("UPDATE sessions SET filter_mode = 'normal' WHERE name = '@push/joined'").run()

    // 3. Connected pull seats (no live push-client consumer): wakes nothing, returned by next drain
    // (checked before filter_mode so a pull seat in focus mode still gets the no-live-push-client note).
    db.prepare("UPDATE sessions SET filter_mode = 'focus' WHERE name = '@pull/idle'").run()
    const idleNote = send("@pull/idle")
    expect(String(idleNote.warning)).toContain(
      "delivery note — @pull/idle has no live push client: this notify wakes nothing and counts as no attention; it is returned by @pull/idle's next drain",
    )
    expect(String(idleNote.warning)).toContain("--ref <open-request-id>")
    db.prepare("UPDATE sessions SET filter_mode = 'normal' WHERE name = '@pull/idle'").run()
    const waitingNote = send("@pull/waiting")
    expect(String(waitingNote.warning)).toContain(
      "@pull/waiting has no live push client: this notify wakes nothing and counts as no attention; it is returned by @pull/waiting's next drain",
    )
    // Prove the wording's claim against getInboxRows in both normal and focus modes (@cto 8a135bdb binding 4 + B1).
    for (const mode of ["normal", "focus"] as const) {
      const drainedIds = (
        stmts.getInboxRows.all({
          $since: 0,
          $name: "@pull/idle",
          $limit: 50,
          $filter_mode: mode,
          $filter_mute: null,
          $filter_until: null,
          $now: NOW,
        }) as Array<{ id: string }>
      ).map((r) => r.id)
      expect(drainedIds).toContain(idleNote.id)
    }

    // 4. Open-ball-ref rows (TAKING status+ref or notify+ref on an open ball): attention_required=1 -> no note.
    const openReq = toolJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: "@pull/idle", message: "take this", type: "request", request: "ball-26522", summary: "take this" },
        opts(),
      ),
    )
    expect(openReq.request_id).toBe("ball-26522")
    const idleCtx = createTribeContext({
      db,
      stmts,
      sessionId: "sess-2",
      sessionRole: "member",
      initialName: "@pull/idle",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    expect(send("@sender", "status", undefined, "ball-26522", idleCtx).warning).toBeUndefined()
    expect(send("@pull/idle", "notify", undefined, "ball-26522", sender).warning).toBeUndefined()

    // 5. Silent cases (@cto 8a135bdb binding 6): watchers, anonymous pending-*, broadcasts, self-notify.
    const watcherCtx = addSeat(
      {
        name: "wait-watch",
        delivery: "pull",
        connected: true,
        readableMailbox: false,
        ownerWaiting: false,
        lastReadAgeMs: null,
      },
      20,
    )
    const anonCtx = addSeat(
      {
        name: "pending-anon",
        delivery: "pull",
        connected: true,
        readableMailbox: false,
        ownerWaiting: false,
        lastReadAgeMs: null,
      },
      21,
    )
    expect(send("@pull/idle", "notify", undefined, undefined, watcherCtx).warning).toBeUndefined()
    expect(send("@pull/idle", "notify", undefined, undefined, anonCtx).warning).toBeUndefined()
    expect(send("*", "notify").warning).toBeUndefined()
    expect(send("@sender", "notify").warning).toBeUndefined()

    // 5b. S3/S4: 2 same-name active sessions for one seat (a waiting pull sibling at active[0]
    // alongside a live push-client sibling at active[1]) union consumers across live siblings and
    // evaluate filter_mode per live push-client session id (defaulting a row-less push sibling to
    // 'normal' just as with-broadcast.ts:96 shouldDeliver does, never borrowing another sibling's row).
    addSeat(
      {
        name: "@multi/seat",
        delivery: "pull",
        connected: true,
        readableMailbox: true,
        ownerWaiting: true,
        lastReadAgeMs: null,
      },
      30,
    )
    addSeat(
      {
        name: "@multi/seat",
        delivery: "push",
        connected: true,
        readableMailbox: true,
        ownerWaiting: false,
        lastReadAgeMs: null,
      },
      31,
    )
    db.prepare("UPDATE sessions SET filter_mode = 'normal', updated_at = ? WHERE id = 'sess-31'").run(NOW)
    expect(send("@multi/seat").warning).toBeUndefined()
    db.prepare("UPDATE sessions SET filter_mode = 'focus' WHERE id = 'sess-31'").run()
    expect(String(send("@multi/seat").warning)).toContain(
      "@multi/seat is in focus mode: no wakeup for this notify; it stays in their inbox until they fetch",
    )
    // S4: When the single remaining DB row for @multi/seat belongs to the pull sibling (sess-30) in
    // focus mode and live push sibling sess-31 has no DB row, push delivery default-allows
    // (getSessionFilter('sess-31') === undefined -> shouldDeliver returns true), so no focus note fires.
    db.prepare(
      "UPDATE sessions SET id = 'sess-30', filter_mode = 'focus', updated_at = ? WHERE name = '@multi/seat'",
    ).run(NOW + 1_000)
    expect(send("@multi/seat").warning).toBeUndefined()

    // 6. Disconnected / deaf recipients retain transport/mailbox diagnostics (including on open-ball refs, S2).
    stmts.touchMailboxAttentionRead.run({ $recipient: "@pull/gone", $now: NOW - 42_000 })
    const gone = send("@pull/gone")
    expect(gone.sent).toBe(true)
    expect(String(gone.warning)).toContain("@pull/gone")
    expect(String(gone.warning)).toContain("opens no obligation")
    expect(String(gone.warning)).toContain("type=request")
    expect(String(gone.warning)).toContain("--ref <open-request-id>")
    expect(String(gone.warning)).toContain("transport=disconnected")
    expect(String(gone.warning)).toContain("canonical mailbox READ=observed age 42000ms")
    expect(String(gone.warning)).not.toContain("not answer-capable")
    expect(db.prepare("SELECT COUNT(*) AS count FROM pending_request WHERE recipient = '@pull/gone'").get()).toEqual({
      count: 0,
    })
    expect(String(send("@pull/gone", "status").warning)).toContain("this status opens no obligation")
    stmts.openPendingRequest.run({
      $request_id: "ball-gone",
      $recipient: "@pull/gone",
      $sender: "@sender",
      $opened_at: NOW,
      $expires_at: NOW + 60_000,
      $message_id: "ball-gone",
      $fanout: "first",
    })
    expect(String(send("@pull/gone", "notify", undefined, "ball-gone").warning)).toContain("transport=disconnected")
    stmts.closePendingRequest.run({ $request_id: "ball-gone", $recipient: "@pull/gone" })

    const unknown = send("@pull/deaf", "status")
    expect(unknown.sent).toBe(true)
    expect(String(unknown.warning)).toContain("mailbox authority=unavailable")
    expect(String(unknown.warning)).toContain("@pull/deaf")
    expect(String(unknown.warning)).not.toContain("not answer-capable")

    const multi = toolJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: ["@push/joined", "@pull/idle", "@pull/gone"], message: "fleet note", type: "notify", summary: "note" },
        opts(),
      ),
    )
    expect(multi.sent).toBe(true)
    expect(String(multi.warning)).toContain("@pull/idle has no live push client")
    expect(String(multi.warning)).toContain("@pull/gone: transport=disconnected")
    expect(String(multi.warning)).not.toContain("@push/joined")
    const tracked = send("@pull/gone", "status", true)
    expect(tracked.sent).toBe(true)
    expect(tracked.request_id).toBeTypeOf("string")
    expect(tracked.warning).toBeUndefined()
  })

  it("warns for the original target of a bounced untracked send", () => {
    addSeat(
      {
        name: "@ci",
        delivery: "pull",
        connected: false,
        readableMailbox: true,
        ownerWaiting: false,
        lastReadAgeMs: null,
      },
      2,
    )
    addSeat(
      {
        name: "@chief",
        delivery: "push",
        connected: true,
        readableMailbox: true,
        ownerWaiting: false,
        lastReadAgeMs: null,
      },
      3,
    )
    const resolveDelivery = parseDeliveryFallbackPolicy(
      tribeHabModule.habitants.wire.env.TRIBE_DELIVERY_FALLBACKS,
    )?.resolveDelivery
    const sent = toolJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: "@ci", message: "fleet note", type: "notify", summary: "note" },
        opts({ resolveDelivery }),
      ),
    )
    expect(sent).toMatchObject({
      sent: true,
      delivery: { state: "bounced", original_target: "@ci", recipient: "@chief" },
    })
    expect(String(sent.warning)).toContain("@ci")
    expect(String(sent.warning)).not.toContain("@chief")
  })

  it("26523: deliveryReport reports connected-no-consumer online at or below the 10-minute ceiling, offline above or null, and omits note", () => {
    const pullSeat = { delivery: "pull", connected: true, readableMailbox: true, ownerWaiting: false } as const
    const cases = [
      { name: "@pull/at-ceiling", lastReadAgeMs: 10 * MINUTE, expectedState: "online" as const },
      { name: "@pull/over-ceiling", lastReadAgeMs: 10 * MINUTE + 1, expectedState: "offline" as const },
      { name: "@pull/never-read", lastReadAgeMs: null, expectedState: "offline" as const },
    ]
    cases.forEach((entry, idx) =>
      addSeat({ ...pullSeat, name: entry.name, lastReadAgeMs: entry.lastReadAgeMs }, idx + 2),
    )

    for (const entry of cases) {
      const sent = toolJson(
        handleToolCall(
          sender,
          "tribe.send",
          { to: entry.name, message: `check ${entry.name}`, type: "request", request: `req-${entry.name}` },
          opts(),
        ),
      )
      expect(sent.delivery, entry.name).toEqual({
        state: entry.expectedState,
        recipient: entry.name,
        reason: "connected-no-consumer",
        last_mailbox_read_age_ms: entry.lastReadAgeMs,
      })
      expect("note" in (sent.delivery as Record<string, unknown>), `${entry.name} delivery note key`).toBe(false)
    }

    const pending = toolJson(handleToolCall(sender, "tribe.pending", { all: true }, opts())) as {
      pending: Array<Record<string, unknown>>
    }
    const pendingByOwner = new Map(pending.pending.map((row) => [row.recipient, row]))
    for (const entry of cases) {
      expect(pendingByOwner.get(entry.name), `pending ${entry.name}`).toMatchObject({
        owner_answer_capability: "not-observed",
        owner_transport_reason: "connected-no-consumer",
        owner_last_mailbox_read_age_ms: entry.lastReadAgeMs,
      })
    }
  })
})
