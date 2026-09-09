/**
 * 24351 U5 rule 4: a down-daemon hint names a cure, and the cure must exist.
 * `withCliDaemonClient` calls `process.exit(1)` on its ECONNREFUSED/ENOENT
 * path, so this reads the source text (same idiom as
 * ../../daemon/src/lib/compose/layering.test.ts) instead of executing it —
 * that keeps the check safe while still failing loud if the named start
 * command drifts away from a real file again.
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const here = fileURLToPath(new URL(".", import.meta.url))
const tribeRoot = resolve(here, "../../..")
const sourcePath = resolve(here, "../src/cli/daemon-client.ts")

describe("no-daemon CLI hint", () => {
  test("names a start command that exists on disk", () => {
    const source = readFileSync(sourcePath, "utf8")
    const match = source.match(/Start one with: bun (\S+)/)
    expect(match, 'expected a "Start one with: bun <path>" hint in daemon-client.ts').not.toBeNull()

    const scriptPath = match?.[1]
    if (scriptPath === undefined) throw new Error('the "Start one with: bun <path>" hint lost its capture group')
    const resolved = resolve(tribeRoot, scriptPath)
    expect(existsSync(resolved), `named cure "bun ${scriptPath}" does not exist at ${resolved}`).toBe(true)
  })
})
