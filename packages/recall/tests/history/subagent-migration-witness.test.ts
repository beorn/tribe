/**
 * Witness test for CTO ruling on Bead 25158:
 * Migration fed by the real producer (a fixture database written by the OLD indexer
 * over a real parent-plus-subagent pair), migrated, re-indexed, and then a second
 * incremental run that indexes nothing.
 */

import { Database } from "bun:sqlite"
import * as fs from "fs"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const corpus = vi.hoisted(() => ({ projects: "", plans: [] as string[], todos: [] as string[] }))
vi.mock("../../src/history/db", async (original) => ({
  ...(await original<typeof import("../../src/history/db")>()),
  get PROJECTS_DIR() {
    return corpus.projects
  },
  getAllSessionEntries: () => [],
  findPlanFiles: () => corpus.plans,
  findTodoFiles: () => corpus.todos,
}))

const { rebuildIndex, indexSessionFile } = await import("../../src/history/indexer")
const { initSchema, runMigrations, closeDb, getIndexMeta, setIndexMeta } = await import("../../src/history/db")
const { ftsSearchWithSnippet } = await import("../../src/history/db-queries")
const { recall } = await import("../../src/history/search")

const FIXTURES_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "../fixtures/subagent-migration")

let root: string
let db: Database
let dbPath: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(require("os").tmpdir()), "recall-migration-witness-"))
  corpus.projects = path.join(root, "projects")
  corpus.plans = []
  corpus.todos = []

  // Recreate the project layout matching the legacy fixture's project path: "test-legacy-proj"
  const projDir = path.join(corpus.projects, "test-legacy-proj")
  const subagentDir = path.join(projDir, "parent-sess", "subagents")
  fs.mkdirSync(subagentDir, { recursive: true })

  // Copy transcripts from fixture directory
  fs.copyFileSync(path.join(FIXTURES_DIR, "parent-sess.jsonl"), path.join(projDir, "parent-sess.jsonl"))
  fs.copyFileSync(
    path.join(FIXTURES_DIR, "parent-sess/subagents/agent-sub1.jsonl"),
    path.join(subagentDir, "agent-sub1.jsonl"),
  )

  // Copy legacy database written by the old indexer
  dbPath = path.join(root, "witness.db")
  fs.copyFileSync(path.join(FIXTURES_DIR, "clobbered-legacy.db"), dbPath)

  db = new Database(dbPath)
  vi.stubEnv("RECALL_DB_PATH", dbPath)
  vi.stubEnv("RECALL_SKIP_CODEX", "1")
  vi.stubEnv("CLAUDE_DIR", root)
})

