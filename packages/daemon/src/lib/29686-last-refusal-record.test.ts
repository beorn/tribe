/**
 * @failure With no record of the LAST register refusal held per session, a seat whose connector the daemon
 * actively refused reads on `tribe.members` exactly like a seat whose transport merely dropped: the refusal
 * leaves no trace on the wire once the refused transport is gone, so a reader cannot tell "the server said no"
 * from "the bridge fell down". The one field that does carry a refusal today (`foreign_transport`) exists for a
 * single kind, on `missing-transport` rows only — every other kind (an absent persona token, a faulting
 * verifier, a name mismatch, a contradicted token, an undecided verdict, a verdict with no generation) is
 * silently absent, and an `exited-not-remounted` row cannot carry one at all (#29686, writer half).
 * @level l1
 * @consumer Tribe operators reading `tribe.members`, and the WATCH bridge diagnosis that reads it.
 * @testonly none
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

const PROJECT_ID = "29686-last-refusal-record"

/** Every kind the register path composes: with-dispatcher.ts:1311 (token missing), :1358 (verifier fault),
 *  :1379 (name mismatch), :1386 (contradicted), :1407 (undecided), :1841 (verdict without gen) and
 *  :2283/:2302 (a transport claiming a seat a live holder keeps). */
const REGISTER_REFUSAL_KINDS = [
  "identity-token-missing",
  "identity-verifier-fault",
  "identity-name-mismatch",
  "identity-contradicted",
  "identity-undecided",
  "identity-verdict-without-gen",
  "foreign-identity-transport",
] as const

/** The daemon's one bounded record per session: the LAST refusal, overwritten by the next one, held until a
 *  real transport connects or `forgetTransportSessions` runs. */
type LastRefusal = {
  readonly kind: string
  readonly claimed: string
  readonly reason?: string
  readonly launch_id: string
  readonly pid: number
  readonly refused_at: string
}

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

/** Registers a durable launch row that holds no transport (`isActive` is hard-coded false, exactly as
 *  membership-declared-roster.test.ts's identical helper does). */
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

/** `HandlerOpts` plus the one reader this bead adds: `getLastRefusal` is not on `HandlerOpts` yet, and the
 *  whole object is cast in the same shape membership-declared-roster.test.ts's identical helper uses. */
type HandlerOptsWithLastRefusal = Partial<HandlerOpts> & {
  getLastRefusal?: (sessionId: string) => LastRefusal | undefined
}

function baseOpts(overrides: HandlerOptsWithLastRefusal = {}): HandlerOpts {
  return {
    cleanup: () => {},
    userRenamed: false,
    setUserRenamed: () => {},
    getActiveSessionIds: () => new Set<string>(),
    hasActiveTransport: () => false,
    getActiveSessionInfo: () => [],
    isPidAlive: () => true,
    ...overrides,
  } as HandlerOpts
}

/** Built the way the daemon parses `TRIBE_EXPECTED_MEMBERS`, never hand-assembled. */
function roster(members: Array<{ name: string; expected: boolean }>): DeclaredRoster {
  return parseExpectedMembers(JSON.stringify(members))!
}

function refusalFor(kind: string, claimed: string, overrides: Partial<LastRefusal> = {}): LastRefusal {
  return {
    kind,
    claimed,
    launch_id: "sid-29686-refused",
    pid: 60_123,
    refused_at: "2026-10-17T03:14:15.926Z",
    ...overrides,
  }
}

type MembersReply = {
  missing: Array<Record<string, unknown>>
  sessions: Array<Record<string, unknown>>
}

function membersReply(opCtx: TribeContext, opts: HandlerOpts): MembersReply {
  const members = parseToolJson(handleToolCall(opCtx, "tribe.members", { all: true }, opts))
  const discrepancy = members.membership_discrepancy as { missing?: Array<Record<string, unknown>> } | undefined
  return {
    missing: discrepancy?.missing ?? [],
    sessions: (members.sessions as Array<Record<string, unknown>> | undefined) ?? [],
  }
}

const entryFor = (reply: MembersReply, name: string): Record<string, unknown> | undefined =>
  reply.missing.find((entry) => entry.name === name)

const rowFor = (reply: MembersReply, name: string): Record<string, unknown> | undefined =>
  reply.sessions.find((row) => row.name === name)

