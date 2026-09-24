/** @failure Failed or competing rebuilds publish fresh Recall evidence (23189). */
import { Database } from "bun:sqlite"
import { tryAcquireFlock } from "@bearly/flock"
import { spawn } from "node:child_process"
import { once } from "node:events"
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { safeRemoveSync } from "removely"
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
const { cmdIndex } = await import("../../src/lib/sessions")
const { ensureProjectSourcesIndexed, ProjectSourcesBusyError } = await import("../../src/history/project-sources")
const { closeDb, getDb, initSchema, getIndexMeta, setIndexMeta } = await import("../../src/history/db")
let root: string
let db: Database
let dbPath: string

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "recall-refresh-"))
  corpus.projects = join(root, "projects")
  mkdirSync(corpus.projects)
  corpus.plans = []
  corpus.todos = []
  dbPath = join(root, "index.db")
  db = new Database(dbPath)
  initSchema(db)
  setIndexMeta(db, "last_rebuild", new Date().toISOString())
  vi.stubEnv("RECALL_DB_PATH", dbPath)
  vi.stubEnv("RECALL_SKIP_CODEX", "1")
  vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  closeDb()
  db.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = 0
  safeRemoveSync(root, { within: realpathSync(tmpdir()) })
})

describe("Recall refresh completion", () => {
  test("invalidates prior success before the first corpus mutation can fail", async () => {
    db.exec("CREATE TRIGGER refuse_prune BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'prune failed'); END")
    db.prepare(
      "INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("old", root, "old.jsonl", 1, 1, 1)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(rebuildIndex(db, { incremental: true })).rejects.toThrow("prune failed")
    expect(getIndexMeta(db, "last_rebuild")).toBe("")
    expect(warn.mock.calls.flat().join(" ")).toContain("1 legacy session(s) have relative paths")
  })

  test("a missing required session root cannot become a fresh empty corpus", async () => {
    corpus.projects = join(root, "missing-projects")
    await expect(rebuildIndex(db, { incremental: true })).rejects.toThrow(corpus.projects)
    expect(getIndexMeta(db, "last_rebuild")).toBe("")
  })

  test("an explicitly requested missing project cannot publish success", async () => {
    const missingProject = join(root, "missing-project")
    await expect(rebuildIndex(db, { incremental: true, projectRoot: missingProject })).rejects.toThrow(missingProject)
    expect(getIndexMeta(db, "last_rebuild")).toBe("")
  })

  test.each(["plan", "todo"])("a selected %s read failure cannot publish success", async (kind) => {
    const file = join(root, `missing.${kind === "plan" ? "md" : "json"}`)
    if (kind === "plan") corpus.plans = [file]
    else corpus.todos = [file]
    await expect(rebuildIndex(db, { incremental: true })).rejects.toThrow(file)
    expect(getIndexMeta(db, "last_rebuild")).toBe("")
  })

  test("a malformed selected todo cannot publish success", async () => {
    const file = join(root, "todo.json")
    writeFileSync(file, "invalid JSON")
    corpus.todos = [file]
    await expect(rebuildIndex(db, { incremental: true })).rejects.toThrow(file)
    expect(getIndexMeta(db, "last_rebuild")).toBe("")
  })

  test("completion is published after every other metadata write", async () => {
    db.exec(
      "CREATE TRIGGER refuse_meta BEFORE INSERT ON index_meta WHEN NEW.key = 'total_files' BEGIN SELECT RAISE(ABORT, 'metadata failed'); END",
    )
    await expect(rebuildIndex(db, { incremental: true })).rejects.toThrow("metadata failed")
    expect(getIndexMeta(db, "last_rebuild")).toBe("")
  })

  test("an empty existing corpus succeeds after an earlier failed attempt", async () => {
    setIndexMeta(db, "last_rebuild", "")
    const result = await rebuildIndex(db, { incremental: true })
    expect(result.files).toBe(0)
    expect(Number.isFinite(Date.parse(getIndexMeta(db, "last_rebuild")!))).toBe(true)
  })

  test("competing full/project requests report contention without mutating the index", async () => {
    const marker = getIndexMeta(db, "last_rebuild")
    using lock = tryAcquireFlock(`${realpathSync(dbPath)}.rebuild.lock`, {
      body: JSON.stringify({ startedAt: Date.now() }),
    })
    expect(lock).not.toBeNull()
    const out = vi.spyOn(console, "log").mockImplementation(() => {})
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    await cmdIndex({ projectRoot: root })
    expect(process.exitCode).toBe(4)
    expect(err.mock.calls.flat().join(" ")).toContain("already active")
    expect(out).not.toHaveBeenCalled()
    expect(getIndexMeta(db, "last_rebuild")).toBe(marker)
  })

  test("a database symlink cannot bypass a competing writer", async () => {
    const alias = join(root, "alias.db")
    symlinkSync(dbPath, alias)
    vi.stubEnv("RECALL_DB_PATH", alias)
    using lock = tryAcquireFlock(`${realpathSync(dbPath)}.rebuild.lock`, {
      body: JSON.stringify({ startedAt: Date.now() }),
    })
    expect(lock).not.toBeNull()
    vi.spyOn(console, "error").mockImplementation(() => {})
    await cmdIndex({ incremental: true })
    expect(process.exitCode).toBe(4)
  })

  test("the exported project-source helper cannot bypass the active writer", () => {
    vi.stubEnv("CLAUDE_PROJECT_DIR", root)
    const marker = getIndexMeta(db, "last_rebuild")
    using lock = tryAcquireFlock(`${realpathSync(dbPath)}.rebuild.lock`, {
      body: JSON.stringify({ startedAt: Date.now() }),
    })
    expect(lock).not.toBeNull()
    expect(() => ensureProjectSourcesIndexed()).toThrow("already active")
    expect(getIndexMeta(db, "last_rebuild")).toBe(marker)
  })

  test("the project-source helper never waits on another connection's write lock (25071)", () => {
    vi.stubEnv("CLAUDE_PROJECT_DIR", root)
    getDb() // opened (WAL, schema) before the lock, as the live DB always is
    const marker = getIndexMeta(db, "last_rebuild")
    const holder = new Database(dbPath)
    holder.run("BEGIN IMMEDIATE")
    try {
      const start = performance.now()
      expect(() => ensureProjectSourcesIndexed()).toThrow(ProjectSourcesBusyError)
      expect(performance.now() - start).toBeLessThan(1000)
    } finally {
      holder.run("ROLLBACK")
      holder.close()
    }
    expect(getIndexMeta(db, "last_rebuild")).toBe(marker)
  })

  test("a project-source-only refresh retains the older session completion timestamp", () => {
    vi.stubEnv("CLAUDE_PROJECT_DIR", root)
    const marker = new Date(Date.now() - 60 * 60_000).toISOString()
    setIndexMeta(db, "last_rebuild", marker)
    ensureProjectSourcesIndexed()
    expect(getIndexMeta(db, "last_rebuild")).toBe(marker)
  })

  test("the actual CLI preserves the contention exit without running a second index", async () => {
    using lock = tryAcquireFlock(`${realpathSync(dbPath)}.rebuild.lock`, {
      body: JSON.stringify({ startedAt: Date.now() }),
    })
    expect(lock).not.toBeNull()
    const child = Bun.spawn(
      [process.execPath, fileURLToPath(new URL("../../src/cli.ts", import.meta.url)), "index", "--incremental"],
      { env: { ...process.env, RECALL_DB_PATH: dbPath }, stdout: "pipe", stderr: "pipe" },
    )
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(exit).toBe(4)
    expect(stdout).toBe("")
    expect(stderr).toContain("already active")
  })

  test("a failed index command releases its writer lock for a later attempt", async () => {
    const source = corpus.projects
    corpus.projects = join(root, "missing-projects")
    await expect(cmdIndex({ incremental: true })).rejects.toThrow(corpus.projects)
    expect(getIndexMeta(db, "last_rebuild")).toBe("")
    corpus.projects = source
    await cmdIndex({ incremental: true })
    expect(Number.isFinite(Date.parse(getIndexMeta(db, "last_rebuild")!))).toBe(true)
  })

  test("a writer exceeding the refresh budget is a failure, not endless reported contention", async () => {
    using lock = tryAcquireFlock(`${realpathSync(dbPath)}.rebuild.lock`, {
      body: JSON.stringify({ startedAt: Date.now() - 11 * 60_000 }),
    })
    expect(lock).not.toBeNull()
    await expect(cmdIndex({ incremental: true })).rejects.toThrow("exceeded")
    expect(process.exitCode).not.toBe(4)
  })

  test("SIGKILL releases a held writer without restoring its invalidated completion marker", async () => {
    // Exercise the kernel/SQLite boundary in a separate process. The tests
    // above prove the indexer performs this invalidation before corpus writes.
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      import { Database } from "bun:sqlite";
      import { tryAcquireFlock } from "@bearly/flock";
      import { realpathSync } from "node:fs";
      const file = process.argv.at(-1);
      using lock = tryAcquireFlock(realpathSync(file) + ".rebuild.lock", { body: JSON.stringify({ startedAt: Date.now() }) });
      if (!lock) throw new Error("fixture writer could not acquire lock");
      const db = new Database(file);
      db.query("UPDATE index_meta SET value = '' WHERE key = 'last_rebuild'").run();
      db.close();
      console.log("invalidated-and-held");
      await new Promise(() => {});
    `,
        dbPath,
      ],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    let stderr = ""
    child.stderr!.on("data", (chunk) => {
      stderr += String(chunk)
    })
    // close waits for stderr to drain as well as for the child to be reaped.
    const exited = once(child, "close")
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => {
        reject(new Error(`fixture writer exceeded 2000ms; stderr: ${stderr || "<empty>"}`))
      }, 2000)
    })
    try {
      const [chunk] = await Promise.race([
        once(child.stdout!, "data"),
        exited.then(([code, signal]) => {
          throw new Error(
            `fixture writer exited before holding its lock (code=${code}, signal=${signal}); stderr: ${stderr || "<empty>"}`,
          )
        }),
        deadline,
      ])
      expect(String(chunk)).toContain("invalidated-and-held")
      expect(tryAcquireFlock(`${realpathSync(dbPath)}.rebuild.lock`)).toBeNull()
      child.kill("SIGKILL")
      expect(await Promise.race([exited, deadline])).toEqual([null, "SIGKILL"])
      expect(getIndexMeta(db, "last_rebuild")).toBe("")
      await cmdIndex({ incremental: true })
      expect(Number.isFinite(Date.parse(getIndexMeta(db, "last_rebuild")!))).toBe(true)
    } finally {
      clearTimeout(deadlineTimer)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            cleanupTimer = setTimeout(() => {
              reject(
                new Error(`fixture writer was not reaped within 1000ms after SIGKILL; stderr: ${stderr || "<empty>"}`),
              )
            }, 1000)
          }),
        ])
      } finally {
        clearTimeout(cleanupTimer)
      }
    }
  })

  test("incremental index skips unchanged session even when mtime is later than event timestamps", async () => {
    const projectDir = join(corpus.projects, "test-proj")
    mkdirSync(projectDir, { recursive: true })
    const sessionFile = join(projectDir, "sess-1.jsonl")
    const eventTime = new Date("2026-08-01T12:00:00.000Z").toISOString()
    const content =
      JSON.stringify({
        sessionId: "sess-1",
        type: "user",
        message: { content: "Hello world" },
        timestamp: eventTime,
      }) + "\n"
    writeFileSync(sessionFile, content)

    // First index pass
    const run1 = await indexSessionFile(db, sessionFile, { incremental: true })
    expect(run1.messages).toBe(1)

    const sessionRow = db.query("SELECT * FROM sessions WHERE id = 'sess-1'").get() as any
    expect(sessionRow).toBeDefined()
    expect(sessionRow.updated_at).toBe(new Date(eventTime).getTime())
    expect(sessionRow.mtime_ms).toBeGreaterThan(0)
    expect(sessionRow.size_bytes).toBe(Buffer.byteLength(content))

    // Second incremental pass on unchanged file: must skip re-indexing
    const run2 = await indexSessionFile(db, sessionFile, { incremental: true })
    expect(run2.messages).toBe(0)
    expect(run2.writes).toBe(0)
  })

  test("legacy row with future event timestamp reindexes once to populate mtime_ms and size_bytes", async () => {
    const projectDir = join(corpus.projects, "test-proj")
    mkdirSync(projectDir, { recursive: true })
    const sessionFile = join(projectDir, "sess-future.jsonl")
    const pastTime = new Date("2026-07-01T12:00:00.000Z").toISOString()
    const content =
      JSON.stringify({
        sessionId: "sess-future",
        type: "user",
        message: { content: "Future event content" },
        timestamp: pastTime,
      }) + "\n"
    writeFileSync(sessionFile, content)

    const st = statSync(sessionFile)
    const mtime = st.mtime.getTime()

    // Insert legacy row with updated_at in the FUTURE compared to mtime, but mtime_ms and size_bytes null
    db.prepare(`
      INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, mtime_ms, size_bytes)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run("sess-future", "test-proj", "test-proj/sess-future.jsonl", mtime + 50000, mtime + 100000, 1)

    // Incremental pass: must NOT skip because mtime_ms and size_bytes are null
    const run = await indexSessionFile(db, sessionFile, { incremental: true })
    expect(run.messages).toBe(1)

    // Check that legacy row was rewritten with exact mtime_ms and size_bytes, semantic event timestamps intact
    const row = db.query("SELECT * FROM sessions WHERE id = 'sess-future'").get() as any
    expect(row).toBeDefined()
    expect(row.mtime_ms).toBe(mtime)
    expect(row.size_bytes).toBe(Buffer.byteLength(content))
    expect(row.updated_at).toBe(new Date(pastTime).getTime())

    // Subsequent pass: now both present and equal -> skips
    const runSubsequent = await indexSessionFile(db, sessionFile, { incremental: true })
    expect(runSubsequent.messages).toBe(0)
  })

  test("legacy row with null size_bytes reindexes once even if mtime_ms matches", async () => {
    const projectDir = join(corpus.projects, "test-proj")
    mkdirSync(projectDir, { recursive: true })
    const sessionFile = join(projectDir, "sess-null-size.jsonl")
    const content =
      JSON.stringify({
        sessionId: "sess-null-size",
        type: "user",
        message: { content: "Null size content" },
        timestamp: new Date().toISOString(),
      }) + "\n"
    writeFileSync(sessionFile, content)

    const st = statSync(sessionFile)
    const mtime = st.mtime.getTime()

    // Insert legacy row where mtime_ms is set, but size_bytes is NULL
    db.prepare(`
      INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, mtime_ms, size_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run("sess-null-size", "test-proj", "test-proj/sess-null-size.jsonl", mtime, mtime, 1, mtime)

    // Incremental pass: must reindex because size_bytes is null
    const run = await indexSessionFile(db, sessionFile, { incremental: true })
    expect(run.messages).toBe(1)

    const row = db.query("SELECT * FROM sessions WHERE id = 'sess-null-size'").get() as any
    expect(row.mtime_ms).toBe(mtime)
    expect(row.size_bytes).toBe(Buffer.byteLength(content))

    // Subsequent pass skips
    const run2 = await indexSessionFile(db, sessionFile, { incremental: true })
    expect(run2.messages).toBe(0)
  })

  test("session reindexes when file size changed even if mtime is unchanged", async () => {
    const projectDir = join(corpus.projects, "test-proj")
    mkdirSync(projectDir, { recursive: true })
    const sessionFile = join(projectDir, "sess-same-mtime.jsonl")
    const line1 =
      JSON.stringify({
        sessionId: "sess-same-mtime",
        type: "user",
        message: { content: "First message" },
        timestamp: new Date().toISOString(),
      }) + "\n"
    writeFileSync(sessionFile, line1)

    // First index pass
    const run1 = await indexSessionFile(db, sessionFile, { incremental: true })
    expect(run1.messages).toBe(1)

    const row1 = db.query("SELECT * FROM sessions WHERE id = 'sess-same-mtime'").get() as any
    const originalMtime = row1.mtime_ms

    // Modify file (append line) but restore original mtime via utimesSync
    const line2 =
      JSON.stringify({
        sessionId: "sess-same-mtime",
        type: "user",
        message: { content: "Second message added" },
        timestamp: new Date().toISOString(),
      }) + "\n"
    writeFileSync(sessionFile, line1 + line2)
    utimesSync(sessionFile, originalMtime / 1000, originalMtime / 1000)

    // Incremental pass: mtime matches, but size_bytes has changed -> MUST reindex
    const run2 = await indexSessionFile(db, sessionFile, { incremental: true })
    expect(run2.messages).toBe(2)

    const row2 = db.query("SELECT * FROM sessions WHERE id = 'sess-same-mtime'").get() as any
    expect(row2.mtime_ms).toBe(originalMtime)
    expect(row2.size_bytes).toBe(Buffer.byteLength(line1 + line2))

    // Subsequent pass: now size_bytes matches -> skips
    const run3 = await indexSessionFile(db, sessionFile, { incremental: true })
    expect(run3.messages).toBe(0)
  })

  test("incremental index with Claude parent session and subagents re-parses 0 files when unchanged and preserves all messages", async () => {
    const projectDir = join(corpus.projects, "test-parent-subagent")
    const subagentsDir = join(projectDir, "parent-sess", "subagents")
    mkdirSync(subagentsDir, { recursive: true })

    const parentFile = join(projectDir, "parent-sess.jsonl")
    const subagentFile = join(subagentsDir, "agent-sub1.jsonl")

    const parentContent =
      JSON.stringify({
        sessionId: "parent-sess",
        type: "user",
        message: { content: "parent user question" },
        timestamp: "2026-08-01T12:00:00.000Z",
      }) +
      "\n" +
      JSON.stringify({
        sessionId: "parent-sess",
        type: "assistant",
        message: { content: "parent assistant reply" },
        timestamp: "2026-08-01T12:00:05.000Z",
      }) +
      "\n"

    // In Claude Code, subagent transcripts have record.sessionId set to the parent session id
    const subagentContent =
      JSON.stringify({
        sessionId: "parent-sess",
        type: "user",
        message: { content: "subagent instructions" },
        timestamp: "2026-08-01T12:00:10.000Z",
      }) +
      "\n" +
      JSON.stringify({
        sessionId: "parent-sess",
        type: "assistant",
        message: { content: "subagent finished task" },
        timestamp: "2026-08-01T12:00:15.000Z",
      }) +
      "\n"

    writeFileSync(parentFile, parentContent)
    writeFileSync(subagentFile, subagentContent)

    // First rebuild: indexes both files
    const run1 = await rebuildIndex(db, { incremental: true })
    expect(run1.messages).toBe(4)

    // Verify both files have distinct entries in sessions table
    const parentRow = db.query("SELECT * FROM sessions WHERE jsonl_path LIKE '%parent-sess.jsonl'").get() as any
    const subagentRow = db.query("SELECT * FROM sessions WHERE jsonl_path LIKE '%agent-sub1.jsonl'").get() as any
    expect(parentRow).toBeDefined()
    expect(subagentRow).toBeDefined()
    expect(parentRow.jsonl_path).not.toBe(subagentRow.jsonl_path)
    expect(parentRow.id).not.toBe(subagentRow.id)

    // Verify total messages in database is 4
    const totalMessages1 = (db.query("SELECT COUNT(*) as c FROM messages").get() as any).c
    expect(totalMessages1).toBe(4)

    // Second incremental pass: files are unchanged, MUST index 0 messages
    const run2 = await rebuildIndex(db, { incremental: true })
    expect(run2.messages).toBe(0)

    // Total messages must still be 4 (neither parent nor subagent wiped out)
    const totalMessages2 = (db.query("SELECT COUNT(*) as c FROM messages").get() as any).c
    expect(totalMessages2).toBe(4)
  })

  /** @failure The share-cap refusal was a console.warn with exit 0, so the unattended recall-index service never saw it (25462). */
  test("an incremental index that refuses a prune over the share cap exits non-zero and says why", async () => {
    const projectDir = join(corpus.projects, "p1")
    mkdirSync(projectDir, { recursive: true })
    const files = [1, 2, 3, 4, 5].map((i) => {
      const file = join(projectDir, `sess-00${i}.jsonl`)
      writeFileSync(
        file,
        JSON.stringify({ type: "user", uuid: `u-${i}`, message: { role: "user", content: `msg ${i}` } }) + "\n",
      )
      return file
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    await cmdIndex({ incremental: true })
    expect(process.exitCode).toBe(0)
    unlinkSync(files[0]!)
    unlinkSync(files[1]!)
    await cmdIndex({ incremental: true }) // miss 1 marks them stale-missing
    await cmdIndex({ incremental: true }) // miss 2 would prune 2 of 5 (40% > 20%)
    expect(process.exitCode).toBe(5)
    const said = [...warn.mock.calls, ...err.mock.calls].flat().join(" ")
    expect(said).toContain("Refusing to prune 2 of 5 sessions")
    expect(said.match(/refus\w* to prune/gi)).toHaveLength(1)
  })

  test("a session file that vanishes mid-run (ENOENT on stat) is skipped without killing rebuildIndex", async () => {
    const projectDir = join(corpus.projects, "test-vanished")
    mkdirSync(projectDir, { recursive: true })

    const firstFile = join(projectDir, "00-first.jsonl")
    const vanishingFile = join(projectDir, "01-vanishing.jsonl")
    const stableFile = join(projectDir, "02-stable.jsonl")

    writeFileSync(
      firstFile,
      JSON.stringify({
        sessionId: "00-first",
        type: "user",
        message: { content: "first message" },
        timestamp: new Date().toISOString(),
      }) + "\n",
    )

    writeFileSync(
      vanishingFile,
      JSON.stringify({
        sessionId: "01-vanishing",
        type: "user",
        message: { content: "vanishing message" },
        timestamp: new Date().toISOString(),
      }) + "\n",
    )

    writeFileSync(
      stableFile,
      JSON.stringify({
        sessionId: "02-stable",
        type: "user",
        message: { content: "stable message" },
        timestamp: new Date().toISOString(),
      }) + "\n",
    )

    const fs = await import("node:fs")

    // rebuildIndex must NOT throw when 01-vanishing.jsonl disappears mid-run;
    // it must skip the vanished file and successfully index 00-first and 02-stable
    const result = await rebuildIndex(db, {
      incremental: true,
      onProgress: (p) => {
        if (p.currentFile.includes("02-stable.jsonl") && fs.existsSync(vanishingFile)) {
          fs.unlinkSync(vanishingFile)
        }
      },
    })
    expect(result.messages).toBe(2)

    const firstRow = db.query("SELECT * FROM sessions WHERE jsonl_path LIKE '%00-first.jsonl'").get() as any
    const stableRow = db.query("SELECT * FROM sessions WHERE jsonl_path LIKE '%02-stable.jsonl'").get() as any
    expect(firstRow).toBeDefined()
    expect(stableRow).toBeDefined()
    expect(firstRow.message_count).toBe(1)
    expect(stableRow.message_count).toBe(1)
  })
})
