/**
 * @failure A daemon warn storm persists one health row per log line and injects fully redacted noise into agent context.
 * @level L2
 * @consumer Tribe operators and every connected agent seat
 * retire-when: daemon logs can no longer enter the durable message journal except through typed, bounded health events.
 */

import { afterEach, describe, expect, test, vi } from "vitest"
import { createLogger, getLogLevel, setLogLevel, setSuppressConsole } from "loggily"
import { defangModelInput } from "tribe-injection-envelope"
import type { MessageInsertedInfo } from "../context.ts"
import { withBroadcast } from "./with-broadcast.ts"
import { withHotReload } from "./with-hot-reload.ts"

type InsertedRow = Record<string, unknown>

function createHarness() {
  const inserted: InsertedRow[] = []
  const deferred: Array<() => void> = []
  let rowid = 0
  const stmts = {
    insertMessage: {
      run(row: InsertedRow) {
        inserted.push(row)
        return { lastInsertRowid: ++rowid }
      },
    },
    // The daemon's own context has no session row, so its rows carry no sender authority (25074 3d-1a).
    selectSessionAuthority: { get: () => null },
  }
  const db = {
    transaction<T>(fn: () => T): () => T {
      return fn
    },
  }
  const daemonCtx = {
    db,
    stmts,
    sessionId: "daemon-test",
    sessionRole: "daemon",
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
    getName: () => "daemon",
    setName: () => {},
    getRole: () => "daemon",
    setRole: () => {},
    onMessageInserted: undefined,
  }
  const tribe = withBroadcast()({
    scope: {
      defer(fn: () => void) {
        deferred.push(fn)
      },
    },
    daemonSessionId: "daemon-test",
    startedAt: 0,
    daemonVersion: "test",
    daemonPid: 1,
    db,
    stmts,
    daemonCtx,
    registry: { clients: new Map() },
  } as never)

  return {
    broadcast: tribe.broadcast,
    inserted,
    tribe,
    dispose() {
      for (const fn of deferred.reverse()) fn()
    },
  }
}

afterEach(() => {
  setSuppressConsole(false)
  vi.useRealTimers()
})

describe("22514 daemon health-log broadcast admission", () => {
  test("does not re-broadcast the daemon's own warn writer into the durable journal", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-29T05:20:34Z"))
    const harness = createHarness()
    const previousLogLevel = getLogLevel()
    setLogLevel("warn")
    setSuppressConsole(true)
    try {
      expect(
        defangModelInput('22:20:34 WARN tribe:dispatcher takeover: superseding live holder of "@worker"'),
        "the actual formatted specimen is fully redacted at the model-input boundary",
      ).toBe("[log-redacted]")

      const log = createLogger("tribe:dispatcher")
      log.warn?.(
        'takeover: superseding live holder of "@worker" ' + "(old pid 95053, old session session-1, new pid 94345)",
      )

      expect(harness.inserted, "local daemon logs must never re-enter Tribe as health messages").toHaveLength(0)
    } finally {
      setLogLevel(previousLogLevel)
      harness.dispose()
    }
  })

  test("coalesces a volatile repeat storm before persistence", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-29T05:20:34Z"))
    const harness = createHarness()
    try {
      for (let i = 0; i < 50; i++) {
        harness.broadcast.log(
          `22:20:34 WARN tribe:dispatcher takeover: superseding live holder of "@worker" ` +
            `(old pid 95053, old session session-${i}, new pid 94345)`,
          "health:daemon:warn",
        )
      }

      expect(harness.inserted, "repeat variants should share one immediate fingerprint").toHaveLength(1)

      await vi.advanceTimersByTimeAsync(60_000)

      expect(harness.inserted, "the whole minute must stay inside the durable row budget").toHaveLength(2)
      expect(harness.inserted[1]?.$content).toContain("×49 in 60s")
      expect(harness.inserted.every((row) => row.$delivery === "pull")).toBe(true)
      expect(harness.inserted.every((row) => row.$topic === "health:daemon:warn")).toBe(true)

      harness.inserted.length = 0
      for (let i = 0; i < 50; i++) {
        const type = i === 49 ? "health:daemon:error" : "health:daemon:warn"
        harness.broadcast.log(`tribe:subsystem-${i}: distinct failure ${i}`, type)
      }

      expect(harness.inserted, "five immediate slots leave one durable slot for the summary").toHaveLength(5)

      await vi.advanceTimersByTimeAsync(60_000)

      expect(harness.inserted, "a distinct storm must also stay inside the total row budget").toHaveLength(6)
      expect(harness.inserted[5]?.$content).toContain("×45 in 60s")
      expect(harness.inserted[5]?.$content).toContain("25 additional log(s) beyond signature cap")
      expect(harness.inserted[5]?.$topic, "a suppressed error must escalate the coalesced summary").toBe(
        "health:daemon:error",
      )
    } finally {
      harness.dispose()
    }
  })

  test("drops useless redacted bodies and persists a model-safe structured body", () => {
    vi.useFakeTimers()
    const redactedHarness = createHarness()
    try {
      redactedHarness.broadcast.log("[log-redacted]", "health:daemon:warn")
      expect(redactedHarness.inserted).toHaveLength(0)
      redactedHarness.dispose()
      expect(redactedHarness.inserted).toHaveLength(1)
      expect(redactedHarness.inserted[0]?.$content).toContain("fully-redacted or empty body")
      expect(redactedHarness.inserted[0]?.$content).not.toContain("[log-redacted]")
    } finally {
      redactedHarness.dispose()
    }

    const safeHarness = createHarness()
    try {
      safeHarness.broadcast.log("22:20:34 ERROR tribe:dispatcher database unavailable (code 5)", "health:daemon:error")

      expect(safeHarness.inserted).toHaveLength(1)
      expect(safeHarness.inserted[0]?.$content).toBe("tribe:dispatcher: database unavailable (code 5)")
      expect(defangModelInput(String(safeHarness.inserted[0]?.$content))).not.toContain("[log-redacted]")
      expect(safeHarness.inserted[0]?.$topic).toBe("health:daemon:error")
    } finally {
      safeHarness.dispose()
    }
  })

  test("persists a real hot-reload owner failure through the bounded health gate", () => {
    const harness = createHarness()
    try {
      const subject = withHotReload({
        stopPlugins: vi.fn(),
        replaceProcess() {
          throw new Error("owner handoff failed")
        },
        triggerShutdown: vi.fn(),
        disableWatch: true,
      })({
        ...harness.tribe,
        config: { operatorCapability: null },
        socket: {
          handedOff: false,
          server: { close: vi.fn() },
          socketPath: "/must-not-unlink-health-integration.sock",
        },
      } as never)

      expect(() => subject.hotReload.reload()).toThrow("owner handoff failed")
      expect(harness.inserted).toContainEqual(
        expect.objectContaining({
          $content: "tribe:hot-reload: Hot-reload lifecycle owner replacement failed: owner handoff failed",
          $delivery: "pull",
          $topic: "health:daemon:error",
          $type: "health:daemon:error",
        }),
      )
    } finally {
      harness.dispose()
    }
  })
})

