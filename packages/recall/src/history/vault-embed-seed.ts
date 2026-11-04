/**
 * One-time seed of vault embeddings from qmd's store (@ag/recall/three-dark-search-paths, CTO 0609d989 rule 5).
 *
 * For each bound-vault markdown file whose km fs_content_hash has a complete qmd vector set for the expected model
 * and fingerprint, copy those vectors into the generation. Input keys come from running the chunker over qmd's own
 * stored text (whose sha256 is that hash) under qmd's own path for it, so a renamed file keys the input qmd embedded;
 * nothing is embedded. Each document is one transaction. After the seed,
 * Recall never reads qmd's store. Running it needs the model loaded for tokenizing, so it waits for the declared
 * model and a grant (CTO 8d4ea4f4 B2).
 */
import type { Database } from "bun:sqlite"
import { getEmbeddingFingerprint } from "@tobilu/qmd/store"
import { UNCOVERED_NO_HASH, type VaultEmbedChunker } from "./vault-embed-refresh.ts"
import { contractIdentity, vaultInputKey, type VaultEmbedContract } from "./vault-embed-store.ts"

/** The model URI qmd recorded for the vectors it made with EmbeddingGemma-300M-Q8_0. */
export const QMD_SEED_MODEL_URI = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf"

export const SEED_SKIP_INCOMPLETE = "qmd has no complete vector set for km's current hash"
export const SEED_SKIP_CHUNK_COUNT = "the chunker's chunk count differs from qmd's"
export const SEED_SKIP_NO_QMD_PATH = "qmd has no active path for this hash, so the title it embedded is unknown"

export interface VaultEmbedSeedReport {
  readonly seededDocuments: number
  readonly seededChunks: number
  readonly alreadyCovered: number
  readonly skipped: Readonly<Record<string, number>>
}

export interface VaultEmbedSeedOptions {
  readonly db: Database
  /** qmd's store database, opened by qmd's own createStore (sqlite-vec loaded). */
  readonly qmdDb: Database
  readonly vaultDb: Database
  readonly vaultId: string
  readonly generation: number
  readonly contract: VaultEmbedContract
  readonly chunker: VaultEmbedChunker
  readonly qmdModel: string
}

export async function seedVaultEmbeddingsFromQmd(options: VaultEmbedSeedOptions): Promise<VaultEmbedSeedReport> {
  const { db, qmdDb, vaultDb, vaultId, generation, contract, chunker, qmdModel } = options
  const fingerprint = getEmbeddingFingerprint(qmdModel)
  const held = qmdDb
    .prepare("SELECT model, embed_fingerprint, COUNT(*) AS n FROM content_vectors GROUP BY model, embed_fingerprint")
    .all() as { model: string; embed_fingerprint: string; n: number }[]
  if (!held.some((row) => row.model === qmdModel && row.embed_fingerprint === fingerprint)) {
    const holds = held.map((row) => `${row.model} (fingerprint ${row.embed_fingerprint}, ${row.n} vectors)`).join("; ")
    throw new Error(
      `qmd store holds no vectors for model ${qmdModel} with fingerprint ${fingerprint}, so nothing can be seeded; it holds: ${holds || "nothing"}`,
    )
  }

  const contractJson = contractIdentity(contract)
  const files = vaultDb
    .prepare(
      "SELECT fs_path, fs_content_hash FROM nodes WHERE fstype = 'mdfile' AND fs_path IS NOT NULL ORDER BY fs_path",
    )
    .all() as { fs_path: string; fs_content_hash: string | null }[]
  const covered = new Set(
    (
      db
        .prepare("SELECT DISTINCT fs_path, doc_hash FROM vault_doc_embed WHERE generation = ? AND vault_id = ?")
        .all(generation, vaultId) as { fs_path: string; doc_hash: string }[]
    ).map((row) => `${row.fs_path}\0${row.doc_hash}`),
  )
  const qmdChunks = qmdDb.prepare(
    "SELECT seq, total_chunks FROM content_vectors WHERE hash = ? AND model = ? AND embed_fingerprint = ? ORDER BY seq",
  )
  const qmdText = qmdDb.prepare("SELECT doc FROM content WHERE hash = ?")
  // qmd titles and chunks a hash by MIN(path) over its active documents; the key must describe that input (ruling 17).
  const qmdPath = qmdDb.prepare("SELECT MIN(path) AS path FROM documents WHERE hash = ? AND active = 1")
  const qmdVector = qmdDb.prepare("SELECT embedding FROM vectors_vec WHERE hash_seq = ?")
  const insert = db.prepare(
    "INSERT OR REPLACE INTO vault_doc_embed (generation, vault_id, fs_path, doc_hash, chunk, input_key, vec) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )

  const skipped: Record<string, number> = {}
  const skip = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
  }
  let seededDocuments = 0
  let seededChunks = 0
  let alreadyCovered = 0

  for (const file of files) {
    const hash = file.fs_content_hash
    if (hash === null) {
      skip(UNCOVERED_NO_HASH)
      continue
    }
    if (covered.has(`${file.fs_path}\0${hash}`)) {
      alreadyCovered++
      continue
    }
    const set = qmdChunks.all(hash, qmdModel, fingerprint) as { seq: number; total_chunks: number }[]
    const total = set[0]?.total_chunks ?? 0
    const vectors = set.map((row) => qmdVector.get(`${hash}_${row.seq}`) as { embedding: Uint8Array } | null)
    const text = qmdText.get(hash) as { doc: string } | null
    const complete =
      total > 0 &&
      set.length === total &&
      set.every((row, i) => row.seq === i && row.total_chunks === total) &&
      vectors.every((vec) => vec !== null) &&
      text !== null
    if (!complete || text === null) {
      skip(SEED_SKIP_INCOMPLETE)
      continue
    }
    const embeddedAs = (qmdPath.get(hash) as { path: string | null } | null)?.path ?? null
    if (embeddedAs === null) {
      skip(SEED_SKIP_NO_QMD_PATH)
      continue
    }
    const title = chunker.title(text.doc, embeddedAs)
    const chunks = await chunker.chunk(text.doc, embeddedAs)
    if (chunks.length !== total) {
      skip(SEED_SKIP_CHUNK_COUNT)
      continue
    }
    const keys = await Promise.all(
      chunks.map(async (chunk) => vaultInputKey(contractJson, await chunker.format(chunk.text, title))),
    )
    const rows = vectors.map((vec, chunk) => {
      const bytes = vec?.embedding
      if (!bytes || bytes.byteLength !== contract.dimensions * 4) {
        throw new Error(
          `qmd vector ${hash}_${chunk} for ${file.fs_path} is ${bytes?.byteLength ?? 0} bytes; the contract dimension ${contract.dimensions} needs ${contract.dimensions * 4}`,
        )
      }
      return { key: keys[chunk] ?? "", vec: new Uint8Array(bytes) }
    })
    db.transaction(() => {
      rows.forEach((row, chunk) => insert.run(generation, vaultId, file.fs_path, hash, chunk, row.key, row.vec))
    })()
    covered.add(`${file.fs_path}\0${hash}`)
    seededDocuments++
    seededChunks += rows.length
  }

  return { seededDocuments, seededChunks, alreadyCovered, skipped }
}
