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
 * load a model. CTO r2 (b7e7f718) changes 1-2: the 5 s cap is the latency the leg adds after the lexical search, so it
 * is armed after that search; a leg module that fails to load degrades, never failing the search.
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
import type { VaultLoadStepRecorder, VaultQueryModel, VaultSemanticSpans } from "../../src/history/vault-semantic"

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
    { fsPath: "a.md", content: "zebracorn zebracorn alpha" },
    { fsPath: "b.md", content: "nothing lexical here" },
    { fsPath: "c.md", content: "zebracorn gamma delta epsilon zeta eta theta iota kappa lambda" },
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
      spans: expect.any(Object),
    })
    // Equal RRF60: b.md (semantic only) ties a.md and outranks c.md, taking c.md's lexical slot and its rank.
    expect(vaultHits(result)).toEqual(["a.md", "b.md"])
  })

  test("fused vault documents inherit the lexical slots' ranks, so a non-vault result between them keeps its place", async () => {
    // recall() closes its in-memory index, so each run gets the same fixture: the generation and one transcript hit.
    const seeded = async () => {
      await publish()
      const { getDb } = await import("../../src/history/db")
      const db = getDb()
      const now = Date.now()
      db.prepare(
        "INSERT OR IGNORE INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title, cwd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("sess-m", "/test/km", "/tmp/sess-m.jsonl", now - 60_000, now, 1, "Session m", "/test/km")
      db.prepare(
        "INSERT OR IGNORE INTO messages (uuid, session_id, type, content, timestamp) VALUES (?, ?, ?, ?, ?)",
      ).run("msg-m", "sess-m", "user", "zebracorn zebracorn zebracorn in a transcript", now)
    }
    const shape = (result: { results: { type: string; sessionId: string; rank: number }[] }) =>
      result.results.map((r) => [r.type, r.type === "vault" ? "vault" : r.sessionId, r.rank])
    await seeded()
    const lexical = await run({ vaultSemantic: false })
    await seeded()
    const fused = await run()
    expect(fused.vaultSemantic).toMatchObject({ state: "ok", added: 1 })
    expect(vaultHits(fused)).toEqual(["a.md", "b.md"])
    // Same types, same non-vault results, same ranks, slot for slot: only which vault document fills a slot changed.
    expect(shape(fused)).toEqual(shape(lexical))
    const types = fused.results.map((r) => r.type)
    expect(types.indexOf("message")).toBeGreaterThan(types.indexOf("vault"))
    expect(types.indexOf("message")).toBeLessThan(types.lastIndexOf("vault"))
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

  test("the cap counts only the time after the lexical search: a 100 ms vault FTS stall leaves a 30 ms embed ok (CTO r2 change 1)", async () => {
    await publish()
    const prepare = Database.prototype.prepare
    const spy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database, sql: string) {
      if (sql.includes("nodes_fts")) {
        const until = performance.now() + 100
        while (performance.now() < until) {
          // A synchronous lexical search slower than the 50 ms cap.
        }
      }
      return prepare.call(this, sql)
    } as typeof prepare)
    try {
      const result = await run({
        model: () => ({
          // 30 ms, then one more tick, which can only run after the stall ends.
          embed: async () => {
            await new Promise((resolve) => {
              setTimeout(resolve, 30)
            })
            await new Promise((resolve) => {
              setTimeout(resolve, 0)
            })
            return basis(0)
          },
          dispose: async () => {},
        }),
      })
      expect(result.vaultSemantic).toMatchObject({ state: "ok" })
    } finally {
      spy.mockRestore()
    }
  })

  test("a vault semantic module that fails to load degrades with its cause and keeps the lexical hits (CTO r2 change 2)", async () => {
    await publish()
    vi.doMock("../../src/history/vault-semantic.ts", () => {
      throw new Error("fixture module load failure")
    })
    try {
      const result = await run()
      expect(result.vaultSemantic).toMatchObject({
        state: "degraded",
        cause: /vault semantic module failed to load.*fixture module load failure/,
      })
      expect(vaultHits(result).sort()).toEqual(["a.md", "c.md"])
    } finally {
      vi.doUnmock("../../src/history/vault-semantic.ts")
    }
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

  // CTO 3a638efb D1: pass 2's 23 s p95 could not say which part was slow; a printed span missing or overlapping
  // another would misname the cause. No other test reads the leg's clock. CTO fa3cf2f1: the timed-out row.
  // CTO 1082ad46: D3 showed the whole ~0.94 s load after the lexical search; the reads now yield, so a load that needs
  // N event-loop turns finishes inside lexical (clipped 0, raw shown) with the same results.
  test("the spans: a load needing 3 turns overlaps the yielding lexical reads; a timed-out load shows after it (fake clock)", async () => {
    await publish()
    let t = 0
    let ftsReads = 0
    const prepare = Database.prototype.prepare
    const spy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database, sql: string) {
      if (sql.includes("nodes_fts")) {
        ftsReads++
        t += 100
      }
      if (sql.includes("SELECT vec FROM vault_doc_embed")) t += 25
      return prepare.call(this, sql)
    } as typeof prepare)
    const { recall, setRecallLogging } = await import("../../src/history/search")
    const { formatVaultSemanticSpans } = await import("../../src/lib/search")
    setRecallLogging(false)
    const search = (model: (path: string, tokens: number, record?: VaultLoadStepRecorder) => VaultQueryModel) => {
      t = 0
      ftsReads = 0
      return recall("zebracorn", {
        raw: true,
        excludeCurrentSession: true,
        vaultDb: vaultPath,
        vaultSemantic: true,
        deps: { clock: () => t, vaultQueryTimeoutMs: 50, vaultQueryModel: model },
      })
    }
    const turn = () =>
      new Promise<void>((resolve) => {
        setImmediate(resolve)
      })
    const sumOf = (s: VaultSemanticSpans) => s.moduleMs + s.lexicalMs + s.loadMs + s.embedMs + s.scanMs + s.mergeMs
    try {
      // Overlapped: the load needs 3 event-loop turns; the lexical reads yield 3 (before messages, project content,
      // vault FTS), so it finishes inside lexical.
      const ok = await search((_path, _tokens, record) => ({
        // Three recorded steps, one turn each: 100, 200 and 400 ms on the fake clock.
        load: async () => {
          for (const [name, ms] of [
            ["import", 100],
            ["getLlama", 200],
            ["loadModel", 400],
          ] as const) {
            record?.(name, "start")
            await turn()
            t += ms
            record?.(name, "end")
          }
        },
        embed: async () => {
          await Promise.resolve()
          t += 40
          return basis(0)
        },
        dispose: async () => {},
      }))
      expect(ftsReads).toBeGreaterThan(0)
      expect(ok.vaultSemantic).toMatchObject({ state: "ok", added: 1 })
      // The same results as the instant-model test above.
      expect(vaultHits(ok)).toEqual(["a.md", "b.md"])
      const lexical = 100 * ftsReads + 740
      const spans = ok.vaultSemantic?.spans
      expect(spans).toEqual({
        moduleMs: 0,
        lexicalMs: lexical,
        loadMs: 0,
        rawLoadMs: 700,
        embedMs: 0,
        scanMs: 25,
        chunksScanned: 1,
        mergeMs: 0,
        totalMs: lexical + 25,
        loadSteps: [
          { step: "import", startMs: 0, endMs: 100, startedBeforeLexicalEnd: true },
          { step: "getLlama", startMs: 100, endMs: 300, startedBeforeLexicalEnd: true },
          { step: "loadModel", startMs: 300, endMs: 700, startedBeforeLexicalEnd: true },
        ],
      })
      if (!spans) throw new Error("no spans")
      expect(sumOf(spans)).toBeLessThanOrEqual(spans.totalMs)
      expect(ok.timing?.lexicalMs).toBe(lexical)
      expect(formatVaultSemanticSpans(spans)).toBe(
        `ms: lexical ${lexical}, module 0, load 0 (raw 700), embed 0, scan 25 (1 chunks), merge 0, total ${lexical + 25}; ` +
          "load steps, ms from load start: import 0-100 (started during lexical), " +
          "getLlama 100-300 (started during lexical), loadModel 300-700 (started during lexical)",
      )

      // Timed out: load never resolves; 300 ms pass on the fake clock after the lexical search, before settle gives up
      // at its 50 ms cap, so the clipped load runs from the lexical end to the settle end.
      const slow = await search((_path, _tokens, record) => ({
        // loadModel starts after lexical and never finishes.
        load: () =>
          new Promise<void>(() => {
            setTimeout(() => {
              t += 300
              record?.("loadModel", "start")
            }, 25)
          }),
        embed: () => new Promise<Float32Array>(() => {}),
        dispose: async () => {},
      }))
      expect(slow.vaultSemantic).toMatchObject({ state: "degraded", cause: /took longer than 50 ms/ })
      const late = slow.vaultSemantic?.spans
      if (!late) throw new Error("no spans on the degraded leg")
      const slowLexical = 100 * ftsReads
      expect(late).toEqual({
        moduleMs: 0,
        lexicalMs: slowLexical,
        loadMs: 300,
        rawLoadMs: slowLexical + 300,
        embedMs: 0,
        scanMs: 0,
        chunksScanned: 0,
        mergeMs: 0,
        totalMs: slowLexical + 300,
        loadSteps: [{ step: "loadModel", startMs: slowLexical + 300, endMs: null, startedBeforeLexicalEnd: false }],
      })
      expect(sumOf(late)).toBeLessThanOrEqual(late.totalMs)
      expect(formatVaultSemanticSpans(late)).toBe(
        `ms: lexical ${slowLexical}, module 0, load 300 (raw ${slowLexical + 300}), embed 0, scan 0 (0 chunks), merge 0, total ${slowLexical + 300}; ` +
          `load steps, ms from load start: loadModel ${slowLexical + 300}-unfinished (started after lexical)`,
      )
    } finally {
      spy.mockRestore()
    }
  })

  // CTO dab0bcbf: the leg's split reads must return exactly what the one synchronous call returns, or the overlap
  // would change results; no other test compares the two.
  test("retrieveCandidatesYielding deep-equals retrieveCandidates: all three sources, and without project content", async () => {
    const { getDb } = await import("../../src/history/db")
    const { insertMessage, upsertContent, upsertSession } = await import("../../src/history/db-queries")
    const { retrieveCandidates, retrieveCandidatesYielding } = await import("../../src/history/search")
    const db = getDb()
    const now = Date.now()
    upsertSession(db, "s1", "/p", "/p/s1.jsonl", now - 5000, now - 1000, 1)
    upsertSession(db, "s2", "/p", "/p/s2.jsonl", now - 5000, now - 2000, 1)
    insertMessage(db, "u1", "s1", "user", "zebracorn in a message", null, null, now - 1000)
    insertMessage(db, "u2", "s2", "assistant", "another zebracorn reply", null, null, now - 2000)
    upsertContent(db, "doc", "d1", null, "zebracorn doc", "zebracorn project content", now - 3000)
    const messages = { limit: 20, sinceTime: now - 86_400_000, snippetTokens: 50 }
    const projectContent = { limit: 20, snippetTokens: 50, types: ["doc"] as const }
    const vault = { limit: 20, dbPath: vaultPath }
    const all = {
      db,
      query: "zebracorn",
      messages,
      projectContent: { ...projectContent, types: [...projectContent.types] },
      vault,
    }
    const sync = retrieveCandidates(all)
    expect(sync.messages.results.length).toBeGreaterThan(0)
    expect(sync.projectContent.results.length).toBeGreaterThan(0)
    expect(sync.vault?.matches.length).toBeGreaterThan(0)
    expect(await retrieveCandidatesYielding(all)).toEqual(sync)

    // The hook shape: no project content.
    const hook = { db, query: "zebracorn", messages, vault }
    expect(await retrieveCandidatesYielding(hook)).toEqual(retrieveCandidates(hook))
  })
})
