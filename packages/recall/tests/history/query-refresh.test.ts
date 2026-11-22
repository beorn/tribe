/**
 * A query reads its own roots' newer transcripts before it answers (37777, @cto a78c4127).
 *
 * @failure  The 4 h index timer left a query answering from an index older than the session that asked it, and a
 *           pass cut short by its time cap answered a partial result as if it were complete.
 * @level    l2 — drives the real refresh over a temp transcript tree and a temp on-disk index; no network, no LLM.
 * @consumer @ag/recall/37777; every `recall` search outside hook mode.
 * @reach    fs-walk <fixture-only: walks this test's mkdtempSync CLAUDE_DIR>
 * @testonly none
 */
import { Database } from "bun:sqlite"
import { tryAcquireFlock } from "@bearly/flock"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

process.env.RECALL_DB_PATH = ":memory:"

const { QUERY_REFRESH_CAP_MS, refreshIndexForQuery, reportQueryRefresh } =
  await import("../../src/history/query-refresh.ts")
const { initSchema } = await import("../../src/history/db.ts")

const TOKEN = "query_refresh_needle_7c21"
const SESSION_A = "session-alpha"
const SESSION_B = "session-beta"

let root: string
let claudeDir: string
let projectsDir: string
let db: Database
let dbPath: string
let previousClaudeDir: string | undefined
let stderrSpy: ReturnType<typeof vi.spyOn>

