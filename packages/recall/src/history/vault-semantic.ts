/**
 * The vault semantic leg of recall() (@ag/recall/three-dark-search-paths slice 3; rev23 P:70/72, D2, D4).
 *
 * One query embedding is started before recall()'s synchronous lexical work and awaited after it. The published
 * generation must match the running contract and the model file's stat (no re-hash per query). A vector counts only
 * while its doc_hash equals km's current fs_content_hash for that path; every other document is reported as not
 * embedded, and FTS still finds it. The two vault rankings fuse by equal RRF60 over vault documents only: fused
 * document i takes lexical slot i's rank, so the merge with other legs is unchanged, and no lexical vault candidates
 * means nothing is added. Any failure keeps the lexical hits and names its cause; the CLI then exits 3.
 */
import type { Database } from "bun:sqlite"
import { realpathSync } from "node:fs"
import { formatQueryForEmbedding } from "@tobilu/qmd/llm"
import { modelFileStat, recallEmbedContract, requireRecallEmbedModel } from "./vault-embed-model.ts"
import {
  decodeVaultVector,
  readPublishedVaultEmbedGeneration,
  vaultEmbedGenerationMismatch,
  type VaultEmbedContract,
} from "./vault-embed-store.ts"
import { log } from "./recall-shared.ts"
import { openVaultDb, type VaultMatch } from "./vault-fts.ts"

export const VAULT_RRF_K = 60
/** The cold added-latency cap (CTO ff83cf0c): a slower query embedding is a named degradation, not a wait. */
export const VAULT_SEMANTIC_TIMEOUT_MS = 5_000

/** One query model. Production loads node-llama-cpp directly (rev23); a test passes a fixture. */
export interface VaultQueryModel {
  embed(formattedQuery: string): Promise<Float32Array>
  dispose(): Promise<void>
}

export interface VaultQueryVector {
  readonly contract: VaultEmbedContract
  readonly modelStat: string
  readonly vector: Float32Array
}

export interface VaultSemanticHit {
  readonly fsPath: string
  readonly title: string | null
  readonly score: number
}

/** What the leg did, on the result: degraded with its cause, or the generation and coverage it ranked over. */
export interface VaultSemanticReceipt {
  readonly state: "ok" | "degraded"
  readonly cause?: string
  readonly generation?: number
  /** Bound-vault markdown documents, and how many have a current vector in the published generation. */
  readonly coverage?: { readonly documents: number; readonly embedded: number }
  /** Documents only the semantic ranking found, fused into the vault window. */
  readonly added?: number
}

/**
 * Production: the rev23 query route (CTO B2), node-llama-cpp 3.20.0 on RECALL_EMBED_MODEL with CPU only, no build and
 * no download. Loading starts on the first embed, so a slow load counts against the query cap.
 */
export function openVaultQueryModel(modelPath: string, contextTokens: number): VaultQueryModel {
  let loaded: Promise<{ dispose(): Promise<void>; embed(input: string): Promise<Float32Array> }> | undefined
  const load = () =>
    (loaded ??= (async () => {
      const { getLlama } = await import("node-llama-cpp")
      const llama = await getLlama({ gpu: false, build: "never", skipDownload: true })
      const model = await llama.loadModel({ modelPath })
      const context = await model.createEmbeddingContext({ contextSize: contextTokens })
      return {
        embed: async (input: string) => Float32Array.from((await context.getEmbeddingFor(input)).vector),
        dispose: async () => {
          await context.dispose()
          await model.dispose()
          await llama.dispose()
        },
      }
    })())
  return {
    embed: async (input) => (await load()).embed(input),
    dispose: async () => {
      if (loaded) await (await loaded).dispose()
    },
  }
}

/** Embed the query once. Rejects with a named cause: no model, a slow model, or no vector. */
export async function embedVaultQuery(
  query: string,
  options: {
    env?: NodeJS.ProcessEnv
    open?: (modelPath: string, contextTokens: number) => VaultQueryModel
    timeoutMs?: number
  } = {},
): Promise<VaultQueryVector> {
  const modelPath = requireRecallEmbedModel(options.env ?? process.env)
  const contract = recallEmbedContract()
  const modelStat = modelFileStat(modelPath)
  const model = (options.open ?? openVaultQueryModel)(modelPath, contract.contextTokens)
  const timeoutMs = options.timeoutMs ?? VAULT_SEMANTIC_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    const vector = await Promise.race([
      model.embed(formatQueryForEmbedding(query, modelPath)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          reject(new Error(`the query embedding took longer than ${timeoutMs} ms`))
        }, timeoutMs)
      }),
    ])
    if (vector.length !== contract.dimensions) {
      throw new Error(
        `the query embedding has ${vector.length} values; the contract dimension is ${contract.dimensions}`,
      )
    }
    return { contract, modelStat, vector }
  } finally {
    clearTimeout(timer)
    if (timedOut) {
      // Production dispose waits for the load; awaiting it here would let a slow load outlast the cap (CTO 0edff0e3
      // fix 2). The CLI ends the process after printing a degraded result.
      model.dispose().catch((error: unknown) => {
        log(`vault semantic: disposing the timed-out query model failed: ${String(error)}`)
      })
    } else {
      await model.dispose()
    }
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb)
}

/**
 * Rank the bound vault's documents by their best chunk's cosine with the query, over the published generation's
 * current vectors only. Throws a named cause when no generation is published or it does not match.
 */
