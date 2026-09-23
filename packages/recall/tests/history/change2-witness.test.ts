import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { Database } from "bun:sqlite"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { initSchema } from "../../src/history/db-schema.ts"
import { closeDb } from "../../src/history/db.ts"
import { rebuildIndex } from "../../src/history/indexer.ts"
import { getSession, ftsSearch, getCachedStatement } from "../../src/history/db-queries.ts"
import { cmdIndex } from "../../src/lib/sessions.ts"

describe("Change 2 Witness Tests (CTO Ruling 2026-09-22: A7 & A8)", () => {
  let tmpDir: string
  let projectsDir: string
  let dbPath: string
  let origClaudeDir: string | undefined
  let origSkipCodex: string | undefined

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "change2-witness-"))
    projectsDir = path.join(tmpDir, "projects")
    fs.mkdirSync(projectsDir, { recursive: true })
    dbPath = path.join(tmpDir, "test-session-index.db")
    origClaudeDir = process.env.CLAUDE_DIR
    origSkipCodex = process.env.RECALL_SKIP_CODEX
    process.env.CLAUDE_DIR = tmpDir
  })

  afterEach(() => {
    closeDb()
    if (origClaudeDir !== undefined) {
      process.env.CLAUDE_DIR = origClaudeDir
    } else {
      delete process.env.CLAUDE_DIR
    }
    if (origSkipCodex !== undefined) {
      process.env.RECALL_SKIP_CODEX = origSkipCodex
    } else {
      delete process.env.RECALL_SKIP_CODEX
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  })

  test("A7: chunked transactions move data_version once per chunk, only malformed file rolls back", async () => {
    const projDir = path.join(projectsDir, "test-proj")
    fs.mkdirSync(projDir, { recursive: true })

    // Create 100 fixture files: session-001 through session-100
    // File 42 is malformed (invalid JSON on line 2)
    const malformedId = "session-042"
    for (let i = 1; i <= 100; i++) {
      const id = `session-${String(i).padStart(3, "0")}`
      const file = path.join(projDir, `${id}.jsonl`)
      if (id === malformedId) {
        fs.writeFileSync(
          file,
          [
            JSON.stringify({ type: "user", message: { content: `User message for ${id}` } }),
            `{ bad json line !! not valid json`,
          ].join("\n") + "\n",
        )
      } else {
        fs.writeFileSync(
          file,
          [
            JSON.stringify({ type: "user", message: { content: `User prompt in ${id}` } }),
            JSON.stringify({ type: "assistant", message: { content: `Assistant answer in ${id}` } }),
          ].join("\n") + "\n",
        )
      }
    }

    const db = new Database(dbPath)
    db.run("PRAGMA journal_mode = WAL")
    db.run("PRAGMA synchronous = NORMAL")
    initSchema(db)

    // Open a second independent connection to observe PRAGMA data_version
    const db2 = new Database(dbPath)
    const getDv = () => (db2.prepare("PRAGMA data_version").get() as { data_version: number }).data_version

    const initialDv = getDv()
    const observedDataVersions = new Set<number>()

    // Run indexing with chunkSize: 25 (expecting ~4-5 chunk commits for 100 files, NOT 100)
    await rebuildIndex(db, {
      skipCodex: true,
      chunkSize: 25,
      onProgress: () => {
        observedDataVersions.add(getDv())
      },
    })

    const finalDv = getDv()
    observedDataVersions.add(finalDv)

    // Verify data_version moved once per chunk (approx 4 chunks), NOT 100 times
    const dvSteps = finalDv - initialDv
    expect(dvSteps).toBeGreaterThanOrEqual(2)
    expect(dvSteps).toBeLessThanOrEqual(8) // Far below 100 per-file commits

    // Verify failure isolation: ONLY the malformed file rolled back
    const malformedSession = getSession(db, malformedId)
    expect(malformedSession).toBeDefined()
    expect(["unreadable", "stale-unreadable"]).toContain(malformedSession?.status ?? "")

    const malformedMsgs = db.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ?").get(malformedId) as {
      c: number
    }
    expect(malformedMsgs.c).toBe(0) // 0 messages committed for malformed file!

    // Verify all 99 other files succeeded and committed their messages
    const completeSessions = db
      .prepare("SELECT COUNT(*) as c FROM sessions WHERE status = 'complete'")
      .get() as { c: number }
    expect(completeSessions.c).toBe(99)

    const totalMessages = db.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }
    expect(totalMessages.c).toBe(99 * 2) // Each valid file had 2 messages

    db.close()
    db2.close()
  })

  test("A7: getCachedStatement hoists prepared statements across queries", () => {
    const db = new Database(":memory:")
    db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")

    const stmt1 = getCachedStatement(db, "INSERT INTO t (name) VALUES (?)")
    const stmt2 = getCachedStatement(db, "INSERT INTO t (name) VALUES (?)")
    expect(stmt1).toBe(stmt2) // Exact same prepared statement object!

    stmt1.run("alpha")
    stmt2.run("beta")

    const rows = db.prepare("SELECT name FROM t ORDER BY id").all() as { name: string }[]
    expect(rows).toEqual([{ name: "alpha" }, { name: "beta" }])
    db.close()
  })

  test("A8: safe pruning of vanished files (marked stale-missing on run 1, pruned on run 2)", async () => {
    const projDir = path.join(projectsDir, "test-proj")
    fs.mkdirSync(projDir, { recursive: true })

    const sessionFile = path.join(projDir, "session-vanish.jsonl")
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "user",
          message: { content: "Unique secret search phrase for vanished file testing 48291" },
        }),
        JSON.stringify({ type: "assistant", message: { content: "Here is the response" } }),
      ].join("\n") + "\n",
    )

    const db = new Database(dbPath)
    db.run("PRAGMA journal_mode = WAL")
    db.run("PRAGMA synchronous = NORMAL")
    initSchema(db)

    // Run 0: Initial indexing
    await rebuildIndex(db, { skipCodex: true })

    const s0 = getSession(db, "session-vanish")
    expect(s0).toBeDefined()
    expect(s0?.status).toBe("complete")

    const search0 = ftsSearch(db, "48291")
    expect(search0.results.length).toBe(1)
    expect(search0.results[0].session_id).toBe("session-vanish")

    // Delete the file from disk
    fs.unlinkSync(sessionFile)

    // Run 1: First miss -> marked stale-missing, stays searchable, pruned count = 0
    const res1 = await rebuildIndex(db, { skipCodex: true, incremental: true })
    expect(res1.pruned).toBe(0)

    const s1 = getSession(db, "session-vanish")
    expect(s1).toBeDefined()
    expect(s1?.status).toBe("stale-missing") // Marked stale-missing!

    // Search STILL finds it on first miss!
    const search1 = ftsSearch(db, "48291")
    expect(search1.results.length).toBe(1)
    expect(search1.results[0].session_id).toBe("session-vanish")

    // Run 2: Second consecutive miss -> deleted, pruned count = 1
    const res2 = await rebuildIndex(db, { skipCodex: true, incremental: true })
    expect(res2.pruned).toBe(1) // Pruned count 1!

    const s2 = getSession(db, "session-vanish")
    expect(s2).toBeNull() // Row deleted from sessions table!

    // Search no longer finds it after pruning
    const search2 = ftsSearch(db, "48291")
    expect(search2.results.length).toBe(0)

    db.close()
  })

  test("A8: reappearing file clears stale-missing and recovers to complete", async () => {
    const projDir = path.join(projectsDir, "test-proj")
    fs.mkdirSync(projDir, { recursive: true })

    const sessionFile = path.join(projDir, "session-recover.jsonl")
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({ type: "user", message: { content: "Recovery test message" } }) + "\n",
    )

    const db = new Database(dbPath)
    db.run("PRAGMA journal_mode = WAL")
    db.run("PRAGMA synchronous = NORMAL")
    initSchema(db)

    // Initial indexing
    await rebuildIndex(db, { skipCodex: true })
    expect(getSession(db, "session-recover")?.status).toBe("complete")

    // Delete file
    fs.unlinkSync(sessionFile)

    // Run 1: marks stale-missing
    await rebuildIndex(db, { skipCodex: true, incremental: true })
    expect(getSession(db, "session-recover")?.status).toBe("stale-missing")

    // Re-create the file before Run 2
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({ type: "user", message: { content: "Restored user message" } }) + "\n",
    )

    // Run 2: file found, re-indexed, status restored to complete
    const res = await rebuildIndex(db, { skipCodex: true, incremental: true })
    expect(res.pruned).toBe(0)
    expect(getSession(db, "session-recover")?.status).toBe("complete")

    db.close()
  })

  test("A8: cmdIndex prints (pruned: N) when pruned > 0", async () => {
    const projDir = path.join(projectsDir, "test-proj")
    fs.mkdirSync(projDir, { recursive: true })

    const sessionFile = path.join(projDir, "session-log.jsonl")
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({ type: "user", message: { content: "Test log pruned message" } }) + "\n",
    )

    process.env.RECALL_DB_PATH = dbPath
    process.env.RECALL_SKIP_CODEX = "1"
    closeDb()
    try {
      // Run 0: Index file
      await cmdIndex({})

      // Delete file
      fs.unlinkSync(sessionFile)

      // Run 1: First miss (marks stale-missing)
      await cmdIndex({ incremental: true })

      // Run 2: Second miss (prunes and logs)
      const logs: string[] = []
      const origLog = console.log
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "))
        origLog(...args)
      }

      try {
        await cmdIndex({ incremental: true })
      } finally {
        console.log = origLog
      }

      const prunedLog = logs.find((l) => l.includes("pruned: 1"))
      expect(prunedLog).toBeDefined()
    } finally {
      closeDb()
      delete process.env.RECALL_DB_PATH
    }
  })
})
