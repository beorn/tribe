/**
 * @failure the project-content exact total (C3: COUNT through the covering id-range probe) counts a different set of
 *   rows than the primary-key join it replaced, under a type, project or time filter
 * @level l2
 * @consumer @ag/recall/three-dark-search-paths
 * @testonly none
 *
 * CTO ee7e8bdd (GO on h3-design.md 470e18be), proof step 1. Requirement: searchAll's exact total equals the old
 * primary-key-join COUNT for every filter combination. Gap: existing tests pin totals on one unfiltered shape only;
 * none compares the count statement against the join across type, project, since and until. The invalid-MATCH throw
 * is already pinned in fanout.test.ts ("-budget").
 */
import { Database } from "bun:sqlite"
import { assertSingleStatement } from "@bearly/sqlite"
import { describe, expect, test } from "vitest"
import { initSchema } from "../../src/history/db-schema.ts"
import { searchAll, toFts5Query, upsertContent, type ContentSearchOptions } from "../../src/history/db-queries.ts"
import type { ContentType } from "../../src/history/types.ts"

const TOKEN = "countprobe"

function seed(): Database {
  const db = new Database(":memory:")
  db.exec("PRAGMA journal_mode = MEMORY")
  initSchema(db)
  const types: ContentType[] = ["bead", "doc", "session_memory", "llm_research", "claude_md", "project_memory"]
  for (let i = 0; i < 36; i++) {
    const type = types[i % types.length]!
    const project = i % 3 === 0 ? "/hh/alpha" : i % 3 === 1 ? "/hh/beta" : null
    const body = i % 4 === 0 ? `unrelated body ${String(i)}` : `${TOKEN} body ${String(i)}`
    upsertContent(db, type, `src-${String(i)}`, project, `title ${String(i)}`, body, 1_000 + i * 10)
  }
  return db
}

/** The COUNT searchAll ran before C3: a primary-key join to the content row for every match. */
function joinCount(db: Database, query: string, o: ContentSearchOptions): number {
  const params: (string | number)[] = [toFts5Query(query)]
  let where = "content_fts MATCH ?"
  if (o.types?.length) {
    where += ` AND c.content_type IN (${o.types.map(() => "?").join(",")})`
    params.push(...o.types)
  }
  if (o.projectFilter) {
    where += " AND c.project_path LIKE ?"
    params.push(`%${o.projectFilter}%`)
  }
  if (o.sinceTime !== undefined) {
    where += " AND c.timestamp >= ?"
    params.push(o.sinceTime)
  }
  if (o.untilTime !== undefined) {
    where += " AND c.timestamp <= ?"
    params.push(o.untilTime)
  }
  const sql = `SELECT COUNT(*) AS n FROM content_fts f JOIN content c ON f.rowid = c.id WHERE ${where}`
  return (db.prepare(assertSingleStatement(sql)).get(...params) as { n: number }).n
}

const CASES: [string, ContentSearchOptions][] = [
  ["no filter", {}],
  [
    "the recall leg's six types",
    { types: ["bead", "session_memory", "project_memory", "doc", "claude_md", "llm_research"] },
  ],
  ["two types", { types: ["bead", "doc"] }],
  ["an absent type", { types: ["project_memory"], projectFilter: "nowhere" }],
  ["project filter", { types: ["bead", "doc", "llm_research"], projectFilter: "alpha" }],
  ["since", { types: ["bead", "doc"], sinceTime: 1_150 }],
  ["until", { sinceTime: 1_050, untilTime: 1_250 }],
  [
    "everything",
    { types: ["doc", "llm_research", "claude_md"], projectFilter: "beta", sinceTime: 1_020, untilTime: 1_300 },
  ],
]

describe("project-content exact total through the covering probe (CTO ee7e8bdd C3)", () => {
  test.each(CASES)("%s: total equals the primary-key-join count", (_name, options) => {
    const db = seed()
    const expected = joinCount(db, TOKEN, options)
    expect(searchAll(db, TOKEN, { ...options, limit: 5 }).total).toBe(expected)
    db.close()
  })

  test("the cases are not vacuous: the filters give distinct non-zero totals", () => {
    const db = seed()
    const totals = CASES.map(([, o]) => joinCount(db, TOKEN, o))
    expect(totals[0]).toBe(27)
    expect(new Set(totals).size).toBeGreaterThan(5)
    db.close()
  })
})
