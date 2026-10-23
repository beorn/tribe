/**
 * @failure 29327: a fetch --ids read answers with the rows but says nothing
 *          about the state of the ball behind each one, so the ag host decides
 *          "owed" from a label it never received and a settled request opens a
 *          turn as owed work. An id the daemon knows no message for, and a
 *          lookup that stops at its budget, must not answer as owed either.
 * @level    l2
 * @consumer the ag host's pre-drain settlement read (controller.ts), through
 *           `tribe.fetch ids` — @cto verdict 68eebc77 (2026-10-17): shape GO,
 *           route GO, four explicit answers and a named cause.
 * @testonly none
 */
import type { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { SETTLEMENT_LOOKUP_BUDGET, handleToolCall, type HandlerOpts } from "./handlers.ts"
import { registerSession } from "./session.ts"

/**
 * The daemon's OWN log (@cto 2026-10-17): a fallback that names its cause only
 * in the response is still a silent error for whoever reads the daemon's log.
 */
const logs = vi.hoisted(() => [] as Array<{ level: string; msg: unknown; ns: string }>)
vi.mock("loggily", async (original) => {
  const actual = await original<typeof import("loggily")>()
  const logger = (ns: string) => ({
    info: (msg: unknown) => logs.push({ level: "info", msg, ns }),
    warn: (msg: unknown) => logs.push({ level: "warn", msg, ns }),
    error: (msg: unknown) => logs.push({ level: "error", msg, ns }),
    debug: () => {},
    child: () => logger(ns),
  })
  return { ...actual, createLogger: (ns: string) => logger(ns) }
})

const SEAT = "@dev/brain"
const SENDER = "@chief"
const OTHER = "@dev/other"
const REQ = "d9696732-2e5b-4f3b-9c11-0a5b8f1c4d2e"
const TS = Date.UTC(2026, 9, 17, 3, 0, 0)

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

describe("tribe.fetch ids — the pre-drain settlement read (29327)", () => {
  let dir: string
  let db: Database
  let stmts: TribeStatements
  let ctx: TribeContext

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fetch-ids-29327-"))
    db = openDatabase(join(dir, "tribe.db"))
    stmts = createStatements(db)
    ctx = createTribeContext({
      db,
      stmts,
      sessionId: "sess-29327-read",
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
    // raw-delete-allow: this test's own mkdtemp root under os.tmpdir(); removely is not a dependency of vendor/tribe, and nothing here is outside the fixture.
    rmSync(dir, { recursive: true, force: true })
  })

  /** One message row. `request` names the ball it opened, null when it never
   *  opened one (the untracked shape). */
  function message(id: string, request: string | null, recipient = SEAT): void {
    stmts.insertMessage.run({
      $id: id,
      $type: "request",
      $sender: SENDER,
      $recipient: recipient,
      $kind: "direct",
      $content: "please take this",
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

  /** A balled message whose ball is STILL OPEN for this seat. */
  function openBall(id: string, recipient = SEAT, requestId = id): void {
    message(id, requestId, recipient)
    stmts.openPendingRequest.run({
      $request_id: requestId,
      $recipient: recipient,
      $sender: SENDER,
      $opened_at: TS,
      $expires_at: TS + 60_000,
      $message_id: id,
      $fanout: "first",
    })
  }

  /** A balled message whose ball has CLOSED: `closePendingRequest` DELETEs the
   *  tracker row, so the row's absence is the whole settlement authority. */
  function closedBall(id: string, settledBy = SENDER, recipient = SEAT, requestId = id): void {
    message(id, requestId, recipient)
    stmts.insertMessage.run({
      $id: `fact-${id}`,
      $type: "event.ball.settled",
      $sender: "daemon",
      $recipient: recipient,
      $kind: "event",
      $content: JSON.stringify({
        schema_version: 1,
        request_id: requestId,
        recipient,
        sender: SENDER,
        opened_at: TS,
        expires_at: TS + 60_000,
        message_id: id,
        fanout: "first",
        summary: null,
        settlement: "answered",
        settled_at: TS + 90_000,
        settled_by: settledBy,
      }),
      $bead_id: null,
      $ref: requestId,
      $ts: TS + 90_000,
      $delivery: "pull",
      $topic: null,
      $room_id: null,
      $request: null,
      $reply: null,
      $summary: null,
    })
  }

  function read(ids: string[], limit?: number): ToolJson {
    return parseToolJson(
      handleToolCall(ctx, "tribe.fetch", { ids, ...(limit === undefined ? {} : { limit }) }, makeOpts()),
    )
  }

  /** One durable settlement fact for `recipient`'s row of `requestId`. The
   *  reason is the daemon's own: only "answered" means the ball was answered. */
  function settledFact(
    requestId: string,
    messageId: string,
    recipient: string,
    reason: string,
    settledBy: string,
    settledAt = TS + 90_000,
  ): void {
    stmts.insertMessage.run({
      $id: `fact-${requestId}-${recipient}`,
      $type: "event.ball.settled",
      $sender: "daemon",
      $recipient: recipient,
      $kind: "event",
      $content: JSON.stringify({
        schema_version: 1,
        request_id: requestId,
        recipient,
        sender: SENDER,
        opened_at: TS,
        expires_at: TS + 60_000,
        message_id: messageId,
        fanout: "all",
        summary: null,
        settlement: reason,
        settled_at: settledAt,
        settled_by: settledBy,
      }),
      $bead_id: null,
      $ref: requestId,
      $ts: settledAt,
      $delivery: "pull",
      $topic: null,
      $room_id: null,
      $request: null,
      $reply: null,
      $summary: null,
    })
  }

  it("answers open, settled and untracked for the rows it returns, naming the settler", () => {
    openBall("msg-29327-open")
    closedBall("msg-29327-settled")
    message("msg-29327-untracked", null)

    const res = read(["msg-29327-open", "msg-29327-settled", "msg-29327-untracked"])
    const events = res.events as Array<Record<string, unknown>>
    const byId = new Map(events.map((event) => [String(event.id), event]))

    expect(byId.get("msg-29327-open")?.settlement).toBe("open")
    expect(byId.get("msg-29327-settled")?.settlement).toBe("settled")
    // The settler comes from the daemon's own fact, never from a report row.
    expect(byId.get("msg-29327-settled")?.settled_by).toBe(SENDER)
    expect(byId.get("msg-29327-untracked")?.settlement).toBe("untracked")
    // Every returned row carries an explicit answer: a consumer must never infer
    // a state from a missing label.
    for (const id of ["msg-29327-open", "msg-29327-settled", "msg-29327-untracked"]) {
      expect(byId.get(id)?.settlement, id).toBeDefined()
    }
  })

  // 29707 (@cto 2026-10-17, non-blocking: recheck the bounced case after item 2).
  // A bounced send keeps its message addressed to the ORIGINAL target while the
  // ball is opened for the FALLBACK owner (handlers.ts persistDelivery: owner is
  // `resolution.to`). A read keyed on the recipients the messages name cannot see
  // that ball for the original addressee; a read keyed on the IDS can, wherever
  // the ball now lives.
  it("reads a bounced row's ball open, though it is owned by the fallback name", () => {
    const ORIGINAL = "@dev/offline-target"
    const FALLBACK = "@dev/fallback-owner"
    const id = "msg-29327-bounced"
    message(id, id, ORIGINAL)
    stmts.openPendingRequest.run({
      $request_id: id,
      $recipient: FALLBACK,
      $sender: SENDER,
      $opened_at: TS,
      $expires_at: TS + 60_000,
      $message_id: id,
      $fanout: "first",
    })

    const res = read([id])
    const events = res.events as Array<Record<string, unknown>>
    const byId = new Map(events.map((event) => [String(event.id), event]))

    expect(byId.get(id)?.settlement).toBe("open")
    // The verdict names WHO holds it: the fallback owner, never the original
    // addressee the message still names.
    expect(byId.get(id)?.owners).toEqual([FALLBACK])
    expect(res.settlement_unresolved ?? []).toEqual([])
  })

  it("names an id it knows no message for instead of answering it as untracked", () => {
    const absent = "0f0f0f0f-1111-4222-8333-444455556666"

    const res = read([absent])

    expect(res.settlement_unknown_ids).toEqual([absent])
    expect(res).not.toHaveProperty("settlement_unresolved")
    // The absence is not smuggled onto a row as a state.
    expect((res.events as Array<unknown>).length).toBe(0)
  })

  it("reads the ball by the ids the batch names, so a watch-role seat is never told a live ball is settled", () => {
    // @cto verdict 2026-10-17 (ruling 2). A watch-role adapter is NOT a ball's
    // recipient: the ag adapter registers `watch` whenever its host name differs
    // from the mirrored persona name (tribe.ts `hostOwnsTargetIdentity`), and that
    // is the ordinary case for a mirrored seat. Before this, the read was scoped
    // to the seat ASKING, found no tracker row for work the target still owed, and
    // answered `settled` — the defect that closes a turn on live owed work.
    const TARGET = "@dev/luna3"
    openBall("msg-29327-watched", TARGET)

    const res = read(["msg-29327-watched"])
    const events = res.events as Array<Record<string, unknown>>

    expect(events[0]?.settlement).toBe("open")
  })

  it("reads an open BROADCAST ball as open, though no tracker row carries '*' as a recipient", () => {
    // @cto verdict 2026-10-17 (C1, correcting ruling 2). A `*` send's ball is
    // opened ONCE PER OWNER — messaging.ts inserts the tracker row with
    // `$recipient: owner` — so the message's recipient is `*` while the ball's is
    // a seat. A read keyed on "the recipients these messages name" therefore
    // misses every open broadcast ball and answers `settled`: the same defect
    // through a different door. Only the IDS can be asked about, and here the
    // ball is open for the very seat doing the reading.
    message("msg-29327-broadcast", "msg-29327-broadcast", "*")
    stmts.openPendingRequest.run({
      $request_id: "msg-29327-broadcast",
      $recipient: SEAT,
      $sender: SENDER,
      $opened_at: TS,
      $expires_at: TS + 60_000,
      $message_id: "msg-29327-broadcast",
      $fanout: "all",
    })

    const res = read(["msg-29327-broadcast"])
    const events = res.events as Array<Record<string, unknown>>

    expect(events[0]?.settlement).toBe("open")
  })

  it("answers undecided for EVERY row when the lookup stops at its budget, and names the cause", () => {
    logs.length = 0
    // The read is keyed on the ids it was asked about, so the over-run can only
    // come from the BATCH itself: every one of these ids is in the request, and
    // one more than the budget is open. (An owner-scoped read could trip this
    // from someone else's busy mailbox; an id-keyed one cannot, which is the
    // point — the work done is proportional to what was asked, never to how much
    // traffic the seat happens to be carrying.)
    const ids = ["msg-29327-over-budget"]
    for (let index = 0; index < SETTLEMENT_LOOKUP_BUDGET; index += 1) ids.push(`msg-29327-ball-${index}`)
    for (const id of ids) openBall(id)

    const res = read(ids)
    const events = res.events as Array<Record<string, unknown>>

    expect(events[0]?.settlement).toBe("undecided")
    expect(events[0]?.settled).toBeUndefined()
    expect((res.settlement_lookup as { status?: string })?.status).toBe("unavailable")
    expect(String((res.settlement_lookup as { detail?: string })?.detail)).toMatch(
      /exceed the settlement lookup budget/,
    )
    expect(logs.some((entry) => entry.level === "warn" && String(entry.msg).includes("could not decide"))).toBe(true)
  })

  // The open verdict must name WHO holds the ball, and the owner set and the
  // settlement facts must come from one snapshot. The OPEN rows below are RED
  // when the owner column is reverted: `owners` is then undefined. The settled
  // row is the control — it must carry no owner set either way.
  it("names the owner holding the ball on an open verdict (29707 control)", () => {
    openBall("msg-29707-control")

    const res = read(["msg-29707-control"])
    const byId = new Map((res.events as Array<Record<string, unknown>>).map((event) => [String(event.id), event]))

    expect(byId.get("msg-29707-control")?.settlement).toBe("open")
    expect(byId.get("msg-29707-control")?.owners).toEqual([SEAT])
  })

  it("reports every owner holding an open ball for one message (per-owner broadcast)", () => {
    const A = "@dev/broadcast-a"
    const B = "@dev/broadcast-b"
    const id = "msg-29707-broadcast"
    message(id, "req-29707-broadcast-a", A)
    for (const [requestId, recipient] of [
      ["req-29707-broadcast-a", A],
      ["req-29707-broadcast-b", B],
    ] as const) {
      stmts.openPendingRequest.run({
        $request_id: requestId,
        $recipient: recipient,
        $sender: SENDER,
        $opened_at: TS,
        $expires_at: TS + 60_000,
        $message_id: id,
        $fanout: "all",
      })
    }

    const res = read([id])
    const byId = new Map((res.events as Array<Record<string, unknown>>).map((event) => [String(event.id), event]))

    expect(byId.get(id)?.settlement).toBe("open")
    expect(byId.get(id)?.owners).toEqual([A, B])
  })

  it("carries no owner set on a settled verdict, so a closed row cannot read as open under someone", () => {
    closedBall("msg-29707-settled")

    const res = read(["msg-29707-settled"])
    const byId = new Map((res.events as Array<Record<string, unknown>>).map((event) => [String(event.id), event]))

    expect(byId.get("msg-29707-settled")?.settlement).toBe("settled")
    expect(byId.get("msg-29707-settled")).not.toHaveProperty("owners")
  })
  it("rides the settlement facts on an open verdict, so a shared ball's answered owner is visible (29707)", () => {
    const A = "@dev/shared-a"
    const B = "@dev/shared-b"
    const id = "msg-29707-shared"
    const requestId = "req-29707-shared"
    message(id, requestId, "*")
    stmts.openPendingRequest.run({
      $request_id: requestId,
      $recipient: B,
      $sender: SENDER,
      $opened_at: TS,
      $expires_at: TS + 60_000,
      $message_id: id,
      $fanout: "all",
    })
    stmts.insertMessage.run({
      $id: `fact-${requestId}-a`,
      $type: "event.ball.settled",
      $sender: "daemon",
      $recipient: A,
      $kind: "event",
      $content: JSON.stringify({
        schema_version: 1,
        request_id: requestId,
        recipient: A,
        sender: SENDER,
        opened_at: TS,
        expires_at: TS + 60_000,
        message_id: id,
        fanout: "all",
        summary: null,
        settlement: "answered",
        settled_at: TS + 90_000,
        settled_by: A,
      }),
      $bead_id: null,
      $ref: requestId,
      $ts: TS + 90_000,
      $delivery: "pull",
      $topic: null,
      $room_id: null,
      $request: null,
      $reply: null,
      $summary: null,
    })

    const res = read([id])
    const byId = new Map((res.events as Array<Record<string, unknown>>).map((event) => [String(event.id), event]))

    expect(byId.get(id)?.settlement).toBe("open")
    expect(byId.get(id)?.owners).toEqual([B])
    expect(byId.get(id)?.settlements).toEqual([
      { owner: A, settled_by: A, settled_at: new Date(TS + 90_000).toISOString(), reason: "answered" },
    ])
  })

  it("keeps a shared ball open under the owner still holding it when MY row closes without an answer", () => {
    const MINE = "@dev/brain"
    const OTHER = "@dev/shared-other"
    const id = "msg-29707-not-an-answer"
    const requestId = "req-29707-not-an-answer"
    message(id, requestId, "*")
    stmts.openPendingRequest.run({
      $request_id: requestId,
      $recipient: OTHER,
      $sender: SENDER,
      $opened_at: TS,
      $expires_at: TS + 60_000,
      $message_id: id,
      $fanout: "all",
    })
    // My own row closed by the roster sweep, never by a reply or a verdict.
    settledFact(requestId, id, MINE, "gc-expired", "declared-roster")

    const res = read([id])
    const byId = new Map((res.events as Array<Record<string, unknown>>).map((event) => [String(event.id), event]))

    // A non-answer close on my row is not a settlement of the shared ball: the
    // other owner still holds it, so this must read open under them.
    expect(byId.get(id)?.settlement).toBe("open")
    expect(byId.get(id)?.owners).toEqual([OTHER])
    // The reader must be able to tell a close from an answer, so the reason
    // rides the fact instead of being dropped.
    expect((byId.get(id)?.settlements as Array<Record<string, unknown>>)[0]?.reason).toBe("gc-expired")
  })

  // A fact belongs to its REQUEST, not to the one message id the batch happens
  // to name: the ball can have been opened from another message of the same
  // request. Admitting by message id drops exactly that fact, and the row then
  // reads as if nobody had settled my share.
  it("admits a settlement fact recorded under another message of the same request", () => {
    const MINE = "@dev/brain"
    const OTHER = "@dev/shared-other"
    const id = "msg-29707-other-message"
    const requestId = "req-29707-other-message"
    const originMessage = "msg-29707-ball-origin"
    message(id, requestId, "*")
    stmts.openPendingRequest.run({
      $request_id: requestId,
      $recipient: OTHER,
      $sender: SENDER,
      $opened_at: TS,
      $expires_at: TS + 60_000,
      $message_id: originMessage,
      $fanout: "all",
    })
    settledFact(requestId, originMessage, MINE, "answered", MINE)

    const res = read([id])
    const byId = new Map((res.events as Array<Record<string, unknown>>).map((event) => [String(event.id), event]))

    expect(byId.get(id)?.settlement).toBe("open")
    expect(byId.get(id)?.owners).toEqual([OTHER])
    expect((byId.get(id)?.settlements as Array<Record<string, unknown>>)[0]).toMatchObject({
      owner: MINE,
      reason: "answered",
    })
  })
  it("control: the same rows resolve by their message ids", () => {
    openBall("msg-30743-a", SEAT, REQ)
    openBall("msg-30743-b", OTHER, REQ)

    const rows = events(read(["msg-30743-a", "msg-30743-b"]))

    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.settlement === "open")).toBe(true)
  })

  it("resolves a request id to the same rows as its message ids", () => {
    openBall("msg-30743-a", SEAT, REQ)
    openBall("msg-30743-b", OTHER, REQ)

    const byRequest = read([REQ])
    const byMessages = read(["msg-30743-a", "msg-30743-b"])

    expect(byRequest.settlement_unresolved ?? []).toEqual([])
    expect(events(byRequest)).toHaveLength(2)
    expect(events(byRequest)).toEqual(events(byMessages))
  })

  it("agrees with pending on the count for one tracked send", () => {
    openBall("msg-30743-a", SEAT, REQ)
    openBall("msg-30743-b", OTHER, REQ)

    const res = read([REQ])
    const pending = parseToolJson(handleToolCall(ctx, "tribe.pending", { owner: SEAT }, makeOpts()))
    const open = events(res).filter((row) => row.settlement === "open")

    expect(open).toHaveLength(2)
    expect((pending.pending as Array<unknown>).length).toBe(1)
  })

  it("resolves a closed request id to its settled row, not to an owed ball", () => {
    const closed = "aa11bb22-cc33-4d44-8e55-ff6600112233"
    closedBall("msg-30743-closed", SENDER, SEAT, closed)

    const res = read([closed])
    const rows = events(res)

    expect(res.settlement_unresolved ?? []).toEqual([])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.settlement).toBe("settled")
    expect(rows[0]?.settled_by).toBe(SENDER)
    expect(rows[0]).not.toHaveProperty("owners")
  })

  it("keeps a closed and an open request apart under mixed owners, and names the unknown id", () => {
    const open = "bb22cc33-dd44-4e55-9f66-aa7700223344"
    const closed = "cc33dd44-ee55-4f66-a077-bb8800334455"
    const absent = "0f0f0f0f-1111-4222-8333-444455556666"
    openBall("msg-30743-open", SEAT, open)
    closedBall("msg-30743-closed", SENDER, OTHER, closed)

    const res = read([open, closed, absent])
    const byId = new Map(events(res).map((row) => [String(row.id), row]))

    expect(res.settlement_unknown_ids).toEqual([absent])
    expect(res.settlement_unresolved ?? []).toEqual([])
    expect([...byId.keys()].sort()).toEqual(["msg-30743-closed", "msg-30743-open"])
    expect(byId.get("msg-30743-open")?.settlement).toBe("open")
    expect(byId.get("msg-30743-open")?.owners).toEqual([SEAT])
    expect(byId.get("msg-30743-closed")?.settlement).toBe("settled")
    expect(byId.get("msg-30743-closed")?.settled_by).toBe(SENDER)
  })
  function events(result: ToolJson): Array<Record<string, unknown>> {
    return [...(result.events as Array<Record<string, unknown>>)].sort((a, b) =>
      String(a.id).localeCompare(String(b.id)),
    )
  }

  // AC2: retained members must remain identifiable without reading archived bodies.
  it.each(["open", "closed"] as const)(
    "returns an archived %s member with state and an explicit body marker",
    (state) => {
      const id = "msg-30743-archived"
      if (state === "open") openBall(id, SEAT, REQ)
      else closedBall(id, SENDER, SEAT, REQ)
      db.prepare(`INSERT INTO messages_archive (seq,id,type,sender,recipient,kind,content,ts,delivery,archived_at,request)
      SELECT rowid,id,type,sender,recipient,kind,content,ts,delivery,?,request FROM messages WHERE id=?`).run(
        TS + 100_000,
        id,
      )
      db.prepare("DELETE FROM messages WHERE id=?").run(id)

      const result = read([REQ])
      const rows = events(result)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ id, settlement: state === "closed" ? "settled" : "open", body_archived: true })
      expect(rows[0]).not.toHaveProperty("content")
      expect(result.settlement_unknown_ids ?? []).not.toContain(REQ)
    },
  )

  it("deduplicates request/member inputs without consuming the row budget twice", () => {
    for (const suffix of ["a", "b", "c"]) openBall(`msg-30743-${suffix}`, `@dev/${suffix}`, REQ)
    const complete = read([REQ, "msg-30743-a", REQ], 3)
    expect(events(complete).map((row) => row.id)).toEqual(["msg-30743-a", "msg-30743-b", "msg-30743-c"])
    expect(complete.settlement_lookup).toBeUndefined()
  })

  // AC2: expansion remains partial even when the separate settlement read also stops at its budget.
  // Prior budget coverage asked only explicit message ids; it never expanded one request.
  it.each([3, SETTLEMENT_LOOKUP_BUDGET + 1])("names omitted members of a %i-member request as partial", (count) => {
    for (let index = 0; index < count; index++) openBall(`msg-30743-${index}`, `@dev/${index}`, REQ)
    const partial = read([REQ], 2)
    expect(events(partial)).toHaveLength(2)
    expect(events(partial).every((row) => row.settlement === "undecided")).toBe(true)
    expect(partial.settlement_lookup).toMatchObject({ status: "partial", budget: 2 })
    const detail = String((partial.settlement_lookup as { detail: string }).detail)
    expect(detail).toContain(REQ)
    expect(detail).toContain(`${count - 2} of ${count} member`)
    if (count > SETTLEMENT_LOOKUP_BUDGET) expect(detail).toContain("exceed the settlement lookup budget")
    expect(partial.settlement_unknown_ids ?? []).not.toContain(REQ)
  })
})
