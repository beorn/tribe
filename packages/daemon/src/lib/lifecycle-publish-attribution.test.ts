/**
 * Bead 20080 — tribe.lifecycle.publish must attribute a snapshot to an explicit
 * `sessionName` when the publisher provides one.
 *
 * Why: a silvercode host runs ONE controller observer that multiplexes every
 * agent session it hosts, and publishes over a SINGLE daemon connection. Keying
 * the lifecycle store by the connection's own name (the default) collapses every
 * agent's snapshots onto one key — so `tribe.lifecycle("@agent/7")` can't find
 * an agent's hung-turn state. The live fleet exhibited exactly this (every
 * snapshot landed on a shared name) before this fix. The publisher now passes
 * the observed session's name; the daemon keys by it. Falls back to the
 * connection name for single-identity publishers (backward compatible).
 */

import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { createTribeContext, type TribeContext } from "./context.ts"
import { createLifecycleStore, type LifecycleStore } from "./lifecycle-store.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"

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

function makeOpts(store: LifecycleStore): HandlerOpts {
  return {
    cleanup: () => {},
    userRenamed: false,
    setUserRenamed: () => {},
    getActiveSessionIds: () => new Set<string>(),
    getActiveSessionInfo: () => [],
    getLifecycleStore: () => store,
  }
}

function snapshot(toolCallId: string, state: string): Record<string, unknown> {
  return { toolCallId, toolName: "Bash", state, elapsedMs: 100, inactivityMs: 0 }
}

function parse(result: unknown): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Record<string, unknown>
}

function publish(
  ctx: TribeContext,
  opts: HandlerOpts,
  snap: Record<string, unknown>,
  sessionName?: string,
): Record<string, unknown> {
  const args: Record<string, unknown> = { snapshot: snap }
  if (sessionName !== undefined) args.sessionName = sessionName
  return parse(handleToolCall(ctx, "tribe.lifecycle.publish", args, opts))
}

function read(ctx: TribeContext, opts: HandlerOpts, session: string): Record<string, unknown> | null {
  const out = parse(handleToolCall(ctx, "tribe.lifecycle", { session }, opts))
  return (out.snapshot as Record<string, unknown> | null) ?? null
}

describe("bead 20080 — tribe.lifecycle.publish session-name attribution", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lifecycle-attr-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })
  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("explicit sessionName keys the store by that name, not the connection name", () => {
    const store = createLifecycleStore()
    const opts = makeOpts(store)
    // Connection identifies as the HOST, not the agent.
    const ctx = makeContext(db, stmts, "sess-host", "silvercode-13850")

    const res = publish(ctx, opts, snapshot("t1", "silent-hang"), "@agent/7")
    expect(res.published).toBe(true)
    expect(res.sessionName).toBe("@agent/7")

    // Queryable by the agent name (what chief asks for) ...
    const byAgent = read(ctx, opts, "@agent/7")
    expect((byAgent?.payload as Record<string, unknown>)?.state).toBe("silent-hang")
    // ... and NOT misfiled under the host connection name.
    expect(read(ctx, opts, "silvercode-13850")).toBeNull()
  })

  it("one connection multiplexing two agents keys each snapshot separately (the core fix)", () => {
    const store = createLifecycleStore()
    const opts = makeOpts(store)
    const ctx = makeContext(db, stmts, "sess-host", "silvercode-13850")

    publish(ctx, opts, snapshot("tA", "active-long"), "@agent/7")
    publish(ctx, opts, snapshot("tB", "failed-deadline"), "@agent/8")

    expect((read(ctx, opts, "@agent/7")?.payload as Record<string, unknown>)?.state).toBe("active-long")
    expect((read(ctx, opts, "@agent/8")?.payload as Record<string, unknown>)?.state).toBe("failed-deadline")
    // Two agents over one connection → two distinct store entries (not collapsed).
    expect(store.size()).toBe(2)
  })

  it("falls back to the connection name when no sessionName is provided (backward compatible)", () => {
    const store = createLifecycleStore()
    const opts = makeOpts(store)
    const ctx = makeContext(db, stmts, "sess-solo", "@agent/3")

    const res = publish(ctx, opts, snapshot("t1", "running"))
    expect(res.sessionName).toBe("@agent/3")
    expect((read(ctx, opts, "@agent/3")?.payload as Record<string, unknown>)?.state).toBe("running")
  })

  it("rejects a non-string sessionName", () => {
    const store = createLifecycleStore()
    const opts = makeOpts(store)
    const ctx = makeContext(db, stmts, "sess-host", "silvercode-13850")

    const res = parse(
      handleToolCall(ctx, "tribe.lifecycle.publish", { snapshot: snapshot("t1", "running"), sessionName: 42 }, opts),
    )
    expect(typeof res.error).toBe("string")
    expect(store.size()).toBe(0)
  })
})
