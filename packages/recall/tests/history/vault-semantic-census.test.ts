/**
 * @failure recall status could report vault semantic coverage that hides stale, missing or unqueryable vectors.
 * @level l1
 * @consumer @ag/recall/three-dark-search-paths (AC1: vault semantic U/A/X/I in recall status)
 * @testonly none
 *
 * Requirement (AC1, the issue's census contract): U = A + X, where U is the bound vault's markdown documents, A those
 * with a vector for km's current hash in the published generation, and X every other document with exactly one
 * reason; I is A only when the generation matches the running contract and model file, otherwise 0 with the cause.
 * CTO r2 change 5 (b7e7f718): the text path of recall status reads the census as the JSON path does, so a census
 * failure prints its cause instead of ending the command with FATAL after partial output, and the check mark means
 * no cause (a 0/0 vault that is not queryable shows a warning).
 * Gap: recall status reports no vault semantic census at all, and the query leg reports only documents/embedded.
 */
import { Database } from "bun:sqlite"
import { assertSingleStatement } from "@bearly/sqlite"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { initSchema } from "../../src/history/db-schema"
import { modelFileStat, recallEmbedContract } from "../../src/history/vault-embed-model"
import {
  beginVaultEmbedGeneration,
  encodeVaultVector,
  publishVaultEmbedGeneration,
} from "../../src/history/vault-embed-store"
import {
  CENSUS_NO_GENERATION,
  CENSUS_NO_HASH,
  CENSUS_NOT_EMBEDDED,
  CENSUS_STALE,
  vaultSemanticCensus,
} from "../../src/history/vault-semantic"
import { CHECK, WARN } from "../../src/lib/format"
import { readVaultSemanticCensus, vaultSemanticCensusLines } from "../../src/lib/vault-semantic-status"

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

describe("vaultSemanticCensus", () => {
  let root: string
  let vaultPath: string
  let modelPath: string
  let db: Database

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "recall-vault-census-")))
    mkdirSync(join(root, ".km"))
    vaultPath = join(root, ".km", "state.db")
    const vault = new Database(vaultPath)
    vault.exec(
      assertSingleStatement(
        "CREATE TABLE nodes (id TEXT PRIMARY KEY, fstype TEXT, fs_path TEXT, fs_content_hash TEXT, title TEXT)",
      ),
    )
    const insert = vault.prepare("INSERT INTO nodes VALUES (?, 'mdfile', ?, ?, NULL)")
    insert.run("a", "current.md", sha256("current"))
    insert.run("b", "stale.md", sha256("edited"))
    insert.run("c", "new.md", sha256("new"))
    insert.run("d", "unhashed.md", null)
    vault.close()
    modelPath = join(root, "model.gguf")
    writeFileSync(modelPath, "fixture model")
    db = new Database(":memory:")
    initSchema(db)
  })
  afterEach(() => {
    db.close()
    safeRemoveSync(root, { within: tmpdir() })
  })

  const publish = () => {
    const id = beginVaultEmbedGeneration(db, {
      contract: recallEmbedContract(),
      ggufSha256: "c".repeat(64),
      ggufStat: modelFileStat(modelPath),
      now: 1,
    })
    publishVaultEmbedGeneration(db, id)
    const insert = db.prepare(
      "INSERT INTO vault_doc_embed (generation, vault_id, fs_path, doc_hash, chunk, input_key, vec) VALUES (?, ?, ?, ?, 0, 'k', ?)",
    )
    const vec = encodeVaultVector(new Float32Array(768), 768)
    insert.run(id, vaultPath, "current.md", sha256("current"), vec)
    insert.run(id, vaultPath, "stale.md", sha256("original"), vec)
  }

  test("every document is accepted or excluded with one reason, and a matching generation makes A queryable", () => {
    publish()
    const census = vaultSemanticCensus(db, vaultPath, { RECALL_EMBED_MODEL: modelPath })
    expect(census).toEqual({
      units: 4,
      accepted: 1,
      excluded: { [CENSUS_STALE]: 1, [CENSUS_NOT_EMBEDDED]: 1, [CENSUS_NO_HASH]: 1 },
      queryable: 1,
      generation: 1,
    })
  })

  test("no published generation: nothing accepted or queryable, and the cause is named", () => {
    const census = vaultSemanticCensus(db, vaultPath, { RECALL_EMBED_MODEL: modelPath })
    expect(census).toEqual({
      units: 4,
      accepted: 0,
      excluded: { [CENSUS_NO_GENERATION]: 3, [CENSUS_NO_HASH]: 1 },
      queryable: 0,
      generation: null,
      cause: CENSUS_NO_GENERATION,
    })
  })

  test("a missing model leaves A counted but I at 0, naming the remedy", () => {
    publish()
    const census = vaultSemanticCensus(db, vaultPath, {})
    expect(census).toMatchObject({
      accepted: 1,
      queryable: 0,
      cause: expect.stringMatching(/RECALL_EMBED_MODEL is not set/),
    })
  })

  test("recall status prints a census failure as its cause instead of throwing", async () => {
    const bare = new Database(":memory:")
    try {
      const reading = await readVaultSemanticCensus(bare, vaultPath)
      expect(reading).toEqual({ error: expect.stringMatching(/no such table/) })
      expect(vaultSemanticCensusLines(reading)[1]).toMatch(/census failed: .*no such table/)
    } finally {
      bare.close()
    }
  })

  test("the check mark means no cause: a vault with no queryable documents shows a warning", () => {
    const empty = { units: 0, accepted: 0, excluded: {}, queryable: 0, generation: null, cause: CENSUS_NO_GENERATION }
    expect(vaultSemanticCensusLines(empty)[1]).toContain(WARN)
    expect(vaultSemanticCensusLines({ ...empty, cause: undefined, generation: 1 })[1]).toContain(CHECK)
  })
})
