import { Database } from "bun:sqlite"
import { writeFileSync, mkdtempSync, chmodSync, mkdirSync, utimesSync, existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir, homedir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { initSchema } from "../../src/history/db-schema.ts"
import { getSession, upsertSession, insertMessage, ftsSearchWithSnippet, getSessionStatus } from "../../src/history/db-queries.ts"
import { resolveAgBin, fetchCodexCatalog, indexCodexTranscripts, safeRollback } from "../../src/history/codex-indexer.ts"
import { rebuildIndex, INDEX_WINDOW_DAYS, INDEX_WINDOW_MS, pruneOldSessions, isRecallIgnored, resetIgnoreCache } from "../../src/history/indexer.ts"
import { getPersistedFailedSessions } from "../../src/lib/status.ts"
import { cmdIndex } from "../../src/lib/sessions.ts"

describe("Codex Transcript Indexer", () => {
  let tempDir: string
  let db: Database
  let origClaudeDir: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "recall-codex-test-"))
    origClaudeDir = process.env.CLAUDE_DIR
    const testClaudeDir = join(tempDir, "isolated-claude")
    mkdirSync(join(testClaudeDir, "projects"), { recursive: true })
    process.env.CLAUDE_DIR = testClaudeDir
    db = new Database(":memory:")
    initSchema(db)
  })

  afterEach(() => {
    resetIgnoreCache()
    if (origClaudeDir !== undefined) {
      process.env.CLAUDE_DIR = origClaudeDir
    } else {
      delete process.env.CLAUDE_DIR
    }
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

  function makeFixtureProducer(isolatedHome?: string): string {
    const homeVal = isolatedHome ?? tempDir
    const tsPath = join(tempDir, `fixture-ag-${Math.random().toString(36).slice(2)}.ts`)
    const shPath = join(tempDir, `fixture-ag-${Math.random().toString(36).slice(2)}.sh`)
    const content = `import * as fs from "node:fs"
import * as path from "node:path"

const homeDir = ${JSON.stringify(homeVal)}
const args = process.argv.slice(2)
const command = args[0]
const subcommand = args[1]

function findFiles(dir: string, ext: string): string[] {
  const results: string[] = []
  if (!fs.existsSync(dir)) return results
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...findFiles(full, ext))
      } else if (entry.isFile() && entry.name.endsWith(ext)) {
        results.push(full)
      }
    }
  } catch {}
  return results
}

interface DiscoveredSession {
  path: string
  nativeId: string
  account: string | null
  key: string
  sizeBytes: number
  mtimeMs: number
  cwd: string | null
  createdAt: string | null
}

function discoverSessions(): DiscoveredSession[] {
  const allJsonl = findFiles(homeDir, ".jsonl")
  const results: DiscoveredSession[] = []
  for (const f of allJsonl) {
    try {
      const st = fs.statSync(f)
      const content = fs.readFileSync(f, "utf8")
      const lines = content.split("\\n")
      const firstLine = lines.find((l) => l.trim().length > 0)
      if (!firstLine) continue
      const parsed = JSON.parse(firstLine)
      if (parsed.type !== "session_meta" || !parsed.payload?.id) continue
      const nativeId = parsed.payload.id
      const cwd = parsed.payload.cwd ?? null
      const createdAt = parsed.payload.timestamp ?? null
      let account: string | null = null
      const profMatch = f.match(/\\/profiles\\/codex\\/([^\\/]+)\\//)
      if (profMatch) {
        account = profMatch[1]!
      }
      const key = account ? \`codex:\${account}:\${nativeId}\` : \`codex:\${nativeId}\`
      results.push({
        path: f,
        nativeId,
        account,
        key,
        sizeBytes: st.size,
        mtimeMs: Math.round(st.mtimeMs),
        cwd,
        createdAt,
      })
    } catch {}
  }
  return results
}

if (command === "transcript" && subcommand === "list") {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  const sessions = discoverSessions()
  const byId = new Map<string, DiscoveredSession[]>()
  for (const s of sessions) {
    const list = byId.get(s.nativeId) ?? []
    list.push(s)
    byId.set(s.nativeId, list)
  }

  let canonicalCount = 0
  let ambiguousCount = 0

  for (const [nativeId, copies] of byId.entries()) {
    if (copies.length === 1) {
      canonicalCount++
      const copy = copies[0]!
      console.log(
        JSON.stringify({
          kind: "session",
          provider: "codex",
          nativeId,
          canonicalPath: copy.path,
          copies: [
            {
              path: copy.path,
              account: copy.account,
              sizeBytes: copy.sizeBytes,
              mtimeMs: copy.mtimeMs,
              lastEventAtMs: null,
              decision: "canonical",
              key: copy.key,
            },
          ],
          status: "canonical",
          key: copy.key,
        }),
      )
    } else {
      ambiguousCount++
      console.log(
        JSON.stringify({
          kind: "session",
          provider: "codex",
          nativeId,
          canonicalPath: null,
          copies: copies.map((c) => ({
            path: c.path,
            account: c.account,
            sizeBytes: c.sizeBytes,
            mtimeMs: c.mtimeMs,
            lastEventAtMs: null,
            decision: "ambiguous",
            key: c.key,
          })),
          status: "ambiguous",
          key: null,
        }),
      )
    }
  }

  console.log(
    JSON.stringify({
      kind: "done",
      discovered: sessions.length,
      canonical: canonicalCount,
      ambiguous: ambiguousCount,
      stale: 0,
      invalid: 0,
    }),
  )
  process.exit(0)
}

if (command === "transcript" && subcommand === "export") {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))

  let targetPaths: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--path" && args[i + 1]) {
      targetPaths.push(path.resolve(args[i + 1]!))
      i++
    }
  }
  const pathsIdx = args.indexOf("--paths")
  if (pathsIdx !== -1) {
    let i = pathsIdx + 1
    while (i < args.length && !args[i]!.startsWith("-")) {
      targetPaths.push(path.resolve(args[i]!))
      i++
    }
  }

  let sessions = discoverSessions()
  if (targetPaths.length > 0) {
    sessions = sessions.filter((s) => targetPaths.includes(path.resolve(s.path)))
    for (const tp of targetPaths) {
      if (!sessions.some((s) => path.resolve(s.path) === tp)) {
        try {
          const st = fs.statSync(tp)
          const content = fs.readFileSync(tp, "utf8")
          const lines = content.split("\\n")
          const firstLine = lines.find((l) => l.trim().length > 0)
          if (firstLine) {
            const parsed = JSON.parse(firstLine)
            if (parsed.type === "session_meta" && parsed.payload?.id) {
              const nativeId = parsed.payload.id
              const key = \`codex:\${nativeId}\`
              sessions.push({
                path: tp,
                nativeId,
                account: null,
                key,
                sizeBytes: st.size,
                mtimeMs: Math.round(st.mtimeMs),
                cwd: parsed.payload.cwd ?? null,
                createdAt: parsed.payload.timestamp ?? null,
              })
            }
          }
        } catch {}
      }
    }
  }

  const byId = new Map<string, DiscoveredSession[]>()
  for (const s of sessions) {
    const list = byId.get(s.nativeId) ?? []
    list.push(s)
    byId.set(s.nativeId, list)
  }

  let totalExportedRows = 0
  let sessionExportCount = 0

  for (const [nativeId, copies] of byId.entries()) {
    sessionExportCount++
    const isAmbiguous = copies.length > 1
    const stableKeys = copies.map((c) => c.key)
    const sessionKey = isAmbiguous ? null : copies[0]!.key
    const primary = copies[0]!

    console.log(
      JSON.stringify({
        kind: "session",
        provider: "codex",
        nativeId,
        sessionKey,
        key: sessionKey,
        keys: stableKeys,
        path: primary.path,
        home: homeDir,
        account: primary.account,
        cwd: primary.cwd,
        createdAt: primary.createdAt,
        sizeBytes: primary.sizeBytes,
        mtimeMs: primary.mtimeMs,
        copies: copies.map((c) => ({
          path: c.path,
          account: c.account,
          sizeBytes: c.sizeBytes,
          mtimeMs: c.mtimeMs,
          lastEventAtMs: null,
          decision: isAmbiguous ? "ambiguous" : "canonical",
          key: c.key,
        })),
      }),
    )

    let sessionRows = 0
    for (const copy of copies) {
      try {
        const content = fs.readFileSync(copy.path, "utf8")
        const lines = content.split("\\n")
        let lineNumber = 0
        for (const line of lines) {
          lineNumber++
          const trimmed = line.trim()
          if (!trimmed) continue
          const parsed = JSON.parse(trimmed)
          if (parsed.type === "event_msg") {
            const payload = parsed.payload
            if (payload?.type === "user_message" && typeof payload.message === "string") {
              sessionRows++
              console.log(
                JSON.stringify({
                  kind: "row",
                  sessionKey: copy.key,
                  line: lineNumber,
                  role: "user",
                  text: payload.message,
                  timestamp: parsed.timestamp ?? primary.createdAt,
                  recordKind: "event_msg",
                  duplicateOf: null,
                }),
              )
            }
          } else if (parsed.type === "response_item") {
            const payload = parsed.payload
            if (payload?.type === "message") {
              const role = payload.role ?? "assistant"
              let text = ""
              if (Array.isArray(payload.content)) {
                for (const item of payload.content) {
                  if (item?.type === "text" && item.text) {
                    text += item.text
                  }
                }
              } else if (typeof payload.content === "string") {
                text = payload.content
              }
              if (text) {
                sessionRows++
                console.log(
                  JSON.stringify({
                    kind: "row",
                    sessionKey: copy.key,
                    line: lineNumber,
                    role,
                    text,
                    timestamp: parsed.timestamp ?? primary.createdAt,
                    recordKind: "response_item",
                    duplicateOf: null,
                  }),
                )
              }
            }
          }
        }
      } catch {}
    }

    totalExportedRows += sessionRows
    console.log(
      JSON.stringify({
        kind: "end",
        nativeId,
        keys: stableKeys,
        rows: sessionRows,
        skipped: 0,
        status: "complete",
      }),
    )
  }

  console.log(
    JSON.stringify({
      kind: "done",
      sessions: sessionExportCount,
      rows: totalExportedRows,
      errors: 0,
    }),
  )
  process.exit(0)
}

process.exit(0)
`
    writeFileSync(tsPath, content)
    writeFileSync(
      shPath,
      `#!/bin/sh
export HOME="${homeVal}"
exec bun "${tsPath}" "$@"
`,
    )
    chmodSync(shPath, 0o755)
    return shPath
  }

  function makeRealAg(isolatedHome?: string): string {
    const realAgEntry = process.env.AG_BIN || join(__dirname, "../../../../../../ag/packages/ag-cli/src/bin/ag.ts")
    if (existsSync(realAgEntry) && process.env.USE_FIXTURE_PRODUCER !== "1") {
      const scriptPath = join(tempDir, `real-ag-${Math.random().toString(36).slice(2)}.sh`)
      const homeVal = isolatedHome ?? tempDir
      writeFileSync(
        scriptPath,
        `#!/bin/sh
export HOME="${homeVal}"
exec bun "${realAgEntry}" "$@"
`,
      )
      chmodSync(scriptPath, 0o755)
      return scriptPath
    }
    return makeFixtureProducer(isolatedHome)
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

  describe("Chief Review 2106: Correction 1 - Public Rebuild Preserves Good Data", () => {
    test("public rebuildIndex preserves prior rows when Ag readiness preflight fails", async () => {
      upsertSession(db, "prior-session-1", "/hh", "prior.jsonl", Date.now() - 1000, Date.now(), 1)
      insertMessage(db, "uuid-1", "prior-session-1", "user", "Prior good message", null, null, Date.now())

      const brokenAg = join(tempDir, "broken-ag-nonexistent")
      await expect(rebuildIndex(db, { agBin: brokenAg })).rejects.toThrow()

      const stored = getSession(db, "prior-session-1")
      expect(stored).toBeDefined()
      const msgs = db.prepare("SELECT * FROM messages WHERE session_id = ?").all("prior-session-1")
      expect(msgs).toHaveLength(1)
    })
  })

  describe("Chief Review 2106: Correction 2 - Real Producer Skip, Growth & Ambiguous Copies", () => {
    test("real producer two-pass skip exports 0 paths on second pass", async () => {
      const codexHome = join(tempDir, "codex-home-skip")
      const realAg = makeRealAg(codexHome)
      const sessionDir = join(codexHome, ".codex/sessions/2026/09/21")
      mkdirSync(sessionDir, { recursive: true })
      const rolloutFile = join(sessionDir, "rollout-2026-09-21T10-00-00-019fce85-test-skip.jsonl")
      writeFileSync(
        rolloutFile,
        JSON.stringify({ type: "session_meta", payload: { id: "019fce85-test-skip", cwd: "/home/work", timestamp: "2026-09-21T10:00:00.000Z" } }) + "\n" +
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Real producer message 1" } }) + "\n",
      )

      // Pass 1: explicit path indexing
      const pass1 = await indexCodexTranscripts(db, { agBin: realAg, path: rolloutFile })
      expect(pass1.sessions).toBe(1)
      expect(pass1.rows).toBe(1)
      expect(pass1.skipped).toBe(0)

      // Pass 2: catalog indexing with same unchanged file -> 0 paths exported, 1 skipped
      const pass2 = await indexCodexTranscripts(db, { agBin: realAg })
      expect(pass2.sessions).toBe(0)
      expect(pass2.rows).toBe(0)
      expect(pass2.skipped).toBe(1)
    })

    test("real producer grown file selects and updates session", async () => {
      const codexHome = join(tempDir, "codex-home-growth")
      const realAg = makeRealAg(codexHome)
      const sessionDir = join(codexHome, ".codex/sessions/2026/09/21")
      mkdirSync(sessionDir, { recursive: true })
      const rolloutFile = join(sessionDir, "rollout-2026-09-21T11-00-00-019fce85-test-grow.jsonl")
      writeFileSync(
        rolloutFile,
        JSON.stringify({ type: "session_meta", payload: { id: "019fce85-test-grow", cwd: "/home/work", timestamp: "2026-09-21T11:00:00.000Z" } }) + "\n" +
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Initial message" } }) + "\n",
      )

      const pass1 = await indexCodexTranscripts(db, { agBin: realAg })
      expect(pass1.sessions).toBe(1)
      expect(pass1.rows).toBe(1)

      // Grow file by adding a second message
      writeFileSync(
        rolloutFile,
        JSON.stringify({ type: "session_meta", payload: { id: "019fce85-test-grow", cwd: "/home/work", timestamp: "2026-09-21T11:00:00.000Z" } }) + "\n" +
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Initial message" } }) + "\n" +
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "text", text: "Grown message 2" }] } }) + "\n",
      )

      const pass2 = await indexCodexTranscripts(db, { agBin: realAg })
      expect(pass2.sessions).toBe(1)
      expect(pass2.rows).toBe(2)
      expect(pass2.skipped).toBe(0)

      const sess = getSession(db, "codex:019fce85-test-grow")
      expect(sess?.message_count).toBe(2)
    })

    test("real producer indexes genuinely ambiguous copies under distinct keys", async () => {
      const codexHome = join(tempDir, "codex-home-ambig")
      const realAg = makeRealAg(codexHome)
      mkdirSync(join(codexHome, ".codex/sessions"), { recursive: true })
      const acc1Dir = join(codexHome, ".config/ag/profiles/codex/work/sessions/2026/09/21")
      const acc2Dir = join(codexHome, ".config/ag/profiles/codex/personal/sessions/2026/09/21")
      mkdirSync(acc1Dir, { recursive: true })
      mkdirSync(acc2Dir, { recursive: true })

      const file1 = join(acc1Dir, "rollout-2026-09-21T12-00-00-019fce85-test-ambig.jsonl")
      const file2 = join(acc2Dir, "rollout-2026-09-21T12-00-00-019fce85-test-ambig.jsonl")

      const content =
        JSON.stringify({ type: "session_meta", payload: { id: "019fce85-test-ambig", cwd: "/home/work", timestamp: "2026-09-21T12:00:00.000Z" } }) + "\n" +
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Ambiguous message" } }) + "\n"
      writeFileSync(file1, content)
      writeFileSync(file2, content)
      const fixedTime = new Date("2026-09-21T12:00:00.000Z")
      utimesSync(file1, fixedTime, fixedTime)
      utimesSync(file2, fixedTime, fixedTime)

      const result = await indexCodexTranscripts(db, { agBin: realAg })
      expect(result.sessions).toBe(1)
      expect(result.ambiguous).toBe(1)

      const allSessions = db.prepare("SELECT id, status, size_bytes FROM sessions WHERE id LIKE 'codex:%'").all() as { id: string; status: string; size_bytes: number }[]
      expect(allSessions).toHaveLength(2)
      expect(allSessions[0]?.id).not.toBe(allSessions[1]?.id)
      for (const s of allSessions) {
        expect(s.status).toBe("complete")
      }
    })
  })

  describe("Chief Review 2106 / 2150: Correction 3 - 180-Day Retention & 30-Day Search Default", () => {
    test("public rebuild indexes older-than-30d native fixtures; 30d default search omits them; extended search finds them", async () => {
      const now = Date.now()
      const fortyFiveDaysAgo = now - 45 * 24 * 60 * 60 * 1000

      // Create native Claude fixture
      const claudeDir = join(tempDir, "claude-corpus")
      mkdirSync(claudeDir, { recursive: true })
      const claudeFile = join(claudeDir, "claude-45d.jsonl")
      const claudeLines = [
        JSON.stringify({ type: "user", message: { content: "Searching ancient forty-five day old topic claude" }, timestamp: new Date(fortyFiveDaysAgo).toISOString() }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Answer from forty-five days ago" }] }, timestamp: new Date(fortyFiveDaysAgo + 1000).toISOString() }),
      ]
      writeFileSync(claudeFile, claudeLines.join("\n") + "\n", "utf8")
      utimesSync(claudeFile, new Date(fortyFiveDaysAgo), new Date(fortyFiveDaysAgo))

      // Create native Codex fixture
      const codexHome = join(tempDir, "codex-corpus")
      const sessionDir = join(codexHome, ".codex/sessions/2026/08/07")
      mkdirSync(sessionDir, { recursive: true })
      const codexFile = join(sessionDir, "rollout-2026-08-07T10-00-00-019fce85-test-45d.jsonl")
      const codexLines = [
        JSON.stringify({ type: "session_meta", payload: { id: "019fce85-test-45d", cwd: "/home/work", timestamp: new Date(fortyFiveDaysAgo).toISOString() } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Searching ancient forty-five day old topic codex" }, timestamp: new Date(fortyFiveDaysAgo).toISOString() }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "text", text: "Codex answer from forty-five days ago" }] }, timestamp: new Date(fortyFiveDaysAgo + 1000).toISOString() }),
      ]
      writeFileSync(codexFile, codexLines.join("\n") + "\n", "utf8")
      utimesSync(codexFile, new Date(fortyFiveDaysAgo), new Date(fortyFiveDaysAgo))

      const realAg = makeRealAg(codexHome)

      // Ingest via public path/indexer
      await rebuildIndex(db, { path: claudeFile, skipCodex: true })
      await rebuildIndex(db, { path: codexFile, agBin: realAg })

      // Verify both sessions and messages exist in SQLite
      const claudeSess = getSession(db, "claude-45d")
      expect(claudeSess).toBeDefined()
      expect(claudeSess?.message_count).toBeGreaterThan(0)

      const codexSess = getSession(db, "codex:019fce85-test-45d")
      expect(codexSess).toBeDefined()
      expect(codexSess?.message_count).toBeGreaterThan(0)

      // Default 30-day search window omits 45-day-old records
      const defaultSearch = ftsSearchWithSnippet(db, "forty-five", { sinceTime: now - 30 * 24 * 60 * 60 * 1000 })
      expect(defaultSearch.results).toHaveLength(0)

      // Extended search window (cutoffTime / 180 days) finds both
      const cutoffTime = now - INDEX_WINDOW_MS
      const extendedSearch = ftsSearchWithSnippet(db, "forty-five", { sinceTime: cutoffTime })
      expect(extendedSearch.results.length).toBeGreaterThanOrEqual(2)

      // Actual public incremental rebuild with native fixtures preserves them across prune
      await rebuildIndex(db, { incremental: true, agBin: realAg })

      const claudeSessAfter = getSession(db, "claude-45d")
      expect(claudeSessAfter).toBeDefined()
      expect(claudeSessAfter?.message_count).toBeGreaterThan(0)

      const codexSessAfter = getSession(db, "codex:019fce85-test-45d")
      expect(codexSessAfter).toBeDefined()
      expect(codexSessAfter?.message_count).toBeGreaterThan(0)

      const defaultSearchAfter = ftsSearchWithSnippet(db, "forty-five", { sinceTime: now - 30 * 24 * 60 * 60 * 1000 })
      expect(defaultSearchAfter.results).toHaveLength(0)

      const extendedSearchAfter = ftsSearchWithSnippet(db, "forty-five", { sinceTime: cutoffTime })
      expect(extendedSearchAfter.results.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe("Chief Review 2106: Correction 4 - Public Search Output Line Provenance", () => {
    test("public search output formats line and duplicateLine while keeping unmarked repeated utterance distinct", () => {
      const sessionId = "search-line-provenance"
      upsertSession(db, sessionId, "/hh", "session.jsonl", Date.now(), Date.now(), 3)

      insertMessage(db, "m1", sessionId, "user", "exact match query", null, null, Date.now(), null, 1)
      insertMessage(db, "m2", sessionId, "user", "exact match query", null, null, Date.now(), 1, 2)
      insertMessage(db, "m3", sessionId, "user", "exact match query", null, null, Date.now(), null, 5)

      const searchRes = ftsSearchWithSnippet(db, "exact match query")
      expect(searchRes.results).toHaveLength(2)

      const firstHit = searchRes.results.find((r) => r.line === 1)
      expect(firstHit).toBeDefined()
      expect(firstHit?.line).toBe(1)
      expect((firstHit as { duplicate_line?: number | null }).duplicate_line).toBe(2)

      const secondHit = searchRes.results.find((r) => r.line === 5)
      expect(secondHit).toBeDefined()
      expect(secondHit?.line).toBe(5)
      expect((secondHit as { duplicate_line?: number | null }).duplicate_line).toBeNull()
    })
  })

  describe("Chief Review 2150: Corrections 1 & 2 - Prior Good Data Preservation & Shrink Prune Safety", () => {
    test("public rebuild preserves prior good Claude session when subsequent read fails or is malformed after valid first record", async () => {
      const claudeDir = join(tempDir, "claude-preservation")
      mkdirSync(claudeDir, { recursive: true })
      const sessionPath = join(claudeDir, "session-preserve.jsonl")

      // Write initial valid transcript
      const lines = [
        JSON.stringify({ type: "user", message: { content: "Original preserved query" } }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Original preserved response" }] } }),
      ]
      writeFileSync(sessionPath, lines.join("\n") + "\n", "utf8")

      // Initial public rebuild
      await rebuildIndex(db, { path: sessionPath, skipCodex: true })
      const initialSess = getSession(db, "session-preserve")
      expect(initialSess).toBeDefined()
      expect(initialSess?.message_count).toBe(2)
      expect(initialSess?.status).toBe("complete")

      // Corrupt the file: valid first user line followed by malformed second line!
      const corruptLines = [
        JSON.stringify({ type: "user", message: { content: "First valid user prompt in v2" } }),
        "NOT_VALID_JSON_AT_ALL\n\n{{{corrupt",
      ]
      writeFileSync(sessionPath, corruptLines.join("\n") + "\n", "utf8")

      // Re-run public rebuild
      await rebuildIndex(db, { path: sessionPath, skipCodex: true })

      // Prior good data remains completely preserved in SQLite via transaction savepoint rollback!
      const preservedSess = getSession(db, "session-preserve")
      expect(preservedSess).toBeDefined()
      expect(preservedSess?.message_count).toBe(2)

      const searchRes = ftsSearchWithSnippet(db, "Original preserved query")
      expect(searchRes.results).toHaveLength(1)

      // Status and failure fields are visible
      const statusDetails = getSessionStatus(db, "session-preserve")
      expect(statusDetails?.status).toBe("stale-unreadable")
      expect(statusDetails?.failureReason).toContain("Malformed JSON in Claude transcript")

      // Persisted failures in status module returns the failed session
      const failed = getPersistedFailedSessions(db)
      expect(failed.some((f) => f.id === "session-preserve" && f.status === "stale-unreadable")).toBe(true)

      // Recovery: write valid replacement transcript with 3 messages
      const recoveryLines = [
        JSON.stringify({ type: "user", message: { content: "Recovered query 1" } }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Recovered response 1" }] } }),
        JSON.stringify({ type: "user", message: { content: "Recovered query 2" } }),
      ]
      writeFileSync(sessionPath, recoveryLines.join("\n") + "\n", "utf8")

      await rebuildIndex(db, { path: sessionPath, skipCodex: true })
      const recoveredSess = getSessionStatus(db, "session-preserve")
      expect(recoveredSess?.status).toBe("complete")
      expect(recoveredSess?.failureReason).toBeNull()
      expect(recoveredSess?.messageCount).toBe(3)

      const failedAfter = getPersistedFailedSessions(db)
      expect(failedAfter.some((f) => f.id === "session-preserve")).toBe(false)
    })

    test("public rebuild records reason-coded failure for brand new malformed Claude session and recovers cleanly", async () => {
      const claudeDir = join(tempDir, "claude-new-fail")
      mkdirSync(claudeDir, { recursive: true })
      const sessionPath = join(claudeDir, "session-new-fail.jsonl")

      // Brand new session: valid first user record followed by malformed second line
      const corruptLines = [
        JSON.stringify({ type: "user", message: { content: "Brand new user prompt" } }),
        "NOT_VALID_JSON_AT_ALL\n\n{{{corrupt",
      ]
      writeFileSync(sessionPath, corruptLines.join("\n") + "\n", "utf8")

      // Public rebuild on this brand-new path
      await rebuildIndex(db, { path: sessionPath, skipCodex: true })

      // Crucial: session row DOES exist with reason-coded failure in existing storage!
      const statusDetails = getSessionStatus(db, "session-new-fail")
      expect(statusDetails).toBeDefined()
      expect(statusDetails?.status).toBe("stale-unreadable")
      expect(statusDetails?.messageCount).toBe(0)
      expect(statusDetails?.failureReason).toContain("Malformed JSON in Claude transcript")
      expect(typeof statusDetails?.failureTime).toBe("number")

      // Appears in persisted failed sessions
      const failed = getPersistedFailedSessions(db)
      expect(failed.some((f) => f.id === "session-new-fail" && f.status === "stale-unreadable")).toBe(true)

      // Recovery: repair the file with 2 valid records
      const recoveryLines = [
        JSON.stringify({ type: "user", message: { content: "Recovered brand new query" } }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Recovered brand new response" }] } }),
      ]
      writeFileSync(sessionPath, recoveryLines.join("\n") + "\n", "utf8")

      await rebuildIndex(db, { path: sessionPath, skipCodex: true })

      const recoveredSess = getSessionStatus(db, "session-new-fail")
      expect(recoveredSess?.status).toBe("complete")
      expect(recoveredSess?.failureReason).toBeNull()
      expect(recoveredSess?.failureTime).toBeNull()
      expect(recoveredSess?.messageCount).toBe(2)

      const failedAfter = getPersistedFailedSessions(db)
      expect(failedAfter.some((f) => f.id === "session-new-fail")).toBe(false)
    })

    test("public rebuild preserves prior good Claude session on unreadable source at public entry", async () => {
      const claudeDir = join(tempDir, "claude-async-fail")
      mkdirSync(claudeDir, { recursive: true })
      const sessionPath = join(claudeDir, "session-async-fail.jsonl")

      const lines = [
        JSON.stringify({ type: "user", message: { content: "Async read fail query" } }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Async read fail response" }] } }),
      ]
      writeFileSync(sessionPath, lines.join("\n") + "\n", "utf8")

      await rebuildIndex(db, { path: sessionPath, skipCodex: true })
      const initialSess = getSession(db, "session-async-fail")
      expect(initialSess?.message_count).toBe(2)

      // Make file unreadable
      chmodSync(sessionPath, 0o000)
      try {
        await rebuildIndex(db, { path: sessionPath, skipCodex: true })
      } finally {
        chmodSync(sessionPath, 0o644)
      }

      // Prior good data remains preserved
      const preservedSess = getSession(db, "session-async-fail")
      expect(preservedSess).toBeDefined()
      expect(preservedSess?.message_count).toBe(2)
      expect(preservedSess?.status).toBe("stale-unreadable")
    })

    test("public rebuild preserves prior Codex rows when shrink is rejected without force", async () => {
      const codexHome = join(tempDir, "codex-shrink-home")
      const sessionDir = join(codexHome, ".codex/sessions/2026/09/21")
      mkdirSync(sessionDir, { recursive: true })
      const rolloutPath = join(sessionDir, "rollout-2026-09-21T12-00-00-019fce85-test-shrink.jsonl")

      // Version 1: 3 rows
      const v1Lines = [
        JSON.stringify({ type: "session_meta", payload: { id: "019fce85-test-shrink", cwd: "/home/work", timestamp: "2026-09-21T12:00:00.000Z" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Shrink test message 1" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "text", text: "Shrink test message 2" }] } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Shrink test message 3" } }),
      ]
      writeFileSync(rolloutPath, v1Lines.join("\n") + "\n", "utf8")

      const realAg = makeRealAg(codexHome)

      // Initial rebuild via full public rebuild branch
      await rebuildIndex(db, { full: true, agBin: realAg })
      const initialSess = getSession(db, "codex:019fce85-test-shrink")
      expect(initialSess?.message_count).toBe(3)
      expect(initialSess?.status).toBe("complete")

      // Version 2: truncated to 1 row (shrink)
      const v2Lines = [
        JSON.stringify({ type: "session_meta", payload: { id: "019fce85-test-shrink", cwd: "/home/work", timestamp: "2026-09-21T12:00:00.000Z" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Shrink test message 1" } }),
      ]
      writeFileSync(rolloutPath, v2Lines.join("\n") + "\n", "utf8")
      const later = new Date(Date.now() + 5000)
      utimesSync(rolloutPath, later, later)

      // Full public rebuild without force (exercises full unreferenced pruning branch)
      await rebuildIndex(db, { full: true, agBin: realAg })

      // Prior rows are PRESERVED, not pruned or deleted!
      const shrunkSess = getSession(db, "codex:019fce85-test-shrink")
      expect(shrunkSess?.status).toBe("shrunk")
      expect(shrunkSess?.message_count).toBe(3) // Prior 3 rows retained!

      // Per-session status query shows shrink details
      const statusDetails = getSessionStatus(db, "codex:019fce85-test-shrink")
      expect(statusDetails?.status).toBe("shrunk")
      expect(statusDetails?.failureReason).toContain("shrunk")
      expect(statusDetails?.shrinkOldCount).toBe(3)
      expect(statusDetails?.shrinkNewCount).toBe(1)

      // Persisted failures in status module returns shrink details
      const failed = getPersistedFailedSessions(db)
      const failedEntry = failed.find((f) => f.id === "codex:019fce85-test-shrink")
      expect(failedEntry).toBeDefined()
      expect(failedEntry?.shrink_old_count).toBe(3)
      expect(failedEntry?.shrink_new_count).toBe(1)

      // Now re-run with force: should recover and update status to complete, clearing failure fields
      await rebuildIndex(db, { path: rolloutPath, agBin: realAg, force: true })
      const forcedSess = getSessionStatus(db, "codex:019fce85-test-shrink")
      expect(forcedSess?.status).toBe("complete")
      expect(forcedSess?.messageCount).toBe(1)
      expect(forcedSess?.failureReason).toBeNull()
      expect(forcedSess?.shrinkOldCount).toBeNull()

      const failedAfter = getPersistedFailedSessions(db)
      expect(failedAfter.find((f) => f.id === "codex:019fce85-test-shrink")).toBeUndefined()
    })
  })

  describe("Chief Review 2150: Corrections 4 & 5 - Failure Contract, Committed IDs, and UTF-8 Chunk Splitting", () => {
    test("interrupted export reports committed session IDs alongside interrupted native ID", async () => {
      const mockInterruptedAg = makeMockAg(`
if (process.argv.includes("list")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "sess-1",
    sessionKey: "codex:sess-1",
    canonicalPath: "/path/sess-1.jsonl",
    sizeBytes: 100,
    mtimeMs: 1000,
    status: "canonical",
    copies: [{ path: "/path/sess-1.jsonl", sizeBytes: 100, mtimeMs: 1000, decision: "canonical", key: "codex:sess-1" }]
  }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "sess-2-interrupted",
    sessionKey: "codex:sess-2-interrupted",
    canonicalPath: "/path/sess-2.jsonl",
    sizeBytes: 100,
    mtimeMs: 1000,
    status: "canonical",
    copies: [{ path: "/path/sess-2.jsonl", sizeBytes: 100, mtimeMs: 1000, decision: "canonical", key: "codex:sess-2-interrupted" }]
  }))
  console.log(JSON.stringify({ kind: "done", homes: 1, files: 2, sessions: 2, canonical: 2, ambiguous: 0, stale: 0, invalid: 0 }))
} else if (process.argv.includes("export")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  // Session 1: succeeds
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "sess-1",
    sessionKey: "codex:sess-1",
    path: "/path/sess-1.jsonl",
    sizeBytes: 100,
    mtimeMs: 1000,
    status: "canonical"
  }))
  console.log(JSON.stringify({ kind: "row", sessionKey: "codex:sess-1", line: 1, role: "user", text: "msg 1" }))
  console.log(JSON.stringify({ kind: "end", sessionKey: "codex:sess-1", status: "complete" }))
  // Session 2: abruptly cut mid-transaction
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "sess-2-interrupted",
    sessionKey: "codex:sess-2-interrupted",
    path: "/path/sess-2.jsonl",
    sizeBytes: 100,
    mtimeMs: 1000,
    status: "canonical"
  }))
  console.log(JSON.stringify({ kind: "row", sessionKey: "codex:sess-2-interrupted", line: 1, role: "user", text: "msg 2" }))
  // Child process exits abruptly without closing end record
  process.exit(1)
}
`)

      await expect(indexCodexTranscripts(db, { agBin: mockInterruptedAg })).rejects.toThrow(/sess-2-interrupted.*committed 1 sessions \[codex:sess-1\]/)
    })

    test("nonzero producer failure includes failed path, wire reason, and timestamp", async () => {
      const mockListError = makeMockAg(`
if (process.argv.includes("list")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({ kind: "unreadable", path: "/var/unreadable-path.jsonl", reason: "permission-denied-eacces" }))
  console.error("Fatal error listing transcripts")
  process.exit(1)
}
`)

      await expect(indexCodexTranscripts(db, { agBin: mockListError })).rejects.toThrow(/unreadable:permission-denied-eacces.*\/var\/unreadable-path\.jsonl/)
    })

    test("handles multi-byte UTF-8 split across chunk boundaries without Unicode corruption", async () => {
      const mockSplitAg = makeMockAg(`
if (process.argv.includes("list")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "utf8-split-sess",
    sessionKey: "codex:utf8-split-sess",
    canonicalPath: "/path/utf8-split.jsonl",
    sizeBytes: 100,
    mtimeMs: 1000,
    status: "canonical",
    copies: [{ path: "/path/utf8-split.jsonl", sizeBytes: 100, mtimeMs: 1000, decision: "canonical", key: "codex:utf8-split-sess" }]
  }))
  console.log(JSON.stringify({ kind: "done", homes: 1, files: 1, sessions: 1, canonical: 1, ambiguous: 0, stale: 0, invalid: 0 }))
} else if (process.argv.includes("export")) {
  process.stdout.write(JSON.stringify({ kind: "schema", version: 1 }) + "\\n")
  process.stdout.write(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "utf8-split-sess",
    sessionKey: "codex:utf8-split-sess",
    path: "/path/utf8-split.jsonl",
    sizeBytes: 100,
    mtimeMs: 1000,
    status: "canonical"
  }) + "\\n")
  
  const fullLine = JSON.stringify({
    kind: "row",
    sessionKey: "codex:utf8-split-sess",
    line: 1,
    role: "user",
    text: "Prefix " + "\\u{1F31F}" + " and " + "\\u2028" + " Suffix"
  }) + "\\n"

  const buf = Buffer.from(fullLine, "utf8")
  const splitPoint = buf.indexOf(Buffer.from("\\u{1F31F}", "utf8")) + 2
  process.stdout.write(buf.subarray(0, splitPoint))
  setTimeout(() => {
    process.stdout.write(buf.subarray(splitPoint))
    process.stdout.write(JSON.stringify({ kind: "end", sessionKey: "codex:utf8-split-sess", status: "complete" }) + "\\n")
    process.stdout.write(JSON.stringify({ kind: "done", homes: 1, files: 1, sessions: 1, canonical: 1, ambiguous: 0, stale: 0, invalid: 0 }) + "\\n")
  }, 20)
}
`)

      const res = await indexCodexTranscripts(db, { agBin: mockSplitAg })
      expect(res.sessions).toBe(1)
      expect(res.rows).toBe(1)

      const searchRes = ftsSearchWithSnippet(db, "Prefix")
      expect(searchRes.results).toHaveLength(1)
      const text = searchRes.results[0]?.content
      expect(text).toContain("\u{1F31F}")
      expect(text).not.toContain("\uFFFD")
    })

    test("list failures are captured into result failures with wire reasons", async () => {
      const mockListFail = makeMockAg(`
if (process.argv.includes("list")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({ kind: "unreadable", path: "/path/unreadable.jsonl", reason: "permission-denied" }))
  console.log(JSON.stringify({ kind: "done", homes: 1, files: 1, sessions: 0, canonical: 0, ambiguous: 0, stale: 0, invalid: 0 }))
}
`)
      const res = await indexCodexTranscripts(db, { agBin: mockListFail })
      expect(res.failures).toHaveLength(1)
      expect(res.failures[0]?.kind).toBe("unreadable")
      expect(res.failures[0]?.reason).toBe("permission-denied")
      expect(res.reasonCounts["permission-denied"]).toBe(1)
    })

    test("handles NDJSON records containing unicode line separators (U+2028) without premature line splitting", async () => {
      const mockAg = makeMockAg(`
if (process.argv.includes("list")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "session-with-line-sep",
    sessionKey: "codex:session-with-line-sep",
    canonicalPath: "/path/session-with-line-sep.jsonl",
    sizeBytes: 100,
    mtimeMs: 1000,
    status: "canonical",
    copies: [{ path: "/path/session-with-line-sep.jsonl", sizeBytes: 100, mtimeMs: 1000, decision: "canonical", key: "codex:session-with-line-sep" }]
  }))
  console.log(JSON.stringify({ kind: "done", homes: 1, files: 1, sessions: 1, canonical: 1, ambiguous: 0, stale: 0, invalid: 0 }))
} else if (process.argv.includes("export")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "session-with-line-sep",
    sessionKey: "codex:session-with-line-sep",
    path: "/path/session-with-line-sep.jsonl",
    sizeBytes: 100,
    mtimeMs: 1000,
    status: "canonical"
  }))
  console.log(JSON.stringify({
    kind: "row",
    sessionKey: "codex:session-with-line-sep",
    line: 1,
    role: "user",
    text: "first part\\u2028second part"
  }))
  console.log(JSON.stringify({ kind: "end", sessionKey: "codex:session-with-line-sep", status: "complete" }))
  console.log(JSON.stringify({ kind: "done", homes: 1, files: 1, sessions: 1, canonical: 1, ambiguous: 0, stale: 0, invalid: 0 }))
}
`)
      const res = await indexCodexTranscripts(db, { agBin: mockAg })
      expect(res.sessions).toBe(1)
      expect(res.rows).toBe(1)
      const sess = getSession(db, "codex:session-with-line-sep")
      expect(sess?.message_count).toBe(1)
    })
  })

  describe("Chief Review 2246: Correction 2 - Absolute, Tilde, and Relative .recall-ignore Matching", () => {
    test("isRecallIgnored matches absolute, tilde, and projects-relative patterns from .recall-ignore", () => {
      const claudeHome = process.env.CLAUDE_DIR!
      const projectsDir = join(claudeHome, "projects")
      const ignoreFile = join(claudeHome, ".recall-ignore")

      const absPatternFile = "/opt/forensic/quarantine.jsonl"
      const tildePatternFile = join(homedir(), "special-quarantine.jsonl")
      const relSessionFile = join(projectsDir, "my-project", "quarantine-me.jsonl")
      const normalSessionFile = join(projectsDir, "my-project", "normal-session.jsonl")

      writeFileSync(
        ignoreFile,
        [
          "# Comment line",
          "",
          "/opt/forensic/quarantine.jsonl",
          "~/special-quarantine.jsonl",
          "my-project/quarantine-me.jsonl",
        ].join("\n") + "\n",
        "utf8",
      )
      resetIgnoreCache()

      // Absolute path match
      expect(isRecallIgnored(absPatternFile)).toBe(true)
      // Tilde expanded path match
      expect(isRecallIgnored(tildePatternFile)).toBe(true)
      // Relative path match against current projects dir
      expect(isRecallIgnored(relSessionFile)).toBe(true)
      // Normal session is not ignored
      expect(isRecallIgnored(normalSessionFile)).toBe(false)
    })
  })

  describe("Request c1effe68: Exit Code Semantics & Ledgered Skips (Exit 5 vs Exit 1)", () => {
    test("export exiting 1 with doneRecord and ledgered skips resolves and commits valid sessions", async () => {
      const mockSkipsAg = makeMockAg(`
if (process.argv.includes("list")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "valid-sess-1",
    sessionKey: "codex:valid-sess-1",
    canonicalPath: "/path/valid.jsonl",
    sizeBytes: 100,
    mtimeMs: 1000,
    status: "canonical",
    copies: [{ path: "/path/valid.jsonl", sizeBytes: 100, mtimeMs: 1000, decision: "canonical", key: "codex:valid-sess-1" }]
  }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "broken-sess-2",
    sessionKey: "codex:broken-sess-2",
    canonicalPath: "/path/broken.jsonl",
    sizeBytes: 50,
    mtimeMs: 1000,
    status: "canonical",
    copies: [{ path: "/path/broken.jsonl", sizeBytes: 50, mtimeMs: 1000, decision: "canonical", key: "codex:broken-sess-2" }]
  }))
  console.log(JSON.stringify({ kind: "done", homes: 1, files: 2, sessions: 2, canonical: 2, ambiguous: 0, stale: 0, invalid: 0 }))
} else if (process.argv.includes("export")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "valid-sess-1",
    sessionKey: "codex:valid-sess-1",
    path: "/path/valid.jsonl",
    sizeBytes: 100,
    mtimeMs: 1000,
    status: "canonical"
  }))
  console.log(JSON.stringify({
    kind: "row",
    sessionKey: "codex:valid-sess-1",
    line: 1,
    role: "user",
    text: "hello from valid session"
  }))
  console.log(JSON.stringify({ kind: "end", sessionKey: "codex:valid-sess-1", status: "complete", nativeId: "valid-sess-1" }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "broken-sess-2",
    sessionKey: "codex:broken-sess-2",
    path: "/path/broken.jsonl",
    sizeBytes: 50,
    mtimeMs: 1000,
    status: "canonical"
  }))
  console.log(JSON.stringify({
    kind: "unreadable",
    path: "/path/broken.jsonl",
    nativeId: "broken-sess-2",
    reason: "bad-header"
  }))
  console.log(JSON.stringify({ kind: "end", sessionKey: "codex:broken-sess-2", status: "bad-header", nativeId: "broken-sess-2" }))
  console.log(JSON.stringify({ kind: "done", homes: 1, files: 2, sessions: 2, canonical: 1, ambiguous: 0, stale: 0, invalid: 0, unreadable: 1, errors: 0 }))
  // Real ag transcript export exits with 1 when unreadable/bad-header/errors > 0
  process.exit(1)
}
`)

      const res = await indexCodexTranscripts(db, { agBin: mockSkipsAg })
      expect(res.sessions).toBe(1)
      expect(res.rows).toBe(1)
      expect(res.failures).toHaveLength(2)
      expect(res.failures[0]?.reason).toBe("bad-header")
      const validSess = getSession(db, "codex:valid-sess-1")
      expect(validSess?.message_count).toBe(1)
    })

    test("export exiting 1 without doneRecord rejects loud with exit code in error", async () => {
      const mockCrashAg = makeMockAg(`
if (process.argv.includes("list")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "sess-crash",
    sessionKey: "codex:sess-crash",
    canonicalPath: "/path/crash.jsonl",
    sizeBytes: 100,
    mtimeMs: 1000,
    status: "canonical",
    copies: [{ path: "/path/crash.jsonl", sizeBytes: 100, mtimeMs: 1000, decision: "canonical", key: "codex:sess-crash" }]
  }))
  console.log(JSON.stringify({ kind: "done", homes: 1, files: 1, sessions: 1, canonical: 1, ambiguous: 0, stale: 0, invalid: 0 }))
} else if (process.argv.includes("export")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.error("FATAL: segmentation fault or unexpected exit")
  process.exit(1)
}
`)

      await expect(indexCodexTranscripts(db, { agBin: mockCrashAg })).rejects.toThrow(
        /ag transcript export exited with code 1.*FATAL: segmentation fault/,
      )
    })

    test("export exiting with usage error (code 2) rejects loud even if doneRecord was emitted", async () => {
      const mockUsageErrorAg = makeMockAg(`
if (process.argv.includes("list")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "sess-usage",
    sessionKey: "codex:sess-usage",
    canonicalPath: "/path/usage.jsonl",
    sizeBytes: 100,
    mtimeMs: 1000,
    status: "canonical",
    copies: [{ path: "/path/usage.jsonl", sizeBytes: 100, mtimeMs: 1000, decision: "canonical", key: "codex:sess-usage" }]
  }))
  console.log(JSON.stringify({ kind: "done", homes: 1, files: 1, sessions: 1, canonical: 1, ambiguous: 0, stale: 0, invalid: 0 }))
} else if (process.argv.includes("export")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({ kind: "done", homes: 1, files: 1, sessions: 1, canonical: 1, ambiguous: 0, stale: 0, invalid: 0 }))
  console.error("usage error: bad flags")
  process.exit(2)
}
`)

      await expect(indexCodexTranscripts(db, { agBin: mockUsageErrorAg })).rejects.toThrow(
        /ag transcript export exited with code 2.*usage error/,
      )
    })

    test("cmdIndex sets process.exitCode = 5 when batch commits with ledgered skips", async () => {
      const origExitCode = process.exitCode
      const origAgBin = process.env.AG_BIN
      try {
        process.exitCode = undefined
        const isolatedDbPath = join(tempDir, "isolated-test.db")
        const isolatedDb = new Database(isolatedDbPath)
        initSchema(isolatedDb)
        isolatedDb.close()
        process.env.RECALL_DB_PATH = isolatedDbPath

        const skipFile = join(tempDir, "skip.jsonl")
        writeFileSync(skipFile, "")

        const mockSkipsAg = makeMockAg(`
if (process.argv.includes("list")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "skip-test-sess",
    sessionKey: "codex:skip-test-sess",
    canonicalPath: "${skipFile}",
    sizeBytes: 100,
    mtimeMs: 1000,
    status: "canonical",
    copies: [{ path: "${skipFile}", sizeBytes: 100, mtimeMs: 1000, decision: "canonical", key: "codex:skip-test-sess" }]
  }))
  console.log(JSON.stringify({ kind: "done", homes: 1, files: 1, sessions: 1, canonical: 1, ambiguous: 0, stale: 0, invalid: 0 }))
} else if (process.argv.includes("export")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "skip-test-sess",
    sessionKey: "codex:skip-test-sess",
    path: "${skipFile}",
    sizeBytes: 100,
    mtimeMs: 1000,
    status: "canonical"
  }))
  console.log(JSON.stringify({
    kind: "unreadable",
    path: "${skipFile}",
    nativeId: "skip-test-sess",
    reason: "permission-denied"
  }))
  console.log(JSON.stringify({ kind: "end", sessionKey: "codex:skip-test-sess", status: "unreadable", nativeId: "skip-test-sess" }))
  console.log(JSON.stringify({ kind: "done", homes: 1, files: 1, sessions: 1, canonical: 0, ambiguous: 0, stale: 0, invalid: 0, unreadable: 1, errors: 0 }))
  process.exit(1)
}
`)
        process.env.AG_BIN = mockSkipsAg

        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
        await cmdIndex({ path: skipFile })
        expect(process.exitCode).toBe(5)
        logSpy.mockRestore()
      } finally {
        process.exitCode = origExitCode
        if (origAgBin !== undefined) {
          process.env.AG_BIN = origAgBin
        } else {
          delete process.env.AG_BIN
        }
        delete process.env.RECALL_DB_PATH
      }
    })

    test("cmdIndex does not set process.exitCode = 5 when batch is clean without skips", async () => {
      const origExitCode = process.exitCode
      const origAgBin = process.env.AG_BIN
      try {
        process.exitCode = undefined
        const isolatedDbPath = join(tempDir, "isolated-clean-test.db")
        const isolatedDb = new Database(isolatedDbPath)
        initSchema(isolatedDb)
        isolatedDb.close()
        process.env.RECALL_DB_PATH = isolatedDbPath

        const cleanFile = join(tempDir, "clean.jsonl")
        writeFileSync(cleanFile, "")

        const mockCleanAg = makeMockAg(`
if (process.argv.includes("list")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "clean-sess",
    sessionKey: "codex:clean-sess",
    canonicalPath: "${cleanFile}",
    sizeBytes: 100,
    mtimeMs: 1000,
    status: "canonical",
    copies: [{ path: "${cleanFile}", sizeBytes: 100, mtimeMs: 1000, decision: "canonical", key: "codex:clean-sess" }]
  }))
  console.log(JSON.stringify({ kind: "done", homes: 1, files: 1, sessions: 1, canonical: 1, ambiguous: 0, stale: 0, invalid: 0 }))
} else if (process.argv.includes("export")) {
  console.log(JSON.stringify({ kind: "schema", version: 1 }))
  console.log(JSON.stringify({
    kind: "session",
    provider: "codex",
    nativeId: "clean-sess",
    sessionKey: "codex:clean-sess",
    path: "${cleanFile}",
    sizeBytes: 100,
    mtimeMs: 1000,
    status: "canonical"
  }))
  console.log(JSON.stringify({
    kind: "row",
    sessionKey: "codex:clean-sess",
    line: 1,
    role: "user",
    text: "clean message"
  }))
  console.log(JSON.stringify({ kind: "end", sessionKey: "codex:clean-sess", status: "complete", nativeId: "clean-sess" }))
  console.log(JSON.stringify({ kind: "done", homes: 1, files: 1, sessions: 1, canonical: 1, ambiguous: 0, stale: 0, invalid: 0, unreadable: 0, errors: 0 }))
  process.exit(0)
}
`)
        process.env.AG_BIN = mockCleanAg

        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
        await cmdIndex({ path: cleanFile })
        expect(process.exitCode).toBe(0)
        logSpy.mockRestore()
      } finally {
        process.exitCode = origExitCode
        if (origAgBin !== undefined) {
          process.env.AG_BIN = origAgBin
        } else {
          delete process.env.AG_BIN
        }
        delete process.env.RECALL_DB_PATH
      }
    })
  })
})


