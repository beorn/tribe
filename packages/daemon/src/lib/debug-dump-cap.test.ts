/**
 * @km/bearly/17018-tribe-daemon-production-hardening — debug-dump cap.
 *
 * `tribe.debug` used to dump EVERY sessions row (4,908 cursors, 1.6MB
 * payloads) — a diagnostic that floods its consumer defeats make-it-visible.
 * The dump now returns {cursors_total, cursors: 50 stalest + 10 newest} and
 * honours an explicit `full: true` for the complete dump. These tests pin
 * the pure cursor-summariser and the handleDebug `full` passthrough.
 */

import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { createTribeContext, type TribeContext } from "./context.ts"
import { handleToolCall, summarizeCursors, type CursorDumpRow, type HandlerOpts } from "./handlers.ts"

function makeRows(n: number): CursorDumpRow[] {
  // ts ascending with index so stalest = index 0, newest = index n-1
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    name: `n${i}`,
    last_delivered_ts: i + 1,
    last_delivered_seq: i,
  }))
}

describe("17018 — summarizeCursors", () => {
  it("caps to 50 stalest + 10 newest by default", () => {
    const out = summarizeCursors(makeRows(100))
    expect(out.cursors_total).toBe(100)
    expect(out.cursors.length).toBe(60)
    expect(out.cursors_truncated).toBe(true)
    // stalest first (smallest last_delivered_ts), newest last
    expect(out.cursors[0]!.name).toBe("n0")
    expect(out.cursors.at(-1)!.name).toBe("n99")
  })

  it("returns everything (untruncated) when full:true", () => {
    const out = summarizeCursors(makeRows(100), { full: true })
    expect(out.cursors_total).toBe(100)
    expect(out.cursors.length).toBe(100)
    expect(out.cursors_truncated).toBeFalsy()
  })

  it("returns all rows unchanged when under the cap", () => {
    const out = summarizeCursors(makeRows(10))
    expect(out.cursors_total).toBe(10)
    expect(out.cursors.length).toBe(10)
    expect(out.cursors_truncated).toBeFalsy()
  })

  it("treats a null last_delivered_ts as the stalest cursor", () => {
    const rows: CursorDumpRow[] = [
      ...makeRows(99),
      { id: "never", name: "never-delivered", last_delivered_ts: null, last_delivered_seq: 0 },
    ]
    const out = summarizeCursors(rows)
    expect(out.cursors[0]!.name).toBe("never-delivered")
  })
})

describe("17018 — handleDebug full passthrough", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements
  let ctx: TribeContext

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "debug-cap-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
    ctx = createTribeContext({
      db,
      stmts,
      sessionId: "sess-1",
      sessionRole: "member",
      initialName: "@agent/1",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
  })
  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("forwards full:true to getDebugState", () => {
    let received: { full?: boolean } | undefined
    const opts: HandlerOpts = {
      cleanup: () => {},
      userRenamed: false,
      setUserRenamed: () => {},
      getActiveSessionIds: () => new Set<string>(),
      getActiveSessionInfo: () => [],
      getDebugState: (o?: { full?: boolean }) => {
        received = o
        return { ok: true }
      },
    }
    handleToolCall(ctx, "tribe.debug", { full: true }, opts)
    expect(received?.full).toBe(true)
  })

  it("passes full:false when the arg is absent", () => {
    let received: { full?: boolean } | undefined
    const opts: HandlerOpts = {
      cleanup: () => {},
      userRenamed: false,
      setUserRenamed: () => {},
      getActiveSessionIds: () => new Set<string>(),
      getActiveSessionInfo: () => [],
      getDebugState: (o?: { full?: boolean }) => {
        received = o
        return { ok: true }
      },
    }
    handleToolCall(ctx, "tribe.debug", {}, opts)
    expect(received?.full).toBe(false)
  })
})
