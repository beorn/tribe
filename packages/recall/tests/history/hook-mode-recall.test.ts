/**
 * The prompt hook's recall runs in hook mode, inside a stated budget (@ag/tribe/25071 row 2, @cto ruling 2026-09-23).
 *
 * B1: hook mode issues no COUNT, not the message total, the content total, or the session-depth corroboration.
 * B2: hook mode ranks the window first, like exact, capped at N ranked matches (@cto re-ruling 516d4c10: the all-time
 *     top-N candidate set was refuted by the real-prompt replay, where hook was slower than exact on 84 of 150).
 * B3: the synonym variants run only while the remaining budget covers one candidate pass; a skipped phase says the
 *     phase, the anchor and the ms left.
 * Exact mode, the default and the CLI's, keeps every count.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

process.env.RECALL_DB_PATH = ":memory:"

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
  return Array.from({ length: n }, (_, i) => ({
    session: `old-${i % 50}`,
    content: `${ANCHOR} ${ANCHOR}`,
    ageDays: 40,
  }))
}

/** `n` recent, long, weak matches: in the window, but below every old strong match in bm25. */
function recentWeak(n: number): Seed[] {
  return Array.from({ length: n }, (_, i) => ({
    session: `new-${i}`,
    content: `${FILLER} ${FILLER} ${ANCHOR} ${FILLER} ${FILLER} item ${String(i)}`,
    ageDays: 1,
  }))
}

/** `n` rows without the anchor, in the window: the corpus a real anchor is rare in. */
function unmatched(n: number): Seed[] {
  return Array.from({ length: n }, (_, i) => ({
    session: `other-${i % 20}`,
    content: `${FILLER} ${String(i)}`,
    ageDays: 3,
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
    // The root vitest setup pins LOG_LEVEL=warn; the count line is an info line (25392), so the row names its level.
    vi.stubEnv("LOG_LEVEL", "info")
    try {
      setRecallLogging(true)
      await recall(ANCHOR, { mode: "hook", raw: true, limit: 5 })
    } finally {
      setRecallLogging(false)
      vi.unstubAllEnvs()
      err.mockRestore()
    }
    const messageLine = lines.find((line) => line.includes("FTS5 messages:"))
    expect(messageLine).toContain("total: not counted (hook mode)")
  })
})

