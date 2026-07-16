import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Server, Socket as NetSocket } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createScope } from "tribe-wire"
import { TRIBE_PROTOCOL_VERSION, type JsonRpcRequest } from "tribe-wire/lib/socket"
import type { TribeRole } from "tribe-wire/lib/config"
import { createTribeContext } from "../context.ts"
import { openDatabase, createStatements } from "../database.ts"
import { sendMessage } from "../messaging.ts"
import type { ClientSession } from "./with-client-registry.ts"
import { withDispatcher } from "./with-dispatcher.ts"
import { TRIBE_COORD_METHODS } from "../handlers.ts"

type TestSocket = NetSocket & {
  destroyedByDispatcher: boolean
  emitClose(): void
  writes: string[]
}

type RegisterResult = {
  sessionId: string
  name: string
  role: TribeRole
}

type CliStatusResult = {
  sessions: Array<{
    id: string
    name: string
    pid: number
    role: TribeRole
    transportPids: number[]
  }>
}

type InboxDrainResult = {
  session: string
  unread_count: number
  drained_count: number
  events: Array<{ content: string }>
}

type InboxStatusResult = {
  session: string
  unread_count: number
}

type InboxWaitResult = {
  session: string
  unread_count: number
  waited_ms: number
  timed_out: boolean
  aborted: boolean
}

type JsonRpcResponse<T> = {
  result?: T
  error?: {
    code: number
    message: string
  }
}

const liveHolderPid = process.pid
const otherLivePid = process.pid + 1

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (!cleanup) return
  const dispose = cleanup
  cleanup = null
  await dispose()
})

describe("dispatcher self-registration collision handling (@ag/tribe/19594)", () => {
  it("lets the same live PID re-register an explicit agent name", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const firstSocket = harness.addPendingClient("conn-first")
    const first = parseResult<RegisterResult>(
      await harness.register("conn-first", {
        name: "@agent/9",
        pid: liveHolderPid,
        project: "/tmp/km-wt9",
      }),
    )

    const secondSocket = harness.addPendingClient("conn-second")
    const second = parseResult<RegisterResult>(
      await harness.register("conn-second", {
        name: "@agent/9",
        pid: liveHolderPid,
        project: "/tmp/km-wt9",
      }),
    )

    expect(second.name).toBe("@agent/9")
    expect(second.sessionId).toBe(first.sessionId)
    expect(firstSocket.destroyedByDispatcher).toBe(true)
    expect(secondSocket.destroyedByDispatcher).toBe(false)

    const status = parseResult<CliStatusResult>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "status",
          method: "cli_status",
          params: {},
        },
        "conn-second",
      ),
    )
    const agentSessions = status.sessions.filter((s) => s.name === "@agent/9")
    expect(agentSessions).toHaveLength(1)
    expect(agentSessions[0]?.pid).toBe(liveHolderPid)
  })

  it("still rejects an explicit duplicate name from a different live PID", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    harness.addPendingClient("conn-holder")
    const holder = parseResult<RegisterResult>(
      await harness.register("conn-holder", {
        name: "@agent/9",
        pid: liveHolderPid,
        project: "/tmp/km-wt9",
      }),
    )
    expect(holder.name).toBe("@agent/9")

    harness.addPendingClient("conn-contender")
    const duplicate = parseError(
      await harness.register("conn-contender", {
        name: "@agent/9",
        pid: otherLivePid,
        project: "/tmp/km-wt9",
      }),
    )

    expect(duplicate.message).toBe(`Name "@agent/9" is already taken by live pid ${liveHolderPid}`)
  })

  it("projects launch fan-in as one canonical session and omits pending probes", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    harness.addPendingClient("conn-agent")
    const registered = parseResult<RegisterResult>(
      await harness.register("conn-agent", {
        name: "@agent/5",
        pid: liveHolderPid,
        project: "/tmp/km-wt5",
      }),
    )
    harness.addTransport("conn-mcp", "conn-agent", liveHolderPid + 2)
    harness.addPendingClient("conn-status-probe")

    const status = parseResult<CliStatusResult>(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "status", method: "cli_status", params: {} },
        "conn-status-probe",
      ),
    )

    expect(status.sessions).toHaveLength(1)
    expect(status.sessions[0]).toMatchObject({
      id: registered.sessionId,
      name: "@agent/5",
      pid: liveHolderPid,
      transportPids: [liveHolderPid, liveHolderPid + 2],
    })
    expect(status.sessions.some((session) => session.name.startsWith("pending-"))).toBe(false)
  })
})

