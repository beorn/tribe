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

  // --------------------------------------------------------------------------
  // CTO Ruling 2026-09-23: A8 wrong-root pruning prevention & migration
  // --------------------------------------------------------------------------

  test("CTO Ruling 4.1: review2 wrongroot probe — two runs from another CLAUDE_DIR prune nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "cto-wrongroot-"))
    const a = join(root, "claudeA")
    const b = join(root, "claudeB")
    mkdirSync(join(a, "projects", "-p1"), { recursive: true })
    mkdirSync(join(b, "projects"), { recursive: true })
    const file = join(a, "projects", "-p1", "11111111-1111-4111-8111-111111111111.jsonl")
    writeFileSync(
      file,
      JSON.stringify({ type: "user", uuid: "m1", message: { role: "user", content: "kept transcript" } }) + "\n",
      "utf8"
    )
    const probeDb = new Database(join(root, "test.db"))
    initSchema(probeDb)

    const savedEnv = process.env.CLAUDE_DIR
    try {
      process.env.CLAUDE_DIR = a
      await rebuildIndex(probeDb, { incremental: true, skipCodex: true })
      const id = "11111111-1111-4111-8111-111111111111"
      expect(getSession(probeDb, id)?.status).toBe("complete")
      expect(getMessageCount(probeDb, id)).toBe(1)

      process.env.CLAUDE_DIR = b
      for (const _n of [1, 2]) {
        const r = await rebuildIndex(probeDb, { incremental: true, skipCodex: true })
        expect(getSession(probeDb, id)?.status).toBe("complete")
        expect(getMessageCount(probeDb, id)).toBe(1)
        expect(r.pruned).toBe(0)
      }
      expect(existsSync(file)).toBe(true)
    } finally {
      if (savedEnv !== undefined) process.env.CLAUDE_DIR = savedEnv
      else delete process.env.CLAUDE_DIR
      probeDb.close()
      safeRemoveSync(root, { within: tmpdir() })
    }
  })

  test("CTO Ruling 4.2: a relative row is rewritten absolute on the run whose root holds it", async () => {
    const root = mkdtempSync(join(tmpdir(), "cto-migrate-"))
    const claudeDir = join(root, "claude")
    const projDir = join(claudeDir, "projects", "-p1")
    mkdirSync(projDir, { recursive: true })
    const fileName = "22222222-2222-4222-8222-222222222222.jsonl"
    const file = join(projDir, fileName)
    writeFileSync(
      file,
      JSON.stringify({ type: "user", uuid: "m2", message: { role: "user", content: "relative to abs" } }) + "\n",
      "utf8"
    )

    const probeDb = new Database(join(root, "test.db"))
    initSchema(probeDb)

    // Seed a legacy relative row in sessions table
    const id = "22222222-2222-4222-8222-222222222222"
    const relativePath = join("-p1", fileName)
    probeDb
      .prepare(
        "INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(id, "/p1", relativePath, Date.now(), Date.now(), 1, "complete")

    expect(getSession(probeDb, id)?.jsonl_path).toBe(relativePath)

    const savedEnv = process.env.CLAUDE_DIR
    try {
      process.env.CLAUDE_DIR = claudeDir
      await rebuildIndex(probeDb, { incremental: true, skipCodex: true })

      // The relative row must have been rewritten to the absolute path
      const session = getSession(probeDb, id)
      expect(session?.jsonl_path).toBe(file)
      expect(session?.status).toBe("complete")
    } finally {
      if (savedEnv !== undefined) process.env.CLAUDE_DIR = savedEnv
      else delete process.env.CLAUDE_DIR
      probeDb.close()
      safeRemoveSync(root, { within: tmpdir() })
    }
  })

  test("CTO Ruling 4.3: a row missing twice at its own absolute path is pruned", async () => {
    const root = mkdtempSync(join(tmpdir(), "cto-abs-prune-"))
    const claudeDir = join(root, "claude")
    const projDir = join(claudeDir, "projects", "-p1")
    mkdirSync(projDir, { recursive: true })
    const file = join(projDir, "33333333-3333-4333-8333-333333333333.jsonl")
    writeFileSync(
      file,
      JSON.stringify({ type: "user", uuid: "m3", message: { role: "user", content: "will vanish" } }) + "\n",
      "utf8"
    )

    const probeDb = new Database(join(root, "test.db"))
    initSchema(probeDb)

    const savedEnv = process.env.CLAUDE_DIR
    try {
      process.env.CLAUDE_DIR = claudeDir
      await rebuildIndex(probeDb, { incremental: true, skipCodex: true })
      const id = "33333333-3333-4333-8333-333333333333"
      expect(getSession(probeDb, id)?.jsonl_path).toBe(file)
      expect(getSession(probeDb, id)?.status).toBe("complete")

      // Delete the file at its absolute path
      unlinkSync(file)

      // Miss 1: marked stale-missing
      await rebuildIndex(probeDb, { incremental: true, skipCodex: true })
      expect(getSession(probeDb, id)?.status).toBe("stale-missing")

      // Miss 2: pruned
      const r2 = await rebuildIndex(probeDb, { incremental: true, skipCodex: true })
      expect(getSession(probeDb, id)).toBeFalsy()
      expect(r2.pruned).toBe(1)
    } finally {
      if (savedEnv !== undefined) process.env.CLAUDE_DIR = savedEnv
      else delete process.env.CLAUDE_DIR
      probeDb.close()
      safeRemoveSync(root, { within: tmpdir() })
    }
  })

  test("CTO Ruling 4.4: a run above max prune share refuses loudly with the count", async () => {
    const root = mkdtempSync(join(tmpdir(), "cto-share-refuse-"))
    const claudeDir = join(root, "claude")
    const projDir = join(claudeDir, "projects", "-p1")
    mkdirSync(projDir, { recursive: true })

    const probeDb = new Database(join(root, "test.db"))
    initSchema(probeDb)

    // Create 5 sessions
    const files: string[] = []
    for (let i = 1; i <= 5; i++) {
      const f = join(projDir, `sess-00${i}.jsonl`)
      writeFileSync(
        f,
        JSON.stringify({ type: "user", uuid: `u-${i}`, message: { role: "user", content: `msg ${i}` } }) + "\n",
        "utf8"
      )
      files.push(f)
    }

    const savedEnv = process.env.CLAUDE_DIR
    try {
      process.env.CLAUDE_DIR = claudeDir
      await rebuildIndex(probeDb, { incremental: true, skipCodex: true })
      expect(probeDb.prepare("SELECT count(*) as c FROM sessions").get()).toEqual({ c: 5 })

      // Delete 2 of 5 files (40% > 20% max prune share)
      unlinkSync(files[0]!)
      unlinkSync(files[1]!)

      // Miss 1
      await rebuildIndex(probeDb, { incremental: true, skipCodex: true })

      const warnings: string[] = []
      const origWarn = console.warn
      console.warn = (...args: any[]) => {
        warnings.push(args.join(" "))
        origWarn(...args)
      }

      try {
        // Miss 2: would prune 2 sessions (40% > 20%), so belt refuses loudly and prunes 0
        const r2 = await rebuildIndex(probeDb, { incremental: true, skipCodex: true })
        expect(r2.pruned).toBe(0)
        expect(probeDb.prepare("SELECT count(*) as c FROM sessions").get()).toEqual({ c: 5 })
        expect(
          warnings.some((w) => w.includes("2 of 5 sessions") && w.includes("exceed max prune share"))
        ).toBe(true)

        // Now run with allowLargePrune: true — prunes the 2 sessions
        const r3 = await rebuildIndex(probeDb, {
          incremental: true,
          skipCodex: true,
          allowLargePrune: true,
        })
        expect(r3.pruned).toBe(2)
        expect(probeDb.prepare("SELECT count(*) as c FROM sessions").get()).toEqual({ c: 3 })
      } finally {
        console.warn = origWarn
      }
    } finally {
      if (savedEnv !== undefined) process.env.CLAUDE_DIR = savedEnv
      else delete process.env.CLAUDE_DIR
      probeDb.close()
      safeRemoveSync(root, { within: tmpdir() })
    }
  })
})
