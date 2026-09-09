/**
 * @failure Daemon startup exits before its socket binds when a transient SQLite
 *          lock prevents the initial WAL journal-mode change.
 * @level   integration
 * @consumer Tribe daemon users starting while another process releases the DB
 *
 * The daemon keeps a five-second SQLite busy policy. A lock that clears within
 * that window must apply to the initial WAL pragma too, because that pragma
 * takes a write lock before the schema can be opened.
 */

import { Database } from "bun:sqlite"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { describe, expect, it } from "vitest"

import { openDatabase } from "./database.ts"

const TEST_ROOT = realpathSync(tmpdir())

async function holdExclusiveLock(path: string) {
  const holder = Bun.spawn({
    cmd: [
      process.execPath,
      "--eval",
      `
        import { Database } from "bun:sqlite"

        const path = process.argv.at(-1)
        if (!path) throw new Error("expected database path")
        const db = new Database(path, { create: true })
        try {
          db.run("BEGIN EXCLUSIVE")
          process.stdout.write("exclusive lock acquired\\n")
          await Bun.sleep(300)
        } finally {
          db.close()
        }
      `,
      "--",
      path,
    ],
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = holder.stdout.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("lock holder did not become ready")), 10_000)
      }),
    ])
    if (first.done || !first.value) throw new Error("lock holder exited before acquiring the lock")
    expect(new TextDecoder().decode(first.value)).toContain("exclusive lock acquired")
    return holder
  } catch (error) {
    if (holder.exitCode === null) holder.kill()
    const [exitCode, stderr] = await Promise.all([holder.exited, new Response(holder.stderr).text()])
    throw new Error(`lock holder failed before readiness; exit=${exitCode}; stderr=${stderr}`, { cause: error })
  } finally {
    if (timer) clearTimeout(timer)
    reader.releaseLock()
  }
}

function expectExclusiveLockToRemainHeld(path: string): void {
  const contender = new Database(path, { create: true })
  try {
    let error: unknown
    try {
      contender.run("PRAGMA journal_mode = WAL")
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ code: "SQLITE_BUSY" })
  } finally {
    contender.close()
  }
}

async function expectLockHolderToExitSuccessfully(
  holder: Awaited<ReturnType<typeof holdExclusiveLock>>,
): Promise<void> {
  const [exitCode, stderr] = await Promise.all([holder.exited, new Response(holder.stderr).text()])
  expect(exitCode, `lock holder exit=${exitCode}; stderr=${stderr}`).toBe(0)
}

describe("openDatabase", () => {
  it("waits for a transient exclusive lock before enabling WAL", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tribe-wal-startup-")))
    const path = join(dir, "tribe.sqlite")
    let holder: Awaited<ReturnType<typeof holdExclusiveLock>> | undefined
    let db: ReturnType<typeof openDatabase> | undefined

    try {
      holder = await holdExclusiveLock(path)
      // This keeps the release window from turning the old WAL-first failure
      // into a false green before the call under test starts.
      expectExclusiveLockToRemainHeld(path)
      db = openDatabase(path)
      expect(db.query("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" })
      await expectLockHolderToExitSuccessfully(holder)
    } finally {
      db?.close()
      if (holder) await holder.exited
      safeRemoveSync(dir, { within: TEST_ROOT, allowMissing: true })
    }
  }, 15_000)
})
