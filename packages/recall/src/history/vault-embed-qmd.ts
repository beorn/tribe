/**
 * qmd's own document procedure for the vault embedding refresh (CTO GO 8d4ea4f4, B1 and B2).
 *
 * One LlamaCpp instance, built on RECALL_EMBED_MODEL, is registered as qmd's default before any qmd call, so qmd
 * never resolves its hf: default model or downloads anything. That instance tokenizes (chunkDocumentByTokens),
 * truncates (truncateToContextSize) and embeds (embedBatch): the procedure that made qmd's existing vectors.
 */
import { formatDocForEmbedding, LlamaCpp, setDefaultLlamaCpp } from "@tobilu/qmd/llm"
import { chunkDocumentByTokens, extractTitle } from "@tobilu/qmd/store"
import { requireRecallEmbedModel } from "./vault-embed-model.ts"
import type { VaultEmbedChunker, VaultEmbedder } from "./vault-embed-refresh.ts"
import type { VaultEmbedContract } from "./vault-embed-store.ts"

/** The parts of qmd's LlamaCpp the refresh uses; a test registers a fixture with the same shape. */
export interface QmdEmbedLlm {
  tokenize(text: string): Promise<readonly unknown[]>
  detokenize(tokens: readonly unknown[]): Promise<string>
  truncateToContextSize(text: string): Promise<{ text: string; truncated: boolean; limit: number }>
  embedBatch(texts: string[]): Promise<({ embedding: number[] } | null)[]>
}

export interface QmdEmbedRuntime {
  readonly chunker: VaultEmbedChunker
  readonly embedder: VaultEmbedder
}

/** Register `llm` as qmd's default and build the refresh's chunker and embedder on it. */
export function registerQmdEmbedRuntime(
  llm: QmdEmbedLlm,
  modelUri: string,
  contract: VaultEmbedContract,
): QmdEmbedRuntime {
  setDefaultLlamaCpp(llm as unknown as LlamaCpp)
  const chunker: VaultEmbedChunker = {
    chunk: (content, fsPath) =>
      chunkDocumentByTokens(content, contract.chunkTokens, contract.overlapTokens, contract.windowTokens, fsPath),
    title: (content, fsPath) => extractTitle(content, fsPath),
    format: async (text, title) => (await llm.truncateToContextSize(formatDocForEmbedding(text, title, modelUri))).text,
  }
  const embedder: VaultEmbedder = {
    embed: async (inputs) => {
      const results = await llm.embedBatch([...inputs])
      return results.map((result, index) => {
        // qmd's embedBatch logs and returns null on a failed text; a missing vector is an error here.
        if (!result) {
          throw new Error(`the embedding model returned no vector for input ${index + 1} of ${inputs.length}`)
        }
        return new Float32Array(result.embedding)
      })
    },
  }
  return { chunker, embedder }
}

/** Production: one LlamaCpp on RECALL_EMBED_MODEL, registered before any qmd call. */
export function createQmdEmbedRuntime(
  contract: VaultEmbedContract,
  env: NodeJS.ProcessEnv = process.env,
): QmdEmbedRuntime {
  const modelPath = requireRecallEmbedModel(env)
  return registerQmdEmbedRuntime(new LlamaCpp({ embedModel: modelPath }) as unknown as QmdEmbedLlm, modelPath, contract)
}
