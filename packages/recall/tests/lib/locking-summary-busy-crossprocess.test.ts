/**
 * @failure Two summary engines run at once on one Recall DB — the real case is two seats' SessionEnd hooks,
 *          reached through a symlink alias path — so two processes write the same daily and cache files.
 * @level l2 — two real bun child processes and a real kernel flock; the engine under test is unmodified.
 * @consumer Recall summarizeDay (the manual / opt-in daily engine)
 * @testonly none
 *
 * The two-real-process row of the 27702 §4 lock contract (@chief 7a748277): spawn a real bun child that occupies
 * the summary-operation lock through the alias, then run the unmodified `summarizeDay` in a second real process
 * over the same alias and require `summary_busy`. The in-process test (locking-summary-busy.test.ts) stays the
 * fast row; this one proves the occupancy crosses an OS process boundary, which no in-process `using` can.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest"

const CHILD = fileURLToPath(new URL("../fixtures/summary-lock-child.ts", import.meta.url))

const DAY = "2026-09-29"
const SESSION_ID = "sess-summary-lock-xproc"
let realDir: string | undefined
let aliasDir = ""
let realDb = ""
let holder: ChildProcess | undefined

function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // The child is a separate process: pin its home and project so the session-summary cache lands inside the
    // fixture instead of the real ~/.claude tree, and drop any ambient LLM backend so the fixture stays offline.
    HOME: realDir,
    CLAUDE_PROJECT_DIR: "/test",
    RECALL_DB_PATH: join(aliasDir, "recall.db"),
    TRIBE_LLM_DIR: "",
  }
}

/** First line a child prints, or a loud failure if it never arrives. */
function firstLine(stream: NodeJS.ReadableStream, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ""
    const timer = setTimeout(
      () => reject(new Error(`${label}: no line within 10s; saw ${JSON.stringify(buffer)}`)),
      10_000,
    )
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      const newline = buffer.indexOf("\n")
      if (newline >= 0) {
        clearTimeout(timer)
        resolve(buffer.slice(0, newline))
      }
    })
    stream.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function runEngine(): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [CHILD, "run", join(aliasDir, "recall.db"), DAY], {
    env: childEnv(),
    encoding: "utf8",
    timeout: 15_000,
  })
}

/** The shape the real engine prints: `summary_busy` when it lost the lock, else the normal skip/content reason. */
function engineResult(stdout: string): { skipped: boolean; reason?: string } {
  return JSON.parse(stdout.trim()) as { skipped: boolean; reason?: string }
}

beforeEach(async () => {
  const { closeDb, getDb } = await import("../../src/history/db.ts")
  closeDb()
  delete process.env.RECALL_DB_PATH
  if (realDir) rmSync(realDir, { recursive: true, force: true })
  realDir = mkdtempSync(join(realpathSync(tmpdir()), "recall-summary-lock-xproc-"))
  aliasDir = `${realDir}-alias`
  rmSync(aliasDir, { recursive: true, force: true })
  // A file-level alias: `aliasDir/recall.db` is a symlink to the real DB file, so the alias path and the real
  // path name different lock files until the engine canonicalises the DB path. That is what makes the
  // canonicalisation rule load-bearing across the two processes, not just the shared inode.
  mkdirSync(aliasDir, { recursive: true })
  realDb = join(realDir, "recall.db")

  const transcriptPath = join(realDir, "session.jsonl")
  // Assistant-only text > 5 KB keeps the session "meaningful" while classifying it as a sub-agent, so the engine
  // reaches the operation and returns before any synthesis/git/beads work.
  writeFileSync(
    transcriptPath,
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: `sub-agent tool chatter ${"z".repeat(6000)}` }] },
    }) + "\n",
    "utf8",
  )

  process.env.RECALL_DB_PATH = realDb
  const db = getDb()
  db.prepare(
    `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SESSION_ID,
    "/test",
    transcriptPath,
    new Date(`${DAY}T12:00:00`).getTime() - 1000,
    new Date(`${DAY}T12:00:00`).getTime(),
    1,
    "fixture",
  )
  closeDb()
  symlinkSync(realDb, join(aliasDir, "recall.db"))
})

afterEach(async () => {
  if (holder) {
    holder.stdin?.end()
    if (holder.exitCode === null && holder.signalCode === null) {
      await once(holder, "exit")
    }
    holder = undefined
  }
  const { closeDb } = await import("../../src/history/db.ts")
  closeDb()
  delete process.env.RECALL_DB_PATH
  if (realDir) rmSync(realDir, { recursive: true, force: true })
  rmSync(aliasDir, { recursive: true, force: true })
  realDir = undefined
})

afterAll(() => {
  delete process.env.RECALL_DB_PATH
})

describe("summary-operation lock across real processes", () => {
  test("a lock held in one process through the alias makes a second process report summary_busy", async () => {
    // The premise: the alias canonicalises to the same DB, so both processes name one lock.
    expect(realpathSync(join(aliasDir, "recall.db"))).toBe(realpathSync(realDb))

    holder = spawn(process.execPath, [CHILD, "hold", join(aliasDir, "recall.db"), DAY], {
      env: childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    })
    expect(await firstLine(holder.stdout!, "holder")).toBe("held")

    // A second real process on the same DB through the same alias must see the lock already owned.
    const busy = runEngine()
    expect(busy.stderr).toBe("")
    expect(busy.status).toBe(0)
    expect(engineResult(busy.stdout)).toMatchObject({ skipped: true, reason: "summary_busy" })
  }, 30_000)

  test("once the holding process exits, the next process runs the operation", async () => {
    holder = spawn(process.execPath, [CHILD, "hold", join(aliasDir, "recall.db"), DAY], {
      env: childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    })
    expect(await firstLine(holder.stdout!, "holder")).toBe("held")

    holder.stdin?.end()
    await once(holder, "exit")
    holder = undefined

    const ran = runEngine()
    expect(ran.stderr).toBe("")
    expect(ran.status).toBe(0)
    expect(engineResult(ran.stdout).reason).not.toBe("summary_busy")
  }, 30_000)
})
