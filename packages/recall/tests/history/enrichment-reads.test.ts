/**
 * @failure a search reads a whole session to expand one hit, or probes an index once per all-time match to weigh
 *   sessions, and a common query misses the first-run bar on those two steps alone
 * @level l1
 * @consumer @ag/recall/three-dark-search-paths
 * @testonly none
 *
 * CTO aab6a992. Requirement: proximity centres on the hit's own row, and depth comes from rows the search already holds.
 * Gap: existing tests never read which statements enrichment runs, and none has two rows sharing a timestamp.
 */
import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

process.env.RECALL_DB_PATH = ":memory:"

let closeDb: (typeof import("../../src/history/db"))["closeDb"]
let getDb: (typeof import("../../src/history/db"))["getDb"]
let getSessionContext: (typeof import("../../src/history/db"))["getSessionContext"]
let ftsSearchWithSnippet: (typeof import("../../src/history/db"))["ftsSearchWithSnippet"]
let recall: (typeof import("../../src/history/search"))["recall"]

const TOKEN = "enrichtoken"
const FILLER = "plain neighbouring words"

beforeEach(async () => {
  vi.resetModules()
  ;({ closeDb, getDb, getSessionContext, ftsSearchWithSnippet } = await import("../../src/history/db"))
  ;({ recall } = await import("../../src/history/search"))
})

afterEach(() => closeDb())

type Row = { session: string; content: string; timestamp: number }

function seed(rows: Row[]): number[] {
  const db: Database = getDb()
  const insertSession = db.prepare(
    `INSERT OR IGNORE INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertMessage = db.prepare(
    `INSERT INTO messages (uuid, session_id, type, content, timestamp) VALUES (?, ?, ?, ?, ?)`,
  )
  return rows.map((row, i) => {
    insertSession.run(row.session, "/test", `/tmp/${row.session}.jsonl`, 1, 1, 1, row.session)
    return Number(insertMessage.run(`u-${i}`, row.session, "user", row.content, row.timestamp).lastInsertRowid)
  })
}

const matches = (session: string, n: number, timestamp: number): Row[] =>
  Array.from({ length: n }, () => ({ session, content: `${TOKEN} ${FILLER}`, timestamp }))

async function preparedSql(run: () => Promise<unknown>): Promise<string[]> {
  const db = getDb()
  const original = db.prepare
  const prepare = original.bind(db)
  const sql: string[] = []
  db.prepare = ((statement: string) => {
    sql.push(statement)
    return prepare(statement)
  }) as typeof db.prepare
  try {
    await run()
  } finally {
    db.prepare = original
  }
  return sql
}

describe("depth comes from the rows the exact search holds", () => {
  test("it counts past the page, up to the over-fetch, per session", () => {
    const now = Date.now()
    seed([...matches("deep", 6, now), ...matches("thin", 1, now)])
    const { results, sessionDepths } = ftsSearchWithSnippet(getDb(), TOKEN, { limit: 2 })
    expect(results).toHaveLength(2)
    expect(sessionDepths).toEqual(
      new Map([
        ["deep", 6],
        ["thin", 1],
      ]),
    )
  })

  test("it stops at the over-fetch, four times the page need, never all time", () => {
    seed(matches("wide", 30, Date.now()))
    expect(ftsSearchWithSnippet(getDb(), TOKEN, { limit: 2 }).sessionDepths.get("wide")).toBe(8)
  })
})

describe("depth never ranks a deeper session below a thinner one", () => {
  test("identical text at the same time: the session with more matches comes first or ties", async () => {
    const now = Date.now()
    seed([...matches("deep", 7, now), ...matches("thin", 1, now)])
    const { results } = await recall(TOKEN, { raw: true, limit: 5, excludeCurrentSession: true })
    const rank = (session: string) => results.find((r) => r.sessionId === session)?.rank ?? 0
    expect(rank("deep")).toBeLessThan(0)
    expect(rank("deep")).toBeLessThanOrEqual(rank("thin"))
  })
})

describe("enrichment runs no statement sized by the session or by every match", () => {
  test("recall prepares no closest-row walk and no per-match depth read", async () => {
    seed(matches("s", 3, Date.now()))
    const sql = await preparedSql(() => recall(TOKEN, { raw: true, limit: 5, excludeCurrentSession: true }))
    expect(sql.length).toBeGreaterThan(0)
    expect(
      sql.filter((statement) => /ABS\(timestamp|GROUP BY m\.session_id|idx_messages_id_session_ts/.test(statement)),
    ).toEqual([])
  })
})

describe("proximity centres on the hit", () => {
  test("rows sharing a timestamp: the neighbours surround the hit, not the first tied row", () => {
    const at = Date.now()
    const ids = seed(Array.from({ length: 9 }, (_, i) => ({ session: "tied", content: `row ${i}`, timestamp: at })))
    const hit = ids[6]!
    expect(getSessionContext(getDb(), "tied", hit, 1).map((row) => row.id)).toEqual([hit - 1, hit, hit + 1])
  })

  test("the expanded snippet reaches the hit's neighbour through recall, and the result gains no field", async () => {
    const at = Date.now()
    seed([
      ...Array.from({ length: 12 }, (_, i) => ({ session: "tied", content: `early${i}`, timestamp: at })),
      { session: "tied", content: `before the hit`, timestamp: at },
      { session: "tied", content: `${TOKEN} here`, timestamp: at },
      { session: "tied", content: `after the hit`, timestamp: at },
    ])
    const { results } = await recall(TOKEN, { raw: true, limit: 5, excludeCurrentSession: true })
    const result = results.find((r) => r.type === "message")
    expect(result?.snippet).toContain("after the hit")
    expect(result?.snippet).not.toContain("early0")
    expect(Object.keys(result ?? {})).not.toContain("id")
    expect(Object.keys(result ?? {})).not.toContain("messageId")
  })
})
