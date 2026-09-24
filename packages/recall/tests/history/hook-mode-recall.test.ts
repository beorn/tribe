/**
 * The prompt hook's recall runs in hook mode, inside a stated budget (@ag/tribe/25071 row 2, @cto ruling 2026-09-23).
 *
 * B1: hook mode issues no COUNT, not the message total, the content total, or the session-depth corroboration.
 * B2: hook mode ranks an FTS-native candidate set instead of every match; it widens once when too few candidates fall
 *     in the window, and skips the message phase loudly when even the wide set leaves too few.
 * B3: the synonym variants run only while the remaining budget covers one candidate pass; a skipped phase says the
 *     phase, the anchor and the ms left.
 * Exact mode, the default and the CLI's, keeps every count.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

process.env.RECALL_DB_PATH = ":memory:"
delete process.env.KM_VAULT_DB

const { closeDb, getDb } = await import("../../src/history/db")
const { recall, setRecallLogging } = await import("../../src/history/search")
const { resetVaultDbCacheForTests } = await import("../../src/history/vault-fts.ts")

const DAY_MS = 24 * 60 * 60 * 1000
const ANCHOR = "zebracorn"
const FILLER = "the quarterly lantern gathers moss beside eleven quiet harbours while nobody watches the tide"

type Seed = { session: string; content: string; ageDays: number }

/** Insert every row in one transaction; the FTS index follows through the schema's triggers. */
function seed(rows: Seed[]): void {
  const db = getDb()
  const now = Date.now()
  const sessions = new Set<string>()
  const insertSession = db.prepare(
    `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertMessage = db.prepare(
    `INSERT INTO messages (uuid, session_id, type, content, timestamp) VALUES (?, ?, ?, ?, ?)`,
  )
  db.transaction(() => {
    rows.forEach((row, i) => {
      if (!sessions.has(row.session)) {
        sessions.add(row.session)
        insertSession.run(row.session, "/test/km", `/tmp/${row.session}.jsonl`, now - DAY_MS, now, 1, row.session)
      }
      insertMessage.run(`msg-${i}`, row.session, "user", row.content, now - row.ageDays * DAY_MS - i)
    })
  })()
}

/** `n` old, short, strong matches: they own the all-time bm25 order, and the 30-day window drops every one. */
function oldStrong(n: number): Seed[] {
  return Array.from({ length: n }, (_, i) => ({ session: `old-${i % 50}`, content: `${ANCHOR} ${ANCHOR}`, ageDays: 40 }))
}

/** `n` recent, long, weak matches: in the window, but below every old strong match in bm25. */
function recentWeak(n: number): Seed[] {
  return Array.from({ length: n }, (_, i) => ({
    session: `new-${i}`,
    content: `${FILLER} ${FILLER} ${ANCHOR} ${FILLER} ${FILLER} item ${String(i)}`,
    ageDays: 1,
  }))
}

/** Every SQL string prepared on the index while `run` runs. */
async function preparedSql(run: () => Promise<unknown>): Promise<string[]> {
  const db = getDb()
  const prepare = vi.spyOn(db, "prepare")
  const query = vi.spyOn(db, "query")
  try {
    await run()
    return [...prepare.mock.calls, ...query.mock.calls].map((call) => String(call[0]))
  } finally {
    prepare.mockRestore()
    query.mockRestore()
  }
}

const COUNTS = /\bCOUNT\s*\(/i

beforeEach(() => {
  closeDb()
  resetVaultDbCacheForTests()
  setRecallLogging(false)
})

afterEach(() => {
  closeDb()
  setRecallLogging(false)
})

describe("25071 row 2 B1: hook mode counts nothing", () => {
  test("the hook path prepares no COUNT; the exact path still counts (the control)", async () => {
    seed(recentWeak(20))

    const hookSql = await preparedSql(() => recall(ANCHOR, { mode: "hook", raw: true, limit: 5 }))
    expect(hookSql.length).toBeGreaterThan(0)
    expect(hookSql.filter((sql) => COUNTS.test(sql))).toEqual([])

    const exactSql = await preparedSql(() => recall(ANCHOR, { raw: true, limit: 5 }))
    expect(exactSql.some((sql) => COUNTS.test(sql))).toBe(true)
  })

  test("the hook log says the total was not counted, never a number it did not count", async () => {
    seed(recentWeak(20))
    const lines: string[] = []
    const err = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    })
    try {
      setRecallLogging(true)
      await recall(ANCHOR, { mode: "hook", raw: true, limit: 5 })
    } finally {
      setRecallLogging(false)
      err.mockRestore()
    }
    const messageLine = lines.find((line) => line.includes("FTS5 messages:"))
    expect(messageLine).toContain("total: not counted (hook mode)")
  })
})

describe("25071 row 2 B2: hook mode ranks a candidate set", () => {
  test("on a plentiful index, hook and exact inject the same five, and hook says it ranked candidates", async () => {
    seed([
      ...recentWeak(40),
      ...Array.from({ length: 30 }, (_, i) => ({
        session: `mid-${i}`,
        content: `${ANCHOR} ${i % 3 === 0 ? ANCHOR : ""} note ${String(i)}`,
        ageDays: 2 + (i % 20),
      })),
    ])

    const exact = await recall(ANCHOR, { raw: true, limit: 5 })
    const hook = await recall(ANCHOR, { mode: "hook", raw: true, limit: 5 })

    expect(hook.hookSearch).toMatchObject({ candidateLimit: 1000, widened: false })
    expect(hook.results.map((r) => `${r.sessionId}:${r.type}`)).toEqual(
      exact.results.map((r) => `${r.sessionId}:${r.type}`),
    )
    expect(hook.results).toHaveLength(5)
  })

  test("when the window keeps too few of the first candidates, hook widens once and finds the recent matches", async () => {
    seed([...oldStrong(1200), ...recentWeak(12)])

    const hook = await recall(ANCHOR, { mode: "hook", raw: true, limit: 5 })

    expect(hook.hookSearch).toMatchObject({ candidateLimit: 5000, widened: true, firstSurvivors: 0, survivors: 12 })
    expect(hook.results.length).toBeGreaterThan(0)
    expect(hook.results.every((r) => r.sessionId.startsWith("new-"))).toBe(true)
  }, 30_000)

  test("when even the wide set leaves fewer than ten in the window, the message phase is skipped loudly with both counts", async () => {
    seed([...oldStrong(5100), ...recentWeak(3)])

    const hook = await recall(ANCHOR, { mode: "hook", raw: true, limit: 5 })

    expect(hook.results.filter((r) => r.type === "message")).toEqual([])
    expect(hook.skipped).toEqual([
      {
        phase: "messages",
        anchor: ANCHOR,
        message: `recall messages skipped: anchor "${ANCHOR}" kept 0 of 1000, then 0 of 5000 candidates in the window (25071)`,
      },
    ])
  }, 60_000)
})

describe("25071 row 2 B3: phases run only while the budget covers them", () => {
  test("a synonym variant the remaining budget cannot cover is skipped, naming the phase, the anchor and the ms left", async () => {
    seed(Array.from({ length: 12 }, (_, i) => ({ session: `auth-${i}`, content: `auth token note ${String(i)}`, ageDays: 1 })))

    const hook = await recall("auth", { mode: "hook", raw: true, limit: 5, deadlineAt: Date.now() + 100 })

    const synonym = hook.skipped?.find((s) => s.phase === "synonym")
    expect(synonym?.anchor).toBe("authentication")
    expect(synonym?.message).toMatch(/^recall synonym skipped: anchor "authentication", -?\d+ ms left \(25071\)$/)
  })

  test("recall reports each phase's time, so the hook's steps can name the slow one", async () => {
    seed(recentWeak(20))

    const hook = await recall(ANCHOR, { mode: "hook", raw: true, limit: 5 })

    expect(Object.keys(hook.timing?.phases ?? {}).sort()).toEqual(
      ["corroboration", "live_session", "messages", "project_content", "proximity", "session_content", "titles", "vault"].sort(),
    )
  })
})

describe("25071 row 2: the budget is stated once, as named constants", () => {
  test("a 1.5 s wall, a 1.0 s target, candidate sets of 1000 then 5000, never under 500, and ten survivors", async () => {
    const budget = await import("../../src/history/recall-budget.ts")
    expect(budget.RECALL_WALL_MS).toBe(1500)
    expect(budget.RECALL_TARGET_MS).toBe(1000)
    expect(budget.HOOK_CANDIDATE_LIMIT).toBe(1000)
    expect(budget.HOOK_WIDE_CANDIDATE_LIMIT).toBe(5000)
    expect(budget.HOOK_CANDIDATE_LIMIT).toBeGreaterThanOrEqual(budget.HOOK_CANDIDATE_FLOOR)
    expect(budget.HOOK_CANDIDATE_FLOOR).toBe(500)
    expect(budget.HOOK_MIN_SURVIVORS).toBe(10)
    expect(budget.HOOK_CANDIDATE_PASS_MS).toBeGreaterThan(0)
  })
})
