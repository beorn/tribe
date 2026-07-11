/**
 * @km/tribe/19975 — tribe.members must reflect the ACTUAL provider/account
 * after a later join/refresh.
 *
 * Bug: a session's account/provider label was only written at register time.
 * `tribe.join` did not forward account/provider, and the join handler updated
 * name/role/domains but left account/provider untouched — so a row that began
 * life with stale labels (e.g. a Codex @chief whose row was first seeded with
 * provider=claude / account=bjorns@gmail.com) never self-corrected, and
 * tribe.members reported the wrong account → wrong chief routing decisions.
 *
 * Fix contract proven here:
 *  (1) A later join carrying the real labels CORRECTS provider/account, and
 *      tribe.members reflects the corrected values.
 *  (2) A join that omits account/provider PRESERVES the existing labels
 *      (COALESCE semantics — a join from a context with no env must not wipe a
 *      good label).
 *  (3) Correction is per-field: a join that carries only provider corrects
 *      provider and leaves account intact.
 */

import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { createTribeContext, type TribeContext } from "./context.ts"
import { registerSession, sweepDeadSessionRows } from "./session.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"

const PROJECT_ID = "acct-provider-proj"

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

function makeOpts(activeIds: Set<string>): HandlerOpts {
  return {
    cleanup: () => {},
    userRenamed: false,
    setUserRenamed: () => {},
    getActiveSessionIds: () => activeIds,
    getActiveSessionInfo: () => [],
  }
}

type MembersSession = { name: string; account?: string; provider?: string }

function membersFor(ctx: TribeContext, opts: HandlerOpts, name: string): MembersSession | undefined {
  const result = handleToolCall(ctx, "tribe.members", {}, opts) as { content: Array<{ text: string }> }
  const data = JSON.parse(result.content[0]?.text ?? "{}") as { sessions?: MembersSession[] }
  return (data.sessions ?? []).find((s) => s.name === name)
}

