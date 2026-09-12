/**
 * @failure Without a declared roster, `tribe.members` / `tribe.health` can
 * only ever call a departed durable launch `finished` or `missing-transport`
 * — there is no way to say "hab expected this seat up and it wasn't." A seat
 * hab declares `expected: true` whose harness exits and is never remounted
 * carries a positive `harness-exited` fact, which the plain finished/missing
 * split reads as settled history and silently drops from `missing` — the
 * exact under-report this bead exists to close. `TRIBE_EXPECTED_MEMBERS`
 * hands the daemon a plain per-name "is hab expecting this seat up" boolean
 * — never a restart-policy vocabulary; hab's own resolved restart default
 * lives in more than one place (habd-runtime, the health classifier), so
 * "expected up" is a declaration semantic hab derives itself and tribe just
 * takes the answer — so the projection can tell a live discrepancy
 * (expected, gone) from quiet-by-design (on-demand, gone) from history
 * nobody was watching (undeclared, gone) — without a declaration, nothing
 * here moves.
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
import { parseExpectedMembers, type DeclaredRoster } from "./membership-declared-roster.ts"
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
function roster(members: Array<{ name: string; expected: boolean }>): DeclaredRoster {
  return parseExpectedMembers(JSON.stringify(members))!
}

describe("membership projection: declared-roster membership is a function of a plain expected-up declaration (@ag/tribe/tribe-membership-projection-counts-permanent-history-as-degraded)", () => {
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
      const opts = baseOpts({ expectedMembers: roster([{ name: "@agent/restart-always", expected: true }]) })
      const members = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, opts)) as {
        membership_discrepancy?: Record<string, unknown>
        finished_launches?: unknown
      }
      expect(members.membership_discrepancy).toEqual({
        status: "degraded",
        connected_durable_launches: 0,
        known_durable_launches: 1,
        expected_count: 1,
        connected_expected_count: 0,
        roster_loaded_at: expect.any(String),
        missing_count: 1,
        missing: [
          {
            member_id: "exp-1",
            name: "@agent/restart-always",
            launch_id: "launch-exp-1",
            launch_parent_pid: 30001,
            state: "exited-not-remounted",
            left_at: new Date(leftAt).toISOString(),
            classified_by: "declared-expected-true",
          },
        ],
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
        expectedMembers: roster([{ name: "@agent/restart-onfailure", expected: true }]),
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
          state: "not-connected",
          classified_by: "declared-expected-true",
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
        expectedMembers: roster([{ name: "@agent/restart-live", expected: true }]),
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

  it("4. on-demand seat, harness-exited fact: dormant_launches, no discrepancy (24589: manner of death does not decide it)", () => {
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
      const opts = baseOpts({ expectedMembers: roster([{ name: "@adhoc/never-1", expected: false }]) })
      const members = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, opts)) as {
        membership_discrepancy?: unknown
        finished_launches?: unknown
        dormant_launches?: Array<Record<string, unknown>>
      }
      expect(members.membership_discrepancy).toBeUndefined()
      expect(members.finished_launches).toBeUndefined()
      expect(members.dormant_launches).toEqual([
        expect.objectContaining({
          member_id: "dem-1",
          name: "@adhoc/never-1",
          launch_id: "launch-dem-1",
          launch_parent_pid: 30004,
          state: "left",
          left_at: new Date(leftAt).toISOString(),
          classified_by: "declared-expected-false",
        }),
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
        { name: "@adhoc/never-quiet", expected: false },
        { name: "@chief/next", expected: false },
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
        expect.objectContaining({
          member_id: "dem-2",
          name: "@adhoc/never-quiet",
          launch_id: "launch-dem-2",
          state: "left",
        }),
        expect.objectContaining({
          member_id: "dem-3",
          name: "@chief/next",
          launch_id: "launch-dem-3",
          state: "left",
        }),
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

  it("6. undeclared name, any fact: departed_launches (with last_seen/left_at/reason/why), no discrepancy", () => {
    let now = 30_500_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const registeredAt = now
      const ctx = addSession(db, stmts, "und-1", "@proof/wait-rc4", { id: "launch-und-1", parentPid: 30007 })
      now += 1_000
      logSessionLeft(ctx, {
        memberId: "und-1",
        name: "@proof/wait-rc4",
        role: "member",
        domains: [],
        launchId: "launch-und-1",
        launchParentPid: 30007,
        reason: "harness-exited",
      })
      const leftAt = now
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
        {
          member_id: "und-1",
          name: "@proof/wait-rc4",
          launch_id: "launch-und-1",
          launch_parent_pid: 30007,
          state: "not-in-this-hab",
          last_seen: new Date(registeredAt).toISOString(),
          left_at: new Date(leftAt).toISOString(),
          reason: "harness-exited",
          // An empty declaration names nobody, so no family can ever match.
          why: "undeclared-foreign",
        },
      ])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("6a. undeclared sibling: a name sharing a declared family reads undeclared-sibling", () => {
    addSession(db, stmts, "sib-1", "@dev/0", { id: "launch-sib-1", parentPid: 30008 })
    addSession(db, stmts, "sib-2", "@dev/1", { id: "launch-sib-2", parentPid: 30108 })
    const opCtx = makeContext(db, stmts, "operator", "@operator")
    const opts = baseOpts({
      expectedMembers: roster([{ name: "@dev/1", expected: true }]),
      getActiveSessionIds: () => new Set(["sib-2"]),
      getActiveSessionInfo: () => [
        {
          id: "sib-2",
          name: "@dev/1",
          pid: 30108,
          cwd: "/repo",
          role: "member",
          claudeSessionId: null,
          registeredAt: Date.now(),
          launchId: "launch-sib-2",
          launchParentPid: 30108,
          transportPids: [30108],
        },
      ],
    })
    const members = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, opts)) as {
      membership_discrepancy?: unknown
      departed_launches?: Array<Record<string, unknown>>
    }
    expect(members.membership_discrepancy).toBeUndefined()
    expect(members.departed_launches).toEqual([
      expect.objectContaining({ member_id: "sib-1", name: "@dev/0", why: "undeclared-sibling" }),
    ])
  })

  it("6b. undeclared foreign: a name whose family matches no declared name reads undeclared-foreign", () => {
    addSession(db, stmts, "for-1", "@proof/x", { id: "launch-for-1", parentPid: 30009 })
    addSession(db, stmts, "for-2", "@dev/1", { id: "launch-for-2", parentPid: 30109 })
    const opCtx = makeContext(db, stmts, "operator", "@operator")
    const opts = baseOpts({
      expectedMembers: roster([{ name: "@dev/1", expected: true }]),
      getActiveSessionIds: () => new Set(["for-2"]),
      getActiveSessionInfo: () => [
        {
          id: "for-2",
          name: "@dev/1",
          pid: 30109,
          cwd: "/repo",
          role: "member",
          claudeSessionId: null,
          registeredAt: Date.now(),
          launchId: "launch-for-2",
          launchParentPid: 30109,
          transportPids: [30109],
        },
      ],
    })
    const members = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, opts)) as {
      membership_discrepancy?: unknown
      departed_launches?: Array<Record<string, unknown>>
    }
    expect(members.membership_discrepancy).toBeUndefined()
    expect(members.departed_launches).toEqual([
      expect.objectContaining({ member_id: "for-1", name: "@proof/x", why: "undeclared-foreign" }),
    ])
  })

  it("6c. undeclared foreign, no-slash name: the whole name is its own family", () => {
    addSession(db, stmts, "nosl-1", "session 1", { id: "launch-nosl-1", parentPid: 30010 })
    const opCtx = makeContext(db, stmts, "operator", "@operator")
    const opts = baseOpts({ expectedMembers: roster([{ name: "@dev/1", expected: true }]) })
    const members = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, opts)) as {
      departed_launches?: Array<Record<string, unknown>>
    }
    expect(members.departed_launches).toEqual([
      expect.objectContaining({ member_id: "nosl-1", name: "session 1", why: "undeclared-foreign" }),
    ])
  })

  it("5b. dormant rows carry last_seen, and left_at/reason only when a keyed fact exists", () => {
    let now = 30_250_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const quiet = addSession(db, stmts, "dorm-quiet", "@adhoc/7", { id: "launch-dorm-quiet", parentPid: 30071 })
      const quietSeen = now
      now += 1_000
      const closed = addSession(db, stmts, "dorm-closed", "@adhoc/8", { id: "launch-dorm-closed", parentPid: 30081 })
      const closedSeen = now
      now += 1_000
      logSessionLeft(closed, {
        memberId: "dorm-closed",
        name: "@adhoc/8",
        role: "member",
        domains: [],
        launchId: "launch-dorm-closed",
        launchParentPid: 30081,
        reason: "transport-closed",
      })
      const closedLeft = now
      void quiet
      const opCtx = makeContext(db, stmts, "operator", "@operator")
      const opts = baseOpts({
        expectedMembers: roster([
          { name: "@adhoc/7", expected: false },
          { name: "@adhoc/8", expected: false },
        ]),
      })
      const members = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, opts)) as {
        membership_discrepancy?: unknown
        dormant_launches?: Array<Record<string, unknown>>
      }
      expect(members.membership_discrepancy).toBeUndefined()
      expect(members.dormant_launches).toEqual([
        {
          member_id: "dorm-quiet",
          name: "@adhoc/7",
          launch_id: "launch-dorm-quiet",
          launch_parent_pid: 30071,
          state: "left",
          last_seen: new Date(quietSeen).toISOString(),
          classified_by: "declared-expected-false",
        },
        {
          member_id: "dorm-closed",
          name: "@adhoc/8",
          launch_id: "launch-dorm-closed",
          launch_parent_pid: 30081,
          state: "left",
          last_seen: new Date(closedSeen).toISOString(),
          left_at: new Date(closedLeft).toISOString(),
          reason: "transport-closed",
          classified_by: "declared-expected-false",
        },
      ])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("7. expected name with no row at all: missing state never-registered", () => {
    const opCtx = makeContext(db, stmts, "operator", "@operator")
    const opts = baseOpts({ expectedMembers: roster([{ name: "@dev/12", expected: true }]) })
    const members = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, opts)) as {
      membership_discrepancy?: Record<string, unknown>
    }
    // known/connected durable launches keep their row meaning: there is no row
    // at all here, so both are 0 while the declaration says one seat is expected.
    expect(members.membership_discrepancy).toEqual({
      status: "degraded",
      connected_durable_launches: 0,
      known_durable_launches: 0,
      expected_count: 1,
      connected_expected_count: 0,
      roster_loaded_at: expect.any(String),
      missing_count: 1,
      missing: [{ name: "@dev/12", state: "never-registered" }],
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
            state: "not-connected",
          },
        ],
        finished_count: 1,
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
    [JSON.stringify({ name: "@a", expected: true }), /JSON array/],
    [JSON.stringify([{ expected: true }]), /name must be a non-empty string/],
    [JSON.stringify([{ name: "@a" }]), /expected must be a boolean/],
    [JSON.stringify([{ name: "@a", expected: "yes" }]), /expected must be a boolean/],
    [JSON.stringify([{ name: "@a", expected: true, extra: true }]), /unknown keys/],
    [
      JSON.stringify([
        { name: "@a", expected: true },
        { name: "@a", expected: false },
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
      expectedMembers: roster([{ name: "@agent/restart-always", expected: true }]),
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

/**
 * @i/24589-4-supervision: expected:false must classify dormant whether the
 * seat exited cleanly or died. Current code still routes a settled
 * harness-exited on-demand row to finished_launches (test 4 above), and the
 * classification does not name which input decided the class — so a reader
 * cannot tell "dormant because declared" from "dormant because it closed
 * politely". The negative control is load-bearing: without it, classifying
 * everything dormant would satisfy the first row.
 */
