/**
 * habwire roadmap stage 2(d) — one ball per incident.
 *
 * Operator ruling 2026-08-02: "at least any watcher should perhaps mint ONE
 * ball not one every tick" → "ONE ball per incident" → "to make it simple for
 * now we can perhaps have just one ball per incident."
 *
 * The shape under test is neither zero balls (the landed blanket ban, which
 * relabels an obligation as an unread log line) nor one per tick (the measured
 * flood: 46 WATCH rows across 46 senders, ~10.5/hour). It is ONE standing
 * obligation per live condition, closed when the condition clears — so the
 * open pile is bounded by the number of distinct conditions rather than by
 * watcher cadence.
 *
 * These tests assert the shape by EMPTYING it deliberately: fire the same
 * condition N times and assert exactly one open row, then clear the condition
 * and assert it closes. Reading the mechanism is not evidence.
 *
 * Note on coverage: a test that varied only the emitter would pass vacuously,
 * because the emitter alone already differs between watchers. Subject and
 * condition are therefore varied INDEPENDENTLY below — the key has three parts
 * for a reason.
 *
 * Deliberately absent: any severity assertion. Severity gating is scope-cut.
 */

import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { incidentKey, parseIncidentKey } from "./incident.ts"
import { sendMessage } from "./messaging.ts"

