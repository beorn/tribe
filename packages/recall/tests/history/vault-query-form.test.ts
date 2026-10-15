/**
 * @failure  recall's CLI and agent search sent the whole question to the vault, and the vault query AND-joined every
 *           word of it as an exact term, so a natural-language question matched no vault row: 21 of 42 corpus
 *           questions returned none on 2026-10-15 while the vault held the answers (@dev/5's census at 11:40:11Z)
 * @level    l1
 * @consumer history/search.ts and lib/search.ts searchVault; lib/inject-core.ts call A (@ag/recall/29487, @cto 7c3f702c)
 * @testonly none
 */
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterEach, describe, expect, test, vi } from "vitest"

import { makeKmVault } from "../helpers/km-vault.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) safeRemoveSync(root, { within: realpathSync(tmpdir()) })
})

// The specimen's shape: the record names Jev and its memory system and says "lint", never "linting"; a second node
// shares only the common words.
const NODES = [
  {
    id: "@i/20-search-and-memory/27897-memory-system",
    fsPath: "@i/20-search-and-memory/27897-memory-system.md",
    title: "Memory system",
    content: "The Jev memory system design: what we keep, and Jev for smarter lint.",
  },
  {
    id: "@km/tui/14097-board",
    fsPath: "@km/tui/14097-board.md",
    title: "Board",
    content: "A memory leak in the system tray of the board view.",
  },
]

async function search(query: string, nodes = NODES): Promise<unknown> {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "recall-vault-query-"))
  roots.push(root)
  vi.resetModules()
  const { searchVault } = await import("../../src/history/vault-fts.ts")
  return searchVault(query, 10, makeKmVault(root, nodes))
}

/** The rows a search returned, read from the receipt (or from the bare list searchVault returned before 29487). */
function paths(result: unknown): string[] {
  type Row = { fsPath: string | null }
  const rows: Row[] = Array.isArray(result) ? (result as Row[]) : (result as { matches: Row[] }).matches
  return rows.map((row) => row.fsPath ?? "")
}

describe("searchVault: content terms, conjunction first, then a bm25-ranked disjunction", () => {
  test("the specimen question finds the record, and the receipt names the form, terms and unmatched terms", async () => {
    const result = await search("how does the Jev memory system and smarter linting work?")

    expect(paths(result)[0]).toBe("@i/20-search-and-memory/27897-memory-system.md")
    expect(result).toMatchObject({
      form: "any",
      terms: ["how", "Jev", "memory", "system", "smarter", "linting", "work"],
      unmatched: ["how", "linting", "work"],
      matched: 2,
    })
  })

  test("a conjunction that matches is kept: every row holds every term, and nothing is unmatched", async () => {
    const result = await search("Jev memory system")

    expect(paths(result)).toEqual(["@i/20-search-and-memory/27897-memory-system.md"])
    expect(result).toMatchObject({ form: "all", terms: ["Jev", "memory", "system"], unmatched: [], matched: 1 })
  })

  test("zero rows after the fallback still names the terms, each unmatched", async () => {
    const result = await search("quokka zebra")

    expect(paths(result)).toEqual([])
    expect(result).toMatchObject({
      form: "any",
      terms: ["quokka", "zebra"],
      unmatched: ["quokka", "zebra"],
      matched: 0,
    })
  })

  test("a query with no term once the stopwords go searches nothing, and says so: a different fact from found nothing", async () => {
    const result = await search("what is this")

    expect(paths(result)).toEqual([])
    expect(result).toMatchObject({ form: "none", terms: [], unmatched: [], matched: 0 })
  })

  // @cto 03d64a82 item 3: a generic term swamps the window (silvery matched 11,891 vault rows), and the window's length
  // cannot say so; the receipt carries the rows the form matched.
  test("the receipt counts the rows the form matched, beyond the window it returns", async () => {
    const notes = Array.from({ length: 14 }, (_, i) => ({
      id: `@km/silvery/${String(i)}-note`,
      fsPath: `@km/silvery/${String(i)}-note.md`,
      title: `Note ${String(i)}`,
      content: `silvery renders frame ${String(i)}`,
    }))
    const result = await search("silvery", [...NODES, ...notes])

    expect(paths(result)).toHaveLength(10)
    expect(result).toMatchObject({ form: "all", terms: ["silvery"], matched: 14 })
  })

  test("a query written in FTS syntax (a quoted phrase, a -negation) runs as written", async () => {
    const result = await search('"memory leak" -Jev')

    expect(paths(result)).toEqual(["@km/tui/14097-board.md"])
    expect(result).toMatchObject({ form: "as-written", matched: 1 })
  })
})
