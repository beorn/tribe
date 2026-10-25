import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

import { slugFromText } from "../src/qmd-export.ts"

/**
 * Bun ships its own `node -> bun` compatibility shim in a temp directory
 * (`/tmp/bun-node-*`) and prepends it to PATH for every process it spawns —
 * including this test's own runner (`bunx --bun vitest`). A plain
 * `spawnSync("node", ...)` resolves to that shim, not a real Node.js
 * runtime, and Bun's argv handling for `-e --input-type=module <arg>`
 * leaves `process.argv[1]` undefined where real Node populates it — hence
 * "Cannot find package 'undefined'". This probe's entire point is proving a
 * REAL Node runtime can load qmd's native SQLite binding, so it must resolve
 * past Bun's self-shim rather than trust PATH order
 * (@km/tribe/ci-green-round3).
 */
function realNodeBinary(): string {
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, "node")
    if (!existsSync(candidate)) continue
    let resolved: string
    try {
      resolved = realpathSync(candidate)
    } catch {
      continue
    }
    if (basename(resolved) === "bun") continue
    return candidate
  }
  throw new Error("no real (non-Bun) node binary found on PATH — qmd's native SQLite binding needs one to load under")
}

// slugFromText becomes a filesystem filename. It must never produce path
// separators, dots, or anything that would break out of the target directory.

describe("slugFromText", () => {
  test("returns 'session' for empty input", () => {
    expect(slugFromText("")).toBe("session")
  })

  test("lowercases input", () => {
    expect(slugFromText("HELLO World")).toBe("hello-world")
  })

  test("replaces special chars with spaces then dashes", () => {
    expect(slugFromText("hello, world!")).toBe("hello-world")
  })

  test("never contains path separators", () => {
    expect(slugFromText("../../../etc/passwd")).not.toContain("/")
    expect(slugFromText("foo/bar/baz")).not.toContain("/")
    expect(slugFromText("foo\\bar\\baz")).not.toContain("\\")
  })

  test("truncates long input", () => {
    const long = "word ".repeat(100)
    expect(slugFromText(long).length).toBeLessThanOrEqual(50)
  })

  test("handles first 8 words max", () => {
    expect(slugFromText("one two three four five six seven eight nine ten")).toBe(
      "one-two-three-four-five-six-seven-eight",
    )
  })
})

