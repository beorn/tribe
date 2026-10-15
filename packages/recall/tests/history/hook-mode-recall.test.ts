/**
 * The prompt hook's recall runs in hook mode, inside a stated budget (@ag/tribe/25071 row 2, @cto ruling 2026-09-23).
 *
 * B1: hook mode issues no COUNT, not the message total, the content total, or the session-depth corroboration.
 * B2: hook mode selects eligible matching IDs before ranking; all window filters apply before the candidate cap.
 *     Ranking uses one MATCH cursor so its global phrase-frequency setup is not repeated per held ID (29482).
 * Phase 3 (@ag/recall/three-dark-search-paths): hook mode runs the phases its caller names, and never the project
 *     content or the synonym variants.
 * Exact mode, the default and the CLI's, keeps every count.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { assertSingleStatement } from "@bearly/sqlite"

process.env.RECALL_DB_PATH = ":memory:"

// A fresh module graph per test starts with an empty in-memory index and an
// unbound vault — what closeDb() + the removed resetVaultDbCacheForTests gave.
let closeDb: (typeof import("../../src/history/db"))["closeDb"]
let getDb: (typeof import("../../src/history/db"))["getDb"]
let recall: (typeof import("../../src/history/search"))["recall"]
let setRecallLogging: (typeof import("../../src/history/search"))["setRecallLogging"]

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

beforeEach(async () => {
  vi.resetModules()
  ;({ closeDb, getDb } = await import("../../src/history/db"))
  ;({ recall, setRecallLogging } = await import("../../src/history/search"))
  setRecallLogging(false)
})

afterEach(() => {
  closeDb()
  setRecallLogging(false)
})

/** @failure Late SQLite failures became apparently successful recall hits; syntax rejection needs a receipt.
 * @level l1 @consumer recall(): the real SQLite boundary fails after the primary search collected a hit.
 */
test.each([
  { phase: "synonym_messages", failure: "database", table: "messages_fts", anchor: "authentication" },
  { phase: "synonym_project_content", failure: "database", table: "content_fts", anchor: "authentication" },
  { phase: "corroboration", failure: "database", table: "messages_fts", anchor: "auth" },
  { phase: "synonym_messages", failure: "syntax", table: "messages_fts", anchor: "authentication" },
  { phase: "synonym_project_content", failure: "syntax", table: "content_fts", anchor: "authentication" },
  { phase: "corroboration", failure: "syntax", table: "messages_fts", anchor: "auth" },
])("late $phase $failure preserves the public failure contract", async ({ phase, failure, table, anchor }) => {
  seed([{ session: "kept", content: "auth authentication evidence", ageDays: 0 }])
  const db = getDb()
  const originalPrepare = db.prepare
  const prepare = originalPrepare.bind(db)
  let injected = false
  let primaryHits = 0
  let originalError: unknown

  // Delegate every read to native SQLite. Fault only the selected late read,
  // after the real primary query; a pre-call DROP would test a different catch.
  db.prepare = ((sql: string) => {
    const statement = prepare(sql)
    const execute = statement.all.bind(statement)
    statement.all = ((...params: Parameters<typeof statement.all>) => {
      const target =
        phase === "corroboration"
          ? sql.includes("GROUP BY m.session_id")
          : sql.includes(table) && !sql.includes("GROUP BY") && params.includes('"authentication"')
      const bindings = [...params]
      if (target && !injected) {
        injected = true
        if (failure === "database") db.run(assertSingleStatement(`DROP TABLE ${table}`))
        else bindings[bindings.indexOf(`"${anchor}"`)] = ""
      }
      try {
        const rows = execute(...bindings)
        if (sql.includes("messages_fts") && !sql.includes("GROUP BY") && params.includes('"auth"')) {
          primaryHits += rows.length
        }
        return rows
      } catch (error) {
        if (target && originalError === undefined) originalError = error
        throw error
      }
    }) as typeof statement.all
    return statement
  }) as typeof db.prepare

  try {
    const outcome = await recall("auth", { raw: true, excludeCurrentSession: true }).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    )
    expect(injected).toBe(true)
    expect(primaryHits).toBeGreaterThan(0)
    expect(originalError).toBeInstanceOf(Error)
    if (failure === "database") {
      expect((originalError as Error).message).toContain(`no such table: ${table}`)
      expect(outcome.error).toBe(originalError)
    } else {
      expect((originalError as Error).message).toContain("fts5: syntax error")
      expect(outcome.error).toBeUndefined()
      expect(outcome.value?.results).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: "kept" })]))
      expect(outcome.value?.skipped).toEqual([
        { kind: "query-rejected", phase, anchor, message: expect.stringContaining((originalError as Error).message) },
      ])
    }
  } finally {
    db.prepare = originalPrepare
  }
})

