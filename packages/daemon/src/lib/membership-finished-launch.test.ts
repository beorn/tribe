/**
 * @failure A durable launch that ended cleanly (its adapter disconnected and
 * never came back) is reported identically to one that vanished without a
 * trace: `tribe.members` / `tribe.health` count both as `missing-transport`
 * and set `membership_discrepancy.status = "degraded"` forever, so operators
 * learn to ignore a signal that is permanently red.
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
import { registerSession } from "./session.ts"

const PROJECT_ID = "membership-finished-launch"

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
 *  `isActive` is hard-coded false: none of these fixtures collide on name
 *  with another row this helper itself just created under a DIFFERENT id,
 *  so eviction/auto-suffix never engages — see the "restart" test below for
 *  why two rows can never share one `name` (the table enforces UNIQUE(name)). */
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

describe("membership projection: a finished launch is history, not a degraded membership (@ag/tribe/tribe-membership-projection-counts-permanent-history-as-degraded)", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "membership-finished-launch-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    vi.useRealTimers()
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("writes the departure fact with ref=member_id and launch identity in its content (smallest exported helper the dispatcher's disconnect path calls through)", () => {
    // Exercising the real socket dispatcher for one payload-shape change is
    // disproportionate (its harness in with-dispatcher-self-registration.test.ts
    // is a 2500+ line live node:net server). logSessionLeft is the exact,
    // fully-exported helper with-dispatcher.ts's socket-close handler calls
    // through for this write, so it is tested directly instead.
    const ctx = makeContext(db, stmts, "helper-1", "@agent/6")
    logSessionLeft(ctx, {
      memberId: "helper-1",
      name: "@agent/6",
      role: "member",
      domains: ["docs"],
      launchId: "launch-6",
      launchParentPid: 6006,
    })
    const row = db.prepare("SELECT ref, type, content FROM messages WHERE type = 'event.session.left'").get() as {
      ref: string
      type: string
      content: string
    }
    expect(row.ref).toBe("helper-1")
    expect(JSON.parse(row.content)).toEqual({
      name: "@agent/6",
      role: "member",
      domains: ["docs"],
      member_id: "helper-1",
      launch_id: "launch-6",
      launch_parent_pid: 6006,
    })
  })

  it("finished: classifies a disconnected durable launch as finished when its departure fact is the last thing that happened to it", () => {
    let now = 1_000_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const ctx = addSession(db, stmts, "finished-1", "@agent/9", { id: "launch-9", parentPid: 9009 })
      now += 1_000 // departs strictly after registration
      logSessionLeft(ctx, {
        memberId: "finished-1",
        name: "@agent/9",
        role: "member",
        domains: [],
        launchId: "launch-9",
        launchParentPid: 9009,
      })
      const leftAt = now

      const opCtx = makeContext(db, stmts, "operator", "@operator")
      const opts = baseOpts()

      const members = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, opts)) as {
        membership_discrepancy?: Record<string, unknown>
        finished_launches?: Array<Record<string, unknown>>
      }
      expect(members.membership_discrepancy).toBeUndefined()
      expect(members.finished_launches).toEqual([
        {
          member_id: "finished-1",
          name: "@agent/9",
          launch_id: "launch-9",
          launch_parent_pid: 9009,
          state: "finished",
          left_at: new Date(leftAt).toISOString(),
        },
      ])

      const health = parseToolJson(handleToolCall(opCtx, "tribe.health", {}, opts)) as {
        membership_discrepancy?: Record<string, unknown>
        finished_launches?: unknown
      }
      expect(health.membership_discrepancy).toBeUndefined()
      expect(health.finished_launches).toBeUndefined()
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("vanished: keeps a disconnected durable launch missing-transport (degraded) when no departure fact was ever journaled", () => {
    addSession(db, stmts, "vanished-1", "@agent/10", { id: "launch-10", parentPid: 10010 })
    const opCtx = makeContext(db, stmts, "operator", "@operator")
    const opts = baseOpts()

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
          member_id: "vanished-1",
          name: "@agent/10",
          launch_id: "launch-10",
          launch_parent_pid: 10010,
          state: "missing-transport",
        },
      ],
      meaning: "missing transport does not establish agent absence",
    })
    expect(members.finished_launches).toBeUndefined()

    const health = parseToolJson(handleToolCall(opCtx, "tribe.health", {}, opts)) as {
      membership_discrepancy?: Record<string, unknown>
    }
    expect(health.membership_discrepancy).toEqual(members.membership_discrepancy)
  })

  it("the trap: never promotes a stale departure fact across a later re-registration of the same row", () => {
    let now = 2_000_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const ctx = addSession(db, stmts, "trap-1", "@agent/11", { id: "launch-11", parentPid: 11011 })
      now += 1_000 // T1: departs
      logSessionLeft(ctx, {
        memberId: "trap-1",
        name: "@agent/11",
        role: "member",
        domains: [],
        launchId: "launch-11",
        launchParentPid: 11011,
      })
      now += 1_000 // T2 > T1: re-registers under the SAME session id, bumping updated_at past the T1 fact
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
        "launch-11",
        11011,
      )
      // ...then disconnects again with no NEW session.left fact.

      const opCtx = makeContext(db, stmts, "operator", "@operator")
      const members = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, baseOpts())) as {
        membership_discrepancy?: { missing: Array<Record<string, unknown>>; missing_count: number }
        finished_launches?: unknown
      }
      expect(members.membership_discrepancy?.missing).toEqual([
        {
          member_id: "trap-1",
          name: "@agent/11",
          launch_id: "launch-11",
          launch_parent_pid: 11011,
          state: "missing-transport",
        },
      ])
      expect(members.membership_discrepancy?.missing_count).toBe(1)
      expect(members.finished_launches).toBeUndefined()
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("restart under the same seat: an old finished launch and a new active launch are classified independently, and only the new one degrades when it later vanishes", () => {
    // The `sessions` table enforces UNIQUE(name) (database.ts CREATE TABLE),
    // so two rows can never share one literal `name` value at the same
    // time — registerSession's own name-collision handling evicts an
    // inactive same-named holder the instant a new session claims its name.
    // What matters for this bead is that finished/missing classification is
    // keyed by the row's own id, never by name, so an old finished launch
    // and a new launch of "the same seat" cannot be conflated even though
    // an operator would describe them as one seat restarting. Two distinct
    // row names model that restart without fighting the schema constraint.
    let now = 3_000_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      addSession(db, stmts, "restart-old", "@agent/12", { id: "launch-12-old", parentPid: 12012 })
      now += 1_000
      logSessionLeft(makeContext(db, stmts, "restart-old", "@agent/12"), {
        memberId: "restart-old",
        name: "@agent/12",
        role: "member",
        domains: [],
        launchId: "launch-12-old",
        launchParentPid: 12012,
      })
      const oldLeftAt = now
      now += 1_000
      addSession(db, stmts, "restart-new", "@agent/12-restarted", { id: "launch-12-new", parentPid: 12013 })

      const opCtx = makeContext(db, stmts, "operator", "@operator")
      const activeOpts = baseOpts({
        getActiveSessionIds: () => new Set(["restart-new"]),
        hasActiveTransport: (id) => id === "restart-new",
        getActiveSessionInfo: () => [
          {
            id: "restart-new",
            name: "@agent/12-restarted",
            pid: 12013,
            cwd: "/repo",
            role: "member",
            claudeSessionId: null,
            registeredAt: now,
            launchId: "launch-12-new",
            launchParentPid: 12013,
            transportPids: [12013],
          },
        ],
      })

      const whileNewIsUp = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, activeOpts)) as {
        membership_discrepancy?: unknown
        finished_launches?: Array<Record<string, unknown>>
      }
      expect(whileNewIsUp.membership_discrepancy).toBeUndefined()
      expect(whileNewIsUp.finished_launches).toEqual([
        {
          member_id: "restart-old",
          name: "@agent/12",
          launch_id: "launch-12-old",
          launch_parent_pid: 12012,
          state: "finished",
          left_at: new Date(oldLeftAt).toISOString(),
        },
      ])

      // The new launch now vanishes without ever writing a departure fact.
      const afterNewVanishes = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, baseOpts())) as {
        membership_discrepancy?: {
          missing: Array<Record<string, unknown>>
          missing_count: number
          finished_count?: number
        }
        finished_launches?: Array<Record<string, unknown>>
      }
      expect(afterNewVanishes.membership_discrepancy?.missing).toEqual([
        {
          member_id: "restart-new",
          name: "@agent/12-restarted",
          launch_id: "launch-12-new",
          launch_parent_pid: 12013,
          state: "missing-transport",
        },
      ])
      expect(afterNewVanishes.membership_discrepancy?.missing_count).toBe(1)
      expect(afterNewVanishes.membership_discrepancy?.finished_count).toBe(1)
      expect(afterNewVanishes.finished_launches).toEqual([
        expect.objectContaining({ member_id: "restart-old", launch_id: "launch-12-old", state: "finished" }),
      ])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("both tiers: finishes a launch whose departure fact already migrated into the archive tier", () => {
    addSession(db, stmts, "archived-1", "@agent/13", { id: "launch-13", parentPid: 13013 })
    const registered = db.prepare("SELECT updated_at FROM sessions WHERE id = ?").get("archived-1") as {
      updated_at: number
    }
    const leftAt = registered.updated_at + 5_000
    db.prepare(
      `INSERT INTO messages_archive
         (seq, id, type, sender, recipient, kind, content, bead_id, ref, ts,
          delivery, topic, room_id, archived_at, request, reply, correlated_reply_requester, summary, session_id, attention_required)
       VALUES
         ($seq, $id, $type, $sender, $recipient, $kind, $content, NULL, $ref, $ts,
          'push', NULL, NULL, $archived_at, NULL, NULL, NULL, NULL, $session_id, 0)`,
    ).run({
      $seq: 1,
      $id: "archived-left-1",
      $type: "event.session.left",
      $sender: "@agent/13",
      $recipient: "*",
      $kind: "event",
      $content: JSON.stringify({
        name: "@agent/13",
        role: "member",
        domains: [],
        member_id: "archived-1",
        launch_id: "launch-13",
        launch_parent_pid: 13013,
      }),
      $ref: "archived-1",
      $ts: leftAt,
      $archived_at: leftAt + 1_000,
      $session_id: "archived-1",
    })

    const opCtx = makeContext(db, stmts, "operator", "@operator")
    const members = parseToolJson(handleToolCall(opCtx, "tribe.members", {}, baseOpts())) as {
      membership_discrepancy?: unknown
      finished_launches?: Array<Record<string, unknown>>
    }
    expect(members.membership_discrepancy).toBeUndefined()
    expect(members.finished_launches).toEqual([
      {
        member_id: "archived-1",
        name: "@agent/13",
        launch_id: "launch-13",
        launch_parent_pid: 13013,
        state: "finished",
        left_at: new Date(leftAt).toISOString(),
      },
    ])
  })

  it("the retired-name path stays as it was: an explicitly retired name is excluded before finished/missing classification even runs", () => {
    const ctx = addSession(db, stmts, "retired-1", "@fleet", { id: "launch-fleet-1", parentPid: 20001 })
    logSessionLeft(ctx, {
      memberId: "retired-1",
      name: "@fleet",
      role: "member",
      domains: [],
      launchId: "launch-fleet-1",
      launchParentPid: 20001,
    })
    const opCtx = makeContext(db, stmts, "operator", "@operator")
    const opts = baseOpts({ retiredNames: new Set(["@fleet"]) })

    const members = parseToolJson(handleToolCall(opCtx, "tribe.members", { all: true }, opts)) as {
      membership_discrepancy?: unknown
      finished_launches?: unknown
      sessions: Array<Record<string, unknown>>
    }
    expect(members.membership_discrepancy).toBeUndefined()
    expect(members.finished_launches).toBeUndefined()
    expect(members.sessions).toContainEqual(expect.objectContaining({ member_id: "retired-1", name: "@fleet" }))

    const health = parseToolJson(handleToolCall(opCtx, "tribe.health", {}, opts)) as {
      membership_discrepancy?: unknown
    }
    expect(health.membership_discrepancy).toBeUndefined()
  })
})
