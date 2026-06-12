/**
 * Doc pin: the plugin README documents the standalone marketplace install
 * path and the host boundary. (The pre-cutover placeholder text pointed at
 * bearly's @bearly/tribe — that era ended with the 19273 move.)
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "vitest"

describe("Claude plugin boundary", () => {
  test("documents the standalone marketplace install and Tribe boundary", () => {
    const readme = readFileSync(resolve(import.meta.dirname, "../README.md"), "utf8")

    expect(readme).toContain("/plugin marketplace add beorn/tribe")
    expect(readme).toContain("/plugin install tribe@tribe")
    expect(readme).toContain("Reusable protocol code belongs in `tribe-wire`")
    expect(readme).toContain("Project workflow conventions")
    expect(readme).not.toContain("Placeholder")
  })
})
