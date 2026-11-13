/**
 * @failure The vault pass could mix vectors from two models in one generation, or serve none while a backfill runs.
 * @level l1
 * @consumer @ag/recall/three-dark-search-paths (vault semantic leg, slice 2: generation selection, CTO D4)
 * @testonly none
 *
 * Requirement (D4, amended by CTO 3bad8137/a01b54d9): a pass hashes on first use or changed stat/contract, otherwise
 * reuses its stored verified digest without expensive setup; it refreshes the published
 * generation only when its contract and digest match; a changed digest fills a separate building generation and
 * publishes it only after a complete pass; the first generation is published at once so partial coverage is served;
 * vault_id is the realpath of the bound state.db and file paths resolve against <root> of <root>/.km/state.db.
 * CTO verdict 0edff0e3 fixes 4 and 8: the contract pins the ruled GGUF digest and a pass under another digest is
 * refused naming both; the digest and the stat describe one resolved file, and a resumed building generation
 * records the model's current stat.
 * Gap: the refresh tests take a generation id as given; nothing tests how a pass picks or publishes one.
 */
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStore, insertContent, insertEmbedding } from "@tobilu/qmd/store"
import { safeRemoveSync } from "removely"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { initSchema } from "../../src/history/db-schema"
import type { QmdEmbedRuntime } from "../../src/history/vault-embed-qmd"
import { runVaultEmbedPass, runVaultEmbedSeed, vaultRootOf } from "../../src/history/vault-embed-index"
import type { VaultEmbedContract } from "../../src/history/vault-embed-store"

// Observe the real model stream through the module boundary; ESM exports cannot be spied on in place.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) }
})