// Inbox drain is bound to the AUTHENTICATED CURRENT session and requires a
// server-verified live launch fan-in (Agent3's c7cecd84 semantics, re-expressed
// on the unified current-epoch-holder authority model). Name is not authority;
// the PUBLIC launch tuple is not authority — only the private token that the
// fan-in transport shares with the live holder is.
describe("dispatcher bounded mailbox drain", () => {
  it("binds acknowledgement to the managed launch's authenticated current session", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const launch = { launchId: "launch-agent-3", launchParentPid: 4242 }
    const identityToken = "private-runtime-agent-3"
    const holderSocket = harness.addPendingClient("conn-holder")
    const holder = parseResult<RegisterResult>(
      await harness.register("conn-holder", {
        name: "@agent/3",
        pid: liveHolderPid,
        project: "/tmp/km-wt3",
        identityToken,
        ...launch,
      }),
    )
    harness.addPendingClient("conn-drain")
    const drainTransport = parseResult<RegisterResult>(
      await harness.register("conn-drain", {
        name: "@agent/3",
        pid: otherLivePid,
        project: "/tmp/km-wt3",
        identityToken,
        ...launch,
      }),
    )
    expect(drainTransport.sessionId).toBe(holder.sessionId)
    expect(holderSocket.destroyedByDispatcher).toBe(false)
    expect(harness.sessionCount("@agent/3")).toBe(1)

    harness.sendActionable("@chief", "chief-only request")
    harness.sendActionable("@agent/3", "agent request")

    // A `session` override is forbidden — the drain is bound to the caller's own
    // authenticated session, so it can never acknowledge a foreign mailbox.
    const crossRole = parseError(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "cross-role-drain", method: "cli_inbox_drain", params: { session: "@chief", limit: 1 } },
        "conn-drain",
      ),
    )
    expect(crossRole).toMatchObject({ code: -32602 })
    expect(crossRole.message).toMatch(/session override is forbidden/)

    const first = parseResult<InboxDrainResult>(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "drain-1", method: "cli_inbox_drain", params: { limit: 1 } },
        "conn-drain",
      ),
    )
    expect(first).toMatchObject({ session: "@agent/3", drained_count: 1, unread_count: 0 })
    expect(first.events.map((event) => event.content)).toEqual(["agent request"])

    // @chief's mailbox is untouched by @agent/3's drain.
    const chiefStatus = parseResult<InboxStatusResult>(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "chief-status", method: "cli_inbox_status", params: { session: "@chief" } },
        "conn-drain",
      ),
    )
    expect(chiefStatus).toMatchObject({ session: "@chief", unread_count: 1 })
  })

  it("rejects a live foreign role replaying the public launch tuple without advancing the victim cursor", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const launch = { launchId: "public-launch-agent-3", launchParentPid: 4242 }
    const victimIdentityToken = "private-runtime-agent-3"
    harness.addPendingClient("conn-victim")
    const victim = parseResult<RegisterResult>(
      await harness.register("conn-victim", {
        name: "@agent/3",
        pid: liveHolderPid,
        project: "/tmp/km-wt3",
        identityToken: victimIdentityToken,
        ...launch,
      }),
    )
    harness.sendActionable("@agent/3", "victim request must remain unread")

    // The attacker knows the PUBLIC launch tuple (readable via tribe.debug) but
    // NOT the victim's private token; replaying the tuple fails the live-holder
    // name conflict (no fan-in without the token).
    harness.addPendingClient("conn-attacker")
    const stolenTuple = parseError(
      await harness.register("conn-attacker", {
        name: "@agent/3",
        pid: otherLivePid,
        project: "/tmp/km-wt8",
        identityToken: "private-runtime-agent-8",
        ...launch,
      }),
    )
    expect(stolenTuple).toMatchObject({ code: -32000 })

    const attackDrain = parseError(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "attacker-drain", method: "cli_inbox_drain", params: { limit: 1 } },
        "conn-attacker",
      ),
    )
    expect(attackDrain).toMatchObject({ code: -32001 })

    const afterAttack = parseResult<InboxStatusResult>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "victim-status-after-attack",
          method: "cli_inbox_status",
          params: { session: "@agent/3" },
        },
        "conn-attacker",
      ),
    )
    expect(afterAttack.unread_count).toBe(1)

    // The legitimate holder (matching private token) fans in and drains.
    harness.addPendingClient("conn-legitimate-drain")
    const legitimate = parseResult<RegisterResult>(
      await harness.register("conn-legitimate-drain", {
        name: "@agent/3",
        pid: otherLivePid + 1,
        project: "/tmp/km-wt3",
        identityToken: victimIdentityToken,
        ...launch,
      }),
    )
    expect(legitimate.sessionId).toBe(victim.sessionId)
    const drained = parseResult<InboxDrainResult>(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "legitimate-drain", method: "cli_inbox_drain", params: { limit: 1 } },
        "conn-legitimate-drain",
      ),
    )
    expect(drained).toMatchObject({ session: "@agent/3", drained_count: 1, unread_count: 0 })
    expect(drained.events.map((event) => event.content)).toEqual(["victim request must remain unread"])
  })

  it("rejects unregistered, non-member, and name-only (no server-verified fan-in) callers", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    harness.addPendingClient("conn-pending")
    expect(
      parseError(
        await harness.dispatcher.handleRequest(
          { jsonrpc: "2.0", id: "pending-drain", method: "cli_inbox_drain", params: {} },
          "conn-pending",
        ),
      ),
    ).toMatchObject({ code: -32001 })

    harness.addPendingClient("conn-watch")
    await harness.register("conn-watch", {
      name: "watcher",
      role: "watch",
      pid: liveHolderPid,
      project: "/tmp/km-watch",
    })
    expect(
      parseError(
        await harness.dispatcher.handleRequest(
          { jsonrpc: "2.0", id: "watch-drain", method: "cli_inbox_drain", params: {} },
          "conn-watch",
        ),
      ),
    ).toMatchObject({ code: -32001 })

    // A caller that ASSERTS a launch tuple but never authenticated a fan-in
    // (no live launch peer sharing its private token) cannot drain.
    harness.addPendingClient("conn-name-only")
    await harness.register("conn-name-only", {
      name: "@chief",
      pid: otherLivePid,
      project: "/tmp/km-chief",
      launchId: "caller-asserted-launch",
      launchParentPid: 9001,
    })
    harness.sendActionable("@chief", "must remain unread")
    const nameOnly = parseError(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "name-only-drain", method: "cli_inbox_drain", params: { limit: 1 } },
        "conn-name-only",
      ),
    )
    expect(nameOnly).toMatchObject({ code: -32001 })
    expect(nameOnly.message).toMatch(/server-verified fan-in/)
    const chiefStatus = parseResult<InboxStatusResult>(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "name-only-chief-status", method: "cli_inbox_status", params: { session: "@chief" } },
        "conn-name-only",
      ),
    )
    expect(chiefStatus.unread_count).toBe(1)
  })

  it("validates the limit before mutation and preserves fetch trust + attention eligibility", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const launch = { launchId: "launch-agent-3", launchParentPid: 4242 }
    const identityToken = "private-runtime-agent-3"
    harness.addPendingClient("conn-holder")
    await harness.register("conn-holder", {
      name: "@agent/3",
      pid: liveHolderPid,
      project: "/tmp/km-wt3",
      identityToken,
      ...launch,
    })
    harness.addPendingClient("conn-drain")
    await harness.register("conn-drain", {
      name: "@agent/3",
      pid: otherLivePid,
      project: "/tmp/km-wt3",
      identityToken,
      ...launch,
    })
    harness.sendActionable("@agent/3", "forged daemon request", {
      sender: "unregistered-sender",
      topic: "daemon:forged",
    })
    harness.sendActionable("@agent/3", "non-actionable notice", { type: "notify" })
    harness.sendActionable("@agent/3", "trusted actionable request", { sender: "daemon", topic: "daemon:request" })

    for (const limit of [0, -1, 101, 1.5, "1"] as unknown[]) {
      const invalid = parseError(
        await harness.dispatcher.handleRequest(
          { jsonrpc: "2.0", id: `invalid-${String(limit)}`, method: "cli_inbox_drain", params: { limit } },
          "conn-drain",
        ),
      )
      expect(invalid).toMatchObject({ code: -32602 })
    }

    const valid = parseResult<InboxDrainResult>(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "valid-drain", method: "cli_inbox_drain", params: { limit: 1 } },
        "conn-drain",
      ),
    )
    expect(valid).toMatchObject({ session: "@agent/3", drained_count: 1, unread_count: 0 })
    expect(valid.events.map((event) => event.content)).toEqual(["trusted actionable request"])

    const empty = parseResult<InboxDrainResult>(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "empty-drain", method: "cli_inbox_drain", params: { limit: 1 } },
        "conn-drain",
      ),
    )
    expect(empty).toMatchObject({ drained_count: 0, unread_count: 0, events: [] })
  })
})

