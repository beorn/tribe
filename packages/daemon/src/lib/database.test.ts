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

import { CURRENT_SCHEMA_VERSION, openDatabase } from "./database.ts"
import { fileURLToPath } from "node:url"

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

  /**
   * @failure Two processes read schema v29 before either adds principal_class;
   *          the loser exits on a duplicate column despite a valid upgraded DB.
   * @level   l2
   * @consumer Tribe daemon processes opening the same existing database
   *
   * The first real Bun opener pauses at its v30 ALTER. A second process can
   * complete the upgrade before it resumes on the old migration runner.
   */
  it("serializes two v29 openers before they decide which migrations to run", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tribe-v29-concurrent-open-")))
    const path = join(dir, "tribe.sqlite")
    const children: Array<ReturnType<typeof Bun.spawn>> = []

    try {
      const seed = new Database(path, { create: true })
      try {
        seed.run("CREATE TABLE _schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        seed.run("INSERT INTO _schema_meta VALUES ('version', '29')")
        seed.run(`CREATE TABLE sessions (
          id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
          domains TEXT NOT NULL DEFAULT '[]', pid INTEGER NOT NULL, cwd TEXT,
          project_id TEXT, claude_session_id TEXT, claude_session_name TEXT,
          identity_token TEXT, mailbox_authority_hash TEXT,
          launch_id TEXT, launch_parent_pid INTEGER,
          started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          last_delivered_ts INTEGER, last_delivered_seq INTEGER NOT NULL DEFAULT 0,
          last_inbox_pull_seq INTEGER NOT NULL DEFAULT 0,
          filter_mode TEXT NOT NULL DEFAULT 'normal', filter_until INTEGER,
          filter_mute TEXT, delivery TEXT NOT NULL DEFAULT 'push', account TEXT,
          provider TEXT
        )`)
        seed.run(
          "INSERT INTO sessions (id, name, role, pid, started_at, updated_at) VALUES ('a', '@a', 'agent', 1, 1, 1)",
        )
        expect(seed.prepare("PRAGMA table_info(sessions)").all()).not.toContainEqual(
          expect.objectContaining({ name: "principal_class" }),
        )
      } finally {
        seed.close()
      }

      const childCode = `
        import { Database } from "bun:sqlite"
        const [modulePath, dbPath, slow] = process.argv.slice(-3)
        if (slow === "true") {
          const original = Database.prototype.run
          Database.prototype.run = function (sql, ...args) {
            if (sql.startsWith("ALTER TABLE sessions ADD COLUMN principal_class")) {
              process.stdout.write("at-v30\\n")
              Bun.sleepSync(1000)
            }
            return original.call(this, sql, ...args)
          }
        }
        const { openDatabase } = await import(modulePath)
        const db = openDatabase(dbPath)
        db.close()
      `
      const spawnOpener = (slow: boolean) => {
        const child = Bun.spawn({
          cmd: [
            process.execPath,
            "--eval",
            childCode,
            "--",
            fileURLToPath(new URL("./database.ts", import.meta.url)),
            path,
            String(slow),
          ],
          stdout: "pipe",
          stderr: "pipe",
        })
        children.push(child)
        return child
      }

      const first = spawnOpener(true)
      const reader = first.stdout.getReader()
      const timer = setTimeout(() => first.kill(), 10_000)
      try {
        const signal = await reader.read()
        expect(signal.done).toBe(false)
        expect(new TextDecoder().decode(signal.value)).toContain("at-v30")
      } finally {
        clearTimeout(timer)
        reader.releaseLock()
      }

      const second = spawnOpener(false)
      const [firstExit, secondExit, firstErr, secondErr] = await Promise.all([
        first.exited,
        second.exited,
        new Response(first.stderr).text(),
        new Response(second.stderr).text(),
      ])
      expect(firstExit, firstErr).toBe(0)
      expect(secondExit, secondErr).toBe(0)

      const upgraded = new Database(path)
      try {
        expect(upgraded.prepare("SELECT value FROM _schema_meta WHERE key = 'version'").get()).toEqual({
          value: String(CURRENT_SCHEMA_VERSION),
        })
        const columns = upgraded.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>
        expect(columns.filter((column) => column.name === "principal_class")).toHaveLength(1)
        expect(upgraded.prepare("SELECT name, principal_class FROM sessions WHERE id = 'a'").get()).toEqual({
          name: "@a",
          principal_class: "agent",
        })
      } finally {
        upgraded.close()
      }
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill()
      await Promise.all(children.map((child) => child.exited))
      safeRemoveSync(dir, { within: TEST_ROOT, allowMissing: true })
    }
  }, 20_000)
})
