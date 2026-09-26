/**
 * @failure Prompt hook runs over budget or is killed without being detected or paged
 * @level   l2
 * @consumer @ag/tribe/25304-nothing-reads-the-prompt-hooks-latency-log-so-a-30-s-kill-is-found-by-the-operator
 * @testonly none
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import {
  clearHookLatencyIncident,
  DEFAULT_HOOK_LATENCY_OWNER,
  formatHookLatencyReport,
  HOOK_LATENCY_EMITTER,
  HOOK_LATENCY_SUBJECT,
  nearestRank,
  pageHookLatency,
  readHookLatencyStats,
  shouldPageHookLatency,
} from "./hook-latency-reader.ts"
import {
  createHookLatencySampler,
  hookLatencyPlugin,
  parseStrictPositiveInt,
  resolveHookLogPathDetails,
} from "./hook-latency-plugin.ts"
import type { TribeClientApi } from "./plugin-api.ts"
import { openDatabase, createStatements } from "./database.ts"
import { createTribeContext } from "./context.ts"
import { sendMessage } from "./messaging.ts"
import { incidentKey } from "tribe-wire"

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
      send: (
        recipient: string,
        content: string,
        type: string,
        beadId?: string,
        classification?: any,
        incident?: any,
      ) => {
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
      emitter: HOOK_LATENCY_EMITTER,
      subject: HOOK_LATENCY_SUBJECT,
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
      send: (
        recipient: string,
        content: string,
        type: string,
        beadId?: string,
        classification?: any,
        incident?: any,
      ) => {
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
      emitter: HOOK_LATENCY_EMITTER,
      subject: HOOK_LATENCY_SUBJECT,
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
      send: (
        recipient: string,
        content: string,
        type: string,
        beadId?: string,
        classification?: any,
        incident?: any,
      ) => {
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
      send: (
        recipient: string,
        content: string,
        type: string,
        beadId?: string,
        classification?: any,
        incident?: any,
      ) => {
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

  test("P3 Criteria 2 & 3: Default owner routing to @chief and subject keyed on recall:hook:prompt", () => {
    const stats: any = {
      killCount: 1,
      killedRuns: [{ session: "s1", ts: "2026-09-25T12:00:00.000Z", startTime: 1000 }],
      totalRuns: 1,
      completedRuns: 0,
      p90Ms: null,
      maxMs: null,
      budgetMs: 1500,
    }
    const sent: any[] = []
    const api = {
      send: (
        recipient: string,
        content: string,
        type: string,
        beadId?: string,
        classification?: any,
        incident?: any,
      ) => {
        sent.push({ recipient, content, type, beadId, classification, incident })
      },
    } as unknown as TribeClientApi

    // pageHookLatency without explicit owner/subject
    const res = pageHookLatency(api, stats)
    expect(res.paged).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.recipient).toBe(DEFAULT_HOOK_LATENCY_OWNER) // "@chief"
    expect(sent[0]!.incident).toEqual({
      emitter: HOOK_LATENCY_EMITTER, // "prompt-hook-latency"
      subject: HOOK_LATENCY_SUBJECT, // "recall:hook:prompt"
      condition: "hook-kill",
      active: true,
    })

    // clearHookLatencyIncident without explicit owner/subject
    clearHookLatencyIncident(api, "hook-kill")
    expect(sent).toHaveLength(2)
    expect(sent[1]!.recipient).toBe(DEFAULT_HOOK_LATENCY_OWNER) // "@chief"
    expect(sent[1]!.type).toBe("notify")
    expect(sent[1]!.incident).toEqual({
      emitter: HOOK_LATENCY_EMITTER,
      subject: HOOK_LATENCY_SUBJECT,
      condition: "hook-kill",
      active: false,
    })
  })

  test("P3 Criteria 5: parseStrictPositiveInt validates positive integers and refuses malformed strings by name", () => {
    expect(parseStrictPositiveInt("PARAM", undefined)).toBeUndefined()
    expect(parseStrictPositiveInt("PARAM", "")).toBeUndefined()
    expect(parseStrictPositiveInt("PARAM", "   ")).toBeUndefined()

    expect(parseStrictPositiveInt("PARAM", "1")).toBe(1)
    expect(parseStrictPositiveInt("PARAM", "1500")).toBe(1500)
    expect(parseStrictPositiveInt("PARAM", "3600000")).toBe(3600000)

    // Non-positive or malformed values throw with the variable name
    expect(() => parseStrictPositiveInt("HOOK_BUDGET_MS", "0")).toThrow(/Invalid HOOK_BUDGET_MS/)
    expect(() => parseStrictPositiveInt("HOOK_BUDGET_MS", "-5")).toThrow(/Invalid HOOK_BUDGET_MS/)
    expect(() => parseStrictPositiveInt("HOOK_LATENCY_POLL_INTERVAL_MS", "abc")).toThrow(
      /Invalid HOOK_LATENCY_POLL_INTERVAL_MS.*not a positive integer/,
    )
    expect(() => parseStrictPositiveInt("HOOK_LATENCY_POLL_INTERVAL_SEC", "12.3")).toThrow(
      /Invalid HOOK_LATENCY_POLL_INTERVAL_SEC.*not a positive integer/,
    )
    expect(() => parseStrictPositiveInt("HOOK_LATENCY_POLL_INTERVAL_MS", "20 minutes")).toThrow(
      /Invalid HOOK_LATENCY_POLL_INTERVAL_MS.*not a positive integer/,
    )
  })

  test("P3 Criteria 5: hookLatencyPlugin.start refuses invalid env vars by name", () => {
    const api = {} as TribeClientApi

    process.env.HOOK_LATENCY_POLL_INTERVAL_MS = "invalid-ms"
    expect(() => hookLatencyPlugin.start(api)).toThrow(/Invalid HOOK_LATENCY_POLL_INTERVAL_MS/)
    delete process.env.HOOK_LATENCY_POLL_INTERVAL_MS

    process.env.HOOK_LATENCY_POLL_INTERVAL_SEC = "invalid-sec"
    expect(() => hookLatencyPlugin.start(api)).toThrow(/Invalid HOOK_LATENCY_POLL_INTERVAL_SEC/)
    delete process.env.HOOK_LATENCY_POLL_INTERVAL_SEC

    process.env.HOOK_BUDGET_MS = "-1"
    expect(() => hookLatencyPlugin.start(api)).toThrow(/Invalid HOOK_BUDGET_MS/)
    delete process.env.HOOK_BUDGET_MS
  })

  test("P3 Criteria 4: Missing log names path and 3 sources considered, and broadcasts health row", async () => {
    const missingPath = join(tempDir, "non-existent-log.jsonl")
    process.env.INJECTION_DEBUG_LOG = missingPath

    const details = resolveHookLogPathDetails()
    expect(details.path).toBe(missingPath)
    expect(details.sources.injectionDebugLog).toBe(missingPath)

    const broadcasts: any[] = []
    const dedupClaims = new Set<string>()
    const api = {
      claimDedup: (key: string) => {
        if (dedupClaims.has(key)) return false
        dedupClaims.add(key)
        return true
      },
      broadcast: (content: string, type: string, beadId?: string, classification?: any) => {
        broadcasts.push({ content, type, beadId, classification })
      },
    } as unknown as TribeClientApi

    const sampler = createHookLatencySampler(api)
    sampler.sample()

    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]!.type).toBe("health")
    expect(broadcasts[0]!.classification).toMatchObject({
      delivery: "pull",
      topic: "health:hook-latency:missing-log",
      summary: `Prompt hook latency log missing: ${missingPath}`,
    })
    expect(broadcasts[0]!.content).toContain(missingPath)
    expect(broadcasts[0]!.content).toContain("INJECTION_DEBUG_LOG")
    expect(broadcasts[0]!.content).toContain("LOGGILY_FILE")
    expect(broadcasts[0]!.content).toContain("default")

    // Second sample should dedup via claimDedup
    sampler.sample()
    expect(broadcasts).toHaveLength(1)

    delete process.env.INJECTION_DEBUG_LOG
  })

  test("P3 Criteria 1 & 6 Witness test: Bad hour opens incident ball (active: true), good hour clears it (active: false)", async () => {
    process.env.INJECTION_DEBUG_LOG = logPath
    const sent: any[] = []
    const api = {
      send: (
        recipient: string,
        content: string,
        type: string,
        beadId?: string,
        classification?: any,
        incident?: any,
      ) => {
        sent.push({ recipient, content, type, beadId, classification, incident })
      },
      claimDedup: () => true,
      broadcast: () => {},
    } as unknown as TribeClientApi

    const sampler = createHookLatencySampler(api, {
      pollIntervalMs: 3600_000,
      budgetMs: 1500,
      owner: "@chief",
      subject: HOOK_LATENCY_SUBJECT,
    })

    // --- HOUR 1: BAD HOUR (10s stall, exceeds 1500ms budget) ---
    const hour1Base = Date.now() - 3000_000
    const hour1Lines = [
      JSON.stringify({
        ts: new Date(hour1Base).toISOString(),
        pid: 501,
        namespace: "recall:hook:prompt",
        level: "info",
        msg: "start",
        session: "sess-hour1-stall",
        start_time: hour1Base,
      }),
      JSON.stringify({
        ts: new Date(hour1Base + 10_000).toISOString(),
        pid: 501,
        namespace: "recall:hook:prompt",
        level: "info",
        msg: "library ok",
        session: "sess-hour1-stall",
        elapsed_ms: 10_000,
        steps: { stdin: 10, recall: 9_990 },
      }),
    ]
    writeFileSync(logPath, hour1Lines.join("\n") + "\n", "utf8")

    sampler.sample()

    // Witness: Bad hour opens incident ball (active: true) on @chief
    expect(sent).toHaveLength(1)
    expect(sent[0]!.recipient).toBe("@chief")
    expect(sent[0]!.incident).toEqual({
      emitter: HOOK_LATENCY_EMITTER,
      subject: HOOK_LATENCY_SUBJECT,
      condition: "hook-budget-exceeded",
      active: true,
    })
    expect(sampler.activeConditions.has("hook-budget-exceeded")).toBe(true)

    // --- HOUR 2: GOOD HOUR (normal run, 150ms elapsed, well within 1500ms budget, 0 kills) ---
    const hour2Base = Date.now() - 500_000
    const hour2Lines = [
      JSON.stringify({
        ts: new Date(hour2Base).toISOString(),
        pid: 502,
        namespace: "recall:hook:prompt",
        level: "info",
        msg: "start",
        session: "sess-hour2-ok",
        start_time: hour2Base,
      }),
      JSON.stringify({
        ts: new Date(hour2Base + 150).toISOString(),
        pid: 502,
        namespace: "recall:hook:prompt",
        level: "info",
        msg: "library ok",
        session: "sess-hour2-ok",
        elapsed_ms: 150,
        steps: { stdin: 5, recall: 145 },
      }),
    ]
    // Overwrite with only hour 2 rows (representing the new hour's window)
    writeFileSync(logPath, hour2Lines.join("\n") + "\n", "utf8")

    sampler.sample()

    // Witness: Good hour sends clearing edge (active: false) on @chief
    expect(sent).toHaveLength(2)
    expect(sent[1]!.recipient).toBe("@chief")
    expect(sent[1]!.type).toBe("notify")
    expect(sent[1]!.incident).toEqual({
      emitter: HOOK_LATENCY_EMITTER,
      subject: HOOK_LATENCY_SUBJECT,
      condition: "hook-budget-exceeded",
      active: false,
    })
    expect(sampler.activeConditions.has("hook-budget-exceeded")).toBe(false)

    // --- HOUR 3: ANOTHER GOOD HOUR ---
    // Nothing was active, so no clear and no page sent
    sampler.sample()
    expect(sent).toHaveLength(2)

    delete process.env.INJECTION_DEBUG_LOG
  })

  test("Real SQLite incident ball lifecycle (opens on bad hour, settles on good hour with incident-cleared)", async () => {
    process.env.INJECTION_DEBUG_LOG = logPath
    const db = openDatabase(join(tempDir, "tribe-incident.db"))
    const stmts = createStatements(db)
    const ctx = createTribeContext({
      db,
      stmts,
      sessionId: "sess-hook-latency",
      sessionRole: "watch",
      initialName: "hook-latency",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })

    const expectedIncident = {
      emitter: HOOK_LATENCY_EMITTER,
      subject: HOOK_LATENCY_SUBJECT,
      condition: "hook-budget-exceeded",
    }
    const expectedKey = incidentKey(expectedIncident)

    const api = {
      send: (
        recipient: string,
        content: string,
        type: string,
        beadId?: string,
        classification?: any,
        incident?: any,
      ) => {
        sendMessage(ctx, recipient, content, type, beadId, undefined, "direct", classification ?? {}, { incident })
      },
      listOpenIncidents: (emitter: string, condition: string) => {
        const rows = stmts.selectOpenIncidentsByEmitter.all({ $prefix: `${emitter}:` }) as Array<{
          request_id: string
          recipient: string
        }>
        return rows.flatMap((row) => {
          const parts = row.request_id.split(":")
          if (parts[0] === emitter && parts[2] === condition) {
            return [{ subject: parts[1]!, recipient: row.recipient }]
          }
          return []
        })
      },
      claimDedup: () => true,
      broadcast: () => {},
    } as unknown as TribeClientApi

    const sampler = createHookLatencySampler(api, {
      pollIntervalMs: 3600_000,
      budgetMs: 1500,
      owner: "@chief",
      subject: HOOK_LATENCY_SUBJECT,
    })

    // Bad hour: Seeded 10s stall
    const hour1Base = Date.now() - 3000_000
    writeFileSync(
      logPath,
      [
        JSON.stringify({
          ts: new Date(hour1Base).toISOString(),
          pid: 601,
          namespace: "recall:hook:prompt",
          level: "info",
          msg: "start",
          session: "sess-stall",
          start_time: hour1Base,
        }),
        JSON.stringify({
          ts: new Date(hour1Base + 10_000).toISOString(),
          pid: 601,
          namespace: "recall:hook:prompt",
          level: "info",
          msg: "library ok",
          session: "sess-stall",
          elapsed_ms: 10_000,
          steps: { stdin: 10, recall: 9_990 },
        }),
      ].join("\n") + "\n",
      "utf8",
    )

    sampler.sample()

    // Verify ball is open in SQLite pending_request table
    const openBallsHour1 = stmts.selectPendingSettlementsForRequest.all({ $request_id: expectedKey }) as any[]
    expect(openBallsHour1).toHaveLength(1)
    expect(openBallsHour1[0]!.request_id).toBe(expectedKey)
    expect(openBallsHour1[0]!.recipient).toBe("@chief")

    // Good hour: 150ms run
    const hour2Base = Date.now() - 500_000
    writeFileSync(
      logPath,
      [
        JSON.stringify({
          ts: new Date(hour2Base).toISOString(),
          pid: 602,
          namespace: "recall:hook:prompt",
          level: "info",
          msg: "start",
          session: "sess-ok",
          start_time: hour2Base,
        }),
        JSON.stringify({
          ts: new Date(hour2Base + 150).toISOString(),
          pid: 602,
          namespace: "recall:hook:prompt",
          level: "info",
          msg: "library ok",
          session: "sess-ok",
          elapsed_ms: 150,
          steps: { stdin: 5, recall: 145 },
        }),
      ].join("\n") + "\n",
      "utf8",
    )

    sampler.sample()

    // Verify ball is CLOSED in SQLite pending_request table!
    const openBallsHour2 = stmts.selectPendingSettlementsForRequest.all({ $request_id: expectedKey }) as any[]
    expect(openBallsHour2).toHaveLength(0)

    // Verify settled event recorded with settlement = "incident-cleared"
    const settledEvents = db
      .prepare("SELECT content FROM messages WHERE kind = 'event' AND type = 'event.ball.settled'")
      .all() as Array<{ content: string }>
    expect(settledEvents.map((r) => JSON.parse(r.content))).toEqual([
      expect.objectContaining({
        request_id: expectedKey,
        recipient: "@chief",
        settlement: "incident-cleared",
      }),
    ])

    delete process.env.INJECTION_DEBUG_LOG
    db.close()
  })
})
