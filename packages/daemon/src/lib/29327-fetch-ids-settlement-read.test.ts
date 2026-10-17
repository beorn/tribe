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
  function openBall(id: string, recipient = SEAT): void {
    message(id, id, recipient)
    stmts.openPendingRequest.run({
      $request_id: id,
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
  function closedBall(id: string, settledBy = SENDER): void {
    message(id, id)
    stmts.insertMessage.run({
      $id: `fact-${id}`,
      $type: "event.ball.settled",
      $sender: "daemon",
      $recipient: SEAT,
      $kind: "event",
      $content: JSON.stringify({
        schema_version: 1,
        request_id: id,
        recipient: SEAT,
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
      $ref: id,
      $ts: TS + 90_000,
      $delivery: "pull",
      $topic: null,
      $room_id: null,
      $request: null,
      $reply: null,
      $summary: null,
    })
  }

  function read(ids: string[]): ToolJson {
    return parseToolJson(handleToolCall(ctx, "tribe.fetch", { ids }, makeOpts()))
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

  it("names an id it knows no message for instead of answering it as untracked", () => {
    const absent = "0f0f0f0f-1111-4222-8333-444455556666"

    const res = read([absent])

    expect(res.settlement_unresolved).toEqual([absent])
    // The absence is not smuggled onto a row as a state.
    expect((res.events as Array<unknown>).length).toBe(0)
  })

  it("reads the ball by the MESSAGE's recipient, so a watch-role seat is never told a live ball is settled", () => {
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

  it("answers undecided for EVERY row when the lookup stops at its budget, and names the cause", () => {
    logs.length = 0
    openBall("msg-29327-over-budget")
    for (let index = 0; index <= SETTLEMENT_LOOKUP_BUDGET; index += 1) openBall(`msg-29327-ball-${index}`)

    const res = read(["msg-29327-over-budget"])
    const events = res.events as Array<Record<string, unknown>>

    expect(events[0]?.settlement).toBe("undecided")
    expect(events[0]?.settled).toBeUndefined()
    expect((res.settlement_lookup as { status?: string })?.status).toBe("unavailable")
    expect(String((res.settlement_lookup as { detail?: string })?.detail)).toMatch(/exceed the settlement lookup budget/)
    expect(logs.some((entry) => entry.level === "warn" && String(entry.msg).includes("could not decide"))).toBe(true)
  })
})
