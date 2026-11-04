/**
 * @failure The vault semantic leg could rank stale vectors, reorder non-vault results, or fail silently.
 * @level l1
 * @consumer @ag/recall/three-dark-search-paths (vault semantic leg, slice 3: query leg, RRF60, degradation)
 * @testonly none
 *
 * Requirement (rev23 P:70/72, D2, D4, AC2/AC4/AC7): one query embedding; vectors count only while doc_hash equals
 * km's current fs_content_hash; the published generation must match the running contract and model file stat;
 * equal RRF60 over vault documents only, fused document i taking lexical slot i's rank, nothing added when no lexical
 * vault candidate exists; any failure keeps the lexical hits and names its cause; the hook and an unset option never
 * load a model.
 * Gap: no test reads vault_doc_embed at query time or composes a second vault ranking in recall().
 * Fixtures: a private km vault (nodes + nodes_fts) and an in-memory index; the query model is a fixture.
 */
import { Database } from "bun:sqlite"
import { assertSingleStatement } from "@bearly/sqlite"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { VaultQueryModel } from "../../src/history/vault-semantic"

process.env.RECALL_DB_PATH = ":memory:"

const DIM = 768
const basis = (k: number) => {
  const v = new Float32Array(DIM)
  v[k] = 1
  return v
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")
describe("the vault semantic leg in recall()", () => {
  let root: string
  let vaultPath: string
  let modelPath: string
  let opened: number
  let disposed: number
  let inputs: string[]
  const savedModel = process.env.RECALL_EMBED_MODEL

  const fixtureModel = (): VaultQueryModel => {
    opened++
    return {
      embed: async (input) => {
        inputs.push(input)
        return basis(0)
      },
      dispose: async () => {
        disposed++
      },
    }
  }

  const docs = [
    { fsPath: "a.md", content: "zebracorn alpha" },
    { fsPath: "b.md", content: "nothing lexical here" },
    { fsPath: "c.md", content: "zebracorn gamma" },
  ]

  beforeEach(async () => {
    vi.resetModules()
    opened = 0
    disposed = 0
    inputs = []
    root = realpathSync(mkdtempSync(join(tmpdir(), "recall-vault-semantic-")))
    mkdirSync(join(root, ".km"))
    vaultPath = join(root, ".km", "state.db")
    const vault = new Database(vaultPath)
    for (const sql of [
      "CREATE TABLE nodes (rowid INTEGER PRIMARY KEY, id TEXT, parent_id TEXT, fs_path TEXT, name TEXT, title TEXT, content TEXT, fstype TEXT, fs_content_hash TEXT)",
      "CREATE VIRTUAL TABLE nodes_fts USING fts5(id, name, title, content, content='nodes', content_rowid='rowid')",
      "CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN INSERT INTO nodes_fts(rowid, id, name, title, content) VALUES (new.rowid, new.id, new.name, new.title, new.content); END",
    ]) {
      vault.exec(assertSingleStatement(sql))
    }
    const insert = vault.prepare(
      "INSERT INTO nodes (id, fs_path, name, title, content, fstype, fs_content_hash) VALUES (?, ?, ?, ?, ?, 'mdfile', ?)",
    )
    for (const doc of docs) {
      insert.run(`n:${doc.fsPath}`, doc.fsPath, doc.fsPath, doc.fsPath, doc.content, sha256(doc.content))
    }
    vault.close()
    modelPath = join(root, "model.gguf")
    writeFileSync(modelPath, "fixture model")
    process.env.RECALL_EMBED_MODEL = modelPath
  })

  afterEach(async () => {
    const { closeDb } = await import("../../src/history/db")
    closeDb()
    if (savedModel === undefined) delete process.env.RECALL_EMBED_MODEL
    else process.env.RECALL_EMBED_MODEL = savedModel
    safeRemoveSync(root, { within: tmpdir() })
  })

  /** Publish a generation for the running contract and this model file, holding b.md's vector (and a stale a.md). */
  async function publish(options: { stat?: string } = {}) {
    const { getDb } = await import("../../src/history/db")
    const { modelFileStat, recallEmbedContract } = await import("../../src/history/vault-embed-model")
    const store = await import("../../src/history/vault-embed-store")
    const db = getDb()
    const id = store.beginVaultEmbedGeneration(db, {
      contract: recallEmbedContract(),
      ggufSha256: "c".repeat(64),
      ggufStat: options.stat ?? modelFileStat(modelPath),
      now: 1,
    })
    store.publishVaultEmbedGeneration(db, id)
    const insert = db.prepare(
      "INSERT INTO vault_doc_embed (generation, vault_id, fs_path, doc_hash, chunk, input_key, vec) VALUES (?, ?, ?, ?, 0, 'k', ?)",
    )
    insert.run(id, vaultPath, "b.md", sha256("nothing lexical here"), store.encodeVaultVector(basis(0), DIM))
    // a.md's vector is for text km no longer holds: it must not count.
    insert.run(id, vaultPath, "a.md", sha256("old alpha"), store.encodeVaultVector(basis(0), DIM))
  }

  async function run(
    options: { vaultSemantic?: boolean; mode?: "exact" | "hook"; query?: string; model?: () => VaultQueryModel } = {},
  ) {
    const { recall, setRecallLogging } = await import("../../src/history/search")
    setRecallLogging(false)
    return recall(options.query ?? "zebracorn", {
      raw: true,
      excludeCurrentSession: true,
      vaultDb: vaultPath,
      vaultSemantic: options.vaultSemantic ?? true,
      mode: options.mode,
      deps: { vaultQueryModel: options.model ?? fixtureModel, vaultQueryTimeoutMs: 50 },
    })
  }

  const vaultHits = (result: { results: { type: string; sessionId: string; rank: number }[] }) =>
    result.results.filter((r) => r.type === "vault").map((r) => r.sessionId)

  test("one formatted query embedding; only current-hash vectors count; the semantic-only document is fused in", async () => {
    await publish()
    const result = await run()
    expect(inputs).toEqual(["task: search result | query: zebracorn"])
    expect(disposed).toBe(1)
    expect(result.vaultSemantic).toEqual({
      state: "ok",
      generation: 1,
      coverage: { documents: 3, embedded: 1 },
      added: 1,
    })
    // Equal RRF60: b.md (semantic only) ties a.md and outranks c.md, taking c.md's lexical slot and its rank.
    expect(vaultHits(result)).toEqual(["a.md", "b.md"])
  })

  test("no lexical vault candidate means the semantic leg adds nothing", async () => {
    await publish()
    const result = await run({ query: "quokka" })
    expect(inputs).toEqual(["task: search result | query: quokka"])
    expect(result.vaultSemantic).toMatchObject({ state: "ok", added: 0 })
    expect(vaultHits(result)).toEqual([])
  })

  test("a query embedding slower than its cap degrades with the cause, and the model is still disposed", async () => {
    await publish()
    const result = await run({
      model: () => ({
        embed: () => new Promise<Float32Array>(() => {}),
        dispose: async () => {
          disposed++
        },
      }),
    })
    expect(result.vaultSemantic).toMatchObject({ state: "degraded", cause: /took longer than 50 ms/ })
    expect(disposed).toBe(1)
    expect(vaultHits(result).sort()).toEqual(["a.md", "c.md"])
  })

  test("the query embedding starts before the vault FTS runs (CTO 0edff0e3 fix 1)", async () => {
    await publish()
    const order: string[] = []
    const prepare = Database.prototype.prepare
    const spy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database, sql: string) {
      if (sql.includes("nodes_fts")) order.push("fts")
      return prepare.call(this, sql)
    } as typeof prepare)
    try {
      const result = await run({
        model: () => ({
          embed: async () => {
            order.push("embed")
            return basis(0)
          },
          dispose: async () => {},
        }),
      })
      expect(result.vaultSemantic?.state).toBe("ok")
    } finally {
      spy.mockRestore()
    }
    expect(order[0]).toBe("embed")
    expect(order).toContain("fts")
  })

  test("a model load that never settles still degrades within the cap (CTO 0edff0e3 fix 2)", async () => {
    await publish()
    const started = performance.now()
    const result = await run({
      model: () => ({
        embed: () => new Promise<Float32Array>(() => {}),
        // Production dispose waits for the load, so it never settles either.
        dispose: () => new Promise<void>(() => {}),
      }),
    })
    expect(result.vaultSemantic).toMatchObject({ state: "degraded", cause: /took longer than 50 ms/ })
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(vaultHits(result).sort()).toEqual(["a.md", "c.md"])
  })

  test("no published generation degrades with its cause and keeps the lexical vault hits", async () => {
    const result = await run()
    expect(result.vaultSemantic).toMatchObject({
      state: "degraded",
      cause: /no vault embedding generation is published/,
    })
    expect(vaultHits(result).sort()).toEqual(["a.md", "c.md"])
  })

  test("a model file whose stat changed since the generation recorded it degrades, naming both", async () => {
    await publish({ stat: "/elsewhere/model.gguf:1:1" })
    const result = await run()
    expect(result.vaultSemantic?.state).toBe("degraded")
    expect(result.vaultSemantic?.cause).toMatch(
      /recorded its model file as \/elsewhere\/model\.gguf:1:1, but it is now/,
    )
  })

  test("a missing RECALL_EMBED_MODEL degrades with the remedy and loads no model", async () => {
    await publish()
    delete process.env.RECALL_EMBED_MODEL
    const result = await run()
    expect(result.vaultSemantic).toMatchObject({ state: "degraded", cause: /RECALL_EMBED_MODEL is not set/ })
    expect(opened).toBe(0)
    expect(vaultHits(result).sort()).toEqual(["a.md", "c.md"])
  })

  test("the option unset, or hook mode, never loads a model or reports a leg", async () => {
    await publish()
    const plain = await run({ vaultSemantic: false })
    const hook = await run({ mode: "hook" })
    expect(opened).toBe(0)
    expect(plain.vaultSemantic).toBeUndefined()
    expect(hook.vaultSemantic).toBeUndefined()
  })
})
