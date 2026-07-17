/**
 * Tribe DB migration lock — cross-process creator/migrator regression.
 *
 * The creator owns the DB-path flock before the destination exists. A
 * migrator started in that window must not enter, observe absence, and rename
 * the legacy DB over the destination the creator is about to establish.
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

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`)
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
    const migratorEntered = join(root, "migrator-entered")
    mkdirSync(dirname(legacyDb), { recursive: true })
    mkdirSync(dirname(xdgDb), { recursive: true })
    writeFileSync(legacyDb, "legacy-db", "utf8")

    const creator = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { writeFileSync } from "node:fs";
         import { withDbPathLock } from ${JSON.stringify(configUrl)};
         withDbPathLock(${JSON.stringify(xdgDb)}, () => {
           writeFileSync(${JSON.stringify(creatorEntered)}, "entered");
           Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
           writeFileSync(${JSON.stringify(xdgDb)}, "fresh-db");
         });`,
      ],
      { stdout: "ignore", stderr: "pipe" },
    )
    await waitForFile(creatorEntered)

    const migrator = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { writeFileSync } from "node:fs";
         import { migrateLegacyTribeDbIfNeeded, withDbPathLock } from ${JSON.stringify(configUrl)};
         withDbPathLock(${JSON.stringify(xdgDb)}, () => {
           writeFileSync(${JSON.stringify(migratorEntered)}, "entered");
           migrateLegacyTribeDbIfNeeded(${JSON.stringify(xdgDb)}, ${JSON.stringify(project)});
         });`,
      ],
      { stdout: "ignore", stderr: "pipe" },
    )

    await Bun.sleep(50)
    expect(existsSync(migratorEntered), "migrator must remain outside while creator owns flock").toBe(false)
    expect(await creator.exited).toBe(0)
    expect(await migrator.exited).toBe(0)
    expect(readFileSync(xdgDb, "utf8")).toBe("fresh-db")
    expect(readFileSync(legacyDb, "utf8")).toBe("legacy-db")
  })
})
