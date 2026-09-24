/**
 * @failure The relative-path migration's UPDATE could be removed with every witness still green (25462).
 *
 * Written by @dev/review2 (25158 A8 rework, behind the merge): the migration is the ONLY thing that rewrites a legacy
 * relative row the incremental scan SKIPS (status complete, mtime and size unchanged) — most live rows. Witness 4.2
 * seeds its row without mtime_ms/size_bytes, so the scan re-indexes the file and the upsert rewrites the path itself;
 * 4.2 stays green with the migration's UPDATE removed. This row seeds the skip condition, so only the migration can pass it.
 */
import { Database } from "bun:sqlite"
import { expect, test } from "vitest"
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { initSchema } from "../../src/history/db-schema.ts"
import { getSession } from "../../src/history/db-queries.ts"
import { rebuildIndex } from "../../src/history/indexer.ts"

test("review2: a legacy relative row the incremental scan skips is rewritten absolute by the migration", async () => {
  const root = mkdtempSync(join(tmpdir(), "review2-migrate-skipped-"))
  const claudeDir = join(root, "claude")
  const projDir = join(claudeDir, "projects", "-p1")
  mkdirSync(projDir, { recursive: true })
  const id = "55555555-5555-4555-8555-555555555555"
  const file = join(projDir, `${id}.jsonl`)
  writeFileSync(
    file,
    JSON.stringify({ type: "user", uuid: "m5", message: { role: "user", content: "skipped row" } }) + "\n",
    "utf8",
  )
  const stats = statSync(file)
  const db = new Database(join(root, "test.db"))
  initSchema(db)
  db.prepare(
    "INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, status, mtime_ms, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, "/p1", join("-p1", `${id}.jsonl`), Date.now(), Date.now(), 1, "complete", stats.mtime.getTime(), stats.size)
  const saved = process.env.CLAUDE_DIR
  try {
    process.env.CLAUDE_DIR = claudeDir
    const result = await rebuildIndex(db, { incremental: true, skipCodex: true })
    // The scan skipped the unchanged file, so the path can only have moved through the migration.
    expect(result.messages ?? 0).toBe(0)
    expect(getSession(db, id)?.jsonl_path).toBe(file)
  } finally {
    if (saved !== undefined) process.env.CLAUDE_DIR = saved
    else delete process.env.CLAUDE_DIR
    db.close()
    safeRemoveSync(root, { within: tmpdir() })
  }
})
