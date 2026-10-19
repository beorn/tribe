/**
 * @failure 29947: `tribe fetch` could only page from the newest end. A bounded
 *          read returned the newest N rows, its at-bound line advised a
 *          `--limit` raise that cannot work at the maximum, and there was no
 *          verb that reached the OLDER end of a history — so a caller bisected
 *          for a rowid in a bespoke script.
 * @level    l2
 * @consumer scripts and seats reading a long history through `tribe fetch`;
 *           the CLI line is `packages/wire/src/cli/read.ts` (tribeFetchScope).
 * @testonly none
 */
import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"
import { registerSession } from "./session.ts"

const SEAT = "@dev/luna4"
const SENDER = "@chief"
const TS = Date.UTC(2026, 9, 19, 7, 0, 0)

type ToolJson = Record<string, unknown>

function parseToolJson(result: ReturnType<typeof handleToolCall>): ToolJson {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as ToolJson
}

function makeOpts(): HandlerOpts {
  return {
    cleanup: () => undefined,
    userRenamed: false,
    setUserRenamed: () => undefined,
    getActiveSessionIds: () => new Set<string>(),
    hasActiveTransport: () => false,
    getActiveSessionInfo: () => [],
  }
}

function rowidsOf(payload: ToolJson): number[] {
  const events = (payload.events ?? []) as Array<{ rowid: number }>
  return events.map((event) => event.rowid)
}

describe("tribe.fetch --before reaches the older end of a history (29947)", () => {
  let dir: string
  let db: Database
  let stmts: TribeStatements
  let ctx: TribeContext

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fetch-before-29947-"))
    db = openDatabase(join(dir, "tribe.db"))
    stmts = createStatements(db)
    ctx = createTribeContext({
      db,
      stmts,
      sessionId: "sess-29947-read",
      sessionRole: "member",
      initialName: SEAT,
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    registerSession(ctx, undefined, () => false, null, 0, "pull")
  })

  afterEach(() => {
    db.close()
    // raw-delete-allow: this test's own mkdtemp root under os.tmpdir().
    rmSync(dir, { recursive: true, force: true })
  })

  function message(n: number): void {
    stmts.insertMessage.run({
      $id: `00000000-0000-4000-8000-00000000000${n}`,
      $type: "notify",
      $sender: SENDER,
      $recipient: SEAT,
      $kind: "direct",
      $content: `message ${n}`,
      $bead_id: null,
      $ref: null,
      $ts: TS + n * 1_000,
      $delivery: "pull",
      $topic: null,
      $room_id: null,
      $request: null,
      $reply: null,
      $summary: null,
    })
  }

  function fetch(args: Record<string, unknown>): ToolJson {
    return parseToolJson(handleToolCall(ctx, "tribe.fetch", args, makeOpts()))
  }

  it("pages below the newest window, and keeps chronological order", () => {
    for (let n = 1; n <= 5; n += 1) message(n)

    // Read every row once and take the real rowids: the fixture's first rowid
    // is not assumed, because session registration may consume one.
    const all = rowidsOf(fetch({ to: SEAT, limit: 10 }))
    expect(all).toHaveLength(5)
    const [a, b, c, d, e] = all

    expect(rowidsOf(fetch({ to: SEAT, limit: 2 }))).toEqual([d, e])
    expect(rowidsOf(fetch({ before: d, limit: 2 }))).toEqual([b, c])
    expect(rowidsOf(fetch({ before: c, limit: 10 }))).toEqual([a, b])
  })

  it("bounds a range when since and before are both given", () => {
    for (let n = 1; n <= 5; n += 1) message(n)

    const [, b, c, d, e] = rowidsOf(fetch({ to: SEAT, limit: 10 }))
    expect(rowidsOf(fetch({ since: b, before: e, limit: 10 }))).toEqual([c, d])
  })

  it("refuses an empty range by name instead of answering an empty list", () => {
    for (let n = 1; n <= 3; n += 1) message(n)

    const [, , c] = rowidsOf(fetch({ to: SEAT, limit: 10 }))
    const refused = fetch({ since: c, before: c, limit: 10 })
    expect(String(refused.error)).toContain(`since ${c} is not below before ${c}`)
  })

  it("refuses a non-integer before by name", () => {
    const refused = fetch({ before: 1.5 })
    expect(String(refused.error)).toBe("before must be a non-negative integer row id.")
  })
})
