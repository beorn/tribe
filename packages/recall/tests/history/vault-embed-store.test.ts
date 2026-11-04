/**
 * @failure Vault semantic vectors could be served from a different model or contract than the one that made them.
 *
 * Requirement (issue @ag/recall/three-dark-search-paths, slice 1; CTO D1/D4 at 9686f199 as amended by 3572804d):
 * session-index.db gains vault_embed_generation and vault_doc_embed through SCHEMA (CREATE TABLE IF NOT EXISTS,
 * user_version unchanged); every generation records its contract identity and GGUF digest; a published generation
 * whose contract or digest differs from the running one is refused loudly, never silently reused.
 * Gap: no existing test covers these tables or any embedding identity; migration-versioning.test.ts only pins
 * user_version stepping. All fixtures are private in-memory databases with fixture vectors; no model is loaded.
 */
import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { CURRENT_SCHEMA_VERSION, initSchema } from "../../src/history/db-schema"
import {
  beginVaultEmbedGeneration,
  contractIdentity,
  decodeVaultVector,
  encodeVaultVector,
  publishVaultEmbedGeneration,
  readPublishedVaultEmbedGeneration,
  requireMatchingVaultEmbedGeneration,
  vaultInputKey,
  type VaultEmbedContract,
} from "../../src/history/vault-embed-store"

const CONTRACT: VaultEmbedContract = {
  model: "fixture-embed",
  dimensions: 4,
  pooling: "mean",
  contextTokens: 2048,
  queryPrefix: "query: ",
  documentPrefix: "doc: ",
  chunkTokens: 900,
  overlapTokens: 135,
  windowTokens: 200,
}
const GGUF = "b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63"
const OTHER_GGUF = "0".repeat(64)

const tableNames = (db: Database): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
    (row) => row.name,
  )
