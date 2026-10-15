/**
 * @failure  the prompt hook searched the vault with the verbatim prompt (an implicit AND that found nothing) or with
 *           a glossary scope that does not answer the question ("memory" for the Jev question, nothing for "ag status
 *           quota"), so both operator questions of 2026-10-14 went unanswered while the vault held the answers
 * @level    l1
 * @consumer lib/inject-core.ts call A (@ag/recall/three-dark-search-paths Phase 3, @cto 7f55e4f2)
 * @testonly none
 */
import { assertSingleStatement } from "@bearly/sqlite"
import { Database } from "bun:sqlite"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterEach, describe, expect, test, vi } from "vitest"

const roots: string[] = []

/** A km vault store holding the paths the anchor reads its root scopes and glossary from. */
function vaultWith(paths: string[]): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "recall-vault-anchor-"))
  roots.push(root)
  const dbPath = join(root, "state.db")
  const db = new Database(dbPath)
  db.exec(
    assertSingleStatement(
      "CREATE TABLE nodes (rowid INTEGER PRIMARY KEY, id TEXT, parent_id TEXT, fs_path TEXT, name TEXT, title TEXT, content TEXT);",
    ),
  )
  const insert = db.prepare("INSERT INTO nodes (id, fs_path, name, title, content) VALUES (?, ?, ?, ?, ?)")
  for (const path of paths) insert.run(path.replace(/\.md$/, ""), path, path, path, "")
  db.close()
  return dbPath
}

async function anchorFor(prompt: string, vault: string | null): Promise<unknown> {
  vi.resetModules()
  const { deriveVaultAnchor } = await import("../../src/history/vault-glossary.ts")
  return deriveVaultAnchor(prompt, vault)
}

afterEach(() => {
  for (const root of roots.splice(0)) safeRemoveSync(root, { within: realpathSync(tmpdir()) })
})

/** A vault store whose schema lacks the nodes table the glossary reads. */
function vaultWithoutNodes(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "recall-vault-anchor-"))
  roots.push(root)
  const dbPath = join(root, "state.db")
  const db = new Database(dbPath)
  db.exec(assertSingleStatement("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);"))
  db.close()
  return dbPath
}

const VAULT = [
  "@ag/code/29456-ag-quota-one-typed-reader-per-provider.md",
  "@i/20-search-and-memory/27897-memory-system.md",
  "@km/tui/14097-board.md",
]

describe("deriveVaultAnchor: the vault query is identifier-first, else the first three content words", () => {
  test("a proper noun mid-sentence is an identifier however short, and leads the query", async () => {
    expect(await anchorFor("how does the Jev memory system and smarter linting work?", vaultWith(VAULT))).toEqual({
      query: "Jev memory system",
      identifier: "Jev",
    })
  })

  test("a vault root scope is an identifier however short", async () => {
    expect(await anchorFor("what did we decide about ag status quota reporting?", vaultWith(VAULT))).toEqual({
      query: "ag status quota",
      identifier: "ag",
    })
  })

  test("kebab-case, camelCase, an @ref and a bead number are identifiers", async () => {
    const vault = vaultWith(VAULT)
    expect(await anchorFor("why does km-tui flicker when resized", vault)).toMatchObject({ identifier: "km-tui" })
    expect(await anchorFor("where is createTestApp defined today", vault)).toMatchObject({
      query: "createTestApp defined today",
    })
    expect(await anchorFor("status of @i/20-search-and-memory/27897-memory-system please", vault)).toMatchObject({
      identifier: "@i/20-search-and-memory/27897-memory-system",
    })
    expect(await anchorFor("what happened with 27897 yesterday", vault)).toMatchObject({ identifier: "27897" })
  })

  test("with no identifier, the first three content words; a sentence-initial capital or a stopword is no proper noun", async () => {
    const vault = vaultWith(VAULT)
    expect(await anchorFor("how should we structure the migration plan for storage", vault)).toEqual({
      query: "structure migration plan",
      identifier: null,
    })
    expect(await anchorFor("Check the logs for errors", vault)).toEqual({
      query: "check logs errors",
      identifier: null,
    })
    expect(await anchorFor("we fixed it and Now the deploy pipeline broke", vault)).toEqual({
      query: "fixed deploy pipeline",
      identifier: null,
    })
  })

  test("an unbound vault has no root scopes, so the same question falls back to its content words", async () => {
    expect(await anchorFor("what did we decide about ag status quota reporting?", null)).toEqual({
      query: "decide status quota",
      identifier: null,
    })
  })

  test("a prompt with no identifier and no content word has no anchor", async () => {
    expect(await anchorFor("ok do it now", vaultWith(VAULT))).toBeNull()
  })

  // @failure The glossary recorded the vault path before opening it, so a missing vault threw once and then read as
  // "no vault" for the life of the process: the anchor lost its root scopes silently (@dev/review2 20a9302c).
  test("a vault that cannot be opened refuses on every call in one process, never cached as no vault", async () => {
    vi.resetModules()
    const { deriveVaultAnchor } = await import("../../src/history/vault-glossary.ts")
    const missing = join(realpathSync(tmpdir()), "recall-vault-anchor-missing", "state.db")
    for (const attempt of [1, 2]) {
      expect(() => deriveVaultAnchor("ag status quota", missing), `attempt ${attempt}`).toThrowError(
        `Vault index ${missing} (bound by --vault-db) does not exist`,
      )
    }
  })
})

