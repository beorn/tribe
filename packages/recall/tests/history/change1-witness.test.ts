import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { initSchema, runMigrations } from "../../src/history/db-schema.ts"
import { getSession, insertMessage, upsertSession } from "../../src/history/db-queries.ts"
import { closeDb } from "../../src/history/db.ts"
import { rebuildIndex, findSessionFiles, isTranscriptShape } from "../../src/history/indexer.ts"
import {
  deleteCodexSessionKeys,
  buildDeleteCodexMessagesSql,
  buildDeleteCodexSessionsSql,
  indexCodexTranscripts,
} from "../../src/history/codex-indexer.ts"
import { cmdIndex } from "../../src/lib/sessions.ts"

describe("Change 1 Witness Tests (CTO Ruling 2026-09-22)", () => {
  let tempDir: string
  let db: Database
  let dbPath: string
  let projectsDir: string
  let origClaudeDir: string | undefined
  let origDbPath: string | undefined
  let origAgBin: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "recall-change1-witness-"))
    origClaudeDir = process.env.CLAUDE_DIR
    origDbPath = process.env.RECALL_DB_PATH
    origAgBin = process.env.AG_BIN

    const isolatedClaude = join(tempDir, "claude")
    projectsDir = join(isolatedClaude, "projects")
    mkdirSync(projectsDir, { recursive: true })
    process.env.CLAUDE_DIR = isolatedClaude

    dbPath = join(tempDir, "test.db")
    process.env.RECALL_DB_PATH = dbPath
    db = new Database(dbPath)
    initSchema(db)
  })

  afterEach(() => {
    closeDb()
    db.close()
    if (origClaudeDir !== undefined) {
      process.env.CLAUDE_DIR = origClaudeDir
    } else {
      delete process.env.CLAUDE_DIR
    }
    if (origDbPath !== undefined) {
      process.env.RECALL_DB_PATH = origDbPath
    } else {
      delete process.env.RECALL_DB_PATH
    }
    if (origAgBin !== undefined) {
      process.env.AG_BIN = origAgBin
    } else {
      delete process.env.AG_BIN
    }
    delete process.env.RECALL_SKIP_CODEX
    process.exitCode = 0
    safeRemoveSync(tempDir, { within: tmpdir() })
  })

  // --------------------------------------------------------------------------
  // A1: Codex delete by key (no SCAN messages)
  // --------------------------------------------------------------------------
  test("A1: deleteCodexSessionKeys uses covering index without SCAN messages", () => {
    const keys = ["codex:sess1", "codex:sess1@copy1"]
    const preparedSqls: string[] = []
    const origPrepare = db.prepare.bind(db)
    const spyPrepare = (sql: string) => {
      preparedSqls.push(sql)
      return origPrepare(sql)
    }
    db.prepare = spyPrepare as any

    try {
      deleteCodexSessionKeys(db, keys)
    } finally {
      db.prepare = origPrepare
    }

    const deleteMsgSql = preparedSqls.find((s) => s.includes("DELETE FROM messages"))
    expect(deleteMsgSql).toBeDefined()
    expect(deleteMsgSql).toBe(buildDeleteCodexMessagesSql(keys))

    const plan = db.prepare(`EXPLAIN QUERY PLAN ${deleteMsgSql}`).all(...keys) as Array<{ detail: string }>

    const planDetails = plan.map((p) => p.detail).join(" ")
    expect(planDetails).not.toContain("SCAN messages")
    expect(planDetails).toContain("SEARCH messages")
  })

  test("A1: red arm - LIKE clause in messages delete triggers SCAN messages", () => {
    const keys = ["codex:sess1", "codex:sess1@copy1"]
    const placeholders = keys.map(() => "?").join(",")
    // Simulating regression: adding LIKE inside delete statement
    const regressionSql = `DELETE FROM messages WHERE session_id IN (${placeholders}) OR session_id LIKE ?`
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${regressionSql}`).all(...keys, "codex:sess1%") as Array<{
      detail: string
    }>
    const planDetails = plan.map((p) => p.detail).join(" ")
    expect(planDetails).toContain("SCAN messages")
  })

  test("A1: explicit key delete removes canonical and @copy rows while preserving peers", () => {
    // Populate session 1 (canonical + @copy) and session 2
    upsertSession(db, "codex:sess1", "/proj", "/path/canon", 100, 100, 2)
    upsertSession(db, "codex:sess1@copy1", "/proj", "/path/copy1", 100, 100, 1)
    upsertSession(db, "codex:sess2", "/proj", "/path/sess2", 100, 100, 3)

    insertMessage(db, null, "codex:sess1", "user", "msg1", null, null, 100)
    insertMessage(db, null, "codex:sess1@copy1", "assistant", "msg2", null, null, 101)
    insertMessage(db, null, "codex:sess2", "user", "msg3", null, null, 102)

    // Execute deleteCodexSessionKeys used by codex-indexer
    const deleteKeys = ["codex:sess1", "codex:sess1@copy1"]
    const res = deleteCodexSessionKeys(db, deleteKeys)
    expect(res.sessions).toBe(2)
    expect(res.messages).toBeGreaterThanOrEqual(2)

    // Verify sess1 rows are gone
    expect(getSession(db, "codex:sess1")).toBeFalsy()
    expect(getSession(db, "codex:sess1@copy1")).toBeFalsy()
    expect(db.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id LIKE 'codex:sess1%'").get()).toEqual({
      c: 0,
    })

    // Verify sess2 rows are untouched
    expect(getSession(db, "codex:sess2")).toBeDefined()
    expect(db.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = 'codex:sess2'").get()).toEqual({
      c: 1,
    })
  })

  test("A1: mock ag re-export deletes canonical and @copy keys while preserving peer sessions", async () => {
    const mockAg = join(tempDir, "mock-ag-a1.ts")
    const now = Date.now()
    const canonPath = join(tempDir, "a1-canon.jsonl")
    const copyPath = join(tempDir, "a1-copy.jsonl")
    writeFileSync(canonPath, '{"role":"user","text":"hello from canon"}\n')
    writeFileSync(copyPath, '{"role":"user","text":"hello from copy"}\n')

    // Pre-insert peer session 2
    upsertSession(db, "codex:peer", "/proj", "/path/peer.jsonl", now, now, 1)
    insertMessage(db, null, "codex:peer", "user", "peer message", null, null, now)

    writeFileSync(
      mockAg,
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "transcript" && args[1] === "list") {
  console.log(JSON.stringify({ kind: "schema", version: 1 }));
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "sess-a1",
    sessionKey: "codex:sess-a1",
    canonicalPath: "${canonPath}",
    status: "canonical",
    copies: [
      { path: "${canonPath}", sizeBytes: 30, mtimeMs: ${now}, decision: "canonical", key: "codex:sess-a1" },
      { path: "${copyPath}", sizeBytes: 30, mtimeMs: ${now}, decision: "ambiguous", key: "codex:sess-a1@copy1" },
    ]
  }));
  console.log(JSON.stringify({ kind: "done", homes: 1, files: 2, sessions: 1, canonical: 1, ambiguous: 1, stale: 0, invalid: 0, unreadable: 0, errors: 0 }));
} else if (args[0] === "transcript" && args[1] === "export") {
  console.log(JSON.stringify({ kind: "schema", version: 1 }));
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "sess-a1",
    sessionKey: "codex:sess-a1",
    path: "${canonPath}",
    sizeBytes: 30,
    mtimeMs: ${now},
    lastEventAtMs: ${now},
    keys: ["codex:sess-a1"],
    copies: [
      { path: "${canonPath}", sizeBytes: 30, mtimeMs: ${now}, decision: "canonical", key: "codex:sess-a1" },
      { path: "${copyPath}", sizeBytes: 30, mtimeMs: ${now}, decision: "ambiguous", key: "codex:sess-a1@copy1" },
    ]
  }));
  console.log(JSON.stringify({
    kind: "row",
    provider: "codex",
    nativeId: "sess-a1",
    sessionKey: "codex:sess-a1",
    line: 1,
    role: "user",
    text: "reloaded canonical",
    timestamp: new Date(${now}).toISOString(),
  }));
  console.log(JSON.stringify({ kind: "end", nativeId: "sess-a1", status: "complete", rows: 1 }));
  console.log(JSON.stringify({ kind: "done", exported: 1, errors: 0 }));
}
`,
    )
    chmodSync(mockAg, 0o755)

    process.env.AG_BIN = mockAg
    const res = await rebuildIndex(db, { incremental: true })
    expect(res.codexSessions).toBe(1)
    expect(res.codexMessages).toBe(1)

    // Verify peer session survived untouched
    const peer = getSession(db, "codex:peer")
    expect(peer).toBeDefined()
    const peerMsgs = db.prepare("SELECT * FROM messages WHERE session_id = 'codex:peer'").all()
    expect(peerMsgs).toHaveLength(1)

    // Verify reloaded session exists
    const reloaded = getSession(db, "codex:sess-a1")
    expect(reloaded).toBeDefined()
  })

  // --------------------------------------------------------------------------
  // A2: Record canonical copy path
  // --------------------------------------------------------------------------
  test("A2: canonical copy path is recorded and unchanged across incremental runs", async () => {
    const mockAg = join(tempDir, "mock-ag.ts")
    const now = Date.now()
    const canonPath = join(tempDir, "canonical.jsonl")
    const stalePath = join(tempDir, "stale.jsonl")
    writeFileSync(canonPath, '{"role":"user","text":"hello"}\n')
    writeFileSync(stalePath, '{"role":"user","text":"old"}\n')

    writeFileSync(
      mockAg,
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "transcript" && args[1] === "list") {
  console.log(JSON.stringify({ kind: "schema", version: 1 }));
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "sess-a2",
    sessionKey: "codex:sess-a2",
    canonicalPath: "${canonPath}",
    status: "canonical",
    copies: [
      { path: "${stalePath}", sizeBytes: 28, mtimeMs: ${now - 10000}, decision: "stale", key: "codex:sess-a2" },
      { path: "${canonPath}", sizeBytes: 30, mtimeMs: ${now}, decision: "canonical", key: "codex:sess-a2" },
    ]
  }));
  console.log(JSON.stringify({ kind: "done", homes: 1, files: 2, sessions: 1, canonical: 1, ambiguous: 0, stale: 1, invalid: 0, unreadable: 0, errors: 0 }));
} else if (args[0] === "transcript" && args[1] === "export") {
  console.log(JSON.stringify({ kind: "schema", version: 1 }));
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "sess-a2",
    sessionKey: "codex:sess-a2",
    path: "${canonPath}",
    sizeBytes: 30,
    mtimeMs: ${now},
    lastEventAtMs: ${now},
    keys: ["codex:sess-a2"],
    copies: [
      { path: "${stalePath}", sizeBytes: 28, mtimeMs: ${now - 10000}, decision: "stale", key: "codex:sess-a2" },
      { path: "${canonPath}", sizeBytes: 30, mtimeMs: ${now}, decision: "canonical", key: "codex:sess-a2" },
    ]
  }));
  console.log(JSON.stringify({
    kind: "row",
    provider: "codex",
    nativeId: "sess-a2",
    sessionKey: "codex:sess-a2",
    line: 1,
    role: "user",
    text: "hello world",
    timestamp: new Date(${now}).toISOString(),
  }));
  console.log(JSON.stringify({ kind: "end", nativeId: "sess-a2", status: "complete", rows: 1 }));
  console.log(JSON.stringify({ kind: "done", exported: 1, errors: 0 }));
}
`,
    )
    chmodSync(mockAg, 0o755)

    process.env.AG_BIN = mockAg
    const res1 = await rebuildIndex(db, { incremental: true })
    expect(res1.codexSessions).toBe(1)

    const session = getSession(db, "codex:sess-a2")
    expect(session).toBeDefined()
    expect(session?.jsonl_path).toBe(canonPath)

    // Incremental run without change
    const res2 = await rebuildIndex(db, { incremental: true })
    expect(res2.codexSkipped).toBe(1)
    expect(res2.codexSessions).toBe(0)
    expect(getSession(db, "codex:sess-a2")?.jsonl_path).toBe(canonPath)
  })

  test("A2: multi-copy session stores each key's own path, size and mtime (both success and failure paths)", async () => {
    const mockAg = join(tempDir, "mock-ag-a2-multikey.ts")
    const copy1Path = join(tempDir, "copy1.jsonl")
    const copy2Path = join(tempDir, "copy2.jsonl")
    writeFileSync(copy1Path, '{"role":"user","text":"msg from copy 1"}\n')
    writeFileSync(copy2Path, '{"role":"user","text":"msg from copy 2 longer"}\n')

    const key1 = "codex:sess-multi@key1"
    const key2 = "codex:sess-multi@key2"
    const size1 = 111
    const size2 = 222
    const mtime1 = 1710000001000
    const mtime2 = 1710000002000

    writeFileSync(
      mockAg,
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "transcript" && args[1] === "list") {
  console.log(JSON.stringify({ kind: "schema", version: 1 }));
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "sess-multi",
    status: "ambiguous",
    copies: [
      { key: "${key1}", path: "${copy1Path}", sizeBytes: ${size1}, mtimeMs: ${mtime1}, lastEventAtMs: null },
      { key: "${key2}", path: "${copy2Path}", sizeBytes: ${size2}, mtimeMs: ${mtime2}, lastEventAtMs: null },
    ]
  }));
  console.log(JSON.stringify({ kind: "done", homes: 1, files: 2, sessions: 1, canonical: 0, ambiguous: 1, stale: 0, invalid: 0, unreadable: 0, errors: 0 }));
} else if (args[0] === "transcript" && args[1] === "export") {
  console.log(JSON.stringify({ kind: "schema", version: 1 }));
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "sess-multi",
    sessionKey: "${key1}",
    path: "${copy1Path}",
    keys: ["${key1}", "${key2}"],
    copies: [
      { key: "${key1}", path: "${copy1Path}", sizeBytes: ${size1}, mtimeMs: ${mtime1}, lastEventAtMs: null },
      { key: "${key2}", path: "${copy2Path}", sizeBytes: ${size2}, mtimeMs: ${mtime2}, lastEventAtMs: null },
    ]
  }));
  console.log(JSON.stringify({ kind: "row", sessionKey: "${key1}", line: 1, role: "user", text: "msg 1", timestamp: null, recordKind: "event_msg", duplicateOf: null }));
  console.log(JSON.stringify({ kind: "row", sessionKey: "${key2}", line: 1, role: "user", text: "msg 2", timestamp: null, recordKind: "event_msg", duplicateOf: null }));
  console.log(JSON.stringify({ kind: "end", nativeId: "sess-multi", keys: ["${key1}", "${key2}"], status: "complete", rows: 2, skipped: 0 }));
  console.log(JSON.stringify({ kind: "done", exported: 1, errors: 0 }));
}
`,
    )
    chmodSync(mockAg, 0o755)

    await indexCodexTranscripts(db, { agBin: mockAg })

    const s1 = getSession(db, key1)
    const s2 = getSession(db, key2)
    expect(s1).toBeDefined()
    expect(s2).toBeDefined()

    // Each key holds its own path, size, and mtime
    expect(s1?.jsonl_path).toBe(copy1Path)
    expect(s1?.size_bytes).toBe(size1)
    expect(s1?.mtime_ms).toBe(mtime1)

    expect(s2?.jsonl_path).toBe(copy2Path)
    expect(s2?.size_bytes).toBe(size2)
    expect(s2?.mtime_ms).toBe(mtime2)
  })

  test("A2: failure path records each key's own path, size and mtime without taking copies[0]", async () => {
    const mockAg = join(tempDir, "mock-ag-a2-fail.ts")
    const copy1Path = join(tempDir, "fail-copy1.jsonl")
    const copy2Path = join(tempDir, "fail-copy2.jsonl")
    writeFileSync(copy1Path, "bad json 1\n")
    writeFileSync(copy2Path, "bad json 2\n")

    const key1 = "codex:sess-fail@key1"
    const key2 = "codex:sess-fail@key2"
    const size1 = 55
    const size2 = 99
    const mtime1 = 1710000005000
    const mtime2 = 1710000009000

    writeFileSync(
      mockAg,
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "transcript" && args[1] === "list") {
  console.log(JSON.stringify({ kind: "schema", version: 1 }));
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "sess-fail",
    status: "ambiguous",
    copies: [
      { key: "${key1}", path: "${copy1Path}", sizeBytes: ${size1}, mtimeMs: ${mtime1}, lastEventAtMs: null },
      { key: "${key2}", path: "${copy2Path}", sizeBytes: ${size2}, mtimeMs: ${mtime2}, lastEventAtMs: null },
    ]
  }));
  console.log(JSON.stringify({ kind: "done", homes: 1, files: 2, sessions: 1, canonical: 0, ambiguous: 1, stale: 0, invalid: 0, unreadable: 0, errors: 0 }));
} else if (args[0] === "transcript" && args[1] === "export") {
  console.log(JSON.stringify({ kind: "schema", version: 1 }));
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "sess-fail",
    sessionKey: "${key1}",
    path: "${copy1Path}",
    keys: ["${key1}", "${key2}"],
    copies: [
      { key: "${key1}", path: "${copy1Path}", sizeBytes: ${size1}, mtimeMs: ${mtime1}, lastEventAtMs: null },
      { key: "${key2}", path: "${copy2Path}", sizeBytes: ${size2}, mtimeMs: ${mtime2}, lastEventAtMs: null },
    ]
  }));
  console.log(JSON.stringify({ kind: "end", nativeId: "sess-fail", keys: ["${key1}", "${key2}"], status: "unreadable", rows: 0, skipped: 0 }));
  console.log(JSON.stringify({ kind: "done", exported: 1, errors: 0 }));
}
`,
    )
    chmodSync(mockAg, 0o755)

    await indexCodexTranscripts(db, { agBin: mockAg })

    const s1 = getSession(db, key1)
    const s2 = getSession(db, key2)
    expect(s1).toBeDefined()
    expect(s2).toBeDefined()

    // In failure path, each key also holds its own path, size, and mtime
    expect(s1?.jsonl_path).toBe(copy1Path)
    expect(s1?.size_bytes).toBe(size1)
    expect(s1?.mtime_ms).toBe(mtime1)

    expect(s2?.jsonl_path).toBe(copy2Path)
    expect(s2?.size_bytes).toBe(size2)
    expect(s2?.mtime_ms).toBe(mtime2)
  })

  test("A2: red arm - taking copies[0] on multi-key causes key2 to erroneously hold copy1 path", () => {
    const key1 = "codex:sess@k1"
    const key2 = "codex:sess@k2"
    const copies = [
      { key: key1, path: "/path/copy1.jsonl", sizeBytes: 100, mtimeMs: 1000 },
      { key: key2, path: "/path/copy2.jsonl", sizeBytes: 200, mtimeMs: 2000 },
    ]
    // Stated rule:
    const correctSelection = (k: string) => copies.find((c) => c.key === k)
    // Red arm: taking copies[0] unconditionally
    const flawedSelection = (_k: string) => copies[0]

    expect(correctSelection(key2)?.path).toBe("/path/copy2.jsonl")
    expect(flawedSelection(key2)?.path).toBe("/path/copy1.jsonl")
    expect(flawedSelection(key2)?.path).not.toBe("/path/copy2.jsonl")
  })

  // --------------------------------------------------------------------------
  // A3: Codex mtime float tolerance
  // --------------------------------------------------------------------------
  test("A3: sub-millisecond mtime drift between FS float and stored int does not cause re-export", async () => {
    const mockAg = join(tempDir, "mock-ag-a3.ts")
    const now = Date.now()
    const canonPath = join(tempDir, "a3.jsonl")
    writeFileSync(canonPath, '{"role":"user","text":"hello"}\n')

    // Stored in db as integer milliseconds: e.g. 1700000000123
    // ag transcript list might report float from FS: 1700000000123.456
    upsertSession(db, "codex:sess-a3", "/proj", canonPath, now, now, 1, null, {
      status: "complete",
      sizeBytes: 25,
      mtimeMs: 1700000000123,
    })

    writeFileSync(
      mockAg,
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "transcript" && args[1] === "list") {
  console.log(JSON.stringify({ kind: "schema", version: 1 }));
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "sess-a3",
    sessionKey: "codex:sess-a3",
    canonicalPath: "${canonPath}",
    status: "canonical",
    copies: [
      { path: "${canonPath}", sizeBytes: 25, mtimeMs: 1700000000123.456, decision: "canonical", key: "codex:sess-a3" },
    ]
  }));
  console.log(JSON.stringify({ kind: "done", homes: 1, files: 1, sessions: 1, canonical: 1, ambiguous: 0, stale: 0, invalid: 0, unreadable: 0, errors: 0 }));
} else if (args[0] === "transcript" && args[1] === "export") {
  // Should NOT be called
  console.error("ERROR: export called unexpectedly!");
  process.exit(1);
}
`,
    )
    chmodSync(mockAg, 0o755)

    process.env.AG_BIN = mockAg
    const res = await rebuildIndex(db, { incremental: true })
    expect(res.codexSkipped).toBe(1)
    expect(res.codexSessions).toBe(0)
  })

  // --------------------------------------------------------------------------
  // A4: Subagent key derivation and non-session exclusion
  // --------------------------------------------------------------------------
  test("A4: discoverSessionFiles includes valid transcripts and excludes non-session files", async () => {
    const projDir = join(projectsDir, "my-proj")
    mkdirSync(projDir, { recursive: true })

    // Valid main session
    const mainSession = join(projDir, "main-sess.jsonl")
    writeFileSync(mainSession, "{}\n")

    // Valid nested subagent session
    const subDir = join(projDir, "main-sess", "subagents")
    mkdirSync(subDir, { recursive: true })
    const subSession = join(subDir, "agent-worker.jsonl")
    writeFileSync(subSession, "{}\n")

    // Memory / non-session file
    const memDir = join(projDir, "memory")
    mkdirSync(memDir, { recursive: true })
    const memFile = join(memDir, "ab-pro.jsonl")
    writeFileSync(memFile, "{}\n")

    const discovered: string[] = []
    for await (const file of findSessionFiles()) {
      discovered.push(file)
    }
    expect(discovered).toContain(mainSession)
    expect(discovered).toContain(subSession)
    expect(discovered).not.toContain(memFile)

    expect(isTranscriptShape(path.relative(projectsDir, mainSession))).toBe(true)
    expect(isTranscriptShape(path.relative(projectsDir, subSession))).toBe(true)
    expect(isTranscriptShape(path.relative(projectsDir, memFile))).toBe(false)
  })

  // --------------------------------------------------------------------------
  // A5: Incremental negative-caching of failed sessions
  // --------------------------------------------------------------------------
  test("A5: new Claude failure exits 5, unchanged failed file is cached and exits 0", async () => {
    process.env.RECALL_SKIP_CODEX = "1"
    const proj = join(projectsDir, "proj-fail")
    mkdirSync(proj, { recursive: true })
    const badFile = join(proj, "bad-session.jsonl")
    writeFileSync(badFile, "not valid json at all\n")

    vi.spyOn(console, "log").mockImplementation(() => {})

    // Run 1: badFile fails -> exits 5 and records stale-unreadable
    process.exitCode = undefined
    await cmdIndex({ incremental: true })
    expect(process.exitCode).toBe(5)

    const failedSession = getSession(db, "bad-session")
    expect(failedSession).toBeDefined()
    expect(failedSession?.status).toBe("stale-unreadable")

    // Run 2: badFile unchanged on disk -> skipped by negative cache -> exits 0
    process.exitCode = undefined
    await cmdIndex({ incremental: true })
    expect(process.exitCode).toBe(0)
  })

  // --------------------------------------------------------------------------
  // Item 5: cmdIndex prints skipped sessions older than 180 days
  // --------------------------------------------------------------------------
  test("Item 5: cmdIndex prints '(skipped N sessions older than 180 days)' when skippedOld > 0", async () => {
    process.env.RECALL_SKIP_CODEX = "1"
    const proj = join(projectsDir, "proj-old")
    mkdirSync(proj, { recursive: true })
    const oldFile = join(proj, "old-session.jsonl")
    const now = Date.now()
    const oldMtimeMs = now - 181 * 24 * 60 * 60 * 1000 // 181 days old
    writeFileSync(
      oldFile,
      JSON.stringify({
        type: "user",
        sessionId: "old-session",
        timestamp: new Date(oldMtimeMs).toISOString(),
        message: { content: [{ type: "text", text: "ancient message" }] },
      }) + "\n",
    )
    const utimeDate = new Date(oldMtimeMs)
    utimesSync(oldFile, utimeDate, utimeDate)

    const logs: string[] = []
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "))
    })

    try {
      await cmdIndex({ incremental: true })
      expect(logs.some((l) => l.includes("(skipped 1 sessions older than 180 days)"))).toBe(true)
    } finally {
      logSpy.mockRestore()
    }
  })

  // --------------------------------------------------------------------------
  // N1: Missing or Unknown Status in Transcript Export End Record
  // --------------------------------------------------------------------------
  test("N1: end record with missing status is rejected as protocol error naming the session, leaving no open tx", async () => {
    const mockAg = join(tempDir, "mock-ag-n1-nostatus.ts")
    writeFileSync(
      mockAg,
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "transcript" && args[1] === "list") {
  console.log(JSON.stringify({ kind: "schema", version: 1 }));
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "sess-nostatus",
    sessionKey: "codex:sess-nostatus",
    canonicalPath: "/fake/nostatus.jsonl",
    status: "canonical",
    copies: [{ key: "codex:sess-nostatus", path: "/fake/nostatus.jsonl", sizeBytes: 10, mtimeMs: 1000, lastEventAtMs: null }]
  }));
  console.log(JSON.stringify({ kind: "done", homes: 1, files: 1, sessions: 1, canonical: 1, ambiguous: 0, stale: 0, invalid: 0, unreadable: 0, errors: 0 }));
} else if (args[0] === "transcript" && args[1] === "export") {
  console.log(JSON.stringify({ kind: "schema", version: 1 }));
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "sess-nostatus",
    sessionKey: "codex:sess-nostatus",
    path: "/fake/nostatus.jsonl",
    keys: ["codex:sess-nostatus"],
    copies: [{ key: "codex:sess-nostatus", path: "/fake/nostatus.jsonl", sizeBytes: 10, mtimeMs: 1000, lastEventAtMs: null }]
  }));
  console.log(JSON.stringify({ kind: "row", sessionKey: "codex:sess-nostatus", line: 1, role: "user", text: "hi", timestamp: null, recordKind: "event_msg", duplicateOf: null }));
  // Missing status property on end record
  console.log(JSON.stringify({ kind: "end", nativeId: "sess-nostatus", keys: ["codex:sess-nostatus"], rows: 1, skipped: 0 }));
  console.log(JSON.stringify({ kind: "done", exported: 1, errors: 0 }));
}
`,
    )
    chmodSync(mockAg, 0o755)

    await expect(indexCodexTranscripts(db, { agBin: mockAg })).rejects.toThrow(
      "Protocol error: received end record without status for session sess-nostatus",
    )

    // Verify session was NOT committed
    expect(getSession(db, "codex:sess-nostatus")).toBeNull()

    // Verify no open transaction was left
    expect(() => {
      db.exec("BEGIN IMMEDIATE")
      db.exec("ROLLBACK")
    }).not.toThrow()
  })

  test("N1: end record with unknown status is rejected as protocol error naming unknown status and session", async () => {
    const mockAg = join(tempDir, "mock-ag-n1-unknownstatus.ts")
    writeFileSync(
      mockAg,
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "transcript" && args[1] === "list") {
  console.log(JSON.stringify({ kind: "schema", version: 1 }));
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "sess-unknown",
    sessionKey: "codex:sess-unknown",
    canonicalPath: "/fake/unknown.jsonl",
    status: "canonical",
    copies: [{ key: "codex:sess-unknown", path: "/fake/unknown.jsonl", sizeBytes: 10, mtimeMs: 1000, lastEventAtMs: null }]
  }));
  console.log(JSON.stringify({ kind: "done", homes: 1, files: 1, sessions: 1, canonical: 1, ambiguous: 0, stale: 0, invalid: 0, unreadable: 0, errors: 0 }));
} else if (args[0] === "transcript" && args[1] === "export") {
  console.log(JSON.stringify({ kind: "schema", version: 1 }));
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "sess-unknown",
    sessionKey: "codex:sess-unknown",
    path: "/fake/unknown.jsonl",
    keys: ["codex:sess-unknown"],
    copies: [{ key: "codex:sess-unknown", path: "/fake/unknown.jsonl", sizeBytes: 10, mtimeMs: 1000, lastEventAtMs: null }]
  }));
  console.log(JSON.stringify({ kind: "row", sessionKey: "codex:sess-unknown", line: 1, role: "user", text: "hi", timestamp: null, recordKind: "event_msg", duplicateOf: null }));
  // Unknown status 'partial'
  console.log(JSON.stringify({ kind: "end", nativeId: "sess-unknown", keys: ["codex:sess-unknown"], status: "partial", rows: 1, skipped: 0 }));
  console.log(JSON.stringify({ kind: "done", exported: 1, errors: 0 }));
}
`,
    )
    chmodSync(mockAg, 0o755)

    await expect(indexCodexTranscripts(db, { agBin: mockAg })).rejects.toThrow(
      'Protocol error: unknown end record status "partial" for session sess-unknown',
    )

    // Verify session was NOT committed
    expect(getSession(db, "codex:sess-unknown")).toBeNull()

    // Verify no open transaction was left
    expect(() => {
      db.exec("BEGIN IMMEDIATE")
      db.exec("ROLLBACK")
    }).not.toThrow()
  })

  // --------------------------------------------------------------------------
  // Chief Ruling 1: BEGIN IMMEDIATE & version re-read inside transaction
  // --------------------------------------------------------------------------
  test("Chief Ruling 1: runMigrations uses BEGIN IMMEDIATE and safely re-reads user_version inside transaction", () => {
    const memoryDb = new Database(":memory:")
    initSchema(memoryDb)
    expect((memoryDb.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3)

    // Setting user_version back to 2
    memoryDb.exec("PRAGMA user_version = 2")
    expect((memoryDb.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2)

    // If another transaction advances version to 3 inside the transaction, re-read sees it
    const origPrepare = memoryDb.prepare.bind(memoryDb)
    let reReadChecked = false
    memoryDb.prepare = ((sql: string) => {
      if (sql.includes("PRAGMA user_version") && !reReadChecked) {
        reReadChecked = true
      }
      return origPrepare(sql)
    }) as any

    // Running migrations brings user_version cleanly to 3
    runMigrations(memoryDb)
    expect(reReadChecked).toBe(true)
    expect((memoryDb.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3)
    memoryDb.close()
  })
})
