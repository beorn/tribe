/**
 * @failure 30743: a tracked send has one request id and N message ids. fetch --ids
 *          cannot resolve the request id, so a seat that quotes the ball it was told
 *          to answer is answered settlement_unresolved; an id with no row anywhere
 *          lands in that same field, so "I have no row" reads as "an owed ball I
 *          have not settled".
 * @level    l2
 * @consumer the pre-drain settlement read through tribe.fetch ids, and the deadline
 *           notify that quotes the send's shared request id.
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

const SEAT = "@dev/brain"
const OTHER = "@dev/other"
const SENDER = "@cpo/update"
const TS = Date.UTC(2026, 9, 23, 17, 0, 0)
const REQ = "d9696732-2e5b-4f3b-9c11-0a5b8f1c4d2e"

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

describe("tribe.fetch ids — a request id and an unknown id (30743)", () => {
  let dir: string
  let db: Database
  let stmts: TribeStatements
  let ctx: TribeContext

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fetch-ids-30743-"))
    db = openDatabase(join(dir, "tribe.db"))
    stmts = createStatements(db)
    ctx = createTribeContext({
      db,
      stmts,
      sessionId: "sess-30743-read",
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
    // raw-delete-allow: this test's own mkdtemp root under os.tmpdir(); nothing here is outside the fixture.
    rmSync(dir, { recursive: true, force: true })
  })

  /** One row of a tracked send: its own message id, carrying the send's shared request id. */
  function message(id: string, request: string | null, recipient = SEAT): void {
    stmts.insertMessage.run({
      $id: id,
      $type: "request",
      $sender: SENDER,
      $recipient: recipient,
      $kind: "direct",
      $content: "please answer the poll",
      $bead_id: null,
      $ref: null,
      $ts: TS,
      $delivery: "push",
      $topic: null,
      $room_id: null,
      $request: request,
      $reply: null,
      $summary: null,
    })
  }

  /** One recipient's still-open ball of the shared request id. */
  function openBall(requestId: string, messageId: string, recipient: string): void {
    message(messageId, requestId, recipient)
    stmts.openPendingRequest.run({
      $request_id: requestId,
      $recipient: recipient,
      $sender: SENDER,
      $opened_at: TS,
      $expires_at: TS + 60_000,
      $message_id: messageId,
      $fanout: "all",
    })
  }

  function read(ids: string[]): ToolJson {
    return parseToolJson(handleToolCall(ctx, "tribe.fetch", { ids }, makeOpts()))
  }

  function events(res: ToolJson): Array<Record<string, unknown>> {
    return [...((res.events ?? []) as Array<Record<string, unknown>>)].sort((a, b) =>
      String(a.id).localeCompare(String(b.id)),
    )
  }

  it("control: the same rows resolve by their message ids", () => {
    openBall(REQ, "msg-30743-a", SEAT)
    openBall(REQ, "msg-30743-b", OTHER)

    const rows = events(read(["msg-30743-a", "msg-30743-b"]))

    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.settlement === "open")).toBe(true)
  })

  it("resolves a request id to the same rows as its message ids", () => {
    openBall(REQ, "msg-30743-a", SEAT)
    openBall(REQ, "msg-30743-b", OTHER)

    const byRequest = read([REQ])
    const byMessages = read(["msg-30743-a", "msg-30743-b"])

    expect(byRequest.settlement_unresolved ?? []).toEqual([])
    expect(events(byRequest)).toHaveLength(2)
    expect(events(byRequest)).toEqual(events(byMessages))
  })

  it("reports an id with no row anywhere under settlement_unknown_ids", () => {
    const absent = "0f0f0f0f-1111-4222-8333-444455556666"

    const res = read([absent])

    expect(res.settlement_unknown_ids).toEqual([absent])
    expect(res.settlement_unresolved ?? []).toEqual([])
    expect((res.events as Array<unknown>).length).toBe(0)
  })

  it("agrees with pending on the count for one tracked send", () => {
    openBall(REQ, "msg-30743-a", SEAT)
    openBall(REQ, "msg-30743-b", OTHER)

    const res = read([REQ])
    const pending = parseToolJson(handleToolCall(ctx, "tribe.pending", { owner: SEAT }, makeOpts()))
    const open = events(res).filter((row) => row.settlement === "open")

    expect(open).toHaveLength(2)
    expect((pending.pending as Array<unknown>).length).toBe(1)
  })
})
