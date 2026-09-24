/**
 * @failure A legacy relative row held by another profile's root was marked and pruned by a run from this root (25462).
 *
 * Written by @dev/review2 (25158 A8 rework, behind the merge): the live index holds LEGACY RELATIVE rows from several
 * profile roots. A run under a root that does not hold a row's file must neither mark nor prune it (ruling 2509961f:
 * "unresolved exempt + counted"), however many runs pass. No row in change2-witness.test.ts seeds this case.
 */
import { Database } from "bun:sqlite"
import { expect, test, vi } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { initSchema } from "../../src/history/db-schema.ts"
import { getMessageCount, getSession, insertMessage } from "../../src/history/db-queries.ts"
import { rebuildIndex } from "../../src/history/indexer.ts"

test("review2: a legacy relative row another profile's root holds survives two runs from this root, unmarked", async () => {
  const root = mkdtempSync(join(tmpdir(), "review2-unresolved-"))
  const other = join(root, "claudeOther")
  const here = join(root, "claudeHere")
  mkdirSync(join(other, "projects", "-p1"), { recursive: true })
  mkdirSync(join(here, "projects"), { recursive: true })
  const id = "44444444-4444-4444-8444-444444444444"
  const relative = join("-p1", `${id}.jsonl`)
  // The transcript exists, under the OTHER profile's root only.
  writeFileSync(
    join(other, "projects", relative),
    JSON.stringify({ type: "user", uuid: "m4", message: { role: "user", content: "other profile" } }) + "\n",
    "utf8",
  )
  const db = new Database(join(root, "test.db"))
  initSchema(db)
  db.prepare(
    "INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, "/p1", relative, Date.now(), Date.now(), 1, "complete")
  insertMessage(db, "m4", id, "user", "other profile", null, null, Date.now())
  const saved = process.env.CLAUDE_DIR
  try {
    process.env.CLAUDE_DIR = here
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    for (const _run of [1, 2, 3]) {
      const result = await rebuildIndex(db, { incremental: true, skipCodex: true })
      expect(result.pruned).toBe(0)
      expect(getSession(db, id)?.status).toBe("complete")
      expect(getSession(db, id)?.jsonl_path).toBe(relative)
      expect(getMessageCount(db, id)).toBe(1)
    }
    // Counted: every run names the unresolved row it left alone.
    expect(
      warn.mock.calls.flat().filter((line) => String(line).includes("1 legacy session(s) have relative paths")),
    ).toHaveLength(3)
  } finally {
    vi.restoreAllMocks()
    if (saved !== undefined) process.env.CLAUDE_DIR = saved
    else delete process.env.CLAUDE_DIR
    db.close()
    safeRemoveSync(root, { within: tmpdir() })
  }
})