function writeTranscript(project: string, sessionId: string, text: string): string {
  const dir = join(projectsDir, project)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sessionId}.jsonl`)
  const line = JSON.stringify({
    sessionId,
    type: "user",
    timestamp: "2026-11-21T12:00:00.000Z",
    message: { role: "user", content: `${TOKEN} ${text}` },
  })
  writeFileSync(file, line + "\n", "utf8")
  return file
}

const stderr = () => stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("")

const messageCount = () =>
  (db.prepare("SELECT COUNT(*) AS c FROM messages WHERE content LIKE ?").get(`%${TOKEN}%`) as { c: number }).c

const sessionCount = (project: string) =>
  (
    db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE project_path = ?").get(project) as {
      c: number
    }
  ).c

const lastRebuild = () =>
  (db.prepare("SELECT value FROM index_meta WHERE key = 'last_rebuild'").get() as { value: string } | undefined)?.value

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "recall-query-refresh-"))
  claudeDir = join(root, "claude")
  projectsDir = join(claudeDir, "projects")
  mkdirSync(projectsDir, { recursive: true })
  previousClaudeDir = process.env.CLAUDE_DIR
  process.env.CLAUDE_DIR = claudeDir
  dbPath = join(root, "index.db")
  db = new Database(dbPath)
  initSchema(db)
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
})

afterEach(() => {
  if (previousClaudeDir === undefined) delete process.env.CLAUDE_DIR
  else process.env.CLAUDE_DIR = previousClaudeDir
  db.close()
  vi.restoreAllMocks()
  safeRemoveSync(root, { within: realpathSync(tmpdir()) })
})

describe("query-time index refresh (37777)", () => {
  test("indexes a transcript the index has never seen, so the query can find it", async () => {
    writeTranscript("projalpha", SESSION_A, "alpha body")
    expect(messageCount()).toBe(0)

    const receipt = await refreshIndexForQuery(db, { capMs: 5_000 })

    expect(receipt).toMatchObject({ indexed: 1, notSearched: 0 })
    expect(receipt.stoppedBy).toBeUndefined()
    expect(messageCount()).toBe(1)
    expect(sessionCount("projalpha")).toBe(1)
  })

  test("says indexed N once when it indexed, and nothing at all when nothing was new", async () => {
    writeTranscript("projalpha", SESSION_A, "alpha body")
    reportQueryRefresh(await refreshIndexForQuery(db, { capMs: 5_000 }))
    expect(stderr()).toMatch(/\[recall\] indexed 1 new transcripts \(\d+ms\)\n/)

    stderrSpy.mockClear()
    const unchanged = await refreshIndexForQuery(db, { capMs: 5_000 })
    expect(unchanged).toMatchObject({ indexed: 0, notSearched: 0 })
    reportQueryRefresh(unchanged)
    expect(stderr()).toBe("")
  })

  test("an unchanged transcript is skipped, so a second pass writes nothing", async () => {
    writeTranscript("projalpha", SESSION_A, "alpha body")
    const first = await refreshIndexForQuery(db, { capMs: 5_000 })
    expect(first.indexed).toBe(1)

    const second = await refreshIndexForQuery(db, { capMs: 5_000 })
    expect(second.indexed).toBe(0)
    expect(messageCount()).toBe(1)
  })

  test("the cap stops the pass before writing, counts every unread transcript, and says so loudly", async () => {
    writeTranscript("projalpha", SESSION_A, "alpha body")
    writeTranscript("projalpha", "session-gamma", "gamma body")
    writeTranscript("projbeta", SESSION_B, "beta body")

    const receipt = await refreshIndexForQuery(db, { capMs: 0 })

    expect(receipt).toMatchObject({ indexed: 0, notSearched: 3, stoppedBy: "cap" })
    expect(messageCount()).toBe(0)

    reportQueryRefresh(receipt, 0)
    expect(stderr()).toContain("3 newer transcripts were NOT searched")
    expect(stderr()).toContain("cap")
    expect(stderr()).toContain("rerun to include them")
    expect(stderr()).toContain("this answer may be missing them")
  })

  test("the cap-sized report names the cap and agrees on singular", () => {
    reportQueryRefresh({ indexed: 0, elapsedMs: 12, notSearched: 1, stoppedBy: "cap" })
    expect(stderr()).toContain("1 newer transcript was NOT searched (the refresh stopped at its 10s cap)")
    expect(QUERY_REFRESH_CAP_MS).toBe(10_000)
  })

  test("scopes to the queried project without claiming the whole index is current", async () => {
    writeTranscript("projalpha", SESSION_A, "alpha body")
    writeTranscript("projbeta", SESSION_B, "beta body")

    const receipt = await refreshIndexForQuery(db, { projectRoot: "projalpha", capMs: 5_000 })

    expect(receipt).toMatchObject({ indexed: 1, notSearched: 0 })
    expect(sessionCount("projalpha")).toBe(1)
    expect(sessionCount("projbeta")).toBe(0)
    expect(lastRebuild()).toBeUndefined()
  })

  test("a whole-root pass that reaches the end records that the index is current", async () => {
    writeTranscript("projalpha", SESSION_A, "alpha body")
    await refreshIndexForQuery(db, { projectRoot: "projalpha", capMs: 5_000 })
    expect(lastRebuild()).toBeUndefined()

    writeTranscript("projbeta", SESSION_B, "beta body")
    const receipt = await refreshIndexForQuery(db, { capMs: 5_000 })

    expect(receipt).toMatchObject({ indexed: 1, notSearched: 0 })
    expect(Number.isFinite(Date.parse(lastRebuild()!))).toBe(true)
  })

  test("a held writer lock reports busy with the count instead of blocking or throwing", async () => {
    writeTranscript("projalpha", SESSION_A, "alpha body")
    using lock = tryAcquireFlock(`${realpathSync(dbPath)}.rebuild.lock`, {
      body: JSON.stringify({ startedAt: Date.now() }),
    })
    expect(lock).not.toBeNull()

    const receipt = await refreshIndexForQuery(db, { capMs: 5_000 })

    expect(receipt).toMatchObject({ indexed: 0, notSearched: 1, stoppedBy: "busy" })
    expect(messageCount()).toBe(0)
    reportQueryRefresh(receipt)
    expect(stderr()).toContain("1 newer transcript was NOT searched (another index writer is active)")
  })

  test("a missing transcript source is reported, never thrown at the caller", async () => {
    safeRemoveSync(projectsDir, { within: realpathSync(tmpdir()) })

    const receipt = await refreshIndexForQuery(db, { capMs: 5_000 })

    expect(receipt).toMatchObject({ indexed: 0, notSearched: 0, stoppedBy: "source-missing" })
    reportQueryRefresh(receipt)
    expect(stderr()).toContain("transcript source missing")
    expect(stderr()).toContain("the index was not refreshed")
  })
})
