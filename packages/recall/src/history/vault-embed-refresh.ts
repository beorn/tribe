/**
 * Vault embedding refresh (@ag/recall/three-dark-search-paths, CTO O2(b) 0609d989).
 *
 * One pass over the bound vault's markdown files, oldest fs_mtime first:
 * - a document whose km fs_content_hash is NULL, or whose file bytes hash to something else, stays uncovered;
 * - a chunk whose input_key already has a vector in the generation reuses it (any vault id), else it is embedded;
 * - each document's rows are written in one transaction, and that path's older rows are pruned after the commit.
 * The chunker and embedder are injected: production passes qmd's own chunkDocumentByTokens, extractTitle,
 * formatDocForEmbedding and truncateToContextSize on the one registered LlamaCpp instance.
 */
import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { contractIdentity, encodeVaultVector, vaultInputKey, type VaultEmbedContract } from "./vault-embed-store.ts"

export interface VaultEmbedChunker {
  /** The document's chunks, in order. */
  chunk(content: string, fsPath: string): Promise<readonly { text: string }[]>
  title(content: string, fsPath: string): string
  /** The exact model input for one chunk: formatted and truncated to the context size. */
  format(text: string, title: string): Promise<string>
}

export interface VaultEmbedder {
  embed(inputs: readonly string[]): Promise<readonly Float32Array[]>
}

export const UNCOVERED_NO_HASH = "km has not recorded this file's hash"
export const UNCOVERED_HASH_MISMATCH = "file bytes differ from km's recorded hash"
export const UNCOVERED_BUDGET = "refresh budget spent before this document"

export interface VaultEmbedRefreshReport {
  readonly documents: number
  readonly coveredDocuments: number
  readonly embeddedDocuments: number
  readonly embeddedChunks: number
  readonly reusedChunks: number
  readonly uncovered: Readonly<Record<string, number>>
  readonly stoppedEarly: boolean
}

export interface VaultEmbedRefreshOptions {
  readonly db: Database
  /** The bound km state.db, read-only. */
  readonly vaultDb: Database
  /** realpath of the bound km state.db (CTO B3). */
  readonly vaultId: string
  /** The directory km's vault-relative fs_path values resolve against. */
  readonly vaultRoot: string
  readonly generation: number
  readonly contract: VaultEmbedContract
  readonly chunker: VaultEmbedChunker
  readonly embedder: VaultEmbedder
  /** Checked before each document that needs embedding; true stops the pass. */
  readonly budgetSpent: () => boolean
}

interface FileRow {
  fs_path: string
  fs_content_hash: string | null
}

export async function refreshVaultEmbeddings(options: VaultEmbedRefreshOptions): Promise<VaultEmbedRefreshReport> {
  const { db, vaultDb, vaultId, vaultRoot, generation, contract, chunker, embedder } = options
  const contractJson = contractIdentity(contract)
  const files = vaultDb
    .prepare(
      "SELECT fs_path, fs_content_hash FROM nodes WHERE fstype = 'mdfile' AND fs_path IS NOT NULL ORDER BY fs_mtime ASC, fs_path ASC",
    )
    .all() as FileRow[]

  const covered = new Set(
    (
      db
        .prepare("SELECT DISTINCT fs_path, doc_hash FROM vault_doc_embed WHERE generation = ? AND vault_id = ?")
        .all(generation, vaultId) as { fs_path: string; doc_hash: string }[]
    ).map((row) => `${row.fs_path}\0${row.doc_hash}`),
  )
  // Reuse works across vault ids (CTO B3): a moved vault copies its vectors instead of re-embedding them.
  const vectorsByKey = new Map<string, Uint8Array>()
  for (const row of db.prepare("SELECT input_key, vec FROM vault_doc_embed WHERE generation = ?").all(generation) as {
    input_key: string
    vec: Uint8Array
  }[]) {
    vectorsByKey.set(row.input_key, row.vec)
  }

  const insert = db.prepare(
    "INSERT OR REPLACE INTO vault_doc_embed (generation, vault_id, fs_path, doc_hash, chunk, input_key, vec) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
  const prune = db.prepare(
    "DELETE FROM vault_doc_embed WHERE generation = ? AND vault_id = ? AND fs_path = ? AND doc_hash != ?",
  )

  const uncovered: Record<string, number> = {}
  const miss = (reason: string) => {
    uncovered[reason] = (uncovered[reason] ?? 0) + 1
  }
  let coveredDocuments = 0
  let embeddedDocuments = 0
  let embeddedChunks = 0
  let reusedChunks = 0
  let stoppedEarly = false

  for (const file of files) {
    const hash = file.fs_content_hash
    if (hash === null) {
      miss(UNCOVERED_NO_HASH)
      continue
    }
    if (covered.has(`${file.fs_path}\0${hash}`)) {
      coveredDocuments++
      continue
    }
    if (stoppedEarly || options.budgetSpent()) {
      stoppedEarly = true
      miss(UNCOVERED_BUDGET)
      continue
    }
    const bytes = readFileSync(join(vaultRoot, file.fs_path))
    if (createHash("sha256").update(bytes).digest("hex") !== hash) {
      miss(UNCOVERED_HASH_MISMATCH)
      continue
    }

    let pending: { key: string; input: string }[]
    let keys: string[]
    let fresh: readonly Float32Array[]
    try {
      const content = bytes.toString("utf8")
      const title = chunker.title(content, file.fs_path)
      const chunks = await chunker.chunk(content, file.fs_path)
      const inputs = await Promise.all(chunks.map((chunk) => chunker.format(chunk.text, title)))
      const chunkInputs = inputs.map((input) => ({ key: vaultInputKey(contractJson, input), input }))
      keys = chunkInputs.map((c) => c.key)
      pending = chunkInputs.filter((c) => !vectorsByKey.has(c.key))
      fresh = pending.length > 0 ? await embedder.embed(pending.map((p) => p.input)) : []
    } catch (error) {
      throw new Error(`vault embedding refresh failed on ${file.fs_path}: ${(error as Error).message}`, {
        cause: error,
      })
    }
    if (fresh.length !== pending.length) {
      throw new Error(
        `vault embedding refresh on ${file.fs_path}: for ${pending.length} inputs the embedder returned ${fresh.length} vector(s)`,
      )
    }
    const added = new Map<string, Uint8Array>()
    fresh.forEach((vec, i) => {
      const p = pending[i]
      if (p) added.set(p.key, encodeVaultVector(vec, contract.dimensions))
    })
    const rowVectors = keys.map((key) => {
      const vec = added.get(key) ?? vectorsByKey.get(key)
      if (!vec) throw new Error(`vault embedding refresh on ${file.fs_path}: no vector for input key ${key}`)
      return vec
    })

    db.transaction(() => {
      keys.forEach((key, chunk) => insert.run(generation, vaultId, file.fs_path, hash, chunk, key, rowVectors[chunk]))
    })()
    prune.run(generation, vaultId, file.fs_path, hash)

    for (const [key, vec] of added) vectorsByKey.set(key, vec)
    covered.add(`${file.fs_path}\0${hash}`)
    embeddedDocuments++
    embeddedChunks += pending.length
    reusedChunks += keys.length - pending.length
  }

  return {
    documents: files.length,
    coveredDocuments,
    embeddedDocuments,
    embeddedChunks,
    reusedChunks,
    uncovered,
    stoppedEarly,
  }
}
