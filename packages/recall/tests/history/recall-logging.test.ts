/**
 * Recall logging routes through loggily and is off by default outside the daemon.
 *
 * @failure  Recall debug logs leak to stderr on every hook execution outside the daemon (bead 25392).
 * @level    l0 — pure in-memory test of recall logging configuration and loggily writer routing.
 * @consumer Claude Code prompt hook and recall Worker stderr silence.
 * @testonly none
 */

import { describe, expect, test, vi, afterEach, beforeEach } from "vitest"
import { addWriter, setSuppressConsole, type LogEvent } from "loggily"
import { log, logFailure, setRecallLogging } from "../../src/history/recall-shared.ts"

describe("25392: recall log goes through loggily and is off by default outside the daemon", () => {
  beforeEach(() => {
    setSuppressConsole(true)
  })

  afterEach(() => {
    setSuppressConsole(false)
    setRecallLogging(false)
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  test("recall logging is off by default outside the daemon", () => {
    const events: LogEvent[] = []
    const unsub = addWriter({ ns: "recall:*" }, (_f, _l, _ns, ev) => {
      if (ev.kind === "log") events.push(ev)
    })
    try {
      log("default is silent")
      expect(events).toHaveLength(0)
    } finally {
      unsub()
    }
  })

  test("logFailure() reports at error level even when logging is off", () => {
    const events: LogEvent[] = []
    const unsub = addWriter({ ns: "recall:*" }, (_f, _l, _ns, ev) => {
      if (ev.kind === "log") events.push(ev)
    })
    try {
      setRecallLogging(false)
      logFailure("planner: m failed (x)")
      expect(events.map((ev) => [ev.level, ev.message])).toEqual([["error", "planner: m failed (x)"]])
    } finally {
      unsub()
    }
  })

  test("log() does not emit when logging is off", () => {
    const events: LogEvent[] = []
    const unsub = addWriter({ ns: "recall:*" }, (_f, _l, _ns, ev) => {
      if (ev.kind === "log") events.push(ev)
    })
    try {
      setRecallLogging(false)
      log("this should not emit")
      expect(events).toHaveLength(0)
    } finally {
      unsub()
    }
  })

  test("log() routes through a loggily logger under namespace recall when enabled", () => {
    const events: LogEvent[] = []
    const unsub = addWriter({ ns: "recall:*" }, (_f, _l, _ns, ev) => {
      if (ev.kind === "log") events.push(ev)
    })
    try {
      // The root vitest setup pins LOG_LEVEL=warn; this row is about routing at info, so it names its level.
      vi.stubEnv("LOG_LEVEL", "info")
      setRecallLogging(true)
      log("test message across loggily")
      expect(events).toHaveLength(1)
      const ev = events[0]!
      expect(ev.message).toBe("test message across loggily")
      expect(ev.namespace).toBe("recall")
      expect(ev.level).toBe("info")
    } finally {
      unsub()
    }
  })
})
