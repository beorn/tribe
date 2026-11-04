/**
 * @failure The vault refresh could load qmd's hf: default model (a download), or build inputs other than qmd's own.
 * @level l1
 * @consumer @ag/recall/three-dark-search-paths (vault semantic leg, slice 2: qmd procedure, CTO GO 8d4ea4f4 B1/B2)
 * @testonly none
 *
 * Requirement (CTO 8d4ea4f4 B2): the refresh registers one instance as qmd's default before any qmd call and uses it
 * to tokenize, truncate and embed; with a fixture instance registered, nothing reaches qmd's default model or a
 * download. A missing RECALL_EMBED_MODEL fails loudly with the remedy before any qmd call. A null vector from qmd's
 * embedBatch is an error, never a skipped chunk. contract_json can carry the patched store.js/llm.js SHA-256 (B1).
 * CTO r2 author point (b): the context size read from qmd is refused loudly unless it is a positive integer, so a qmd
 * that moves the static fails instead of recording null in the contract.
 * Gap: the refresh core tests inject a stand-in chunker; nothing exercises qmd's real chunker and formatter path.
 */
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getDefaultLlamaCpp, LlamaCpp, setDefaultLlamaCpp } from "@tobilu/qmd/llm"
import { safeRemoveSync } from "removely"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { initSchema } from "../../src/history/db-schema"
import {
  qmdModuleSha256,
  recallEmbedContract,
  requireQmdContextSize,
  requireRecallEmbedModel,
} from "../../src/history/vault-embed-model"
import { registerQmdEmbedRuntime, type QmdEmbedLlm } from "../../src/history/vault-embed-qmd"
import { refreshVaultEmbeddings } from "../../src/history/vault-embed-refresh"
import { beginVaultEmbedGeneration, type VaultEmbedContract } from "../../src/history/vault-embed-store"

const CONTRACT: VaultEmbedContract = {
  model: "fixture-embed",
  modelSha256: "b".repeat(64),
  dimensions: 4,
  pooling: "mean",
  contextTokens: 2048,
  queryPrefix: "task: search result | query: ",
  documentPrefix: "title: ",
  chunkTokens: 900,
  overlapTokens: 135,
  windowTokens: 200,
  qmdVersion: "2.8.3",
  qmdStoreSha256: "a".repeat(64),
  qmdLlmSha256: "b".repeat(64),
}

function fixtureLlm(): QmdEmbedLlm & { embedded: string[]; tokenized: number } {
  const state = { embedded: [] as string[], tokenized: 0 }
  return {
    get embedded() {
      return state.embedded
    },
    get tokenized() {
      return state.tokenized
    },
    tokenize: async (text) => {
      state.tokenized++
      return Array.from(text)
    },
    detokenize: async (tokens) => tokens.join(""),
    truncateToContextSize: async (text) => ({ text, truncated: false, limit: 2048 }),
    embedBatch: async (texts) => {
      state.embedded.push(...texts)
      return texts.map((text) => {
        const b = createHash("sha256").update(text).digest()
        return { embedding: [b[0]!, b[1]!, b[2]!, b[3]!] }
      })
    },
  }
}

describe("qmd embed runtime", () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "recall-vault-qmd-"))
  })
  afterEach(() => {
    setDefaultLlamaCpp(null)
    vi.restoreAllMocks()
    safeRemoveSync(root, { within: tmpdir() })
  })

  test("qmd's context size must be a positive integer; the installed qmd's is, and the contract caps it at 2048", () => {
    for (const bad of [undefined, null, 0, -1, 1.5, "2048"]) {
      expect(() => requireQmdContextSize(bad)).toThrow(/EMBED_CONTEXT_SIZE is .* not a positive integer/)
    }
    expect(requireQmdContextSize(512)).toBe(512)
    expect(recallEmbedContract().contextTokens).toBeLessThanOrEqual(2048)
  })

  test("a missing or absent RECALL_EMBED_MODEL fails loudly with the remedy", () => {
    expect(() => requireRecallEmbedModel({})).toThrow(/RECALL_EMBED_MODEL is not set.*flake wrapper/)
    expect(() => requireRecallEmbedModel({ RECALL_EMBED_MODEL: join(root, "missing.gguf") })).toThrow(
      /does not exist.*Rebuild the flake wrapper/,
    )
    const present = join(root, "model.gguf")
    writeFileSync(present, "gguf")
    expect(requireRecallEmbedModel({ RECALL_EMBED_MODEL: present })).toBe(realpathSync(present))
  })

  test("with a fixture registered, a refresh runs qmd's chunker and formatter on it and never reaches qmd's default model", async () => {
    const ensureEmbed = vi.spyOn(
      LlamaCpp.prototype as unknown as { ensureEmbedContext: () => unknown },
      "ensureEmbedContext",
    )
    const llm = fixtureLlm()
    const runtime = registerQmdEmbedRuntime(llm, "/store/embeddinggemma-300M-Q8_0.gguf", CONTRACT)
    expect(getDefaultLlamaCpp()).toBe(llm)

    const content = "# Alpha\n\nBody text."
    writeFileSync(join(root, "a.md"), content)
    const vault = new Database(":memory:")
    vault.exec(
      "CREATE TABLE nodes (id TEXT PRIMARY KEY, fstype TEXT, fs_path TEXT, fs_mtime INTEGER, fs_content_hash TEXT)",
    )
    vault
      .prepare("INSERT INTO nodes VALUES ('n1', 'mdfile', 'a.md', 1, ?)")
      .run(createHash("sha256").update(content).digest("hex"))
    const db = new Database(":memory:")
    initSchema(db)
    const generation = beginVaultEmbedGeneration(db, {
      contract: CONTRACT,
      ggufSha256: "c".repeat(64),
      ggufStat: "m:1:1",
      now: 1,
    })

    const report = await refreshVaultEmbeddings({
      db,
      vaultDb: vault,
      vaultId: "/fixture/state.db",
      vaultRoot: root,
      generation,
      contract: CONTRACT,
      ...runtime,
      timeLeftMs: () => Number.POSITIVE_INFINITY,
    })

    expect(report).toMatchObject({ embeddedDocuments: 1, embeddedChunks: 1 })
    expect(llm.tokenized).toBeGreaterThan(0)
    expect(llm.embedded).toEqual([`title: Alpha | text: ${content}`])
    expect(ensureEmbed).not.toHaveBeenCalled()
    db.close()
    vault.close()
  })

  test("a null vector from qmd's embedBatch is an error, never a skipped chunk", async () => {
    const llm = { ...fixtureLlm(), embedBatch: async (texts: string[]) => texts.map(() => null) }
    const runtime = registerQmdEmbedRuntime(llm, "/store/model.gguf", CONTRACT)
    await expect(runtime.embedder.embed(["x", "y"])).rejects.toThrow(/no vector for input 1 of 2/)
  })

  test("the patched qmd store.js and llm.js each have a SHA-256 for contract_json", () => {
    const store = qmdModuleSha256("@tobilu/qmd/store")
    const llm = qmdModuleSha256("@tobilu/qmd/llm")
    expect(store).toMatch(/^[0-9a-f]{64}$/)
    expect(llm).toMatch(/^[0-9a-f]{64}$/)
    expect(store).not.toBe(llm)
  })
})
