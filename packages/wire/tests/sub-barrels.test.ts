/**
 * The four consumer subpaths (./launch-environment, ./client, ./trust,
 * ./records) are narrow doors onto the root barrel's names, one home per name.
 * A name reachable through two subpaths would let consumers of one name split
 * across two graphs; a subpath exporting a name the root lacks would grow the
 * public surface through a side door.
 */
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as { exports: Record<string, string> }
const SUBPATHS = ["./launch-environment", "./client", "./trust", "./records"] as const
const entry = (subpath: string): string => {
  const target = manifest.exports[subpath]
  if (target === undefined) throw new Error(`package.json exports has no ${subpath}`)
  return resolve(PACKAGE, target)
}
const ROOT = entry(".")

async function names(file: string): Promise<Set<string>> {
  return new Set(Object.keys((await import(file)) as Record<string, unknown>))
}

describe("tribe-wire's consumer subpaths", () => {
  it("export pairwise disjoint name sets whose union is inside the root barrel", async () => {
    const root = await names(ROOT)
    const sets = await Promise.all(SUBPATHS.map(async (subpath) => [subpath, await names(entry(subpath))] as const))
    for (const [subpath, set] of sets) {
      expect(set.size, `${subpath} exports nothing`).toBeGreaterThan(0)
      expect(
        [...set].filter((name) => !root.has(name)),
        `${subpath} exports names the root barrel lacks`,
      ).toEqual([])
    }
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        const [a, left] = sets[i]!
        const [b, right] = sets[j]!
        expect(
          [...left].filter((name) => right.has(name)),
          `${a} and ${b} both export`,
        ).toEqual([])
      }
    }
  })

  it("re-export leaf modules only: no subpath entry imports the root barrel or another subpath's entry", () => {
    const entries = new Set([ROOT, ...SUBPATHS.map(entry)])
    for (const subpath of SUBPATHS) {
      const file = entry(subpath)
      const specifiers = [...readFileSync(file, "utf8").matchAll(/\bfrom\s*["'](\.{1,2}\/[^"']+)["']/gu)].map(
        (m) => m[1]!,
      )
      const bad = specifiers.filter((specifier) => entries.has(resolve(dirname(file), specifier)))
      expect(bad, `${subpath} (${file}) imports another entry`).toEqual([])
    }
  })
})
