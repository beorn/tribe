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
    expectedMembers: roster(members),
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
      db
        .prepare("SELECT id, type, content, ts FROM messages WHERE type = 'event.ball.settled' LIMIT 1")
        .get() as { id: string; type: "event.ball.settled"; content: string; ts: number },
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
      handleToolCall(ctx, "tribe.pending", { all: true }, {
        cleanup: () => undefined,
        userRenamed: false,
        setUserRenamed: () => undefined,
        getActiveSessionIds: () => new Set<string>(),
        hasActiveTransport: () => false,
        getActiveSessionInfo: () => [],
      }),
    )
    expect(listed.count).toBe(1)
  })

  it("refuses an explicit tracked send between two unrun seats; auto-track request is untracked", () => {
    const ci = makeContext(db, stmts, "@ci")
    const explicit = parseToolJson(
      handleToolCall(ci, "tribe.send", { to: "@dev/3", message: "work", type: "request", request: true }, optsWithRoster(UNRUN)),
    )
    expect(String(explicit.error ?? "")).toContain("expected:false")
    const auto = parseToolJson(
      handleToolCall(ci, "tribe.send", { to: "@dev/3", message: "work", type: "request" }, optsWithRoster(UNRUN)),
    )
    expect(auto.error).toBeUndefined()
    const remaining = stmts.selectPendingForRecipient.all({ $recipient: "@dev/3" }) as unknown[]
    expect(remaining).toHaveLength(0)
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
})
