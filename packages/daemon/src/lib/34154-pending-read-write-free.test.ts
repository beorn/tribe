/**
 * 34154 — a `tribe.pending` read that has nothing to settle must not open the
 * settle's write transaction.
 *
 * The old path ran `ctx.db.transaction(() => settleDeclaredUnrunPairs(...))` on
 * every plain pending read; on a store whose balls were already settled that
 * transaction was empty but still taken, on the busiest verb on the wire.
 *
 * Why not the WAL byte count: SQLite logs no frame for a transaction that
 * changes nothing, so the WAL is byte-identical under both the old and the new
 * code (measured on this harness). The observable that does separate them is the
 * number of transactions the read opens: the live-rows projection opens one, so
 * a read with a declared roster and nothing to settle must open exactly one, not
 * two.
 */
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"
import { parseExpectedMembers } from "./membership-declared-roster.ts"

const PROJECT_ID = "34154-pending-read"

const ROSTER = [
  { name: "@ci", expected: false },
  { name: "@dev/3", expected: false },
  { name: "@dev/12", expected: true },
]

function optsWithRoster(): HandlerOpts {
  return {
    cleanup: () => undefined,
    userRenamed: false,
    setUserRenamed: () => undefined,
    getActiveSessionIds: () => new Set<string>(),
    hasActiveTransport: () => false,
    isReconnectGraceProtected: () => false,
    getActiveSessionInfo: () => [],
    getExpectedMembers: () => parseExpectedMembers(JSON.stringify(ROSTER))!,
  }
}

/** Counts the transactions a read opens, without changing what they do. */
function countingDb(db: Database): { db: Database; transactions: () => number } {
  let count = 0
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "transaction") {
        return (...args: unknown[]) => {
          count += 1
          return (target.transaction as (...a: unknown[]) => unknown)(...args)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return { db: proxy as Database, transactions: () => count }
}

describe("34154: a pending read with nothing to settle opens no settle transaction", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), `${PROJECT_ID}-`))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("opens one transaction for the rows, not a second for a settle that has nothing to do", () => {
    const counted = countingDb(db)
    const ctx: TribeContext = createTribeContext({
      db: counted.db,
      stmts,
      sessionId: "sess-34154",
      sessionRole: "member",
      initialName: "@dev/12",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    const result = handleToolCall(ctx, "tribe.pending", { all: true }, optsWithRoster())
    expect(result).toBeTruthy()
    // Two, not three: the handler's own snapshot wrapper plus the row
    // projection. The settle's transaction is the third one below.
    expect(counted.transactions()).toBe(2)
    const settled = db.prepare("SELECT count(*) AS n FROM messages WHERE type = 'event.ball.settled'").get() as {
      n: number
    }
    expect(settled.n).toBe(0)
  })

  it("still settles the eligible ball, in a transaction of its own", () => {
    stmts.openPendingRequest.run({
      $request_id: "8d2f4c11",
      $recipient: "@dev/3",
      $sender: "@ci",
      $opened_at: 1_000,
      $expires_at: 2_000,
      $message_id: "8d2f4c11-msg",
      $fanout: "first",
    })
    const counted = countingDb(db)
    const ctx: TribeContext = createTribeContext({
      db: counted.db,
      stmts,
      sessionId: "sess-34154",
      sessionRole: "member",
      initialName: "@dev/12",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    handleToolCall(ctx, "tribe.pending", { all: true }, optsWithRoster())
    const settled = db.prepare("SELECT count(*) AS n FROM messages WHERE type = 'event.ball.settled'").get() as {
      n: number
    }
    expect(settled.n).toBe(1)
    expect(counted.transactions()).toBe(3)
  })
})
