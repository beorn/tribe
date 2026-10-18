/**
 * @failure recall exact top-N fills with forked-codex copies that share uuid NULL, hiding later distinct hits
 * @level l2
 * @consumer @ag/recall/29964-codex-null-uuid-copies-fill
 * @testonly none
 *
 * Specimen class (item-119-lexical): ten forked sessions, same text at the same line, uuid NULL,
 * plus one later distinct row. Exact n=10 must show one copy plus that distinct row; total stays the raw count.
 */
import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"
import { describe, expect, test } from "vitest"
import { initSchema } from "../../src/history/db-schema.ts"
import { ftsSearchWithSnippet, insertMessage, upsertSession } from "../../src/history/db-queries.ts"

const TOKEN = "item119lexical"
const COPY = `${TOKEN} Ag is pushed at e1efc5dc on current main, with 229/230 green?`
const OTHER = `${TOKEN} a different later hit about lanterns beside eleven quiet harbours`
const COPY_LINE = 5255

function snippetHash(content: string | null): string {
  return createHash("sha256")
    .update(content ?? "")
    .digest("hex")
    .slice(0, 8)
}

function seedForkCopies(copyCount: number, extras: { content: string; line: number }[] = []): Database {
  const db = new Database(":memory:")
  db.exec("PRAGMA journal_mode = MEMORY")
  initSchema(db)
  const now = Date.now()
  const parent = "codex:parent"
  upsertSession(db, parent, "/test", `/tmp/${parent}.jsonl`, now, now, 1, parent)
  insertMessage(db, null, parent, "user", COPY, null, null, now, null, COPY_LINE)
  for (let i = 1; i < copyCount; i++) {
    const id = `codex:fork-${String(i)}`
    upsertSession(db, id, "/test", `/tmp/${id}.jsonl`, now, now, 1, id, { parentSessionId: parent })
    insertMessage(db, null, id, "user", COPY, null, null, now + i, null, COPY_LINE)
  }
  for (const [i, extra] of extras.entries()) {
    const id = `codex:other-${String(i)}`
    upsertSession(db, id, "/test", `/tmp/${id}.jsonl`, now, now, 1, id)
    insertMessage(db, null, id, "user", extra.content, null, null, now + 1000 + i, null, extra.line)
  }
  return db
}

describe("null-uuid copy collapse (29964)", () => {
  test("exact limit 10 keeps one fork copy and the next distinct row; total stays raw", () => {
    const db = seedForkCopies(10, [{ content: OTHER, line: 100 }])
    const page = ftsSearchWithSnippet(db, TOKEN, { limit: 10 })
    const contents = page.results.map((row) => row.content)
    expect(page.total).toBe(11)
    expect(contents.filter((c) => c === COPY)).toHaveLength(1)
    expect(contents).toContain(OTHER)
    expect(new Set(page.results.map((row) => `${String(row.line)}\0${snippetHash(row.content)}`)).size).toBeGreaterThan(
      1,
    )
  })

  test("hook limit 10 collapses copies before the page slice", () => {
    const db = seedForkCopies(10, [{ content: OTHER, line: 100 }])
    const page = ftsSearchWithSnippet(db, TOKEN, { mode: "hook", limit: 10 })
    const contents = page.results.map((row) => row.content)
    expect(contents.filter((c) => c === COPY)).toHaveLength(1)
    expect(contents).toContain(OTHER)
  })

  test("exact over-fetch cap is loud when copies exhaust the window", () => {
    const db = seedForkCopies(50)
    const page = ftsSearchWithSnippet(db, TOKEN, { limit: 10 })
    expect(page.total).toBe(50)
    expect(page.results.filter((row) => row.content === COPY)).toHaveLength(1)
    expect(page.capped?.kind).toBe("candidate-cap")
    expect(page.capped?.message).toMatch(/null-uuid copy collapse/)
  })
})
