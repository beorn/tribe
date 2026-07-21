/**
 * Smoke tests for `registerReadCommands` — Family 1 of Phase A.2 verb-port.
 *
 * Bead: @km/bearly/19231-tribe-cli-unify-phase-a2-verbs
 *
 * These tests verify that each read verb is registered on the program and
 * accepts its expected flag surface. End-to-end daemon behavior is covered
 * by the legacy tribe-cli integration tests; the focus here is wiring +
 * Commander definitions only.
 */

import { describe, expect, test } from "vitest"
import { Command } from "@silvery/commander"
import { formatReloadResult, registerReadCommands, waitForInboxWithReconnect } from "../src/cli/read.ts"
import {
  deriveInboxWaitCallTimeoutMs,
  MAX_INBOX_WAIT_TIMEOUT_MS,
  resolveInboxWaitOptions,
} from "../src/lib/inbox-wait-options.ts"

function buildProgram(): Command {
  const program = new Command("tribe-test")
  registerReadCommands(program)
  return program
}

function findCmd(program: Command, name: string): Command | undefined {
  return program.commands.find((c) => c.name() === name) as Command | undefined
}

function optionFlags(cmd: Command): string[] {
  // Commander exposes the registered options on `.options`; each entry has a
  // `.long` (e.g. "--limit") and an optional `.short` (e.g. "-n").
  return (cmd.options ?? []).map((o: { long?: string }) => o.long ?? "").filter(Boolean)
}

describe("registerReadCommands", () => {
  test("registers all read verbs", () => {
    const program = buildProgram()
    const names = program.commands.map((c) => c.name())
    expect(names).toEqual(
      expect.arrayContaining([
        "status",
        "sessions",
        "members",
        "pending",
        "log",
        "health",
        "inbox-drain",
        "inbox-status",
        "inbox-wait",
        "reload",
        "repair",
        "activity",
      ]),
    )
  })

  test("status verb is registered with description", () => {
    const cmd = findCmd(buildProgram(), "status")
    expect(cmd).toBeDefined()
    expect(cmd!.description()).toMatch(/active sessions/i)
  })

  test("sessions verb accepts --all", () => {
    const cmd = findCmd(buildProgram(), "sessions")
    expect(cmd).toBeDefined()
    expect(optionFlags(cmd!)).toEqual(expect.arrayContaining(["--all"]))
  })

  test("members verb accepts --all and documents transport verdicts", () => {
    const cmd = findCmd(buildProgram(), "members")
    expect(cmd).toBeDefined()
    expect(optionFlags(cmd!)).toContain("--all")
    expect(cmd!.description()).toMatch(/transport|owner/i)
  })

  test("pending verb accepts --all, --json, --owner, --stale, and --close", () => {
    const cmd = findCmd(buildProgram(), "pending")
    expect(cmd).toBeDefined()
    const flags = optionFlags(cmd!)
    expect(flags).toEqual(expect.arrayContaining(["--all", "--json", "--owner", "--stale", "--close"]))
  })

  test("log verb accepts --limit, --all, --follow, --json, and --ref-prefix", () => {
    const cmd = findCmd(buildProgram(), "log")
    expect(cmd).toBeDefined()
    const flags = optionFlags(cmd!)
    expect(flags).toEqual(expect.arrayContaining(["--limit", "--all", "--follow", "--json", "--ref-prefix"]))
  })

  test("health verb is registered with description", () => {
    const cmd = findCmd(buildProgram(), "health")
    expect(cmd).toBeDefined()
    expect(cmd!.description()).toMatch(/diagnostics/i)
  })

  test("inbox-status verb accepts --session and --json", () => {
    const cmd = findCmd(buildProgram(), "inbox-status")
    expect(cmd).toBeDefined()
    const flags = optionFlags(cmd!)
    expect(flags).toEqual(expect.arrayContaining(["--session", "--json"]))
  })

  test("inbox-drain verb accepts --session, --limit, and --json", () => {
    const cmd = findCmd(buildProgram(), "inbox-drain")
    expect(cmd).toBeDefined()
    const flags = optionFlags(cmd!)
    expect(flags).toEqual(expect.arrayContaining(["--session", "--limit", "--json"]))
  })

  test("inbox-wait verb accepts --session, --timeout, and --json", () => {
    const cmd = findCmd(buildProgram(), "inbox-wait")
    expect(cmd).toBeDefined()
    const flags = optionFlags(cmd!)
    expect(flags).toEqual(expect.arrayContaining(["--session", "--timeout", "--json"]))
  })

  test("repair verb accepts --session, --inbox-cursor, and --json", () => {
    const cmd = findCmd(buildProgram(), "repair")
    expect(cmd).toBeDefined()
    const flags = optionFlags(cmd!)
    expect(flags).toEqual(expect.arrayContaining(["--session", "--inbox-cursor", "--json"]))
  })

  test("reload verb accepts --reason and --json", () => {
    const cmd = findCmd(buildProgram(), "reload")
    expect(cmd).toBeDefined()
    expect(cmd!.description()).toMatch(/hot-reload/i)
    const flags = optionFlags(cmd!)
    expect(flags).toEqual(expect.arrayContaining(["--reason", "--json"]))
  })

  test("activity verb accepts --follow, --since, and --no-color", () => {
    const cmd = findCmd(buildProgram(), "activity")
    expect(cmd).toBeDefined()
    const flags = optionFlags(cmd!)
    // Commander stores --no-color as --no-color (the negation form).
    expect(flags).toEqual(expect.arrayContaining(["--follow", "--since"]))
    expect(flags.some((f) => f.includes("color"))).toBe(true)
  })

  test("idempotent — each call returns Commander-shaped sub-commands", () => {
    const program = new Command("tribe-test")
    registerReadCommands(program)
    // Sanity: every registered command exposes the standard Commander API.
    for (const c of program.commands) {
      expect(typeof c.name()).toBe("string")
      expect(typeof c.description()).toBe("string")
    }
  })
})

