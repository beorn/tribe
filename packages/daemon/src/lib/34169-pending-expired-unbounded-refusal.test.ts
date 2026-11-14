/**
 * 34169 (@cto 4203a1ab) — the unbounded expired history read is refused before
 * any fold.
 *
 * `expiredPendingBalls` reads every settlement fact and every reply fact in the
 * store. On the live store that fold took 13.0 s (17.4 s under load) — past the
 * client's 10 s limit — and because the daemon runs it on the one thread that
 * serves every seat with synchronous SQLite, a caller giving up does not stop
 * it: the whole wire waited for the fold's full duration. `owed` bounds the read
 * to live requests, so that is the only wired shape.
 *
 * What this pins: the refused shapes answer with the named refusal and never
 * reach the fold statements; the three bounded shapes answer as before.
 */
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"

const PROJECT_ID = "34169-unbounded-expired"

function makeOpts(): HandlerOpts {
  return {
    cleanup: () => undefined,
    userRenamed: false,
    setUserRenamed: () => undefined,
    getActiveSessionIds: () => new Set<string>(),
    hasActiveTransport: () => false,
    isReconnectGraceProtected: () => false,
    getActiveSessionInfo: () => [],
  }
}

/**
 * The fold's two statements, rigged to fail the test if the refusal ever runs
 * them. A refusal that reads first and refuses after is the defect this pins.
 */
function stmtsThatFailOnFold(stmts: TribeStatements): TribeStatements {
  return new Proxy(stmts, {
    get(target, prop, receiver) {
      if (prop === "selectPendingOutcomeFactsByType" || prop === "selectPendingReplyFacts") {
        throw new Error(`34169: the refusal reached the fold statement ${String(prop)}`)
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Record<string, unknown>
}

describe("34169: the unbounded expired history read is refused, never folded", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements
  let ctx: TribeContext

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), `${PROJECT_ID}-`))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
    ctx = createTribeContext({
      db,
      stmts,
      sessionId: "sess-34169",
      sessionRole: "member",
      initialName: "@chief",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it.each([
    ["default owner", { expired: true }],
    ["every owner", { expired: true, all: true }],
    ["one named owner", { expired: true, owner: "@dev/3" }],
    ["with a stale filter", { expired: true, stale_ms: 1_000 }],
  ])("refuses the unbounded read (%s) by name, without touching the fold", (_label, params) => {
    const rigged = createTribeContext({
      db,
      stmts: stmtsThatFailOnFold(stmts),
      sessionId: "sess-34169-rigged",
      sessionRole: "member",
      initialName: "@chief",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    const payload = parseToolJson(handleToolCall(rigged, "tribe.pending", params, makeOpts()))
    const error = String(payload.error ?? "")
    expect(error).toContain("refusing the unbounded expired history read")
    expect(error).toContain("owed: true")
    expect(payload.pending).toBeUndefined()
  })

  it("still answers the three bounded shapes, and still shows a live expired ball", () => {
    const now = Date.now()
    stmts.openPendingRequest.run({
      $request_id: "live-expired",
      $recipient: "@dev/3",
      $sender: "@chief",
      $opened_at: now - 600_000,
      $expires_at: now - 60_000,
      $message_id: "live-expired-msg",
      $fanout: "first",
    })

    const own = parseToolJson(
      handleToolCall(ctx, "tribe.pending", { expired: true, owed: true, owner: "@dev/3" }, makeOpts()),
    )
    expect(own.error).toBeUndefined()
    expect(own.expired).toBe(true)
    expect(own.owed).toBe(true)
    expect((own.pending as Array<Record<string, unknown>>)[0]).toMatchObject({
      request_id: "live-expired",
      backing: "live",
      status: "expired",
    })

    const fleet = parseToolJson(
      handleToolCall(ctx, "tribe.pending", { expired: true, owed: true, all: true }, makeOpts()),
    )
    expect(fleet.error).toBeUndefined()
    expect(fleet.all).toBe(true)
    expect(fleet.count).toBe(1)

    const implicit = parseToolJson(handleToolCall(ctx, "tribe.pending", { expired: true, owed: true }, makeOpts()))
    expect(implicit.error).toBeUndefined()
    expect(implicit.owner).toBe("@chief")
    expect(implicit.count).toBe(0)
  })
})
