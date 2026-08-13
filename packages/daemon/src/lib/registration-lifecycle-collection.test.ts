/**
 * A register/die cycle used to leave its `sessions` row behind for up to six
 * hours. Only two things removed one: the six-hour `cleanupOldData` tick, and
 * a LATER registration claiming the SAME NAME (`registerSession`'s holder
 * eviction). Anonymous churn never collides on a name, so nothing collected
 * it — a service registering and dying once a second seeded rows faster than
 * any sweep removed them, and every full-table read in the daemon then paid
 * for all of them.
 *
 * The allocator must be the collector: the same lifecycle that created the row
 * retires it, and the reap policy is the one that already exists
 * (`reapStaleTransportRows`) rather than a second eviction rule free to drift
 * from the first.
 *
 * Collection is deferred to the end of the reconnect grace, not run at
 * disconnect: a pull-delivery seat has no socket between polls and
 * `isReconnectGraceProtected` protects it deliberately. These tests pin both
 * halves — the row goes away on its own, and a seat that reconnected keeps it.
 */
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { registerSession, reapStaleTransportRows } from "./session.ts"

const PROJECT_ID = "registration-lifecycle-collection"

describe("a registration is collected by its own lifecycle", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "registration-lifecycle-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const countRows = (): number => (db.prepare("SELECT count(*) c FROM sessions").get() as { c: number }).c

  /** One anonymous register/die cycle: a fresh connection id and a fresh name. */
  function registerAnonymous(index: number): string {
    const sessionId = `conn-${index}`
    const ctx = createTribeContext({
      db,
      stmts,
      sessionId,
      sessionRole: "member",
      initialName: `anon-${index}`,
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    // launchId/launchParentPid both null => connection-scoped, the lifetime
    // whose liveness IS its socket.
    registerSession(ctx, PROJECT_ID, () => false, null, 10_000 + index, "pull", "/repo", null, "codex", null, null)
    return sessionId
  }

  it("anonymous register/die churn accumulates rows that no name collision can reach", () => {
    for (let i = 0; i < 200; i++) registerAnonymous(i)

    // This is the seed. Name-collision eviction never fires because no two
    // cycles share a name, so every cycle leaves a row.
    expect(countRows()).toBe(200)
  })

  it("collects a departed connection-scoped row once its reconnect grace has passed", () => {
    const departed = [registerAnonymous(1), registerAnonymous(2), registerAnonymous(3)]
    expect(countRows()).toBe(3)

    const report = reapStaleTransportRows(db, {
      hasActiveTransport: () => false,
      isReconnectGraceProtected: () => false,
      onlySessionIds: new Set(departed),
    })

    expect(report.reaped).toBe(3)
    expect(countRows()).toBe(0)
  })

  it("keeps the row of a seat that reconnected inside the grace window", () => {
    const departed = registerAnonymous(1)
    registerAnonymous(2)

    // The seat came back: its transport is active again by the time the
    // deferred collection runs, so the existing fence must preserve it.
    const report = reapStaleTransportRows(db, {
      hasActiveTransport: (sessionId) => sessionId === departed,
      isReconnectGraceProtected: () => false,
      onlySessionIds: new Set([departed, "conn-2"]),
    })

    expect(report.reaped).toBe(1)
    expect(report.reason_counts.active_transport).toBe(1)
    const survivors = db.prepare("SELECT id FROM sessions").all() as Array<{ id: string }>
    expect(survivors.map((row) => row.id)).toEqual([departed])
  })

  it("still refuses to collect a row that is inside its reconnect grace", () => {
    const departed = registerAnonymous(1)

    const report = reapStaleTransportRows(db, {
      hasActiveTransport: () => false,
      isReconnectGraceProtected: () => true,
      onlySessionIds: new Set([departed]),
    })

    expect(report.reaped).toBe(0)
    expect(report.reason_counts.reconnect_grace).toBe(1)
    expect(countRows()).toBe(1)
  })

  it("scoping changes which rows are examined, never the policy applied to them", () => {
    const durableCtx = createTribeContext({
      db,
      stmts,
      sessionId: "durable-1",
      sessionRole: "member",
      initialName: "@dev/1",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    registerSession(durableCtx, PROJECT_ID, () => false, null, 4242, "pull", "/repo", null, "codex", "launch-A", 999)
    const anon = registerAnonymous(1)

    // A durable-launch row must survive the scoped path exactly as it survives
    // the sweep — a missing transport never establishes agent absence.
    const scoped = reapStaleTransportRows(db, {
      hasActiveTransport: () => false,
      isReconnectGraceProtected: () => false,
      onlySessionIds: new Set([anon, "durable-1"]),
    })
    expect(scoped.reaped).toBe(1)
    expect(scoped.reason_counts.durable_launch).toBe(1)

    const survivors = db.prepare("SELECT id FROM sessions").all() as Array<{ id: string }>
    expect(survivors.map((row) => row.id)).toEqual(["durable-1"])
  })
})
