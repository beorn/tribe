import { Database as SqliteDb } from "bun:sqlite"
import * as fs from "fs"
import * as path from "path"
import { spawnSync } from "child_process"

const outDir = path.dirname(new URL(import.meta.url).pathname)
const tmp = fs.mkdtempSync("/tmp/gen-legacy-fixture-")
const pdir = path.join(tmp, "projects")
const proj = path.join(pdir, "test-legacy-proj")
const subDir = path.join(proj, "parent-sess", "subagents")
fs.mkdirSync(subDir, { recursive: true })

const parentFile = path.join(proj, "parent-sess.jsonl")
const subagentFile = path.join(subDir, "agent-sub1.jsonl")

const parentTranscript =
  JSON.stringify({
    sessionId: "parent-sess",
    type: "user",
    message: { content: "parent user question" },
    timestamp: "2026-08-01T12:00:00.000Z",
  }) +
  "\n" +
  JSON.stringify({
    sessionId: "parent-sess",
    type: "assistant",
    message: { content: [{ type: "text", text: "parent assistant reply" }] },
    timestamp: "2026-08-01T12:00:05.000Z",
  }) +
  "\n"

const subagentTranscript =
  JSON.stringify({
    sessionId: "parent-sess",
    type: "user",
    message: { content: "subagent instructions" },
    timestamp: "2026-08-01T12:00:10.000Z",
  }) +
  "\n" +
  JSON.stringify({
    sessionId: "parent-sess",
    type: "assistant",
    message: { content: [{ type: "text", text: "subagent finished task" }] },
    timestamp: "2026-08-01T12:00:15.000Z",
  }) +
  "\n"

fs.writeFileSync(parentFile, parentTranscript)
fs.writeFileSync(subagentFile, subagentTranscript)

// Also save transcripts in the fixture directory for test reuse
fs.writeFileSync(path.join(outDir, "parent-sess.jsonl"), parentTranscript)
const fixtureSubDir = path.join(outDir, "parent-sess", "subagents")
fs.mkdirSync(fixtureSubDir, { recursive: true })
fs.writeFileSync(path.join(fixtureSubDir, "agent-sub1.jsonl"), subagentTranscript)

// Extract old schema and indexer from origin/main (fe416c4c0b)
const oldSchemaCode = spawnSync("git", ["show", "origin/main:packages/recall/src/history/db-schema.ts"], {
  encoding: "utf8",
}).stdout
const oldDbCode = spawnSync("git", ["show", "origin/main:packages/recall/src/history/db.ts"], {
  encoding: "utf8",
}).stdout
const oldIndexerCode = spawnSync("git", ["show", "origin/main:packages/recall/src/history/indexer.ts"], {
  encoding: "utf8",
}).stdout
const oldTypesCode = spawnSync("git", ["show", "origin/main:packages/recall/src/history/types.ts"], {
  encoding: "utf8",
}).stdout
const oldQueriesCode = spawnSync("git", ["show", "origin/main:packages/recall/src/history/db-queries.ts"], {
  encoding: "utf8",
}).stdout
const oldCodexCode = spawnSync("git", ["show", "origin/main:packages/recall/src/history/codex-indexer.ts"], {
  encoding: "utf8",
}).stdout
const oldFormattersCode = spawnSync("git", ["show", "origin/main:packages/recall/src/history/formatters.ts"], {
  encoding: "utf8",
}).stdout

const srcDir = path.join(tmp, "src")
fs.mkdirSync(srcDir, { recursive: true })
fs.writeFileSync(path.join(srcDir, "db-schema.ts"), oldSchemaCode)
fs.writeFileSync(path.join(srcDir, "db.ts"), oldDbCode)
fs.writeFileSync(path.join(srcDir, "indexer.ts"), oldIndexerCode)
fs.writeFileSync(path.join(srcDir, "types.ts"), oldTypesCode)
fs.writeFileSync(path.join(srcDir, "db-queries.ts"), oldQueriesCode)
fs.writeFileSync(path.join(srcDir, "codex-indexer.ts"), oldCodexCode)
fs.writeFileSync(path.join(srcDir, "formatters.ts"), oldFormattersCode)

process.env.CLAUDE_DIR = tmp
process.env.RECALL_SKIP_CODEX = "1"

const { initSchema } = await import(path.join(srcDir, "db.ts"))
const { rebuildIndex } = await import(path.join(srcDir, "indexer.ts"))

const fixtureDbPath = path.join(outDir, "clobbered-legacy.db")
if (fs.existsSync(fixtureDbPath)) {
  fs.unlinkSync(fixtureDbPath)
}

const db = new SqliteDb(fixtureDbPath)
initSchema(db)

const result = await rebuildIndex(db, { incremental: true })
console.log("Legacy indexer result:", result)

const sessions = db.query("SELECT id, project_path, jsonl_path, message_count FROM sessions").all()
console.log("Legacy sessions in fixture:", sessions)
const msgCount = (db.query("SELECT COUNT(*) as c FROM messages").get() as any).c
console.log("Legacy messages count:", msgCount)

db.close()
fs.rmSync(tmp, { recursive: true, force: true })
console.log("Fixture written to:", fixtureDbPath)
