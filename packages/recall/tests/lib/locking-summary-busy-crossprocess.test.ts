/**
 * @failure Two summary engines run at once on one Recall DB — the real case is two seats' SessionEnd
 *          hooks, reached through a symlink alias path — so two processes write the same daily and cache
 *          files, and a lock released before the operation settles lets both run.
 * @level l2 — two real bun child processes running the unmodified engine, a real kernel flock, and a real
 *              on-disk DB reached through a file-level symlink alias.
 * @consumer Recall summarizeDay (the manual / opt-in daily engine)
 * @testonly none
 *
 * The two-real-process row of the 27702 §4 lock contract (@chief 7a748277; @dev/review2 revise): a first real
 * process runs the engine and holds the lock, and a second real process on the same DB through the same alias
 * reports summary_busy; terminating the runner releases the fd lock for the next process.
 * SCOPE OF THIS ROW (measured, @dev/review2 1180059): it proves adoption, alias canonicalisation and
 * crash-release — NOT the early-return ordering. The engine's expensive work sits in a SYNCHRONOUS prefix with
 * no await before it, so a lock released at the return statement is still held for that whole prefix and a peer
 * process observes it anyway; this row therefore does NOT fail against that defect and must not claim to. The
 * ORDERING regression is the in-process settlement row (locking-summary-busy.test.ts), whose contender is
 * refused only while the lock is held past the returned promise settling.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { tryAcquireFlock, isFlockHeld } from "@bearly/flock"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest"

const CHILD = fileURLToPath(new URL("../fixtures/summary-lock-child.ts", import.meta.url))

const DAY = "2026-09-29"
/** Sessions in the day: enough that the running engine holds the lock long enough for the parent to observe
 *  it and fire the pre-booted contender, with a wide margin over process-scheduling jitter. */
const SESSION_COUNT = 200
let realDir: string | undefined
let aliasDir = ""
let realDb = ""
const live: ChildProcess[] = []

/** A stdout line source that queues lines and lets a caller await the next one. */
function lineReader(stream: NodeJS.ReadableStream) {
  let buffer = ""
  const queued: string[] = []
  const waiters: Array<(line: string) => void> = []
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8")
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      const waiter = waiters.shift()
      if (waiter) waiter(line)
      else queued.push(line)
    }
  })
  return {
    next(timeoutMs: number, label: string): Promise<string> {
      const queuedLine = queued.shift()
      if (queuedLine !== undefined) return Promise.resolve(queuedLine)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label}: no stdout line within ${timeoutMs}ms`)), timeoutMs)
        waiters.push((line) => {
          clearTimeout(timer)
          resolve(line)
        })
      })
    },
  }
}

function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // The children are separate processes: pin their home and project so any cache stays inside the fixture,
    // and drop any ambient LLM backend so the fixture stays offline.
    HOME: realDir,
    CLAUDE_PROJECT_DIR: "/test",
    RECALL_DB_PATH: join(aliasDir, "recall.db"),
    TRIBE_LLM_DIR: "",
  }
}

/** Spawn a parked engine child and wait until it has imported and is ready for "go". */
async function spawnEngine(): Promise<{ child: ChildProcess; reader: ReturnType<typeof lineReader> }> {
  const child = spawn(process.execPath, [CHILD, join(aliasDir, "recall.db"), DAY], {
    env: childEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  })
  live.push(child)
  const reader = lineReader(child.stdout!)
  const ready = await reader.next(20_000, "engine")
  if (ready !== "ready") throw new Error(`engine child not ready: ${JSON.stringify(ready)}`)
  return { child, reader }
}

/** The canonical lock path both the engine and the alias converge on. */
function lockPath(): string {
  return `${realpathSync(join(aliasDir, "recall.db"))}.summary.lock`
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`${label}: condition not met within ${timeoutMs}ms`)
}

function engineResult(line: string): { skipped: boolean; reason?: string } {
  return JSON.parse(line.trim()) as { skipped: boolean; reason?: string }
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
  // path name different lock files until the engine canonicalises the DB path — the rule this row pins.
  mkdirSync(aliasDir, { recursive: true })
  realDb = join(realDir, "recall.db")

  process.env.RECALL_DB_PATH = realDb
  const db = getDb()
  const insert = db.prepare(
    `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const dayStart = new Date(`${DAY}T12:00:00`).getTime()
  for (let i = 0; i < SESSION_COUNT; i++) {
    const transcriptPath = join(realDir, `session-${i}.jsonl`)
    // Assistant-only text > 5 KB keeps each session "meaningful" while classifying it as a sub-agent, so the
    // engine reaches the operation and returns before any synthesis/git/beads work — the lock window is the scan.
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: `sub-agent tool chatter ${"z".repeat(6000)}` }] },
      }) + "\n",
      "utf8",
    )
    insert.run(`sess-${i}`, "/test", transcriptPath, dayStart - 1000, dayStart + i, 1, "fixture")
  }
  closeDb()
  symlinkSync(realDb, join(aliasDir, "recall.db"))
})

afterEach(async () => {
  for (const child of live.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL")
      await once(child, "exit").catch(() => {})
    }
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
  test("one real process runs while a second, on the same DB through the alias, reports summary_busy", async () => {
    // The premise: the alias canonicalises to the same DB, so both processes name one lock.
    expect(realpathSync(join(aliasDir, "recall.db"))).toBe(realpathSync(realDb))

    const runner = await spawnEngine()
    const contender = await spawnEngine()

    runner.child.stdin!.write("go\n")
    // The runner must be holding the lock while its operation is in flight — the window the defect closes.
    await waitFor(() => isFlockHeld(lockPath()), 15_000, "runner holds the summary lock")
    contender.child.stdin!.write("go\n")

    const contenderResult = engineResult(await contender.reader.next(30_000, "contender"))
    const runnerResult = engineResult(await runner.reader.next(60_000, "runner"))

    expect(contenderResult).toMatchObject({ skipped: true, reason: "summary_busy" })
    expect(runnerResult.reason).not.toBe("summary_busy")
  }, 90_000)

  test("terminating the active engine releases the fd lock for the next process", async () => {
    const runner = await spawnEngine()
    runner.child.stdin!.write("go\n")
    await waitFor(() => isFlockHeld(lockPath()), 15_000, "runner holds the summary lock")

    runner.child.kill("SIGKILL")
    await once(runner.child, "exit")
    await waitFor(() => !isFlockHeld(lockPath()), 5000, "kernel released the killed holder's lock")

    const next = await spawnEngine()
    next.child.stdin!.write("go\n")
    const nextResult = engineResult(await next.reader.next(60_000, "next"))
    expect(nextResult.reason).not.toBe("summary_busy")
  }, 90_000)
})

describe("the lock primitive the engine uses", () => {
  test("a real second holder is refused while the runner holds the alias lock", async () => {
    const runner = await spawnEngine()
    runner.child.stdin!.write("go\n")
    await waitFor(() => isFlockHeld(lockPath()), 15_000, "runner holds the summary lock")
    using stolen = tryAcquireFlock(lockPath(), { body: JSON.stringify({ probe: "review2-shape" }) })
    expect(stolen).toBeNull()
  }, 90_000)
})
