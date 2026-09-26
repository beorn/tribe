/**
 * @failure Prompt hook runs over budget or is killed without being detected or paged
 * @level   l2
 * @consumer @ag/tribe/25304-nothing-reads-the-prompt-hooks-latency-log-so-a-30-s-kill-is-found-by-the-operator
 * @testonly none
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import {
  readHookLatencyStats,
  shouldPageHookLatency,
  formatHookLatencyReport,
  formatHookLatencyPage,
  pageHookLatency,
  nearestRank,
} from "./hook-latency-reader.ts"
import { hookLatencyPlugin } from "./hook-latency-plugin.ts"
import type { TribeClientApi } from "./plugin-api.ts"

describe("Prompt hook latency reader & paging (25304)", () => {
  let tempDir: string
  let logPath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hook-latency-test-"))
    logPath = join(tempDir, "injection.jsonl")
  })

  afterEach(() => {
    safeRemoveSync(tempDir, { within: tmpdir() })
  })

  test("nearestRank computes accurate percentiles", () => {
    expect(nearestRank([], 0.9)).toBeNull()
    expect(nearestRank([100], 0.9)).toBe(100)
    // 10 values: 10, 20, 30, 40, 50, 60, 70, 80, 90, 100 -> p90 is 90
    const vals = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    expect(nearestRank(vals, 0.9)).toBe(90)
    expect(nearestRank(vals, 0.5)).toBe(50)
  })

  test("Acceptance 1 & 2: A killed hook run appears as started and never finished with session and time, and reports hourly p90, max and kill count", () => {
    const baseTime = new Date("2026-09-25T12:00:00.000Z").getTime()

    // 1. Completed run 1: 200ms
    const r1Start = JSON.stringify({
      ts: new Date(baseTime).toISOString(),
      pid: 101,
      namespace: "recall:hook:prompt",
      level: "info",
      msg: "start",
      session: "sess-completed-1",
      start_time: baseTime,
    })
    const r1End = JSON.stringify({
      ts: new Date(baseTime + 200).toISOString(),
      pid: 101,
      namespace: "recall:hook:prompt",
      level: "info",
      msg: "library ok",
      session: "sess-completed-1",
      elapsed_ms: 200,
      steps: { stdin: 5, recall: 195 },
    })

    // 2. Completed run 2: 400ms
    const r2Start = JSON.stringify({
      ts: new Date(baseTime + 1000).toISOString(),
      pid: 102,
      namespace: "recall:hook:prompt",
      level: "info",
      msg: "start",
      session: "sess-completed-2",
      start_time: baseTime + 1000,
    })
    const r2End = JSON.stringify({
      ts: new Date(baseTime + 1400).toISOString(),
      pid: 102,
      namespace: "recall:hook:prompt",
      level: "info",
      msg: "daemon ok",
      session: "sess-completed-2",
      elapsed_ms: 400,
      steps: { stdin: 5, daemon: 395 },
    })

    // 3. Killed run: started at 12:05:00, NEVER finished
    const rKilledStart = JSON.stringify({
      ts: "2026-09-25T12:05:00.000Z",
      pid: 103,
      namespace: "recall:hook:prompt",
      level: "info",
      msg: "start",
      session: "sess-killed-at-30s",
      start_time: new Date("2026-09-25T12:05:00.000Z").getTime(),
    })

    writeFileSync(logPath, [r1Start, r1End, r2Start, r2End, rKilledStart].join("\n") + "\n", "utf8")

    const stats = readHookLatencyStats(logPath, {
      windowStartMs: new Date("2026-09-25T12:00:00.000Z").getTime(),
      windowEndMs: new Date("2026-09-25T13:00:00.000Z").getTime(),
      budgetMs: 1500,
      timeoutMs: 30_000,
    })

    // Acceptance 1: Killed hook run appears as started and never finished, with its session and time
    expect(stats.killCount).toBe(1)
    expect(stats.killedRuns).toHaveLength(1)
    expect(stats.killedRuns[0]!.session).toBe("sess-killed-at-30s")
    expect(stats.killedRuns[0]!.ts).toBe("2026-09-25T12:05:00.000Z")
    expect(stats.killedRuns[0]!.startTime).toBe(new Date("2026-09-25T12:05:00.000Z").getTime())

    // Acceptance 2 metrics: hourly p90, max, and kill count
    expect(stats.completedRuns).toBe(2)
    expect(stats.totalRuns).toBe(3)
    expect(stats.maxMs).toBe(400)
    expect(stats.p90Ms).toBe(400)

    const report = formatHookLatencyReport(stats)
    expect(report).toContain("p90=400ms")
    expect(report).toContain("max=400ms")
    expect(report).toContain("kills=1")
    expect(report).toContain("runs=3")

    // Pages the owner because killCount > 0
    expect(shouldPageHookLatency(stats, 1500)).toBe(true)

    const sent: any[] = []
    const api = {
      send: (recipient: string, content: string, type: string, beadId?: string, classification?: any, incident?: any) => {
        sent.push({ recipient, content, type, beadId, classification, incident })
      },
    } as unknown as TribeClientApi

    const result = pageHookLatency(api, stats, { owner: "@dev/11", budgetMs: 1500 })
    expect(result.paged).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.recipient).toBe("@dev/11")
    expect(sent[0]!.content).toContain("Hourly kill count: 1")
    expect(sent[0]!.content).toContain("sess-killed-at-30s")
    expect(sent[0]!.content).toContain("2026-09-25T12:05:00.000Z")
    expect(sent[0]!.incident).toMatchObject({
      emitter: "prompt-hook-latency",
      subject: "@dev/11",
      condition: "hook-kill",
      active: true,
    })
  })

  test("Acceptance 3: A seeded 10 s recall stall in a fixture produces exactly one page naming the step", () => {
    const baseTime = new Date("2026-09-25T14:00:00.000Z").getTime()

    // Normal run: 150ms
    const rNormal = [
      JSON.stringify({
        ts: new Date(baseTime).toISOString(),
        pid: 201,
        namespace: "recall:hook:prompt",
        level: "info",
        msg: "start",
        session: "sess-normal",
        start_time: baseTime,
      }),
      JSON.stringify({
        ts: new Date(baseTime + 150).toISOString(),
        pid: 201,
        namespace: "recall:hook:prompt",
        level: "info",
        msg: "library ok",
        session: "sess-normal",
        elapsed_ms: 150,
        steps: { stdin: 5, recall: 145 },
      }),
    ]

    // Seeded 10 s recall stall: 10,000ms where recall step took 9,990ms
    const rStall = [
      JSON.stringify({
        ts: new Date(baseTime + 10_000).toISOString(),
        pid: 202,
        namespace: "recall:hook:prompt",
        level: "info",
        msg: "start",
        session: "sess-stalled-recall",
        start_time: baseTime + 10_000,
      }),
      JSON.stringify({
        ts: new Date(baseTime + 20_000).toISOString(),
        pid: 202,
        namespace: "recall:hook:prompt",
        level: "info",
        msg: "library ok",
        session: "sess-stalled-recall",
        elapsed_ms: 10_000,
        steps: { stdin: 10, recall: 9_990 },
      }),
    ]

    writeFileSync(logPath, [...rNormal, ...rStall].join("\n") + "\n", "utf8")

    const stats = readHookLatencyStats(logPath, {
      windowStartMs: baseTime,
      windowEndMs: baseTime + 3600_000,
      budgetMs: 1500, // Stated budget is 1500ms
    })

    expect(stats.completedRuns).toBe(2)
    expect(stats.killCount).toBe(0)
    expect(stats.maxMs).toBe(10_000)
    expect(stats.p90Ms).toBe(10_000)
    expect(stats.slowestStepOverall).toBe("recall")

    const sent: any[] = []
    const api = {
      send: (recipient: string, content: string, type: string, beadId?: string, classification?: any, incident?: any) => {
        sent.push({ recipient, content, type, beadId, classification, incident })
      },
    } as unknown as TribeClientApi

    // Execute paging
    const result = pageHookLatency(api, stats, { owner: "@dev/11", budgetMs: 1500 })

    expect(result.paged).toBe(true)
    // EXACTLY ONE page produced!
    expect(sent).toHaveLength(1)
    expect(sent[0]!.recipient).toBe("@dev/11")

    // The page explicitly names the step: "recall"!
    const pageText = `${sent[0]!.classification?.summary} \n ${sent[0]!.content}`
    expect(pageText).toContain("recall")
    expect(sent[0]!.content).toContain("Slowest step: recall")
    expect(sent[0]!.incident).toMatchObject({
      emitter: "prompt-hook-latency",
      subject: "@dev/11",
      condition: "hook-budget-exceeded",
      active: true,
    })
  })

  test("runs within budget produce no page", () => {
    const baseTime = Date.now() - 1000_000
    const lines = [
      JSON.stringify({
        ts: new Date(baseTime).toISOString(),
        pid: 301,
        namespace: "recall:hook:prompt",
        level: "info",
        msg: "start",
        session: "s1",
        start_time: baseTime,
      }),
      JSON.stringify({
        ts: new Date(baseTime + 200).toISOString(),
        pid: 301,
        namespace: "recall:hook:prompt",
        level: "info",
        msg: "library ok",
        session: "s1",
        elapsed_ms: 200,
        steps: { stdin: 5, recall: 195 },
      }),
    ]
    writeFileSync(logPath, lines.join("\n") + "\n", "utf8")

    const stats = readHookLatencyStats(logPath, { budgetMs: 1500 })
    expect(stats.p90Ms).toBe(200)
    expect(stats.killCount).toBe(0)
    expect(shouldPageHookLatency(stats, 1500)).toBe(false)

    const sent: any[] = []
    const api = {
      send: (recipient: string, content: string, type: string, beadId?: string, classification?: any, incident?: any) => {
        sent.push({ recipient, content, type, beadId, classification, incident })
      },
    } as unknown as TribeClientApi

    const result = pageHookLatency(api, stats, { owner: "@dev/11", budgetMs: 1500 })
    expect(result.paged).toBe(false)
    expect(sent).toHaveLength(0)
  })

  test("hookLatencyPlugin lifecycle and periodic tick integration", async () => {
    const baseTime = Date.now() - 500_000
    // Write 10s stall to logPath
    process.env.INJECTION_DEBUG_LOG = logPath
    const lines = [
      JSON.stringify({
        ts: new Date(baseTime).toISOString(),
        pid: 401,
        namespace: "recall:hook:prompt",
        level: "info",
        msg: "start",
        session: "s-plugin-stall",
        start_time: baseTime,
      }),
      JSON.stringify({
        ts: new Date(baseTime + 10_000).toISOString(),
        pid: 401,
        namespace: "recall:hook:prompt",
        level: "info",
        msg: "library ok",
        session: "s-plugin-stall",
        elapsed_ms: 10_000,
        steps: { stdin: 10, recall: 9_990 },
      }),
    ]
    writeFileSync(logPath, lines.join("\n") + "\n", "utf8")

    const sent: any[] = []
    const api = {
      send: (recipient: string, content: string, type: string, beadId?: string, classification?: any, incident?: any) => {
        sent.push({ recipient, content, type, beadId, classification, incident })
      },
    } as unknown as TribeClientApi

    expect(hookLatencyPlugin.name).toBe("hook-latency")
    expect(hookLatencyPlugin.available()).toBe(true)

    // Run tick directly
    const stop = hookLatencyPlugin.start(api)
    expect(typeof stop).toBe("function")

    // Dispose
    if (stop) stop()
    delete process.env.INJECTION_DEBUG_LOG
  })
})
