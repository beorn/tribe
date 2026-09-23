/**
 * @failure The session hooks spawned `recall index --incremental` into the live index, a second writer beside
 * the recall-index timer and its mechanic (@ag/tribe/25071 row 4): every seat's SessionStart with a stale index,
 * and every SessionEnd, fired one. 12 spawns 06:01-07:25Z on 2026-09-23, each failing on sessions.jsonl_path.
 */
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"

const fake = vi.hoisted(() => ({ home: "", spawn: vi.fn() }))
fake.home = mkdtempSync(join(realpathSync(tmpdir()), "recall-hook-"))
vi.mock("os", async (original) => ({ ...(await original<typeof import("os")>()), homedir: () => fake.home }))
vi.mock("child_process", async (original) => ({
  ...(await original<typeof import("child_process")>()),
  spawn: fake.spawn,
}))
const { cmdSessionStart, cmdSessionEnd } = await import("../../src/lib/hooks")
const { getDb, closeDb, setIndexMeta } = await import("../../src/history/db")

afterEach(() => {
  closeDb()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fake.spawn.mockReset()
})
afterAll(() => safeRemoveSync(fake.home, { within: realpathSync(tmpdir()) }))

describe("Recall session hooks never write the index (@ag/tribe/25071 row 4)", () => {
  test.each(["start", "end"])("the session %s hook spawns no indexer, even when the index is stale", async (kind) => {
    vi.stubEnv("RECALL_DB_PATH", ":memory:")
    vi.stubEnv("TRIBE_NO_DAEMON", "1")
    vi.stubEnv("RECALL_NO_BG_INDEX", undefined)
    setIndexMeta(getDb(), "last_rebuild", "invalid timestamp")
    fake.spawn.mockReturnValue({ on: vi.fn(), unref: vi.fn() })
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
      yield Buffer.from(JSON.stringify({ session_id: "fixture", cwd: fake.home }))
      return undefined
    })
    await (kind === "start" ? cmdSessionStart() : cmdSessionEnd())
    expect(fake.spawn).not.toHaveBeenCalled()
  })
})
