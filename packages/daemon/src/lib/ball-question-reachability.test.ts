/**
 * A ball can outlive its question (22844) — pre-fix this file ships RED.
 *
 * Two defects, one family. The tracker holds an obligation open indefinitely
 * while the message carrying the question ages out of every WINDOWED read —
 * the body survives in the messages table (fetch-by-id works), but the
 * ordinary drain reports an obligation it cannot help discharge. Five of
 * @chief's ten oldest owed requests were structurally unanswerable this way.
 *
 * And closing a ball is coupled to delivering its answer: when the close
 * cannot be applied, the content half must never be the part that fails.
 * The daemon already delivers and reports closed=0; these tests pin that so
 * the CLI's refuse-before-send shape can never migrate down here.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"
import { sendMessage } from "./messaging.ts"

type ToolJson = Record<string, unknown>
type PendingRow = { request_id: string; message_id: string; content?: string | null; summary?: string | null }

function makeOpts(): HandlerOpts {
  return {
    cleanup: () => undefined,
    userRenamed: false,
    setUserRenamed: () => undefined,
    getActiveSessionIds: () => new Set(["sess-chief"]),
    hasActiveTransport: (sessionId) => sessionId === "sess-chief",
    getActiveSessionInfo: () => [],
  }
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): ToolJson {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as ToolJson
}

describe("a ball never outlives its question (22844)", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ball-question-"))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function setup() {
    const db = openDatabase(join(tmpDir, "tribe.db"))
    const stmts = createStatements(db)
    return { db, stmts }
  }

  function makeContext(db: ReturnType<typeof openDatabase>, stmts: TribeStatements, initialName: string) {
    return createTribeContext({
      db,
      stmts,
      sessionId: `sess-${initialName.slice(1).replaceAll("/", "-")}`,
      sessionRole: "member",
      initialName,
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
  }

  it("tribe.pending carries the full question body for every owed ball", () => {
    const { db, stmts } = setup()
    const sender = makeContext(db, stmts, "@fable/1")
    const body =
      "Which of the two semantics should the initiative representation encode? " +
      "I will not proceed without the answer — the summary line names only the topic."
    sendMessage(
      sender,
      "@chief",
      body,
      "request",
      undefined,
      undefined,
      "direct",
      { summary: "semantics ruling" },
      {
        request: "sem-req-1",
      },
    )

    const chief = makeContext(db, stmts, "@chief")
    const res = parseToolJson(handleToolCall(chief, "tribe.pending", { owner: "@chief" }, makeOpts()))
    const pending = (res.pending ?? []) as PendingRow[]
    expect(pending).toHaveLength(1)
    // The obligation and the question arrive TOGETHER through the ordinary
    // drain — no window read, no second fetch-by-id step.
    expect(pending[0]!.content).toBe(body)
  })

  it("active pending snapshots join a large population without per-ball body queries", () => {
    const { db, stmts } = setup()
    const sender = makeContext(db, stmts, "@fable/1")
    const population = 256
    const bodySuffix = "x".repeat(2_000)
    for (let index = 0; index < population; index += 1) {
      sendMessage(
        sender,
        index % 2 === 0 ? "@chief" : "@cto",
        `question-${index}-${bodySuffix}`,
        "request",
        undefined,
        undefined,
        "direct",
        { summary: `question ${index}` },
        { request: `large-population-${index}` },
      )
    }

    let perBallBodyQueries = 0
    const bodyStatement = stmts.selectMessageContentById
    const instrumentedStmts = {
      ...stmts,
      selectMessageContentById: new Proxy(bodyStatement, {
        get(target, property) {
          if (property !== "get") return Reflect.get(target, property, target)
          return (...args: Parameters<typeof target.get>) => {
            perBallBodyQueries += 1
            return target.get(...args)
          }
        },
      }),
    } as TribeStatements
    const chief = makeContext(db, instrumentedStmts, "@chief")

    const all = parseToolJson(handleToolCall(chief, "tribe.pending", { all: true }, makeOpts()))
    const allPending = (all.pending ?? []) as PendingRow[]
    expect(allPending).toHaveLength(population)
    expect(allPending[255]!.content).toContain("question-")

    const owned = parseToolJson(handleToolCall(chief, "tribe.pending", { owner: "@chief" }, makeOpts()))
    const ownedPending = (owned.pending ?? []) as PendingRow[]
    expect(ownedPending).toHaveLength(population / 2)
    expect(ownedPending[127]!.content).toContain("question-")
    expect(perBallBodyQueries).toBe(0)
  })

  it("an owed ball whose message row is gone stays listed, flagged by content: null", () => {
    const { db, stmts } = setup()
    const now = Date.now()
    stmts.openPendingRequest.run({
      $request_id: "orphaned-req",
      $recipient: "@chief",
      $sender: "@ghost",
      $opened_at: now - 1000,
      $expires_at: null,
      $message_id: "message-that-no-longer-exists",
      $fanout: "first",
    })

    const chief = makeContext(db, stmts, "@chief")
    const res = parseToolJson(handleToolCall(chief, "tribe.pending", { owner: "@chief" }, makeOpts()))
    const pending = (res.pending ?? []) as PendingRow[]
    expect(pending).toHaveLength(1)
    // Never listed indistinguishably from a readable one: content is
    // explicitly null, not absent.
    expect(pending[0]).toHaveProperty("content", null)
  })

  it("the fleet-wide and expired views carry bodies too", () => {
    const { db, stmts } = setup()
    const sender = makeContext(db, stmts, "@fable/1")
    const body = "Standing question with a short deadline."
    sendMessage(
      sender,
      "@chief",
      body,
      "request",
      undefined,
      undefined,
      "direct",
      { summary: "short-ttl" },
      {
        request: "ttl-req-1",
        expiresInMs: 1,
      },
    )

    const chief = makeContext(db, stmts, "@chief")
    const all = parseToolJson(handleToolCall(chief, "tribe.pending", { all: true }, makeOpts()))
    const allRows = (all.pending ?? []) as PendingRow[]
    expect(allRows.length).toBeGreaterThanOrEqual(1)
    expect(allRows.find((r) => r.request_id === "ttl-req-1")?.content).toBe(body)

    // After the deadline passes the ball leaves the default view; the
    // expired diagnostic view must still deliver the question.
    const expired = parseToolJson(
      handleToolCall(chief, "tribe.pending", { owner: "@chief", expired: true }, makeOpts()),
    )
    const expiredRows = (expired.pending ?? []) as PendingRow[]
    const row = expiredRows.find((r) => r.request_id === "ttl-req-1")
    if (row !== undefined) expect(row.content).toBe(body)
  })

  it("a reply that cannot close still delivers, reporting closed: 0", () => {
    const { db, stmts } = setup()
    const responder = makeContext(db, stmts, "@dev/9")
    const answer = "The answer you waited hours for."
    const result = sendMessage(
      responder,
      "@fable/1",
      answer,
      "response",
      undefined,
      undefined,
      "direct",
      { summary: "late answer" },
      { reply: "request-nobody-owns" },
    )

    // Delivered: the message row exists and is addressed.
    const row = db.prepare("SELECT sender, recipient, content FROM messages WHERE id = ?").get(result.id) as {
      sender: string
      recipient: string
      content: string
    } | null
    expect(row).not.toBeNull()
    expect(row!.recipient).toBe("@fable/1")
    expect(row!.content).toBe(answer)
    // The bookkeeping half reports its own failure distinctly.
    expect(result.tracker).toEqual({ request_id: "request-nobody-owns", closed: 0 })
  })
})
