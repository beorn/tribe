import { Database } from "bun:sqlite"
import { writeFileSync, mkdtempSync, chmodSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { initSchema } from "../../src/history/db-schema.ts"
import { getSession } from "../../src/history/db-queries.ts"
import { resolveAgBin, fetchCodexCatalog, indexCodexTranscripts } from "../../src/history/codex-indexer.ts"
import { rebuildIndex } from "../../src/history/indexer.ts"

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
})
