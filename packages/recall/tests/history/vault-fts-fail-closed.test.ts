/**
 * Fail-closed guards for the vault FTS adapter (recall → km vault read path).
 *
 * The recall/injection pipeline may merge matches from the km vault
 * (`.km/state.db`) into its results. These guards pin that this integration
 * can NEVER autostart km vault parsing or the km server, and never mutates
 * the user's vault. Three invariants:
 *
 *  1. READONLY PIN — `getVaultDb()` opens the km state.db strictly read-only:
 *     writes are refused and `PRAGMA query_only` reads back 1. No branch of
 *     the recall path may promote itself to a writer of the vault.
 *  2. TYPED DEGRADE — with no vault db resolvable (`KM_VAULT_DB` unset, none
 *     up the cwd walk), resolution is a pure fs probe: `getVaultDb()` returns
 *     null and `searchVault()` returns an empty typed result — no throw, no
 *     process spawn.
 *  3. IMPORT-EDGE PIN — no source file under `packages/daemon/src` or
 *     `packages/recall/src` imports km-cli server plumbing (`daemon-client`,
 *     `server-routing`) or any `@km/*` runtime package. A future violating
 *     import turns this red, naming the offending file + line.
 *
 * Audit facts pinned (verified true at pin 7fc78ea): `vault-fts.ts` opens
 * `.km/state.db` with `new Database(path, { readonly: true })` + `PRAGMA
 * query_only = ON` and does no walk-up spawn; no module in the injection path
 * invokes km, `ensureServer`, or `km daemon`.
 */

import { describe, test, expect, afterEach, vi } from "vitest"
import { Database } from "bun:sqlite"
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { getVaultDb, getVaultDbPath, searchVault, resetVaultDbCacheForTests } from "../../src/history/vault-fts.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
// packages/recall/tests/history -> repo root
const REPO_ROOT = resolve(HERE, "../../../..")
const VAULT_FTS_SRC = resolve(HERE, "../../src/history/vault-fts.ts")

// Build a minimal db shaped like km's vault (`.km/state.db`): a `nodes` table
// plus the external-content `nodes_fts` FTS5 index, exactly as km declares it
// (km/packages/km-storage/src/db/schema.ts). Default (delete) journal mode so
// the read-only open needs no sidecar -wal/-shm files.
function makeKmVaultDb(dbPath: string): void {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE nodes (
      rowid INTEGER PRIMARY KEY,
      id TEXT,
      fs_path TEXT,
      name TEXT,
      title TEXT,
      content TEXT
    );
    CREATE VIRTUAL TABLE nodes_fts USING fts5(
      id,
      name,
      title,
      content,
      content='nodes',
      content_rowid='rowid',
      prefix='2,3,4',
      tokenize='unicode61 tokenchars ''@#+~'''
    );
    CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
      INSERT INTO nodes_fts(rowid, id, name, title, content)
      VALUES (new.rowid, new.id, new.name, new.title, new.content);
    END;
  `)
  const insert = db.prepare("INSERT INTO nodes (id, fs_path, name, title, content) VALUES (?, ?, ?, ?, ?)")
  insert.run(
    "@km/tribe/12345-termless",
    "hub/@km/tribe/12345-termless.md",
    "12345-termless",
    "Termless headless terminal harness",
    "Termless drives a headless pty for silvery rendering tests.",
  )
  insert.run(
    "@km/docs/architecture",
    "docs/architecture.md",
    "architecture",
    "Architecture",
    "The recall pipeline merges vault matches into its result list.",
  )
  db.close()
}

function listTsSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listTsSources(full))
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      out.push(full)
    }
  }
  return out
}

// Strip block + line comments so bead references (`@km/tribe/20033`) that live
// only in comments cannot masquerade as import edges. Aggressive line-comment
// cutting is safe here: it can only shorten a line at a `//`, which never
// creates or destroys a real `from "spec"` specifier.
function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "")
  return noBlock
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//")
      return idx === -1 ? line : line.slice(0, idx)
    })
    .join("\n")
}

