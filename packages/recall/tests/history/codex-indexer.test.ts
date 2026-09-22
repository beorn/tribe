import { Database } from "bun:sqlite"
import { writeFileSync, mkdtempSync, chmodSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { initSchema } from "../../src/history/db-schema.ts"
import { getSession, upsertSession, insertMessage, ftsSearchWithSnippet } from "../../src/history/db-queries.ts"
import { resolveAgBin, fetchCodexCatalog, indexCodexTranscripts, safeRollback } from "../../src/history/codex-indexer.ts"
import { rebuildIndex, INDEX_WINDOW_DAYS, INDEX_WINDOW_MS, pruneOldSessions } from "../../src/history/indexer.ts"

describe("Codex Transcript Indexer", () => {
  let tempDir: string
  let db: Database

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "recall-codex-test-"))
    db = new Database(":memory:")
    initSchema(db)
  })

  afterEach(() => {
    db.close()
  })

  function makeMockAg(content: string): string {
    const scriptPath = join(tempDir, `mock-ag-${Math.random().toString(36).slice(2)}.ts`)
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env bun
${content}
`,
    )
    chmodSync(scriptPath, 0o755)
    return scriptPath
  }

  describe("resolveAgBin", () => {
    test("returns explicit valid binary path", () => {
      const mock = makeMockAg('console.log("ok")')
      expect(resolveAgBin(mock)).toBe(mock)
    })

    test("throws fail-loud error when binary cannot be found", () => {
      expect(() => resolveAgBin("/nonexistent/path/to/ag")).toThrow("Specified ag binary does not exist")
    })
  })

  describe("Protocol Negotiation & Fail-Loud Validation", () => {
    test("rejects unsupported schema version in list", async () => {
      const mock = makeMockAg(`
console.log(JSON.stringify({ kind: "schema", version: 2 }))
console.log(JSON.stringify({ kind: "done", discovered: 0 }))
`)
      await expect(fetchCodexCatalog(mock)).rejects.toThrow(
        "Unsupported ag transcript schema version: expected 1, got 2",
      )
    })

    test("rejects stream ending without done in list", async () => {
      const mock = makeMockAg(`
console.log(JSON.stringify({ kind: "schema", version: 1 }))
`)
      await expect(fetchCodexCatalog(mock)).rejects.toThrow("ag transcript list stream ended without done record")
    })

    test("rejects stream cut off abruptly in active transaction during export", async () => {
      const mock = makeMockAg(`
const args = process.argv.slice(2)
if (args.includes("list")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "cut-test-123",
    canonicalPath: "/fake/cut.jsonl",
    copies: [{ path: "/fake/cut.jsonl", account: null, sizeBytes: 100, mtimeMs: 1000, lastEventAtMs: null }],
    status: "canonical",
    key: "codex:cut-test-123"
  }))
  console.log(JSON.stringify({ kind: "done", discovered: 1, canonical: 1 }))
} else {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "cut-test-123",
    sessionKey: "codex:cut-test-123",
    path: "/fake/cut.jsonl",
    keys: ["codex:cut-test-123"]
  }))
  // Terminate without end or done
  process.exit(0)
}
`)
      await expect(indexCodexTranscripts(db, { agBin: mock })).rejects.toThrow(
        "ag transcript export stream ended abruptly during active transaction",
      )
      // Assert database holds no partial session
      expect(getSession(db, "codex:cut-test-123")).toBeFalsy()
    })
  })

  describe("Ingestion, Skip-Key & Search", () => {
    test("indexes canonical session and exposes content to FTS search", async () => {
      const mock = makeMockAg(`
