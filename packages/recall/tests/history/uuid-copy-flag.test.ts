/**
 * @failure a uuid copy shows in search, or its winner is hidden, because the stored flag missed an event the old
 *   per-hit lookup answered live
 * @level l2
 * @consumer @ag/recall/three-dark-search-paths
 * @testonly none
 *
 * CTO 2de1a8ca. Requirement: count stays exact and the same ids come back after the correlated lookup goes.
 * Gap: existing tests seed one insert order, so none sees a winner move after ingest, and none reads the plan that keeps
 * message rows out of count and phase A.
 */
import { assertSingleStatement } from "@bearly/sqlite"
import { Database } from "bun:sqlite"
import { describe, expect, test } from "vitest"
import { initSchema, UUID_COPY_FLAG, uuidWinnerSql } from "../../src/history/db-schema.ts"
import { ftsSearchWithSnippet, insertMessage, upsertSession } from "../../src/history/db-queries.ts"

const TOKEN = "copyflagtoken"

function store(): Database {
  const db = new Database(":memory:")
  db.exec("PRAGMA journal_mode = MEMORY")
  initSchema(db)
  return db
}

const session = (db: Database, id: string, parentSessionId: string | null = null) =>
  upsertSession(db, id, "/test", `/tmp/${id}.jsonl`, 1, 1, 1, id, { parentSessionId, cwd: "/test" })

const message = (
  db: Database,
  uuid: string | null,
  sessionId: string,
  line: number | null = null,
  duplicateOf: number | null = null,
) => insertMessage(db, uuid, sessionId, "user", `${TOKEN} words`, null, null, Date.now(), duplicateOf, line)

const flags = (db: Database, uuid: string) =>
  db.prepare("SELECT session_id, duplicate_of FROM messages WHERE uuid = ? ORDER BY id").all(uuid) as {
    session_id: string
    duplicate_of: number | null
  }[]

/** The session holding the one unflagged row of a uuid: the winner as the flag says it. */
const winnerSession = (db: Database, uuid: string) => {
  const open = flags(db, uuid).filter((row) => row.duplicate_of === null)
  expect(open).toHaveLength(1)
  return open[0]!.session_id
}

/** What the removed clause answered, read live, so every event is checked against the rule rather than a constant. */
const liveWinnerId = (db: Database, uuid: string) =>
  (db.prepare(assertSingleStatement(`SELECT ${uuidWinnerSql("?")} AS id`)).get(uuid) as { id: number | null }).id

describe("the stored uuid copy flag follows every event that moves the winner", () => {
  test("a later copy is flagged; the lowest id stays the winner", () => {
    const db = store()
    session(db, "c1", "root")
    session(db, "c2", "root")
    message(db, "u", "c1")
    message(db, "u", "c2")
    expect(flags(db, "u")).toEqual([
      { session_id: "c1", duplicate_of: null },
      { session_id: "c2", duplicate_of: UUID_COPY_FLAG },
    ])
  })

  test("a parent copy arriving after its child copy flips the winner", () => {
    const db = store()
    session(db, "root")
    session(db, "c1", "root")
    message(db, "u", "c1")
    expect(winnerSession(db, "u")).toBe("c1")
    message(db, "u", "root")
    expect(winnerSession(db, "u")).toBe("root")
  })

  test("deleting the winner hands the win on", () => {
    const db = store()
    session(db, "c1", "root")
    session(db, "c2", "root")
    message(db, "u", "c1")
    message(db, "u", "c2")
    db.prepare("DELETE FROM messages WHERE session_id = 'c1'").run()
    expect(winnerSession(db, "u")).toBe("c2")
  })

  test("a re-index gives new ids, so the win moves as the clause moved it", () => {
    const db = store()
    session(db, "c1", "root")
    session(db, "c2", "root")
    message(db, "u", "c1")
    message(db, "u", "c2")
    db.prepare("DELETE FROM messages WHERE session_id = 'c1'").run()
    message(db, "u", "c1")
    expect(winnerSession(db, "u")).toBe("c2")
    const open = db.prepare("SELECT id FROM messages WHERE uuid = 'u' AND duplicate_of IS NULL").get() as { id: number }
    expect(liveWinnerId(db, "u")).toBe(open.id)
  })

  test("a parent link written late flips the win", () => {
    const db = store()
    session(db, "a")
    session(db, "b")
    message(db, "u", "a")
    message(db, "u", "b")
    expect(winnerSession(db, "u")).toBe("a")
    session(db, "a", "root")
    expect(winnerSession(db, "u")).toBe("b")
  })

  test("a session row written after its messages, as a full re-index does, settles the rule", () => {
    const db = store()
    session(db, "known", "root")
    message(db, "u", "known")
    message(db, "u", "late")
    expect(winnerSession(db, "u")).toBe("known")
    session(db, "late")
    expect(winnerSession(db, "u")).toBe("late")
  })

  test("an upsert of a known uuid keeps the flag", () => {
    const db = store()
    session(db, "c1", "root")
    session(db, "c2", "root")
    message(db, "u", "c1")
    message(db, "u", "c2")
    message(db, "u", "c2")
    expect(flags(db, "u")).toEqual([
      { session_id: "c1", duplicate_of: null },
      { session_id: "c2", duplicate_of: UUID_COPY_FLAG },
    ])
  })

  test("a Codex line number is never touched", () => {
    const db = store()
    session(db, "c1", "root")
    session(db, "c2", "root")
    message(db, "u", "c1")
    message(db, "u", "c2")
    db.prepare("UPDATE messages SET duplicate_of = 7 WHERE session_id = 'c2'").run()
    db.prepare("DELETE FROM messages WHERE session_id = 'c1'").run()
    expect(flags(db, "u")).toEqual([{ session_id: "c2", duplicate_of: 7 }])
  })

  test("a flag write leaves the FTS index alone", () => {
    const db = store()
    session(db, "c1", "root")
    session(db, "c2", "root")
    message(db, "u", "c1")
    message(db, "u", "c2")
    const data = () => (db.prepare("SELECT COUNT(*) AS n FROM messages_fts_data").get() as { n: number }).n
    const before = data()
    db.prepare("UPDATE messages SET duplicate_of = NULL WHERE session_id = 'c2'").run()
    expect(data()).toBe(before)
  })
})