describe("dispatcher session announcement recovery (@ag/tribe/21052/19442)", () => {
  it("re-attaches a reconnecting name to ONE durable member without join spam", async () => {
    // Durable identity (Goal 1) supersedes the old time-window join coalescing:
    // a name that reconnects re-ATTACHES to its existing member (one identity,
    // one row) instead of re-joining. The first join announces; every re-attach
    // is silent. Durable history stays lossless — the initial `session.joined`
    // plus one `session.attached` per reconnect — so nothing is dropped.
    const suppressWindowMs = 10_000
    let now = 100_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const harness = createDispatcherHarness({
        suppressWindowMs,
        socketStartedAt: now - suppressWindowMs - 1,
      })
      cleanup = harness.dispose

      // The daemon-start window has elapsed, so this exercises live adapter
      // churn rather than startup suppression.
      const first = harness.connectClient()
      const r1 = await registerMember(harness, first.connId, "@agent/6")
      now += 5_000
      first.socket.emitClose()

      now += 5_000
      const second = harness.connectClient()
      const r2 = await registerMember(harness, second.connId, "@agent/6")
      now += 5_000
      second.socket.emitClose()

      now += 10_000
      const stable = harness.connectClient()
      const r3 = await registerMember(harness, stable.connId, "@agent/6")
      const independent = harness.connectClient()
      await registerMember(harness, independent.connId, "@agent/7")

      // ONE durable member: all three registrations resolve the SAME sessionId
      // and there is exactly one row for the name.
      expect(r2.sessionId).toBe(r1.sessionId)
      expect(r3.sessionId).toBe(r1.sessionId)
      expect(harness.memberRowCount("@agent/6")).toBe(1)

      // Only the first join announces; the two re-attaches are silent.
      const announcements = harness.sessionAnnouncements("@agent/6")
      expect(announcements).toHaveLength(1)
      expect(announcements.every((content) => content.includes("@agent/6 joined (member)"))).toBe(true)
      expect(harness.sessionAnnouncements("@agent/7")).toHaveLength(1)

      // Durable history is lossless: one join + one attach per reconnect, and
      // each disconnect records a DETACHED transition (successor r2), never a
      // `session.left`. Only an explicit authorized leave emits `left`.
      expect(harness.sessionJoinEvents("@agent/6")).toHaveLength(1)
      expect(harness.sessionAttachedEvents("@agent/6")).toHaveLength(2)
      expect(harness.sessionJoinEvents("@agent/7")).toHaveLength(1)
      expect(harness.sessionDetachedEvents("@agent/6")).toHaveLength(2)
      expect(harness.sessionLeftEvents("@agent/6")).toHaveLength(0)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("suppresses both channel transitions during daemon startup without losing durable lifecycle events", async () => {
    const suppressWindowMs = 10_000
    let now = 200_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const harness = createDispatcherHarness({ suppressWindowMs, socketStartedAt: now })
      cleanup = harness.dispose

      const client = harness.connectClient()
      await registerMember(harness, client.connId, "@agent/6")
      // Even if this startup-created connection outlives the startup window,
      // a suppressed join must not later produce an orphan "left" line.
      now += 15_000
      client.socket.emitClose()

      expect(harness.sessionAnnouncements("@agent/6")).toEqual([])
      expect(harness.sessionJoinEvents("@agent/6")).toHaveLength(1)
      // Disconnect records a DETACHED transition (successor r2), not `left`.
      expect(harness.sessionDetachedEvents("@agent/6")).toHaveLength(1)
      expect(harness.sessionLeftEvents("@agent/6")).toHaveLength(0)
    } finally {
      nowSpy.mockRestore()
    }
  })
})

describe("dispatcher inbox-wait parsing", () => {
  it("wakes waits for actionable messages sent through a registered client context", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    harness.addPendingClient("conn-sender")
    await harness.register("conn-sender", {
      name: "@agent/sender",
      pid: liveHolderPid,
      project: "/tmp/km-wt9",
    })

    const wait = harness.dispatcher.handleRequest(
      {
        jsonrpc: "2.0",
        id: "wait",
        method: "tribe.inbox.wait",
        params: { session: "@agent/wait", timeoutMs: 100 },
      },
      "conn-wait",
    )

    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    parseResult(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "send",
          method: "tribe.send",
          params: {
            to: "@agent/wait",
            message: "wake inbox wait",
            type: "request",
          },
        },
        "conn-sender",
      ),
    )

    const result = parseResult<InboxWaitResult>(await wait)
    expect(result.session).toBe("@agent/wait")
    expect(result.unread_count).toBe(1)
    expect(result.timed_out).toBe(false)
    expect(result.aborted).toBe(false)
  })

  it("uses the same timeoutMs fallback accepted by the MCP handler", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const wait = harness.dispatcher.handleRequest(
      {
        jsonrpc: "2.0",
        id: "wait",
        method: "tribe.inbox.wait",
        params: { session: "@agent/wait", timeoutMs: 0 },
      },
      "conn-wait",
    )

    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    harness.sendActionable("@agent/wait")

    const result = parseResult<InboxWaitResult>(await wait)
    expect(result.session).toBe("@agent/wait")
    expect(result.unread_count).toBe(0)
    expect(result.timed_out).toBe(true)
    expect(result.aborted).toBe(false)
  })
})

