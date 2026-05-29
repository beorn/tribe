/**
 * The standalone Tribe repo does not embed bearly's legacy lore/recall test
 * harness. Recall-specific MCP behavior remains covered in bearly; this plugin
 * directory now only documents the Claude host boundary for Tribe.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "vitest"

describe("Claude plugin boundary", () => {
  test("documents the standalone Tribe boundary without importing bearly lore internals", () => {
    const readme = readFileSync(resolve(import.meta.dirname, "../README.md"), "utf8")

    expect(readme).toContain("The published Claude Code plugin is `@bearly/tribe`")
    expect(readme).toContain("Reusable protocol code belongs in `tribe-wire`")
    expect(readme).toContain("Project workflow conventions")
  })
})