const args = process.argv.slice(2)
if (args.includes("list")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "session-abc",
    canonicalPath: "/fake/session-abc.jsonl",
    copies: [{ path: "/fake/session-abc.jsonl", account: null, sizeBytes: 500, mtimeMs: 1700000000000, lastEventAtMs: null }],
    status: "canonical",
    key: "codex:session-abc"
  }))
  console.log(JSON.stringify({ kind: "done", discovered: 1, canonical: 1 }))
} else {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "session-abc",
    sessionKey: "codex:session-abc",
    path: "/fake/session-abc.jsonl",
    cwd: "/workspace/project",
    createdAt: "2026-09-21T10:00:00.000Z",
    sizeBytes: 500,
    mtimeMs: 1700000000000,
    lastEventAtMs: null,
    keys: ["codex:session-abc"]
  }))
  console.log(JSON.stringify({
    kind: "row",
    sessionKey: "codex:session-abc",
    line: 10,
    role: "user",
    text: "please implement the silverize algorithm",
    timestamp: "2026-09-21T10:00:01.000Z",
    recordKind: "event_msg",
    duplicateOf: null
  }))
  console.log(JSON.stringify({
    kind: "row",
    sessionKey: "codex:session-abc",
    line: 12,
    role: "assistant",
    text: "Here is the silverize implementation for Silvery reconciler",
    timestamp: "2026-09-21T10:00:05.000Z",
    recordKind: "response_item",
    duplicateOf: null
  }))
  console.log(JSON.stringify({
    kind: "end",
    nativeId: "session-abc",
    keys: ["codex:session-abc"],
    rows: 2,
    skipped: 0,
    status: "complete"
  }))
  console.log(JSON.stringify({ kind: "done", sessions: 1, rows: 2, errors: 0 }))
}
`)

      // First run: ingests session
      const res1 = await indexCodexTranscripts(db, { agBin: mock })
      expect(res1.sessions).toBe(1)
      expect(res1.rows).toBe(2)
      expect(res1.skipped).toBe(0)

      const stored = getSession(db, "codex:session-abc")
      expect(stored).toBeDefined()
      expect(stored?.status).toBe("complete")
      expect(stored?.message_count).toBe(2)
      expect(stored?.size_bytes).toBe(500)
      expect(stored?.mtime_ms).toBe(1700000000000)

      // Verify messages table
      const msgs = db
        .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp")
        .all("codex:session-abc") as {
        uuid: string
        type: string
        content: string
      }[]
      expect(msgs).toHaveLength(2)
      expect(msgs[0]!.uuid).toBe("codex:session-abc:10")
      expect(msgs[0]!.type).toBe("user")
      expect(msgs[0]!.content).toContain("silverize algorithm")
      expect(msgs[1]!.uuid).toBe("codex:session-abc:12")
      expect(msgs[1]!.type).toBe("assistant")
      expect(msgs[1]!.content).toContain("Silvery reconciler")

      // Verify FTS search
      const ftsMatches = db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'silverize'").all()
      expect(ftsMatches.length).toBeGreaterThan(0)

      // Second run: skip key matches, skipped = 1
      const res2 = await indexCodexTranscripts(db, { agBin: mock })
      expect(res2.sessions).toBe(0)
      expect(res2.skipped).toBe(1)

      // Third run with full: true: re-indexes even when skip key matches
      const res3 = await indexCodexTranscripts(db, { agBin: mock, full: true })
      expect(res3.sessions).toBe(1)
      expect(res3.rows).toBe(2)
    })
  })

  describe("Error Outcomes & Shrink Safety (CTO C3 & D1)", () => {
    test("incomplete-tail commits valid rows with incomplete-tail status", async () => {
      const mock = makeMockAg(`
