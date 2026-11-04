/**
 * @failure The vault pass could mix vectors from two models in one generation, or serve none while a backfill runs.
 * @level l1
 * @consumer @ag/recall/three-dark-search-paths (vault semantic leg, slice 2: generation selection, CTO D4)
 * @testonly none
 *
 * Requirement (D4, CTO 9686f199/0609d989/8d4ea4f4): the pass hashes the GGUF once and refreshes the published
 * generation only when its contract and digest match; a changed digest fills a separate building generation and
 * publishes it only after a complete pass; the first generation is published at once so partial coverage is served;
 * vault_id is the realpath of the bound state.db and file paths resolve against <root> of <root>/.km/state.db.
 * Gap: the refresh tests take a generation id as given; nothing tests how a pass picks or publishes one.
 */
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStore, insertContent, insertEmbedding } from "@tobilu/qmd/store"
import { safeRemoveSync } from "removely"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { initSchema } from "../../src/history/db-schema"
import type { QmdEmbedRuntime } from "../../src/history/vault-embed-qmd"
import { runVaultEmbedPass, runVaultEmbedSeed, vaultRootOf } from "../../src/history/vault-embed-index"
import type { VaultEmbedContract } from "../../src/history/vault-embed-store"

const CONTRACT: VaultEmbedContract = {
  model: "fixture-embed",
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
const sha256 = (data: string) => createHash("sha256").update(data).digest("hex")

const fixtureRuntime = (): QmdEmbedRuntime => ({
  chunker: {
    chunk: async (content) => content.split("\n\n").map((text) => ({ text })),
    title: (content) => content.split("\n")[0] ?? "",
    format: async (text, title) => `doc: ${title} | ${text}`,
  },
  embedder: {
    embed: async (inputs) =>
      inputs.map((input) => {
        const b = createHash("sha256").update(input).digest()
        return new Float32Array([b[0]!, b[1]!, b[2]!, b[3]!])
      }),
  },
})

describe("runVaultEmbedPass", () => {
  let root: string
  let statePath: string
  let modelPath: string
  let db: Database

  const addDoc = (fsPath: string, content: string, mtime: number) => {
    writeFileSync(join(root, fsPath), content)
    const vault = new Database(statePath)
    vault.prepare("INSERT INTO nodes VALUES (?, 'mdfile', ?, ?, ?)").run(`n:${fsPath}`, fsPath, mtime, sha256(content))
    vault.close()
  }
  const pass = (budget = Number.POSITIVE_INFINITY) => {
    let left = budget
    return runVaultEmbedPass({
      db,
      vaultDbPath: statePath,
      budgetSpent: () => left-- <= 0,
      now: 1,
      env: { RECALL_EMBED_MODEL: modelPath },
      contract: CONTRACT,
      runtime: fixtureRuntime,
    })
  }
  const generations = () => db.prepare("SELECT id, gguf_sha256, state FROM vault_embed_generation ORDER BY id").all()

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "recall-vault-pass-")))
    mkdirSync(join(root, ".km"))
    statePath = join(root, ".km", "state.db")
    const vault = new Database(statePath)
    vault.exec(
      "CREATE TABLE nodes (id TEXT PRIMARY KEY, fstype TEXT, fs_path TEXT, fs_mtime INTEGER, fs_content_hash TEXT)",
    )
    vault.close()
    modelPath = join(root, "model.gguf")
    writeFileSync(modelPath, "model one")
    db = new Database(":memory:")
    initSchema(db)
  })
  afterEach(() => {
    db.close()
    safeRemoveSync(root, { within: tmpdir() })
  })

  test("the first pass publishes its generation at once, keyed to the realpath vault id and the GGUF digest", async () => {
    addDoc("a.md", "A\n\na", 1)
    addDoc("b.md", "B\n\nb", 2)
    const report = await pass(1)
    expect(report).toMatchObject({ generation: 1, published: true, embeddedDocuments: 1, stoppedEarly: true })
    expect(generations()).toEqual([{ id: 1, gguf_sha256: sha256("model one"), state: "published" }])
    expect(db.prepare("SELECT DISTINCT vault_id FROM vault_doc_embed").all()).toEqual([{ vault_id: statePath }])
    const second = await pass()
    expect(second).toMatchObject({ generation: 1, embeddedDocuments: 1, coveredDocuments: 1 })
  })

  test("a changed GGUF fills a building generation and publishes it only after a complete pass", async () => {
    addDoc("a.md", "A\n\na", 1)
    addDoc("b.md", "B\n\nb", 2)
    await pass()
    writeFileSync(modelPath, "model two")

    const partial = await pass(1)
    expect(partial).toMatchObject({ generation: 2, published: false, stoppedEarly: true })
    expect(generations()).toEqual([
      { id: 1, gguf_sha256: sha256("model one"), state: "published" },
      { id: 2, gguf_sha256: sha256("model two"), state: "building" },
    ])

    const complete = await pass()
    expect(complete).toMatchObject({ generation: 2, published: true, embeddedDocuments: 1, coveredDocuments: 1 })
    expect(generations()).toEqual([
      { id: 1, gguf_sha256: sha256("model one"), state: "retired" },
      { id: 2, gguf_sha256: sha256("model two"), state: "published" },
    ])
  })

  test("an unset RECALL_EMBED_MODEL fails before any runtime is built", async () => {
    let built = false
    await expect(
      runVaultEmbedPass({
        db,
        vaultDbPath: statePath,
        budgetSpent: () => false,
        env: {},
        contract: CONTRACT,
        runtime: () => {
          built = true
          return fixtureRuntime()
        },
      }),
    ).rejects.toThrow(/RECALL_EMBED_MODEL is not set/)
    expect(built).toBe(false)
  })

  test("the seed fills the selected generation from a qmd store, and the next pass embeds nothing for it", async () => {
    addDoc("a.md", "A\n\na", 1)
    const qmdPath = join(root, "index.sqlite")
    const qmd = createStore(qmdPath)
    qmd.ensureVecTable(4)
    const hash = sha256("A\n\na")
    insertContent(qmd.db, hash, "A\n\na", "2026-11-01")
    for (const seq of [0, 1]) {
      insertEmbedding(qmd.db, hash, seq, 0, new Float32Array([seq, 1, 2, 3]), "hf:fixture/embed.gguf", "x", 2)
    }
    qmd.close()
    let embedded = 0
    const counting = (): QmdEmbedRuntime => {
      const base = fixtureRuntime()
      return {
        chunker: base.chunker,
        embedder: {
          embed: async (inputs) => {
            embedded += inputs.length
            return base.embedder.embed(inputs)
          },
        },
      }
    }
    const seed = await runVaultEmbedSeed({
      db,
      vaultDbPath: statePath,
      qmdDbPath: qmdPath,
      now: 1,
      env: { RECALL_EMBED_MODEL: modelPath },
      contract: CONTRACT,
      runtime: counting,
      qmdModel: "hf:fixture/embed.gguf",
    })
    expect(seed).toMatchObject({ generation: 1, seededDocuments: 1, seededChunks: 2 })
    const report = await runVaultEmbedPass({
      db,
      vaultDbPath: statePath,
      budgetSpent: () => false,
      now: 1,
      env: { RECALL_EMBED_MODEL: modelPath },
      contract: CONTRACT,
      runtime: counting,
    })
    expect(report).toMatchObject({ generation: 1, coveredDocuments: 1, embeddedChunks: 0 })
    expect(embedded).toBe(0)
  })

  test("a missing qmd store is refused before anything is selected", async () => {
    await expect(
      runVaultEmbedSeed({
        db,
        vaultDbPath: statePath,
        qmdDbPath: join(root, "absent.sqlite"),
        env: { RECALL_EMBED_MODEL: modelPath },
        contract: CONTRACT,
        runtime: fixtureRuntime,
      }),
    ).rejects.toThrow(/absent\.sqlite does not exist/)
    expect(generations()).toEqual([])
  })

  test("a vault database outside <root>/.km/state.db is refused with its cause", () => {
    expect(vaultRootOf("/v/.km/state.db")).toBe("/v")
    expect(() => vaultRootOf("/v/state.db")).toThrow(/not <vault root>\/\.km\/state\.db/)
  })
})
