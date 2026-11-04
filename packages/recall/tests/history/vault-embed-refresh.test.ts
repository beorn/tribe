/**
 * @failure The vault embedding refresh could embed stale bytes, re-embed unchanged chunks, or leave a half-written document.
 * @level l1
 * @consumer @ag/recall/three-dark-search-paths (vault semantic leg, slice 2: refresh producer, CTO O2(b) 0609d989)
 * @testonly none
 *
 * Requirement (CTO 0609d989 rules 1, 3, 4 and the settled-first order): a pass embeds only chunks whose input_key has
 * no vector in the target generation; it embeds a document only when its file bytes hash to km's current
 * fs_content_hash; it writes one transaction per document and prunes that path's older rows after the commit; it
 * takes documents oldest fs_mtime first, so a spent budget leaves the newest documents uncovered and reported.
 * Gap: slice 1 tests cover storage and identity only; nothing exercises a refresh. Fixtures are private: an
 * in-memory km-shaped nodes table, files in a temp dir, a paragraph chunker and a hash-derived 4-dimension embedder.
 */
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { initSchema } from "../../src/history/db-schema"
import {
  refreshVaultEmbeddings,
  type VaultEmbedChunker,
  type VaultEmbedder,
} from "../../src/history/vault-embed-refresh"
import {
  beginVaultEmbedGeneration,
  contractIdentity,
  decodeVaultVector,
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
  qmdVersion: "2.8.3",
  qmdStoreSha256: "a".repeat(64),
  qmdLlmSha256: "b".repeat(64),
}
const GGUF = "b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63"
const VAULT = "/fixture/vault/state.db"
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

const chunker: VaultEmbedChunker = {
  chunk: async (content) => content.split("\n\n").map((text) => ({ text })),
  title: (content) => content.split("\n")[0] ?? "",
  format: async (text, title) => `doc: ${title} | ${text}`,
}

function recordingEmbedder(): VaultEmbedder & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    embed: async (inputs) => {
      calls.push(inputs)
      return inputs.map((input) => {
        const bytes = createHash("sha256").update(input).digest()
        return new Float32Array([bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!])
      })
    },
  }
}