const args = process.argv.slice(2)
if (args.includes("list")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "tail-test",
    canonicalPath: "/fake/tail.jsonl",
    copies: [{ path: "/fake/tail.jsonl", account: null, sizeBytes: 200, mtimeMs: 1000, lastEventAtMs: null }],
    status: "canonical",
    key: "codex:tail-test"
  }))
  console.log(JSON.stringify({ kind: "done", discovered: 1, canonical: 1 }))
} else {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "tail-test",
    sessionKey: "codex:tail-test",
    path: "/fake/tail.jsonl",
    keys: ["codex:tail-test"]
  }))
  console.log(JSON.stringify({
    kind: "row",
    sessionKey: "codex:tail-test",
    line: 1,
    role: "user",
    text: "partial tail query",
    timestamp: "2026-09-21T10:00:00.000Z",
    recordKind: "event_msg",
    duplicateOf: null
  }))
  console.log(JSON.stringify({
    kind: "end",
    nativeId: "tail-test",
    keys: ["codex:tail-test"],
    rows: 1,
    skipped: 0,
    status: "incomplete-tail"
  }))
  console.log(JSON.stringify({ kind: "done", sessions: 1, rows: 1, errors: 0 }))
}
`)
      const res = await indexCodexTranscripts(db, { agBin: mock })
      expect(res.sessions).toBe(1)
      const stored = getSession(db, "codex:tail-test")
      expect(stored?.status).toBe("incomplete-tail")
      expect(stored?.message_count).toBe(1)
    })

    test("shrunk file without --force rolls back and marks session shrunk without deleting rows", async () => {
      // Pre-seed a session with 5 messages
      db.prepare(`INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, status, size_bytes, mtime_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "codex:shrink-test",
        "/cwd",
        "/fake/shrink.jsonl",
        1000,
        1000,
        5,
        "complete",
        500,
        1000,
      )
      for (let i = 1; i <= 5; i++) {
        db.prepare(`INSERT INTO messages (uuid, session_id, type, content, timestamp) VALUES (?, ?, ?, ?, ?)`).run(
          `codex:shrink-test:${i}`,
          "codex:shrink-test",
          "user",
          `old message ${i}`,
          1000 + i,
        )
      }

      // Mock returns 2 messages (fewer than 5) with changed mtime
      const mock = makeMockAg(`
const args = process.argv.slice(2)
if (args.includes("list")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "shrink-test",
    canonicalPath: "/fake/shrink.jsonl",
    copies: [{ path: "/fake/shrink.jsonl", account: null, sizeBytes: 300, mtimeMs: 2000, lastEventAtMs: null }],
    status: "canonical",
    key: "codex:shrink-test"
  }))
  console.log(JSON.stringify({ kind: "done", discovered: 1, canonical: 1 }))
} else {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "shrink-test",
    sessionKey: "codex:shrink-test",
    path: "/fake/shrink.jsonl",
    keys: ["codex:shrink-test"]
  }))
  console.log(JSON.stringify({
    kind: "row",
    sessionKey: "codex:shrink-test",
    line: 1,
    role: "user",
    text: "new truncated row 1",
    timestamp: "2026-09-21T10:00:00.000Z",
    recordKind: "event_msg",
    duplicateOf: null
  }))
  console.log(JSON.stringify({
    kind: "row",
    sessionKey: "codex:shrink-test",
    line: 2,
    role: "user",
    text: "new truncated row 2",
    timestamp: "2026-09-21T10:00:01.000Z",
    recordKind: "event_msg",
    duplicateOf: null
  }))
  console.log(JSON.stringify({
    kind: "end",
    nativeId: "shrink-test",
    keys: ["codex:shrink-test"],
    rows: 2,
    skipped: 0,
    status: "complete"
  }))
  console.log(JSON.stringify({ kind: "done", sessions: 1, rows: 2, errors: 0 }))
}
`)

      // Without --force: should NOT delete old rows; marks status as shrunk
      await indexCodexTranscripts(db, { agBin: mock, force: false })
      const stored = getSession(db, "codex:shrink-test")
      expect(stored?.status).toBe("shrunk")
      const msgCount = (
        db.prepare("SELECT COUNT(*) as n FROM messages WHERE session_id = ?").get("codex:shrink-test") as { n: number }
      ).n
      expect(msgCount).toBe(5) // original rows kept!

      // With --force: commits the shrunk session
      await indexCodexTranscripts(db, { agBin: mock, force: true })
      const forcedStored = getSession(db, "codex:shrink-test")
      expect(forcedStored?.status).toBe("complete")
      expect(forcedStored?.message_count).toBe(2)
      const forcedMsgCount = (
        db.prepare("SELECT COUNT(*) as n FROM messages WHERE session_id = ?").get("codex:shrink-test") as { n: number }
      ).n
      expect(forcedMsgCount).toBe(2)
    })

    test("unreadable session preserves existing rows and sets status to stale-unreadable", async () => {
      // Pre-seed session
      db.prepare(`INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, status, size_bytes, mtime_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "codex:unreadable-test",
        "/cwd",
        "/fake/unread.jsonl",
        1000,
        1000,
        3,
        "complete",
        300,
        1000,
      )
      for (let i = 1; i <= 3; i++) {
        db.prepare(`INSERT INTO messages (uuid, session_id, type, content, timestamp) VALUES (?, ?, ?, ?, ?)`).run(
          `codex:unreadable-test:${i}`,
          "codex:unreadable-test",
          "user",
          `unread msg ${i}`,
          1000 + i,
        )
      }

      const mock = makeMockAg(`
const args = process.argv.slice(2)
if (args.includes("list")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "unreadable-test",
    canonicalPath: "/fake/unread.jsonl",
    copies: [{ path: "/fake/unread.jsonl", account: null, sizeBytes: 300, mtimeMs: 2000, lastEventAtMs: null }],
    status: "canonical",
    key: "codex:unreadable-test"
  }))
  console.log(JSON.stringify({ kind: "done", discovered: 1, canonical: 1 }))
} else {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "unreadable-test",
    sessionKey: "codex:unreadable-test",
    path: "/fake/unread.jsonl",
    keys: ["codex:unreadable-test"]
  }))
  console.log(JSON.stringify({
    kind: "end",
    nativeId: "unreadable-test",
    keys: ["codex:unreadable-test"],
    rows: 0,
    skipped: 0,
    status: "unreadable"
  }))
  console.log(JSON.stringify({ kind: "done", sessions: 1, rows: 0, unreadable: 1 }))
}
`)

      await indexCodexTranscripts(db, { agBin: mock })
      const stored = getSession(db, "codex:unreadable-test")
      expect(stored?.status).toBe("stale-unreadable")
      const msgCount = (
        db.prepare("SELECT COUNT(*) as n FROM messages WHERE session_id = ?").get("codex:unreadable-test") as {
          n: number
        }
      ).n
      expect(msgCount).toBe(3) // rows kept!
    })
  })

  describe("Ambiguous Copies (CTO C1 & E2)", () => {
    test("indexes ambiguous copies under distinct keys with 64 hex hash", async () => {
      const hash1 = createHash("sha256").update("/fake/copy1.jsonl").digest("hex")
      const hash2 = createHash("sha256").update("/fake/copy2.jsonl").digest("hex")
      const key1 = `codex:amb-123@${hash1}`
      const key2 = `codex:amb-123@${hash2}`

      const mock = makeMockAg(`
const args = process.argv.slice(2)
if (args.includes("list")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "amb-123",
    canonicalPath: "/fake/copy1.jsonl",
    copies: [
      { path: "/fake/copy1.jsonl", account: "acc1", sizeBytes: 100, mtimeMs: 1000, lastEventAtMs: null },
      { path: "/fake/copy2.jsonl", account: "acc2", sizeBytes: 100, mtimeMs: 1000, lastEventAtMs: null }
    ],
    status: "ambiguous",
    key: "codex:amb-123"
  }))
  console.log(JSON.stringify({ kind: "done", discovered: 1, ambiguous: 1 }))
} else {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "amb-123",
    sessionKey: "${key1}",
    path: "/fake/copy1.jsonl",
    keys: ["${key1}", "${key2}"],
    copies: [
      { path: "/fake/copy1.jsonl", sizeBytes: 100, decision: "ambiguous" },
      { path: "/fake/copy2.jsonl", sizeBytes: 100, decision: "ambiguous" }
    ]
  }))
  console.log(JSON.stringify({
    kind: "row",
    sessionKey: "${key1}",
    line: 1,
    role: "user",
    text: "copy 1 text",
    timestamp: null,
    recordKind: "event_msg",
    duplicateOf: null
  }))
  console.log(JSON.stringify({
    kind: "row",
    sessionKey: "${key2}",
    line: 1,
    role: "user",
    text: "copy 2 text",
    timestamp: null,
    recordKind: "event_msg",
    duplicateOf: null
  }))
  console.log(JSON.stringify({
    kind: "end",
    nativeId: "amb-123",
    keys: ["${key1}", "${key2}"],
    rows: 2,
    skipped: 0,
    status: "complete"
  }))
  console.log(JSON.stringify({ kind: "done", sessions: 1, rows: 2, errors: 0 }))
}
`)

      await indexCodexTranscripts(db, { agBin: mock })

      const sess1 = getSession(db, key1)
      const sess2 = getSession(db, key2)
      expect(sess1).toBeDefined()
      expect(sess2).toBeDefined()

      const msg1 = db.prepare("SELECT content FROM messages WHERE session_id = ?").get(key1) as { content: string }
      const msg2 = db.prepare("SELECT content FROM messages WHERE session_id = ?").get(key2) as { content: string }
      expect(msg1.content).toBe("copy 1 text")
      expect(msg2.content).toBe("copy 2 text")
    })
  })

  describe("Batching & Multi-Session Atomic Transactions", () => {
    test("passes all changed paths in ONE single invocation of ag transcript export", async () => {
      const invocationsFile = join(tempDir, "export-invocations.txt")
      const mock = makeMockAg(`
