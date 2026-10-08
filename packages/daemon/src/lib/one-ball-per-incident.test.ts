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
import { handleToolCall, type HandlerOpts } from "./handlers.ts"
import { incidentKey, parseIncidentKey } from "tribe-wire"
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

  it("26899: ack by a seat other than the puller closes 1; a second pull leaves one ball", () => {
    const puller = makeContext(db, stmts, "@dev/13")
    const acker = makeContext(db, stmts, "@dev/fixer")
    const andon = { emitter: "andon", subject: "fleet-stop", condition: "active" }
    observe(puller, andon)
    expect(openKeys("@chief")).toEqual([incidentKey(andon)])

    const cleared = observe(acker, andon, false)
    expect(cleared.tracker?.closed).toBe(1)
    expect(openKeys("@chief")).toHaveLength(0)

    observe(puller, andon)
    expect(openKeys("@chief")).toEqual([incidentKey(andon)])
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

  // The mechanism above is unreachable unless an emitter can actually express
  // an incident on the wire. These pin the MCP surface, because a watcher that
  // cannot pass an identity falls back to minting one obligation per tick.
  describe("MCP tribe.send passthrough", () => {
    function makeOpts(): HandlerOpts {
      return {
        cleanup: () => undefined,
        userRenamed: false,
        setUserRenamed: () => undefined,
        getActiveSessionIds: () => new Set(["sess-@fleet", "sess-@chief"]),
        hasActiveTransport: () => true,
        getActiveSessionInfo: () =>
          ["@fleet", "@chief"].map((name) => ({
            id: `sess-${name}`,
            name,
            pid: process.pid,
            cwd: "/repo",
            role: "member",
            claudeSessionId: null,
            registeredAt: Date.now(),
            launchId: null,
            launchParentPid: null,
            transportPids: [process.pid],
            pushTransportPids: [],
          })),
      }
    }

    function call(ctx: TribeContext, args: Record<string, unknown>): Record<string, unknown> {
      const result = handleToolCall(ctx, "tribe.send", args, makeOpts())
      const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
      return JSON.parse(text) as Record<string, unknown>
    }

    const INCIDENT = { emitter: WATCHER, subject: "@dev/5", condition: "transport-wedged" }

    // 28044 AC3: existing upsert/clear tests have no stale snapshot or whole-recipient comparison.
    it("conflicts without mutation on stale raise/clear and requires every recipient before clearing", () => {
      const watcher = makeContext(db, stmts, WATCHER)
      const first = call(watcher, { to: "@chief", message: "first", incident: INCIDENT, if_current: [] })
      const expected = [{ recipient: "@chief", message_id: first.id }]
      const count = () => (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n
      const before = count()
      for (const active of [true, false]) {
        const stale = call(watcher, {
          to: "@chief",
          message: "stale",
          incident: { ...INCIDENT, active },
          if_current: [],
        })
        expect(stale).toMatchObject({
          sent: false,
          conflict: { kind: "incident-current-changed", expected: [], current: expected },
        })
        expect(count()).toBe(before)
      }
      const other = sendMessage(
        watcher,
        "@dev/7",
        "other holding",
        "notify",
        undefined,
        undefined,
        "direct",
        {},
        { incident: INCIDENT },
      )
      const beforeClear = count()
      const partial = call(watcher, {
        to: "@chief",
        message: "partial clear",
        incident: { ...INCIDENT, active: false },
        if_current: expected,
      })
      expect(partial).toMatchObject({ sent: false, conflict: { kind: "incident-current-changed" } })
      expect(count()).toBe(beforeClear)
      expect(openKeys("@chief")).toHaveLength(1)
      expect(openKeys("@dev/7")).toHaveLength(1)
      const cleared = call(watcher, {
        to: "@chief",
        message: "complete clear",
        incident: { ...INCIDENT, active: false },
        if_current: [{ recipient: "@dev/7", message_id: other.id }, ...expected],
      })
      expect(cleared).toMatchObject({ sent: true, tracker: { closed: 2 } })
      expect(openKeys("@chief")).toEqual([])
      expect(openKeys("@dev/7")).toEqual([])
    })

    it("accepts exact retries from hot or archived history without replacing a newer observation", () => {
      const watcher = makeContext(db, stmts, WATCHER)
      const original = {
        to: "@chief",
        message: "original",
        incident: INCIDENT,
        if_current: [],
        message_id: "28044-original",
      }
      const first = call(watcher, original)
      const newer = call(watcher, {
        to: "@chief",
        message: "newer",
        incident: INCIDENT,
        if_current: [{ recipient: "@chief", message_id: first.id }],
      })
      expect(newer.sent).toBe(true)
      expect(call(watcher, original)).toMatchObject({ sent: true, id: first.id, deduplicated: true })
      stmts.archiveExpiredMessages.run({ $cutoff: Date.now() + 1000, $archived_at: Date.now() })
      stmts.deleteExpiredMessages.run({ $cutoff: Date.now() + 1000 })
      expect(call(watcher, original)).toMatchObject({ sent: true, id: first.id, deduplicated: true })
      expect(
        db.prepare("SELECT message_id FROM pending_request WHERE request_id=?").get(incidentKey(INCIDENT)),
      ).toEqual({ message_id: newer.id })
      expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE id='28044-original'").get()).toEqual({ n: 0 })
    })

    it("requires conditional writes when managed policy is enabled and refuses malformed holdings", () => {
      const watcher = makeContext(db, stmts, WATCHER)
      const managed = handleToolCall(
        watcher,
        "tribe.send",
        { to: "@chief", message: "missing compare", incident: INCIDENT },
        {
          ...makeOpts(),
          requiredIncidentEmitters: [WATCHER],
          incidentAuthorization: { emitter: WATCHER, operation: "raise" },
        },
      ) as { content: Array<{ text: string }> }
      expect((JSON.parse(managed.content[0]!.text) as { error?: string }).error).toMatch(/if_current/)
      for (const value of [
        null,
        {},
        [{ recipient: "@chief" }],
        [
          { recipient: "@chief", message_id: "a" },
          { recipient: "@chief", message_id: "b" },
        ],
      ]) {
        expect(
          call(watcher, { to: "@chief", message: "invalid", incident: INCIDENT, if_current: value }).error,
        ).toMatch(/if_current/)
      }
      expect(openKeys("@chief")).toEqual([])
    })

    // 28044 AC1/3: prior snapshots only exercised null; wake tests never persisted opaque reconciliation data.
    it("keeps metadata-only reassertions quiet and carries payload through archive and reopen", () => {
      const watcher = makeContext(db, stmts, WATCHER)
      const read = () => {
        const result = handleToolCall(
          makeContext(db, stmts, WATCHER),
          "tribe.pending",
          { emitter: WATCHER },
          { ...makeOpts(), incidentAuthorization: { emitter: WATCHER, operation: "read" } },
        ) as { content: Array<{ text: string }> }
        return JSON.parse(result.content[0]!.text) as {
          pending: Array<{ incident_data: unknown; opened_at: string; message_id: string }>
        }
      }
      call(watcher, {
        to: "@chief",
        message: "body one",
        summary: "same condition",
        incident: INCIDENT,
        incident_data: { version: 1, revision: "first" },
      })
      const opened = read().pending[0]!.opened_at
      const data = {
        version: 1,
        revision: "second",
        members: ["a", "b"],
        episodeStart: null,
        nested: { preserve: true },
      }
      const repeated = call(watcher, {
        to: "@chief",
        message: "a different human body",
        summary: "same condition",
        incident: INCIDENT,
        incident_data: data,
      })
      expect(repeated.incident).toEqual({ transition: "repeated", wakesOwner: false })
      expect(read().pending[0]).toMatchObject({ incident_data: data, opened_at: opened })
      stmts.archiveExpiredMessages.run({ $cutoff: Date.now() + 1000, $archived_at: Date.now() })
      stmts.deleteExpiredMessages.run({ $cutoff: Date.now() + 1000 })
      db.close()
      db = openDatabase(join(tmpDir, "tribe.db"))
      stmts = createStatements(db)
      expect(read().pending[0]).toMatchObject({ incident_data: data, opened_at: opened })
      const id = read().pending[0]!.message_id
      expect(db.prepare("SELECT incident_data FROM messages_archive WHERE id=?").get(id)).toEqual({
        incident_data: JSON.stringify(data),
      })
      // An older protocol caller omits the optional field and still reads/writes against the migrated store.
      const older = call(makeContext(db, stmts, WATCHER), {
        to: "@chief",
        message: "older caller observation",
        summary: "same condition",
        incident: INCIDENT,
      })
      expect(older.sent).toBe(true)
      expect(read().pending[0]).toMatchObject({ incident_data: null, opened_at: opened })
    })

    it("refuses non-JSON metadata before mutation and corrupt stored metadata instead of empty success", () => {
      const watcher = makeContext(db, stmts, WATCHER)
      const bad = call(watcher, { to: "@chief", message: "bad", incident: INCIDENT, incident_data: { revision: NaN } })
      expect(String(bad.error)).toMatch(/incident_data.*JSON/)
      expect(openKeys("@chief")).toEqual([])
      observe(watcher, INCIDENT)
      db.run("UPDATE messages SET incident_data='not-json' WHERE is_incident=1")
      const result = handleToolCall(
        watcher,
        "tribe.pending",
        { emitter: WATCHER },
        { ...makeOpts(), incidentAuthorization: { emitter: WATCHER, operation: "read" } },
      ) as { content: Array<{ text: string }> }
      const body = JSON.parse(result.content[0]!.text) as { error?: string }
      expect(body.error).toMatch(/health-monitor.*tribe.db.*incident_data/)
      expect(body).not.toHaveProperty("pending")
    })

    /** @failure An authorized emitter sees a recipient mailbox or incomplete custody instead of its full snapshot.
     * @level l1
     * @consumer longproc/postmerge/WATCH restart reconciliation (28044 AC1).
     * Owner diagnostics and envelope-authority tests do not prove emitter scope or missing-message handling.
     */
    it("reads a complete emitter snapshot, with explicit empty and legacy metadata", () => {
      const reader = makeContext(db, stmts, WATCHER)
      const read = () => {
        const result = handleToolCall(
          reader,
          "tribe.pending",
          { emitter: WATCHER },
          {
            ...makeOpts(),
            incidentAuthorization: { emitter: WATCHER, operation: "read" },
          },
        ) as { content: Array<{ text: string }> }
        return JSON.parse(result.content[0]!.text) as Record<string, unknown>
      }
      expect(read()).toMatchObject({ scope: "emitter", emitter: WATCHER, count: 0, pending: [] })
      const original = makeContext(db, stmts, "historical-service-name")
      const first = observe(original, INCIDENT)
      const second = sendMessage(
        original,
        "@dev/7",
        "same condition, another recipient",
        "notify",
        undefined,
        undefined,
        "direct",
        {},
        { incident: INCIDENT },
      )
      observe(original, { emitter: "health-monitor-other", subject: "@dev/5", condition: "transport-wedged" })
      const snapshot = read() as { pending: Array<Record<string, unknown>> }
      expect(snapshot).toMatchObject({ scope: "emitter", emitter: WATCHER, count: 2 })
      expect(snapshot.pending).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            identity: INCIDENT,
            recipient: "@chief",
            sender: "historical-service-name",
            message_id: first.id,
            incident_data: null,
          }),
          expect.objectContaining({
            identity: INCIDENT,
            recipient: "@dev/7",
            sender: "historical-service-name",
            message_id: second.id,
            incident_data: null,
          }),
        ]),
      )
      expect(snapshot.pending.every((row) => typeof row.opened_at === "string")).toBe(true)
    })

    it("refuses an emitter snapshot whose pending observation is missing from both stores", () => {
      const watcher = makeContext(db, stmts, WATCHER)
      observe(watcher, INCIDENT)
      db.prepare("UPDATE pending_request SET message_id = 'missing-observation' WHERE request_id = ?").run(
        incidentKey(INCIDENT),
      )
      const result = handleToolCall(
        watcher,
        "tribe.pending",
        { emitter: WATCHER },
        {
          ...makeOpts(),
          incidentAuthorization: { emitter: WATCHER, operation: "read" },
        },
      ) as { content: Array<{ text: string }> }
      const body = JSON.parse(result.content[0]!.text) as { error?: string }
      expect(body.error).toContain(WATCHER)
      expect(body.error).toContain("missing-observation")
      expect(body.error).toContain("tribe.db")
      expect(body).not.toHaveProperty("pending")
    })

    it("repeated sends carrying the same identity hold ONE ball, and report its key", () => {
      const watcher = makeContext(db, stmts, "@fleet")

      const first = call(watcher, { to: "@chief", message: "wedged", incident: INCIDENT })
      call(watcher, { to: "@chief", message: "still wedged", incident: INCIDENT })
      call(watcher, { to: "@chief", message: "still wedged", incident: INCIDENT })

      expect(first.request_id).toBe(incidentKey(INCIDENT))
      expect(openKeys("@chief")).toEqual([incidentKey(INCIDENT)])
    })

    it("reports each incident transition from the same transaction that opens or updates its ball", () => {
      const watcher = makeContext(db, stmts, "@fleet")
      const opened = call(watcher, { to: "@chief", message: "red A", summary: "red A", incident: INCIDENT })
      const repeated = call(watcher, { to: "@chief", message: "red A again", summary: "red A", incident: INCIDENT })
      const changed = call(watcher, { to: "@chief", message: "red B", summary: "red B", incident: INCIDENT })
      const cleared = call(watcher, {
        to: "@chief",
        message: "green",
        summary: "green",
        incident: { ...INCIDENT, active: false },
      })
      expect(opened.incident).toEqual({ transition: "opened", wakesOwner: true })
      expect(repeated.incident).toEqual({ transition: "repeated", wakesOwner: false })
      expect(changed.incident).toEqual({ transition: "changed", wakesOwner: true })
      expect(cleared.incident).toEqual({ transition: "cleared", wakesOwner: false })
    })

    it("active:false over the wire closes the ball", () => {
      const watcher = makeContext(db, stmts, "@fleet")
      call(watcher, { to: "@chief", message: "wedged", incident: INCIDENT })
      expect(openKeys("@chief")).toHaveLength(1)

      call(watcher, { to: "@chief", message: "recovered", incident: { ...INCIDENT, active: false } })
      expect(openKeys("@chief")).toHaveLength(0)
      const facts = db
        .prepare("SELECT content FROM messages WHERE kind = 'event' AND type = 'event.ball.settled'")
        .all() as Array<{ content: string }>
      expect(facts.map((row) => JSON.parse(row.content))).toEqual([
        expect.objectContaining({
          request_id: incidentKey(INCIDENT),
          recipient: "@chief",
          sender: "@fleet",
          settlement: "incident-cleared",
          settled_by: "@fleet",
        }),
      ])
    })

    it("refuses a partial identity with the supported shape named", () => {
      const watcher = makeContext(db, stmts, "@fleet")
      const res = call(watcher, {
        to: "@chief",
        message: "wedged",
        incident: { emitter: WATCHER, subject: "@dev/5" },
      })
      expect(String(res.error)).toMatch(/incident\.condition/)
      expect(openKeys("@chief")).toHaveLength(0)
    })

    it("refuses incident together with request — one obligation cannot have two ids", () => {
      const watcher = makeContext(db, stmts, "@fleet")
      const res = call(watcher, { to: "@chief", message: "wedged", incident: INCIDENT, request: true })
      expect(String(res.error)).toMatch(/not both/i)
      expect(openKeys("@chief")).toHaveLength(0)
    })

    it("refuses a reply deadline on an incident instead of silently discarding it", () => {
      const watcher = makeContext(db, stmts, "@fleet")
      const res = call(watcher, {
        to: "@chief",
        message: "wedged",
        incident: INCIDENT,
        expires_in_ms: 60_000,
      })
      expect(String(res.error)).toMatch(/incident.*deadline|expires_in_ms.*incident/i)
      expect(openKeys("@chief")).toHaveLength(0)
    })

    it("refuses a broadcast incident — a broadcast owns no ball", () => {
      const watcher = makeContext(db, stmts, "@fleet")
      const res = call(watcher, { to: "*", message: "wedged", incident: INCIDENT })
      expect(String(res.error)).toMatch(/exactly one recipient/i)
    })

    // @hh/pm/@i/5-no-wedged-agents/22964: openIncidentRequest's ON CONFLICT clause used to
    // update only request_kind/expires_at, leaving message_id — and therefore every
    // reader's displayed content — frozen at whichever tick first opened the ball.
    // opened_at staying frozen is correct (rung-5 escalation's demand instant); content
    // staying frozen is not — a re-evaluating watcher ticking correctly for days still
    // showed a reader the FIRST tick's counts/ages/refs forever.
    it("reassertion refreshes the displayed content to the latest tick, not the first", () => {
      const watcher = makeContext(db, stmts, "@fleet")
      call(watcher, { to: "@chief", message: "1 waiting, oldest 2m", incident: INCIDENT })
      call(watcher, { to: "@chief", message: "1 waiting, oldest 55m", incident: INCIDENT })

      const result = handleToolCall(makeContext(db, stmts, "@chief"), "tribe.pending", { owner: "@chief" }, makeOpts())
      const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
      const parsed = JSON.parse(text) as { pending: Array<{ request_id: string; content: string | null }> }
      const row = parsed.pending.find((p) => p.request_id === incidentKey(INCIDENT))

      expect(row?.content).toBe("1 waiting, oldest 55m")
      expect(row?.content).not.toBe("1 waiting, oldest 2m")
    })
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
