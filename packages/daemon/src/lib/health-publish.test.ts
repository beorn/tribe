/**
 * km @ag/super/20324-chain-refactor/20327 gap-4 — tribe.health.publish: the
 * dedicated daemon tool that emits an agent recovery (force-settle / restart /
 * rotate) as an ambient `health:recovery` broadcast so chief/deck SEE it —
 * instead of it rendering only in the agent's own pane (which forced the user to
 * relay recovery screenshots).
 *
 * Mirrors tribe.lifecycle.publish (a dedicated client→daemon tool) + the
 * accountly-plugin's `health:*` topic-broadcast. The TOPIC is set SERVER-SIDE
 * here — clients cannot set arbitrary topics via tribe.send (the send tool omits
 * topic; trust.ts gates registered topics), so a dedicated tool is the correct
 * seam for a host to publish a classified health event.
 */

import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { createTribeContext, type TribeContext } from "./context.ts"
import { handleToolCall, type HandlerOpts } from "./handlers.ts"

function makeContext(db: Database, stmts: TribeStatements, sessionId: string, name: string): TribeContext {
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

function makeOpts(): HandlerOpts {
  return {
    cleanup: () => {},
    userRenamed: false,
    setUserRenamed: () => {},
    getActiveSessionIds: () => new Set<string>(),
    hasActiveTransport: () => false,
    getActiveSessionInfo: () => [],
  }
}

function parse(result: unknown): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}"
  return JSON.parse(text) as Record<string, unknown>
}

type MsgRow = {
  type: string
  sender: string
  content: string
  topic: string | null
  recipient: string
  delivery: string
}

function row(db: Database, id: string): MsgRow | null {
  return (db.query("SELECT type, sender, content, topic, recipient, delivery FROM messages WHERE id = ?").get(id) ??
    null) as MsgRow | null
}

describe("km @ag/super/20327 — tribe.health.publish (lateral recovery channel)", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "health-pub-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })
  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("publishes a recovery as an ambient health:recovery broadcast (topic set server-side)", () => {
    // The connection is the HOST (silvercode), not the recovering agent — the
    // agent it names travels in the content, the same shape lifecycle.publish uses.
    const ctx = makeContext(db, stmts, "sess-host", "silvercode-13850")
    const res = parse(
      handleToolCall(
        ctx,
        "tribe.health.publish",
        { content: "@agent/3 recovery #1: restart attempt 1 (rss)", agent: "@agent/3", seq: 1 },
        makeOpts(),
      ),
    )
    expect(res.published).toBe(true)
    expect(typeof res.id).toBe("string")
    expect(res.agent).toBe("@agent/3")
    expect(res.seq).toBe(1)

    const r = row(db, res.id as string)
    expect(r?.topic).toBe("health:recovery") // the diagnostics adapter filters event.topic startsWith "health:"
    expect(r?.type).toBe("health:recovery") // ...and type startsWith "health:" (mirrors accountly's health:* broadcasts)
    expect(r?.sender).toBe("daemon") // health:* is daemon-trusted and must remain visible through tribe.fetch.
    expect(r?.recipient).toBe("*") // broadcast — chief/deck both observe it
    expect(r?.delivery).toBe("pull") // ambient (health visibility), not a push DM
    expect(r?.content).toContain("@agent/3 recovery #1")
  })

  it("rejects a missing/empty content field — loud, never a silent empty publish", () => {
    const ctx = makeContext(db, stmts, "sess-host", "silvercode-13850")
    expect(typeof parse(handleToolCall(ctx, "tribe.health.publish", {}, makeOpts())).error).toBe("string")
    expect(typeof parse(handleToolCall(ctx, "tribe.health.publish", { content: "" }, makeOpts())).error).toBe("string")
    expect(typeof parse(handleToolCall(ctx, "tribe.health.publish", { content: 42 }, makeOpts())).error).toBe("string")
    // No row written on rejection.
    expect((db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBe(0)
  })

  it("agent/seq are optional metadata — a bare content publish still emits the topic", () => {
    const ctx = makeContext(db, stmts, "sess-solo", "@agent/3")
    const res = parse(
      handleToolCall(ctx, "tribe.health.publish", { content: "force-settled a stalled turn" }, makeOpts()),
    )
    expect(res.published).toBe(true)
    expect(row(db, res.id as string)?.topic).toBe("health:recovery")
  })
})
