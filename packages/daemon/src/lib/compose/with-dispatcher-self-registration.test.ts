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

type InboxWaitResult = {
  session: string
  unread_count: number
  waited_ms: number
  timed_out: boolean
  aborted: boolean
  attention: {
    actionable_unread: Array<{ content: string; type: string }>
    pending_balls: Array<{ request_id: string; recipient: string }>
  }
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
  it("persists a startup notification filter before the session becomes connected", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    harness.addPendingClient("conn-fleet")

    await harness.register("conn-fleet", {
      name: "@fleet",
      pid: liveHolderPid,
      project: "/tmp/km",
      filterMode: "focus",
    })

    expect(harness.sessionFilter("@fleet")).toEqual({ mode: "focus", until: null, mute: null })
  })

  it("preserves or overrides the stored notification filter when another transport fans in", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    harness.addPendingClient("conn-fleet-primary")

    const primary = parseResult<RegisterResult>(
      await harness.register("conn-fleet-primary", {
        name: "@fleet",
        pid: liveHolderPid,
        project: "/tmp/km",
        launchId: "fleet-filter-launch",
        launchParentPid: process.pid,
      }),
    )
    const staleFilter = {
      mode: "focus",
      until: Date.now() + 60_000,
      mute: JSON.stringify(["github:*"]),
    }
    harness.setSessionFilter("@fleet", staleFilter)

    harness.addPendingClient("conn-fleet-secondary")
    const secondary = parseResult<RegisterResult>(
      await harness.register("conn-fleet-secondary", {
        name: "@fleet",
        pid: otherLivePid,
        project: "/tmp/km",
        launchId: "fleet-filter-launch",
        launchParentPid: process.pid,
      }),
    )

    expect(secondary.sessionId).toBe(primary.sessionId)
    expect(harness.sessionFilter("@fleet")).toEqual(staleFilter)

    harness.addPendingClient("conn-fleet-override")
    const overridden = parseResult<RegisterResult>(
      await harness.register("conn-fleet-override", {
        name: "@fleet",
        pid: otherLivePid,
        project: "/tmp/km",
        launchId: "fleet-filter-launch",
        launchParentPid: process.pid,
        filterMode: "normal",
      }),
    )

    expect(overridden.sessionId).toBe(primary.sessionId)
    expect(harness.sessionFilter("@fleet")).toEqual({ mode: "normal", until: null, mute: null })

    harness.addPendingClient("conn-fleet-invalid")
    const invalid = parseError(
      await harness.register("conn-fleet-invalid", {
        name: "@fleet",
        pid: otherLivePid,
        project: "/tmp/km",
        launchId: "fleet-filter-launch",
        launchParentPid: process.pid,
        filterMode: "everything",
      }),
    )
    expect(invalid).toMatchObject({ code: -32602, message: expect.stringContaining("focus|normal|ambient") })
    expect(harness.sessionFilter("@fleet")).toEqual({ mode: "normal", until: null, mute: null })
  })

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

  it("rejects a registered client with an incompatible wire protocol before creating session state", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    harness.addPendingClient("conn-skew")

    const error = parseError(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "register-skew",
          method: "register",
          params: {
            name: "@agent/skew",
            role: "member",
            pid: liveHolderPid,
            project: "/tmp/km-wt9",
            projectName: "km-wt9",
            projectId: "test-project",
            delivery: "pull",
            protocolVersion: TRIBE_PROTOCOL_VERSION - 1,
          },
        },
        "conn-skew",
      ),
    )

    expect(error.message).toMatch(/protocol version mismatch/i)
    expect(harness.sessionCount("@agent/skew")).toBe(0)
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

