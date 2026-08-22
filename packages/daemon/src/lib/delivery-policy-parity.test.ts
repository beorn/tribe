/**
 * The subscription policy exists TWICE and the copies must not drift.
 *
 * `shouldDeliver` (with-broadcast.ts) decides whether a push client is woken.
 * The predicate inside `getInboxRows` (database.ts) decides what a pull drain
 * returns. One is TypeScript, one is SQL, and neither can call the other — so
 * the only thing standing between them and silent divergence is this table.
 *
 * Case Study 7 in /hh/docs/lessons/refactoring.md is exactly this shape: a copy that
 * compiles, passes tests, and is invisible until someone audits by hand. A
 * duplicated policy raises no type error when one half changes.
 *
 * If you change either copy, this test tells you loudly. If you delete the push
 * copy, delete this file with it.
 *
 * @failure The push filter and the pull predicate disagree about whether a seat
 *          is subscribed to a row.
 * @level   l2
 */

import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { shouldDeliver } from "./compose/with-broadcast.ts"
import type { MessageKind } from "./messaging.ts"

const NAME = "@seat"
const ACTIVE_UNTIL = Date.now() + 3_600_000
const EXPIRED_UNTIL = Date.now() - 3_600_000

type Row = { kind: MessageKind; topic: string | null; type: string }
type Filter = { filter_mode: string; filter_mute: string | null; filter_until: number | null }

const ROWS: Row[] = [
  { kind: "broadcast", topic: "health:cpu:warning", type: "health:cpu:warning" },
  { kind: "broadcast", topic: "github:push", type: "github:push" },
  { kind: "broadcast", topic: null, type: "status" },
  { kind: "broadcast", topic: null, type: "request" },
  { kind: "broadcast", topic: "ops:thing", type: "verdict" },
  { kind: "direct", topic: null, type: "notify" },
  { kind: "direct", topic: "health:cpu:warning", type: "request" },
]

const FILTERS: Filter[] = [
  { filter_mode: "normal", filter_mute: null, filter_until: null },
  { filter_mode: "ambient", filter_mute: null, filter_until: null },
  { filter_mode: "focus", filter_mute: null, filter_until: null },
  // Mute with no globs means "mute everything" in both copies.
  { filter_mode: "normal", filter_mute: null, filter_until: ACTIVE_UNTIL },
  { filter_mode: "normal", filter_mute: "[]", filter_until: ACTIVE_UNTIL },
  { filter_mode: "normal", filter_mute: '["health:*"]', filter_until: ACTIVE_UNTIL },
  { filter_mode: "normal", filter_mute: '["health:*","github:*"]', filter_until: ACTIVE_UNTIL },
  // An expired window must behave as though no mute were set at all.
  { filter_mode: "normal", filter_mute: '["health:*"]', filter_until: EXPIRED_UNTIL },
]

describe("push filter and pull predicate agree on every subscription case", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "delivery-parity-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  /** What the PULL predicate says, by asking it for real. */
  function sqlAdmits(row: Row, filter: Filter, index: number): boolean {
    const id = `m-${index}`
    stmts.insertMessage.run({
      $id: id,
      $type: row.type,
      $sender: "@someone-else",
      $recipient: row.kind === "direct" ? NAME : "*",
      $kind: row.kind,
      $content: "body",
      $bead_id: null,
      $ref: null,
      $ts: Date.now() - 60_000,
      $delivery: "pull",
      $topic: row.topic,
      $room_id: null,
      $request: null,
      $reply: null,
    })
    const got = stmts.getInboxRows.all({
      $since: 0,
      $name: NAME,
      $limit: 500,
      $filter_mode: filter.filter_mode,
      $filter_mute: filter.filter_mute,
      $filter_until: filter.filter_until,
      $now: Date.now(),
    }) as Array<{ id: string }>
    return got.some((r) => r.id === id)
  }

  it("agrees on every FLEET row — that is the traffic the subscription exists for", () => {
    const disagreements: string[] = []
    let index = 0
    for (const filter of FILTERS) {
      for (const row of ROWS.filter((r) => r.kind === "broadcast")) {
        index += 1
        const push = shouldDeliver({ kind: row.kind, type: row.type, replyHint: "no", topic: row.topic }, filter)
        const pull = sqlAdmits(row, filter, index)
        if (push !== pull) {
          disagreements.push(
            `mode=${filter.filter_mode} mute=${filter.filter_mute ?? "none"} | ${row.type}/${row.topic ?? "no-topic"} → push=${push} pull=${pull}`,
          )
        }
      }
    }
    expect(disagreements).toEqual([])
  })

  /**
   * Directs are where the two paths are MEANT to differ, and conflating them
   * was a real bug in this branch: the first cut of the pull predicate dropped
   * non-actionable directs in focus mode, which deleted a seat's own mail from
   * its drain. The 19442 journey test caught it against a live daemon.
   *
   * The two answer different questions. Push asks "does this interrupt you?" —
   * a notify addressed to you does not. Pull asks "is this yours to read?" — it
   * always is. Filtering fleet noise is the goal; filtering your own mail never
   * was.
   */
  it("diverges on directs by design: push may skip the wakeup, pull always delivers", () => {
    const direct: Row = { kind: "direct", topic: null, type: "notify" }
    const focus: Filter = { filter_mode: "focus", filter_mute: null, filter_until: null }

    expect(shouldDeliver({ ...direct, replyHint: "no" }, focus)).toBe(false)
    expect(sqlAdmits(direct, focus, 2000)).toBe(true)

    // A muted-everything window must not swallow a direct either.
    const mutedAll: Filter = { filter_mode: "normal", filter_mute: "[]", filter_until: ACTIVE_UNTIL }
    expect(shouldDeliver({ ...direct, replyHint: "no" }, mutedAll)).toBe(true)
    expect(sqlAdmits(direct, mutedAll, 2001)).toBe(true)
  })

  it("agrees that an absent session filter admits everything", () => {
    // shouldDeliver's `if (!filter) return true`, and the pull path's defaults
    // in inboxFilterParams, must mean the same thing.
    const openFilter: Filter = { filter_mode: "normal", filter_mute: null, filter_until: null }
    let index = 1000
    for (const row of ROWS) {
      index += 1
      expect(shouldDeliver({ kind: row.kind, type: row.type, replyHint: "no", topic: row.topic }, undefined)).toBe(true)
      expect(sqlAdmits(row, openFilter, index)).toBe(true)
    }
  })
})