describe("25071 row 2 B2: hook mode ranks the window first (@cto re-ruling 516d4c10)", () => {
  test("on a plentiful index, hook and exact inject the same five, and hook says how many window matches it ranked", async () => {
    // recall() closes the index when it returns, and an in-memory index closes empty: seed before each call.
    // The unmatched rows give the anchor a real IDF, so bm25 orders the matches instead of tying them all.
    const plentiful = (): Seed[] => [
      ...unmatched(200),
      ...recentWeak(40),
      ...Array.from({ length: 30 }, (_, i) => ({
        session: `mid-${i}`,
        content: `${ANCHOR} ${i % 3 === 0 ? ANCHOR : ""} note ${String(i)}`,
        ageDays: 2 + (i % 20),
      })),
    ]
    seed(plentiful())
    const exact = await recall(ANCHOR, { raw: true, limit: 5 })
    seed(plentiful())
    const hook = await recall(ANCHOR, { mode: "hook", raw: true, limit: 5 })

    expect(hook.hookSearch).toEqual({ candidateLimit: 1000, survivors: 70 })
    expect(hook.results).toHaveLength(5)
    expect(hook.results.map((r) => `${r.sessionId}:${r.type}`)).toEqual(
      exact.results.map((r) => `${r.sessionId}:${r.type}`),
    )
  })

  test("old strong matches outside the window never crowd out the recent weak ones: one pass finds them", async () => {
    seed([...oldStrong(1200), ...recentWeak(12)])

    const hook = await recall(ANCHOR, { mode: "hook", raw: true, limit: 5 })

    expect(hook.hookSearch).toEqual({ candidateLimit: 1000, survivors: 12 })
    expect(hook.skipped ?? []).toEqual([])
    expect(hook.results.length).toBeGreaterThan(0)
    expect(hook.results.every((r) => r.sessionId.startsWith("new-"))).toBe(true)
  }, 30_000)

  test("N caps the ranked window matches, and says so: the one case where hook can differ from exact", async () => {
    seed([...unmatched(50), ...recentWeak(1003)])

    const hook = await recall(ANCHOR, { mode: "hook", raw: true, limit: 5 })

    expect(hook.hookSearch).toEqual({ candidateLimit: 1000, survivors: 1000 })
    // B1 counts nothing, so the cap is seen by fetching one row past it, not by a COUNT.
    expect(hook.skipped).toEqual([
      {
        phase: "messages",
        anchor: ANCHOR,
        message: `recall messages capped: survivors capped at 1000 of more than 1000 window matches for anchor "${ANCHOR}" (25071)`,
      },
    ])
  }, 30_000)

  test("a window at the cap exactly is not reported as capped", async () => {
    seed([...unmatched(50), ...recentWeak(1000)])

    const hook = await recall(ANCHOR, { mode: "hook", raw: true, limit: 5 })

    expect(hook.hookSearch).toEqual({ candidateLimit: 1000, survivors: 1000 })
    expect(hook.skipped ?? []).toEqual([])
  }, 30_000)

  test("every statement hook mode runs against the message index applies the window in the same statement", async () => {
    seed([...oldStrong(20), ...recentWeak(20)])

    const sql = await preparedSql(() => recall(ANCHOR, { mode: "hook", raw: true, limit: 5 }))

    // Ranking the bare index (MATCH, then ORDER BY with nothing between) scores every all-time match before the
    // window: the pass the replay refuted. Each statement that matches the message index holds the window instead.
    const messageMatches = sql.filter((q) => /messages_fts\s+MATCH/i.test(q))
    expect(messageMatches.length).toBeGreaterThan(0)
    for (const q of messageMatches) {
      expect(q).toMatch(/m\.timestamp >= \?/)
      expect(q).not.toMatch(/messages_fts\s+MATCH\s+\?\s+ORDER BY/i)
    }
  })
})

describe("25071 row 2 B3: phases run only while the budget covers them", () => {
  test("a synonym variant the remaining budget cannot cover is skipped, naming the phase, the anchor and the ms left", async () => {
    seed(
      Array.from({ length: 12 }, (_, i) => ({
        session: `auth-${i}`,
        content: `auth token note ${String(i)}`,
        ageDays: 1,
      })),
    )

    const hook = await recall("auth", { mode: "hook", raw: true, limit: 5, deadlineAt: Date.now() + 100 })

    const synonym = hook.skipped?.find((s) => s.phase === "synonym")
    expect(synonym?.anchor).toBe("authentication")
    expect(synonym?.message).toMatch(/^recall synonym skipped: anchor "authentication", -?\d+ ms left \(25071\)$/)
  })

  test("recall reports each phase's time, so the hook's steps can name the slow one", async () => {
    seed(recentWeak(20))

    const hook = await recall(ANCHOR, { mode: "hook", raw: true, limit: 5 })

    expect(Object.keys(hook.timing?.phases ?? {}).sort()).toEqual(
      [
        "corroboration",
        "live_session",
        "messages",
        "project_content",
        "proximity",
        "session_content",
        "titles",
        "vault",
      ].sort(),
    )
  })
})

describe("25071 row 2: the budget is stated once, as named constants", () => {
  test("a 1.5 s wall, a 1.0 s target, a cap of 1000 ranked window matches, and the cost of one pass", async () => {
    const budget = await import("../../src/history/recall-budget.ts")
    expect(budget.RECALL_WALL_MS).toBe(1500)
    expect(budget.RECALL_TARGET_MS).toBe(1000)
    expect(budget.HOOK_CANDIDATE_LIMIT).toBe(1000)
    expect(budget.HOOK_CANDIDATE_PASS_MS).toBeGreaterThan(0)
    // The all-time candidate set's widening, its floor and its survivor minimum went with it (re-ruling 516d4c10).
    expect(Object.keys(budget).sort()).toEqual(
      ["HOOK_CANDIDATE_LIMIT", "HOOK_CANDIDATE_PASS_MS", "RECALL_TARGET_MS", "RECALL_WALL_MS"].sort(),
    )
  })
})
