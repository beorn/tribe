/**
 * The vault embedding model and contract, shared by the refresh and the query leg (@ag/recall/three-dark-search-paths).
 *
 * Loads neither qmd's store nor a model, so a bound search imports it before its lexical work (CTO 0edff0e3 fix 1).
 * The contract pins the ruled GGUF digest (fix 4); the digest and the stat describe one resolved file (fix 8).
 */
import { createHash } from "node:crypto"
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { LlamaCpp } from "@tobilu/qmd/llm"
import type { VaultEmbedContract } from "./vault-embed-store.ts"

export const RECALL_EMBED_MODEL_ENV = "RECALL_EMBED_MODEL"

/** The ruled GGUF (D4): EmbeddingGemma-300M-Q8_0, the model qmd's existing vectors came from. */
export const RECALL_EMBED_MODEL_SHA256 = "b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63"

/** EmbeddingGemma-300M's trained context; qmd embeds at the smaller of this and its QMD_EMBED_CONTEXT_SIZE. */
const EMBEDDINGGEMMA_TRAIN_CONTEXT = 2048

/**
 * qmd's embedding context size, which follows QMD_EMBED_CONTEXT_SIZE. qmd 2.8.3 declares the static private but sets
 * it at load; the contract pins llm.js by hash, so a qmd that moves it is a different contract.
 */
const qmdEmbedContextSize: unknown = (LlamaCpp as unknown as { readonly EMBED_CONTEXT_SIZE: unknown })
  .EMBED_CONTEXT_SIZE

/** The context size qmd reports, refused loudly unless it is a positive integer (CTO r2, author point b). */
export function requireQmdContextSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `qmd's LlamaCpp.EMBED_CONTEXT_SIZE is ${JSON.stringify(value) ?? String(value)}, not a positive integer; the installed qmd no longer exposes the context size the vault embedding contract needs`,
    )
  }
  return value
}

/** The declared model, resolved to its realpath; unset or absent fails loudly with the remedy. */
export function requireRecallEmbedModel(env: NodeJS.ProcessEnv = process.env): string {
  const path = env[RECALL_EMBED_MODEL_ENV]
  if (!path) {
    throw new Error(
      `${RECALL_EMBED_MODEL_ENV} is not set, so vault embeddings cannot run. Run recall through its flake wrapper, which sets it to the declared EmbeddingGemma-300M-Q8_0 GGUF.`,
    )
  }
  if (!existsSync(path)) {
    throw new Error(
      `${RECALL_EMBED_MODEL_ENV}=${path} does not exist, so vault embeddings cannot run. Rebuild the flake wrapper so the declared GGUF is in the store.`,
    )
  }
  return realpathSync(path)
}

/** SHA-256 of the installed, patched qmd module that computes the input (CTO B1 condition). Reads; never loads. */
export function qmdModuleSha256(specifier: "@tobilu/qmd/store" | "@tobilu/qmd/llm"): string {
  return createHash("sha256")
    .update(readFileSync(fileURLToPath(import.meta.resolve(specifier))))
    .digest("hex")
}

/** The rev23 contract: EmbeddingGemma-300M-Q8_0 through qmd 2.8.3's own procedure. */
export function recallEmbedContract(): VaultEmbedContract {
  const qmdPackage = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.resolve("@tobilu/qmd/store"))), "utf8"),
  ) as { version: string }
  return {
    model: "EmbeddingGemma-300M-Q8_0",
    modelSha256: RECALL_EMBED_MODEL_SHA256,
    dimensions: 768,
    pooling: "mean",
    contextTokens: Math.min(requireQmdContextSize(qmdEmbedContextSize), EMBEDDINGGEMMA_TRAIN_CONTEXT),
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

/** `realpath:size:mtimeMs`: how a query names the model without hashing it (D4). */
export function modelFileStat(path: string): string {
  const real = realpathSync(path)
  const stat = statSync(real)
  return `${real}:${stat.size}:${stat.mtimeMs}`
}

/** The model as both sides name it: the refresh by digest, a query by stat. */
export interface ModelIdentity {
  readonly sha256: string
  readonly stat: string
}

/** Hash one resolved file, with its stat taken before and after; a file that changed underneath is refused. */
export async function modelIdentity(path: string): Promise<ModelIdentity> {
  const real = realpathSync(path)
  const before = modelFileStat(real)
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(real)) hash.update(chunk as Buffer)
  const after = modelFileStat(real)
  if (after !== before) {
    throw new Error(
      `the embedding model ${real} changed while it was hashed (${before} became ${after}); run the pass again`,
    )
  }
  return { sha256: hash.digest("hex"), stat: before }
}

/** The refusal when the declared GGUF is not the one the contract pins. */
export function requirePinnedModel(contract: VaultEmbedContract, model: ModelIdentity): void {
  if (model.sha256 !== contract.modelSha256) {
    throw new Error(
      `${RECALL_EMBED_MODEL_ENV} names a GGUF with sha256 ${model.sha256}, but the contract pins ${contract.modelSha256} (${contract.model}); vectors from another model are never written`,
    )
  }
}
