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
export const UNCOVERED_BUDGET_INSIDE = "refresh budget spent inside this document; it is abandoned unwritten"
export const UNCOVERED_EMPTY = "the document has no text to embed"
/** km still lists the file but it cannot be read, e.g. after a delete: the reason carries the error code. */
export const uncoveredUnreadable = (code: string) => `file unreadable (${code})`
/**
 * A document whose pending chunks the time left cannot embed is skipped, and the pass goes on (CTO r2 change 4):
 * oldest-first order would otherwise put it first again every pass and block every newer document.
 */
export const uncoveredTooLarge = (needs: number, fits: number) =>
  `needs ${needs} chunks; this pass has time for ${fits}`
/** The rate a pass assumes before it has embedded anything: the native pilot, 250 chunks in 873.48 s. */
export const VAULT_EMBED_PILOT_CHUNKS_PER_MS = 250 / 873_480
/**
 * Chunks per embed call. The budget is checked between calls, so one call is the most a pass can overrun its budget:
 * at the measured pilot rate (0.2862 chunks/s) eight chunks take about 28 s, inside the 600 s ceiling's margin.
 */
export const VAULT_EMBED_BATCH = 8

export interface VaultEmbedRefreshReport {
  readonly documents: number
  readonly coveredDocuments: number
  readonly embeddedDocuments: number
  readonly embeddedChunks: number
  readonly reusedChunks: number
  readonly uncovered: Readonly<Record<string, number>>
  readonly stoppedEarly: boolean
  /** Documents skipped because their chunks did not fit the time left, and the largest pending chunk count among them. */
  readonly tooLarge: { readonly documents: number; readonly largestChunks: number }
  /**
   * Embed-call times on the caller's clock: the pass's first call (it includes the model load) and the median of the
   * rest; null when the pass made no such call.
   */
  readonly batchMs: { readonly first: number | null; readonly steadyMedian: number | null }
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
  /**
   * Milliseconds this pass may still spend, read before each document that needs embedding and between embed
   * batches: 0 or less stops the pass, and a document whose pending chunks do not fit the time left is skipped.
   */
  readonly timeLeftMs: () => number
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
  // The rate is measured on the caller's own clock, the time-left reading before and after each embed call, so the fit
  // check and the budget agree on one clock (CTO r3).
  let measuredChunks = 0
  let measuredMs = 0
  const callMs: number[] = []
  let tooLargeDocuments = 0
  let largestTooLarge = 0
  const chunksPerMs = () => (measuredMs > 0 ? measuredChunks / measuredMs : VAULT_EMBED_PILOT_CHUNKS_PER_MS)
  const readTimeLeft = () => {
    const left = options.timeLeftMs()
    if (!Number.isFinite(left)) {
      throw new Error(`vault embedding refresh: timeLeftMs() returned ${left}; a pass needs a finite time budget`)
    }
    return left
  }

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
    if (stoppedEarly || readTimeLeft() <= 0) {
      stoppedEarly = true
      miss(UNCOVERED_BUDGET)
      continue
    }
    let bytes: Buffer
    try {
      bytes = readFileSync(join(vaultRoot, file.fs_path))
    } catch (error) {
      miss(uncoveredUnreadable((error as NodeJS.ErrnoException).code ?? (error as Error).message))
      continue
    }
    if (createHash("sha256").update(bytes).digest("hex") !== hash) {
      miss(UNCOVERED_HASH_MISMATCH)
      continue
    }

    let pending: { key: string; input: string }[]
    let keys: string[]
    const fresh: Float32Array[] = []
    let abandoned = false
    let tooLarge: string | null = null
    try {
      const content = bytes.toString("utf8")
      const title = chunker.title(content, file.fs_path)
      const chunks = await chunker.chunk(content, file.fs_path)
      const inputs = await Promise.all(chunks.map((chunk) => chunker.format(chunk.text, title)))
      const chunkInputs = inputs.map((input) => ({ key: vaultInputKey(contractJson, input), input }))
      keys = chunkInputs.map((c) => c.key)
      pending = chunkInputs.filter((c) => !vectorsByKey.has(c.key))
      // Re-read after chunking, then before every batch: a document whose remaining chunks no longer fit the time
      // left at the rate measured so far is skipped by name and the pass goes on (CTO r2 change 4, r3). Only a time
      // left already spent stops the pass.
      let left = readTimeLeft()
      for (let start = 0; start < pending.length; start += VAULT_EMBED_BATCH) {
        if (left <= 0) {
          abandoned = true
          break
        }
        const fits = Math.floor(left * chunksPerMs())
        if (pending.length - start > fits) {
          tooLarge = uncoveredTooLarge(pending.length, start + fits)
          tooLargeDocuments++
          largestTooLarge = Math.max(largestTooLarge, pending.length)
          break
        }
        const batch = pending.slice(start, start + VAULT_EMBED_BATCH)
        const vectors = await embedder.embed(batch.map((p) => p.input))
        const after = readTimeLeft()
        measuredMs += Math.max(0, left - after)
        callMs.push(Math.max(0, left - after))
        measuredChunks += batch.length
        left = after
        if (vectors.length !== batch.length) {
          throw new Error(`for ${batch.length} inputs the embedder returned ${vectors.length} vector(s)`)
        }
        fresh.push(...vectors)
      }
    } catch (error) {
      throw new Error(`vault embedding refresh failed on ${file.fs_path}: ${(error as Error).message}`, {
        cause: error,
      })
    }
    if (tooLarge !== null) {
      miss(tooLarge)
      continue
    }
    if (abandoned) {
      stoppedEarly = true
      miss(UNCOVERED_BUDGET_INSIDE)
      continue
    }
    if (keys.length === 0) {
      miss(UNCOVERED_EMPTY)
      continue
    }
    const added = new Map<string, Uint8Array>()
    fresh.forEach((vec, i) => {
      const p = pending[i]
      if (!p) throw new Error(`vault embedding refresh on ${file.fs_path}: vector ${i} has no pending input`)
      added.set(p.key, encodeVaultVector(vec, contract.dimensions))
    })
    const rows = keys.map((key) => {
      const vec = added.get(key) ?? vectorsByKey.get(key)
      if (!vec) throw new Error(`vault embedding refresh on ${file.fs_path}: no vector for input key ${key}`)
      return { key, vec }
    })

    try {
      db.transaction(() => {
        rows.forEach((row, chunk) => insert.run(generation, vaultId, file.fs_path, hash, chunk, row.key, row.vec))
      })()
    } catch (error) {
      throw new Error(`vault embedding refresh could not write ${file.fs_path}: ${(error as Error).message}`, {
        cause: error,
      })
    }
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
    tooLarge: { documents: tooLargeDocuments, largestChunks: largestTooLarge },
    batchMs: { first: callMs[0] ?? null, steadyMedian: median(callMs.slice(1)) },
  }
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}
