/**
 * @failure An incident its owner closed with evidence re-opened and paged on the emitter's next identical send,
 *          because the transition read only an open ball and a close deletes it (#30551: one ag set re-paged four
 *          times in a day, and the same run's guard-2 alarms re-opened as deadline pages).
 * @level l1
 * @consumer every incident emitter; component-ci-reader and post-merge-tests guard 2 are the two measured doors
 * @testonly none
 *
 * With no ball standing, a send that sets suppress_after_evidence and whose summary equals the summary its owner
 * closed with evidence is "suppressed": recorded, no ball, no wake. Everything else opens, so the rule only fails
 * toward paging (@cto 97d43fc4). The flag is read from the current send only (@cto 85130374, option A).
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createTribeContext } from "./lib/context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./lib/database.ts"
import { handleToolCall, type HandlerOpts } from "./lib/handlers.ts"
import { sendMessage, settlePendingRows, type PendingSettlementRow } from "./lib/messaging.ts"
import { incidentKey } from "tribe-wire"

const OWNER = "@dev/fixer"
const INCIDENT = { emitter: "component-ci-reader", subject: "ag", condition: "ci-red-at-pin" }
const KEY = incidentKey(INCIDENT)
const SET_A = "ag: 17 reds at 0667c848 [set e5bdd466]"
const SET_B = "ag: 18 reds at 3dfb7365 [set 94ddeceb]"

let db: ReturnType<typeof openDatabase>
let stmts: TribeStatements

beforeEach(() => {
  db = openDatabase(":memory:")
  stmts = createStatements(db)
})
afterEach(() => {
  db.close()
})

function context(sessionId: string, name: string) {
  return createTribeContext({
    db,
    stmts,
    sessionId,
    sessionRole: "member",
    initialName: name,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
}

const opts = (): HandlerOpts => ({
  cleanup: () => {},
  userRenamed: false,
  setUserRenamed: () => {},
  getActiveSessionIds: () => new Set<string>(),
  hasActiveTransport: () => false,
  getActiveSessionInfo: () => [],
})

function rig() {
  const emitter = context("daemon", "component-ci-reader")
  const owner = context("owner", OWNER)
  const page = (summary: string | undefined, active = true, suppressAfterEvidence = true) =>
    sendMessage(
      emitter,
      OWNER,
      `${summary ?? "no summary"} body`,
      "notify",
      undefined,
      undefined,
      "direct",
      summary === undefined ? {} : { summary },
      { incident: { ...INCIDENT, active, ...(suppressAfterEvidence ? { suppressAfterEvidence } : {}) } },
    )
  const closeWithEvidence = () => {
    const result = JSON.parse(
      (
        handleToolCall(
          owner,
          "tribe.pending",
          { owner: OWNER, close: KEY, close_evidence: "every row green at descendant main 3dfb7365" },
          opts(),
        ) as { content: Array<{ text: string }> }
      ).content[0]!.text,
    ) as { closed: number }
    expect(result.closed).toBe(1)
  }
  const openBalls = () =>
    (stmts.selectPendingForRecipient.all({ $recipient: OWNER }) as Array<{ request_id: string }>).filter(
      (row) => row.request_id === KEY,
    ).length
  return { page, closeWithEvidence, openBalls }
}

describe("an evidence close suppresses an identical re-send (#30551)", () => {
  test("the same summary after an evidence close is suppressed: no ball, no wake, and the observation is kept", () => {
    const { page, closeWithEvidence, openBalls } = rig()
    expect(page(SET_A).incident).toEqual({ transition: "opened", wakesOwner: true })
    closeWithEvidence()

    const again = page(SET_A)
    expect(again.incident).toEqual({ transition: "suppressed", wakesOwner: false })
    expect(openBalls()).toBe(0)
    const row = db.query("SELECT request, wakes_owner, summary FROM messages WHERE id = ?").get(again.id) as {
      request: string | null
      wakes_owner: number
      summary: string
    }
    expect(row).toEqual({ request: null, wakes_owner: 0, summary: SET_A })
    // Still suppressed on the next tick: the evidence close stays the newest closing fact.
    expect(page(SET_A).incident?.transition).toBe("suppressed")
  })

  test("a changed summary re-opens once, and the new summary then repeats as repeated", () => {
    const { page, closeWithEvidence, openBalls } = rig()
    page(SET_A)
    closeWithEvidence()
    expect(page(SET_B).incident).toEqual({ transition: "opened", wakesOwner: true })
    expect(openBalls()).toBe(1)
    expect(page(SET_B).incident).toEqual({ transition: "repeated", wakesOwner: false })
  })

  test("a clear while no ball is open leaves a fact and ends suppression", () => {
    const { page, closeWithEvidence, openBalls } = rig()
    page(SET_A)
    closeWithEvidence()
    const clear = page(SET_A, false)
    expect(clear.incident?.transition).toBe("cleared")
    const fact = db
      .query(
        "SELECT sender, content FROM messages WHERE kind = 'event' AND type = 'event.incident.cleared' AND ref = ?",
      )
      .get(KEY) as { sender: string; content: string } | null
    expect(fact?.sender).toBe("daemon")
    expect(JSON.parse(fact!.content)).toMatchObject({ request_id: KEY, sender: "component-ci-reader" })

    expect(page(SET_A).incident).toEqual({ transition: "opened", wakesOwner: true })
    expect(openBalls()).toBe(1)
  })

  test("a null summary is never suppressed", () => {
    const { page, closeWithEvidence } = rig()
    page(undefined)
    closeWithEvidence()
    expect(page(undefined).incident).toEqual({ transition: "opened", wakesOwner: true })
  })

  test("a settlement without evidence (gc-expired) does not suppress", () => {
    const { page, openBalls } = rig()
    page(SET_A)
    const rows = stmts.selectPendingSettlementsForRequest.all({ $request_id: KEY }) as PendingSettlementRow[]
    expect(settlePendingRows(context("gc", "daemon"), rows, "gc-expired", "daemon")).toBe(1)
    expect(page(SET_A).incident).toEqual({ transition: "opened", wakesOwner: true })
    expect(openBalls()).toBe(1)
  })

  test("an archive-tier settled fact still suppresses", () => {
    const { page, closeWithEvidence } = rig()
    page(SET_A)
    closeWithEvidence()
    db.run(`
      INSERT INTO messages_archive (seq, id, type, sender, recipient, kind, content, ts, delivery, request, reply, ref, summary, archived_at)
      SELECT rowid, id, type, sender, recipient, kind, content, ts, delivery, request, reply, ref, summary, ts
      FROM messages WHERE kind = 'event' AND type = 'event.ball.settled'
    `)
    db.run("DELETE FROM messages WHERE kind = 'event' AND type = 'event.ball.settled'")
    expect(
      (db.query("SELECT count(*) AS n FROM messages_archive WHERE type = 'event.ball.settled'").get() as { n: number })
        .n,
    ).toBe(1)
    expect(page(SET_A).incident?.transition).toBe("suppressed")
  })

  test("a deleted journal fact opens: retention ends suppression with one re-open", () => {
    const { page, closeWithEvidence } = rig()
    page(SET_A)
    closeWithEvidence()
    db.run("DELETE FROM messages WHERE kind = 'event' AND type = 'event.ball.settled'")
    expect(page(SET_A).incident?.transition).toBe("opened")
  })
})

describe("suppression is opt-in, read from the current send (#30551 option A)", () => {
  test("without the flag, an identical send after an evidence close re-opens and pages, as before", () => {
    const { page, closeWithEvidence, openBalls } = rig()
    page(SET_A, true, false)
    closeWithEvidence()
    expect(page(SET_A, true, false).incident).toEqual({ transition: "opened", wakesOwner: true })
    expect(openBalls()).toBe(1)
  })

  test("the flag suppresses, and a flag on an earlier send never decides a later unflagged one", () => {
    const { page, closeWithEvidence, openBalls } = rig()
    page(SET_A)
    closeWithEvidence()
    expect(page(SET_A).incident).toEqual({ transition: "suppressed", wakesOwner: false })
    expect(page(SET_A, true, false).incident).toEqual({ transition: "opened", wakesOwner: true })
    expect(openBalls()).toBe(1)
  })

  test("the flag followed by a clear re-opens the next flagged send", () => {
    const { page, closeWithEvidence, openBalls } = rig()
    page(SET_A)
    closeWithEvidence()
    expect(page(SET_A).incident?.transition).toBe("suppressed")
    expect(page(SET_A, false).incident?.transition).toBe("cleared")
    expect(page(SET_A).incident).toEqual({ transition: "opened", wakesOwner: true })
    expect(openBalls()).toBe(1)
  })

  test("tribe.send carries incident.suppress_after_evidence and refuses a non-boolean", () => {
    const { page, closeWithEvidence } = rig()
    page(SET_A)
    closeWithEvidence()
    const send = (flag: unknown) =>
      JSON.parse(
        (
          handleToolCall(
            context("daemon", "component-ci-reader"),
            "tribe.send",
            {
              to: OWNER,
              message: `${SET_A} body`,
              type: "request",
              summary: SET_A,
              incident: { ...INCIDENT, suppress_after_evidence: flag },
            },
            opts(),
          ) as { content: Array<{ text: string }> }
        ).content[0]!.text,
      ) as { error?: string; incident?: { transition: string } }
    expect(send("yes").error).toContain("incident.suppress_after_evidence")
    expect(send(true).incident?.transition).toBe("suppressed")
  })
})
