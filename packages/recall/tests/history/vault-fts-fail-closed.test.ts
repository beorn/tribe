/**
 * Fail-closed guards for the vault FTS adapter (recall → km vault read path).
 *
 * @failure Recall vault reads can mutate database content or reach km startup through unparsed module edges.
 * @level l2
 * @consumer tribe-recall vault history adapter
 *
 * The recall/injection pipeline may merge matches from the km vault
 * (`.km/state.db`) into its results. These guards pin that this integration
 * can NEVER autostart km vault parsing or the km server, and never mutates
 * vault data or sidecar topology. Three invariants:
 *
 *  1. READONLY PIN — `getVaultDb()` opens the km state.db strictly read-only:
 *     writes are refused and `PRAGMA query_only` reads back 1. The database
 *     and WAL bytes stay identical and no sidecar is created, removed, or
 *     resized. SQLite may update an existing `-shm` WAL index in any way;
 *     that coordination state is not database content.
 *  2. TYPED DEGRADE — with no vault db resolvable (`KM_VAULT_DB` unset, none
 *     up the cwd walk), resolution is a pure fs probe: `getVaultDb()` returns
 *     null and `searchVault()` returns an empty typed result — no throw, no
 *     process spawn. The reachable-graph guard proves the no-spawn half
 *     structurally: it denies spawn edges in the vault-history module graph by
 *     specifier literal (`child_process`/`node:child_process` appearing
 *     anywhere, including as a `getBuiltinModule` argument; Bun's `$` shell
 *     import under any local name), so indirection cannot hide km startup.
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
import ts from "typescript"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, dirname, extname, relative } from "node:path"
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
function seedKmVaultDb(db: Database): void {
  db.exec(`
    CREATE TABLE nodes (
      rowid INTEGER PRIMARY KEY,
      id TEXT,
      parent_id TEXT,
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
  const insert = db.prepare(
    "INSERT INTO nodes (id, parent_id, fs_path, name, title, content) VALUES (?, ?, ?, ?, ?, ?)",
  )
  insert.run(
    "@km/tribe/12345-termless",
    null,
    "hub/@km/tribe/12345-termless.md",
    "12345-termless",
    "Termless headless terminal harness",
    "Termless drives a headless pty for silvery rendering tests.",
  )
  insert.run(
    "@km/docs/architecture",
    null,
    "docs/architecture.md",
    "architecture",
    "Architecture",
    "The recall pipeline merges vault matches into its result list.",
  )
}

function makeKmVaultDb(dbPath: string): void {
  const db = new Database(dbPath)
  seedKmVaultDb(db)
  db.close()
}

function makeWalKmVaultDb(dbPath: string): Database {
  const db = new Database(dbPath)
  const row = db.query("PRAGMA journal_mode = WAL").get() as { journal_mode: string }
  if (row.journal_mode.toLowerCase() !== "wal") {
    db.close()
    throw new Error(`expected WAL journal mode, got ${row.journal_mode}`)
  }
  seedKmVaultDb(db)
  return db
}

function snapshotVaultFiles(dir: string): Record<string, { size: number; mtimeMs: number; sha256: string }> {
  return Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((name) => {
        const path = join(dir, name)
        const stat = statSync(path)
        const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex")
        return [name, { size: stat.size, mtimeMs: stat.mtimeMs, sha256 }]
      }),
  )
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

function sourceFile(src: string, fileName = "module.ts"): ts.SourceFile {
  return ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

// Parse static imports/exports, bare imports, dynamic import(), and legacy
// require() without matching comments or string contents.
function importSpecifiers(src: string, fileName = "module.ts"): string[] {
  const specs: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      specs.push(node.arguments[0]!.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile(src, fileName))
  return specs
}

function isBannedSpecifier(spec: string): boolean {
  const normalized = spec.replaceAll("\\", "/")
  return (
    normalized.includes("daemon-client") ||
    normalized.includes("server-routing") ||
    normalized === "@km" ||
    normalized.startsWith("@km/") ||
    /(^|\/)km\/packages\//.test(normalized)
  )
}

function isSpawnSpecifier(spec: string): boolean {
  return spec === "child_process" || spec === "node:child_process" || spec === "execa" || spec === "zx"
}

function spawnPrimitives(src: string, fileName: string): string[] {
  const found = new Set<string>()
  const dottedName = (node: ts.Expression): string | null => {
    if (ts.isIdentifier(node)) return node.text
    if (ts.isPropertyAccessExpression(node)) {
      const owner = dottedName(node.expression)
      return owner ? `${owner}.${node.name.text}` : null
    }
    return null
  }
  const recordExpression = (node: ts.Expression): void => {
    const name = dottedName(node)
    if (name === "Bun.spawn" || name === "Bun.spawnSync" || name === "Bun.$" || name === "Deno.Command") {
      found.add(name)
    }
    if (name === "ensureServer") found.add(name)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) recordExpression(node.expression)
    if (ts.isTaggedTemplateExpression(node)) recordExpression(node.tag)
    // isStringLiteralLike also matches a no-substitution template literal, so a
    // Bun shell tag `$`km daemon`` is caught even though its tag is unenumerated.
    if (ts.isStringLiteralLike(node) && node.text.includes("km daemon")) found.add("km daemon")
    ts.forEachChild(node, visit)
  }
  visit(sourceFile(src, fileName))
  return [...found]
}

// Specifier literals that deny by default anywhere in reachable module content —
// as an import/require()/import() target OR as a string argument (e.g. handed to
// process.getBuiltinModule(...), which the call-shape enumeration above cannot
// see). Substring match on "child_process" also covers the "node:child_process"
// builtin id. This is deny-by-default on the literal, not on the call shape, so
// indirection through getBuiltinModule / a computed require cannot hide it.
const BANNED_CONTENT_LITERALS = ["child_process"]

function bannedContentLiterals(src: string, fileName: string): string[] {
  const found = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      for (const banned of BANNED_CONTENT_LITERALS) {
        if (node.text.includes(banned)) found.add(node.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile(src, fileName))
  return [...found]
}

// `$` imported from Bun's `bun` module is the shell-exec tag; `$`km daemon``
// runs a subprocess. Detect the binding regardless of a rename (`$ as sh`),
// since reachable code holding the tag can spawn under any local name.
function importsBunShell(src: string, fileName: string): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "bun" &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const element of node.importClause.namedBindings.elements) {
        // propertyName is the imported name on a rename (`$ as sh`); otherwise
        // the local name IS the imported name.
        const imported = element.propertyName?.text ?? element.name.text
        if (imported === "$") found = true
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile(src, fileName))
  return found
}

function resolveRelativeModule(importer: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null
  const raw = resolve(dirname(importer), spec)
  const extension = extname(raw)
  const withoutJsExtension = /\.[cm]?jsx?$/.test(extension) ? raw.slice(0, -extension.length) : raw
  const candidates = extension
    ? [
        raw,
        `${withoutJsExtension}.ts`,
        `${withoutJsExtension}.tsx`,
        `${withoutJsExtension}.mts`,
        `${withoutJsExtension}.cts`,
      ]
    : [raw, `${raw}.ts`, `${raw}.tsx`, `${raw}.mts`, `${raw}.cts`, join(raw, "index.ts"), join(raw, "index.tsx")]
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
}

function displayPath(path: string, repoRoot: string): string {
  const rel = relative(repoRoot, path)
  return rel.startsWith("..") ? path : rel
}

function auditSourceImports(file: string, repoRoot: string, rejectSpawnImports = false): string[] {
  const src = readFileSync(file, "utf8")
  const shown = displayPath(file, repoRoot)
  const violations: string[] = []
  for (const spec of importSpecifiers(src, file)) {
    if (isBannedSpecifier(spec) || (rejectSpawnImports && isSpawnSpecifier(spec))) {
      violations.push(`${shown} imports "${spec}"`)
    }
    if (spec.startsWith(".")) {
      const resolved = resolveRelativeModule(file, spec)
      if (resolved && relative(repoRoot, resolved).startsWith("..")) {
        violations.push(`${shown} imports outside repo "${spec}"`)
      }
    }
  }
  return violations
}

function auditModuleGraph(entryPath: string, repoRoot: string): string[] {
  const violations: string[] = []
  const visited = new Set<string>()
  const visit = (file: string): void => {
    if (visited.has(file)) return
    visited.add(file)
    const src = readFileSync(file, "utf8")
    const shown = displayPath(file, repoRoot)
    violations.push(...auditSourceImports(file, repoRoot, true))
    for (const primitive of spawnPrimitives(src, file)) {
      violations.push(`${shown} uses "${primitive}"`)
    }
    for (const literal of bannedContentLiterals(src, file)) {
      violations.push(`${shown} references "${literal}"`)
    }
    if (importsBunShell(src, file)) {
      violations.push(`${shown} imports Bun shell $ from "bun"`)
    }
    for (const spec of importSpecifiers(src, file)) {
      const resolved = resolveRelativeModule(file, spec)
      if (resolved && !relative(repoRoot, resolved).startsWith("..")) visit(resolved)
    }
  }
  visit(entryPath)
  return violations
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

  // Regression for @i/20-search-and-memory/23189: searchVault() used to
  // require `fs_path IS NOT NULL OR title IS NOT NULL` in its WHERE clause,
  // which silently discarded every body-only node — the km knode model puts
  // most real prose there (mdsection/list-item/table-row content), not on
  // the file/folder node itself. Measured on the live vault, that filter
  // took a real 4-token query from 71 matches to 0 while `searchVault`
  // logged the false "0 matches" the caller cannot tell from a true zero.
  test("projects body-only matches to their file source and dedupes sibling hits", () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-vault-guard-body-"))
    const dbPath = join(dir, "state.db")
    try {
      const db = new Database(dbPath)
      seedKmVaultDb(db)
      const insert = db.prepare(
        "INSERT INTO nodes (id, parent_id, fs_path, name, title, content) VALUES (?, ?, ?, ?, ?, ?)",
      )
      insert.run(
        "01VAULTNEEDLEBODYONLYROW0",
        "@km/tribe/12345-termless",
        null,
        null,
        null,
        "vaultneedle appears only in this nested body row",
      )
      insert.run(
        "01VAULTNEEDLEBODYONLYROW1",
        "@km/tribe/12345-termless",
        null,
        null,
        null,
        "a sibling repeats vaultneedle in the same source file",
      )
      db.close()

      process.env.KM_VAULT_DB = dbPath
      resetVaultDbCacheForTests()

      const hits = searchVault("vaultneedle", 5)
      expect(hits).toHaveLength(1)
      expect(hits[0]?.id).toMatch(/^01VAULTNEEDLEBODYONLYROW[01]$/)
      expect(hits[0]?.fsPath).toBe("hub/@km/tribe/12345-termless.md")
      expect(hits[0]?.title).toBe("Termless headless terminal harness")
      expect(hits[0]?.snippet).toContain("vaultneedle")
    } finally {
      resetVaultDbCacheForTests()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("FAIL LOUD: an explicitly configured vault with an invalid schema names repair commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-vault-guard-invalid-"))
    const dbPath = join(dir, "state.db")
    try {
      const db = new Database(dbPath)
      db.exec("CREATE TABLE unrelated (id TEXT)")
      db.close()

      process.env.KM_VAULT_DB = dbPath
      resetVaultDbCacheForTests()

      expect(() => searchVault("termless", 5)).toThrowError(/KM_VAULT_DB=.*Run 'km sync'.*unset KM_VAULT_DB/)
    } finally {
      resetVaultDbCacheForTests()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("FAIL LOUD: a missing explicit KM_VAULT_DB does not fall through to discovery", () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-vault-guard-missing-"))
    const dbPath = join(dir, "missing.db")
    try {
      process.env.KM_VAULT_DB = dbPath
      resetVaultDbCacheForTests()

      expect(() => getVaultDb()).toThrowError(/KM_VAULT_DB=.*does not exist.*Run 'km sync'.*unset KM_VAULT_DB/)
    } finally {
      resetVaultDbCacheForTests()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("READONLY PIN: live WAL data and sidecar topology are unchanged after recall reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-vault-guard-wal-"))
    const dbPath = join(dir, "state.db")
    let writer: Database | null = null
    try {
      writer = makeWalKmVaultDb(dbPath)
      const before = snapshotVaultFiles(dir)
      expect(Object.keys(before)).toEqual(expect.arrayContaining(["state.db", "state.db-wal", "state.db-shm"]))

      process.env.KM_VAULT_DB = dbPath
      resetVaultDbCacheForTests()
      expect(searchVault("termless", 5)).toHaveLength(1)
      resetVaultDbCacheForTests()

      const after = snapshotVaultFiles(dir)
      expect(Object.keys(after)).toEqual(Object.keys(before))
      expect(after["state.db"]).toEqual(before["state.db"])
      expect(after["state.db-wal"]).toEqual(before["state.db-wal"])
    } finally {
      resetVaultDbCacheForTests()
      writer?.close()
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

  test("TYPED DEGRADE: the reachable vault-history graph cannot start km", () => {
    expect(auditModuleGraph(VAULT_FTS_SRC, REPO_ROOT)).toEqual([])
  })

  test("IMPORT-EDGE PIN: scanner recognizes dynamic imports", () => {
    expect(importSpecifiers('async function load() { return import("@km/commands") }')).toContain("@km/commands")
  })

  test("IMPORT-EDGE PIN: reachable helpers cannot hide process startup", () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-vault-guard-graph-"))
    try {
      const entryPath = join(dir, "entry.ts")
      writeFileSync(entryPath, 'import { start } from "./helper.ts"\nexport const run = start\n')
      writeFileSync(join(dir, "helper.ts"), 'export const start = () => Bun.spawn(["km", "daemon"])\n')
      expect(auditModuleGraph(entryPath, dir)).toContain('helper.ts uses "Bun.spawn"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Reviewer BLOCK (@agent/9, msg f89ebcea): the scanner returned [] for two
  // vectors that reach km startup through no import/call the enumeration knew.
  test('IMPORT-EDGE PIN: reachable helper cannot start km via Bun $ shell (import { $ } from "bun")', () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-vault-guard-bunsh-"))
    try {
      const entryPath = join(dir, "entry.ts")
      writeFileSync(entryPath, 'import { start } from "./helper.ts"\nexport const run = start\n')
      writeFileSync(join(dir, "helper.ts"), 'import { $ } from "bun"\nexport const start = () => $`km daemon`\n')
      expect(auditModuleGraph(entryPath, dir)).toContain('helper.ts imports Bun shell $ from "bun"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("IMPORT-EDGE PIN: reachable helper cannot start km via renamed Bun $ shell (import { $ as sh })", () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-vault-guard-bunsh-rename-"))
    try {
      const entryPath = join(dir, "entry.ts")
      writeFileSync(entryPath, 'import { start } from "./helper.ts"\nexport const run = start\n')
      writeFileSync(join(dir, "helper.ts"), 'import { $ as sh } from "bun"\nexport const start = () => sh`km daemon`\n')
      expect(auditModuleGraph(entryPath, dir)).toContain('helper.ts imports Bun shell $ from "bun"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('IMPORT-EDGE PIN: reachable helper cannot start km via process.getBuiltinModule("node:child_process")', () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-vault-guard-getbuiltin-"))
    try {
      const entryPath = join(dir, "entry.ts")
      writeFileSync(entryPath, 'import { start } from "./helper.ts"\nexport const run = start\n')
      writeFileSync(
        join(dir, "helper.ts"),
        'export const start = () => process.getBuiltinModule("node:child_process").spawn("km", ["daemon"])\n',
      )
      expect(auditModuleGraph(entryPath, dir)).toContain('helper.ts references "node:child_process"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("IMPORT-EDGE PIN: no daemon/recall source imports km-cli server plumbing or @km/* runtime", () => {
    const roots = [resolve(REPO_ROOT, "packages/daemon/src"), resolve(REPO_ROOT, "packages/recall/src")]
    const offenders: string[] = []
    for (const root of roots) {
      for (const file of listTsSources(root)) {
        offenders.push(...auditSourceImports(file, REPO_ROOT))
      }
    }
    expect(offenders).toEqual([])
  })
})
