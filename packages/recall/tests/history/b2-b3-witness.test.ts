/**
 * @failure  Incremental recall index rewrites every session or blocks prompt hooks on writer lock
 * @level    l2
 * @consumer @i/20-search-and-memory/25158-recall-index-runs-back-to-back-and-rewrites-every-run
 * @testonly none
 */
import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { initSchema } from "../../src/history/db-schema.ts"
import { getSession, ftsSearch, getIndexMeta, setIndexMeta } from "../../src/history/db-queries.ts"
import { closeDb, acquireIndexWriter } from "../../src/history/db.ts"
import { rebuildIndex, discoverProjectCwds, indexSessionFile } from "../../src/history/indexer.ts"
import { runInjectDelta, createMemorySeenStore } from "../../src/lib/inject-core.ts"

describe("Change 2 Tier B2 & B3 Witness Tests (CTO Ruling 2026-09-22: B2, B3)", () => {
  let tempDir: string
  let db: Database
  let dbPath: string
  let projectsDir: string
  let origClaudeDir: string | undefined
  let origDbPath: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "recall-b2-b3-witness-"))
    origClaudeDir = process.env.CLAUDE_DIR
    origDbPath = process.env.RECALL_DB_PATH

    const isolatedClaude = join(tempDir, "claude")
    projectsDir = join(isolatedClaude, "projects")
    mkdirSync(projectsDir, { recursive: true })
    process.env.CLAUDE_DIR = isolatedClaude

    dbPath = join(tempDir, "test.db")
    process.env.RECALL_DB_PATH = dbPath
    db = new Database(dbPath)
    initSchema(db)
    process.env.RECALL_SKIP_CODEX = "1"
  })

  afterEach(() => {
    closeDb()
    db.close()
    if (origClaudeDir !== undefined) {
      process.env.CLAUDE_DIR = origClaudeDir
    } else {
      delete process.env.CLAUDE_DIR
    }
    if (origDbPath !== undefined) {
      process.env.RECALL_DB_PATH = origDbPath
    } else {
      delete process.env.RECALL_DB_PATH
    }
    delete process.env.RECALL_SKIP_CODEX
    safeRemoveSync(tempDir, { within: tmpdir() })
  })

  // --------------------------------------------------------------------------
  // B2: Claude tail indexing contract
  // --------------------------------------------------------------------------

  test("B2.1: Append 1 line -> 1 message inserted, row IDs unchanged, no DELETE, tail offset advances", async () => {
    const projDir = join(projectsDir, "-test-proj")
    mkdirSync(projDir, { recursive: true })
    const sessFile = join(projDir, "sess-b2-1.jsonl")

    const line1 =
      JSON.stringify({
        type: "user",
        uuid: "u1",
        cwd: "/test/proj",
        timestamp: "2026-09-22T10:00:00.000Z",
        message: { content: "first user prompt" },
      }) + "\n"
    const line2 =
      JSON.stringify({
        type: "assistant",
        uuid: "u2",
        cwd: "/test/proj",
        timestamp: "2026-09-22T10:01:00.000Z",
        message: { content: [{ type: "text", text: "first assistant reply" }] },
      }) + "\n"

    writeFileSync(sessFile, line1 + line2, "utf8")

    const res1 = await rebuildIndex(db, { incremental: true })
    expect(res1.messages).toBe(2)

    const sess1 = getSession(db, "sess-b2-1")
    expect(sess1).toBeDefined()
    expect(sess1?.tail_offset).toBe(Buffer.byteLength(line1 + line2, "utf8"))
    expect(sess1?.head_fingerprint).toBeDefined()
    expect(sess1?.tail_fingerprint).toBeDefined()
    expect(sess1?.cwd).toBe("/test/proj")

    const initialRows = db
      .prepare("SELECT id, content FROM messages WHERE session_id = 'sess-b2-1' ORDER BY id ASC")
      .all() as Array<{ id: number; content: string }>
    expect(initialRows).toHaveLength(2)
    const [row1Id, row2Id] = initialRows.map((r) => r.id)

    // Append exactly 1 new line
    const line3 =
      JSON.stringify({
        type: "user",
        uuid: "u3",
        cwd: "/test/proj",
        timestamp: "2026-09-22T10:05:00.000Z",
        message: { content: "second user prompt" },
      }) + "\n"

    writeFileSync(sessFile, line1 + line2 + line3, "utf8")

    const res2 = await rebuildIndex(db, { incremental: true })
    expect(res2.messages).toBe(1) // Exactly 1 message indexed on tail append

    const afterRows = db
      .prepare("SELECT id, content FROM messages WHERE session_id = 'sess-b2-1' ORDER BY id ASC")
      .all() as Array<{ id: number; content: string }>
    expect(afterRows).toHaveLength(3)

    // Existing row IDs are untouched (no DELETE FROM messages)
    expect(afterRows[0]!.id).toBe(row1Id)
    expect(afterRows[1]!.id).toBe(row2Id)
    expect(afterRows[2]!.id).toBeGreaterThan(row2Id!)
    expect(afterRows[2]!.content).toBe("second user prompt")

    const sess2 = getSession(db, "sess-b2-1")
    expect(sess2?.message_count).toBe(3)
    expect(sess2?.tail_offset).toBe(Buffer.byteLength(line1 + line2 + line3, "utf8"))
    expect(sess2?.head_fingerprint).toBe(sess1?.head_fingerprint)
  })

  test("B2.2: Partial last line without newline is not consumed until completed", async () => {
    const projDir = join(projectsDir, "-test-proj")
    mkdirSync(projDir, { recursive: true })
    const sessFile = join(projDir, "sess-b2-2.jsonl")

    const line1 =
      JSON.stringify({
        type: "user",
        uuid: "u1",
        cwd: "/test/proj",
        timestamp: "2026-09-22T10:00:00.000Z",
        message: { content: "complete line one" },
      }) + "\n"

    writeFileSync(sessFile, line1, "utf8")
    await rebuildIndex(db, { incremental: true })

    const sess1 = getSession(db, "sess-b2-2")
    const initialOffset = sess1?.tail_offset
    expect(initialOffset).toBe(Buffer.byteLength(line1, "utf8"))

    // Append partial line without trailing newline
    const partialLine = JSON.stringify({
      type: "user",
      uuid: "u2",
      cwd: "/test/proj",
      timestamp: "2026-09-22T10:01:00.000Z",
      message: { content: "partial incomplete" },
    }) // note: no \n

    writeFileSync(sessFile, line1 + partialLine, "utf8")

    const resPartial = await rebuildIndex(db, { incremental: true })
    expect(resPartial.messages).toBe(0) // 0 messages consumed

    const sessPartial = getSession(db, "sess-b2-2")
    expect(sessPartial?.message_count).toBe(1)
    expect(sessPartial?.tail_offset).toBe(initialOffset)

    // Complete the line with newline
    writeFileSync(sessFile, line1 + partialLine + "\n", "utf8")

    const resCompleted = await rebuildIndex(db, { incremental: true })
    expect(resCompleted.messages).toBe(1)

    const sessCompleted = getSession(db, "sess-b2-2")
    expect(sessCompleted?.message_count).toBe(2)
    expect(sessCompleted?.tail_offset).toBe(Buffer.byteLength(line1 + partialLine + "\n", "utf8"))
  })

  test("B2.3: Shrink triggers full re-index with shrink counts recorded", async () => {
    const projDir = join(projectsDir, "-test-proj")
    mkdirSync(projDir, { recursive: true })
    const sessFile = join(projDir, "sess-b2-3.jsonl")

    const lines = [1, 2, 3, 4, 5]
      .map(
        (i) =>
          JSON.stringify({
            type: "user",
            uuid: `u${i}`,
            cwd: "/test/proj",
            timestamp: `2026-09-22T10:0${i}:00.000Z`,
            message: { content: `prompt ${i}` },
          }) + "\n",
      )
      .join("")

    writeFileSync(sessFile, lines, "utf8")
    await rebuildIndex(db, { incremental: true })

    const sessBefore = getSession(db, "sess-b2-3")
    expect(sessBefore?.message_count).toBe(5)

    // Truncate file to only first 2 lines
    const truncatedLines = [1, 2]
      .map(
        (i) =>
          JSON.stringify({
            type: "user",
            uuid: `u${i}`,
            cwd: "/test/proj",
            timestamp: `2026-09-22T10:0${i}:00.000Z`,
            message: { content: `prompt ${i}` },
          }) + "\n",
      )
      .join("")

    writeFileSync(sessFile, truncatedLines, "utf8")

    await rebuildIndex(db, { incremental: true })

    const sessAfter = getSession(db, "sess-b2-3")
    expect(sessAfter?.message_count).toBe(2)
    expect(sessAfter?.shrink_old_count).toBe(5)
    expect(sessAfter?.shrink_new_count).toBe(2)
    expect(sessAfter?.tail_offset).toBe(Buffer.byteLength(truncatedLines, "utf8"))

    const remainingRows = db.prepare("SELECT content FROM messages WHERE session_id = 'sess-b2-3'").all() as Array<{
      content: string
    }>
    expect(remainingRows).toHaveLength(2)
  })

  test("B2.4: Size-preserving rewrite triggers full re-index", async () => {
    const projDir = join(projectsDir, "-test-proj")
    mkdirSync(projDir, { recursive: true })
    const sessFile = join(projDir, "sess-b2-4.jsonl")

    const lineA =
      JSON.stringify({
        type: "user",
        uuid: "uA",
        cwd: "/test/proj",
        timestamp: "2026-09-22T10:00:00.000Z",
        message: { content: "original text 123" },
      }) + "\n"

    writeFileSync(sessFile, lineA, "utf8")
    await rebuildIndex(db, { incremental: true })

    const sessBefore = getSession(db, "sess-b2-4")
    const rowsBefore = db.prepare("SELECT id, content FROM messages WHERE session_id = 'sess-b2-4'").all() as Array<{
      id: number
      content: string
    }>
    expect(rowsBefore[0]!.content).toBe("original text 123")

    // Overwrite with identical byte length but different content and newer mtime
    const lineB =
      JSON.stringify({
        type: "user",
        uuid: "uB",
        cwd: "/test/proj",
        timestamp: "2026-09-22T10:00:00.000Z",
        message: { content: "modified text 456" },
      }) + "\n"
    expect(Buffer.byteLength(lineA, "utf8")).toBe(Buffer.byteLength(lineB, "utf8"))

    // Wait 10ms and touch mtime
    writeFileSync(sessFile, lineB, "utf8")
    const futureTime = (Date.now() + 5000) / 1000
    utimesSync(sessFile, futureTime, futureTime)

    await rebuildIndex(db, { incremental: true })

    const rowsAfter = db
      .prepare("SELECT id, uuid, content FROM messages WHERE session_id = 'sess-b2-4'")
      .all() as Array<{ id: number; uuid: string; content: string }>
    expect(rowsAfter).toHaveLength(1)
    expect(rowsAfter[0]!.content).toBe("modified text 456")
    expect(rowsAfter[0]!.uuid).toBe("uB")

    const sessAfter = getSession(db, "sess-b2-4")
    expect(sessAfter?.tail_fingerprint).not.toBe(sessBefore?.tail_fingerprint)
  })

  test("B2.5: Fingerprint mismatch triggers full re-index", async () => {
    const projDir = join(projectsDir, "-test-proj")
    mkdirSync(projDir, { recursive: true })
    const sessFile = join(projDir, "sess-b2-5.jsonl")

    const line1 =
      JSON.stringify({
        type: "user",
        uuid: "u1",
        cwd: "/test/proj",
        timestamp: "2026-09-22T10:00:00.000Z",
        message: { content: "first content" },
      }) + "\n"

    writeFileSync(sessFile, line1, "utf8")
    await rebuildIndex(db, { incremental: true })

    // Tamper with the row in DB: if full re-index runs, this row will be deleted and re-indexed with "first content"
    db.prepare("UPDATE messages SET content = 'tampered content' WHERE session_id = 'sess-b2-5'").run()

    // Corrupt recorded tail_fingerprint in DB
    db.prepare("UPDATE sessions SET tail_fingerprint = 'corrupted_hash' WHERE id = 'sess-b2-5'").run()

    // Append line 2
    const line2 =
      JSON.stringify({
        type: "user",
        uuid: "u2",
        cwd: "/test/proj",
        timestamp: "2026-09-22T10:01:00.000Z",
        message: { content: "second content" },
      }) + "\n"
    writeFileSync(sessFile, line1 + line2, "utf8")

    await rebuildIndex(db, { incremental: true })

    // Mismatch triggered full re-index: old messages deleted and re-inserted from file
    const rows2 = db
      .prepare("SELECT id, content FROM messages WHERE session_id = 'sess-b2-5' ORDER BY id ASC")
      .all() as Array<{ id: number; content: string }>
    expect(rows2).toHaveLength(2)
    expect(rows2[0]!.content).toBe("first content") // Not 'tampered content'
    expect(rows2[1]!.content).toBe("second content")
  })

  // --------------------------------------------------------------------------
  // B3: Project sources off the hook & exact cwd discovery
  // --------------------------------------------------------------------------

  test("B3.1: Prompt hook only reads and succeeds while index writer lock is held", async () => {
    // Populate DB with a session and content
    const sessFile = join(projectsDir, "-test-proj", "sess-b3-1.jsonl")
    mkdirSync(join(projectsDir, "-test-proj"), { recursive: true })
    writeFileSync(
      sessFile,
      JSON.stringify({
        type: "user",
        uuid: "u1",
        cwd: "/test/proj",
        timestamp: "2026-09-22T10:00:00.000Z",
        message: {
          content:
            "why does packages/recall/src/history/indexer.ts mention architectural invariants? Here is the discussion of architectural invariants.",
        },
      }) + "\n",
      "utf8",
    )
    await rebuildIndex(db)

    // Acquire writer lock
    using _lock = acquireIndexWriter(db)

    // runInjectDelta should succeed without error or contention skip because hook only reads
    const result = await runInjectDelta(
      "why does packages/recall/src/history/indexer.ts mention architectural invariants?",
      createMemorySeenStore(),
      {
        minRank: 0,
        deps: {
          getVaultDbPath: () => "/bound/vault.db",
        },
      },
    )

    expect(result.skipped).toBe(false)
  })

  test("B3.2: rebuildIndex sets run_started_at and never blanks last_rebuild during run", async () => {
    setIndexMeta(db, "last_rebuild", "2026-09-22T08:00:00.000Z")

    const res = await rebuildIndex(db)
    expect(res).toBeDefined()

    const startedAt = getIndexMeta(db, "run_started_at")
    expect(startedAt).toBeDefined()
    expect(typeof startedAt).toBe("string")
    expect(new Date(startedAt!).getTime()).toBeGreaterThan(0)

    const lastRebuild = getIndexMeta(db, "last_rebuild")
    expect(lastRebuild).toBeDefined()
    expect(lastRebuild).not.toBe("")
    expect(new Date(lastRebuild!).getTime()).toBeGreaterThan(new Date("2026-09-22T08:00:00.000Z").getTime())
  })

  test("B3.3: Discovery reads exact cwd from Claude transcripts, indexes discovered roots, skips vanished", async () => {
    const activeProjectDir = join(tempDir, "active-project")
    const vanishedProjectDir = join(tempDir, "vanished-project")
    mkdirSync(activeProjectDir, { recursive: true })

    // Create a CLAUDE.md in active project
    writeFileSync(
      join(activeProjectDir, "CLAUDE.md"),
      "# Active Project Guide\n\nGuidelines for active project discovery.\n",
      "utf8",
    )

    const projDir = join(projectsDir, "-test-proj")
    mkdirSync(projDir, { recursive: true })

    // Session 1 records active project cwd
    const sess1File = join(projDir, "sess-active.jsonl")
    writeFileSync(
      sess1File,
      JSON.stringify({
        type: "user",
        uuid: "u1",
        cwd: activeProjectDir,
        timestamp: new Date().toISOString(),
        message: { content: "work on active project" },
      }) + "\n",
      "utf8",
    )

    // Session 2 records vanished project cwd
    const sess2File = join(projDir, "sess-vanished.jsonl")
    writeFileSync(
      sess2File,
      JSON.stringify({
        type: "user",
        uuid: "u2",
        cwd: vanishedProjectDir,
        timestamp: new Date().toISOString(),
        message: { content: "work on vanished project" },
      }) + "\n",
      "utf8",
    )

    // First indexing pass indexes sessions and stores exact cwd
    await rebuildIndex(db)

    const sessActive = getSession(db, "sess-active")
    expect(sessActive?.cwd).toBe(activeProjectDir)

    const sessVanished = getSession(db, "sess-vanished")
    expect(sessVanished?.cwd).toBe(vanishedProjectDir)

    // Test discovery
    const discovery = discoverProjectCwds(db)
    expect(discovery.discovered).toContain(activeProjectDir)
    expect(discovery.vanished).toContain(vanishedProjectDir)

    // Verify CLAUDE.md from activeProjectDir was indexed into content table
    const contentRows = db.prepare("SELECT * FROM content WHERE content_type = 'claude_md'").all() as Array<{
      title: string
      content: string
    }>
    expect(
      contentRows.some(
        (r) =>
          r.title.includes("Active Project Guide") || r.content.includes("Guidelines for active project discovery"),
      ),
    ).toBe(true)
  })

  test("B3.4: sessions.cwd is the project key for search projectFilter", async () => {
    const customCwd = "/hh/dev-wt7"
    const projDir = join(projectsDir, "-hh-dev-wt7")
    mkdirSync(projDir, { recursive: true })

    const sessFile = join(projDir, "sess-cwd-filter.jsonl")
    writeFileSync(
      sessFile,
      JSON.stringify({
        type: "user",
        uuid: "u1",
        cwd: customCwd,
        timestamp: "2026-09-22T10:00:00.000Z",
        message: { content: "searchable keyword in wt7 session" },
      }) + "\n",
      "utf8",
    )

    await rebuildIndex(db)

    // Search filtering by exact cwd substring
    const hits = ftsSearch(db, "searchable keyword", { projectFilter: "dev-wt7" })
    expect(hits.results.length).toBeGreaterThanOrEqual(1)
    expect(hits.results[0]!.cwd).toBe(customCwd)

    // Non-matching project filter returns 0 results
    const noHits = ftsSearch(db, "searchable keyword", { projectFilter: "dev-wt99" })
    expect(noHits.results).toHaveLength(0)
  })
})
