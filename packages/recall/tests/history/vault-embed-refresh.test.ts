/**
 * @failure The vault embedding refresh could embed stale bytes, re-embed unchanged chunks, or leave a half-written document.
 * @level l1
 * @consumer @ag/recall/three-dark-search-paths (vault semantic leg, slice 2: refresh producer, CTO O2(b) 0609d989)
 * @testonly none
 *
 * Requirement (CTO 0609d989 rules 1, 3, 4 and the settled-first order): a pass embeds only chunks whose input_key has
 * no vector in the target generation; it embeds a document only when its file bytes hash to km's current
 * fs_content_hash; it writes one transaction per document and prunes that path's older rows after the commit; it
 * takes documents oldest fs_mtime first, so a spent budget leaves the newest documents uncovered and reported.
 * CTO verdict 0edff0e3 fixes 6 and 7: the budget is checked between embedding batches inside a document, so one huge
 * document cannot overrun the 600 s limit (it is abandoned unwritten and reported); a file km lists that cannot be
 * read is one uncovered document with a named reason, never a failed pass; an empty document is named, never silent.
 * CTO r2 change 4 (b7e7f718): before a document's first batch its pending chunks are compared with what the time left
 * can embed, at the rate measured so far in this pass or the pilot rate before any measurement; a document that does
 * not fit is skipped under "needs N chunks; this pass has time for M" and the pass goes on to newer documents. Gap:
 * an abandoned document stopped the pass, and oldest-first order put it first again every pass.
 * Gap: slice 1 tests cover storage and identity only; nothing exercises a refresh. Fixtures are private: an
 * in-memory km-shaped nodes table, files in a temp dir, a paragraph chunker and a hash-derived 4-dimension embedder.
 */
import { Database } from "bun:sqlite"
import { assertSingleStatement } from "@bearly/sqlite"
import { createHash } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { initSchema } from "../../src/history/db-schema"
import {
  refreshVaultEmbeddings,
  UNCOVERED_BUDGET,
  UNCOVERED_BUDGET_INSIDE,
  UNCOVERED_EMPTY,
  uncoveredTooLarge,
  uncoveredUnreadable,
  VAULT_EMBED_BATCH,
  type VaultEmbedChunker,
  type VaultEmbedder,
} from "../../src/history/vault-embed-refresh"
import {
  beginVaultEmbedGeneration,
  contractIdentity,
  decodeVaultVectorInto,
  type VaultEmbedContract,
} from "../../src/history/vault-embed-store"