describe("dispatcher bounded mailbox drain", () => {
  it("validates daemon-derived launch targets and fails closed on conflicting authorities", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    for (const [label, params, code] of [
      ["missing launch id", {}, -32602],
      ["empty launch id", { launch_id: "" }, -32602],
      ["session override", { launch_id: "managed-launch", session: "@chief" }, -32602],
      ["caller parent override", { launch_id: "managed-launch", launch_parent_pid: process.pid }, -32602],
      ["unknown launch", { launch_id: "missing-launch" }, -32003],
    ] as const) {
      const error = parseError(
        await harness.dispatcher.handleRequest(
          { jsonrpc: "2.0", id: `invalid-${label}`, method: "cli_inbox_status_by_launch_v1", params },
          "conn-status",
        ),
      )
      expect(error.code, label).toBe(code)
    }

    for (const [connId, name, pid, project, launchParentPid] of [
      ["conn-outer", "@agent/outer", process.pid, "/tmp/km-outer", process.pid],
      ["conn-inner", "@agent/inner", process.ppid, "/tmp/km-inner", process.ppid],
    ] as const) {
      harness.addPendingClient(connId)
      await harness.register(connId, {
        name,
        pid,
        project,
        launchId: "shared-inherited-launch",
        launchParentPid,
      })
    }

    const ambiguous = parseError(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "ambiguous-launch-inbox",
          method: "cli_inbox_status_by_launch_v1",
          params: { launch_id: "shared-inherited-launch" },
        },
        "conn-status",
      ),
    )

    expect(ambiguous.code).toBe(-32003)
    expect(ambiguous.message).toMatch(/resolved to 2 sessions|ambiguous/i)
  })

  it("resolves a launch to its sole routable session when connected tombstones share the launch id", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    const launchId = "retained-dead-launch"

    for (const index of [1, 2, 3]) {
      const { connId } = harness.connectClient()
      await harness.register(connId, {
        name: `@chief-dead-${String(index).padStart(8, "0")}`,
        pid: liveHolderPid + index,
        project: "/tmp/hh",
        launchId,
        launchParentPid: process.pid,
      })
    }

    const { connId: liveConnId } = harness.connectClient()
    await harness.register(liveConnId, {
      name: "@chief",
      pid: liveHolderPid,
      project: "/tmp/hh",
      launchId,
      launchParentPid: process.pid,
    })

    const status = parseResult<{ session: string; unread_count: number }>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "retained-dead-launch-inbox",
          method: "cli_inbox_status_by_launch_v1",
          params: { launch_id: launchId },
        },
        "conn-status",
      ),
    )

    expect(status).toMatchObject({ session: "@chief", unread_count: 0 })
  })

  it("keeps legal names containing the tombstone marker routable", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    const launchId = "legal-dead-marker-launch"
    const name = "@agent/foo-dead-letter"
    const { connId } = harness.connectClient()
    await harness.register(connId, {
      name,
      pid: liveHolderPid,
      project: "/tmp/hh",
      launchId,
      launchParentPid: process.pid,
    })

    const status = parseResult<{ session: string }>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "legal-dead-marker-inbox",
          method: "cli_inbox_status_by_launch_v1",
          params: { launch_id: launchId },
        },
        "conn-status",
      ),
    )

    expect(status.session).toBe(name)
  })

  it("advances the durable role cursor without creating a transient registration", async () => {
    const harness = createDispatcherHarness({ operatorCapability: "operator-test-secret" })
    cleanup = harness.dispose

    harness.sendActionable("@chief", "first historical request")
    harness.sendActionable("@chief", "second historical request")
    harness.sendActionable("@chief", "third historical request")

    const first = parseResult<InboxDrainResult>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "drain-1",
          method: "cli_inbox_drain",
          params: { session: "@chief", limit: 2, operator_capability: "operator-test-secret" },
        },
        "conn-drain",
      ),
    )
    expect(first.events.map((event) => event.content)).toEqual([
      "first historical request",
      "second historical request",
    ])
    expect(first.drained_count).toBe(2)
    expect(first.unread_count).toBe(1)

    const second = parseResult<InboxDrainResult>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "drain-2",
          method: "cli_inbox_drain",
          params: { session: "@chief", limit: 2, operator_capability: "operator-test-secret" },
        },
        "conn-drain",
      ),
    )
    expect(second.events.map((event) => event.content)).toEqual(["third historical request"])
    expect(second.unread_count).toBe(0)

    const wait = parseResult<InboxWaitResult>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "wait-after-drain",
          method: "cli_inbox_wait",
          params: { session: "@chief", timeout_ms: 1 },
        },
        "conn-drain",
      ),
    )
    expect(wait.timed_out).toBe(true)
    expect(wait.unread_count).toBe(0)
    expect(wait.attention.actionable_unread).toEqual([])
    expect(wait.attention.pending_balls).toHaveLength(3)
    expect(harness.sessionCount("@chief")).toBe(0)
    expect(harness.sessionAnnouncements("@chief")).toEqual([])
  })

  it("denies a registered role that tries to acknowledge another role's mailbox", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    harness.addPendingClient("conn-agent-7")
    await harness.register("conn-agent-7", {
      name: "@agent/7",
      pid: liveHolderPid,
      project: "/tmp/km-wt7",
    })
    harness.sendActionable("@chief", "chief-only request")
    harness.sendActionable("@agent/7", "agent-owned request")

    const denied = parseError(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "cross-role-drain",
          method: "cli_inbox_drain",
          params: { session: "@chief", limit: 10 },
        },
        "conn-agent-7",
      ),
    )
    expect(denied.message).toMatch(/bound to the authenticated current session.*session override/i)

    const selfAsserted = parseError(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "self-asserted-drain",
          method: "cli_inbox_drain",
          params: { session: "@agent/7", limit: 10 },
        },
        "conn-agent-7",
      ),
    )
    expect(selfAsserted.message).toMatch(/bound to the authenticated current session.*session override/i)

    const own = parseResult<InboxDrainResult>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "own-role-drain",
          method: "cli_inbox_drain",
          params: { limit: 10 },
        },
        "conn-agent-7",
      ),
    )
    expect(own.events.map((event) => event.content)).toEqual(["agent-owned request"])
    const chiefStatus = parseResult<{ unread_count: number }>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "chief-status",
          method: "cli_inbox_status",
          params: { session: "@chief" },
        },
        "conn-agent-7",
      ),
    )
    expect(chiefStatus.unread_count).toBe(1)
  })

  it("fails closed for an unregistered caller without the configured operator capability", async () => {
    const harness = createDispatcherHarness({ operatorCapability: "operator-test-secret" })
    cleanup = harness.dispose
    harness.sendActionable("@chief", "must remain unread")

    const denied = parseError(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "untrusted-drain",
          method: "cli_inbox_drain",
          params: { session: "@chief", limit: 10, operator_capability: "wrong-secret" },
        },
        "conn-untrusted",
      ),
    )
    expect(denied.message).toMatch(/authenticated current session or the configured operator capability/i)

    const status = parseResult<{ unread_count: number }>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "chief-status-after-denial",
          method: "cli_inbox_status",
          params: { session: "@chief" },
        },
        "conn-untrusted",
      ),
    )
    expect(status.unread_count).toBe(1)
  })
})