describe("the duplicate check never answers the flag", () => {
  test("a hit whose copies are flagged shows no duplicate line, at any line, and a real one still shows", () => {
    const db = store()
    session(db, "c1", "root")
    session(db, "c2", "root")
    message(db, "u", "c1", 1)
    message(db, "v", "c1", 2)
    message(db, "w", "c2", 3)
    message(db, "u", "c2", 4)
    message(db, "x", "c1", 5)
    db.prepare("UPDATE messages SET duplicate_of = 2 WHERE uuid = 'x'").run()
    const { results } = ftsSearchWithSnippet(db, TOKEN)
    const byLine = new Map(results.map((hit) => [hit.line, hit.duplicate_line]))
    expect(byLine.get(1)).toBeNull()
    expect(byLine.get(3)).toBeNull()
    expect(byLine.get(2)).toBe(5)
    expect([...byLine.values()]).not.toContain(UUID_COPY_FLAG)
  })

  test("the flag cannot match: no store line is 0, and a flagged row with a line answers nothing", () => {
    const db = store()
    session(db, "c1", "root")
    session(db, "c2", "root")
    message(db, "u", "c1", 9)
    message(db, "u", "c2", 9)
    const answers = db
      .prepare(
        "SELECT COUNT(*) AS n FROM messages d JOIN messages m ON d.session_id = m.session_id AND d.duplicate_of = m.line",
      )
      .get() as { n: number }
    expect(answers.n).toBe(0)
  })
})

describe("search reads the flag", () => {
  const seed = () => {
    const db = store()
    session(db, "root")
    session(db, "c1", "root")
    session(db, "c2", "root")
    message(db, "shared", "c1")
    message(db, "shared", "c2")
    message(db, "shared", "root")
    message(db, "only", "c1")
    message(db, null, "c2")
    return db
  }

  test("total and ids drop every copy, and keep the winner", () => {
    const db = seed()
    const { total, results } = ftsSearchWithSnippet(db, TOKEN)
    expect(total).toBe(3)
    expect(results.map((hit) => hit.session_id).sort()).toEqual(["c1", "c2", "root"])
    expect(results.find((hit) => hit.uuid === "shared")?.session_id).toBe("root")
  })

  test("a project filter takes the session path and answers the same way", () => {
    const db = seed()
    const { total } = ftsSearchWithSnippet(db, TOKEN, { projectFilter: "/nothing-matches" })
    expect(total).toBe(0)
    expect(ftsSearchWithSnippet(db, TOKEN, { projectFilter: "/test" }).total).toBe(
      ftsSearchWithSnippet(db, TOKEN).total,
    )
  })

  test("count and phase A read no message row and no session when no filter needs one", () => {
    const db = seed()
    const seen: string[] = []
    const prepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => {
      seen.push(sql)
      return prepare(sql)
    }) as typeof db.prepare
    ftsSearchWithSnippet(db, TOKEN, { sinceTime: 1 })
    db.prepare = prepare
    const narrow = seen.filter((sql) => sql.includes("INDEXED BY idx_messages_window"))
    expect(narrow).toHaveLength(2)
    for (const sql of narrow) {
      const plan = (
        db.prepare(assertSingleStatement(`EXPLAIN QUERY PLAN ${sql}`)).all(...planParams(sql)) as { detail: string }[]
      ).map((row) => row.detail)
      expect(plan.some((detail) => detail.includes("COVERING INDEX idx_messages_window"))).toBe(true)
      expect(plan.some((detail) => detail.includes("sessions") || /\bSEARCH s\b/.test(detail))).toBe(false)
    }
  })
})

const planParams = (sql: string) => Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 1)

describe("migration to the flag", () => {
  test("the one backfill flags existing copies and leaves everything else", () => {
    const db = store()
    session(db, "root")
    session(db, "c1", "root")
    for (const name of ["messages_copy_ai", "messages_copy_ad", "sessions_copy_ai", "sessions_copy_au"]) {
      db.exec(assertSingleStatement(`DROP TRIGGER ${name}`))
    }
    message(db, "u", "c1")
    message(db, "u", "root")
    message(db, null, "c1", 3, 2)
    db.exec("DROP INDEX idx_messages_window")
    db.exec("PRAGMA user_version = 8")
    initSchema(db, { allowMigration: true })
    expect(flags(db, "u")).toEqual([
      { session_id: "c1", duplicate_of: UUID_COPY_FLAG },
      { session_id: "root", duplicate_of: null },
    ])
    expect((db.prepare("SELECT duplicate_of AS d FROM messages WHERE uuid IS NULL").get() as { d: number }).d).toBe(2)
  })
})