const CONTRACT: VaultEmbedContract = {
  model: "fixture-embed",
  modelSha256: createHash("sha256").update("model one").digest("hex"),
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
  /** A budget of embed calls: the time left reads as ample until that many calls have run, then as spent. */
  const pass = (budget = Number.POSITIVE_INFINITY, contract = CONTRACT) => {
    let calls = 0
    const base = fixtureRuntime()
    return runVaultEmbedPass({
      db,
      vaultDbPath: statePath,
      timeLeftMs: () => (calls < budget ? 1e12 : 0),
      now: 1,
      env: { RECALL_EMBED_MODEL: modelPath },
      contract,
      runtime: () => ({
        chunker: base.chunker,
        embedder: {
          embed: async (inputs) => {
            calls++
            return base.embedder.embed(inputs)
          },
        },
      }),
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
    const report = await pass(2)
    expect(report).toMatchObject({ generation: 1, published: true, embeddedDocuments: 1, stoppedEarly: true })
    expect(generations()).toEqual([{ id: 1, gguf_sha256: sha256("model one"), state: "published" }])
    expect(db.prepare("SELECT DISTINCT vault_id FROM vault_doc_embed").all()).toEqual([{ vault_id: statePath }])
    // An index whose transcript phase spent the window must retain coverage and start no native runtime.
    const runtime = vi.fn(() => fixtureRuntime())
    const spent = await runVaultEmbedPass({
      db,
      vaultDbPath: statePath,
      timeLeftMs: () => 0,
      env: { RECALL_EMBED_MODEL: modelPath },
      contract: CONTRACT,
      runtime,
    })
    expect(spent).toMatchObject({
      coveredDocuments: 1,
      embeddedDocuments: 0,
      embeddedChunks: 0,
      stoppedEarly: true,
      uncovered: { "refresh budget spent before this document": 1 },
    })
    expect(runtime).not.toHaveBeenCalled()
    const second = await pass()
    expect(second).toMatchObject({ generation: 1, embeddedDocuments: 1, coveredDocuments: 1 })
  })

  test("a persisted fully covered repeat avoids model hashing, vector loading, runtime construction, and embedding", async () => {
    addDoc("a.md", "A\n\na", 1)
    const indexPath = join(root, "session-index.db")
    db.close()
    db = new Database(indexPath)
    initSchema(db)
    await pass()

    db.close()
    db = new Database(indexPath)
    initSchema(db)

    let runtimeBuilds = 0
    let embedCalls = 0
    const base = fixtureRuntime()
    const stream = vi.mocked(fs.createReadStream)
    stream.mockClear()
    const prepare = vi.spyOn(db, "prepare")
    try {
      const report = await runVaultEmbedPass({
        db,
        vaultDbPath: statePath,
        timeLeftMs: () => 1e12,
        now: 2,
        env: { RECALL_EMBED_MODEL: modelPath },
        contract: CONTRACT,
        runtime: () => {
          runtimeBuilds++
          return {
            chunker: base.chunker,
            embedder: {
              embed: async (inputs) => {
                embedCalls += inputs.length
                return base.embedder.embed(inputs)
              },
            },
          }
        },
      })
      const modelHashStreams = stream.mock.calls.filter(([file]) => file === modelPath).length
      const generationVectorLoads = prepare.mock.calls.filter(([sql]) =>
        String(sql).includes("SELECT input_key, vec FROM vault_doc_embed"),
      ).length
      expect(report).toMatchObject({ generation: 1, coveredDocuments: 1, embeddedDocuments: 0, embeddedChunks: 0 })
      expect({ modelHashStreams, generationVectorLoads, runtimeBuilds, embedCalls }).toEqual({
        modelHashStreams: 0,
        generationVectorLoads: 0,
        runtimeBuilds: 0,
        embedCalls: 0,
      })
    } finally {
      prepare.mockRestore()
      stream.mockClear()
    }
  })

  test("an unchanged model is not streamed again when a new document needs embedding", async () => {
    addDoc("a.md", "A\n\na", 1)
    const indexPath = join(root, "session-index.db")
    db.close()
    db = new Database(indexPath)
    initSchema(db)
    await pass()

    addDoc("b.md", "B\n\nb", 2)
    db.close()
    db = new Database(indexPath)
    initSchema(db)

    let runtimeBuilds = 0
    let embedCalls = 0
    const base = fixtureRuntime()
    const stream = vi.mocked(fs.createReadStream)
    stream.mockClear()
    try {
      const report = await runVaultEmbedPass({
        db,
        vaultDbPath: statePath,
        timeLeftMs: () => 1e12,
        now: 2,
        env: { RECALL_EMBED_MODEL: modelPath },
        contract: CONTRACT,
        runtime: () => {
          runtimeBuilds++
          return {
            chunker: base.chunker,
            embedder: {
              embed: async (inputs) => {
                embedCalls += inputs.length
                return base.embedder.embed(inputs)
              },
            },
          }
        },
      })
      const modelHashStreams = stream.mock.calls.filter(([file]) => file === modelPath).length
      expect(report).toMatchObject({ generation: 1, embeddedDocuments: 1, coveredDocuments: 1 })
      expect({ modelHashStreams, runtimeBuilds, embedCalls }).toEqual({
        modelHashStreams: 0,
        runtimeBuilds: 1,
        embedCalls: 2,
      })
    } finally {
      stream.mockClear()
    }
  })

  // Warm-cache integrity is distinct from the cold pin test: no-work coverage must not bypass validation.
  test("a verified cache rehashes changed path, stat, or contract and still rejects a missing or wrong model", async () => {
    addDoc("a.md", "A\n\na", 1)
    const stream = vi.mocked(fs.createReadStream)
    stream.mockClear()
    try {
      await pass()
      expect(stream).toHaveBeenCalledTimes(1)

      modelPath = join(root, "moved-model.gguf")
      writeFileSync(modelPath, "model one")
      await pass()
      expect(stream).toHaveBeenCalledTimes(2)

      utimesSync(modelPath, 1_000, 2_000)
      await pass()
      expect(stream).toHaveBeenCalledTimes(3)

      const changedContract = { ...CONTRACT, documentPrefix: "changed: " }
      await pass(Number.POSITIVE_INFINITY, changedContract)
      expect(stream).toHaveBeenCalledTimes(4)

      writeFileSync(modelPath, "not the ruled model")
      await expect(pass(Number.POSITIVE_INFINITY, changedContract)).rejects.toThrow(/contract pins/)
      expect(stream).toHaveBeenCalledTimes(5)

      unlinkSync(modelPath)
      await expect(pass(Number.POSITIVE_INFINITY, changedContract)).rejects.toThrow(/does not exist/)
      expect(stream).toHaveBeenCalledTimes(5)
    } finally {
      stream.mockClear()
    }
  })

  test("a changed GGUF fills a building generation and publishes it only after a complete pass", async () => {
    addDoc("a.md", "A\n\na", 1)
    addDoc("b.md", "B\n\nb", 2)
    await pass()
    writeFileSync(modelPath, "model two")
    const two = { ...CONTRACT, modelSha256: sha256("model two") }

    const partial = await pass(2, two)
    expect(partial).toMatchObject({ generation: 2, published: false, stoppedEarly: true })
    expect(generations()).toEqual([
      { id: 1, gguf_sha256: sha256("model one"), state: "published" },
      { id: 2, gguf_sha256: sha256("model two"), state: "building" },
    ])

    const complete = await pass(Number.POSITIVE_INFINITY, two)
    expect(complete).toMatchObject({ generation: 2, published: true, embeddedDocuments: 1, coveredDocuments: 1 })
    expect(generations()).toEqual([
      { id: 1, gguf_sha256: sha256("model one"), state: "retired" },
      { id: 2, gguf_sha256: sha256("model two"), state: "published" },
    ])
  })

  test("a GGUF other than the contract's pinned digest is refused naming both, and nothing is selected", async () => {
    addDoc("a.md", "A\n\na", 1)
    writeFileSync(modelPath, "not the ruled model")
    await expect(pass()).rejects.toThrow(
      new RegExp(`sha256 ${sha256("not the ruled model")}.*pins ${CONTRACT.modelSha256}`),
    )
    expect(generations()).toEqual([])
  })

  test("a vault bound through a symlink is keyed by the realpath of its state.db", async () => {
    addDoc("a.md", "A\n\na", 1)
    const linked = `${root}-link`
    symlinkSync(root, linked)
    try {
      await runVaultEmbedPass({
        db,
        vaultDbPath: join(linked, ".km", "state.db"),
        timeLeftMs: () => 1e12,
        now: 1,
        env: { RECALL_EMBED_MODEL: modelPath },
        contract: CONTRACT,
        runtime: fixtureRuntime,
      })
      expect(db.prepare("SELECT DISTINCT vault_id FROM vault_doc_embed").all()).toEqual([{ vault_id: statePath }])
    } finally {
      unlinkSync(linked)
    }
  })

  test("a symlinked RECALL_EMBED_MODEL is hashed and stat'ed as its one realpath", async () => {
    addDoc("a.md", "A\n\na", 1)
    const link = join(root, "link.gguf")
    symlinkSync(modelPath, link)
    await runVaultEmbedPass({
      db,
      vaultDbPath: statePath,
      timeLeftMs: () => 1e12,
      now: 1,
      env: { RECALL_EMBED_MODEL: link },
      contract: CONTRACT,
      runtime: fixtureRuntime,
    })
    const row = db.prepare("SELECT gguf_sha256, gguf_stat FROM vault_embed_generation").get() as {
      gguf_sha256: string
      gguf_stat: string
    }
    expect(row.gguf_sha256).toBe(sha256("model one"))
    expect(row.gguf_stat).toBe(`${modelPath}:${statSync(modelPath).size}:${statSync(modelPath).mtimeMs}`)
  })

  test("a resumed building generation records the model's current stat", async () => {
    addDoc("a.md", "A\n\na", 1)
    addDoc("b.md", "B\n\nb", 2)
    await pass()
    writeFileSync(modelPath, "model two")
    const two = { ...CONTRACT, modelSha256: sha256("model two") }
    await pass(2, two)
    utimesSync(modelPath, 1_000, 2_000)
    await pass(2, two)
    const stat = db.prepare("SELECT gguf_stat FROM vault_embed_generation WHERE id = 2").get() as { gguf_stat: string }
    expect(stat.gguf_stat).toBe(`${modelPath}:${statSync(modelPath).size}:${statSync(modelPath).mtimeMs}`)
    expect(stat.gguf_stat).toMatch(/:2000000$/)
  })

  test("an unset RECALL_EMBED_MODEL fails before any runtime is built", async () => {
    let built = false
    await expect(
      runVaultEmbedPass({
        db,
        vaultDbPath: statePath,
        timeLeftMs: () => 1e12,
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
      timeLeftMs: () => 1e12,
      now: 1,
      env: { RECALL_EMBED_MODEL: modelPath },
      contract: CONTRACT,
      runtime: counting,
    })
    expect(report).toMatchObject({ generation: 1, coveredDocuments: 1, embeddedChunks: 0 })
    expect(embedded).toBe(0)
  })

  test("the seed refuses a GGUF other than the contract's pinned digest, as the pass does, selecting nothing", async () => {
    const qmdPath = join(root, "index.sqlite")
    writeFileSync(qmdPath, "")
    writeFileSync(modelPath, "not the ruled model")
    await expect(
      runVaultEmbedSeed({
        db,
        vaultDbPath: statePath,
        qmdDbPath: qmdPath,
        env: { RECALL_EMBED_MODEL: modelPath },
        contract: CONTRACT,
        runtime: fixtureRuntime,
      }),
    ).rejects.toThrow(new RegExp(`sha256 ${sha256("not the ruled model")}.*pins ${CONTRACT.modelSha256}`))
    expect(generations()).toEqual([])
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