describe("dispatcher durable log projection", () => {
  it("filters correlation refs and reply ids by literal prefix without deriving controller policy", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose
    harness.sendWithRef("ball-controller:v1:owner-epoch:@agent/6:launch-1")
    harness.sendWithRef("ball-controller:v1:answer-sla:req-2")
    harness.sendWithRef("another-controller:v1:owner-epoch:@agent/7:launch-2")
    harness.sendReply("ball-rescue:v1:%40agent%2F6:launch-1")
    harness.sendReply("another-controller:v1:request-2")

    const result = parseResult<{
      messages: Array<{ ref: string | null; reply: string | null }>
      query: { all: boolean; ref_prefix: string | null; reply_prefix: string | null }
    }>(
      await harness.dispatcher.handleRequest(
        {
          jsonrpc: "2.0",
          id: "controller-journal",
          method: "cli_log",
          params: { all: true, ref_prefix: "ball-controller:v1:", reply_prefix: "ball-rescue:v1:" },
        },
        "conn-log",
      ),
    )

    expect(result.messages.map(({ ref, reply }) => ({ ref, reply }))).toEqual([
      { ref: "ball-controller:v1:owner-epoch:@agent/6:launch-1", reply: null },
      { ref: "ball-controller:v1:answer-sla:req-2", reply: null },
      { ref: null, reply: "ball-rescue:v1:%40agent%2F6:launch-1" },
    ])
    expect(result.query).toEqual({
      all: true,
      ref_prefix: "ball-controller:v1:",
      reply_prefix: "ball-rescue:v1:",
    })
  })
})

