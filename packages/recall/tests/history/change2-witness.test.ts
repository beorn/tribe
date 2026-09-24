import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import {
  CURRENT_SCHEMA_VERSION,
  MIGRATION_STEPS,
  initSchema,
} from "../../src/history/db-schema.ts"
import { getMessageCount, getSession, insertMessage, upsertSession } from "../../src/history/db-queries.ts"
import { closeDb, getDb } from "../../src/history/db.ts"
import { rebuildIndex } from "../../src/history/indexer.ts"

describe("Change 2 Witness Tests (A7 & A8 — CTO Ruling 2026-09-22)", () => {
  let tempDir: string
  let db: Database
  let dbPath: string
  let projectsDir: string
  let origClaudeDir: string | undefined
  let origDbPath: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "recall-change2-witness-"))
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
    process.exitCode = 0
    safeRemoveSync(tempDir, { within: tmpdir() })
  })

  // --------------------------------------------------------------------------
  // A7: Write pattern (chunked commits, savepoints, synchronous=NORMAL, cache_size)
  // --------------------------------------------------------------------------

  test("A7: synchronous=NORMAL and cache_size=-64000 are set during index runs", async () => {
    await rebuildIndex(db, { incremental: true, skipCodex: true })

    const syncRow = db.prepare("PRAGMA synchronous").get() as { synchronous: number }
    // 1 is NORMAL in SQLite (0 = OFF, 1 = NORMAL, 2 = FULL, 3 = EXTRA)
    expect(syncRow.synchronous).toBe(1)

    const cacheRow = db.prepare("PRAGMA cache_size").get() as { cache_size: number }
    // cache_size set to -64000 (or at least 64MB)
    expect(cacheRow.cache_size).toBe(-64000)
  })

  test("A7: chunked commits around savepoints — only malformed file rolls back, others in chunk commit", async () => {
    const projDir = join(projectsDir, "p1")
    mkdirSync(projDir, { recursive: true })

    // Create 10 valid transcript files and 1 malformed file
    for (let i = 1; i <= 10; i++) {
      const file = join(projDir, `sess-${i.toString().padStart(3, "0")}.jsonl`)
      const content = [
        JSON.stringify({ type: "user", message: { uuid: `u-${i}-1`, content: `hello ${i}` } }),
        JSON.stringify({ type: "assistant", message: { uuid: `u-${i}-2`, content: `reply ${i}` } }),
      ].join("\n")
      writeFileSync(file, content, "utf8")
    }

    // Malformed file in the middle (line 2 invalid JSON, line 1 valid message to verify rollback)
    const badFile = join(projDir, "sess-005.jsonl")
    writeFileSync(
      badFile,
      JSON.stringify({ type: "user", uuid: "u-5-1", message: { role: "user", content: "hello 5" } }) + "\nINVALID JSON SYNTAX\n",
      "utf8"
    )

    const result = await rebuildIndex(db, { incremental: true, skipCodex: true })

    // Valid files should be indexed
    expect(result.files).toBeGreaterThanOrEqual(9)
    const sess1 = getSession(db, "sess-001")
    expect(sess1).toBeDefined()
    expect(sess1?.status).toBe("complete")
    expect(getMessageCount(db, "sess-001")).toBe(2)

    const sess10 = getSession(db, "sess-010")
    expect(sess10).toBeDefined()
    expect(sess10?.status).toBe("complete")
    expect(getMessageCount(db, "sess-010")).toBe(2)

    // The malformed file should have rolled back its messages and marked stale-unreadable
    const badSess = getSession(db, "sess-005")
    expect(badSess).toBeDefined()
    expect(badSess?.status).toBe("stale-unreadable")
    expect(getMessageCount(db, "sess-005")).toBe(0)
  })

  test("A7: chunked commits — commit is called once per chunk, not per file", async () => {
    const projDir = join(projectsDir, "p1")
    mkdirSync(projDir, { recursive: true })

    for (let i = 1; i <= 25; i++) {
      const file = join(projDir, `sess-${i.toString().padStart(3, "0")}.jsonl`)
      writeFileSync(
        file,
        JSON.stringify({ type: "user", message: { uuid: `u-${i}`, content: `hello ${i}` } }),
        "utf8"
      )
    }

    const executedSql: string[] = []
    const origRun = db.run.bind(db)
    const origExec = db.exec.bind(db)

    db.run = ((sql: string, ...args: any[]) => {
      executedSql.push(sql)
      return (origRun as any)(sql, ...args)
    }) as any

    db.exec = ((sql: string) => {
      executedSql.push(sql)
      return origExec(sql)
    }) as any

    try {
      await rebuildIndex(db, { incremental: true, skipCodex: true, chunkSize: 10 })
    } finally {
      db.run = origRun
      db.exec = origExec
    }

    const commitCalls = executedSql.filter((s) => s.trim().toUpperCase().startsWith("COMMIT"))
    // For 25 files with chunkSize 10, there should be ceil(25/10) = 3 chunk commits
    expect(commitCalls.length).toBeGreaterThanOrEqual(3)
    expect(commitCalls.length).toBeLessThan(10) // not per-file!
  })

  test("A7: PRAGMA optimize is executed at the end of rebuildIndex", async () => {
    const executedSql: string[] = []
    const origRun = db.run.bind(db)
    const origExec = db.exec.bind(db)

    db.run = ((sql: string, ...args: any[]) => {
      executedSql.push(sql)
      return (origRun as any)(sql, ...args)
    }) as any

    db.exec = ((sql: string) => {
      executedSql.push(sql)
      return origExec(sql)
    }) as any

    try {
      await rebuildIndex(db, { incremental: true, skipCodex: true })
    } finally {
      db.run = origRun
      db.exec = origExec
    }

    const optimizeCall = executedSql.find((s) => s.includes("PRAGMA optimize"))
    expect(optimizeCall).toBeDefined()
  })

  test("A7: statement caching — insertMessage reuses prepared statements rather than re-preparing", () => {
    const prepares: string[] = []
    const origPrepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => {
      prepares.push(sql)
      return origPrepare(sql)
    }) as any

    try {
      for (let i = 1; i <= 20; i++) {
        insertMessage(db, `uuid-${i}`, "sess-test", "user", `content ${i}`, null, null, Date.now())
      }
    } finally {
      db.prepare = origPrepare
    }

    const insertMsgPrepares = prepares.filter((s) => s.includes("INSERT INTO messages"))
    expect(insertMsgPrepares.length).toBe(1)
  })

  // --------------------------------------------------------------------------
  // A8: Safe two-miss pruning of vanished files
  // --------------------------------------------------------------------------

  test("A8: vanished file is marked stale-missing on miss 1, remains searchable; deleted on miss 2 with printed count", async () => {
    const projDir = join(projectsDir, "p1")
    mkdirSync(projDir, { recursive: true })

    const file = join(projDir, "transient-sess.jsonl")
    writeFileSync(
      file,
      JSON.stringify({ type: "user", message: { uuid: "trans-1", content: "ephemeral message queryable" } }),
      "utf8"
    )

    // Initial indexing
    await rebuildIndex(db, { incremental: true, skipCodex: true })

    const sessInitial = getSession(db, "transient-sess")
    expect(sessInitial).toBeDefined()
    expect(sessInitial?.status).toBe("complete")
    expect(getMessageCount(db, "transient-sess")).toBe(1)

    // Now delete the file from disk (simulate vanished file)
    unlinkSync(file)
    expect(existsSync(file)).toBe(false)

    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: any[]) => {
      logs.push(args.join(" "))
      origLog(...args)
    }

    try {
      // Run 1: First miss!
      await rebuildIndex(db, { incremental: true, skipCodex: true })

      const sessMiss1 = getSession(db, "transient-sess")
      expect(sessMiss1).toBeDefined()
      expect(sessMiss1?.status).toBe("stale-missing")
      // Messages MUST still exist and be searchable on miss 1
      expect(getMessageCount(db, "transient-sess")).toBe(1)
      expect(logs.some((l) => l.includes("pruned: 1"))).toBe(false)

      // Run 2: Second miss!
      await rebuildIndex(db, { incremental: true, skipCodex: true })

      const sessMiss2 = getSession(db, "transient-sess")
      // Completely pruned on miss 2
      expect(sessMiss2).toBeFalsy()
      expect(getMessageCount(db, "transient-sess")).toBe(0)
      expect(logs.some((l) => l.includes("pruned: 1"))).toBe(true)
    } finally {
      console.log = origLog
    }
  })

  test("A8: vanished file that reappears before miss 2 is un-marked and restored to complete", async () => {
    const projDir = join(projectsDir, "p1")
    mkdirSync(projDir, { recursive: true })

    const file = join(projDir, "reappearing-sess.jsonl")
    const content = JSON.stringify({ type: "user", message: { uuid: "reappear-1", text: "I will vanish then return" } })
    writeFileSync(file, content, "utf8")

    // Initial index
    await rebuildIndex(db, { incremental: true, skipCodex: true })
    expect(getSession(db, "reappearing-sess")?.status).toBe("complete")

    // Vanish
    unlinkSync(file)

    // Run 1: Miss 1
    await rebuildIndex(db, { incremental: true, skipCodex: true })
    expect(getSession(db, "reappearing-sess")?.status).toBe("stale-missing")

    // File reappears before Run 2!
    writeFileSync(file, content, "utf8")

    // Run 2: Reappeared!
    await rebuildIndex(db, { incremental: true, skipCodex: true })
    const restored = getSession(db, "reappearing-sess")
    expect(restored).toBeDefined()
    expect(restored?.status).toBe("complete")
  })
})
