/**
 * @km/tribe/20008 — pending-ball GC + explicit repair.
 *
 * A `pending_request` ball that never gets a reply (dead recipient, out-of-band
 * close, bead-closed handoff) used to stay "open" forever and pollute
 * `tribe.pending` (@km/tribe/19996 — chief saw ~124 stale balls). Two paths:
 *  - periodic auto-GC in `cleanupOldData` (ball never outlives its message's 7d
 *    retention);
 *  - the scoped `gcStalePendingForRecipient` engine behind the explicit
 *    `tribe.pending` prune/close (safe chief-recovery repair — scoped).
 * Neither deletes message history; only ball-tracker rows are removed.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"
import { cleanupOldData } from "./session.ts"

const DAY = 24 * 60 * 60 * 1000
type ToolJson = Record<string, unknown>

function makeOpts(): HandlerOpts {
  return {
    cleanup: () => undefined,
    userRenamed: false,
    setUserRenamed: () => undefined,
    getActiveSessionIds: () => new Set(["sess-chief"]),
    getActiveSessionInfo: () => [],
  }
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): ToolJson {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as ToolJson
}

describe("pending-ball GC (@km/tribe/20008)", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pending-gc-"))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function setup() {
    const db = openDatabase(join(tmpDir, "tribe.db"))
    const stmts = createStatements(db)
    return { db, stmts }
  }

  function openBall(
    stmts: TribeStatements,
    o: { id: string; recipient: string; openedAt: number; sender?: string },
  ): void {
    stmts.openPendingRequest.run({
      $request_id: o.id,
      $recipient: o.recipient,
      $sender: o.sender ?? "@chief",
      $opened_at: o.openedAt,
      $message_id: `${o.id}-msg`,
      $fanout: "first",
    })
  }

  function openIds(stmts: TribeStatements, recipient: string): string[] {
    return (stmts.selectPendingForRecipient.all({ $recipient: recipient }) as Array<{ request_id: string }>).map(
      (r) => r.request_id,
    )
  }

  it("cleanupOldData GCs balls older than the 7d retention, keeps fresh ones", () => {
    const { db, stmts } = setup()
    try {
      const now = Date.now()
      openBall(stmts, { id: "stale", recipient: "@chief", openedAt: now - 8 * DAY }) // > 7d → GC
      openBall(stmts, { id: "fresh", recipient: "@chief", openedAt: now - 1 * DAY }) // < 7d → keep

      cleanupOldData({ stmts } as unknown as Parameters<typeof cleanupOldData>[0])

      expect(openIds(stmts, "@chief")).toEqual(["fresh"])
    } finally {
      db.close()
    }
  })

  it("scoped prune deletes only the owner's balls older than the cutoff", () => {
    const { db, stmts } = setup()
    try {
      const now = Date.now()
      openBall(stmts, { id: "chief-stale", recipient: "@chief", openedAt: now - 3 * DAY })
      openBall(stmts, { id: "chief-fresh", recipient: "@chief", openedAt: now - 30 * 60 * 1000 }) // 30m
      openBall(stmts, { id: "other-stale", recipient: "@agent/2", openedAt: now - 3 * DAY })

      const res = stmts.gcStalePendingForRecipient.run({ $recipient: "@chief", $cutoff: now - 1 * DAY })

      expect(res.changes).toBe(1) // only chief-stale
      expect(openIds(stmts, "@chief")).toEqual(["chief-fresh"]) // fresh preserved
      expect(openIds(stmts, "@agent/2")).toEqual(["other-stale"]) // other recipient untouched (scoped)
    } finally {
      db.close()
    }
  })

  it("a fresh request/reply ball is never GC'd and still closes on reply", () => {
    const { db, stmts } = setup()
    try {
      const now = Date.now()
      openBall(stmts, { id: "live", recipient: "@chief", openedAt: now - 5 * 60 * 1000 }) // 5m old

      // Auto-GC + a scoped prune with a 1d threshold both leave it open.
      cleanupOldData({ stmts } as unknown as Parameters<typeof cleanupOldData>[0])
      stmts.gcStalePendingForRecipient.run({ $recipient: "@chief", $cutoff: now - 1 * DAY })
      expect(openIds(stmts, "@chief")).toEqual(["live"])

      // The normal reply path still closes it.
      stmts.closePendingRequest.run({ $request_id: "live", $recipient: "@chief" })
      expect(openIds(stmts, "@chief")).toEqual([])
    } finally {
      db.close()
    }
  })

  it("explicit close deletes exactly one owner's pending ball", () => {
    const { db, stmts } = setup()
    try {
      const now = Date.now()
      openBall(stmts, { id: "done", recipient: "@chief", openedAt: now })
      openBall(stmts, { id: "keep", recipient: "@chief", openedAt: now })
      openBall(stmts, { id: "done", recipient: "@agent/2", openedAt: now })
      const ctx = createTribeContext({
        db,
        stmts,
        sessionId: "sess-chief",
        sessionRole: "member",
        initialName: "@chief",
        domains: [],
        claudeSessionId: null,
        claudeSessionName: null,
      })

      const res = parseToolJson(handleToolCall(ctx, "tribe.pending", { close: "done" }, makeOpts()))

      expect(res).toMatchObject({ owner: "@chief", request_id: "done", closed: 1 })
      expect(openIds(stmts, "@chief")).toEqual(["keep"])
      expect(openIds(stmts, "@agent/2")).toEqual(["done"])
    } finally {
      db.close()
    }
  })
})