describe("durable member identity (Goal 1)", () => {
  it("keeps the member row across disconnect so fetch/pending still resolve the owner", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const first = harness.connectClient()
    const r1 = parseResult<RegisterResult>(
      await harness.register(first.connId, { name: "@cli-chief", pid: 7001, project: "/tmp/km-wt6" }),
    )

    // An actionable lands for the member — opens its durable, name-keyed mailbox.
    harness.sendActionable("@cli-chief", "please verify")

    // Disconnect DETACHES; the durable row must persist (not be deleted).
    first.socket.emitClose()
    expect(harness.memberRowCount("@cli-chief")).toBe(1)

    // The owner still resolves while detached: the mailbox is name-keyed.
    const status = parseResult<{ unread_count: number }>(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "s", method: "cli_inbox_status", params: { session: "@cli-chief" } },
        "conn-probe",
      ),
    )
    expect(status.unread_count).toBeGreaterThanOrEqual(1)

    // Reconnecting (fresh pid = true CLI churn) re-attaches to the SAME member.
    const second = harness.connectClient()
    const r2 = parseResult<RegisterResult>(
      await harness.register(second.connId, { name: "@cli-chief", pid: 7002, project: "/tmp/km-wt6" }),
    )
    expect(r2.sessionId).toBe(r1.sessionId)
    expect(harness.memberRowCount("@cli-chief")).toBe(1)
  })

  it("attributes 3 CLI connect-send-disconnect cycles to ONE member with zero join/left broadcasts", async () => {
    // suppressWindowMs 0 turns OFF the time-window coalescer, so the ONLY thing
    // that can silence a re-attach is the durable-identity attach path itself.
    const harness = createDispatcherHarness({ suppressWindowMs: 0 })
    cleanup = harness.dispose

    // Establish the durable member (a genuine first join is allowed to announce).
    const est = harness.connectClient()
    const established = parseResult<RegisterResult>(
      await harness.register(est.connId, { name: "@cli-chief", pid: 8000, project: "/tmp/km-wt6" }),
    )
    est.socket.emitClose()
    const baselineAnnouncements = harness.sessionAnnouncements("@cli-chief").length

    // 3 CLI-style cycles, a FRESH pid each (no pid+cwd adoption → attach-by-name).
    for (let i = 0; i < 3; i++) {
      const c = harness.connectClient()
      const res = parseResult<RegisterResult>(
        await harness.register(c.connId, { name: "@cli-chief", pid: 8100 + i, project: "/tmp/km-wt6" }),
      )
      expect(res.sessionId).toBe(established.sessionId)
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: `send-${i}`,
          method: TRIBE_COORD_METHODS.send,
          params: { to: "*", message: `cycle ${i}`, type: "status" },
        },
        c.connId,
      )
      c.socket.emitClose()
    }

    // ONE member row, and the 3 cycles added ZERO join/left broadcasts.
    expect(harness.memberRowCount("@cli-chief")).toBe(1)
    expect(harness.sessionAnnouncements("@cli-chief").length).toBe(baselineAnnouncements)
  })

  it("authorizes explicit leave: self and operator may leave, an arbitrary connection is denied (successor r2)", async () => {
    const OPERATOR = "op-secret-xyz"
    const harness = createDispatcherHarness({ operatorToken: OPERATOR })
    cleanup = harness.dispose

    // Self-leave: the LIVE holder connection leaves itself → authorized.
    const holder = harness.connectClient()
    await harness.register(holder.connId, { name: "@cli-worker", pid: 9001, project: "/tmp/km-wt6" })
    const selfLeave = parseResult<{ left: boolean; removed: number }>(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "self-leave", method: "cli_leave", params: { session: "@cli-worker" } },
        holder.connId,
      ),
    )
    expect(selfLeave.left).toBe(true)
    expect(harness.memberRowCount("@cli-worker")).toBe(0)

    // A detached member to reap.
    const c = harness.connectClient()
    await harness.register(c.connId, { name: "@cli-chief", pid: 9002, project: "/tmp/km-wt6" })
    c.socket.emitClose()
    expect(harness.memberRowCount("@cli-chief")).toBe(1)

    // Unauthorized: an arbitrary connection (not the holder, no operator token)
    // is DENIED and the durable row survives — the r1 unowned-destruction hole.
    const denied = parseError(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "bad-leave", method: "cli_leave", params: { session: "@cli-chief" } },
        "conn-attacker",
      ),
    )
    expect(denied.code).toBe(-32001)
    expect(harness.memberRowCount("@cli-chief")).toBe(1)

    // A wrong operator token is likewise denied.
    const wrongOp = parseError(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "wrong-op",
          method: "cli_leave",
          params: { session: "@cli-chief", operatorToken: "not-the-secret" },
        },
        "conn-attacker",
      ),
    )
    expect(wrongOp.code).toBe(-32001)
    expect(harness.memberRowCount("@cli-chief")).toBe(1)

    // Operator authority reaps the detached member.
    const opLeave = parseResult<{ left: boolean; removed: number }>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "op-leave",
          method: "cli_leave",
          params: { session: "@cli-chief", operatorToken: OPERATOR },
        },
        "conn-operator",
      ),
    )
    expect(opLeave.left).toBe(true)
    expect(opLeave.removed).toBe(1)
    expect(harness.memberRowCount("@cli-chief")).toBe(0)
  })

  it("distinguishes attached from detached members in the sessions view", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const liveClient = harness.connectClient()
    await harness.register(liveClient.connId, { name: "@cli-worker", pid: 9101, project: "/tmp/km-wt6" })
    const gone = harness.connectClient()
    await harness.register(gone.connId, { name: "@cli-chief", pid: 9102, project: "/tmp/km-wt6" })
    gone.socket.emitClose()

    const status = parseResult<{ sessions: Array<{ name: string; attached: boolean; epoch: number }> }>(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "st", method: "cli_status", params: {} },
        liveClient.connId,
      ),
    )
    const worker = status.sessions.find((s) => s.name === "@cli-worker")
    const chief = status.sessions.find((s) => s.name === "@cli-chief")
    expect(worker?.attached).toBe(true)
    expect(chief?.attached).toBe(false)
    expect(chief?.epoch ?? 0).toBeGreaterThanOrEqual(1)
  })
})

