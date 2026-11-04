/**
 * @failure The one-time qmd seed could copy vectors for stale text, an incomplete set, or another model's vectors.
 * @level l1
 * @consumer @ag/recall/three-dark-search-paths (vault semantic leg, slice 2: one-time seed, CTO 0609d989 rule 5)
 * @testonly none
 *
 * Requirement (CTO 0609d989 rule 5, 9686f199 conditions 1-2, D4): the seed copies a document's qmd vectors only when
 * km's current fs_content_hash equals qmd's stored hash and qmd's vector set for that hash is complete; input keys
 * come from running the chunker, never from an embedding; each document is one transaction; a qmd store with no
 * vectors for the expected model and fingerprint is refused loudly, naming what it holds. CTO r2 change 3 (b7e7f718,
 * ruling 17): qmd records no path it embedded under, so a document whose title depends on its path (headingless) is
 * skipped by name and left to the refresh; a renamed document with a heading is seeded under its own title.
 * Gap: no test reads a qmd store. The fixture store is built by qmd's own createStore, insertContent and
 * insertEmbedding in a temp dir, with 4-dimension vectors; no model is loaded.
 */
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStore, getEmbeddingFingerprint, insertContent, insertEmbedding, type Store } from "@tobilu/qmd/store"
import { safeRemoveSync } from "removely"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { initSchema } from "../../src/history/db-schema"
import type { VaultEmbedChunker } from "../../src/history/vault-embed-refresh"
import { SEED_SKIP_HEADINGLESS, seedVaultEmbeddingsFromQmd } from "../../src/history/vault-embed-seed"
import {
  beginVaultEmbedGeneration,
  contractIdentity,
  decodeVaultVectorInto,
  vaultInputKey,
  type VaultEmbedContract,
} from "../../src/history/vault-embed-store"

