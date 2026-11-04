/**
 * The vault embedding pass of `recall index` (@ag/recall/three-dark-search-paths, D3/D4).
 *
 * Runs only when `--vault-db` is bound. The GGUF is hashed once per pass. The pass refreshes the published
 * generation when its contract and digest match the running ones. Otherwise it fills a building generation with
 * the running identity, publishing it once a pass covers every document it can. When nothing is published yet, the
 * first generation is published at once, so its partial coverage is served and reported while the backfill runs.
 */
import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { createReadStream, readFileSync, realpathSync } from "node:fs"
import { basename, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { openVaultDb } from "./vault-fts.ts"
import {
  createQmdEmbedRuntime,
  qmdModuleSha256,
  requireRecallEmbedModel,
  type QmdEmbedRuntime,
} from "./vault-embed-qmd.ts"
import { refreshVaultEmbeddings, type VaultEmbedRefreshReport } from "./vault-embed-refresh.ts"
import {
  beginVaultEmbedGeneration,
  contractIdentity,
  publishVaultEmbedGeneration,
  readPublishedVaultEmbedGeneration,
  type VaultEmbedContract,
} from "./vault-embed-store.ts"

/** The rev23 contract: EmbeddingGemma-300M-Q8_0 through qmd 2.8.3's own procedure. */
export function recallEmbedContract(): VaultEmbedContract {
  const qmdPackage = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.resolve("@tobilu/qmd/store"))), "utf8"),
  ) as { version: string }
  return {
    model: "EmbeddingGemma-300M-Q8_0",
    dimensions: 768,
    pooling: "mean",
    contextTokens: 2048,
    queryPrefix: "task: search result | query: ",
    documentPrefix: "title: <title> | text: ",
    chunkTokens: 900,
    overlapTokens: 135,
    windowTokens: 200,
    qmdVersion: qmdPackage.version,
    qmdStoreSha256: qmdModuleSha256("@tobilu/qmd/store"),
    qmdLlmSha256: qmdModuleSha256("@tobilu/qmd/llm"),
  }
}

/** km keeps a vault's database at `<root>/.km/state.db`; fs_path values resolve against `<root>`. */
export function vaultRootOf(stateDbPath: string): string {
  const dir = dirname(stateDbPath)
  if (basename(dir) !== ".km") {
    throw new Error(
      `--vault-db ${stateDbPath} is not <vault root>/.km/state.db, so the vault's file paths have no root to resolve against`,
    )
  }
  return dirname(dir)
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest("hex")
}

export interface VaultEmbedPassReport extends VaultEmbedRefreshReport {
  readonly generation: number
  readonly published: boolean
}

export interface VaultEmbedPassOptions {
  readonly db: Database
  readonly vaultDbPath: string
  readonly budgetSpent: () => boolean
  readonly now?: number
  readonly env?: NodeJS.ProcessEnv
  readonly contract?: VaultEmbedContract
  /** Production builds qmd's runtime on RECALL_EMBED_MODEL; a test passes a fixture. */
  readonly runtime?: (contract: VaultEmbedContract) => QmdEmbedRuntime
}

export async function runVaultEmbedPass(options: VaultEmbedPassOptions): Promise<VaultEmbedPassReport> {
  const { db } = options
  const env = options.env ?? process.env
  const modelPath = requireRecallEmbedModel(env)
  const vaultId = realpathSync(options.vaultDbPath)
  const vaultRoot = vaultRootOf(vaultId)
  const contract = options.contract ?? recallEmbedContract()
  const contractJson = contractIdentity(contract)
  const ggufSha256 = await sha256File(modelPath)
  const now = options.now ?? Date.now()

  const published = readPublishedVaultEmbedGeneration(db)
  let generation: number
  let publishWhenComplete = false
  if (published && published.contractJson === contractJson && published.ggufSha256 === ggufSha256) {
    generation = published.id
  } else {
    const building = db
      .prepare(
        "SELECT id FROM vault_embed_generation WHERE state = 'building' AND contract_json = ? AND gguf_sha256 = ? ORDER BY id DESC LIMIT 1",
      )
      .get(contractJson, ggufSha256) as { id: number } | null
    generation = building?.id ?? beginVaultEmbedGeneration(db, { contract, ggufSha256, now })
    if (published) publishWhenComplete = true
    else publishVaultEmbedGeneration(db, generation)
  }

  const runtime = (options.runtime ?? ((c) => createQmdEmbedRuntime(c, env)))(contract)
  const report = await refreshVaultEmbeddings({
    db,
    vaultDb: openVaultDb(vaultId),
    vaultId,
    vaultRoot,
    generation,
    contract,
    chunker: runtime.chunker,
    embedder: runtime.embedder,
    budgetSpent: options.budgetSpent,
  })
  let isPublished = !publishWhenComplete
  if (publishWhenComplete && !report.stoppedEarly) {
    publishVaultEmbedGeneration(db, generation)
    isPublished = true
  }
  return { ...report, generation, published: isPublished }
}