describe("secure durable identity (successor r2)", () => {
  it("denies a token-less OR forged-tuple claim of a token-bound detached name and leaves the victim intact", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    // A managed member binds @agent/5 with its PRIVATE token (+ a public launch
    // tuple), opens its mailbox, then detaches (the durable row persists).
    const managed = harness.connectClient()
    const r1 = parseResult<RegisterResult>(
      await harness.register(managed.connId, {
        name: "@agent/5",
        pid: 5000,
        project: "/tmp/km-wt5",
        identityToken: "private-runtime-agent-5",
        launchId: "launch-abc",
        launchParentPid: 4242,
      }),
    )
    harness.sendActionable("@agent/5", "verify the build")
    managed.socket.emitClose()
    expect(harness.memberRowCount("@agent/5")).toBe(1)

    // A token-less connection tries to inherit @agent/5 by NAME only → REJECTED.
    const attacker = harness.connectClient()
    const denied = parseError(
      await harness.register(attacker.connId, { name: "@agent/5", pid: 9999, project: "/tmp/evil" }),
    )
    expect(denied.code).toBe(-32001)
    expect(denied.message).toContain("bound to a stored identity")

    // A connection replaying the PUBLIC launch tuple but not the private token is
    // ALSO rejected — the tuple is a locator (readable via tribe.debug), never an
    // authenticator.
    const tupleForger = harness.connectClient()
    const tupleDenied = parseError(
      await harness.register(tupleForger.connId, {
        name: "@agent/5",
        pid: 9998,
        project: "/tmp/evil",
        identityToken: "wrong-token",
        launchId: "launch-abc",
        launchParentPid: 4242,
      }),
    )
    expect(tupleDenied.code).toBe(-32001)

    // The victim's durable row + sessionId + token + launch binding survive.
    expect(harness.memberRowCount("@agent/5")).toBe(1)
    expect(
      harness.db.prepare("SELECT id, identity_token, launch_id FROM sessions WHERE name = ?").get("@agent/5"),
    ).toMatchObject({ id: r1.sessionId, identity_token: "private-runtime-agent-5", launch_id: "launch-abc" })
    expect(harness.sessionAttachDeniedEvents("@agent/5")).toHaveLength(2)

    // The legitimate managed relaunch (matching PRIVATE token) reclaims it.
    const relaunch = harness.connectClient()
    const r2 = parseResult<RegisterResult>(
      await harness.register(relaunch.connId, {
        name: "@agent/5",
        pid: 5001,
        project: "/tmp/km-wt5",
        identityToken: "private-runtime-agent-5",
        launchId: "launch-abc",
        launchParentPid: 4242,
      }),
    )
    expect(r2.sessionId).toBe(r1.sessionId)
  })

  it("never nulls launch provenance when a dual-bound member reattaches via token only", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    // A member bound by BOTH its private token AND a launch identity.
    const first = harness.connectClient()
    const r1 = parseResult<RegisterResult>(
      await harness.register(first.connId, {
        name: "@agent/8",
        pid: 8001,
        project: "/tmp/km-wt8",
        identityToken: "tok-agent8",
        launchId: "launch-8",
        launchParentPid: 88,
      }),
    )
    first.socket.emitClose()
    expect(
      harness.db
        .prepare("SELECT identity_token, launch_id, launch_parent_pid FROM sessions WHERE name = ?")
        .get("@agent/8"),
    ).toMatchObject({ identity_token: "tok-agent8", launch_id: "launch-8", launch_parent_pid: 88 })

    // Reattach as a pure-CLI connection: present the TOKEN (the authenticator) but
    // NO launch tuple. Token match authorizes it, and the stored LAUNCH binding
    // must survive (the COALESCE guard: never overwrite a non-null stored field
    // with null).
    const second = harness.connectClient()
    const r2 = parseResult<RegisterResult>(
      await harness.register(second.connId, {
        name: "@agent/8",
        pid: 8002,
        project: "/tmp/km-wt8",
        identityToken: "tok-agent8",
      }),
    )
    expect(r2.sessionId).toBe(r1.sessionId)
    expect(
      harness.db
        .prepare("SELECT identity_token, launch_id, launch_parent_pid FROM sessions WHERE name = ?")
        .get("@agent/8"),
    ).toMatchObject({ identity_token: "tok-agent8", launch_id: "launch-8", launch_parent_pid: 88 })
  })

  it("preserves the mailbox cursor across reattach: a DM sent while detached delivers after reattach", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const first = harness.connectClient()
    const r1 = parseResult<RegisterResult>(
      await harness.register(first.connId, { name: "@cli-chief", pid: 7001, project: "/tmp/km-wt6" }),
    )
    const cursorAfterJoin = harness.inboxCursor(r1.sessionId)

    // Detach, then two ordinary DMs land while the member is offline.
    first.socket.emitClose()
    harness.sendDirect("@cli-chief", "offline DM one")
    harness.sendDirect("@cli-chief", "offline DM two")

    // Reattach (fresh pid = CLI churn → attach-by-name on the unbound row).
    const second = harness.connectClient()
    const r2 = parseResult<RegisterResult>(
      await harness.register(second.connId, { name: "@cli-chief", pid: 7002, project: "/tmp/km-wt6" }),
    )
    expect(r2.sessionId).toBe(r1.sessionId)

    // The cursor was NOT advanced to the new tail — reset was skipped on reattach.
    expect(harness.inboxCursor(r2.sessionId)).toBe(cursorAfterJoin)
    // Both detached-period DMs remain deliverable past that preserved cursor.
    expect(harness.inboxRowContents("@cli-chief", cursorAfterJoin)).toEqual(["offline DM one", "offline DM two"])
  })

  it("keeps a member's pending balls across detach/rejoin (name-keyed ownership survives)", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    const first = harness.connectClient()
    const r1 = parseResult<RegisterResult>(
      await harness.register(first.connId, { name: "@cli-chief", pid: 7101, project: "/tmp/km-wt6" }),
    )
    const asker = harness.connectClient()
    await harness.register(asker.connId, { name: "@asker", pid: 7200, project: "/tmp/km-wt7" })

    // Someone opens a tracked ball owned by @cli-chief.
    await harness.dispatcher.handleRequest(
      {
        jsonrpc: "2.0",
        id: "ask",
        method: TRIBE_COORD_METHODS.send,
        params: { to: "@cli-chief", message: "please review", type: "request", request: true },
      },
      asker.connId,
    )
    expect(harness.pendingBallCount("@cli-chief")).toBe(1)

    // Detach and reattach the owner.
    first.socket.emitClose()
    const second = harness.connectClient()
    const r2 = parseResult<RegisterResult>(
      await harness.register(second.connId, { name: "@cli-chief", pid: 7102, project: "/tmp/km-wt6" }),
    )
    expect(r2.sessionId).toBe(r1.sessionId)

    // The ball still belongs to the reattached owner.
    expect(harness.pendingBallCount("@cli-chief")).toBe(1)
  })

  it("fences a stale disconnect from a superseded epoch: it cannot mark the current holder detached", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    // connA owns @agent/3 (unbound, sessionId X, epoch 1).
    const a = harness.connectClient()
    const rA = parseResult<RegisterResult>(
      await harness.register(a.connId, { name: "@agent/3", pid: 3001, project: "/tmp/km-wt3" }),
    )
    const staleClientA = harness.clients.get(a.connId)!
    a.socket.emitClose() // connA detaches → detached #1 (epoch 1); row persists.
    expect(harness.sessionDetachedEvents("@agent/3")).toHaveLength(1)

    // connB re-owns @agent/3 under a DIFFERENT sessionId via launch-eviction (a
    // launch identity is not a same-sessionId attach; registerSession evicts the
    // unbound detached row and mints a fresh identity).
    const b = harness.connectClient()
    const rB = parseResult<RegisterResult>(
      await harness.register(b.connId, {
        name: "@agent/3",
        pid: 3002,
        project: "/tmp/km-wt3",
        launchId: "launch-3",
        launchParentPid: 33,
      }),
    )
    expect(rB.sessionId).not.toBe(rA.sessionId)

    // A late/duplicate close from the SUPERSEDED connA arrives (re-inject to model
    // an in-flight close). The epoch fence must SUPPRESS it — no spurious detached
    // for @agent/3, whose current holder is connB.
    harness.clients.set(staleClientA.id, staleClientA)
    harness.socketToClient.set(staleClientA.socket, staleClientA.id)
    a.socket.emitClose()

    // Still exactly ONE detached event (connA's legit epoch-1 detach); the stale
    // replay added none, and connB (live) is not marked detached.
    expect(harness.sessionDetachedEvents("@agent/3")).toHaveLength(1)
    expect(harness.memberRowCount("@agent/3")).toBe(1)
  })

  it("hostile leave cannot delete authority: a denied leave leaves the victim byte-identical", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    // A token-bound member with unread mail + an open pending ball, then detached.
    const holder = harness.connectClient()
    await harness.register(holder.connId, {
      name: "@agent/2",
      pid: 2001,
      project: "/tmp/km-wt2",
      identityToken: "tok-agent2",
      launchId: "launch-2",
      launchParentPid: 22,
    })
    const asker = harness.connectClient()
    await harness.register(asker.connId, { name: "@asker", pid: 2100, project: "/tmp/km-wt-asker" })
    await harness.dispatcher.handleRequest(
      {
        jsonrpc: "2.0",
        id: "ask",
        method: TRIBE_COORD_METHODS.send,
        params: { to: "@agent/2", message: "review", type: "request", request: true },
      },
      asker.connId,
    )
    harness.sendActionable("@agent/2", "unread actionable")
    holder.socket.emitClose()

    // Snapshot the victim's full durable identity + mailbox cursor + mailbox
    // contents + pending state.
    const before = harness.fullSessionState("@agent/2")
    expect(before.mailbox.length).toBeGreaterThanOrEqual(1)
    expect(before.balls.length).toBeGreaterThanOrEqual(1)

    // A hostile leave from an arbitrary connection (not the holder, no operator).
    const denied = parseError(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "hostile-leave", method: "cli_leave", params: { session: "@agent/2" } },
        "conn-hostile",
      ),
    )
    expect(denied.code).toBe(-32001)

    // Byte-identical (deep-equal): durable row + identity fields, mailbox cursor,
    // mailbox contents, and pending balls are all exactly as before.
    expect(harness.fullSessionState("@agent/2")).toEqual(before)
    expect(harness.memberRowCount("@agent/2")).toBe(1)
  })

  it("current-epoch authority: a stale-epoch holder cannot leave or drain, the current holder can", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    // connA is the epoch-1 holder of @cli-worker; capture it, then detach.
    const a = harness.connectClient()
    await harness.register(a.connId, { name: "@cli-worker", pid: 3001, project: "/tmp/km-wtw" })
    const staleA = harness.clients.get(a.connId)!
    a.socket.emitClose()

    // connB reattaches @cli-worker (epoch 2, same member) — advancing the epoch.
    const b = harness.connectClient()
    await harness.register(b.connId, { name: "@cli-worker", pid: 3002, project: "/tmp/km-wtw" })

    // Re-inject the stale epoch-1 connection; it no longer carries authority.
    harness.clients.set(staleA.id, staleA)
    harness.socketToClient.set(staleA.socket, staleA.id)
    const staleLeave = parseError(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "stale-leave", method: "cli_leave", params: { session: "@cli-worker" } },
        staleA.id,
      ),
    )
    expect(staleLeave.code).toBe(-32001)
    const staleDrain = parseError(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "stale-drain", method: "cli_inbox_drain", params: {} },
        staleA.id,
      ),
    )
    expect(staleDrain.code).toBe(-32001)
    expect(harness.memberRowCount("@cli-worker")).toBe(1)

    // The CURRENT-epoch holder (connB) can self-leave.
    const bLeave = parseResult<{ left: boolean }>(
      await harness.dispatcher.handleRequest(
        { jsonrpc: "2.0", id: "b-leave", method: "cli_leave", params: { session: "@cli-worker" } },
        b.connId,
      ),
    )
    expect(bLeave.left).toBe(true)
    expect(harness.memberRowCount("@cli-worker")).toBe(0)
  })
})

