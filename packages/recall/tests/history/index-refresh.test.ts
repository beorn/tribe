/** @failure Failed or competing rebuilds publish fresh Recall evidence (23189). */
import { Database } from "bun:sqlite"
import { tryAcquireFlock } from "@bearly/flock"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
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

const { rebuildIndex } = await import("../../src/history/indexer")
const { cmdIndex } = await import("../../src/lib/sessions")
const { ensureProjectSourcesIndexed } = await import("../../src/history/project-sources")
const { closeDb, initSchema, getIndexMeta, setIndexMeta } = await import("../../src/history/db")
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
    await expect(rebuildIndex(db, { incremental: true })).rejects.toThrow("prune failed")
    expect(getIndexMeta(db, "last_rebuild")).toBe("")
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
})
