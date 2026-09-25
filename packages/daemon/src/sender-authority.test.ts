/**
 * @failure A message from a claimed (tokenless) session reads exactly like one from a verified seat, so a reader
 *          cannot tell an unverified claim of a name from the name's owner.
 * @level l1
 * @consumer every envelope reader: tribe.fetch rows and the stdio adapter's <channel> meta (25074 3d-1a)
 * @testonly none
 *
 * Every envelope carries its sender's authority (25074 3d, @cto 2bfc1935 Q0): after 3d a standalone launch and a
 * nested unnamed provider child are class claimed, on the condition that the class is visible on the wire, in
 * members and on every envelope from that session. The authority is a fact about the message fixed at insert (the
 * v36 wakes_owner precedent), read from the sending session's row through sessionAuthority, and it survives archiving.
 * A message the daemon itself originates has no sending session and carries none.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createTribeContext, type TribeContext } from "./lib/context.ts"
import { createStatements, openDatabase, type TribeStatements } from "./lib/database.ts"
import { handleToolCall, type HandlerOpts } from "./lib/handlers.ts"
import { sendMessage } from "./lib/messaging.ts"
import { registerSession } from "./lib/session.ts"

const RECIPIENT = "@dev/3"

let dir: string
let db: ReturnType<typeof openDatabase>
let stmts: TribeStatements

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tribe-sender-authority-"))
  db = openDatabase(join(dir, "tribe.db"))
  stmts = createStatements(db)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function context(sessionId: string, name: string): TribeContext {
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

/** A registered sender whose session row holds the given authority, as the register path leaves it. */
function sender(sessionId: string, name: string, authority: "verified" | "bearer" | "claimed"): TribeContext {
  const ctx = context(sessionId, name)
  const bearerHash = authority === "bearer" ? "0a".repeat(32) : null
  registerSession(ctx, undefined, () => true, null, 0, "pull", undefined, null, null, null, null, bearerHash)
  // The dispatcher records a verified token the same way after the register (with-dispatcher.ts, 25074 3b).
  if (authority === "verified") {
    db.prepare("UPDATE sessions SET identity_sid = ?, identity_gen = ? WHERE id = ?").run(`${sessionId}-sid`, 1, sessionId)
  }
  return ctx
}

const opts = (): HandlerOpts => ({
  cleanup: () => {},
  userRenamed: false,
  setUserRenamed: () => {},
  getActiveSessionIds: () => new Set<string>(),
  hasActiveTransport: () => false,
  getActiveSessionInfo: () => [],
})

function fetchedAuthorities(): Record<string, unknown> {
  const reader = context("reader", RECIPIENT)
  const result = handleToolCall(reader, "tribe.fetch", { limit: 10 }, opts()) as { content: Array<{ text: string }> }
  const parsed = JSON.parse(result.content[0]?.text ?? "{}") as {
    events?: Array<{ from: string; from_authority?: unknown }>
  }
  return Object.fromEntries((parsed.events ?? []).map((event) => [event.from, event.from_authority]))
}

describe("every envelope carries its sender's authority (25074 3d-1a)", () => {
  test("a fetched row names the sender's authority: verified, bearer or claimed", () => {
    sendMessage(sender("s-verified", "@dev/1", "verified"), RECIPIENT, "from a verified seat", "notify")
    sendMessage(sender("s-bearer", "@dev/2", "bearer"), RECIPIENT, "from a bearer session", "notify")
    sendMessage(sender("s-claimed", "hand-shell", "claimed"), RECIPIENT, "from a claimed shell", "notify")

    expect(fetchedAuthorities()).toEqual({ "@dev/1": "verified", "@dev/2": "bearer", "hand-shell": "claimed" })
  })

  test("a claim of a verified seat's name reads claimed, never the owner's authority", () => {
    sendMessage(sender("s-owner", "@dev/1", "verified"), RECIPIENT, "the owner", "notify")
    const owner = fetchedAuthorities()["@dev/1"]
    // The same display name from a tokenless session: the envelope says so.
    sendMessage(sender("s-impostor", "@dev/1", "claimed"), RECIPIENT, "a claim", "notify")
    const reader = context("reader-2", RECIPIENT)
    const result = handleToolCall(reader, "tribe.fetch", { limit: 10 }, opts()) as { content: Array<{ text: string }> }
    const events = (JSON.parse(result.content[0]?.text ?? "{}") as { events?: Array<{ content: string; from_authority?: unknown }> })
      .events
    expect(owner).toBe("verified")
    expect(events?.find((event) => event.content === "a claim")?.from_authority).toBe("claimed")
  })

  test("a message the daemon originates carries no sender authority", () => {
    sendMessage(context("daemon", "daemon"), RECIPIENT, "a daemon notice", "notify")
    expect(fetchedAuthorities()).toEqual({ daemon: null })
  })

  test("the authority is fixed at insert and survives archiving", () => {
    const claimed = sender("s-claimed", "hand-shell", "claimed")
    const sent = sendMessage(claimed, RECIPIENT, "old claim", "notify")
    // The session later verifies: the message still says what its sender was when it was sent.
    db.prepare("UPDATE sessions SET identity_sid = 'late', identity_gen = 1 WHERE id = 's-claimed'").run()
    stmts.archiveExpiredMessages.run({ $cutoff: Date.now() + 1, $archived_at: Date.now() })
    expect(db.prepare("SELECT sender_authority FROM messages_archive WHERE id = ?").get(sent.id)).toEqual({
      sender_authority: "claimed",
    })
  })
})