/** @failure The prompt hook queried the retired session types; project knowledge belongs to its vault phase. */
test("hook phases prepare no content-table query", async () => {
  const db = getDb()
  const insert = db.prepare(
    `INSERT INTO content (content_type, source_id, project_path, title, content, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  for (const type of [
    "doc",
    "llm_research",
    "project_memory",
    "claude_md",
    "plan",
    "summary",
    "todo",
    "first_prompt",
  ]) {
    insert.run(type, type, "/test/km", type, "livehookneedle", Date.now() - 40 * DAY_MS)
  }

  const sql = await preparedSql(() =>
    recall("livehookneedle", { mode: "hook", raw: true, limit: 20, phases: ["messages", "titles"] }),
  )
  expect(sql.some((statement) => /content_fts|FROM\s+content\b/i.test(statement))).toBe(false)
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

describe("29482 B2: hook mode bounds eligible candidates before ranking", () => {
  test("29482 ranking keeps one MATCH cursor instead of restarting global BM25 setup for every held ID", async () => {
    // The accepted work bound includes BM25's global phrase-frequency setup.
    // Hit/count fixtures pass even when SQLite repeats that setup per ID; its
    // native VM exposes the repeat without a load-dependent timing assertion.
    seed(recentWeak(20))
    const { ftsSearchWithSnippet, toFts5Query } = await import("../../src/history/db-queries")
    const db = getDb()
    const statements = await preparedSql(async () => ftsSearchWithSnippet(db, ANCHOR, { mode: "hook", limit: 5 }))
    const ranking = statements.find((sql) => sql.includes("bm25(messages_fts") && sql.includes("json_each"))
    expect(ranking).toBeDefined()
    type Instruction = { addr: number; opcode: string; p2: number; p4: string | null }
    const vm = db
      .prepare(assertSingleStatement(`EXPLAIN ${ranking!}`))
      .all(toFts5Query(ANCHOR), "[1,2,3,4,5]") as Instruction[]
    const matchFilters = vm.filter((op) => op.opcode === "VFilter" && /M\d/.test(op.p4 ?? ""))
    expect(matchFilters).toHaveLength(1)
    const match = matchFilters[0]!
    const restartingLoops = vm.filter(
      (op) => /^(Next|Prev)$/.test(op.opcode) && op.addr > match.addr && op.p2 <= match.addr,
    )
    expect(restartingLoops).toEqual([])
    const rank = vm.find((op) => op.opcode === "Function" && op.p4?.startsWith("bm25("))!
    expect(vm.some((op) => op.opcode === "NotFound" && op.addr > match.addr && op.addr < rank.addr)).toBe(true)
  })

  test("29482 caps eligible candidates before ranking and reports the approximation", async () => {
    // A survivor LIMIT still returns the old strongest row; a pre-score ID cap
    // excludes it. Existing output-count cases cannot distinguish those paths.
    seed([
      { session: "old-best", content: `${ANCHOR} `.repeat(80), ageDays: 2 },
      ...recentWeak(1000),
      ...unmatched(500),
    ])
    const { ftsSearchWithSnippet } = await import("../../src/history/db")
    const db = getDb()
    const exact = ftsSearchWithSnippet(db, ANCHOR, { limit: 5 })
    const hook = ftsSearchWithSnippet(db, ANCHOR, { mode: "hook", limit: 5 })

    expect(exact.results[0]?.session_id).toBe("old-best")
    expect(hook.results.some((r) => r.session_id === "old-best")).toBe(false)
    expect(hook.hook.survivors).toBe(1000)
    expect(hook.hook.capped?.message).toContain("prose held 1000")
    expect(hook.hook.capped?.message).toContain("tools held 0")
    expect(hook.hook.capped?.message).toContain("overflow")
  }, 30_000)

  test("29482 matches before the candidate cap, retaining an older rare eligible hit", async () => {
    // Newer nonmatches and ineligible matches must not consume the candidate
    // set. This distinguishes MATCH/filter-first from a global recent-row cap.
    seed([{ session: "eligible-old", content: ANCHOR, ageDays: 29 }, ...recentWeak(1200), ...unmatched(1200)])
    const { ftsSearchWithSnippet } = await import("../../src/history/db")
    const db = getDb()
    db.prepare("UPDATE sessions SET cwd = '/other'").run()
    db.prepare("UPDATE sessions SET cwd = '/target' WHERE id = 'eligible-old'").run()
    const hook = ftsSearchWithSnippet(db, ANCHOR, { mode: "hook", projectFilter: "/target", limit: 5 })

    expect(hook.results.map((r) => r.session_id)).toEqual(["eligible-old"])
    expect(hook.hook.survivors).toBe(1)
    expect(hook.hook.capped).toBeUndefined()
  }, 30_000)

  test("29482 keeps prose under tool pressure and honors an explicit tool lookup", async () => {
    // Final tool weighting cannot recover prose excluded by a recent-row cap.
    seed([
      ...Array.from({ length: 12 }, (_, i) => ({ session: `prose-${i}`, content: ANCHOR, ageDays: 2 })),
      ...recentWeak(1001),
    ])
    const { ftsSearchWithSnippet } = await import("../../src/history/db")
    const db = getDb()
    db.prepare("UPDATE messages SET tool_name = 'Bash' WHERE session_id LIKE 'new-%'").run()
    const prose = ftsSearchWithSnippet(db, ANCHOR, { mode: "hook", limit: 5 })
    const tools = ftsSearchWithSnippet(db, ANCHOR, { mode: "hook", toolName: "Bash", limit: 5 })

    expect(prose.results).toHaveLength(5)
    expect(prose.results.every((r) => r.session_id.startsWith("prose-"))).toBe(true)
    expect(prose.hook.capped?.message).toContain("prose held 12, tools held 988")
    expect(tools.results).toHaveLength(5)
    expect(tools.results.every((r) => r.tool_name === "Bash")).toBe(true)
    expect(tools.hook.capped?.message).toContain("prose held 0, tools held 1000")
  }, 30_000)

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

  test("N caps eligible window matches before ranking and reports the approximation", async () => {
    seed([...unmatched(50), ...recentWeak(1003)])

    const hook = await recall(ANCHOR, { mode: "hook", raw: true, limit: 5 })

    expect(hook.hookSearch).toEqual({ candidateLimit: 1000, survivors: 1000 })
    // B1 counts nothing, so the cap is seen by fetching one row past it, not by a COUNT.
    expect(hook.skipped).toEqual([
      {
        kind: "candidate-cap",
        phase: "messages",
        anchor: ANCHOR,
        message: `recall messages capped before ranking at 1000 eligible matches: prose held 1000, tools held 0; overflow at least 1 for anchor "${ANCHOR}"; results are approximate (29482)`,
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

describe("Phase 3: hook mode runs the phases its caller names (@ag/recall/three-dark-search-paths, @cto 7f55e4f2)", () => {
  test("with no phases named, hook mode times vault, messages and titles, and runs no project_content", async () => {
    seed(recentWeak(20))

    const hook = await recall(ANCHOR, { mode: "hook", raw: true, limit: 5 })

    expect(Object.keys(hook.timing?.phases ?? {}).sort()).toEqual(
      ["corroboration", "live_session", "messages", "proximity", "titles", "vault"].sort(),
    )
  })

  test("a vault-only call runs no statement on the message index, not even the corroboration scan", async () => {
    seed(recentWeak(20))

    const sql = await preparedSql(() => recall(ANCHOR, { mode: "hook", raw: true, limit: 5, phases: ["vault"] }))
    seed(recentWeak(20))
    const vaultOnly = await recall(ANCHOR, { mode: "hook", raw: true, limit: 5, phases: ["vault"] })

    expect(sql.filter((q) => /messages_fts/i.test(q))).toEqual([])
    expect(vaultOnly.results).toEqual([])
    expect(Object.keys(vaultOnly.timing?.phases ?? {}).sort()).toEqual(
      ["corroboration", "live_session", "proximity", "vault"].sort(),
    )
  })

  test("hook mode runs no synonym variant; exact mode still does (the control)", async () => {
    const auth = (): Seed[] =>
      Array.from({ length: 12 }, (_, i) => ({
        session: `auth-${i}`,
        content: `auth token note ${String(i)}`,
        ageDays: 1,
      }))
    seed(auth())
    const hook = await recall("auth", { mode: "hook", raw: true, limit: 5 })
    seed(auth())
    const exact = await recall("auth", { raw: true, limit: 5 })

    expect(hook.timing?.phases?.synonyms).toBeUndefined()
    expect(hook.skipped ?? []).toEqual([])
    expect(exact.timing?.phases?.synonyms).toBeGreaterThanOrEqual(0)
  })
})

describe("25071 row 2: the budget is stated once, as named constants", () => {
  test("a 1.5 s wall and a cap of 1000 ranked window matches", async () => {
    const budget = await import("../../src/history/recall-budget.ts")
    expect(budget.RECALL_WALL_MS).toBe(1500)
    expect(budget.HOOK_CANDIDATE_LIMIT).toBe(1000)
    // The all-time candidate set's widening, its floor and its survivor minimum went with it (re-ruling 516d4c10);
    // the cost of one pass went with the phases it budgeted, the synonym variants and the glossary fallback (Phase 3).
    // The 1 s target is prose in this module, not an export; RECALL_WALL_MS is what a call is bounded by.
    expect(Object.keys(budget).sort()).toEqual(["HOOK_CANDIDATE_LIMIT", "RECALL_WALL_MS"].sort())
  })
})
