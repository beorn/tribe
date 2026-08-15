/**
 * Tribe DB migration lock — cross-process creator/migrator regression.
 *
 * The creator owns the DB-path flock before the destination exists. A
 * migrator started in that window must not enter, observe absence, and rename
 * the legacy DB over the destination the creator is about to establish.
 *
 * Timing is controlled, not raced: the creator holds LOCK_EX until this test
 * writes an explicit release marker, so the "migrator stays outside" assertion
 * is a deterministic mutual-exclusion proof rather than a bet on a fixed sleep
 * outrunning a subprocess cold-start (the CI flake this file was hitting — a
 * 2s readiness deadline lost to a loaded runner's bun startup).
 */

import { afterEach, describe, expect, test } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scratch: string[] = []
const configUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "config.ts")).href

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

/**
 * Wait for a cross-process marker file. The deadline is generous (a cold `bun
 * --eval` importing config.ts + acquiring an flock can take seconds on a loaded
 * CI runner); the poll returns the instant the file appears, so the ceiling
 * only guards against a genuinely stuck subprocess. Fails loud if the process
 * we are waiting on exits before producing the file — a silent 2s timeout hid
 * exactly this class of subprocess crash before.
 */
async function waitForFile(path: string, proc: Bun.Subprocess, label: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (!existsSync(path)) {
    if (proc.exitCode !== null) {
      const stderr = proc.stderr instanceof ReadableStream ? await new Response(proc.stderr).text() : ""
      throw new Error(`${label} exited (code ${proc.exitCode}) before writing ${path}\n${stderr}`)
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label} to write ${path}`)
    await Bun.sleep(10)
  }
}

describe("tribe DB migration flock", () => {
  test("a waiting migrator cannot replace a concurrently created destination DB", async () => {
    const root = mkdtempSync(join(tmpdir(), "tribe-config-lock-"))
    scratch.push(root)
    const project = join(root, "project")
    const legacyDb = join(project, ".beads", "tribe.db")
    const xdgDb = join(root, "xdg", "tribe", "tribe.db")
    const creatorEntered = join(root, "creator-entered")
    const creatorRelease = join(root, "creator-release")
    const migratorStarting = join(root, "migrator-starting")
    const migratorEntered = join(root, "migrator-entered")
    mkdirSync(dirname(legacyDb), { recursive: true })
    mkdirSync(dirname(xdgDb), { recursive: true })
    writeFileSync(legacyDb, "legacy-db", "utf8")

    // Creator: take the DB-path flock BEFORE the destination exists, then hold
    // it until this test writes the release marker. Only then does it establish
    // the fresh destination and drop the lock. Holding until released removes
    // any dependence on a fixed timer to keep the lock during the assertion.
    const creator = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { existsSync, writeFileSync } from "node:fs";
         import { withDbPathLock } from ${JSON.stringify(configUrl)};
         withDbPathLock(${JSON.stringify(xdgDb)}, () => {
           writeFileSync(${JSON.stringify(creatorEntered)}, "entered");
           const idle = new Int32Array(new SharedArrayBuffer(4));
           const deadline = Date.now() + 30_000;
           while (!existsSync(${JSON.stringify(creatorRelease)}) && Date.now() < deadline) Atomics.wait(idle, 0, 0, 20);
           writeFileSync(${JSON.stringify(xdgDb)}, "fresh-db");
         });`,
      ],
      { stdout: "ignore", stderr: "pipe" },
    )
    await waitForFile(creatorEntered, creator, "creator")

    // Migrator: announce it is about to contend, then block on the same flock.
    // migrator-entered is written INSIDE the lock, so it can only appear once
    // the creator releases.
    const migrator = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { writeFileSync } from "node:fs";
         import { migrateLegacyTribeDbIfNeeded, withDbPathLock } from ${JSON.stringify(configUrl)};
         writeFileSync(${JSON.stringify(migratorStarting)}, "starting");
         withDbPathLock(${JSON.stringify(xdgDb)}, () => {
           writeFileSync(${JSON.stringify(migratorEntered)}, "entered");
           migrateLegacyTribeDbIfNeeded(${JSON.stringify(xdgDb)}, ${JSON.stringify(project)});
         });`,
      ],
      { stdout: "ignore", stderr: "pipe" },
    )
    // The migrator process is live and about to call withDbPathLock; give it a
    // beat to reach the blocking flock() syscall. The creator still holds
    // LOCK_EX (it waits for the release marker below), so a migrator that
    // entered here would be a genuine mutual-exclusion break, not slow startup.
    await waitForFile(migratorStarting, migrator, "migrator")
    await Bun.sleep(100)
    expect(existsSync(migratorEntered), "migrator must remain outside while creator owns flock").toBe(false)

    // Release the creator: it writes the fresh destination DB and drops the
    // lock. The migrator then enters, sees the destination already exists, and
    // must NOT rename the legacy DB over it.
    writeFileSync(creatorRelease, "release", "utf8")

    expect(await creator.exited).toBe(0)
    expect(await migrator.exited).toBe(0)
    expect(existsSync(migratorEntered), "migrator must enter once the creator releases the flock").toBe(true)
    expect(readFileSync(xdgDb, "utf8")).toBe("fresh-db")
    expect(readFileSync(legacyDb, "utf8")).toBe("legacy-db")
  }, 60_000)
})
