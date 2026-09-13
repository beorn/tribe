/** @failure Hosted Recall hooks re-execute the host's unrelated CLI (23189). */
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
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

describe("Recall lifecycle refresh hints", () => {
  test.each(["start", "end"])("the %s hint invokes Recall itself when hosted", async (kind) => {
    vi.stubEnv("RECALL_DB_PATH", ":memory:")
    vi.stubEnv("TRIBE_NO_DAEMON", "1")
    vi.stubEnv("RECALL_NO_BG_INDEX", "0")
    setIndexMeta(getDb(), "last_rebuild", "invalid timestamp")
    fake.spawn.mockReturnValue({ on: vi.fn(), unref: vi.fn() })
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
      yield Buffer.from(JSON.stringify({ session_id: "fixture", cwd: fake.home }))
      return undefined
    })
    const oldArgv = process.argv
    process.argv = [process.execPath, "/unrelated/tribe-host.ts"]
    try {
      await (kind === "start" ? cmdSessionStart() : cmdSessionEnd())
    } finally {
      process.argv = oldArgv
    }
    expect(fake.spawn).toHaveBeenCalledOnce()
    expect(fake.spawn.mock.calls[0]?.slice(0, 2)).toEqual([
      process.execPath,
      [fileURLToPath(new URL("../../src/cli.ts", import.meta.url)), "index", "--incremental"],
    ])
  })
})