describe("a glossary query that fails on an open vault refuses, naming the vault, and caches nothing", () => {
  test("it throws on every call until the store answers, then builds", async () => {
    vi.resetModules()
    const { deriveVaultAnchor } = await import("../../src/history/vault-glossary.ts")
    const vault = vaultWithoutNodes()
    const refusal = `vault glossary ${vault}: no such table: nodes`

    expect(() => deriveVaultAnchor("what did we decide about ag status quota reporting?", vault)).toThrow(refusal)
    expect(() => deriveVaultAnchor("what did we decide about ag status quota reporting?", vault)).toThrow(refusal)

    const db = new Database(vault)
    db.exec(
      assertSingleStatement(
        "CREATE TABLE nodes (rowid INTEGER PRIMARY KEY, id TEXT, parent_id TEXT, fs_path TEXT, name TEXT, title TEXT, content TEXT);",
      ),
    )
    db.prepare("INSERT INTO nodes (id, fs_path) VALUES (?, ?)").run("q", "@ag/code/29456-quota.md")
    db.close()
    expect(deriveVaultAnchor("what did we decide about ag status quota reporting?", vault)).toEqual({
      query: "ag status quota",
      identifier: "ag",
    })
  })
})

describe("a slash token is a path only when it reads as one, never a prose pair (@cto 159a5acb, rule D)", () => {
  const vault = () => vaultWith([...VAULT, "@yrd/landing/27001-merge.md", "hub/rulings/26678-close-ruling.md"])

  test("and/or, they/them and A/B lead no vault query", async () => {
    const v = vault()
    expect(await anchorFor("keep the and/or wording in the merge queue notes", v)).toMatchObject({ identifier: null })
    expect(await anchorFor("they/them pronouns everywhere in reports", v)).toMatchObject({ identifier: null })
    expect(await anchorFor("rerun the A/B comparison tonight", v)).toMatchObject({ identifier: null })
  })

  test("a segment naming a vault root scope makes it a path, and it leads past a prose pair", async () => {
    expect(await anchorFor("the and/or rule in vendor/yrd queue", vault())).toMatchObject({
      query: "vendor/yrd queue",
      identifier: "vendor/yrd",
    })
  })

  test("a segment naming a vault directory makes it a path, with no digit, hyphen or root scope in it", async () => {
    expect(await anchorFor("what does hub/rulings say on closes", vault())).toMatchObject({ identifier: "hub/rulings" })
  })

  test("with no vault, a file path and a segment with a digit or hyphen still count", async () => {
    expect(await anchorFor("open docs/principles.md please", null)).toMatchObject({ identifier: "docs/principles.md" })
    expect(await anchorFor("watch dev/6 and tools/hh-cli today", null)).toMatchObject({ identifier: "dev/6" })
    expect(await anchorFor("keep the and/or wording", null)).toMatchObject({ identifier: null })
  })
})
