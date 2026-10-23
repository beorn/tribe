/**
 * @failure A response that settled a ball through its tracked `reply` reads
 *          settlement "untracked" from `tribe.fetch --ids`, because the read
 *          keys the settlement only on the message's request/ref columns and
 *          never on `reply`. Live specimen 2026-10-23: @chief's ruling
 *          f4e8423b settled @dev/8's request 0c1b3607 (journal fact
 *          settlement "answered", settled_by @chief, and the row carries
 *          reply=0c1b3607 with correlated_reply_requester=@dev/8), yet the
 *          read answered "untracked". @dev/8 read that label as proof the
 *          message carried no --reply at all, and reported the wrong cause of
 *          a missed wake to @chief.
 * @level l2
 * @consumer the pre-drain settlement read (`tribe.fetch ids`) and every seat
 *           that reasons about whether an answer closed its ball.
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

const REQUESTER = "@dev/8"
const RESPONDER = "@chief"
const BALL = "0c1b3607-fd0d-40e8-8598-ffef706069f2"
const REPLY = "f4e8423b-0fdd-4cc6-83f3-e9d8c2064f86"
const TS = Date.UTC(2026, 9, 23, 14, 37, 0)

function parseToolJson(result: ReturnType<typeof handleToolCall>): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Record<string, unknown>
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

describe("a settling reply's own settlement label", () => {
  let dir: string
  let db: Database
  let stmts: TribeStatements
  let ctx: TribeContext

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "settling-reply-label-"))
    db = openDatabase(join(dir, "tribe.db"))
    stmts = createStatements(db)
    ctx = createTribeContext({
      db,
      stmts,
      sessionId: "sess-settling-reply",
      sessionRole: "member",
      initialName: REQUESTER,
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
    registerSession(ctx, undefined, () => false, null, 0, "pull")
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function base(extra: Record<string, unknown>) {
    return {
      $bead_id: null,
      $delivery: "push",
      $topic: null,
      $room_id: null,
      $summary: null,
      ...extra,
    }
  }

  it("names the settlement and the settler when the ball was closed through reply", () => {
    // The request this seat SENT: opens a ball owned by the responder.
    stmts.insertMessage.run(
      base({
        $id: BALL,
        $type: "request",
        $sender: REQUESTER,
        $recipient: RESPONDER,
        $kind: "direct",
        $content: "ruling needed",
        $ref: null,
        $ts: TS,
        $request: BALL,
        $reply: null,
        $correlated_reply_requester: null,
        $attention_required: 1,
      }) as never,
    )
    stmts.openPendingRequest.run({
      $request_id: BALL,
      $recipient: RESPONDER,
      $sender: REQUESTER,
      $opened_at: TS,
      $expires_at: TS + 1_800_000,
      $message_id: BALL,
      $fanout: "first",
    })

    // What settlePendingRows does: journal the fact, then DELETE the tracker row.
    stmts.insertMessage.run(
      base({
        $id: `fact-${BALL}`,
        $type: "event.ball.settled",
        $sender: "daemon",
        $recipient: RESPONDER,
        $kind: "event",
        $content: JSON.stringify({
          schema_version: 1,
          request_id: BALL,
          recipient: RESPONDER,
          sender: REQUESTER,
          opened_at: TS,
          expires_at: TS + 1_800_000,
          message_id: BALL,
          fanout: "first",
          summary: "ruling needed",
          settlement: "answered",
          settled_at: TS + 150_625,
          settled_by: RESPONDER,
        }),
        $ref: BALL,
        $ts: TS + 150_625,
        $request: null,
        $reply: null,
        $correlated_reply_requester: null,
        $attention_required: 0,
      }) as never,
    )
    stmts.closePendingRequest.run({ $request_id: BALL, $recipient: RESPONDER })

    // The answering row, exactly as the live journal holds it: no request, no
    // ref, but a tracked reply and the requester recorded for the opt-in wake.
    stmts.insertMessage.run(
      base({
        $id: REPLY,
        $type: "response",
        $sender: RESPONDER,
        $recipient: REQUESTER,
        $kind: "direct",
        $content: "Ruling (a).",
        $ref: null,
        $ts: TS + 150_625,
        $request: null,
        $reply: BALL,
        $correlated_reply_requester: REQUESTER,
        $attention_required: 1,
      }) as never,
    )

    const res = parseToolJson(handleToolCall(ctx, "tribe.fetch", { ids: [REPLY] }, makeOpts()))
    const events = res.events as Array<Record<string, unknown>>
    const row = events.find((event) => event.id === REPLY)

    expect(row, "the read must return the row it was asked for").toBeDefined()
    expect(
      row?.settlement,
      "a row that settled a ball through reply must not read as untracked",
    ).toBe("settled")
    expect(row?.settled_by, "the settler is the daemon's fact, not a guess").toBe(RESPONDER)
  })
})
