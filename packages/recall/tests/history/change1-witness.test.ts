import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { initSchema } from "../../src/history/db-schema.ts"
import { getSession, insertMessage, upsertSession } from "../../src/history/db-queries.ts"
import { closeDb } from "../../src/history/db.ts"
import { rebuildIndex, findSessionFiles, isTranscriptShape } from "../../src/history/indexer.ts"
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
  test("A1: delete by key list uses covering index without SCAN messages", () => {
    const plan = db
      .prepare("EXPLAIN QUERY PLAN DELETE FROM messages WHERE session_id IN (?, ?)")
      .all("codex:sess1", "codex:sess1@copy1") as Array<{ detail: string }>

    const planDetails = plan.map((p) => p.detail).join(" ")
    expect(planDetails).not.toContain("SCAN messages")
    expect(planDetails).toContain("SEARCH messages")
  })

  test("A1: explicit key delete removes canonical and @copy rows while preserving peers", () => {
    // Populate session 1 (canonical + @copy) and session 2
    upsertSession(db, "codex:sess1", "/proj", "/path/canon", 100, 100, 2)
    upsertSession(db, "codex:sess1@copy1", "/proj", "/path/copy1", 100, 100, 1)
    upsertSession(db, "codex:sess2", "/proj", "/path/sess2", 100, 100, 3)

    insertMessage(db, "u1", "codex:sess1", "user", "msg1", null, null, 100)
    insertMessage(db, "u2", "codex:sess1@copy1", "assistant", "msg2", null, null, 101)
    insertMessage(db, "u3", "codex:sess2", "user", "msg3", null, null, 102)

    // Execute delete statement used by codex-indexer
    const deleteKeys = ["codex:sess1", "codex:sess1@copy1"]
    const placeholders = deleteKeys.map(() => "?").join(",")
    db.prepare(`DELETE FROM messages WHERE session_id IN (${placeholders})`).run(...deleteKeys)
    db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...deleteKeys)

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
  console.log(JSON.stringify({ kind: "row", sessionKey: "codex:sess-a2", line: 1, role: "user", text: "hello", timestamp: new Date(${now}).toISOString(), recordKind: "event_msg" }));
  console.log(JSON.stringify({ kind: "end", nativeId: "sess-a2", keys: ["codex:sess-a2"], rows: 1, skipped: 0, status: "complete" }));
  console.log(JSON.stringify({ kind: "done", sessions: 1, rows: 1, skipped: 0, status: "ok" }));
}
`,
    )
    chmodSync(mockAg, 0o755)
    process.env.AG_BIN = mockAg

    // Run 1: index session
    const res1 = await rebuildIndex(db, { incremental: true, agBin: mockAg })
    expect(res1.codexSessions).toBe(1)

    // Stored jsonl_path MUST be the canonical path, not the first copy (stalePath)
    const stored = getSession(db, "codex:sess-a2")
    expect(stored).toBeDefined()
    expect(stored?.jsonl_path).toBe(canonPath)

    // Run 2: incremental pass with no changes MUST skip the session (0 exported)
    const res2 = await rebuildIndex(db, { incremental: true, agBin: mockAg })
    expect(res2.codexSessions).toBe(0)
    expect(res2.codexSkipped).toBe(1)
  })

  // --------------------------------------------------------------------------
  // A3: One catalog call per run
  // --------------------------------------------------------------------------
  test("A3: exactly 1 ag transcript list is invoked per rebuildIndex", async () => {
    const listLogFile = join(tempDir, "list-calls.log")
    const mockAg = join(tempDir, "mock-ag-a3.ts")
    writeFileSync(
      mockAg,
      `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "transcript" && args[1] === "list") {
  appendFileSync("${listLogFile}", "list\\n");
  console.log(JSON.stringify({ kind: "schema", version: 1 }));
  console.log(JSON.stringify({ kind: "done", homes: 1, files: 0, sessions: 0, canonical: 0, ambiguous: 0, stale: 0, invalid: 0, unreadable: 0, errors: 0 }));
}
`,
    )
    chmodSync(mockAg, 0o755)
    process.env.AG_BIN = mockAg

    await rebuildIndex(db, { incremental: true, agBin: mockAg })

    const fs = await import("node:fs")
    const listCalls = fs.readFileSync(listLogFile, "utf8").trim().split("\n").filter(Boolean)
    expect(listCalls.length).toBe(1)
  })

  // --------------------------------------------------------------------------
  // A4: Discovery takes transcript shapes only
  // --------------------------------------------------------------------------
  test("A4: discovery excludes non-transcript files like memory/ab-pro.jsonl", async () => {
    expect(isTranscriptShape("proj/uuid.jsonl")).toBe(true)
    expect(isTranscriptShape("proj/parent/subagents/agent-sub.jsonl")).toBe(true)
    expect(isTranscriptShape("proj/parent/subagents/workflows/w1/agent-sub.jsonl")).toBe(true)
    expect(isTranscriptShape("proj/memory/ab-pro.jsonl")).toBe(false)
    expect(isTranscriptShape("proj/plans/foo.jsonl")).toBe(false)
    expect(isTranscriptShape("proj/parent/subagents/workflows/w1/journal.jsonl")).toBe(false)

    // Create 2 project dirs each holding memory/ab-pro.jsonl and 1 valid transcript
    const proj1 = join(projectsDir, "proj-1")
    const proj2 = join(projectsDir, "proj-2")
    mkdirSync(join(proj1, "memory"), { recursive: true })
    mkdirSync(join(proj2, "memory"), { recursive: true })

    writeFileSync(join(proj1, "memory", "ab-pro.jsonl"), '{"type":"user","message":"mem1"}\n')
    writeFileSync(join(proj2, "memory", "ab-pro.jsonl"), '{"type":"user","message":"mem2"}\n')
    writeFileSync(join(proj1, "valid-1.jsonl"), '{"type":"user","message":{"content":"v1"}}\n')

    process.env.RECALL_SKIP_CODEX = "1"
    const res1 = await rebuildIndex(db, { incremental: true })
    expect(res1.files).toBe(1) // only valid-1.jsonl

    // Neither memory/ab-pro.jsonl should have produced a session row
    const abProRows = db.prepare("SELECT * FROM sessions WHERE id = 'ab-pro'").all()
    expect(abProRows.length).toBe(0)

    // Second run re-parses 0 files
    const res2 = await rebuildIndex(db, { incremental: true })
    expect(res2.messages).toBe(0)
  })

  // --------------------------------------------------------------------------
  // A5: Claude failures are loud (exit 5) and cached on second run (exit 0)
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
})
