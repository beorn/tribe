/**
 * 24994 — Tests pinning the canonical error shape for tribe.send:
 *   tribe.send: <what failed> - <short plain reason>
 *
 * The long form, with capability names and bead numbers, moves to the log
 * and to `detail`, never to the one line.
 */
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTribeContext, type TribeContext } from "./context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { planAlertSends } from "../../../wire/src/lib/incident-reconciler.ts"
import { handleToolCall, type ActiveSessionInfo, type HandlerOpts } from "./handlers.ts"
import { parseExpectedMembers, type DeclaredRoster } from "./membership-declared-roster.ts"
import { registerSession } from "./session.ts"

const PROJECT_ID = "send-error-shapes"
const VALID_HASH = "cd".repeat(32)

function makeContext(
  db: Database,
  stmts: TribeStatements,
  sessionId: string,
  name: string,
  claudeSessionId: string | null = null,
): TribeContext {
  return createTribeContext({
    db,
    stmts,
    sessionId,
    sessionRole: "member",
    initialName: name,
    domains: [],
    claudeSessionId,
    claudeSessionName: claudeSessionId ? name : null,
  })
}

function addSession(
  db: Database,
  stmts: TribeStatements,
  sessionId: string,
  name: string,
  updatedAt: number = Date.now(),
): void {
  const ctx = makeContext(db, stmts, sessionId, name)
  registerSession(ctx, PROJECT_ID, () => false, null, process.pid, "pull", "/repo", null, "codex", null, null)
  db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [updatedAt, sessionId])
}

function parseToolJson(result: ReturnType<typeof handleToolCall>): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Record<string, unknown>
}

function liveInfo(id: string, name: string): ActiveSessionInfo {
  return {
    id,
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
  }
}

function makeOpts(info: ActiveSessionInfo[] = [], expectedMembers?: () => DeclaredRoster | undefined): HandlerOpts {
  const ids = new Set(info.map((row) => row.id))
  return {
    cleanup: () => undefined,
    userRenamed: false,
    setUserRenamed: () => undefined,
    getActiveSessionIds: () => ids,
    hasActiveTransport: (id) => ids.has(id),
    isReconnectGraceProtected: () => false,
    getActiveSessionInfo: () => info,
    getExpectedMembers: expectedMembers,
  }
}