describe("dispatcher session announcement recovery (@ag/tribe/21052/19442)", () => {
  it("coalesces a reconnecting name without losing durable join events", async () => {
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
      // churn rather than startup suppression. Every suppressed attempt must
      // re-arm the per-name window, while another name remains independent.
      const first = harness.connectClient()
      await registerMember(harness, first.connId, "@agent/6")
      now += 5_000
      first.socket.emitClose()

      now += 5_000
      const second = harness.connectClient()
      await registerMember(harness, second.connId, "@agent/6")
      now += 5_000
      second.socket.emitClose()

      // The boundary itself is outside the window; callers must not need an
      // undocumented extra millisecond before the next stable announcement.
      now += 10_000
      const stable = harness.connectClient()
      await registerMember(harness, stable.connId, "@agent/6")
      const independent = harness.connectClient()
      await registerMember(harness, independent.connId, "@agent/7")

      const announcements = harness.sessionAnnouncements("@agent/6")
      expect(announcements).toHaveLength(2)
      expect(announcements.every((content) => content.includes("@agent/6 joined (member)"))).toBe(true)
      expect(harness.sessionAnnouncements("@agent/7")).toHaveLength(1)
      expect(harness.sessionJoinEvents("@agent/6")).toHaveLength(3)
      expect(harness.sessionJoinEvents("@agent/7")).toHaveLength(1)
      expect(harness.sessionLeftEvents("@agent/6")).toHaveLength(2)
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
      expect(harness.sessionLeftEvents("@agent/6")).toHaveLength(1)
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
    expect(result.attention.actionable_unread).toEqual([expect.objectContaining({ content: "wake inbox wait" })])
    expect(result.attention.pending_balls).toEqual([expect.objectContaining({ recipient: "@agent/wait" })])
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
    expect(result.attention).toEqual({
      actionable_unread: [],
      pending_balls: [],
      pending_balls_summary: { total: 0, oldest_age_ms: 0 },
    })
  })

  it("records an inbox-wait attention receipt for the authenticated caller, never an explicit target", async () => {
    const harness = createDispatcherHarness()
    cleanup = harness.dispose

    harness.addPendingClient("conn-reader")
    await harness.register("conn-reader", {
      name: "@agent/reader",
      pid: liveHolderPid,
      project: "/tmp/km-wt-reader",
    })

    const receiptAt = Date.now() + 5_000
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(receiptAt)
    try {
      const result = parseResult<InboxWaitResult>(
        await harness.dispatcher.handleRequest(
          {
            jsonrpc: "2.0",
            id: "wait-explicit-target",
            method: "tribe.inbox.wait",
            params: { session: "@agent/other", timeoutMs: 0 },
          },
          "conn-reader",
        ),
      )
      expect(result.timed_out).toBe(true)
      expect(harness.mailboxAttentionReadAt("@agent/reader")).toBe(receiptAt)
      expect(harness.mailboxAttentionReadAt("@agent/other")).toBeNull()
    } finally {
      nowSpy.mockRestore()
    }
  })
})

function createDispatcherHarness(
  options: { suppressWindowMs?: number; socketStartedAt?: number; operatorCapability?: string } = {},
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
      operatorCapability: options.operatorCapability ?? null,
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
  const daemon = withDispatcher({ suppressWindowMs: options.suppressWindowMs ?? Number.MAX_SAFE_INTEGER })(shape)

  return {
    dispatcher: daemon.dispatcher,
    register(
      connId: string,
      params: {
        name: string
        pid: number
        project: string
        launchId?: string
        launchParentPid?: number
        filterMode?: string
      },
    ) {
      const req: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: `register-${connId}`,
        method: "register",
        params: {
          ...params,
          role: "member",
          projectName: "km-wt9",
          projectId: "test-project",
          delivery: "pull",
          protocolVersion: TRIBE_PROTOCOL_VERSION,
        },
      }
      return daemon.dispatcher.handleRequest(req, connId)
    },
    sendActionable(recipient: string, content: string = "wake inbox wait") {
      sendMessage(daemonCtx, recipient, content, "request", undefined, undefined, "direct")
    },
    sendWithRef(ref: string) {
      sendMessage(daemonCtx, "@fleet", `effect ${ref}`, "notify", undefined, ref, "direct")
    },
    sendReply(reply: string) {
      sendMessage(daemonCtx, "@controller", `reply ${reply}`, "verdict", undefined, undefined, "direct", {}, { reply })
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
    mailboxAttentionReadAt(name: string): number | null {
      const row = db
        .prepare("SELECT last_attention_read_at FROM mailbox_cursors WHERE recipient = ?")
        .get(name) as { last_attention_read_at: number | null } | null
      return row?.last_attention_read_at ?? null
    },
    sessionFilter(name: string): { mode: string; until: number | null; mute: string | null } | undefined {
      const row = db
        .prepare("SELECT filter_mode, filter_until, filter_mute FROM sessions WHERE name = ?")
        .get(name) as { filter_mode: string; filter_until: number | null; filter_mute: string | null } | null
      return row ? { mode: row.filter_mode, until: row.filter_until, mute: row.filter_mute } : undefined
    },
    setSessionFilter(name: string, filter: { mode: string; until: number | null; mute: string | null }): void {
      db.prepare(
        "UPDATE sessions SET filter_mode = $mode, filter_until = $until, filter_mute = $mute WHERE name = $name",
      ).run({ $name: name, $mode: filter.mode, $until: filter.until, $mute: filter.mute })
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