function makeContext(db: Database, stmts: TribeStatements, name: string): TribeContext {
  return createTribeContext({
    db,
    stmts,
    sessionId: `sess-${name}`,
    sessionRole: "member",
    initialName: name,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
}

const WATCHER = "health-monitor"

describe("one ball per incident (habwire stage 2(d))", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "one-ball-per-incident-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  /** Emit one observation of a live condition, the way a watcher tick does. */
  function observe(
    ctx: TribeContext,
    identity: { emitter?: string; subject: string; condition: string },
    active = true,
  ) {
    return sendMessage(
      ctx,
      "@chief",
      `${identity.subject} ${identity.condition}`,
      "notify",
      undefined,
      undefined,
      "direct",
      {},
      {
        incident: {
          emitter: identity.emitter ?? WATCHER,
          subject: identity.subject,
          condition: identity.condition,
          active,
        },
      },
    )
  }

  function openKeys(recipient: string): string[] {
    return (stmts.selectPendingForRecipient.all({ $recipient: recipient }) as Array<{ request_id: string }>)
      .map((r) => r.request_id)
      .sort()
  }

  it("N observations of ONE condition leave exactly one open ball", () => {
    const watcher = makeContext(db, stmts, "@fleet")

    // A flapping condition observed on five consecutive ticks.
    for (let tick = 0; tick < 5; tick++) {
      observe(watcher, { subject: "@dev/5", condition: "transport-wedged" })
    }

    const open = openKeys("@chief")
    expect(open).toHaveLength(1)
    expect(open[0]).toBe(incidentKey({ emitter: WATCHER, subject: "@dev/5", condition: "transport-wedged" }))
  })

  it("every observation is still durable history — dedupe bounds obligations, not the log", () => {
    const watcher = makeContext(db, stmts, "@fleet")
    for (let tick = 0; tick < 3; tick++) {
      observe(watcher, { subject: "@dev/5", condition: "transport-wedged" })
    }

    // The pile is a current-conditions projection; the journal is not deduped.
    const messageCount = db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE sender = ? AND recipient = ?")
      .get("@fleet", "@chief") as { n: number }
    expect(messageCount.n).toBe(3)
    expect(openKeys("@chief")).toHaveLength(1)
  })

  it("the clearing edge auto-closes the ball with no operator verb", () => {
    const watcher = makeContext(db, stmts, "@fleet")
    observe(watcher, { subject: "@dev/5", condition: "transport-wedged" })
    observe(watcher, { subject: "@dev/5", condition: "transport-wedged" })
    expect(openKeys("@chief")).toHaveLength(1)

    // The watcher observes the condition no longer holding.
    const cleared = observe(watcher, { subject: "@dev/5", condition: "transport-wedged" }, false)

    expect(openKeys("@chief")).toHaveLength(0)
    expect(cleared.tracker?.closed).toBe(1)
  })

  it("re-arms after clearing: the same condition returning opens one ball again", () => {
    const watcher = makeContext(db, stmts, "@fleet")
    observe(watcher, { subject: "@dev/5", condition: "transport-wedged" })
    observe(watcher, { subject: "@dev/5", condition: "transport-wedged" }, false)
    expect(openKeys("@chief")).toHaveLength(0)

    observe(watcher, { subject: "@dev/5", condition: "transport-wedged" })
    expect(openKeys("@chief")).toHaveLength(1)
  })

  it("a different SUBJECT from the same emitter and condition mints a separate ball", () => {
    const watcher = makeContext(db, stmts, "@fleet")
    observe(watcher, { subject: "@dev/5", condition: "transport-wedged" })
    observe(watcher, { subject: "@dev/7", condition: "transport-wedged" })

    expect(openKeys("@chief")).toEqual(
      [
        incidentKey({ emitter: WATCHER, subject: "@dev/5", condition: "transport-wedged" }),
        incidentKey({ emitter: WATCHER, subject: "@dev/7", condition: "transport-wedged" }),
      ].sort(),
    )
  })

  it("a different CONDITION on the same subject mints a separate ball", () => {
    const watcher = makeContext(db, stmts, "@fleet")
    observe(watcher, { subject: "@dev/5", condition: "transport-wedged" })
    observe(watcher, { subject: "@dev/5", condition: "quota-exhausted" })

    expect(openKeys("@chief")).toEqual(
      [
        incidentKey({ emitter: WATCHER, subject: "@dev/5", condition: "transport-wedged" }),
        incidentKey({ emitter: WATCHER, subject: "@dev/5", condition: "quota-exhausted" }),
      ].sort(),
    )
  })

  it("clearing one condition leaves the subject's other condition open", () => {
    const watcher = makeContext(db, stmts, "@fleet")
    observe(watcher, { subject: "@dev/5", condition: "transport-wedged" })
    observe(watcher, { subject: "@dev/5", condition: "quota-exhausted" })

    observe(watcher, { subject: "@dev/5", condition: "transport-wedged" }, false)

    expect(openKeys("@chief")).toEqual([
      incidentKey({ emitter: WATCHER, subject: "@dev/5", condition: "quota-exhausted" }),
    ])
  })

  it("a malformed identity fails loud rather than collapsing onto a partial key", () => {
    const watcher = makeContext(db, stmts, "@fleet")

    expect(() => observe(watcher, { subject: "   ", condition: "transport-wedged" })).toThrow(/non-empty subject/i)
    // An embedded separator would let two distinct conditions parse as one.
    expect(() => observe(watcher, { subject: "@dev/5", condition: "a:b" })).toThrow(/may not contain/i)
    expect(openKeys("@chief")).toHaveLength(0)
  })

  it("an incident identity and an explicit request id together are refused, not silently merged", () => {
    const watcher = makeContext(db, stmts, "@fleet")
    expect(() =>
      sendMessage(
        watcher,
        "@chief",
        "ambiguous",
        "notify",
        undefined,
        undefined,
        "direct",
        {},
        {
          request: "req-explicit",
          incident: { emitter: WATCHER, subject: "@dev/5", condition: "transport-wedged" },
        },
      ),
    ).toThrow(/incident identity/i)
  })

  it("the open ball is addressable as its identity — the pile reads as current conditions", () => {
    const watcher = makeContext(db, stmts, "@fleet")
    observe(watcher, { subject: "@dev/5", condition: "transport-wedged" })

    const [key] = openKeys("@chief")
    expect(parseIncidentKey(key!)).toEqual({
      emitter: WATCHER,
      subject: "@dev/5",
      condition: "transport-wedged",
    })
  })
})