describe("formatReloadResult", () => {
  test("formats the daemon reload acknowledgement with pid and reason", () => {
    expect(formatReloadResult({ reloading: true, reason: "pick up CLI fix", pid: 1234 })).toBe(
      "Reloading tribe daemon (pid 1234): pick up CLI fix.",
    )
  })

  test("formats older daemon reload acknowledgements without pid", () => {
    expect(formatReloadResult({ reloading: true, reason: "manual reload" })).toBe(
      "Reloading tribe daemon: manual reload.",
    )
  })
})

describe("resolveInboxWaitOptions", () => {
  test("normalizes default, snake_case, and camelCase inbox-wait inputs", () => {
    expect(resolveInboxWaitOptions({}, { defaultSession: "@agent/5" })).toEqual({
      session: "@agent/5",
      timeoutMs: 30_000,
      wakeOnCorrelatedReply: false,
    })
    expect(
      resolveInboxWaitOptions({
        session: "@ci",
        timeout_ms: "120000",
        wake_on_correlated_reply: true,
      }),
    ).toEqual({
      session: "@ci",
      timeoutMs: 120_000,
      wakeOnCorrelatedReply: true,
    })
    expect(resolveInboxWaitOptions({ timeoutMs: 0 }, { defaultSession: "@agent/5" })).toEqual({
      session: "@agent/5",
      timeoutMs: 0,
      wakeOnCorrelatedReply: false,
    })
  })

  test("caps one logical wait and sizes its daemon RPC beyond that full window", () => {
    const resolved = resolveInboxWaitOptions({ timeout_ms: 24 * 60 * 60_000 })
    expect(resolved.timeoutMs).toBe(MAX_INBOX_WAIT_TIMEOUT_MS)
    expect(deriveInboxWaitCallTimeoutMs(resolved.timeoutMs)).toBe(MAX_INBOX_WAIT_TIMEOUT_MS + 5_000)
    expect(deriveInboxWaitCallTimeoutMs(24 * 60 * 60_000)).toBe(MAX_INBOX_WAIT_TIMEOUT_MS + 5_000)
  })
})