describe("refreshVaultEmbeddings", () => {
  let db: Database
  let vault: Database
  let root: string
  let generation: number

  const putFile = (fsPath: string, content: string, mtime: number, hash: string | null = sha256(content)) => {
    writeFileSync(join(root, fsPath), content)
    vault.prepare("DELETE FROM nodes WHERE fs_path = ?").run(fsPath)
    vault
      .prepare("INSERT INTO nodes (id, fstype, fs_path, fs_mtime, fs_content_hash) VALUES (?, 'mdfile', ?, ?, ?)")
      .run(`n:${fsPath}`, fsPath, mtime, hash)
  }
  const run = (embedder: VaultEmbedder, extra: { budgetDocuments?: number } = {}) => {
    let left = extra.budgetDocuments ?? Number.POSITIVE_INFINITY
    return refreshVaultEmbeddings({
      db,
      vaultDb: vault,
      vaultId: VAULT,
      vaultRoot: root,
      generation,
      contract: CONTRACT,
      chunker,
      embedder,
      budgetSpent: () => left-- <= 0,
    })
  }
  const rows = () =>
    db.prepare("SELECT fs_path, doc_hash, chunk, input_key FROM vault_doc_embed ORDER BY fs_path, chunk").all() as {
      fs_path: string
      doc_hash: string
      chunk: number
      input_key: string
    }[]

  beforeEach(() => {
    db = new Database(":memory:")
    initSchema(db)
    generation = beginVaultEmbedGeneration(db, { contract: CONTRACT, ggufSha256: GGUF, now: 1 })
    vault = new Database(":memory:")
    vault.exec(
      "CREATE TABLE nodes (id TEXT PRIMARY KEY, fstype TEXT, fs_path TEXT, fs_mtime INTEGER, fs_content_hash TEXT)",
    )
    root = mkdtempSync(join(tmpdir(), "recall-vault-refresh-"))
  })
  afterEach(() => {
    db.close()
    vault.close()
    safeRemoveSync(root, { within: tmpdir() })
  })

  test("embeds each chunk once, keyed by input_key, and a second pass embeds nothing", async () => {
    putFile("a.md", "Alpha\n\none\n\ntwo", 10)
    const embedder = recordingEmbedder()
    const first = await run(embedder)
    expect(first).toMatchObject({ embeddedDocuments: 1, embeddedChunks: 3, reusedChunks: 0 })
    const stored = rows()
    expect(stored.map((r) => [r.fs_path, r.doc_hash, r.chunk])).toEqual([
      ["a.md", sha256("Alpha\n\none\n\ntwo"), 0],
      ["a.md", sha256("Alpha\n\none\n\ntwo"), 1],
      ["a.md", sha256("Alpha\n\none\n\ntwo"), 2],
    ])
    expect(stored[1]!.input_key).toBe(
      createHash("sha256").update(contractIdentity(CONTRACT)).update("\0").update("doc: Alpha | one").digest("hex"),
    )
    const vec = db.prepare("SELECT vec FROM vault_doc_embed WHERE chunk = 0").get() as { vec: Uint8Array }
    expect(decodeVaultVector(vec.vec, 4)).toHaveLength(4)

    const second = await run(embedder)
    expect(second).toMatchObject({ embeddedDocuments: 0, embeddedChunks: 0, coveredDocuments: 1 })
    expect(embedder.calls).toHaveLength(1)
  })

  test("an edit re-embeds only the changed chunk and prunes the path's older rows after commit", async () => {
    putFile("a.md", "Alpha\n\none\n\ntwo", 10)
    const embedder = recordingEmbedder()
    await run(embedder)
    putFile("a.md", "Alpha\n\none\n\nTWO", 20)
    const report = await run(embedder)
    expect(report).toMatchObject({ embeddedDocuments: 1, embeddedChunks: 1, reusedChunks: 2 })
    expect(embedder.calls[1]).toEqual(["doc: Alpha | TWO"])
    expect(new Set(rows().map((r) => r.doc_hash))).toEqual(new Set([sha256("Alpha\n\none\n\nTWO")]))
  })

  test("bytes that do not hash to km's current fs_content_hash are not embedded and are reported", async () => {
    putFile("a.md", "Alpha\n\none", 10, sha256("an older version"))
    const report = await run(recordingEmbedder())
    expect(report.embeddedDocuments).toBe(0)
    expect(report.uncovered).toEqual({ "file bytes differ from km's recorded hash": 1 })
    expect(rows()).toEqual([])
  })

  test("a NULL km hash leaves the document uncovered with its named reason", async () => {
    putFile("a.md", "Alpha", 10, null)
    const report = await run(recordingEmbedder())
    expect(report.uncovered).toEqual({ "km has not recorded this file's hash": 1 })
    expect(rows()).toEqual([])
  })

  test("documents go oldest fs_mtime first; a spent budget leaves the newest uncovered and reported", async () => {
    putFile("new.md", "New\n\nn", 300)
    putFile("old.md", "Old\n\no", 100)
    putFile("mid.md", "Mid\n\nm", 200)
    const embedder = recordingEmbedder()
    const report = await run(embedder, { budgetDocuments: 2 })
    expect(embedder.calls.map((call) => call[0])).toEqual(["doc: Old | Old", "doc: Mid | Mid"])
    expect(report).toMatchObject({ embeddedDocuments: 2, stoppedEarly: true })
    expect(report.uncovered).toEqual({ "refresh budget spent before this document": 1 })
    expect(new Set(rows().map((r) => r.fs_path))).toEqual(new Set(["old.md", "mid.md"]))
  })

  test("a failure on one document leaves earlier documents committed, writes none of its rows, and throws", async () => {
    putFile("a.md", "A\n\na", 10)
    putFile("b.md", "B\n\nb", 20)
    const failing: VaultEmbedder = {
      embed: async (inputs) => {
        if (inputs.some((input) => input.startsWith("doc: B"))) throw new Error("fixture embedder failed on B")
        return recordingEmbedder().embed(inputs)
      },
    }
    await expect(run(failing)).rejects.toThrow(/b\.md.*fixture embedder failed on B/)
    expect(new Set(rows().map((r) => r.fs_path))).toEqual(new Set(["a.md"]))
  })

  test("an embedder that returns the wrong number of vectors is refused loudly", async () => {
    putFile("a.md", "A\n\na", 10)
    const short: VaultEmbedder = { embed: async () => [new Float32Array(4)] }
    await expect(run(short)).rejects.toThrow(/2 inputs.*1 vector/)
    expect(rows()).toEqual([])
  })
})
