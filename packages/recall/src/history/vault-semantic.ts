/**
 * The vault semantic leg of recall() (@ag/recall/three-dark-search-paths slice 3; rev23 P:70/72, D2, D4).
 *
 * One query embedding is started before recall()'s synchronous lexical work, and its cap is armed after it. The published
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
  decodeVaultVectorInto,
  readPublishedVaultEmbedGeneration,
  vaultEmbedGenerationMismatch,
  type VaultEmbedContract,
} from "./vault-embed-store.ts"
import { log } from "./recall-shared.ts"
import { openVaultDb, type VaultMatch } from "./vault-fts.ts"

export const VAULT_RRF_K = 60
/** The cold added-latency cap (CTO ff83cf0c): a slower query embedding is a named degradation, not a wait. */
export const VAULT_SEMANTIC_TIMEOUT_MS = 5_000
/**
 * The longest recall() waits, before its lexical search, for the model's native load to be called (CTO 981cb56b, (b)).
 * D5: import and getLlama take ~0.1 s but cannot run while the synchronous reads hold the main thread, so loadModel and
 * context always started after the search. The load continues past a bound hit; only the wait is capped.
 */
export const VAULT_PRE_LEXICAL_BOUND_MS = 500

/** One query model. Production loads node-llama-cpp directly (rev23); a test passes a fixture. */
export interface VaultQueryModel {
  /** Load the model before the first embed, so the load is timed apart from the embed; absent, embed loads. */
  load?(): Promise<void>
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
  /** Where the search's time went (CTO 3a638efb D1), on success and on degradation alike. */
  readonly spans?: VaultSemanticSpans
}

/**
 * Span times in ms on one clock. The spans are disjoint, so they sum to at most totalMs. lexicalMs is the
 * synchronous lexical search and its synonym variants. loadMs and embedMs count only the wait after that search;
 * work the model does during it (it may load on native threads) is not shown here, and a run with the leg off
 * measures any slowdown it causes. totalMs runs from the leg's module import to the end of the synonyms.
 */
export interface VaultSemanticSpans {
  readonly moduleMs: number
  /** The bounded wait before the lexical search for the native load call; null when the leg never started. */
  readonly preLexical: VaultPreLexicalWait | null
  readonly lexicalMs: number
  readonly loadMs: number
  /** The whole load, start to end (or to the settle end when it never finished), overlap with lexical included. */
  readonly rawLoadMs: number
  readonly embedMs: number
  readonly scanMs: number
  readonly chunksScanned: number
  readonly mergeMs: number
  readonly totalMs: number
  /** Each load step's start and end in ms from load start, and when it started relative to the lexical search. */
  readonly loadSteps: readonly VaultLoadStepSpan[]
}

/** The wait before the lexical search: its ms, its bound, and whether the bound ran out first. */
export interface VaultPreLexicalWait {
  readonly waitMs: number
  readonly boundMs: number
  readonly hit: boolean
}

/** The production load's steps, in order (CTO 6a21299d): where the load's time goes. */
export type VaultLoadStep = "import" | "getLlama" | "loadModel" | "context"
/** Records one load step's start or end; the leg stamps it on its clock. */
export type VaultLoadStepRecorder = (step: VaultLoadStep, at: "start" | "end") => void

export interface VaultLoadStepSpan {
  readonly step: VaultLoadStep
  readonly startMs: number
  /** null when the step never finished (a timed-out or failed load). */
  readonly endMs: number | null
  readonly started: "before lexical" | "during lexical" | "after lexical"
}

/** When the query model's load and embed began and ended, on the caller's clock; unset until reached. */
export interface VaultQueryMarks {
  loadStart?: number
  loadEnd?: number
  embedStart?: number
  embedEnd?: number
  /** Each load step reached, in order, when the model records them. */
  steps?: { step: VaultLoadStep; start: number; end?: number }[]
}