import { appendFileSync } from "node:fs"
const args = process.argv.slice(2)
if (args.includes("list")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "s1",
    canonicalPath: "/path/s1.jsonl",
    copies: [{ path: "/path/s1.jsonl", account: null, sizeBytes: 100, mtimeMs: 1000, lastEventAtMs: null }],
    status: "canonical",
    key: "codex:s1"
  }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "s2",
    canonicalPath: "/path/s2.jsonl",
    copies: [{ path: "/path/s2.jsonl", account: null, sizeBytes: 200, mtimeMs: 1000, lastEventAtMs: null }],
    status: "canonical",
    key: "codex:s2"
  }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "s3",
    canonicalPath: "/path/s3.jsonl",
    copies: [{ path: "/path/s3.jsonl", account: null, sizeBytes: 300, mtimeMs: 1000, lastEventAtMs: null }],
    status: "canonical",
    key: "codex:s3"
  }))
  console.log(JSON.stringify({ kind: "done", discovered: 3, canonical: 3 }))
} else {
  appendFileSync(${JSON.stringify(invocationsFile)}, JSON.stringify(args) + "\\n")
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  for (const id of ["s1", "s2", "s3"]) {
    console.log(JSON.stringify({
      kind: "session",
      provider: "codex",
      nativeId: id,
      sessionKey: "codex:" + id,
      path: "/path/" + id + ".jsonl",
      keys: ["codex:" + id]
    }))
    console.log(JSON.stringify({
      kind: "row",
      sessionKey: "codex:" + id,
      line: 1,
      role: "user",
      text: "hello " + id,
      timestamp: null,
      recordKind: "event_msg",
      duplicateOf: null
    }))
    console.log(JSON.stringify({
      kind: "end",
      nativeId: id,
      keys: ["codex:" + id],
      rows: 1,
      skipped: 0,
      status: "complete"
    }))
  }
  console.log(JSON.stringify({ kind: "done", sessions: 3, rows: 3, errors: 0 }))
}
`)

      const res = await indexCodexTranscripts(db, { agBin: mock })
      expect(res.sessions).toBe(3)
      expect(res.rows).toBe(3)

      const invocations = (await Bun.file(invocationsFile).text()).trim().split("\n")
      // Assert ag transcript export was spawned exactly ONCE
      expect(invocations).toHaveLength(1)
      const recordedArgs = JSON.parse(invocations[0]!) as string[]
      expect(recordedArgs).toContain("/path/s1.jsonl")
      expect(recordedArgs).toContain("/path/s2.jsonl")
      expect(recordedArgs).toContain("/path/s3.jsonl")
      expect(recordedArgs.filter((a) => a === "--path")).toHaveLength(3)
    })

    test("atomic per-session boundaries: failing session rolls back without affecting peers in stream", async () => {
      // Pre-seed s2
      db.prepare(`INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, status, size_bytes, mtime_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "codex:s2",
        "/cwd",
        "/path/s2.jsonl",
        1000,
        1000,
        1,
        "complete",
        200,
        1000,
      )
      db.prepare(`INSERT INTO messages (uuid, session_id, type, content, timestamp) VALUES (?, ?, ?, ?, ?)`).run(
        "codex:s2:1",
        "codex:s2",
        "user",
        "original s2 text",
        1000,
      )

      const mock = makeMockAg(`
const args = process.argv.slice(2)
if (args.includes("list")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "s1",
    canonicalPath: "/path/s1.jsonl",
    copies: [{ path: "/path/s1.jsonl", account: null, sizeBytes: 100, mtimeMs: 2000, lastEventAtMs: null }],
    status: "canonical",
    key: "codex:s1"
  }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "s2",
    canonicalPath: "/path/s2.jsonl",
    copies: [{ path: "/path/s2.jsonl", account: null, sizeBytes: 250, mtimeMs: 2000, lastEventAtMs: null }],
    status: "canonical",
    key: "codex:s2"
  }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "s3",
    canonicalPath: "/path/s3.jsonl",
    copies: [{ path: "/path/s3.jsonl", account: null, sizeBytes: 300, mtimeMs: 2000, lastEventAtMs: null }],
    status: "canonical",
    key: "codex:s3"
  }))
  console.log(JSON.stringify({ kind: "done", discovered: 3, canonical: 3 }))
} else {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  // s1: valid
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "s1",
    sessionKey: "codex:s1",
    path: "/path/s1.jsonl",
    keys: ["codex:s1"]
  }))
  console.log(JSON.stringify({
    kind: "row",
    sessionKey: "codex:s1",
    line: 1,
    role: "user",
    text: "s1 query",
    timestamp: null,
    recordKind: "event_msg",
    duplicateOf: null
  }))
  console.log(JSON.stringify({
    kind: "end",
    nativeId: "s1",
    keys: ["codex:s1"],
    rows: 1,
    skipped: 0,
    status: "complete"
  }))

  // s2: unreadable / bad-header in same stream
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "s2",
    sessionKey: "codex:s2",
    path: "/path/s2.jsonl",
    keys: ["codex:s2"]
  }))
  console.log(JSON.stringify({
    kind: "end",
    nativeId: "s2",
    keys: ["codex:s2"],
    rows: 0,
    skipped: 0,
    status: "bad-header"
  }))

  // s3: valid
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "s3",
    sessionKey: "codex:s3",
    path: "/path/s3.jsonl",
    keys: ["codex:s3"]
  }))
  console.log(JSON.stringify({
    kind: "row",
    sessionKey: "codex:s3",
    line: 1,
    role: "user",
    text: "s3 query",
    timestamp: null,
    recordKind: "event_msg",
    duplicateOf: null
  }))
  console.log(JSON.stringify({
    kind: "end",
    nativeId: "s3",
    keys: ["codex:s3"],
    rows: 1,
    skipped: 0,
    status: "complete"
  }))
  console.log(JSON.stringify({ kind: "done", sessions: 2, rows: 2, unreadable: 1, errors: 0 }))
}
`)

      const res = await indexCodexTranscripts(db, { agBin: mock })
      expect(res.sessions).toBe(2)
      expect(res.rows).toBe(2)
      expect(res.unreadable).toBe(1)

      // s1 and s3 committed cleanly
      expect(getSession(db, "codex:s1")?.status).toBe("complete")
      expect(getSession(db, "codex:s3")?.status).toBe("complete")

      // s2 marked stale-bad-header, existing messages preserved
      const s2 = getSession(db, "codex:s2")
      expect(s2?.status).toBe("stale-bad-header")
      const s2Msg = db.prepare("SELECT content FROM messages WHERE session_id = ?").get("codex:s2") as {
        content: string
      }
      expect(s2Msg.content).toBe("original s2 text")
    })
  })

  describe("Growth, Skip Keys & Full History", () => {
    test("session growth updates message count and ingests new messages", async () => {
      // First version with 2 messages
      const mockV1 = makeMockAg(`
const args = process.argv.slice(2)
if (args.includes("list")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "grow-test",
    canonicalPath: "/path/grow.jsonl",
    copies: [{ path: "/path/grow.jsonl", account: null, sizeBytes: 200, mtimeMs: 1000, lastEventAtMs: 1000 }],
    status: "canonical",
    key: "codex:grow-test"
  }))
  console.log(JSON.stringify({ kind: "done", discovered: 1, canonical: 1 }))
} else {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "grow-test",
    sessionKey: "codex:grow-test",
    path: "/path/grow.jsonl",
    sizeBytes: 200,
    mtimeMs: 1000,
    lastEventAtMs: 1000,
    keys: ["codex:grow-test"]
  }))
  console.log(JSON.stringify({
    kind: "row",
    sessionKey: "codex:grow-test",
    line: 1,
    role: "user",
    text: "m1",
    timestamp: null,
    recordKind: "event_msg",
    duplicateOf: null
  }))
  console.log(JSON.stringify({
    kind: "row",
    sessionKey: "codex:grow-test",
    line: 2,
    role: "assistant",
    text: "m2",
    timestamp: null,
    recordKind: "response_item",
    duplicateOf: null
  }))
  console.log(JSON.stringify({
    kind: "end",
    nativeId: "grow-test",
    keys: ["codex:grow-test"],
    rows: 2,
    skipped: 0,
    status: "complete"
  }))
  console.log(JSON.stringify({ kind: "done", sessions: 1, rows: 2, errors: 0 }))
}
`)

      await indexCodexTranscripts(db, { agBin: mockV1 })
      expect(getSession(db, "codex:grow-test")?.message_count).toBe(2)

      // Second version grown to 4 messages with new size/mtime
      const mockV2 = makeMockAg(`
const args = process.argv.slice(2)
if (args.includes("list")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "grow-test",
    canonicalPath: "/path/grow.jsonl",
    copies: [{ path: "/path/grow.jsonl", account: null, sizeBytes: 400, mtimeMs: 2000, lastEventAtMs: 2000 }],
    status: "canonical",
    key: "codex:grow-test"
  }))
  console.log(JSON.stringify({ kind: "done", discovered: 1, canonical: 1 }))
} else {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "grow-test",
    sessionKey: "codex:grow-test",
    path: "/path/grow.jsonl",
    sizeBytes: 400,
    mtimeMs: 2000,
    lastEventAtMs: 2000,
    keys: ["codex:grow-test"]
  }))
  for (let i = 1; i <= 4; i++) {
    console.log(JSON.stringify({
      kind: "row",
      sessionKey: "codex:grow-test",
      line: i,
      role: i % 2 === 1 ? "user" : "assistant",
      text: "grown m" + i,
      timestamp: null,
      recordKind: "event_msg",
      duplicateOf: null
    }))
  }
  console.log(JSON.stringify({
    kind: "end",
    nativeId: "grow-test",
    keys: ["codex:grow-test"],
    rows: 4,
    skipped: 0,
    status: "complete"
  }))
  console.log(JSON.stringify({ kind: "done", sessions: 1, rows: 4, errors: 0 }))
}
`)

      const res = await indexCodexTranscripts(db, { agBin: mockV2 })
      expect(res.sessions).toBe(1)
      expect(res.rows).toBe(4)
      const updated = getSession(db, "codex:grow-test")
      expect(updated?.message_count).toBe(4)
      expect(updated?.size_bytes).toBe(400)
      expect(updated?.mtime_ms).toBe(2000)

      const msgs = db
        .prepare("SELECT content FROM messages WHERE session_id = ? ORDER BY uuid")
        .all("codex:grow-test") as { content: string }[]
      expect(msgs).toHaveLength(4)
      expect(msgs[3]!.content).toBe("grown m4")
    })
  })

  describe("Chief Review Correction 1: Top-Level Clearing & Targeted Force", () => {
    test("throws fail-loud error if --force is used without explicit --path", async () => {
      await expect(rebuildIndex(db, { force: true, skipCodex: true })).rejects.toThrow(
        "--force is only permitted when an explicit --path is specified",
      )
    })

    test("targeted force preserves existing sessions and does not wipe the database", async () => {
      // Seed prior session A in DB
      upsertSession(db, "codex:prior-sess-a", "/prior/cwd", "/prior/sess-a.jsonl", 1000, 1000, 2, null, {
        status: "complete",
      })
      insertMessage(db, "codex:prior-sess-a:1", "codex:prior-sess-a", "user", "prior msg 1", null, null, 1000)
      insertMessage(db, "codex:prior-sess-a:2", "codex:prior-sess-a", "assistant", "prior msg 2", null, null, 1000)

      const targetPath = join(tempDir, "target-sess-b.jsonl")
      writeFileSync(targetPath, '{"type":"session_meta"}\n')

      const mock = makeMockAg(`
console.log(JSON.stringify({ kind: "schema", version: 1 }))
console.log(JSON.stringify({
  kind: "session",
  provider: "codex",
  nativeId: "sess-b",
  sessionKey: "codex:sess-b",
  path: ${JSON.stringify(targetPath)},
  keys: ["codex:sess-b"]
}))
console.log(JSON.stringify({
  kind: "row",
  sessionKey: "codex:sess-b",
  line: 1,
  role: "user",
  text: "target msg 1",
  timestamp: null,
  recordKind: "event_msg",
  duplicateOf: null
}))
console.log(JSON.stringify({
  kind: "end",
  nativeId: "sess-b",
  keys: ["codex:sess-b"],
  rows: 1,
  skipped: 0,
  status: "complete"
}))
console.log(JSON.stringify({ kind: "done", sessions: 1, rows: 1, errors: 0 }))
`)

      const res = await rebuildIndex(db, {
        path: targetPath,
        force: true,
        agBin: mock,
      })

      expect(res.codexSessions).toBe(1)
      // Prior session A must survive intact!
      const priorSess = getSession(db, "codex:prior-sess-a")
      expect(priorSess).toBeDefined()
      expect(priorSess?.message_count).toBe(2)
      const priorMsgs = db.prepare("SELECT * FROM messages WHERE session_id = ?").all("codex:prior-sess-a")
      expect(priorMsgs).toHaveLength(2)

      // Target session B was indexed
      const targetSess = getSession(db, "codex:sess-b")
      expect(targetSess).toBeDefined()
      expect(targetSess?.message_count).toBe(1)
    })

    test("arbitrary path without .codex or rollout- heuristic is exported and indexed", async () => {
      const arbitraryPath = join(tempDir, "custom-name-no-prefix.jsonl")
      writeFileSync(arbitraryPath, '{"type":"session_meta"}\n')

      const invocationLog = join(tempDir, "arbitrary-invocations.txt")
      const mock = makeMockAg(`
import { appendFileSync } from "node:fs"
appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify(process.argv.slice(2)) + "\\n")
console.log(JSON.stringify({ kind: "schema", version: 1 }))
console.log(JSON.stringify({
  kind: "session",
  provider: "codex",
  nativeId: "custom-native-id",
  sessionKey: "codex:custom-native-id",
  path: ${JSON.stringify(arbitraryPath)},
  keys: ["codex:custom-native-id"]
}))
console.log(JSON.stringify({
  kind: "row",
  sessionKey: "codex:custom-native-id",
  line: 1,
  role: "user",
  text: "custom text",
  timestamp: null,
  recordKind: "event_msg",
  duplicateOf: null
}))
console.log(JSON.stringify({
  kind: "end",
  nativeId: "custom-native-id",
  keys: ["codex:custom-native-id"],
  rows: 1,
  skipped: 0,
  status: "complete"
}))
console.log(JSON.stringify({ kind: "done", sessions: 1, rows: 1, errors: 0 }))
`)

      const res = await rebuildIndex(db, {
        path: arbitraryPath,
        agBin: mock,
      })

      expect(res.codexSessions).toBe(1)
      const sess = getSession(db, "codex:custom-native-id")
      expect(sess).toBeDefined()
      expect(sess?.message_count).toBe(1)
    })
  })

  describe("Chief Review Correction 2: Real Copy Metadata & Keys Without SHA-256", () => {
    test("consumes real copy metadata and keys directly without SHA-256 rederivation", async () => {
      const mock = makeMockAg(`
const args = process.argv.slice(2)
if (args.includes("list")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "meta-test",
    canonicalPath: "/path/meta.jsonl",
    copies: [{
      path: "/path/meta.jsonl",
      account: "test@example.com",
      sizeBytes: 12345,
      mtimeMs: 1726000000000,
      lastEventAtMs: 1726000050000,
      decision: "canonical",
      key: "codex:meta-test"
    }],
    status: "canonical",
    key: "codex:meta-test"
  }))
  console.log(JSON.stringify({ kind: "done", discovered: 1, canonical: 1 }))
} else {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "meta-test",
    sessionKey: "codex:meta-test",
    path: "/path/meta.jsonl",
    sizeBytes: 12345,
    mtimeMs: 1726000000000,
    lastEventAtMs: 1726000050000,
    keys: ["codex:meta-test"],
    copies: [{
      path: "/path/meta.jsonl",
      account: "test@example.com",
      sizeBytes: 12345,
      mtimeMs: 1726000000000,
      lastEventAtMs: 1726000050000,
      decision: "canonical",
      key: "codex:meta-test"
    }]
  }))
  console.log(JSON.stringify({
    kind: "row",
    sessionKey: "codex:meta-test",
    line: 1,
    role: "user",
    text: "meta msg",
    timestamp: null,
    recordKind: "event_msg",
    duplicateOf: null
  }))
  console.log(JSON.stringify({
    kind: "end",
    nativeId: "meta-test",
    keys: ["codex:meta-test"],
    rows: 1,
    skipped: 0,
    status: "complete"
  }))
  console.log(JSON.stringify({ kind: "done", sessions: 1, rows: 1, errors: 0 }))
}
`)

      const pass1 = await indexCodexTranscripts(db, { agBin: mock })
      expect(pass1.sessions).toBe(1)
      const sess = getSession(db, "codex:meta-test")
      expect(sess?.size_bytes).toBe(12345)
      expect(sess?.mtime_ms).toBe(1726000000000)
      expect(sess?.last_event_at_ms).toBe(1726000050000)

      // Second pass: unchanged metadata skips export
      const pass2 = await indexCodexTranscripts(db, { agBin: mock })
      expect(pass2.skipped).toBe(1)
      expect(pass2.sessions).toBe(0)
    })
  })

  describe("Chief Review Correction 3: 180-Day Index Window", () => {
    test("sessions between 30 and 180 days old are preserved across incremental prune", () => {
      const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000
      const twoHundredDaysAgo = Date.now() - 200 * 24 * 60 * 60 * 1000

      upsertSession(db, "codex:sess-60d", "/p", "/sess-60d.jsonl", sixtyDaysAgo, sixtyDaysAgo, 1)
      upsertSession(db, "codex:sess-200d", "/p", "/sess-200d.jsonl", twoHundredDaysAgo, twoHundredDaysAgo, 1)

      const cutoffTime = Date.now() - INDEX_WINDOW_MS
      pruneOldSessions(db, cutoffTime)

      // 60-day-old session must survive
      expect(getSession(db, "codex:sess-60d")).toBeDefined()
      // 200-day-old session must be pruned
      expect(getSession(db, "codex:sess-200d")).toBeNull()
    })
  })

  describe("Chief Review Correction 4: Duplicate Provenance & Search Semantics", () => {
    test("representation pair collapses to 1 search hit while retaining both physical rows and naming duplicate line", () => {
      const sessId = "codex:dup-provenance-test"
      upsertSession(db, sessId, "/test/path", "/test/dup.jsonl", 1000, 1000, 2)

      // Canonical row (e.g. from response_item) at line 10
      insertMessage(
        db,
        `${sessId}:10`,
        sessId,
        "user",
        "quantum superposition query",
        null,
        null,
        1000,
        null,
        10,
      )
      // Duplicate row (e.g. from event_msg) at line 11 pointing to line 10
      insertMessage(
        db,
        `${sessId}:11`,
        sessId,
        "user",
        "quantum superposition query",
        null,
        null,
        1000,
        10,
        11,
      )

      // Both physical rows exist in messages table
      const rows = db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY line").all(sessId) as {
        line: number
        duplicate_of: number | null
      }[]
      expect(rows).toHaveLength(2)
      expect(rows[0]!.line).toBe(10)
      expect(rows[0]!.duplicate_of).toBeNull()
      expect(rows[1]!.line).toBe(11)
      expect(rows[1]!.duplicate_of).toBe(10)

      // Search returns 1 hit for line 10 with duplicate_line: 11
      const searchRes = ftsSearchWithSnippet(db, "quantum superposition")
      expect(searchRes.results).toHaveLength(1)
      const hit = searchRes.results[0]!
      expect(hit.line).toBe(10)
      expect((hit as unknown as { duplicate_line: number }).duplicate_line).toBe(11)
    })

    test("repeated utterances across turn/tool boundaries remain distinct search hits", () => {
      const sessId = "codex:repeated-turns-test"
      upsertSession(db, sessId, "/test/path", "/test/turns.jsonl", 1000, 1000, 2)

      // Turn 1 utterance
      insertMessage(
        db,
        `${sessId}:10`,
        sessId,
        "user",
        "recurrent deployment trigger",
        null,
        null,
        1000,
        null,
        10,
      )
      // Turn 2 utterance (after tool/agent events) - duplicate_of is null
      insertMessage(
        db,
        `${sessId}:30`,
        sessId,
        "user",
        "recurrent deployment trigger",
        null,
        null,
        2000,
        null,
        30,
      )

      const searchRes = ftsSearchWithSnippet(db, "recurrent deployment trigger")
      expect(searchRes.results).toHaveLength(2)
    })
  })

  describe("Chief Review Correction 5: Reason-Coded Failures & Status Reporting", () => {
    test("ingests wire skipped, unreadable, and error records with reason breakdown", async () => {
      const mock = makeMockAg(`
const args = process.argv.slice(2)
if (args.includes("list")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "reason-test",
    canonicalPath: "/path/reason.jsonl",
    copies: [{ path: "/path/reason.jsonl", account: null, sizeBytes: 100, mtimeMs: 1000, lastEventAtMs: null, decision: "canonical", key: "codex:reason-test" }],
    status: "canonical",
    key: "codex:reason-test"
  }))
  console.log(JSON.stringify({ kind: "done", discovered: 1, canonical: 1 }))
} else {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "reason-test",
    sessionKey: "codex:reason-test",
    path: "/path/reason.jsonl",
    keys: ["codex:reason-test"]
  }))
  console.log(JSON.stringify({ kind: "skipped", line: 5, reason: "no-text", path: "/path/reason.jsonl" }))
  console.log(JSON.stringify({ kind: "unreadable", reason: "bad-decompression", path: "/path/unreadable.jsonl" }))
  console.log(JSON.stringify({ kind: "error", message: "network-timeout", path: "/path/error.jsonl" }))
  console.log(JSON.stringify({
    kind: "end",
    nativeId: "reason-test",
    keys: ["codex:reason-test"],
    rows: 0,
    skipped: 1,
    status: "complete"
  }))
  console.log(JSON.stringify({ kind: "done", sessions: 1, rows: 0, errors: 1 }))
}
`)

      const res = await indexCodexTranscripts(db, { agBin: mock })
      expect(res.failures).toHaveLength(3)
      expect(res.reasonCounts["no-text"]).toBe(1)
      expect(res.reasonCounts["bad-decompression"]).toBe(1)
      expect(res.reasonCounts["network-timeout"]).toBe(1)
    })

    test("safeRollback throws loud critical error if rollback fails", () => {
      const mockDb = {
        run: (sql: string) => {
          if (sql === "ROLLBACK") throw new Error("database is locked")
        },
      } as unknown as Database

      expect(() => safeRollback(mockDb)).toThrow("CRITICAL: Database transaction rollback failed: database is locked")
    })
  })

  describe("Chief Review Correction 6: Streaming Row Inserts & Bounded Memory", () => {
    test("rollback on shrink completely undoes streamed row inserts and restores prior messages", async () => {
      // Seed prior session with 3 messages
      upsertSession(db, "codex:stream-shrink", "/p", "/stream.jsonl", 1000, 1000, 3, null, { status: "complete" })
      for (let i = 1; i <= 3; i++) {
        insertMessage(db, `codex:stream-shrink:${i}`, "codex:stream-shrink", "user", `orig msg ${i}`, null, null, 1000)
      }

      const mockShrunk = makeMockAg(`
const args = process.argv.slice(2)
if (args.includes("list")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "stream-shrink",
    canonicalPath: "/path/stream.jsonl",
    copies: [{ path: "/path/stream.jsonl", account: null, sizeBytes: 50, mtimeMs: 2000, lastEventAtMs: null, decision: "canonical", key: "codex:stream-shrink" }],
    status: "canonical",
    key: "codex:stream-shrink"
  }))
  console.log(JSON.stringify({ kind: "done", discovered: 1, canonical: 1 }))
} else {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "stream-shrink",
    sessionKey: "codex:stream-shrink",
    path: "/path/stream.jsonl",
    keys: ["codex:stream-shrink"]
  }))
  // Stream only 1 row (shrunk from 3)
  console.log(JSON.stringify({
    kind: "row",
    sessionKey: "codex:stream-shrink",
    line: 1,
    role: "user",
    text: "shrunk msg",
    timestamp: null,
    recordKind: "event_msg",
    duplicateOf: null
  }))
  console.log(JSON.stringify({
    kind: "end",
    nativeId: "stream-shrink",
    keys: ["codex:stream-shrink"],
    rows: 1,
    skipped: 0,
    status: "complete"
  }))
  console.log(JSON.stringify({ kind: "done", sessions: 1, rows: 1, errors: 0 }))
}
`)

      await indexCodexTranscripts(db, { agBin: mockShrunk })

      // Status marked shrunk
      const sess = getSession(db, "codex:stream-shrink")
      expect(sess?.status).toBe("shrunk")
      // Prior 3 messages must remain in database intact
      const msgs = db.prepare("SELECT * FROM messages WHERE session_id = ?").all("codex:stream-shrink")
      expect(msgs).toHaveLength(3)
    })
  })
})