const userVersion = (db: Database): number =>
  (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
const schemaText = (db: Database): string =>
  (db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all() as { sql: string | null }[])
    .map((row) => row.sql ?? "")
    .join("\n")

describe("vault embedding tables in SCHEMA", () => {
  let db: Database
  beforeEach(() => {
    db = new Database(":memory:")
  })
  afterEach(() => db.close())

  test("a fresh database gets both tables", () => {
    initSchema(db)
    expect(tableNames(db)).toEqual(expect.arrayContaining(["vault_embed_generation", "vault_doc_embed"]))
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
  })

  test("opening an existing version-6 database adds both tables, keeps user_version and changes no row", () => {
    initSchema(db)
    db.exec("DROP TABLE vault_doc_embed")
    db.exec("DROP TABLE vault_embed_generation")
    db.prepare(
      "INSERT INTO writes (session_id, session_file, tool_use_id, timestamp, file_path, content_hash, content_size, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("s1", "/f.jsonl", "t1", "2026-11-03T00:00:00Z", "/a.md", "h1", 3, "abc")
    const versionBefore = userVersion(db)
    expect(versionBefore).toBe(6)
    const rowsBefore = db.prepare("SELECT * FROM writes").all()

    initSchema(db)

    expect(tableNames(db)).toEqual(expect.arrayContaining(["vault_embed_generation", "vault_doc_embed"]))
    expect(userVersion(db)).toBe(versionBefore)
    expect(db.prepare("SELECT * FROM writes").all()).toEqual(rowsBefore)
  })

  test("a second open is a no-op", () => {
    initSchema(db)
    const before = schemaText(db)
    const versionBefore = userVersion(db)
    initSchema(db)
    expect(schemaText(db)).toBe(before)
    expect(userVersion(db)).toBe(versionBefore)
  })

  test("the tables have exactly the ruled D1 columns and primary key", () => {
    initSchema(db)
    const columns = (table: string) =>
      (db.prepare("SELECT name, pk FROM pragma_table_info(?)").all(table) as { name: string; pk: number }[]).map(
        (c) => [c.name, c.pk],
      )
    expect(columns("vault_embed_generation")).toEqual([
      ["id", 1],
      ["contract_json", 0],
      ["gguf_sha256", 0],
      ["created_at", 0],
      ["state", 0],
    ])
    expect(columns("vault_doc_embed")).toEqual([
      ["generation", 1],
      ["vault_id", 2],
      ["fs_path", 3],
      ["doc_hash", 4],
      ["chunk", 5],
      ["input_key", 0],
      ["vec", 0],
    ])
    expect(() =>
      db
        .prepare(
          "INSERT INTO vault_embed_generation (contract_json, gguf_sha256, created_at, state) VALUES ('{}', ?, 1, 'live')",
        )
        .run(GGUF),
    ).toThrow()
  })
})

describe("vault embedding generation identity", () => {
  let db: Database
  beforeEach(() => {
    db = new Database(":memory:")
    initSchema(db)
  })
  afterEach(() => db.close())

  test("a published generation records the contract identity and GGUF digest", () => {
    const id = beginVaultEmbedGeneration(db, { contract: CONTRACT, ggufSha256: GGUF, now: 1000 })
    expect(readPublishedVaultEmbedGeneration(db)).toBeNull()
    publishVaultEmbedGeneration(db, id)
    expect(readPublishedVaultEmbedGeneration(db)).toEqual({
      id,
      contractJson: contractIdentity(CONTRACT),
      ggufSha256: GGUF,
    })
  })

  test("publishing a new generation retires the previous one, so exactly one is published", () => {
    const first = beginVaultEmbedGeneration(db, { contract: CONTRACT, ggufSha256: GGUF, now: 1 })
    publishVaultEmbedGeneration(db, first)
    const second = beginVaultEmbedGeneration(db, { contract: CONTRACT, ggufSha256: GGUF, now: 2 })
    publishVaultEmbedGeneration(db, second)
    const states = db.prepare("SELECT id, state FROM vault_embed_generation ORDER BY id").all()
    expect(states).toEqual([
      { id: first, state: "retired" },
      { id: second, state: "published" },
    ])
  })

  test("contract identity is canonical: key order does not change it, any value does", () => {
    const reordered = Object.fromEntries(Object.entries(CONTRACT).reverse()) as unknown as VaultEmbedContract
    expect(contractIdentity(reordered)).toBe(contractIdentity(CONTRACT))
    expect(contractIdentity({ ...CONTRACT, chunkTokens: 800 })).not.toBe(contractIdentity(CONTRACT))
  })

  test("a published generation with a different GGUF digest is refused loudly, naming both digests", () => {
    publishVaultEmbedGeneration(db, beginVaultEmbedGeneration(db, { contract: CONTRACT, ggufSha256: GGUF, now: 1 }))
    expect(() => requireMatchingVaultEmbedGeneration(db, CONTRACT, OTHER_GGUF)).toThrow(
      new RegExp(`${GGUF}.*${OTHER_GGUF}|${OTHER_GGUF}.*${GGUF}`),
    )
  })

  test("a published generation with a different contract is refused loudly", () => {
    publishVaultEmbedGeneration(db, beginVaultEmbedGeneration(db, { contract: CONTRACT, ggufSha256: GGUF, now: 1 }))
    expect(() => requireMatchingVaultEmbedGeneration(db, { ...CONTRACT, documentPrefix: "other: " }, GGUF)).toThrow(
      /contract/,
    )
  })

  test("a matching published generation is returned; none published returns null", () => {
    expect(requireMatchingVaultEmbedGeneration(db, CONTRACT, GGUF)).toBeNull()
    const id = beginVaultEmbedGeneration(db, { contract: CONTRACT, ggufSha256: GGUF, now: 1 })
    publishVaultEmbedGeneration(db, id)
    expect(requireMatchingVaultEmbedGeneration(db, CONTRACT, GGUF)?.id).toBe(id)
  })

  test("a GGUF digest that is not 64 lowercase hex characters is refused", () => {
    expect(() => beginVaultEmbedGeneration(db, { contract: CONTRACT, ggufSha256: "abc", now: 1 })).toThrow(/sha256/i)
  })
})

describe("vault input keys and vectors", () => {
  test("the input key is the sha256 of the contract identity and the formatted input", () => {
    const identity = contractIdentity(CONTRACT)
    const key = vaultInputKey(identity, "doc: hello")
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(vaultInputKey(identity, "doc: hello")).toBe(key)
    expect(vaultInputKey(identity, "doc: hello!")).not.toBe(key)
    expect(vaultInputKey(contractIdentity({ ...CONTRACT, model: "other" }), "doc: hello")).not.toBe(key)
  })

  test("a vector round-trips as raw Float32 and a wrong dimension is refused", () => {
    const vec = new Float32Array([0.5, -1, 2, 0.25])
    const blob = encodeVaultVector(vec, CONTRACT.dimensions)
    expect(blob.byteLength).toBe(16)
    expect(Array.from(decodeVaultVector(blob, CONTRACT.dimensions))).toEqual([0.5, -1, 2, 0.25])
    expect(() => encodeVaultVector(new Float32Array(3), CONTRACT.dimensions)).toThrow(/dimension/)
    expect(() => decodeVaultVector(new Uint8Array(12), CONTRACT.dimensions)).toThrow(/dimension/)
  })
})