afterEach(() => {
  closeDb()
  db.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

describe("Subagent Migration Witness (CTO Ruling 25158)", () => {
  test("legacy database has clobbered subagent state before migration", () => {
    // 1. Verify the starting state produced by the old indexer:
    // Only 1 session exists, pointing to the subagent file, clobbering the parent
    const sessions = db.query("SELECT * FROM sessions").all() as any[]
    expect(sessions.length).toBe(1)
    expect(sessions[0].id).toBe("parent-sess")
    expect(sessions[0].jsonl_path).toContain("subagents/agent-sub1.jsonl")
    expect(sessions[0].parent_session_id).toBeUndefined()
    expect(sessions[0].agent_id).toBeUndefined()

    // Messages table has only 2 messages (parent messages were wiped by the old indexer)
    const msgCount = (db.query("SELECT COUNT(*) as c FROM messages").get() as any).c
    expect(msgCount).toBe(2)
  })

  test("migration cleans clobbered rows, rebuildIndex reindexes parent and subagent under distinct keys, second pass indexes 0", async () => {
    const consoleLogs: string[] = []
    vi.spyOn(console, "log").mockImplementation((...args) => {
      consoleLogs.push(args.join(" "))
    })

    // Step 1: Run migration on legacy database
    initSchema(db)

    // Verify migration logged cleanup
    const migrationLog = consoleLogs.find((l) => l.includes("[migration] Cleaned"))
    expect(migrationLog).toBeDefined()
    expect(migrationLog).toContain("Cleaned 1 clobbered subagent session(s)")

    // Verify columns exist now
    const tableInfo = db.query("PRAGMA table_info(sessions)").all() as any[]
    const colNames = tableInfo.map((c) => c.name)
    expect(colNames).toContain("parent_session_id")
    expect(colNames).toContain("agent_id")

    // Verify clobbered row and its messages were deleted
    const sessionCountAfterMigration = (db.query("SELECT COUNT(*) as c FROM sessions").get() as any).c
    expect(sessionCountAfterMigration).toBe(0)
    const msgCountAfterMigration = (db.query("SELECT COUNT(*) as c FROM messages").get() as any).c
    expect(msgCountAfterMigration).toBe(0)

    // Step 2: First rebuild pass — re-indexes parent and subagent cleanly
    const run1 = await rebuildIndex(db, { incremental: true })
    expect(run1.files).toBe(2)
    expect(run1.messages).toBe(4)

    // Verify sessions table now has two distinct rows with stable keys
    const parentRow = db.query("SELECT * FROM sessions WHERE id = 'parent-sess'").get() as any
    expect(parentRow).toBeDefined()
    expect(parentRow.jsonl_path).toBe("test-legacy-proj/parent-sess.jsonl")
    expect(parentRow.parent_session_id).toBeNull()
    expect(parentRow.agent_id).toBeNull()
    expect(parentRow.message_count).toBe(2)

    const subagentRow = db.query("SELECT * FROM sessions WHERE id = 'parent-sess:agent-sub1'").get() as any
    expect(subagentRow).toBeDefined()
    expect(subagentRow.jsonl_path).toBe("test-legacy-proj/parent-sess/subagents/agent-sub1.jsonl")
    expect(subagentRow.parent_session_id).toBe("parent-sess")
    expect(subagentRow.agent_id).toBe("agent-sub1")
    expect(subagentRow.message_count).toBe(2)

    // Verify total messages
    const totalMsgs = (db.query("SELECT COUNT(*) as c FROM messages").get() as any).c
    expect(totalMsgs).toBe(4)

    // Step 3: Second incremental run — files are unchanged, MUST index 0 messages
    const run2 = await rebuildIndex(db, { incremental: true })
    expect(run2.messages).toBe(0)
    expect((db.query("SELECT COUNT(*) as c FROM messages").get() as any).c).toBe(4)

    // Step 4: Idempotency — runMigrations again on healthy database deletes 0 rows
    consoleLogs.length = 0
    runMigrations(db)
    expect(consoleLogs.filter((l) => l.includes("[migration] Cleaned")).length).toBe(0)
    expect((db.query("SELECT COUNT(*) as c FROM sessions").get() as any).c).toBe(2)
    expect((db.query("SELECT COUNT(*) as c FROM messages").get() as any).c).toBe(4)
  })

  test("search queries support parent-scoped filtering and expose subagent metadata", async () => {
    initSchema(db)
    await rebuildIndex(db, { incremental: true })

    // 1. Search with sessionId = 'parent-sess' matches BOTH parent and subagent messages
    const searchParent = ftsSearchWithSnippet(db, "question", { sessionId: "parent-sess" })
    expect(searchParent.results.length).toBe(1)
    expect(searchParent.results[0].session_id).toBe("parent-sess")
    expect(searchParent.results[0].parent_session_id).toBeNull()
    expect(searchParent.results[0].agent_id).toBeNull()

    const searchSubagentUnderParent = ftsSearchWithSnippet(db, "subagent instructions", { sessionId: "parent-sess" })
    expect(searchSubagentUnderParent.results.length).toBe(1)
    expect(searchSubagentUnderParent.results[0].session_id).toBe("parent-sess:agent-sub1")
    expect(searchSubagentUnderParent.results[0].parent_session_id).toBe("parent-sess")
    expect(searchSubagentUnderParent.results[0].agent_id).toBe("agent-sub1")

    // 2. High-level recall search exposes parentSessionId and agentId in results
    const recallResult = await recall("subagent finished task", { raw: true, since: "180d" })
    const subHit = recallResult.results.find((r) => r.sessionId === "parent-sess:agent-sub1")
    expect(subHit).toBeDefined()
    expect(subHit?.parentSessionId).toBe("parent-sess")
    expect(subHit?.agentId).toBe("agent-sub1")

    // 3. Exclude current session filters out subagents when current session is parent
    vi.stubEnv("CLAUDE_SESSION_ID", "parent-sess")
    const excludedResult = await recall("subagent finished task", {
      raw: true,
      since: "180d",
      excludeCurrentSession: true,
    })
    const subHitExcluded = excludedResult.results.find((r) => r.sessionId === "parent-sess:agent-sub1")
    expect(subHitExcluded).toBeUndefined()
  })

  test("record with mismatched sessionId logs a loud warning once per file and is never obeyed", async () => {
    const projDir = path.join(corpus.projects, "test-legacy-proj")
    const mismatchFile = path.join(projDir, "mismatched-session.jsonl")

    fs.writeFileSync(
      mismatchFile,
      JSON.stringify({
        sessionId: "wrong-id-1",
        type: "user",
        message: { content: "mismatched message 1" },
        timestamp: "2026-08-01T12:00:00.000Z",
      }) +
        "\n" +
        JSON.stringify({
          sessionId: "wrong-id-2",
          type: "assistant",
          message: { content: [{ type: "text", text: "mismatched message 2" }] },
          timestamp: "2026-08-01T12:00:05.000Z",
        }) +
        "\n",
    )

    initSchema(db)

    const warnCalls: string[] = []
    vi.spyOn(console, "warn").mockImplementation((...args) => {
      warnCalls.push(args.join(" "))
    })

    const result = await indexSessionFile(db, mismatchFile)
    expect(result.messages).toBe(2)

    // Verify loud warning was printed with count and last mismatched sessionId
    const warnMsg = warnCalls.find((w) => w.includes("mismatched sessionId"))
    expect(warnMsg).toBeDefined()
    expect(warnMsg).toContain("2 record(s)")
    expect(warnMsg).toContain('last: "wrong-id-2"')
    expect(warnMsg).toContain('expected: "mismatched-session"')

    // Verify session ID in DB is keyed by the FILE basename, NOT the records
    const row = db.query("SELECT * FROM sessions WHERE id = 'mismatched-session'").get() as any
    expect(row).toBeDefined()
    expect(db.query("SELECT * FROM sessions WHERE id = 'wrong-id-1'").get()).toBeNull()
    expect(db.query("SELECT * FROM sessions WHERE id = 'wrong-id-2'").get()).toBeNull()

    // Verify messages are keyed by the file's sessionId
    const msgs = db.query("SELECT * FROM messages WHERE session_id = 'mismatched-session'").all() as any[]
    expect(msgs.length).toBe(2)
  })
})