describe("qmd export boundary", () => {
  test("ships qmd with a Node-loadable native SQLite module", () => {
    // Write before each blocking child so a stalled CI run retains its last reached stage.
    const observe = (stage: string, details: Record<string, unknown>) => {
      writeSync(2, `${JSON.stringify({ test: "qmd packaging", stage, at: new Date().toISOString(), ...details })}\n`)
    }
    observe("dependencies", { phase: "start" })
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies?.["@tobilu/qmd"]).toBe("2.8.3")

    const qmdRoot = realpathSync(fileURLToPath(new URL("../node_modules/@tobilu/qmd/", import.meta.url)))
    const qmdNodeModules = dirname(dirname(qmdRoot))
    const betterSqliteRoot = realpathSync(join(qmdNodeModules, "better-sqlite3"))
    const betterSqliteEntry = join(betterSqliteRoot, "lib", "index.js")
    const nodeBinary = realNodeBinary()
    observe("dependencies", {
      phase: "end",
      declaredQmdVersion: manifest.dependencies?.["@tobilu/qmd"],
      qmdRoot,
      betterSqliteEntry,
      nodeBinary,
      nodeRealPath: realpathSync(nodeBinary),
    })

    const nativeStarted = performance.now()
    observe("native-sqlite", { phase: "start" })
    const nativeProbe = spawnSync(
      nodeBinary,
      [
        "--input-type=module",
        "-e",
        'const { default: Database } = await import(process.argv[1]); const db = new Database(":memory:"); const row = db.prepare("select 1 as value").get(); db.close(); process.stdout.write(String(row.value));',
        betterSqliteEntry,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )
    observe("native-sqlite", {
      phase: "end",
      elapsedMs: performance.now() - nativeStarted,
      status: nativeProbe.status,
      signal: nativeProbe.signal,
      error: nativeProbe.error?.message,
      stdout: nativeProbe.stdout,
      stderr: nativeProbe.stderr,
    })
    expect(nativeProbe.status, nativeProbe.stderr).toBe(0)
    expect(nativeProbe.stdout).toBe("1")

    const versionStarted = performance.now()
    observe("qmd-version", { phase: "start" })
    const versionProbe = spawnSync(join(qmdRoot, "bin", "qmd"), ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    observe("qmd-version", {
      phase: "end",
      elapsedMs: performance.now() - versionStarted,
      status: versionProbe.status,
      signal: versionProbe.signal,
      error: versionProbe.error?.message,
      stdout: versionProbe.stdout,
      stderr: versionProbe.stderr,
    })
    expect(versionProbe.status, versionProbe.stderr).toBe(0)
    expect(versionProbe.stdout.trim()).toMatch(/^qmd 2\.8\.3(?:\s|$)/)
  })
})

// @failure Interrupted QMD indexing repeats valid chunks or treats orphan metadata as complete.
// @level l2 @consumer Recall's pinned offline QMD update/embed boundary
// The real store/chunker/session and SQLite extension own progress. Only the external
// tokenizer/inference is deterministic; actual native32/56/interruption proof is separate.
describe("qmd embedding persistence contract", () => {
  test("retains valid progress and repairs incomplete pairs across SDK resumes", () => {
    const root = mkdtempSync(join(tmpdir(), "recall-qmd-store-"))
    const qmdRoot = realpathSync(fileURLToPath(new URL("../node_modules/@tobilu/qmd/", import.meta.url)))
    mkdirSync(join(root, "source"))
    writeFileSync(join(root, "source", "fixture.md"), "# Fixture\n" + "x".repeat(2500))
    try {
      const program = String.raw`
        import { readFileSync, writeFileSync } from 'node:fs';
        import { pathToFileURL } from 'node:url';
        const packageRoot = process.env.QMD_TEST_PACKAGE;
        const root = process.env.QMD_TEST_ROOT;
        const { createStore } = await import(pathToFileURL(packageRoot + '/dist/index.js').href);
        const { chunkDocumentByTokens, generateEmbeddings, getEmbeddingFingerprint, DEFAULT_EMBED_MODEL } = await import(pathToFileURL(packageRoot + '/dist/store.js').href);
        const { setDefaultLlamaCpp } = await import(pathToFileURL(packageRoot + '/dist/llm.js').href);
        const calls = [];
        let delayBatch = false;
        const model = {
          embedModelName: DEFAULT_EMBED_MODEL,
          tokenize: async text => Array.from(text),
          detokenize: async tokens => tokens.join(''),
          embed: async text => { calls.push(text); return { embedding: [1, 0, 0, 0] }; },
          embedBatch: async texts => { if (delayBatch) await new Promise(resolve => setTimeout(resolve, 30)); return Promise.all(texts.map(text => model.embed(text))); },
          dispose: async () => {},
        };
        setDefaultLlamaCpp(model);
        const store = await createStore({ dbPath: root + '/index.sqlite', config: { collections: { contract: { path: root + '/source', pattern: '**/*.md' } } } });
        store.internal.llm = model;
        try {
          if (process.env.QMD_TEST_PHASE === 'hard-kill') {
            writeFileSync(root + '/source/fixture.md', '# Hard stop\n' + 'z'.repeat(30000));
            await store.update({ collections: ['contract'] });
            const hash = store.internal.db.prepare("SELECT hash FROM documents WHERE collection='contract' AND active=1").get().hash;
            const chunks = await chunkDocumentByTokens(readFileSync(root + '/source/fixture.md', 'utf8'), undefined, undefined, undefined, 'fixture.md');
            if (chunks.length <= 32) throw Error('hard-stop fixture must span more than one batch');
            await store.embed({ collection: 'contract', onProgress(info) {
              if (info.chunksEmbedded < 32) return;
              const before = store.internal.db.prepare('SELECT seq,pos,total_chunks,embedded_at FROM content_vectors WHERE hash=? ORDER BY seq').all(hash);
              writeFileSync(root + '/hard-stop.json', JSON.stringify({ hash, expected: chunks.length, before }));
              process.kill(process.pid, 'SIGKILL');
            } });
            throw Error('hard-stop fixture did not reach its committed first batch');
          }
          if (process.env.QMD_TEST_PHASE === 'hard-recover') {
            const { hash, expected, before } = JSON.parse(readFileSync(root + '/hard-stop.json', 'utf8'));
            const pairedBefore = store.internal.db.prepare("SELECT count(*) AS n FROM content_vectors cv JOIN vectors_vec v ON v.hash_seq=cv.hash||'_'||cv.seq WHERE cv.hash=?").get(hash).n;
            const recovered = await store.embed({ collection: 'contract' });
            const after = store.internal.db.prepare('SELECT seq,pos,total_chunks,embedded_at FROM content_vectors WHERE hash=? ORDER BY seq').all(hash);
            const pairedAfter = store.internal.db.prepare("SELECT count(*) AS n FROM content_vectors cv JOIN vectors_vec v ON v.hash_seq=cv.hash||'_'||cv.seq WHERE cv.hash=?").get(hash).n;
            const oldRowsPreserved = before.every(row => JSON.stringify(after.find(next => next.seq === row.seq)) === JSON.stringify(row));
            console.log(JSON.stringify({ before: before.length, expected, generated: recovered.chunksEmbedded, after: after.length, pairedBefore, pairedAfter, oldRowsPreserved }));
          } else {
          if (typeof store.internal.db.prepare !== 'function') throw Error('pinned QMD InternalStore.db shape changed');
          await store.update({ collections: ['contract'] });
          const body = readFileSync(root + '/source/fixture.md', 'utf8');
          const chunks = await chunkDocumentByTokens(body, undefined, undefined, undefined, 'fixture.md');
          const hash = store.internal.db.prepare("SELECT hash FROM documents WHERE collection='contract' AND active=1").get().hash;
          const fingerprint = getEmbeddingFingerprint(DEFAULT_EMBED_MODEL);
          const originalTime = '2000-01-01T00:00:00.000Z';
          store.internal.ensureVecTable(4);
          store.internal.insertEmbedding(hash, 0, 0, new Float32Array([1, 0, 0, 0]), DEFAULT_EMBED_MODEL, originalTime, 4, fingerprint);
          const first = await store.embed({ collection: 'contract' });
          const retainedTime = store.internal.db.prepare('SELECT embedded_at FROM content_vectors WHERE hash=? AND seq=0').get(hash).embedded_at;
          calls.length = 0;
          const noop = await store.embed({ collection: 'contract' });
          const noopCalls = calls.length;
          let badInsertThrew = false;
          try { store.internal.insertEmbedding(hash, 0, 0, new Float32Array([1, 0, 0]), DEFAULT_EMBED_MODEL, '2099-01-01T00:00:00.000Z', 4, fingerprint); }
          catch { badInsertThrew = true; }
          const afterBadInsertTime = store.internal.db.prepare('SELECT embedded_at FROM content_vectors WHERE hash=? AND seq=0').get(hash).embedded_at;
          store.internal.db.prepare('DELETE FROM vectors_vec WHERE hash_seq=?').run(hash + '_2');
          const orphanPending = store.internal.getHashesNeedingEmbedding(DEFAULT_EMBED_MODEL);
          const repaired = await store.embed({ collection: 'contract' });
          const paired = store.internal.db.prepare("SELECT count(*) AS n FROM content_vectors cv JOIN vectors_vec v ON v.hash_seq=cv.hash||'_'||cv.seq WHERE cv.hash=?").get(hash).n;
          const mismatchGenerated = [];
          for (const mutation of ['seq=-1', 'pos=9999', 'total_chunks=99']) {
            store.internal.db.prepare('DELETE FROM vectors_vec WHERE hash_seq=?').run(hash + '_3');
            store.internal.db.prepare('DELETE FROM content_vectors WHERE hash=? AND seq=3').run(hash);
            store.internal.db.prepare('UPDATE content_vectors SET ' + mutation + ' WHERE hash=? AND seq=0').run(hash);
            mismatchGenerated.push((await store.embed({ collection: 'contract' })).chunksEmbedded);
          }
          store.internal.db.prepare("UPDATE content_vectors SET embed_fingerprint='stale' WHERE hash=?").run(hash);
          const fingerprintGenerated = (await store.embed({ collection: 'contract' })).chunksEmbedded;
          const modelGenerated = (await store.embed({ collection: 'contract', model: 'contract-other-model' })).chunksEmbedded;
          writeFileSync(root + '/source/fixture.md', '# Graceful\n' + 'y'.repeat(30000));
          await store.update({ collections: ['contract'] });
          const gracefulHash = store.internal.db.prepare("SELECT hash FROM documents WHERE collection='contract' AND active=1").get().hash;
          const gracefulChunks = await chunkDocumentByTokens(readFileSync(root + '/source/fixture.md', 'utf8'), undefined, undefined, undefined, 'fixture.md');
          delayBatch = true;
          await generateEmbeddings(store.internal, { collection: 'contract', maxDurationMs: 10 });
          const gracefulPersisted = store.internal.db.prepare('SELECT count(*) AS n FROM content_vectors WHERE hash=?').get(gracefulHash).n;
          delayBatch = false;
          const gracefulResumed = await store.embed({ collection: 'contract' });
          const gracefulPairedAfter = store.internal.db.prepare("SELECT count(*) AS n FROM content_vectors cv JOIN vectors_vec v ON v.hash_seq=cv.hash||'_'||cv.seq WHERE cv.hash=?").get(gracefulHash).n;
          console.log(JSON.stringify({ fixtureChunks: chunks.length, generated: first.chunksEmbedded, retainedTime, noopGenerated: noop.chunksEmbedded, noopCalls, badInsertThrew, afterBadInsertTime, orphanPending, repairedGenerated: repaired.chunksEmbedded, paired, mismatchGenerated, fingerprintGenerated, modelGenerated, gracefulExpected: gracefulChunks.length, gracefulPersisted, gracefulResumed: gracefulResumed.chunksEmbedded, gracefulPairedAfter }));
          }
        } finally { await store.close(); setDefaultLlamaCpp(null); }
      `
      const run = (phase: string) =>
        spawnSync("bun", ["--eval", program], {
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, QMD_TEST_ROOT: root, QMD_TEST_PACKAGE: qmdRoot, QMD_TEST_PHASE: phase },
        })
      const probe = run("contract")
      expect(probe.status, probe.stderr).toBe(0)
      const result = JSON.parse(probe.stdout.trim()) as {
        fixtureChunks: number
        generated: number
        retainedTime: string
        noopGenerated: number
        noopCalls: number
        badInsertThrew: boolean
        afterBadInsertTime: string
        orphanPending: number
        repairedGenerated: number
        paired: number
        mismatchGenerated: number[]
        fingerprintGenerated: number
        modelGenerated: number
        gracefulExpected: number
        gracefulPersisted: number
        gracefulResumed: number
        gracefulPairedAfter: number
      }
      expect(result.fixtureChunks).toBe(4)
      expect.soft(result.generated).toBe(3)
      expect.soft(result.retainedTime).toBe("2000-01-01T00:00:00.000Z")
      expect.soft(result.noopGenerated).toBe(0)
      expect.soft(result.noopCalls).toBe(0)
      expect.soft(result.badInsertThrew).toBe(true)
      expect.soft(result.afterBadInsertTime).toBe("2000-01-01T00:00:00.000Z")
      expect.soft(result.orphanPending).toBe(1)
      expect.soft(result.repairedGenerated).toBe(1)
      expect.soft(result.paired).toBe(4)
      expect.soft(result.mismatchGenerated).toEqual([4, 4, 4])
      expect.soft(result.fingerprintGenerated).toBe(4)
      expect.soft(result.modelGenerated).toBe(4)
      expect(result.gracefulExpected).toBeGreaterThan(32)
      expect.soft(result.gracefulPersisted).toBe(32)
      // The next call shares the process/model, so it also checks expiry releases its session.
      expect.soft(result.gracefulResumed).toBe(result.gracefulExpected - 32)
      expect.soft(result.gracefulPairedAfter).toBe(result.gracefulExpected)
      const killed = run("hard-kill")
      expect(killed.signal, killed.stderr).toBe("SIGKILL")
      const recovery = run("hard-recover")
      expect(recovery.status, recovery.stderr).toBe(0)
      const resumed = JSON.parse(recovery.stdout.trim()) as {
        before: number
        expected: number
        generated: number
        after: number
        pairedBefore: number
        pairedAfter: number
        oldRowsPreserved: boolean
      }
      expect(resumed.before).toBe(32)
      expect(resumed.pairedBefore).toBe(32)
      expect(resumed.generated).toBe(resumed.expected - 32)
      expect(resumed.after).toBe(resumed.expected)
      expect(resumed.pairedAfter).toBe(resumed.expected)
      expect(resumed.oldRowsPreserved).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