const CONTRACT: VaultEmbedContract = {
  model: "fixture-embed",
  modelSha256: "b".repeat(64),
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
const QMD_MODEL = "hf:fixture/embed.gguf"
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")
const chunker: VaultEmbedChunker = {
  chunk: async (content) => content.split("\n\n").map((text) => ({ text })),
  // A capitalized first line stands for a heading; a headingless document is titled by its path, as qmd's is.
  title: (content, fsPath) => (/^[A-Z]/.test(content) ? (content.split("\n")[0] ?? "") : fsPath),
  format: async (text, title) => `doc: ${title} | ${text}`,
}

describe("seedVaultEmbeddingsFromQmd", () => {
  let dir: string
  let qmd: Store
  let db: Database
  let vault: Database
  let generation: number

  const qmdDoc = (content: string, chunks: number[] | "all", model = QMD_MODEL) => {
    const hash = sha256(content)
    insertContent(qmd.db, hash, content, "2026-11-01")
    const parts = content.split("\n\n")
    parts.forEach((_, seq) => {
      if (chunks !== "all" && !chunks.includes(seq)) return
      insertEmbedding(qmd.db, hash, seq, 0, new Float32Array([seq, 1, 2, 3]), model, "2026-11-01", parts.length)
    })
    return hash
  }
  const kmDoc = (fsPath: string, hash: string | null, mtime = 1) =>
    vault.prepare("INSERT INTO nodes VALUES (?, 'mdfile', ?, ?, ?)").run(`n:${fsPath}`, fsPath, mtime, hash)
  const seed = () =>
    seedVaultEmbeddingsFromQmd({
      db,
      qmdDb: qmd.db as unknown as Database,
      vaultDb: vault,
      vaultId: "/v/.km/state.db",
      generation,
      contract: CONTRACT,
      chunker,
      qmdModel: QMD_MODEL,
    })
  const rows = () =>
    db
      .prepare("SELECT fs_path, doc_hash, chunk, input_key, vec FROM vault_doc_embed ORDER BY fs_path, chunk")
      .all() as {
      fs_path: string
      doc_hash: string
      chunk: number
      input_key: string
      vec: Uint8Array
    }[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "recall-vault-seed-"))
    qmd = createStore(join(dir, "index.sqlite"))
    qmd.ensureVecTable(4)
    db = new Database(":memory:")
    initSchema(db)
    generation = beginVaultEmbedGeneration(db, {
      contract: CONTRACT,
      ggufSha256: "c".repeat(64),
      ggufStat: "m:1:1",
      now: 1,
    })
    vault = new Database(":memory:")
    vault.exec(
      "CREATE TABLE nodes (id TEXT PRIMARY KEY, fstype TEXT, fs_path TEXT, fs_mtime INTEGER, fs_content_hash TEXT)",
    )
  })
  afterEach(() => {
    qmd.close()
    db.close()
    vault.close()
    safeRemoveSync(dir, { within: tmpdir() })
  })

  test("a complete qmd set whose hash is km's current hash is copied with chunker-derived input keys", async () => {
    const hash = qmdDoc("Alpha\n\none", "all")
    kmDoc("a.md", hash)
    const report = await seed()
    expect(report).toMatchObject({ seededDocuments: 1, seededChunks: 2 })
    const stored = rows()
    expect(stored.map((r) => [r.fs_path, r.doc_hash, r.chunk])).toEqual([
      ["a.md", hash, 0],
      ["a.md", hash, 1],
    ])
    expect(stored[1]?.input_key).toBe(vaultInputKey(contractIdentity(CONTRACT), "doc: Alpha | one"))
    expect(Array.from(decodeVaultVectorInto(stored[1]!.vec, new Float32Array(4)))).toEqual([1, 1, 2, 3])
  })

  test("a headingless document, whose title depends on a path qmd never recorded, is skipped by name", async () => {
    kmDoc("new-name.md", qmdDoc("plain\n\none", "all"))
    const report = await seed()
    expect(report.skipped).toEqual({ [SEED_SKIP_HEADINGLESS]: 1 })
    expect(rows()).toEqual([])
  })

  test("a document with a heading is seeded under that title whatever path km now holds it under", async () => {
    kmDoc("renamed.md", qmdDoc("Alpha\n\none", "all"))
    const report = await seed()
    expect(report).toMatchObject({ seededDocuments: 1, seededChunks: 2 })
    expect(rows()[1]?.input_key).toBe(vaultInputKey(contractIdentity(CONTRACT), "doc: Alpha | one"))
  })

  test("a document edited since qmd embedded it is not seeded", async () => {
    qmdDoc("Alpha\n\none", "all")
    kmDoc("a.md", sha256("Alpha\n\nedited"))
    const report = await seed()
    expect(report.seededDocuments).toBe(0)
    expect(report.skipped).toEqual({ "qmd has no complete vector set for km's current hash": 1 })
    expect(rows()).toEqual([])
  })

  test("an incomplete qmd vector set is not seeded", async () => {
    kmDoc("a.md", qmdDoc("Alpha\n\none\n\ntwo", [0, 2]))
    const report = await seed()
    expect(report.skipped).toEqual({ "qmd has no complete vector set for km's current hash": 1 })
    expect(rows()).toEqual([])
  })

  test("a chunk count that differs from qmd's is not seeded", async () => {
    kmDoc("a.md", qmdDoc("Alpha\n\none", "all"))
    const merged: VaultEmbedChunker = { ...chunker, chunk: async (content) => [{ text: content }] }
    const report = await seedVaultEmbeddingsFromQmd({
      db,
      qmdDb: qmd.db as unknown as Database,
      vaultDb: vault,
      vaultId: "/v/.km/state.db",
      generation,
      contract: CONTRACT,
      chunker: merged,
      qmdModel: QMD_MODEL,
    })
    expect(report.skipped).toEqual({ "the chunker's chunk count differs from qmd's": 1 })
    expect(rows()).toEqual([])
  })

  test("a qmd store with no vectors for the expected model and fingerprint is refused, naming what it holds", async () => {
    kmDoc("a.md", qmdDoc("Alpha\n\none", "all", "hf:other/model.gguf"))
    await expect(seed()).rejects.toThrow(
      new RegExp(`no vectors for model ${QMD_MODEL}.*${getEmbeddingFingerprint(QMD_MODEL)}.*hf:other/model.gguf`),
    )
    expect(rows()).toEqual([])
  })
})
