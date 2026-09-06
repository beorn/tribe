/**
 * @failure Without a declared roster, `tribe.members` / `tribe.health` can
 * only ever call a departed durable launch `finished` or `missing-transport`
 * — there is no way to say "hab expected this seat to remount and it
 * didn't." A seat hab supervises (`restart: "always"`) whose harness exits
 * and is never remounted carries a positive `harness-exited` fact, which the
 * plain finished/missing split reads as settled history and silently drops
 * from `missing` — the exact under-report this bead exists to close.
 * `TRIBE_EXPECTED_MEMBERS` hands the daemon hab's own restart declaration so
 * the projection can tell a live discrepancy (expected, gone) from
 * quiet-by-design (on-demand, gone) from history nobody was watching
 * (undeclared, gone) — without a declaration, nothing here moves.
 * @level l1
 * @consumer Tribe operators and daemon health/membership readers.
 *
 * @ag/tribe/tribe-membership-projection-counts-permanent-history-as-degraded
 */

import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"
import { logSessionLeft } from "./messaging.ts"
import { parseExpectedMembers, type DeclaredRoster, type MemberRestartPolicy } from "./membership-declared-roster.ts"
import { registerSession } from "./session.ts"

const PROJECT_ID = "membership-declared-roster"

function makeContext(db: Database, stmts: TribeStatements, sessionId: string, name: string): TribeContext {
  return createTribeContext({
    db,
    stmts,
    sessionId,
    sessionRole: "member",
    initialName: name,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
}

/** Registers (or re-registers, for the same sessionId) a durable launch row.
 *  `isActive` is hard-coded false — see membership-finished-launch.test.ts's
 *  identical helper docstring for why that never collides across fixtures. */
function addSession(
  db: Database,
  stmts: TribeStatements,
  sessionId: string,
  name: string,
  launch: { id: string; parentPid: number },
): TribeContext {
  const ctx = makeContext(db, stmts, sessionId, name)
  registerSession(
    ctx,
    PROJECT_ID,
    () => false,
    null,
    process.pid,
    "pull",
    "/repo",
    null,
    "codex",
    launch.id,
    launch.parentPid,
  )
  return ctx
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Record<string, unknown>
}

function baseOpts(overrides: Partial<HandlerOpts> = {}): HandlerOpts {
  return {
    cleanup: () => {},
    userRenamed: false,
    setUserRenamed: () => {},
    getActiveSessionIds: () => new Set<string>(),
    hasActiveTransport: () => false,
    getActiveSessionInfo: () => [],
    ...overrides,
  } as HandlerOpts
}

/** Builds a declared roster exactly the way the daemon parses
 *  `TRIBE_EXPECTED_MEMBERS` — never hand-assembled, so a test can never
 *  drift from the real parser's shape. */
function roster(members: Array<{ name: string; restart: MemberRestartPolicy }>): DeclaredRoster {
  return parseExpectedMembers(JSON.stringify(members))!
}

describe("membership projection: declared-roster membership is a function of hab's own restart policy (@ag/tribe/tribe-membership-projection-counts-permanent-history-as-degraded)", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "membership-declared-roster-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    vi.useRealTimers()
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("1. expected seat, harness-exited fact, not remounted: missing state exited-not-remounted, degraded (THE regression this bead closes)", () => {
    let now = 30_000_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const ctx = addSession(db, stmts, "exp-1", "@agent/restart-always", { id: "launch-exp-1", parentPid: 30001 })
      now += 1_000 // departs strictly after registration
      logSessionLeft(ctx, {
        memberId: "exp-1",
        name: "@agent/restart-always",
        role: "member",
        domains: [],
        launchId: "launch-exp-1",
        launchParentPid: 30001,
        reason: "harness-exited",
      })
      const leftAt = now

      const opCtx = makeContext(db, stmts, "operator", "@operator")
      const opts = baseOpts({ expectedMembers: roster([{ name: "@agent/restart-always", restart: "always" }]) })
      const members = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, opts)) as {
        membership_discrepancy?: Record<string, unknown>
        finished_launches?: unknown
      }
      expect(members.membership_discrepancy).toEqual({
        status: "degraded",
        connected_durable_launches: 0,
        known_durable_launches: 1,
        missing_count: 1,
        missing: [
          {
            member_id: "exp-1",
            name: "@agent/restart-always",
            launch_id: "launch-exp-1",
            launch_parent_pid: 30001,
            state: "exited-not-remounted",
            left_at: new Date(leftAt).toISOString(),
          },
        ],
        meaning: "missing transport does not establish agent absence",
      })
      expect(members.finished_launches).toBeUndefined()

      const health = parseToolJson(handleToolCall(opCtx, "tribe.health", {}, opts)) as {
        membership_discrepancy?: Record<string, unknown>
      }
      expect(health.membership_discrepancy).toEqual(members.membership_discrepancy)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("2. expected seat, transport-closed fact: missing-transport, degraded", () => {
    let now = 30_100_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const ctx = addSession(db, stmts, "exp-2", "@agent/restart-onfailure", { id: "launch-exp-2", parentPid: 30002 })
      now += 1_000
      logSessionLeft(ctx, {
        memberId: "exp-2",
        name: "@agent/restart-onfailure",
        role: "member",
        domains: [],
        launchId: "launch-exp-2",
        launchParentPid: 30002,
        reason: "transport-closed",
      })
      const opCtx = makeContext(db, stmts, "operator", "@operator")
      const opts = baseOpts({
        expectedMembers: roster([{ name: "@agent/restart-onfailure", restart: "on-failure" }]),
      })
      const members = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, opts)) as {
        membership_discrepancy?: { status: string; missing: Array<Record<string, unknown>> }
        finished_launches?: unknown
      }
      expect(members.finished_launches).toBeUndefined()
      expect(members.membership_discrepancy?.status).toBe("degraded")
      expect(members.membership_discrepancy?.missing).toEqual([
        {
          member_id: "exp-2",
          name: "@agent/restart-onfailure",
          launch_id: "launch-exp-2",
          launch_parent_pid: 30002,
          state: "missing-transport",
        },
      ])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("3. expected seat re-registered after the fact stays clean while connected (the 0e2fc4b restart case still holds)", () => {
    let now = 30_200_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const ctx = addSession(db, stmts, "exp-3", "@agent/restart-live", { id: "launch-exp-3", parentPid: 30003 })
      now += 1_000 // T1: departs
      logSessionLeft(ctx, {
        memberId: "exp-3",
        name: "@agent/restart-live",
        role: "member",
        domains: [],
        launchId: "launch-exp-3",
        launchParentPid: 30003,
        reason: "harness-exited",
      })
      now += 1_000 // T2 > T1: re-registers under the SAME session id and is live again
      registerSession(
        ctx,
        PROJECT_ID,
        () => false,
        null,
        process.pid,
        "pull",
        "/repo",
        null,
        "codex",
        "launch-exp-3",
        30003,
      )

      const opCtx = makeContext(db, stmts, "operator", "@operator")
      const opts = baseOpts({
        expectedMembers: roster([{ name: "@agent/restart-live", restart: "always" }]),
        getActiveSessionIds: () => new Set(["exp-3"]),
        getActiveSessionInfo: () => [
          {
            id: "exp-3",
            name: "@agent/restart-live",
            pid: 30003,
            cwd: "/repo",
            role: "member",
            claudeSessionId: null,
            registeredAt: now,
            launchId: "launch-exp-3",
            launchParentPid: 30003,
            transportPids: [30003],
          },
        ],
      })
      const members = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, opts)) as {
        membership_discrepancy?: unknown
        finished_launches?: unknown
      }
      expect(members.membership_discrepancy).toBeUndefined()
      expect(members.finished_launches).toBeUndefined()
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("4. on-demand seat, harness-exited fact: finished_launches, no discrepancy (by design, unchanged)", () => {
    let now = 30_300_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const ctx = addSession(db, stmts, "dem-1", "@adhoc/never-1", { id: "launch-dem-1", parentPid: 30004 })
      now += 1_000
      logSessionLeft(ctx, {
        memberId: "dem-1",
        name: "@adhoc/never-1",
        role: "member",
        domains: [],
        launchId: "launch-dem-1",
        launchParentPid: 30004,
        reason: "harness-exited",
      })
      const leftAt = now
      const opCtx = makeContext(db, stmts, "operator", "@operator")
      const opts = baseOpts({ expectedMembers: roster([{ name: "@adhoc/never-1", restart: "never" }]) })
      const members = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, opts)) as {
        membership_discrepancy?: unknown
        finished_launches?: Array<Record<string, unknown>>
      }
      expect(members.membership_discrepancy).toBeUndefined()
      expect(members.finished_launches).toEqual([
        {
          member_id: "dem-1",
          name: "@adhoc/never-1",
          launch_id: "launch-dem-1",
          launch_parent_pid: 30004,
          state: "finished",
          left_at: new Date(leftAt).toISOString(),
        },
      ])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("5. on-demand seat quiet between uses (no fact, or a transport-closed fact): dormant_launches, no discrepancy", () => {
    addSession(db, stmts, "dem-2", "@adhoc/never-quiet", { id: "launch-dem-2", parentPid: 30005 })
    const ctx3 = addSession(db, stmts, "dem-3", "@chief/next", { id: "launch-dem-3", parentPid: 30006 })
    logSessionLeft(ctx3, {
      memberId: "dem-3",
      name: "@chief/next",
      role: "member",
      domains: [],
      launchId: "launch-dem-3",
      launchParentPid: 30006,
      reason: "transport-closed",
    })
    const opCtx = makeContext(db, stmts, "operator", "@operator")
    const opts = baseOpts({
      expectedMembers: roster([
        { name: "@adhoc/never-quiet", restart: "never" },
        { name: "@chief/next", restart: "never" },
      ]),
    })
    const members = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, opts)) as {
      membership_discrepancy?: unknown
      finished_launches?: unknown
      dormant_launches?: Array<Record<string, unknown>>
    }
    expect(members.membership_discrepancy).toBeUndefined()
    expect(members.finished_launches).toBeUndefined()
    expect(members.dormant_launches).toEqual(
      expect.arrayContaining([
        { member_id: "dem-2", name: "@adhoc/never-quiet", launch_id: "launch-dem-2", state: "dormant" },
        { member_id: "dem-3", name: "@chief/next", launch_id: "launch-dem-3", state: "dormant" },
      ]),
    )
    expect(members.dormant_launches).toHaveLength(2)

    const health = parseToolJson(handleToolCall(opCtx, "tribe.health", {}, opts)) as {
      membership_discrepancy?: unknown
      dormant_launches?: unknown
    }
    expect(health.membership_discrepancy).toBeUndefined()
    expect(health.dormant_launches).toBeUndefined()
  })

  it("6. undeclared name, any fact: departed_launches, no discrepancy", () => {
    const ctx = addSession(db, stmts, "und-1", "@proof/wait-rc4", { id: "launch-und-1", parentPid: 30007 })
    logSessionLeft(ctx, {
      memberId: "und-1",
      name: "@proof/wait-rc4",
      role: "member",
      domains: [],
      launchId: "launch-und-1",
      launchParentPid: 30007,
      reason: "harness-exited",
    })
    const opCtx = makeContext(db, stmts, "operator", "@operator")
    // A real declaration that names nobody: @proof/wait-rc4 is absent from
    // it entirely, unlike the "never" (on-demand) rows in test 5.
    const opts = baseOpts({ expectedMembers: roster([]) })
    const members = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, opts)) as {
      membership_discrepancy?: unknown
      finished_launches?: unknown
      departed_launches?: Array<Record<string, unknown>>
    }
    expect(members.membership_discrepancy).toBeUndefined()
    expect(members.finished_launches).toBeUndefined()
    expect(members.departed_launches).toEqual([
      { member_id: "und-1", name: "@proof/wait-rc4", launch_id: "launch-und-1", state: "departed" },
    ])
  })

  it("7. expected name with no row at all: missing state never-registered", () => {
    const opCtx = makeContext(db, stmts, "operator", "@operator")
    const opts = baseOpts({ expectedMembers: roster([{ name: "@dev/12", restart: "always" }]) })
    const members = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, opts)) as {
      membership_discrepancy?: Record<string, unknown>
    }
    expect(members.membership_discrepancy).toEqual({
      status: "degraded",
      connected_durable_launches: 0,
      known_durable_launches: 1,
      missing_count: 1,
      missing: [{ name: "@dev/12", state: "never-registered" }],
      meaning: "missing transport does not establish agent absence",
    })
  })

  it("8. no declaration present: byte-identical to the pre-declaration finished/missing-transport split for the same rows", () => {
    let now = 30_400_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const finishedCtx = addSession(db, stmts, "nodecl-finished", "@agent/nodecl-9", {
        id: "launch-nodecl-9",
        parentPid: 40009,
      })
      now += 1_000
      logSessionLeft(finishedCtx, {
        memberId: "nodecl-finished",
        name: "@agent/nodecl-9",
        role: "member",
        domains: [],
        launchId: "launch-nodecl-9",
        launchParentPid: 40009,
        reason: "harness-exited",
      })
      const leftAt = now
      addSession(db, stmts, "nodecl-vanished", "@agent/nodecl-10", { id: "launch-nodecl-10", parentPid: 40010 })

      const opCtx = makeContext(db, stmts, "operator", "@operator")
      const opts = baseOpts() // no `expectedMembers` key at all — undefined, not an empty roster
      const members = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, opts)) as {
        membership_discrepancy?: Record<string, unknown>
        finished_launches?: Array<Record<string, unknown>>
        dormant_launches?: unknown
        departed_launches?: unknown
        unexpected_connected?: unknown
      }
      // Identical to membership-finished-launch.test.ts's "finished" +
      // "vanished" expectations — the pre-existing behavior for a row with
      // no declared roster must not move by one field, and none of the new
      // roster-only keys may appear.
      expect(members.finished_launches).toEqual([
        {
          member_id: "nodecl-finished",
          name: "@agent/nodecl-9",
          launch_id: "launch-nodecl-9",
          launch_parent_pid: 40009,
          state: "finished",
          left_at: new Date(leftAt).toISOString(),
        },
      ])
      expect(members.membership_discrepancy).toEqual({
        status: "degraded",
        connected_durable_launches: 0,
        known_durable_launches: 1,
        missing_count: 1,
        missing: [
          {
            member_id: "nodecl-vanished",
            name: "@agent/nodecl-10",
            launch_id: "launch-nodecl-10",
            launch_parent_pid: 40010,
            state: "missing-transport",
          },
        ],
        finished_count: 1,
        meaning: "missing transport does not establish agent absence",
      })
      expect(members.dormant_launches).toBeUndefined()
      expect(members.departed_launches).toBeUndefined()
      expect(members.unexpected_connected).toBeUndefined()
    } finally {
      nowSpy.mockRestore()
    }
  })

  it.each([
    ["not-json", /must be JSON/],
    [JSON.stringify({ name: "@a", restart: "always" }), /JSON array/],
    [JSON.stringify([{ restart: "always" }]), /name must be a non-empty string/],
    [JSON.stringify([{ name: "@a", restart: "sometimes" }]), /restart must be/],
    [JSON.stringify([{ name: "@a", restart: "always", extra: true }]), /unknown keys/],
    [
      JSON.stringify([
        { name: "@a", restart: "always" },
        { name: "@a", restart: "never" },
      ]),
      /duplicates declared name/,
    ],
  ])("9. fails loud on an invalid declared-roster table: %s", (raw, expected) => {
    expect(() => parseExpectedMembers(raw)).toThrow(expected)
  })

  it("10. undeclared connected row: unexpected_connected, no discrepancy", () => {
    addSession(db, stmts, "probe-1", "@probe/23145", { id: "launch-probe-1", parentPid: 30099 })
    addSession(db, stmts, "exp-10", "@agent/restart-always", { id: "launch-exp-10", parentPid: 30100 })
    const opCtx = makeContext(db, stmts, "operator", "@operator")
    const opts = baseOpts({
      expectedMembers: roster([{ name: "@agent/restart-always", restart: "always" }]),
      getActiveSessionIds: () => new Set(["probe-1", "exp-10"]),
      getActiveSessionInfo: () => [
        {
          id: "probe-1",
          name: "@probe/23145",
          pid: 30099,
          cwd: "/repo",
          role: "member",
          claudeSessionId: null,
          registeredAt: Date.now(),
          launchId: "launch-probe-1",
          launchParentPid: 30099,
          transportPids: [30099],
        },
        {
          id: "exp-10",
          name: "@agent/restart-always",
          pid: 30100,
          cwd: "/repo",
          role: "member",
          claudeSessionId: null,
          registeredAt: Date.now(),
          launchId: "launch-exp-10",
          launchParentPid: 30100,
          transportPids: [30100],
        },
      ],
    })
    const members = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, opts)) as {
      membership_discrepancy?: unknown
      unexpected_connected?: string[]
    }
    // The declared+connected seat never shows up as unexpected; only the
    // undeclared probe does, and a fully-satisfied declaration stays clean.
    expect(members.unexpected_connected).toEqual(["@probe/23145"])
    expect(members.membership_discrepancy).toBeUndefined()

    const health = parseToolJson(handleToolCall(opCtx, "tribe.health", {}, opts)) as {
      unexpected_connected?: unknown
    }
    expect(health.unexpected_connected).toBeUndefined()
  })
})