const CONTRACT: VaultEmbedContract = {
  model: "fixture-embed",
  modelSha256: "b".repeat(64),
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
const GGUF = "b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63"
const VAULT = "/fixture/vault/state.db"
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

const chunker: VaultEmbedChunker = {
  chunk: async (content) =>
    content
      .split("\n\n")
      .filter((text) => text.length > 0)
      .map((text) => ({ text })),
  title: (content) => content.split("\n")[0] ?? "",
  format: async (text, title) => `doc: ${title} | ${text}`,
}

function recordingEmbedder(): VaultEmbedder & { calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = []
  return {
    calls,
    embed: async (inputs) => {
      calls.push(inputs)
      return inputs.map((input) => {
        const bytes = createHash("sha256").update(input).digest()
        return new Float32Array([bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!])
      })
    },
  }
}

/** A fixed clock: the embedder advances it msPerChunk per input, and the time left counts down from budgetMs. */
function fixedClock(budgetMs: number, msPerChunk: number) {
  let now = 0
  const base = recordingEmbedder()
  const embedder: VaultEmbedder = {
    embed: async (inputs) => {
      now += inputs.length * msPerChunk
      return base.embed(inputs)
    },
  }
  return { timeLeftMs: () => budgetMs - now, embedder }
}

describe("refreshVaultEmbeddings", () => {
  let db: Database
  let vault: Database
  let root: string
  let generation: number

  const putFile = (fsPath: string, content: string, mtime: number, hash: string | null = sha256(content)) => {
    writeFileSync(join(root, fsPath), content)
    vault.prepare("DELETE FROM nodes WHERE fs_path = ?").run(fsPath)
    vault
      .prepare("INSERT INTO nodes (id, fstype, fs_path, fs_mtime, fs_content_hash) VALUES (?, 'mdfile', ?, ?, ?)")
      .run(`n:${fsPath}`, fsPath, mtime, hash)
  }
  /** budgetCalls: the time left reads as ample until that many embed calls have run, then as spent. */
  const run = (embedder: VaultEmbedder, extra: { budgetCalls?: number; timeLeftMs?: () => number } = {}) => {
    const budget = extra.budgetCalls ?? Number.POSITIVE_INFINITY
    let calls = 0
    const counted: VaultEmbedder = {
      embed: async (inputs) => {
        calls++
        return embedder.embed(inputs)
      },
    }
    return refreshVaultEmbeddings({
      db,
      vaultDb: vault,
      vaultId: VAULT,
      vaultRoot: root,
      generation,
      contract: CONTRACT,
      chunker,
      embedder: counted,
      timeLeftMs: extra.timeLeftMs ?? (() => (calls < budget ? 1e12 : 0)),
    })
  }
  const rows = () =>
    db.prepare("SELECT fs_path, doc_hash, chunk, input_key FROM vault_doc_embed ORDER BY fs_path, chunk").all() as {
      fs_path: string
      doc_hash: string
      chunk: number
      input_key: string
    }[]

  beforeEach(() => {
    db = new Database(":memory:")
    initSchema(db)
    generation = beginVaultEmbedGeneration(db, { contract: CONTRACT, ggufSha256: GGUF, ggufStat: "m:1:1", now: 1 })
    vault = new Database(":memory:")
    vault.exec(
      "CREATE TABLE nodes (id TEXT PRIMARY KEY, fstype TEXT, fs_path TEXT, fs_mtime INTEGER, fs_content_hash TEXT)",
    )
    root = mkdtempSync(join(tmpdir(), "recall-vault-refresh-"))
  })
  afterEach(() => {
    db.close()
    vault.close()
    safeRemoveSync(root, { within: tmpdir() })
  })

  test("embeds each chunk once, keyed by input_key, and a second pass embeds nothing", async () => {
    putFile("a.md", "Alpha\n\none\n\ntwo", 10)
    const embedder = recordingEmbedder()
    const first = await run(embedder)
    expect(first).toMatchObject({ embeddedDocuments: 1, embeddedChunks: 3, reusedChunks: 0 })
    const stored = rows()
    expect(stored.map((r) => [r.fs_path, r.doc_hash, r.chunk])).toEqual([
      ["a.md", sha256("Alpha\n\none\n\ntwo"), 0],
      ["a.md", sha256("Alpha\n\none\n\ntwo"), 1],
      ["a.md", sha256("Alpha\n\none\n\ntwo"), 2],
    ])
    expect(stored[1]!.input_key).toBe(
      createHash("sha256").update(contractIdentity(CONTRACT)).update("\0").update("doc: Alpha | one").digest("hex"),
    )
    const vec = db.prepare("SELECT vec FROM vault_doc_embed WHERE chunk = 0").get() as { vec: Uint8Array }
    expect(decodeVaultVectorInto(vec.vec, new Float32Array(4))).toHaveLength(4)

    const prepare = vi.spyOn(db, "prepare")
    const second = await run(embedder)
    const generationVectorLoads = prepare.mock.calls.filter(([sql]) =>
      String(sql).includes("SELECT input_key, vec FROM vault_doc_embed"),
    ).length
    prepare.mockRestore()
    expect(second).toMatchObject({ embeddedDocuments: 0, embeddedChunks: 0, coveredDocuments: 1 })
    expect(embedder.calls).toHaveLength(1)
    expect(generationVectorLoads).toBe(0)
  })

  test("an edit re-embeds only the changed chunk and prunes the path's older rows after commit", async () => {
    putFile("a.md", "Alpha\n\none\n\ntwo", 10)
    const embedder = recordingEmbedder()
    await run(embedder)
    putFile("a.md", "Alpha\n\none\n\nTWO", 20)
    const report = await run(embedder)
    expect(report).toMatchObject({ embeddedDocuments: 1, embeddedChunks: 1, reusedChunks: 2 })
    expect(embedder.calls[1]).toEqual(["doc: Alpha | TWO"])
    expect(new Set(rows().map((r) => r.doc_hash))).toEqual(new Set([sha256("Alpha\n\none\n\nTWO")]))
  })

  test("a chunk moved from an updated document stays reusable by a later document before deferred pruning", async () => {
    putFile("a.md", "Title\n\nkeep\n\nmove", 10)
    await run(recordingEmbedder())
    const movedInputKey = createHash("sha256")
      .update(contractIdentity(CONTRACT))
      .update("\0")
      .update("doc: Title | move")
      .digest("hex")
    const oldMovedVector = db
      .prepare("SELECT vec FROM vault_doc_embed WHERE fs_path = ? AND input_key = ?")
      .get("a.md", movedInputKey) as { vec: Uint8Array }

    // a.md sorts before b.md; its completed write must not prune the old `move` row before b.md reuses it.
    putFile("a.md", "Title\n\nkeep", 20)
    putFile("b.md", "Title\n\nmove", 30)
    putFile("c.md", "C\n\nunique", 40)
    const calls: string[][] = []
    const failing: VaultEmbedder = {
      embed: async (inputs) => {
        calls.push([...inputs])
        if (inputs.some((input) => input.includes("unique"))) throw new Error("fixture failure after moved chunk")
        return recordingEmbedder().embed(inputs)
      },
    }

    await expect(run(failing)).rejects.toThrow(/c\.md.*fixture failure after moved chunk/)

    const movedRow = db
      .prepare("SELECT vec FROM vault_doc_embed WHERE fs_path = ? AND input_key = ?")
      .get("b.md", movedInputKey) as { vec: Uint8Array } | null
    expect(movedRow?.vec).toEqual(oldMovedVector.vec)
    expect(new Set(rows().filter((row) => row.fs_path === "a.md").map((row) => row.doc_hash))).toEqual(
      new Set([sha256("Title\n\nkeep")]),
    )
    expect(new Set(rows().filter((row) => row.fs_path === "b.md").map((row) => row.doc_hash))).toEqual(
      new Set([sha256("Title\n\nmove")]),
    )
    expect(rows().some((row) => row.fs_path === "c.md")).toBe(false)
    expect(calls).toEqual([["doc: C | C", "doc: C | unique"]])
  })

  test("bytes that do not hash to km's current fs_content_hash are not embedded and are reported", async () => {
    putFile("a.md", "Alpha\n\none", 10, sha256("an older version"))
    const report = await run(recordingEmbedder())
    expect(report.embeddedDocuments).toBe(0)
    expect(report.uncovered).toEqual({ "file bytes differ from km's recorded hash": 1 })
    expect(rows()).toEqual([])
  })

  test("a NULL km hash leaves the document uncovered with its named reason", async () => {
    putFile("a.md", "Alpha", 10, null)
    const report = await run(recordingEmbedder())
    expect(report.uncovered).toEqual({ "km has not recorded this file's hash": 1 })
    expect(rows()).toEqual([])
  })

  test("documents go oldest fs_mtime first; a spent budget leaves the newest uncovered and reported", async () => {
    putFile("new.md", "New\n\nn", 300)
    putFile("old.md", "Old\n\no", 100)
    putFile("mid.md", "Mid\n\nm", 200)
    const embedder = recordingEmbedder()
    const report = await run(embedder, { budgetCalls: 2 })
    expect(embedder.calls.map((call) => call[0])).toEqual(["doc: Old | Old", "doc: Mid | Mid"])
    expect(report).toMatchObject({ embeddedDocuments: 2, stoppedEarly: true })
    expect(report.uncovered).toEqual({ "refresh budget spent before this document": 1 })
    expect(new Set(rows().map((r) => r.fs_path))).toEqual(new Set(["old.md", "mid.md"]))
  })

  test("a failure on one document leaves earlier documents committed, writes none of its rows, and throws", async () => {
    putFile("a.md", "A\n\na", 10)
    putFile("b.md", "B\n\nb", 20)
    const failing: VaultEmbedder = {
      embed: async (inputs) => {
        if (inputs.some((input) => input.startsWith("doc: B"))) throw new Error("fixture embedder failed on B")
        return recordingEmbedder().embed(inputs)
      },
    }
    await expect(run(failing)).rejects.toThrow(/b\.md.*fixture embedder failed on B/)
    expect(new Set(rows().map((r) => r.fs_path))).toEqual(new Set(["a.md"]))
  })

  test("an edited document whose new embedding fails keeps its old vectors: prune runs only after the insert commits", async () => {
    putFile("a.md", "A\n\nold", 10)
    await run(recordingEmbedder())
    const before = rows()
    expect(before.map((r) => r.doc_hash)).toEqual([sha256("A\n\nold"), sha256("A\n\nold")])
    putFile("a.md", "A\n\nnew", 20)
    // The insert itself fails, so a prune placed before it would already have deleted the old rows.
    db.exec(
      assertSingleStatement(
        `CREATE TRIGGER fail_new BEFORE INSERT ON vault_doc_embed WHEN NEW.doc_hash = '${sha256("A\n\nnew")}' BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END`,
      ),
    )
    await expect(run(recordingEmbedder())).rejects.toThrow(/could not write a\.md: .*fixture insert failure/)
    expect(rows()).toEqual(before)
  })

  test("an embedder that returns the wrong number of vectors is refused loudly", async () => {
    putFile("a.md", "A\n\na", 10)
    const short: VaultEmbedder = { embed: async () => [new Float32Array(4)] }
    await expect(run(short)).rejects.toThrow(/2 inputs.*1 vector/)
    expect(rows()).toEqual([])
  })

  test("a file km lists that cannot be read is uncovered with its errno, and the pass continues", async () => {
    putFile("a.md", "A\n\na", 10)
    vault
      .prepare("INSERT INTO nodes (id, fstype, fs_path, fs_mtime, fs_content_hash) VALUES (?, 'mdfile', ?, ?, ?)")
      .run("n:gone.md", "gone.md", 5, sha256("gone"))
    putFile("b.md", "B\n\nb", 20)
    const report = await run(recordingEmbedder())
    expect(report.uncovered).toEqual({ [uncoveredUnreadable("ENOENT")]: 1 })
    expect(report.embeddedDocuments).toBe(2)
    expect(new Set(rows().map((r) => r.fs_path))).toEqual(new Set(["a.md", "b.md"]))
  })

  test("a budget spent between batches inside one document abandons it unwritten and stops the pass", async () => {
    const big = Array.from({ length: VAULT_EMBED_BATCH + 2 }, (_, i) => `p${i}`).join("\n\n")
    putFile("big.md", big, 10)
    putFile("later.md", "L\n\nl", 20)
    const embedder = recordingEmbedder()
    const report = await run(embedder, { budgetCalls: 1 })
    expect(embedder.calls.map((call) => call.length)).toEqual([VAULT_EMBED_BATCH])
    expect(report).toMatchObject({ embeddedDocuments: 0, stoppedEarly: true })
    expect(report.uncovered).toEqual({ [UNCOVERED_BUDGET_INSIDE]: 1, [UNCOVERED_BUDGET]: 1 })
    expect(rows()).toEqual([])
  })

  test("a document with no text to embed is reported by name and writes nothing", async () => {
    putFile("empty.md", "", 10)
    const report = await run(recordingEmbedder())
    expect(report.uncovered).toEqual({ [UNCOVERED_EMPTY]: 1 })
    expect(rows()).toEqual([])
  })

  const tenParagraphs = Array.from({ length: 10 }, (_, i) => `p${i}`).join("\n\n")

  test("a document too large for the time left is skipped by name and the pass goes on to newer documents", async () => {
    // Ten chunks; 10 s left at the pilot rate (250 chunks in 873.48 s) has time for 2.
    putFile("big.md", tenParagraphs, 10)
    putFile("later.md", "L\n\nl", 20)
    const embedder = recordingEmbedder()
    const report = await run(embedder, { timeLeftMs: () => 10_000 })
    expect(report.uncovered).toEqual({ [uncoveredTooLarge(10, 2)]: 1 })
    expect(report).toMatchObject({ embeddedDocuments: 1, stoppedEarly: false })
    expect(embedder.calls.flat().some((input) => input.includes("p0"))).toBe(false)
    expect(new Set(rows().map((r) => r.fs_path))).toEqual(new Set(["later.md"]))
  })

  test("once the pass has measured its own rate, the fit check uses it instead of the pilot rate", async () => {
    putFile("a.md", "A\n\na", 10)
    putFile("big.md", tenParagraphs, 20)
    // 100 ms per chunk on a fixed clock is far faster than the pilot: after a.md, 9.8 s has time for 98 chunks, though
    // the pilot rate would allow two.
    const clock = fixedClock(10_000, 100)
    const report = await run(clock.embedder, { timeLeftMs: clock.timeLeftMs })
    expect(report.uncovered).toEqual({})
    expect(report.embeddedDocuments).toBe(2)
  })

  test("a document admitted at the pilot rate on a slower host is skipped mid-way by name, and newer documents still embed (CTO r3)", async () => {
    // 10 s per chunk is slower than the pilot (about 3.5 s). With 100 s left the pilot admits big.md's 20 chunks; after
    // its first batch (80 s) the measured rate fits 2 of the 12 left, so big.md is skipped without stopping the pass,
    // and later.md's 2 chunks fit the last 20 s.
    putFile("big.md", Array.from({ length: 20 }, (_, i) => `p${i}`).join("\n\n"), 10)
    putFile("later.md", "L\n\nl", 20)
    const clock = fixedClock(100_000, 10_000)
    const report = await run(clock.embedder, { timeLeftMs: clock.timeLeftMs })
    expect(report.uncovered).toEqual({ [uncoveredTooLarge(20, VAULT_EMBED_BATCH + 2)]: 1 })
    expect(report).toMatchObject({ embeddedDocuments: 1, stoppedEarly: false })
    // Slice 5 reports these as numbers: one document too large (20 chunks); calls of 8 chunks then 2, each 10 s a chunk.
    expect(report.tooLarge).toEqual({ documents: 1, largestChunks: 20 })
    expect(report.msPerChunk).toEqual({ first: 10_000, steadyMedian: 10_000 })
    expect(new Set(rows().map((r) => r.fs_path))).toEqual(new Set(["later.md"]))
  })

  test("a time budget that is not a finite number is refused loudly", async () => {
    putFile("a.md", "A\n\na", 10)
    await expect(run(recordingEmbedder(), { timeLeftMs: () => Number.POSITIVE_INFINITY })).rejects.toThrow(
      /returned Infinity; a pass needs a finite time budget/,
    )
  })
})
