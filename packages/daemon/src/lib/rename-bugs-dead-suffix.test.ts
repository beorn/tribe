/**
 * Regression tests for @ag/tribe/22226:
 * 1. Live sessions (with active PID or transport or reconnect grace) are NEVER dead-suffixed.
 * 2. tribe.rename repairs DB row when in-memory name matches new_name but DB row was tombstoned/desynchronized.
 */
import { describe, expect, it } from "vitest"
import { createTribeContext, type TribeContext } from "./context.ts"
import { openDatabase, createStatements, type TribeStatements } from "./database.ts"
import { handleToolCall } from "./handlers.ts"
import type { Database } from "bun:sqlite"

function makeCtx(db: Database, stmts: TribeStatements, sessionId: string, initialName: string): TribeContext {
  return createTribeContext({
    db,
    stmts,
    sessionId,
    sessionRole: "member",
    initialName,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
}

describe("bead 22226 — rename and dead-suffix fixes", () => {
  it("never dead-suffixes a session whose OS PID is alive even if active transport is absent", () => {
    const db = openDatabase(":memory:")
    const stmts = createStatements(db)
    const now = Date.now()

    // Insert session s1 with name "@ci" and PID = process.pid (current live PID)
    db.prepare(`
      INSERT INTO sessions (id, name, role, domains, pid, cwd, updated_at, started_at)
      VALUES ('s1', '@ci', 'member', '[]', ?, '/tmp', ?, ?)
    `).run(process.pid, now, now)

    // Context for a new session s2 (different PID) attempting to join as "@ci"
    const otherPid = process.pid + 1000
    const ctx2 = makeCtx(db, stmts, "sess-2", "@agent/1")
    db.prepare(`
      INSERT INTO sessions (id, name, role, domains, pid, cwd, updated_at, started_at)
      VALUES ('sess-2', '@agent/1', 'member', '[]', ?, '/tmp', ?, ?)
    `).run(otherPid, now, now)

    const opts = {
      hasActiveTransport: (_id: string) => false, // transport socket absent (e.g. re-exec / reconnect)
      getActiveSessionIds: () => ["sess-2"],
      getActiveSessionInfo: () => [{ id: "sess-2", pid: otherPid, cwd: "/tmp" }],
      setUserRenamed: () => {},
    }

    // s2 attempts to join as "@ci"
    const res = handleToolCall(ctx2, "tribe.join", { name: "@ci" }, opts as any) as any

    // Assertion 1: Join as "@ci" must fail with error because "@ci" is owned by live process s1
    const json = JSON.parse(res.content[0].text) as {
      error?: string
      renamed?: boolean
      old_name?: string
      new_name?: string
    }
    expect(json.error).toContain('Name "@ci" is already taken')

    // Assertion 2: s1's row in SQLite DB must NOT be dead-suffixed to @ci-dead-s1
    const s1Row = db.prepare("SELECT name FROM sessions WHERE id = 's1'").get() as { name: string }
    expect(s1Row.name).toBe("@ci")
  })

  it("repairs DB row during tribe.rename when in-memory name matches new_name but DB row is tombstoned", () => {
    const db = openDatabase(":memory:")
    const stmts = createStatements(db)
    const ctx = makeCtx(db, stmts, "s1", "@ci")
    const now = Date.now()

    // Insert s1 row in DB tombstoned as "@ci-dead-12345678" (simulating past drift)
    db.prepare(`
      INSERT INTO sessions (id, name, role, domains, pid, cwd, updated_at, started_at)
      VALUES ('s1', '@ci-dead-12345678', 'member', '[]', ?, '/tmp', ?, ?)
    `).run(process.pid, now, now)

    const opts = {
      hasActiveTransport: (id: string) => id === "s1",
      getActiveSessionIds: () => ["s1"],
      getActiveSessionInfo: () => [{ id: "s1", pid: process.pid, cwd: "/tmp" }],
      setUserRenamed: () => {},
    }

    // In-memory ctx.getName() is "@ci", DB has "@ci-dead-12345678".
    // Calling tribe.rename({ new_name: "@ci" }) must repair DB row back to "@ci".
    const res = handleToolCall(ctx, "tribe.rename", { new_name: "@ci" }, opts as any) as any

    const json = JSON.parse(res.content[0].text) as {
      error?: string
      renamed?: boolean
      old_name?: string
      new_name?: string
    }
    expect(json.renamed).toBe(true)
    expect(json.old_name).toBe("@ci-dead-12345678")
    expect(json.new_name).toBe("@ci")

    // DB row must now be updated back to "@ci"
    const s1Row = db.prepare("SELECT name FROM sessions WHERE id = 's1'").get() as { name: string }
    expect(s1Row.name).toBe("@ci")
  })
})