// Extract the module specifiers of every `import`/`export … from "spec"` and
// bare `import "spec"` statement in comment-stripped source.
function importSpecifiers(src: string): string[] {
  const cleaned = stripComments(src)
  const specs: string[] = []
  const fromRe = /\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g
  const bareRe = /\bimport\s*['"]([^'"]+)['"]/g
  for (const m of cleaned.matchAll(fromRe)) specs.push(m[1]!)
  for (const m of cleaned.matchAll(bareRe)) specs.push(m[1]!)
  return specs
}

function isBannedSpecifier(spec: string): boolean {
  return spec.includes("daemon-client") || spec.includes("server-routing") || spec === "@km" || spec.startsWith("@km/")
}

describe("vault-fts fail-closed guards", () => {
  afterEach(() => {
    resetVaultDbCacheForTests()
    delete process.env.KM_VAULT_DB
    vi.restoreAllMocks()
  })

  test("READONLY PIN: opens read-only, refuses writes, query_only reads 1, still returns hits", () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-vault-guard-ro-"))
    const dbPath = join(dir, "state.db")
    try {
      makeKmVaultDb(dbPath)

      process.env.KM_VAULT_DB = dbPath
      resetVaultDbCacheForTests()

      // Search over the read-only handle still returns real hits.
      const hits = searchVault("termless", 5)
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0]!.name).toBe("12345-termless")
      expect(hits[0]!.fsPath).toBe("hub/@km/tribe/12345-termless.md")

      const db = getVaultDb()
      expect(db).not.toBeNull()
      expect(getVaultDbPath()).toBe(dbPath)

      // The module explicitly ran `PRAGMA query_only = ON`.
      const pragma = db!.query("PRAGMA query_only").get() as { query_only: number }
      expect(pragma.query_only).toBe(1)

      // The read-only handle refuses writes.
      expect(() => db!.exec("INSERT INTO nodes (id, name, title, content) VALUES ('x', 'x', 'x', 'x')")).toThrow()
    } finally {
      resetVaultDbCacheForTests()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("TYPED DEGRADE: no vault db → null handle + empty typed result, no throw", () => {
    delete process.env.KM_VAULT_DB
    resetVaultDbCacheForTests()

    // A cwd with no `.km/state.db` anywhere up the 8-level walk. The redirected
    // test TMPDIR (see tests/setup/tmpdir-redirect.ts) has no vault ancestor.
    const isolated = mkdtempSync(join(tmpdir(), "tribe-vault-guard-nowalk-"))
    const deep = join(isolated, "a", "b", "c")
    mkdirSync(deep, { recursive: true })
    vi.spyOn(process, "cwd").mockReturnValue(deep)
    try {
      expect(getVaultDb()).toBeNull()
      expect(getVaultDbPath()).toBeNull()

      const result = searchVault("termless", 5)
      expect(Array.isArray(result)).toBe(true)
      expect(result).toEqual([])
    } finally {
      rmSync(isolated, { recursive: true, force: true })
    }
  })

  test("TYPED DEGRADE: vault resolution is a pure fs probe — no process-spawn primitives in vault-fts.ts", () => {
    const src = readFileSync(VAULT_FTS_SRC, "utf8")
    // `.exec(` is a sqlite call, not a process spawn — never scan for bare
    // "exec". These are the ways this module could shell out or start km.
    const spawnPrimitives = [
      "child_process",
      "Bun.spawn",
      "Bun.spawnSync",
      "execSync",
      "execFile",
      "spawnSync",
      "ensureServer",
      "km daemon",
    ]
    const found = spawnPrimitives.filter((p) => src.includes(p))
    expect(found).toEqual([])
  })

  test("IMPORT-EDGE PIN: no daemon/recall source imports km-cli server plumbing or @km/* runtime", () => {
    const roots = [resolve(REPO_ROOT, "packages/daemon/src"), resolve(REPO_ROOT, "packages/recall/src")]
    const offenders: string[] = []
    for (const root of roots) {
      for (const file of listTsSources(root)) {
        const src = readFileSync(file, "utf8")
        for (const spec of importSpecifiers(src)) {
          if (isBannedSpecifier(spec)) {
            offenders.push(`${file.slice(REPO_ROOT.length + 1)} imports "${spec}"`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