/**
 * Production: the rev23 query route (CTO B2), node-llama-cpp 3.20.0 on RECALL_EMBED_MODEL with CPU only, no build and
 * no download. Loading starts on the first embed, so a slow load counts against the query cap.
 */
export function openVaultQueryModel(
  modelPath: string,
  contextTokens: number,
  record?: VaultLoadStepRecorder,
): VaultQueryModel {
  let loaded: Promise<{ dispose(): Promise<void>; embed(input: string): Promise<Float32Array> }> | undefined
  // Marks only (CTO 6a21299d): the same awaits in the same order.
  const step = async <T>(name: VaultLoadStep, run: () => Promise<T>): Promise<T> => {
    record?.(name, "start")
    const value = await run()
    record?.(name, "end")
    return value
  }
  const load = () =>
    (loaded ??= (async () => {
      const { getLlama } = await step("import", () => import("node-llama-cpp"))
      const llama = await step("getLlama", () => getLlama({ gpu: false, build: "never", skipDownload: true }))
      const model = await step("loadModel", () => llama.loadModel({ modelPath }))
      const context = await step("context", () => model.createEmbeddingContext({ contextSize: contextTokens }))
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
    load: async () => {
      await load()
    },
    embed: async (input) => (await load()).embed(input),
    dispose: async () => {
      if (loaded) await (await loaded).dispose()
    },
  }
}

/** One query embedding, started early; its cap starts only when the caller settles it. */
export interface VaultQueryEmbedding {
  /** The vector, or a rejection with a named cause: no model, a slow model, or no vector. */
  settle(timeoutMs?: number): Promise<VaultQueryVector>
  /** The load and embed times reached so far; empty when the embedding never started. */
  readonly marks: VaultQueryMarks
  /**
   * Wait at most boundMs until the native load has been called (the loadModel step started), the load has settled, or
   * the model has no separate load. Never rejects, never starts a second load; the load continues after a bound hit.
   */
  untilLoadCalled(boundMs?: number): Promise<VaultPreLexicalWait>
}

/**
 * Start the one query embedding so the model loads during recall()'s synchronous lexical work. The cap is the latency
 * the leg adds after that work (CTO ff83cf0c ruling 5, r2 change 1), so it is armed by settle(), never here. Never
 * throws: a failure to start is the rejection settle() returns.
 */
export function startVaultQueryEmbedding(
  query: string,
  options: {
    env?: NodeJS.ProcessEnv
    open?: (modelPath: string, contextTokens: number, record?: VaultLoadStepRecorder) => VaultQueryModel
    clock?: () => number
  } = {},
): VaultQueryEmbedding {
  const clock = options.clock ?? (() => performance.now())
  const marks: VaultQueryMarks = {}
  let contract: VaultEmbedContract
  let modelStat: string
  let model: VaultQueryModel
  let embedded: Promise<{ ok: true; vector: Float32Array } | { ok: false; error: unknown }>
  let markLoadCalled = () => {}
  const loadCalled = new Promise<void>((resolve) => {
    markLoadCalled = resolve
  })
  const untilLoadCalled = async (boundMs = VAULT_PRE_LEXICAL_BOUND_MS): Promise<VaultPreLexicalWait> => {
    const start = clock()
    let timer: ReturnType<typeof setTimeout> | undefined
    let hit = false
    try {
      await Promise.race([
        loadCalled,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            hit = true
            resolve()
          }, boundMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
    return { waitMs: clock() - start, boundMs, hit }
  }
  try {
    const modelPath = requireRecallEmbedModel(options.env ?? process.env)
    contract = recallEmbedContract()
    modelStat = modelFileStat(modelPath)
    const steps: NonNullable<VaultQueryMarks["steps"]> = []
    marks.steps = steps
    const record: VaultLoadStepRecorder = (name, at) => {
      if (at === "start") {
        steps.push({ step: name, start: clock() })
        if (name === "loadModel") markLoadCalled()
      } else {
        const open = steps.findLast((entry) => entry.step === name && entry.end === undefined)
        if (open) open.end = clock()
      }
    }
    model = (options.open ?? openVaultQueryModel)(modelPath, contract.contextTokens, record)
    const formatted = formatQueryForEmbedding(query, modelPath)
    const started = model
    const embed = () => {
      marks.embedStart = clock()
      return started.embed(formatted)
    }
    // Both calls start synchronously, before the lexical search, as before the load was timed apart.
    marks.loadStart = clock()
    const loading = model.load?.()
    let vectorOf: Promise<Float32Array>
    if (loading === undefined) {
      marks.loadEnd = marks.loadStart
      markLoadCalled()
      vectorOf = embed()
    } else {
      // A load that settles before (or without) recording its loadModel call ends the wait too. Both branches handle a
      // rejection here, so a failed or abandoned load is never unhandled; vectorOf below reuses this one load.
      loading.then(markLoadCalled, markLoadCalled)
      vectorOf = loading.then(() => {
        marks.loadEnd = clock()
        return embed()
      })
    }
    // The outcome is held, error included, until settle() reads it, so an early failure is never unhandled.
    embedded = vectorOf.then(
      (vector) => {
        marks.embedEnd = clock()
        return { ok: true as const, vector }
      },
      (error: unknown) => ({ ok: false as const, error }),
    )
  } catch (error) {
    markLoadCalled()
    return { settle: () => Promise.reject(error), marks, untilLoadCalled }
  }
  return {
    marks,
    untilLoadCalled,
    settle: async (timeoutMs = VAULT_SEMANTIC_TIMEOUT_MS) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let timedOut = false
      try {
        const outcome = await Promise.race([
          embedded,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              timedOut = true
              reject(new Error(`the query embedding took longer than ${timeoutMs} ms after the lexical search`))
            }, timeoutMs)
          }),
        ])
        if (!outcome.ok) throw outcome.error
        if (outcome.vector.length !== contract.dimensions) {
          throw new Error(
            `the query embedding has ${outcome.vector.length} values; the contract dimension is ${contract.dimensions}`,
          )
        }
        return { contract, modelStat, vector: outcome.vector }
      } finally {
        clearTimeout(timer)
        if (timedOut) {
          // Production dispose waits for the load; awaiting it here would let a slow load outlast the cap (CTO
          // 0edff0e3 fix 2). The CLI ends the process after printing a degraded result.
          model.dispose().catch((error: unknown) => {
            log(`vault semantic: disposing the timed-out query model failed: ${String(error)}`)
          })
        } else {
          await model.dispose()
        }
      }
    },
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
): { generation: number; hits: VaultSemanticHit[]; documents: number; embedded: number; scanned: number } {
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

  // One primary-key lookup per document reads only the vectors for km's current hash, one row at a time, decoded into
  // one reused buffer, so neither stale rows nor the whole generation are ever held (CTO 0edff0e3 fix 3).
  const best = new Map<string, number>()
  const vaultId = realpathSync(vaultDbPath)
  const vectorsOf = db.prepare(
    "SELECT vec FROM vault_doc_embed WHERE generation = ? AND vault_id = ? AND fs_path = ? AND doc_hash = ?",
  )
  const buffer = new Float32Array(query.contract.dimensions)
  let scanned = 0
  for (const [fsPath, file] of current) {
    if (file.hash === null) continue
    for (const row of vectorsOf.iterate(published.id, vaultId, fsPath, file.hash) as Iterable<{ vec: Uint8Array }>) {
      scanned++
      const score = cosine(query.vector, decodeVaultVectorInto(row.vec, buffer))
      if (score > (best.get(fsPath) ?? Number.NEGATIVE_INFINITY)) best.set(fsPath, score)
    }
  }
  const hits = [...best.entries()]
    .map(([fsPath, score]) => ({ fsPath, title: current.get(fsPath)?.title ?? null, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  return { generation: published.id, hits, documents: current.size, embedded: best.size, scanned }
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