describe("29686 — one bounded last-refusal record per session, published on the tribe.members wire", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "29686-last-refusal-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    vi.useRealTimers()
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it.each(REGISTER_REFUSAL_KINDS)("(a) a last refusal of kind %s reaches the roster as last_refusal.kind", (kind) => {
    const slug = kind.replace(/[^a-z0-9]+/gu, "-")
    const sessionId = `ref-${slug}`
    const name = `@agent/${slug}`
    addSession(db, stmts, sessionId, name, { id: `launch-${slug}`, parentPid: 60_101 })
    const refusal = refusalFor(kind, name)
    const opCtx = makeContext(db, stmts, "operator", "@operator")
    const opts = baseOpts({
      getExpectedMembers: () => roster([{ name, expected: true }]),
      getLastRefusal: (candidate) => (candidate === sessionId ? refusal : undefined),
    })

    const reply = membersReply(opCtx, opts)
    const entry = entryFor(reply, name)
    expect(entry, `${name} on membership_discrepancy.missing`).toMatchObject({ name, state: "missing-transport" })
    expect(entry?.last_refusal, `${name} last_refusal`).toMatchObject({
      kind,
      claimed: name,
      launch_id: refusal.launch_id,
      pid: refusal.pid,
      refused_at: refusal.refused_at,
    })
  })

  it("(a-row) the same record rides the row spread at handlers.ts:3561, beside foreign_transport", () => {
    const sessionId = "ref-row"
    const name = "@agent/row-refused"
    addSession(db, stmts, sessionId, name, { id: "launch-row-refused", parentPid: 60_102 })
    const refusal = refusalFor("identity-verifier-fault", name)
    const opCtx = makeContext(db, stmts, "operator", "@operator")
    const opts = baseOpts({
      getExpectedMembers: () => roster([{ name, expected: true }]),
      getLastRefusal: (candidate) => (candidate === sessionId ? refusal : undefined),
    })

    const reply = membersReply(opCtx, opts)
    expect(rowFor(reply, name)?.last_refusal, `${name} session row`).toMatchObject({ kind: "identity-verifier-fault" })
  })

  it("(b) an exited-not-remounted entry carries last_refusal too, not only missing-transport rows", () => {
    let now = 60_200_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const sessionId = "ref-exited"
      const name = "@agent/exited-refused"
      const ctx = addSession(db, stmts, sessionId, name, { id: "launch-exited-refused", parentPid: 60_103 })
      now += 1_000
      logSessionLeft(ctx, {
        memberId: sessionId,
        name,
        role: "member",
        domains: [],
        launchId: "launch-exited-refused",
        launchParentPid: 60_103,
        reason: "harness-exited",
      })
      const leftAt = now
      const refusal = refusalFor("identity-contradicted", name)
      const opCtx = makeContext(db, stmts, "operator", "@operator")
      const opts = baseOpts({
        getExpectedMembers: () => roster([{ name, expected: true }]),
        getLastRefusal: (candidate) => (candidate === sessionId ? refusal : undefined),
      })

      const reply = membersReply(opCtx, opts)
      const entry = entryFor(reply, name)
      expect(entry).toMatchObject({
        name,
        state: "exited-not-remounted",
        left_at: new Date(leftAt).toISOString(),
      })
      expect(entry?.last_refusal, `${name} last_refusal on a settled exit`).toMatchObject({
        kind: "identity-contradicted",
        claimed: name,
      })
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("(c) a cleared record leaves no last_refusal: neither after a real transport connects nor after forgetTransportSessions", () => {
    const sessionId = "ref-cleared"
    const name = "@agent/cleared"
    addSession(db, stmts, sessionId, name, { id: "launch-cleared", parentPid: 60_104 })
    // The daemon's store: one record per session, cleared by a real transport connecting and by
    // forgetTransportSessions (with-client-registry.ts:303-315). A refused connection never becomes a member, so
    // this map — not the ClientSession registry — is what holds it; the wire sees only its effect.
    const stored = new Map<string, LastRefusal>([[sessionId, refusalFor("identity-name-mismatch", name)]])
    const connected = new Set<string>()
    const opCtx = makeContext(db, stmts, "operator", "@operator")
    const opts = baseOpts({
      getExpectedMembers: () => roster([{ name, expected: true }]),
      getActiveSessionIds: () => connected,
      getLastRefusal: (candidate) => stored.get(candidate),
    })

    expect(entryFor(membersReply(opCtx, opts), name)?.last_refusal).toMatchObject({ kind: "identity-name-mismatch" })

    // A real transport connects: the row becomes active and the record is gone.
    connected.add(sessionId)
    stored.delete(sessionId)
    const afterConnect = membersReply(opCtx, opts)
    expect(entryFor(afterConnect, name)).toBeUndefined()
    expect(rowFor(afterConnect, name), `${name} connected row`).not.toHaveProperty("last_refusal")

    // Same for the reaper: forgetTransportSessions drops the record of a session whose durable row is gone.
    connected.delete(sessionId)
    stored.set(sessionId, refusalFor("identity-verifier-fault", name))
    expect(entryFor(membersReply(opCtx, opts), name)?.last_refusal).toMatchObject({ kind: "identity-verifier-fault" })
    stored.delete(sessionId)
    const afterForget = membersReply(opCtx, opts)
    expect(entryFor(afterForget, name), `${name} after forgetTransportSessions`).not.toHaveProperty("last_refusal")
  })

  it("(d) a foreign-identity refusal keeps the row shape it has today, and gains last_refusal beside it", () => {
    const sessionId = "ref-foreign"
    const name = "@dev/7"
    addSession(db, stmts, sessionId, name, { id: "launch-dev7", parentPid: 60_105 })
    const refusedAt = "2026-10-17T03:14:15.926Z"
    const foreignTransport = { name: "@dev/8", launch_id: "sid-dev8", pid: 4_801, refused_at: refusedAt }
    const refusal: LastRefusal = {
      kind: "foreign-identity-transport",
      claimed: "@dev/8",
      reason: "identity-precedence",
      launch_id: "sid-dev8",
      pid: 4_801,
      refused_at: refusedAt,
    }
    const opCtx = makeContext(db, stmts, "operator", "@operator")
    const opts = baseOpts({
      getExpectedMembers: () => roster([{ name, expected: true }]),
      getForeignIdentityTransport: (candidate) => (candidate === sessionId ? foreignTransport : undefined),
      getLastRefusal: (candidate) => (candidate === sessionId ? refusal : undefined),
    })

    const entry = entryFor(membersReply(opCtx, opts), name)
    expect(entry).toMatchObject({ name, state: "foreign-identity-transport" })
    // The compatibility requirement: the four fields this row has always carried, and nothing else.
    expect(entry?.foreign_transport).toEqual(foreignTransport)
    expect(Object.keys(entry?.foreign_transport as object).sort()).toEqual(["launch_id", "name", "pid", "refused_at"])
    expect(entry?.last_refusal, `${name} last_refusal`).toMatchObject({ kind: "foreign-identity-transport" })
  })
})
