/**
 * 24588 row 4 — a ball whose sender AND recipient are both declared
 * expected:false must not accrue. The tracker already has the roster;
 * the ball lifecycle now asks it. Names absent from the roster (hab-page)
 * are not unrun seats. No roster means the pre-declaration projection.
 */
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"
import { parseExpectedMembers } from "./membership-declared-roster.ts"
import { parseBallOutcomeFact, type BallSettlementFact } from "tribe-wire"

const PROJECT_ID = "pending-declared-unrun"

function makeContext(db: Database, stmts: TribeStatements, name: string): TribeContext {
  return createTribeContext({
    db,
    stmts,
    sessionId: `sess-${name.replaceAll("/", "-")}`,
    sessionRole: "member",
    initialName: name,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Record<string, unknown>
}

function roster(members: Array<{ name: string; expected: boolean }>) {
  return parseExpectedMembers(JSON.stringify(members))!
}

function optsWithRoster(members: Array<{ name: string; expected: boolean }>): HandlerOpts {
  return {
    cleanup: () => undefined,
    userRenamed: false,
    setUserRenamed: () => undefined,
    getActiveSessionIds: () => new Set<string>(),
    hasActiveTransport: () => false,
    getActiveSessionInfo: () => [],
    getExpectedMembers: () => roster(members),
  }
}

function optsWithLiveSeats(members: Array<{ name: string; expected: boolean }>, liveNames: string[]): HandlerOpts {
  const activeIds = new Set(liveNames.map((n) => `sess-${n.replaceAll("/", "-")}`))
  return {
    cleanup: () => undefined,
    userRenamed: false,
    setUserRenamed: () => undefined,
    getActiveSessionIds: () => activeIds,
    hasActiveTransport: (id) => activeIds.has(id),
    getActiveSessionInfo: () =>
      liveNames.map((name) => ({
        id: `sess-${name.replaceAll("/", "-")}`,
        name,
        pid: process.pid,
        cwd: "/repo",
        role: "member",
        claudeSessionId: null,
        registeredAt: Date.now(),
        launchId: `launch-${name}`,
        launchParentPid: process.pid,
        transportPids: [process.pid],
      })),
    getExpectedMembers: () => roster(members),
  }
}

const UNRUN = [
  { name: "@ci", expected: false },
  { name: "@dev/3", expected: false },
  { name: "@dev/12", expected: true },
]

describe("24588 row 4: dual expected:false balls do not accrue", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), `${PROJECT_ID}-`))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("pending --all settles an existing @ci → @dev/3 ball as gc-expired by declared-roster", () => {
    stmts.openPendingRequest.run({
      $request_id: "51e4b4ea",
      $recipient: "@dev/3",
      $sender: "@ci",
      $opened_at: 1_000,
      $expires_at: 2_000,
      $message_id: "51e4b4ea-msg",
      $fanout: "all",
    })
    const ctx = makeContext(db, stmts, "@dev/12")
    const listed = parseToolJson(handleToolCall(ctx, "tribe.pending", { all: true }, optsWithRoster(UNRUN)))
    expect(listed.count).toBe(0)
    const remaining = stmts.selectPendingForRecipient.all({ $recipient: "@dev/3" }) as unknown[]
    expect(remaining).toHaveLength(0)
    const fact = parseBallOutcomeFact(
      db.prepare("SELECT id, type, content, ts FROM messages WHERE type = 'event.ball.settled' LIMIT 1").get() as {
        id: string
        type: "event.ball.settled"
        content: string
        ts: number
      },
    ) as BallSettlementFact
    expect(fact.settlement).toBe("gc-expired")
    expect(fact.settled_by).toBe("declared-roster")
    expect(fact.recipient).toBe("@dev/3")
    expect(fact.sender).toBe("@ci")
  })

  it("does not settle hab-page → @dev/3: hab-page is not a declared unrun seat", () => {
    stmts.openPendingRequest.run({
      $request_id: "4bb4789c",
      $recipient: "@dev/3",
      $sender: "hab-page",
      $opened_at: 1_000,
      $expires_at: 2_000,
      $message_id: "4bb4789c-msg",
      $fanout: "first",
    })
    const ctx = makeContext(db, stmts, "@dev/12")
    const listed = parseToolJson(handleToolCall(ctx, "tribe.pending", { all: true }, optsWithRoster(UNRUN)))
    expect(listed.count).toBe(1)
    const remaining = stmts.selectPendingForRecipient.all({ $recipient: "@dev/3" }) as unknown[]
    expect(remaining).toHaveLength(1)
  })

  it("does not settle when the roster is absent", () => {
    stmts.openPendingRequest.run({
      $request_id: "51e4b4ea",
      $recipient: "@dev/3",
      $sender: "@ci",
      $opened_at: 1_000,
      $expires_at: 2_000,
      $message_id: "51e4b4ea-msg",
      $fanout: "all",
    })
    const ctx = makeContext(db, stmts, "@dev/12")
    const listed = parseToolJson(
      handleToolCall(
        ctx,
        "tribe.pending",
        { all: true },
        {
          cleanup: () => undefined,
          userRenamed: false,
          setUserRenamed: () => undefined,
          getActiveSessionIds: () => new Set<string>(),
          hasActiveTransport: () => false,
          getActiveSessionInfo: () => [],
        },
      ),
    )
    expect(listed.count).toBe(1)
  })

  it("NEGATIVE: live expected:true sender to unrun recipient still opens a ball", () => {
    const live = makeContext(db, stmts, "@dev/12")
    const sent = parseToolJson(
      handleToolCall(
        live,
        "tribe.send",
        { to: "@dev/3", message: "work", type: "request" },
        {
          ...optsWithRoster(UNRUN),
          getActiveSessionIds: () => new Set(["sess-dev3"]),
          hasActiveTransport: (id) => id === "sess-dev3",
          getActiveSessionInfo: () => [
            {
              id: "sess-dev3",
              name: "@dev/3",
              pid: process.pid,
              cwd: "/repo",
              role: "member",
              claudeSessionId: null,
              registeredAt: Date.now(),
              launchId: null,
              launchParentPid: null,
              transportPids: [process.pid],
            },
          ],
        },
      ),
    )
    expect(sent.error).toBeUndefined()
    const remaining = stmts.selectPendingForRecipient.all({ $recipient: "@dev/3" }) as unknown[]
    expect(remaining).toHaveLength(1)
  })

  it("T1 pin: live on-demand pair opens request ball and survives tribe.pending read (live specimen)", () => {
    const onDemandRoster = [
      { name: "@adhoc/5", expected: false },
      { name: "@dev/review-adhoc5", expected: false },
    ]
    const liveOpts = optsWithLiveSeats(onDemandRoster, ["@adhoc/5", "@dev/review-adhoc5"])
    const senderCtx = makeContext(db, stmts, "@adhoc/5")
    const sent = parseToolJson(
      handleToolCall(
        senderCtx,
        "tribe.send",
        { to: "@dev/review-adhoc5", message: "review request", type: "request", request: true },
        liveOpts,
      ),
    )
    expect(sent.error).toBeUndefined()
    expect(sent.sent).toBe(true)

    // Ball exists in DB
    const pendingBefore = stmts.selectPendingForRecipient.all({
      $recipient: "@dev/review-adhoc5",
    }) as Array<{ request_id: string }>
    expect(pendingBefore).toHaveLength(1)

    // Reading tribe.pending must NOT settle this ball because both ends have live launches
    const pendingRead = parseToolJson(
      handleToolCall(makeContext(db, stmts, "@dev/review-adhoc5"), "tribe.pending", { all: true }, liveOpts),
    )
    expect(pendingRead.count).toBe(1)

    // Ball survives intact
    const pendingAfter = stmts.selectPendingForRecipient.all({ $recipient: "@dev/review-adhoc5" }) as unknown[]
    expect(pendingAfter).toHaveLength(1)
  })

  it("T2 pin: stopped on-demand pair with ball past deadline is settled by declared-roster", () => {
    stmts.openPendingRequest.run({
      $request_id: "t2-req-past-deadline",
      $recipient: "@dev/3",
      $sender: "@ci",
      $opened_at: 1_000,
      $expires_at: 2_000,
      $message_id: "t2-msg",
      $fanout: "all",
    })
    const ctx = makeContext(db, stmts, "@dev/12")
    const listed = parseToolJson(handleToolCall(ctx, "tribe.pending", { all: true }, optsWithRoster(UNRUN)))
    expect(listed.count).toBe(0)
    const remaining = stmts.selectPendingForRecipient.all({ $recipient: "@dev/3" }) as unknown[]
    expect(remaining).toHaveLength(0)
    const fact = parseBallOutcomeFact(
      db.prepare("SELECT id, type, content, ts FROM messages WHERE type = 'event.ball.settled' LIMIT 1").get() as {
        id: string
        type: "event.ball.settled"
        content: string
        ts: number
      },
    ) as BallSettlementFact
    expect(fact.settlement).toBe("gc-expired")
    expect(fact.settled_by).toBe("declared-roster")
    expect(fact.recipient).toBe("@dev/3")
    expect(fact.sender).toBe("@ci")
  })

  it("T3 pin: stopped on-demand pair with ball NOT past deadline is untouched (restart-gap case)", () => {
    const now = Date.now()
    stmts.openPendingRequest.run({
      $request_id: "t3-req-unexpired",
      $recipient: "@dev/3",
      $sender: "@ci",
      $opened_at: now,
      $expires_at: now + 600_000,
      $message_id: "t3-msg",
      $fanout: "first",
    })
    const ctx = makeContext(db, stmts, "@dev/12")
    const listed = parseToolJson(handleToolCall(ctx, "tribe.pending", { all: true }, optsWithRoster(UNRUN)))
    expect(listed.count).toBe(1)
    const remaining = stmts.selectPendingForRecipient.all({ $recipient: "@dev/3" }) as unknown[]
    expect(remaining).toHaveLength(1)
    const settledFact = db.prepare("SELECT id FROM messages WHERE type = 'event.ball.settled'").get()
    expect(settledFact).toBeNull()
  })

  it("T4 pin: one end live with ball past deadline is untouched by sweep", () => {
    // 4a: sender @ci is live, recipient @dev/3 is unrun
    stmts.openPendingRequest.run({
      $request_id: "t4a-sender-live",
      $recipient: "@dev/3",
      $sender: "@ci",
      $opened_at: 1_000,
      $expires_at: 2_000,
      $message_id: "t4a-msg",
      $fanout: "first",
    })
    const senderLiveOpts = optsWithLiveSeats(UNRUN, ["@ci"])
    const listedSenderLive = parseToolJson(
      handleToolCall(makeContext(db, stmts, "@dev/12"), "tribe.pending", { all: true }, senderLiveOpts),
    )
    expect(listedSenderLive.count).toBe(1)
    expect(stmts.selectPendingForRecipient.all({ $recipient: "@dev/3" })).toHaveLength(1)

    // 4b: recipient @dev/3 is live, sender @ci is unrun
    stmts.openPendingRequest.run({
      $request_id: "t4b-recipient-live",
      $recipient: "@dev/3",
      $sender: "@ci",
      $opened_at: 1_000,
      $expires_at: 2_000,
      $message_id: "t4b-msg",
      $fanout: "first",
    })
    const recipientLiveOpts = optsWithLiveSeats(UNRUN, ["@dev/3"])
    const listedRecipientLive = parseToolJson(
      handleToolCall(makeContext(db, stmts, "@dev/12"), "tribe.pending", { all: true }, recipientLiveOpts),
    )
    expect(listedRecipientLive.count).toBe(2)
    expect(stmts.selectPendingForRecipient.all({ $recipient: "@dev/3" })).toHaveLength(2)
  })

  it("F1 pin: fails loudly when required membership observation getter throws in tribe.pending (no silent errors)", () => {
    stmts.openPendingRequest.run({
      $request_id: "throwing-getter-req",
      $recipient: "@dev/3",
      $sender: "@ci",
      $opened_at: 1_000,
      $expires_at: 2_000,
      $message_id: "throwing-msg",
      $fanout: "all",
    })
    const brokenOpts: HandlerOpts = {
      ...optsWithRoster(UNRUN),
      getActiveSessionInfo: () => {
        throw new Error("simulated membership getter failure")
      },
    }
    const ctx = makeContext(db, stmts, "@dev/12")
    expect(() => {
      handleToolCall(ctx, "tribe.pending", { all: true }, brokenOpts)
    }).toThrow("simulated membership getter failure")

    // Proves tribe.pending settles nothing on throw
    const remaining = stmts.selectPendingForRecipient.all({ $recipient: "@dev/3" }) as unknown[]
    expect(remaining).toHaveLength(1)
  })

  it("Condition 2 pin (suggestion): ball with explicit expires_at 10m ahead opened 30m ago survives sweep", () => {
    const now = Date.now()
    stmts.openPendingRequest.run({
      $request_id: "long-deadline-gap-req",
      $recipient: "@dev/3",
      $sender: "@ci",
      $opened_at: now - 30 * 60 * 1000,
      $expires_at: now + 10 * 60 * 1000,
      $message_id: "long-deadline-msg",
      $fanout: "first",
    })
    const ctx = makeContext(db, stmts, "@dev/12")
    const listed = parseToolJson(handleToolCall(ctx, "tribe.pending", { all: true }, optsWithRoster(UNRUN)))
    expect(listed.count).toBe(1)
    const remaining = stmts.selectPendingForRecipient.all({ $recipient: "@dev/3" }) as unknown[]
    expect(remaining).toHaveLength(1)
    const settledFact = db.prepare("SELECT id FROM messages WHERE type = 'event.ball.settled'").get()
    expect(settledFact).toBeNull()
  })
})