export function rankVaultSemantic(
  db: Database,
  vaultDbPath: string,
  query: VaultQueryVector,
  limit: number,
): { generation: number; hits: VaultSemanticHit[]; documents: number; embedded: number } {
  const published = readPublishedVaultEmbedGeneration(db)
  if (!published) {
    throw new Error("no vault embedding generation is published; recall index --vault-db builds one")
  }
  const mismatch = vaultEmbedGenerationMismatch(published, query.contract, { stat: query.modelStat })
  if (mismatch !== null) throw new Error(mismatch)

  const current = new Map<string, { hash: string | null; title: string | null }>()
  const files = openVaultDb(vaultDbPath)
    .prepare("SELECT fs_path, fs_content_hash, title FROM nodes WHERE fstype = 'mdfile' AND fs_path IS NOT NULL")
    .all() as { fs_path: string; fs_content_hash: string | null; title: string | null }[]
  for (const file of files) current.set(file.fs_path, { hash: file.fs_content_hash, title: file.title })

  const best = new Map<string, number>()
  const rows = db
    .prepare("SELECT fs_path, doc_hash, vec FROM vault_doc_embed WHERE generation = ? AND vault_id = ?")
    .all(published.id, realpathSync(vaultDbPath)) as { fs_path: string; doc_hash: string; vec: Uint8Array }[]
  for (const row of rows) {
    if (current.get(row.fs_path)?.hash !== row.doc_hash) continue
    const score = cosine(query.vector, decodeVaultVector(row.vec, query.contract.dimensions))
    if (score > (best.get(row.fs_path) ?? Number.NEGATIVE_INFINITY)) best.set(row.fs_path, score)
  }
  const hits = [...best.entries()]
    .map(([fsPath, score]) => ({ fsPath, title: current.get(fsPath)?.title ?? null, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  return { generation: published.id, hits, documents: current.size, embedded: best.size }
}

/** Equal RRF60 over vault documents; fused document i takes lexical slot i's rank (rev23 P:72). */
export function fuseVaultMatches(
  lexical: readonly VaultMatch[],
  semantic: readonly VaultSemanticHit[],
): { matches: VaultMatch[]; added: number } {
  const fused = new Map<string, { score: number; match: VaultMatch; lexical: boolean }>()
  lexical.forEach((match, i) => {
    fused.set(match.fsPath ?? match.id, { score: 1 / (VAULT_RRF_K + i + 1), match, lexical: true })
  })
  semantic.forEach((hit, i) => {
    const score = 1 / (VAULT_RRF_K + i + 1)
    const entry = fused.get(hit.fsPath)
    if (entry) {
      entry.score += score
      return
    }
    fused.set(hit.fsPath, {
      score,
      lexical: false,
      match: {
        id: hit.fsPath,
        fsPath: hit.fsPath,
        name: null,
        title: hit.title,
        snippet: hit.title ?? hit.fsPath,
        rank: 0,
      },
    })
  })
  const window = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, lexical.length)
  const matches = window.flatMap((entry, i) => {
    const slot = lexical[i]
    return slot ? [{ ...entry.match, rank: slot.rank }] : []
  })
  return { matches, added: window.filter((entry) => !entry.lexical).length }
}

export const CENSUS_NO_HASH = "km has not recorded this file's hash"
export const CENSUS_STALE = "its vector is for older text; the next refresh replaces it"
export const CENSUS_NOT_EMBEDDED = "not embedded yet"
export const CENSUS_NO_GENERATION = "no vault embedding generation is published"

/**
 * AC1: U = A + X for the bound vault. U is its markdown documents; A those with a vector for km's current hash in the
 * published generation; X the rest, one reason each. I is A when the generation matches the running contract and
 * model file, else 0 with the cause.
 */
export interface VaultSemanticCensus {
  readonly units: number
  readonly accepted: number
  readonly excluded: Readonly<Record<string, number>>
  readonly queryable: number
  readonly generation: number | null
  readonly cause?: string
}

export function vaultSemanticCensus(
  db: Database,
  vaultDbPath: string,
  env: NodeJS.ProcessEnv = process.env,
): VaultSemanticCensus {
  const files = openVaultDb(vaultDbPath)
    .prepare("SELECT fs_path, fs_content_hash FROM nodes WHERE fstype = 'mdfile' AND fs_path IS NOT NULL")
    .all() as { fs_path: string; fs_content_hash: string | null }[]
  const published = readPublishedVaultEmbedGeneration(db)
  const held = new Map<string, Set<string>>()
  if (published) {
    const rows = db
      .prepare("SELECT DISTINCT fs_path, doc_hash FROM vault_doc_embed WHERE generation = ? AND vault_id = ?")
      .all(published.id, realpathSync(vaultDbPath)) as { fs_path: string; doc_hash: string }[]
    for (const row of rows) held.set(row.fs_path, (held.get(row.fs_path) ?? new Set()).add(row.doc_hash))
  }
  const excluded: Record<string, number> = {}
  let accepted = 0
  for (const file of files) {
    const hashes = held.get(file.fs_path)
    const reason =
      file.fs_content_hash === null
        ? CENSUS_NO_HASH
        : !published
          ? CENSUS_NO_GENERATION
          : hashes?.has(file.fs_content_hash)
            ? null
            : hashes
              ? CENSUS_STALE
              : CENSUS_NOT_EMBEDDED
    if (reason === null) accepted++
    else excluded[reason] = (excluded[reason] ?? 0) + 1
  }
  const base = { units: files.length, accepted, excluded, generation: published?.id ?? null }
  if (!published) return { ...base, queryable: 0, cause: CENSUS_NO_GENERATION }
  let cause: string | null
  try {
    cause = vaultEmbedGenerationMismatch(published, recallEmbedContract(), {
      stat: modelFileStat(requireRecallEmbedModel(env)),
    })
  } catch (error) {
    cause = error instanceof Error ? error.message : String(error)
  }
  return cause === null ? { ...base, queryable: accepted } : { ...base, queryable: 0, cause }
}
