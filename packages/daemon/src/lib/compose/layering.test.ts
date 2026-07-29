/**
 * @failure L2 Tribe regrows L3 Tent subprocess tools or dead bead-era observers.
 * @level   L3
 * @consumer Standalone Tribe users and the hh composition layer
 */

import { readdirSync, readFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const sourceRoot = fileURLToPath(new URL("../..", import.meta.url))

function productionSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) return productionSources(path)
    if (!entry.name.endsWith(".ts") || /\.(?:test|spec)\.ts$/.test(entry.name)) return []
    return [path]
  })
}

describe("daemon layer and live-surface boundaries", () => {
  test("contains no Tent subprocess vocabulary or retired observer modules", () => {
    const sources = productionSources(sourceRoot)
    const forbiddenText = [
      /\.agents\/skills\/tent/,
      /\.claude\/skills\/tent/,
      /\bfleet-(?:read|wake|exec)\b/,
      /\.beads\/backup\/issues\.jsonl/,
      /backup\/issues\.jsonl/,
    ]
    const textViolations = sources.flatMap((path) => {
      const source = readFileSync(path, "utf8")
      return forbiddenText.some((pattern) => pattern.test(source)) ? [relative(sourceRoot, path)] : []
    })
    const retiredModules = new Set(["lib/bead-snapshot.ts", "lib/beads-plugin.ts", "lib/dolt-reaper-plugin.ts"])
    const moduleViolations = sources
      .map((path) => relative(sourceRoot, path))
      .filter((path) => retiredModules.has(path))

    expect({ moduleViolations, textViolations }).toEqual({
      moduleViolations: [],
      textViolations: [],
    })
  })
})