describe("24994: canonical one-line error shape for tribe.send", () => {
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

  it("refuses an absent message by name instead of throwing", () => {
    const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
    const sent = parseToolJson(
      handleToolCall(sender, "tribe.send", { to: "@dev/2" }, makeOpts([liveInfo("sess-dev2", "@dev/2")])),
    )

    expect(sent.error).toBe("tribe.send: invalid message - must be a string")
  })

  it("pins self-mailbox-authority-missing refusal to one line with last seen time and preserves detail", () => {
    const fiveMinsAgo = Date.now() - 5 * 60_000
    addSession(db, stmts, "sess-adhoc", "@adhoc/1", fiveMinsAgo)
    const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
    const sent = parseToolJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: "@adhoc/1", message: "ping", type: "request" },
        makeOpts([liveInfo("sess-adhoc", "@adhoc/1")]),
      ),
    )

    // 24576 AC2: @adhoc/1 is connected, so the cause is its unreadable mailbox, not "not online".
    expect(sent.error).toBe(
      "tribe.send: failed to deliver to @adhoc/1 - mailbox unreadable (connected, no identity token; last seen 5 mins ago)",
    )
    expect(String(sent.detail)).toContain(
      "mailbox_read_capability.state is unavailable (self-mailbox-authority-missing)",
    )
    expect(String(sent.detail)).toContain('before retrying an answer-required request give "@adhoc/1" one')
  })

  it("24576 AC4: a claimed, tokenless, connection-registered session is refused a tracked request with the fix named", () => {
    // The unimac shape (30458): Hab did not launch it, so it registered by connection alone. Its row holds no launch
    // id and no mailbox authority, so its authority is claimed. The outcome is refusal, @cto ruling 2304 option 1: a
    // remote seat answers only once it is a declared, minted participant, so the refusal names that route.
    addSession(db, stmts, "sess-unimac", "unimac/hhcorp")
    const row = db
      .prepare("SELECT launch_id, mailbox_authority_hash FROM sessions WHERE id = ?")
      .get("sess-unimac") as {
      launch_id: string | null
      mailbox_authority_hash: string | null
    }
    expect(row).toEqual({ launch_id: null, mailbox_authority_hash: null })
    const sender = makeContext(db, stmts, "sess-chief", "@chief")
    const sent = parseToolJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: "unimac/hhcorp", message: "update km", type: "request" },
        makeOpts([liveInfo("sess-unimac", "unimac/hhcorp")]),
      ),
    )

    expect(String(sent.error)).toMatch(
      /^tribe\.send: failed to deliver to unimac\/hhcorp - mailbox unreadable \(connected, no identity token; /,
    )
    expect(String(sent.error)).not.toContain("not online")
    const detail = String(sent.detail)
    expect(detail).toContain("self-mailbox-authority-missing")
    expect(detail).toContain("declare it under `participants` in the habitat file")
    expect(detail).toContain("run `hab participant mint @ext/<slug>`")
    expect(detail).not.toContain("cannot hold one yet")
    expect(stmts.selectPendingForRecipient.all({ $recipient: "unimac/hhcorp" })).toHaveLength(0)
  })

  it("pins no-live-transport refusal to one line and preserves detail", () => {
    const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
    const sent = parseToolJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: "@dev/2", message: "ping", type: "request" },
        makeOpts([]), // no session and no live transport
      ),
    )

    expect(sent.error).toBe("tribe.send: failed to deliver to @dev/2 - not online (no connected transport)")
    expect(String(sent.detail)).toContain("no connected, PID-live transport was observed")
  })

  it("pins no-broadcast-owner refusal to one line when no broadcast owners are live", () => {
    const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
    const sent = parseToolJson(
      handleToolCall(sender, "tribe.send", { to: "*", message: "anyone there?", request: true }, makeOpts([])),
    )

    expect(sent.error).toBe("tribe.send: failed to deliver to * - no online recipients")
    expect(String(sent.detail)).toContain("no answer-capable broadcast owner was observed")
  })

  // F23 (@cto 4da05ac8 + GO amendment, 2026-11-26): a request, assign, query or verdict that says only "ok" ships an
  // empty ball — the recipient sees a long summary in the wake and nothing to act on in the body. The four
  // answer-owing types must carry their ask in the body; status and notify do not owe an answer and keep the short body.
  describe("an answer-owing body must carry the ask, not lean on a longer summary", () => {
    const summary =
      "Trial-steward alarm: @dev/8 has a wake queued for more than 8 minutes behind a turn that never closed"

    it("refuses a request whose body is only ok", () => {
      const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
      const sent = parseToolJson(
        handleToolCall(
          sender,
          "tribe.send",
          { to: "@chief", message: "ok", type: "request", summary },
          makeOpts([liveInfo("sess-chief", "@chief")]),
        ),
      )

      expect(sent.error).toBe(
        "tribe.send: message too short for a request - the body is what the recipient acts on, so put the ask there " +
          "(40 characters or more), not only in the summary",
      )
    })

    it("refuses an assign, a query, and a verdict the same way", () => {
      const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
      const opts = makeOpts([liveInfo("sess-chief", "@chief")])
      for (const type of ["assign", "query", "verdict"]) {
        const sent = parseToolJson(
          handleToolCall(sender, "tribe.send", { to: "@chief", message: "ok", type, summary }, opts),
        )
        expect(String(sent.error)).toContain(`message too short for a ${type}`)
      }
      expect((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind <> 'event'").get() as { n: number }).n).toBe(0)
    })

    it("delivers a request whose body carries the ask", () => {
      const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
      const sent = parseToolJson(
        handleToolCall(
          sender,
          "tribe.send",
          {
            to: "@chief",
            message:
              "Please clear the phantom turn on @dev/8 so its queued wake can deliver, then tell me when it is done.",
            type: "request",
            summary,
          },
          makeOpts([liveInfo("sess-chief", "@chief")]),
        ),
      )

      expect(sent.error).toBeUndefined()
      expect(sent).toMatchObject({ sent: true })
    })

    it("leaves status and notify free to be short", () => {
      const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
      const opts = makeOpts([liveInfo("sess-chief", "@chief")])
      for (const type of ["status", "notify"]) {
        const sent = parseToolJson(
          handleToolCall(sender, "tribe.send", { to: "@chief", message: "ok", type, summary }, opts),
        )
        expect(sent.error).toBeUndefined()
        expect(sent).toMatchObject({ sent: true })
      }
    })
  })

  // dark-work exit 6 (2026-11-26 16:38Z, @chief dde669d2): the shared reconciler cleared or moved an incident with a
  // 22-character body under an authored summary, so the minimum above refused every clear; the ball stayed open and the
  // gather failed loud on each run. Drives the reconciler's own planned edges through tribe.send, not a copied string.
  describe("the standing-incident reconciler's clearing and moving edges carry the ask in the body", () => {
    const key = "dark-work:Owner4h:@dev/3"
    const opened = {
      key,
      class: "Owner4h",
      subject: "Owner4h",
      condition: "@dev/3",
      revision: "r1",
      summary: "Quiet work items",
      body: "2 items; oldest 5 h. Commit, write a Continue-from, or record a valid wait on each one.",
    }
    const ledger = { reassertedAt: null, open: { [key]: { class: "Owner4h", to: "@dev/3", revision: "r1" } } }

    it.each([
      ["a cleared finding", [] as (typeof opened & { to: string })[]],
      ["a finding moved to another owner", [{ ...opened, to: "@dev/luna3", revision: "r2" }]],
    ])("%s closes the ball it names", (_label, alerts) => {
      const watcher = makeContext(db, stmts, "sess-dark-work", "dark-work")
      const opts = makeOpts([liveInfo("sess-dev3", "@dev/3"), liveInfo("sess-luna3", "@dev/luna3")])
      const identity = { emitter: "dark-work", subject: "Owner4h", condition: "@dev/3" }
      const open = parseToolJson(
        handleToolCall(
          watcher,
          "tribe.send",
          { to: "@dev/3", message: opened.body, type: "request", summary: opened.summary, incident: identity },
          opts,
        ),
      )
      expect(open).toMatchObject({ sent: true })

      const clear = planAlertSends("dark-work", alerts, ledger, new Set()).find((send) => send.cleared)
      if (clear === undefined) throw new Error("the reconciler planned no clearing edge")
      const sent = parseToolJson(
        handleToolCall(
          watcher,
          "tribe.send",
          {
            to: clear.to,
            message: clear.body,
            type: "request",
            summary: clear.summary,
            incident: { ...identity, active: false },
          },
          opts,
        ),
      )
      expect(sent.error).toBeUndefined()
      expect(sent).toMatchObject({ sent: true, tracker: { closed: 1 } })
    })
  })

  it("pins summary-required refusal to one line for LLM senders omitting summary", () => {
    const sender = makeContext(db, stmts, "sess-llm", "@dev/7", "claude-uuid-1234")
    const sent = parseToolJson(
      handleToolCall(
        sender,
        "tribe.send",
        { to: "@chief", message: "hello without summary", type: "notify" },
        makeOpts([]),
      ),
    )

    expect(sent.error).toBe("tribe.send: summary required - author a one-line summary before sending")
  })

  describe("argument validation refusals", () => {
    it("pins invalid to", () => {
      const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
      const sent = parseToolJson(handleToolCall(sender, "tribe.send", { to: "", message: "hi" }, makeOpts()))
      expect(sent.error).toBe("tribe.send: invalid to - must be a non-empty string or array of non-empty strings")
    })

    it("pins invalid delivery", () => {
      const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
      const sent = parseToolJson(
        handleToolCall(sender, "tribe.send", { to: "@chief", message: "hi", delivery: "express" }, makeOpts()),
      )
      expect(sent.error).toBe("tribe.send: invalid delivery - must be 'push' or 'pull'")
    })

    it('refuses an unknown type (a quoted `"request"` from an MCP tool call) and stores nothing', () => {
      // 28200: the daemon accepted any type string, so an agent's tool call
      // carrying a quoted `"request"` was STORED as a type no consumer or ball
      // rule recognises, and the sender believed it had asked. The CLI refuses
      // this (wire/src/cli/send.ts:995); the daemon must too.
      const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
      const sent = parseToolJson(
        handleToolCall(sender, "tribe.send", { to: "@chief", message: "hi", type: '"request"' }, makeOpts([])),
      )

      expect(sent.error).toBe(
        "tribe.send: invalid type '\"request\"' - expected one of: assign, status, query, response, notify, request, verdict",
      )
      const stored = db.query("SELECT COUNT(*) AS n FROM messages WHERE type = '\"request\"'").get() as { n: number }
      expect(stored.n, "a refused type must store nothing").toBe(0)
    })

    it("keeps an explicit null type as omitted -> notify (28200 follow-up)", () => {
      // @cto 74b5accb: the old `(a.type as string) ?? "notify"` turned null into
      // notify, so a harness that serializes an unset optional as null was
      // always stored as notify. The refusal must keep that: only a NON-null
      // unknown value is refused. A census cannot see the null population
      // because those rows are indistinguishable from omitted ones.
      addSession(db, stmts, "sess-chief", "@chief", Date.now())
      const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
      const res = parseToolJson(
        handleToolCall(
          sender,
          "tribe.send",
          { to: "@chief", message: "hi", type: null },
          makeOpts([liveInfo("sess-chief", "@chief")]),
        ),
      )

      expect(res.error).toBeUndefined()
      const stored = db.prepare("SELECT type FROM messages WHERE id = ?").get(res.id as string) as { type: string }
      expect(stored.type).toBe("notify")
    })

    it("pins invalid request", () => {
      const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
      const sent = parseToolJson(
        handleToolCall(sender, "tribe.send", { to: "@chief", message: "hi", request: 123 }, makeOpts()),
      )
      expect(sent.error).toBe("tribe.send: invalid request - must be true or a non-empty string")
    })

    it("pins invalid request 'true' literal string", () => {
      const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
      const sent = parseToolJson(
        handleToolCall(sender, "tribe.send", { to: "@chief", message: "hi", request: "true" }, makeOpts()),
      )
      expect(sent.error).toBe(
        'tribe.send: invalid request - "true" is reserved for generated tracking, pass boolean true',
      )
    })

    it("pins invalid expires_in_ms", () => {
      const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
      const sent = parseToolJson(
        handleToolCall(sender, "tribe.send", { to: "@chief", message: "hi", expires_in_ms: -50 }, makeOpts()),
      )
      expect(sent.error).toBe(
        "tribe.send: invalid expires_in_ms - must be a positive integer no greater than 2592000000",
      )
    })

    it.each([true, false, "yes", null])("rejects removed incident muting field %s before storing anything", (value) => {
      const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
      const sent = parseToolJson(
        handleToolCall(
          sender,
          "tribe.send",
          {
            to: "@chief",
            message: "incident",
            summary: "incident",
            incident: { emitter: "test", subject: "test", condition: "test", suppress_after_evidence: value },
          },
          makeOpts(),
        ),
      )
      expect(sent.error).toBe("tribe.send: invalid incident.suppress_after_evidence - field has been removed")
      expect((db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBe(0)
      expect((db.query("SELECT COUNT(*) AS n FROM pending_request").get() as { n: number }).n).toBe(0)
    })

    it("pins invalid incident shape", () => {
      const sender = makeContext(db, stmts, "sess-dev7", "@dev/7")
      const sent = parseToolJson(
        handleToolCall(sender, "tribe.send", { to: "@chief", message: "hi", incident: "not-an-object" }, makeOpts()),
      )
      expect(sent.error).toBe("tribe.send: invalid incident - must be an object {emitter, subject, condition, active?}")
    })
  })
})