function createDispatcherHarness(
  options: { suppressWindowMs?: number; socketStartedAt?: number; operatorToken?: string } = {},
) {
  const tempDir = mkdtempSync(join(tmpdir(), "tribe-dispatcher-"))
  const scope = createScope("dispatcher-self-registration-test")
  const db = openDatabase(join(tempDir, "tribe.sqlite"))
  const stmts = createStatements(db)
  scope.defer(() => rmSync(tempDir, { recursive: true, force: true }))
  scope.defer(() => db.close())

  const daemonCtx = createTribeContext({
    db,
    stmts,
    sessionId: "daemon-test",
    sessionRole: "daemon",
    initialName: "daemon",
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
    onMessageInserted: undefined,
  })
  const clients = new Map<string, ClientSession>()
  const socketToClient = new Map<NetSocket, string>()
  const fakeServer = createFakeServer()

  const shape = {
    scope,
    daemonSessionId: "daemon-test",
    startedAt: Date.now(),
    daemonVersion: "test",
    daemonPid: process.pid,
    config: {
      socketPath: join(tempDir, "tribe.sock"),
      dbPath: join(tempDir, "tribe.sqlite"),
      recallDbPath: join(tempDir, "recall.sqlite"),
      quitTimeoutSec: -1,
      inheritFd: null,
      focusPollMs: 60_000,
      summaryPollMs: 120_000,
      summarizerMode: "off" as const,
      recallEnabled: false,
    },
    db,
    stmts,
    daemonCtx,
    recall: null,
    registry: {
      clients,
      socketToClient,
      getActiveSessionIds(): Set<string> {
        return new Set(Array.from(clients.values(), (c) => c.ctx.sessionId))
      },
      getActiveSessionInfo() {
        const members = new Map<
          string,
          {
            id: string
            name: string
            pid: number
            cwd: string
            role: TribeRole
            claudeSessionId: string | null
            registeredAt: number
            launchId: string | null
            launchParentPid: number | null
            transportPids: number[]
          }
        >()
        for (const client of clients.values()) {
          if (client.role !== "member") continue
          const id = client.ctx.sessionId
          const member = members.get(id)
          if (member) {
            if (client.pid > 0 && !member.transportPids.includes(client.pid)) member.transportPids.push(client.pid)
            member.registeredAt = Math.min(member.registeredAt, client.registeredAt)
            continue
          }
          members.set(id, {
            id,
            name: client.name,
            pid: client.pid,
            cwd: client.project,
            role: client.role,
            claudeSessionId: client.claudeSessionId,
            registeredAt: client.registeredAt,
            launchId: client.launchId,
            launchParentPid: client.launchParentPid,
            transportPids: client.pid > 0 ? [client.pid] : [],
          })
        }
        return Array.from(members.values())
      },
    },
    broadcast: {
      notify() {},
      pushToClient() {},
      persistDeliveredCursor() {},
      async toConnected() {},
      log() {},
      flushConnection() {},
      discardConnection() {},
      messageTap() {},
    },
    socket: {
      server: fakeServer,
      socketPath: join(tempDir, "tribe.sock"),
      binding: Promise.resolve("listening" as const),
      inheritedFd: false,
      startedAt: options.socketStartedAt ?? Date.now(),
      handedOff: false,
    },
  }
  const daemon = withDispatcher({
    suppressWindowMs: options.suppressWindowMs ?? Number.MAX_SAFE_INTEGER,
    getOperatorToken: () => options.operatorToken ?? null,
  })(shape)

  return {
    dispatcher: daemon.dispatcher,
    register(
      connId: string,
      params: {
        name: string
        pid: number
        project: string
        role?: TribeRole
        identityToken?: string
        launchId?: string
        launchParentPid?: number
        delivery?: "push" | "pull"
      },
    ) {
      const { delivery, role, ...rest } = params
      const req: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: `register-${connId}`,
        method: "register",
        params: {
          role: role ?? "member",
          projectName: "km-wt9",
          projectId: "test-project",
          delivery: delivery ?? "pull",
          protocolVersion: TRIBE_PROTOCOL_VERSION,
          ...rest,
        },
      }
      return daemon.dispatcher.handleRequest(req, connId)
    },
    sendActionable(
      recipient: string,
      content: string = "wake inbox wait",
      options: { sender?: string; topic?: string; type?: string } = {},
    ) {
      sendMessage(
        daemonCtx,
        recipient,
        content,
        options.type ?? "request",
        undefined,
        undefined,
        "direct",
        options.topic ? { topic: options.topic } : {},
        {},
        options.sender ? { sender: options.sender } : {},
      )
    },
    connectClient(): { connId: string; socket: TestSocket } {
      const socket = createTestSocket()
      daemon.dispatcher.handleConnection(socket)
      const connId = socketToClient.get(socket)
      if (!connId) throw new Error("dispatcher did not register the connected socket")
      return { connId, socket }
    },
    sessionAnnouncements(name: string): string[] {
      const rows = db
        .prepare("SELECT content FROM messages WHERE type = 'session' ORDER BY ts ASC, id ASC")
        .all() as Array<{ content: string }>
      return rows.map((row) => row.content).filter((content) => content.includes(name))
    },
    sessionCount(name: string): number {
      const row = db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE name = ?").get(name) as { count: number }
      return row.count
    },
    sessionJoinEvents(name: string): Array<{ name: string }> {
      const rows = db
        .prepare("SELECT content FROM messages WHERE type = 'event.session.joined' ORDER BY ts ASC, id ASC")
        .all() as Array<{ content: string }>
      return rows.map((row) => JSON.parse(row.content) as { name: string }).filter((event) => event.name === name)
    },
    sessionLeftEvents(name: string): Array<{ name: string }> {
      const rows = db
        .prepare("SELECT content FROM messages WHERE type = 'event.session.left' ORDER BY ts ASC, id ASC")
        .all() as Array<{ content: string }>
      return rows.map((row) => JSON.parse(row.content) as { name: string }).filter((event) => event.name === name)
    },
    sessionAttachedEvents(name: string): Array<{ name: string }> {
      const rows = db
        .prepare("SELECT content FROM messages WHERE type = 'event.session.attached' ORDER BY ts ASC, id ASC")
        .all() as Array<{ content: string }>
      return rows.map((row) => JSON.parse(row.content) as { name: string }).filter((event) => event.name === name)
    },
    sessionDetachedEvents(name: string): Array<{ name: string; epoch?: number }> {
      const rows = db
        .prepare("SELECT content FROM messages WHERE type = 'event.session.detached' ORDER BY ts ASC, id ASC")
        .all() as Array<{ content: string }>
      return rows
        .map((row) => JSON.parse(row.content) as { name: string; epoch?: number })
        .filter((event) => event.name === name)
    },
    sessionAttachDeniedEvents(name: string): Array<{ name: string; reason: string }> {
      const rows = db
        .prepare("SELECT content FROM messages WHERE type = 'event.session.attach_denied' ORDER BY ts ASC, id ASC")
        .all() as Array<{ content: string }>
      return rows
        .map((row) => JSON.parse(row.content) as { name: string; reason: string })
        .filter((event) => event.name === name)
    },
    /** White-box access for stale-close / epoch-fence / cursor regressions. */
    clients,
    socketToClient,
    db,
    stmts,
    /** Per-session ordinary-inbox pull cursor (last_inbox_pull_seq). */
    inboxCursor(sessionId: string): number {
      const row = stmts.getInboxCursor.get({ $id: sessionId }) as { last_inbox_pull_seq: number } | undefined
      return row?.last_inbox_pull_seq ?? -1
    },
    /** Ordinary (non-actionable) inbox rows deliverable to a name past `since`. */
    inboxRowContents(name: string, since: number): string[] {
      const rows = stmts.getInboxRows.all({ $name: name, $since: since, $limit: 100 }) as Array<{ content: string }>
      return rows.map((r) => r.content)
    },
    /** Open ball count for a recipient (name-keyed pending_request rows). */
    pendingBallCount(recipient: string): number {
      const rows = stmts.selectPendingForRecipient.all({ $recipient: recipient }) as unknown[]
      return rows.length
    },
    /** A stable, timestamp-free snapshot of a member's durable identity, mailbox
     *  CURSOR, mailbox CONTENTS, and pending balls — for the hostile-leave
     *  byte-identical assertion (deep-equal before/after). */
    fullSessionState(name: string) {
      return {
        row:
          db
            .prepare(
              "SELECT id, name, role, pid, identity_token, launch_id, launch_parent_pid, last_inbox_pull_seq, last_delivered_seq, connection_epoch FROM sessions WHERE name = ?",
            )
            .get(name) ?? null,
        cursor:
          db.prepare("SELECT recipient, last_actionable_seq FROM mailbox_cursors WHERE recipient = ?").get(name) ??
          null,
        balls: db
          .prepare(
            "SELECT request_id, recipient, sender, message_id, fanout FROM pending_request WHERE recipient = ? ORDER BY request_id",
          )
          .all(name),
        // Actual mailbox CONTENTS (the durable direct actionables addressed to
        // this member), not just a count — proves the leave neither dropped nor
        // acknowledged any mail.
        mailbox: db
          .prepare(
            "SELECT rowid, id, sender, type, content FROM messages WHERE recipient = ? AND kind = 'direct' AND type IN ('request','query','verdict','assign') ORDER BY rowid",
          )
          .all(name),
      }
    },
    sendDirect(recipient: string, content: string, type = "notify") {
      sendMessage(daemonCtx, recipient, content, type, undefined, undefined, "direct")
    },
    /** Count of durable `sessions` rows currently holding this exact name. */
    memberRowCount(name: string): number {
      return (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE name = $name").get({ $name: name }) as { n: number })
        .n
    },
    addPendingClient(connId: string): TestSocket {
      const socket = createTestSocket()
      clients.set(connId, {
        socket,
        id: connId,
        name: `pending-${connId}`,
        role: "pending",
        domains: [],
        project: "/tmp/km-wt9",
        projectName: "km-wt9",
        projectId: "test-project",
        pid: 0,
        launchId: null,
        launchParentPid: null,
        claudeSessionId: null,
        peerSocket: null,
        conn: "test",
        ctx: daemonCtx,
        registeredAt: Date.now(),
        lastActivityAt: Date.now(),
        recall: { sessionId: null, claudePid: null },
      })
      socketToClient.set(socket, connId)
      return socket
    },
    addTransport(connId: string, canonicalConnId: string, pid: number): TestSocket {
      const canonical = clients.get(canonicalConnId)
      if (!canonical) throw new Error(`canonical client ${canonicalConnId} not found`)
      const socket = createTestSocket()
      clients.set(connId, {
        ...canonical,
        socket,
        id: connId,
        pid,
        registeredAt: canonical.registeredAt + 1,
        lastActivityAt: canonical.lastActivityAt + 1,
      })
      socketToClient.set(socket, connId)
      return socket
    },
    async dispose() {
      await scope[Symbol.asyncDispose]()
    },
  }
}