describe("G9 self-inbox P0: a focus seat is woken by the reply that settles its own request", () => {
  function focusSeatFanout() {
    const writes: string[] = []
    const deferred: Array<() => void> = []
    const daemonCtx: { onMessageInserted?: (info: MessageInsertedInfo) => void } = {}
    const seat = {
      name: "@seat",
      role: "member",
      ctx: { sessionId: "seat" },
      socket: { write: (m: string) => writes.push(m) },
    }
    withBroadcast()({
      scope: { defer: (fn: () => void) => deferred.push(fn) },
      stmts: {
        getSessionDeliveryById: { get: () => ({ delivery: "push" }) },
        getSessionFilter: { get: () => ({ filter_mode: "focus", filter_until: null, filter_mute: null }) },
        updateLastDelivered: { run: () => {} },
      },
      daemonCtx,
      registry: { clients: new Map([["conn-seat", seat]]) },
    } as never)
    const reply = (correlatedReply: MessageInsertedInfo["correlatedReply"]): MessageInsertedInfo => ({
      id: "reply",
      ts: 1,
      rowid: 1,
      type: "response",
      kind: "direct",
      sender: "@chief",
      senderRole: "member",
      recipient: "@seat",
      content: "ruled",
      bead_id: null,
      delivery: "push",
      topic: null,
      roomId: null,
      correlatedReply,
    })
    return { writes, reply, tap: daemonCtx.onMessageInserted!, dispose: () => deferred.reverse().forEach((fn) => fn()) }
  }

  test("wakes for its own settlement, and still not for a plain reply or one settling another seat's request", async () => {
    const fanout = focusSeatFanout()
    try {
      fanout.tap(fanout.reply(null))
      fanout.tap(fanout.reply({ requestId: "r-other", requester: "@other" }))
      await Promise.resolve()
      expect(fanout.writes).toEqual([])

      fanout.tap(fanout.reply({ requestId: "r-own", requester: "@seat" }))
      await vi.waitFor(() => expect(fanout.writes).toHaveLength(1))
      expect(fanout.writes[0]).toContain('"wakeup"')
    } finally {
      fanout.dispose()
    }
  })
})