describe("waitForInboxWithReconnect", () => {
  const EMPTY_ATTENTION = {
    actionable_unread: [],
    pending_balls: [],
    pending_balls_summary: { total: 0, oldest_age_ms: 0 },
  }

  test("retries retryable transport close without losing the original absolute deadline", async () => {
    let now = 1_000
    const chunkCalls: number[] = []
    const result = await waitForInboxWithReconnect({
      session: "@ci",
      timeoutMs: 65_000,
      maxChunkMs: 30_000,
      retryDelayMs: 250,
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
      call: async ({ timeoutMs }) => {
        chunkCalls.push(timeoutMs)
        if (chunkCalls.length === 1) {
          now += 12_000
          throw new Error("Connection closed")
        }
        now += 5_000
        return {
          session: "@ci",
          unread_count: 1,
          oldest_unread_age_min: 0,
          oldest_unread_ts: now,
          waited_ms: 5_000,
          effective_timeout_ms: timeoutMs,
          timed_out: false,
          aborted: false,
          attention: EMPTY_ATTENTION,
        }
      },
    })

    expect(chunkCalls).toEqual([30_000, 30_000])
    expect(result.unread_count).toBe(1)
    expect(result.waited_ms).toBe(17_250)
    expect(result.timed_out).toBe(false)
  })

  test("clamps the last retry and keeps reload churn loud without an authoritative daemon result", async () => {
    let now = 0
    const chunkCalls: number[] = []
    const wait = waitForInboxWithReconnect({
      session: "@ci",
      timeoutMs: 35_000,
      maxChunkMs: 30_000,
      retryDelayMs: 0,
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
      call: async ({ timeoutMs }) => {
        chunkCalls.push(timeoutMs)
        now += timeoutMs
        throw Object.assign(new Error("Connection closed"), { code: "ECONNRESET" })
      },
    })

    await expect(wait).rejects.toMatchObject({ code: "ECONNRESET" })
    expect(chunkCalls).toEqual([30_000, 5_000])
  })

  test("does not fabricate empty attention when the daemon is unavailable for the whole short window", async () => {
    let now = 0
    const missing = Object.assign(new Error("connect ENOENT /tmp/tribe.sock"), { code: "ENOENT" })

    await expect(
      waitForInboxWithReconnect({
        session: "@ci",
        timeoutMs: 100,
        retryDelayMs: 100,
        unavailableGraceMs: 2_000,
        now: () => now,
        sleep: async (ms) => {
          now += ms
        },
        call: async () => {
          throw missing
        },
      }),
    ).rejects.toBe(missing)
  })

  test("retries lost wait RPC timeouts caused by daemon reload", async () => {
    let now = 0
    const chunkCalls: number[] = []
    const result = await waitForInboxWithReconnect({
      session: "@ci",
      timeoutMs: 45_000,
      maxChunkMs: 30_000,
      retryDelayMs: 100,
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
      call: async ({ timeoutMs }) => {
        chunkCalls.push(timeoutMs)
        if (chunkCalls.length === 1) {
          now += 35_000
          throw new Error("Request cli_inbox_wait timed out")
        }
        now += 500
        return {
          session: "@ci",
          unread_count: 1,
          oldest_unread_age_min: 0,
          oldest_unread_ts: now,
          waited_ms: 500,
          effective_timeout_ms: timeoutMs,
          timed_out: false,
          aborted: false,
          attention: EMPTY_ATTENTION,
        }
      },
    })

    expect(chunkCalls).toEqual([30_000, 9_900])
    expect(result.unread_count).toBe(1)
    expect(result.waited_ms).toBe(35_600)
  })

  test("daemon-unavailable errors retry only during the short startup grace, then stay loud", async () => {
    let now = 0
    const chunkCalls: number[] = []
    const missing = Object.assign(new Error("connect ENOENT /tmp/tribe.sock"), { code: "ENOENT" })

    await expect(
      waitForInboxWithReconnect({
        session: "@ci",
        timeoutMs: 120_000,
        maxChunkMs: 30_000,
        retryDelayMs: 1_000,
        unavailableGraceMs: 2_000,
        now: () => now,
        sleep: async (ms) => {
          now += ms
        },
        call: async ({ timeoutMs }) => {
          chunkCalls.push(timeoutMs)
          throw missing
        },
      }),
    ).rejects.toBe(missing)

    expect(chunkCalls).toEqual([30_000, 30_000, 30_000])
  })

  test("daemon-unavailable errors can recover during the startup grace", async () => {
    let now = 0
    const chunkCalls: number[] = []
    const result = await waitForInboxWithReconnect({
      session: "@ci",
      timeoutMs: 120_000,
      maxChunkMs: 30_000,
      retryDelayMs: 500,
      unavailableGraceMs: 2_000,
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
      call: async ({ timeoutMs }) => {
        chunkCalls.push(timeoutMs)
        if (chunkCalls.length === 1) {
          throw Object.assign(new Error("connect ECONNREFUSED /tmp/tribe.sock"), { code: "ECONNREFUSED" })
        }
        now += 250
        return {
          session: "@ci",
          unread_count: 1,
          oldest_unread_age_min: 0,
          oldest_unread_ts: now,
          waited_ms: 250,
          effective_timeout_ms: timeoutMs,
          timed_out: false,
          aborted: false,
          attention: EMPTY_ATTENTION,
        }
      },
    })

    expect(chunkCalls).toEqual([30_000, 30_000])
    expect(result.unread_count).toBe(1)
    expect(result.waited_ms).toBe(750)
  })

  test("preserves the daemon attention projection when the logical window times out", async () => {
    let now = 0
    const attention = {
      actionable_unread: [{ id: "request-visible" }],
      pending_balls: [{ request_id: "request-visible" }],
      pending_balls_summary: { total: 1, oldest_age_ms: 500 },
    }
    const result = await waitForInboxWithReconnect({
      session: "@ci",
      timeoutMs: 35_000,
      maxChunkMs: 30_000,
      now: () => now,
      call: async ({ timeoutMs }) => {
        now += timeoutMs
        return {
          session: "@ci",
          unread_count: 0,
          oldest_unread_age_min: 0,
          oldest_unread_ts: 0,
          waited_ms: timeoutMs,
          effective_timeout_ms: timeoutMs,
          timed_out: true,
          aborted: false,
          attention,
        }
      },
    })

    expect(result).toMatchObject({
      waited_ms: 35_000,
      effective_timeout_ms: 35_000,
      timed_out: true,
      aborted: false,
      attention,
    })
  })

  test("preserves the last authoritative attention when the daemon becomes unavailable", async () => {
    let now = 0
    let calls = 0
    const attention = {
      actionable_unread: [{ id: "request-before-reload" }],
      pending_balls: [{ request_id: "request-before-reload" }],
      pending_balls_summary: { total: 1, oldest_age_ms: 750 },
    }
    const result = await waitForInboxWithReconnect({
      session: "@ci",
      timeoutMs: 35_000,
      maxChunkMs: 30_000,
      retryDelayMs: 5_000,
      unavailableGraceMs: 2_000,
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
      call: async ({ timeoutMs }) => {
        calls += 1
        if (calls > 1) {
          throw Object.assign(new Error("connect ENOENT /tmp/tribe.sock"), { code: "ENOENT" })
        }
        now += timeoutMs
        return {
          session: "@ci",
          unread_count: 0,
          oldest_unread_age_min: 0,
          oldest_unread_ts: 0,
          waited_ms: timeoutMs,
          effective_timeout_ms: timeoutMs,
          timed_out: true,
          aborted: false,
          attention,
        }
      },
    })

    expect(calls).toBe(2)
    expect(result).toMatchObject({
      waited_ms: 35_000,
      effective_timeout_ms: 35_000,
      timed_out: true,
      aborted: false,
      attention,
    })
  })
})