function parseResult<T>(line: string): T {
  const response = JSON.parse(line) as JsonRpcResponse<T>
  expect(response.error).toBeUndefined()
  expect(response.result).toBeDefined()
  return response.result as T
}

async function registerMember(
  harness: ReturnType<typeof createDispatcherHarness>,
  connId: string,
  name: string,
): Promise<RegisterResult> {
  return parseResult<RegisterResult>(
    await harness.register(connId, {
      name,
      pid: liveHolderPid,
      project: "/tmp/km-wt6",
    }),
  )
}

function parseError(line: string): { code: number; message: string } {
  const response = JSON.parse(line) as JsonRpcResponse<unknown>
  expect(response.result).toBeUndefined()
  expect(response.error).toBeDefined()
  return response.error!
}

function createTestSocket(): TestSocket {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  const socket = {
    destroyedByDispatcher: false,
    writes: [] as string[],
    write(payload: string | Uint8Array) {
      this.writes.push(String(payload))
      return true
    },
    destroy() {
      this.destroyedByDispatcher = true
      return this
    },
    end() {
      return this
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      const eventHandlers = handlers.get(event) ?? []
      eventHandlers.push(handler)
      handlers.set(event, eventHandlers)
      return this
    },
    once(event: string, handler: (...args: unknown[]) => void) {
      const wrapped = (...args: unknown[]) => {
        handlers.set(
          event,
          (handlers.get(event) ?? []).filter((candidate) => candidate !== wrapped),
        )
        handler(...args)
      }
      const eventHandlers = handlers.get(event) ?? []
      eventHandlers.push(wrapped)
      handlers.set(event, eventHandlers)
      return this
    },
    emitClose() {
      for (const handler of handlers.get("close") ?? []) handler()
    },
  }
  return socket as unknown as TestSocket
}

function createFakeServer(): Server {
  const server = {
    on() {
      return server
    },
    removeListener() {
      return server
    },
  }
  return server as unknown as Server
}