describe("@km/tribe/19975 — join/refresh corrects provider/account", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acct-provider-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("a later join with real labels corrects a stale provider/account", () => {
    const sessionId = "sess-chief"
    const ctx = makeContext(db, stmts, sessionId, "@chief")
    const opts = makeOpts(new Set([sessionId]))

    // Register with STALE labels (the row a Codex chief inherited).
    registerSession(ctx, PROJECT_ID, () => true, null, 4321, "push", "/repo", "bjorns@gmail.com", "claude")

    const baseline = membersFor(ctx, opts, "@chief")
    expect(baseline).toMatchObject({ account: "bjorns@gmail.com", provider: "claude" })

    // The corrective join — /up always re-joins, now carrying the real labels.
    handleToolCall(ctx, "tribe.join", { name: "@chief", account: "d@delei.org", provider: "codex" }, opts)

    const corrected = membersFor(ctx, opts, "@chief")
    expect(corrected).toMatchObject({ account: "d@delei.org", provider: "codex" })
  })

  it("sweepDeadSessionRows GCs only -dead- tombstones older than the max age (21052)", () => {
    const now = Date.now()
    const mk = (sid: string, name: string) => {
      const c = makeContext(db, stmts, sid, name)
      registerSession(c, PROJECT_ID, () => false, null, 1234, "pull", "/repo", null, null)
    }
    mk("s-old-dead", "@agent/5-dead-aaaa1111")
    mk("s-fresh-dead", "@agent/5-dead-bbbb2222")
    mk("s-live", "@agent/5")
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = 's-old-dead'").run(now - 8 * 24 * 3600 * 1000)

    const swept = sweepDeadSessionRows(db, 7 * 24 * 3600 * 1000, now)

    expect(swept).toBe(1)
    const names = (db.prepare("SELECT name FROM sessions").all() as Array<{ name: string }>).map((r) => r.name).sort()
    expect(names).toEqual(["@agent/5", "@agent/5-dead-bbbb2222"])
  })

  it("a join without a prior self-row records the connected client's real pid, not 0 (21052)", () => {
    const sessionId = "sess-cli-join"
    const ctx = makeContext(db, stmts, sessionId, "@agent/7")
    const opts: HandlerOpts = {
      ...makeOpts(new Set([sessionId])),
      getActiveSessionInfo: () => [
        {
          id: sessionId,
          name: "@agent/7",
          pid: 4242,
          role: "member",
          claudeSessionId: null,
          registeredAt: Date.now(),
          launchId: null,
          launchParentPid: null,
          transportPids: [4242],
        },
      ],
    }

    // NO registerSession first — the join's late-registration branch
    // (hasSelfRow=false) previously hardcoded pid 0, planting rows that defeat
    // every isPidAlive liveness check downstream (the 19442 pid-0 ghost class).
    handleToolCall(ctx, "tribe.join", { name: "@agent/7", delivery: "pull" }, opts)

    const row = db.prepare("SELECT pid FROM sessions WHERE id = ?").get(sessionId) as { pid: number } | null
    expect(row?.pid).toBe(4242)
  })

  it("a join that omits account/provider preserves the existing labels", () => {
    const sessionId = "sess-agent"
    const ctx = makeContext(db, stmts, sessionId, "@agent/6")
    const opts = makeOpts(new Set([sessionId]))

    registerSession(ctx, PROJECT_ID, () => true, null, 9876, "push", "/repo", "acc1@x.org", "claude")

    // Join with no labels (a context where TRIBE_ACCOUNT/TRIBE_PROVIDER aren't set).
    handleToolCall(ctx, "tribe.join", { name: "@agent/6" }, opts)

    const after = membersFor(ctx, opts, "@agent/6")
    expect(after).toMatchObject({ account: "acc1@x.org", provider: "claude" })
  })

  it("correction is per-field — a provider-only join leaves account intact", () => {
    const sessionId = "sess-mixed"
    const ctx = makeContext(db, stmts, sessionId, "@agent/2")
    const opts = makeOpts(new Set([sessionId]))

    registerSession(ctx, PROJECT_ID, () => true, null, 1111, "push", "/repo", "keep@x.org", "claude")

    handleToolCall(ctx, "tribe.join", { name: "@agent/2", provider: "codex" }, opts)

    const after = membersFor(ctx, opts, "@agent/2")
    expect(after).toMatchObject({ account: "keep@x.org", provider: "codex" })
  })

  it("join persists a session row when the caller was only live in the daemon client map", () => {
    const sessionId = "sess-pending-only"
    const ctx = makeContext(db, stmts, sessionId, "pending-abc123")
    const opts = makeOpts(new Set([sessionId]))
    const historic = stmts.insertMessage.run({
      $id: "historic-chief-request",
      $type: "request",
      $sender: "@agent/1",
      $recipient: "@chief",
      $kind: "direct",
      $content: "old request before the pending-only client joined",
      $bead_id: null,
      $ref: null,
      $ts: Date.now() - 13 * 60 * 60 * 1000,
      $delivery: "pull",
      $topic: null,
      $room_id: null,
      $request: null,
      $reply: null,
    })

    handleToolCall(ctx, "tribe.join", { name: "@chief", delivery: "pull", provider: "codex" }, opts)

    const row = db
      .prepare("SELECT id, name, role, delivery, provider, last_inbox_pull_seq FROM sessions WHERE id = ?")
      .get(sessionId) as {
      id: string
      name: string
      role: string
      delivery: string
      provider: string
      last_inbox_pull_seq: number
    } | null
    expect(row).toMatchObject({
      id: sessionId,
      name: "@chief",
      role: "member",
      delivery: "pull",
      provider: "codex",
    })
    expect(row?.last_inbox_pull_seq).toBeGreaterThanOrEqual(Number(historic.lastInsertRowid))

    expect(membersFor(ctx, opts, "@chief")).toMatchObject({ name: "@chief", provider: "codex" })
  })
})