describe("24589: expected:false is dormant regardless of manner of death", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "membership-24589-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    vi.useRealTimers()
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("on-demand crash with no left fact is dormant, not missing-transport", () => {
    addSession(db, stmts, "crash-1", "@dev/5", { id: "launch-crash-1", parentPid: 40001 })
    const opCtx = makeContext(db, stmts, "operator", "@operator")
    const opts = baseOpts({ expectedMembers: roster([{ name: "@dev/5", expected: false }]) })
    const members = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, opts)) as {
      membership_discrepancy?: unknown
      dormant_launches?: Array<Record<string, unknown>>
    }
    expect(members.membership_discrepancy).toBeUndefined()
    expect(members.dormant_launches).toEqual([
      expect.objectContaining({
        member_id: "crash-1",
        name: "@dev/5",
        state: "left",
        classified_by: "declared-expected-false",
      }),
    ])
  })

  it("on-demand harness-exited is also dormant — manner of death does not decide it", () => {
    let now = 40_000_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const ctx = addSession(db, stmts, "exit-1", "@dev/7", { id: "launch-exit-1", parentPid: 40002 })
      now += 1_000
      logSessionLeft(ctx, {
        memberId: "exit-1",
        name: "@dev/7",
        role: "member",
        domains: [],
        launchId: "launch-exit-1",
        launchParentPid: 40002,
        reason: "harness-exited",
      })
      const opCtx = makeContext(db, stmts, "operator", "@operator")
      const opts = baseOpts({ expectedMembers: roster([{ name: "@dev/7", expected: false }]) })
      const members = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, opts)) as {
        membership_discrepancy?: unknown
        finished_launches?: unknown
        dormant_launches?: Array<Record<string, unknown>>
      }
      expect(members.membership_discrepancy).toBeUndefined()
      expect(members.finished_launches).toBeUndefined()
      expect(members.dormant_launches).toEqual([
        expect.objectContaining({
          member_id: "exit-1",
          name: "@dev/7",
          state: "left",
          classified_by: "declared-expected-false",
        }),
      ])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("NEGATIVE CONTROL: expected:true crash with no left fact is still missing-transport", () => {
    addSession(db, stmts, "need-1", "@chief", { id: "launch-need-1", parentPid: 40003 })
    const opCtx = makeContext(db, stmts, "operator", "@operator")
    const opts = baseOpts({ expectedMembers: roster([{ name: "@chief", expected: true }]) })
    const members = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, opts)) as {
      membership_discrepancy?: { missing?: Array<Record<string, unknown>>; missing_count?: number }
      dormant_launches?: unknown
    }
    expect(members.dormant_launches).toBeUndefined()
    expect(members.membership_discrepancy?.missing_count).toBe(1)
    expect(members.membership_discrepancy?.missing).toEqual([
      expect.objectContaining({
        member_id: "need-1",
        name: "@chief",
        state: "not-connected",
        classified_by: "declared-expected-true",
      }),
    ])
  })

  it("expected_count is never present without roster_loaded_at, and members carries the age even with no discrepancy", () => {
    let now = 50_000_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const loadedAt = new Date(now).toISOString()
      addSession(db, stmts, "live-1", "@chief", { id: "launch-live-1", parentPid: 50001 })
      const opCtx = makeContext(db, stmts, "operator", "@operator")
      const liveOpts = baseOpts({
        expectedMembers: roster([{ name: "@chief", expected: true }]),
        getActiveSessionIds: () => new Set(["live-1"]),
        hasActiveTransport: () => true,
        getActiveSessionInfo: () => [
          {
            id: "live-1",
            name: "@chief",
            pid: 50001,
            cwd: "/repo",
            role: "member",
            claudeSessionId: null,
            registeredAt: now,
            launchId: "launch-live-1",
            launchParentPid: 50001,
            transportPids: [50001],
          },
        ],
      })
      const live = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, liveOpts)) as {
        roster_loaded_at?: string
        membership_discrepancy?: { expected_count?: number; roster_loaded_at?: string }
      }
      expect(live.membership_discrepancy).toBeUndefined()
      expect(live.roster_loaded_at).toBe(loadedAt)

      addSession(db, stmts, "gone-1", "@dev/6", { id: "launch-gone-1", parentPid: 50002 })
      const goneOpts = baseOpts({ expectedMembers: roster([{ name: "@dev/6", expected: true }]) })
      const gone = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, goneOpts)) as {
        roster_loaded_at?: string
        membership_discrepancy?: { expected_count?: number; roster_loaded_at?: string }
      }
      expect(gone.roster_loaded_at).toBe(loadedAt)
      expect(gone.membership_discrepancy?.expected_count).toBe(1)
      expect(gone.membership_discrepancy?.roster_loaded_at).toBe(loadedAt)
    } finally {
      nowSpy.mockRestore()
    }
  })
})
