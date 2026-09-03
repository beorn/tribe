/**
 * tribe-wire@0.1.4 shipped three releases with 2 of 12 subpath exports missing
 * from the published tarball: `exports` (dev, source-pointing), `tsdown.entry`
 * (the build list), and `publishConfig.exports` (what npm actually ships) had
 * drifted apart and nothing tested that they agreed. This file asserts the
 * three stay mechanically derivable from one another so a fourth subpath can
 * never again go missing silently.
 *
 * Everything here is derived from the live `package.json` values — no
 * hardcoded subpath list — so adding/removing/renaming an export only
 * requires editing `exports` + `tsdown.entry` + `publishConfig.exports`
 * together; a slip in any one of the three fails here first.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

type PublishExportEntry = { types: string; import: string }

type WirePackageJson = {
  exports: Record<string, string>
  publishConfig: { exports: Record<string, PublishExportEntry> }
  tsdown: { entry: string[] }
}

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const repoDir = join(packageDir, "..", "..")
const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as WirePackageJson

const devExports = pkg.exports
const publishedExports = pkg.publishConfig.exports
const tsdownEntries = pkg.tsdown.entry

const workflowDir = join(repoDir, ".github", "workflows")
const setupBunWorkflows = readdirSync(workflowDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .map((name) => ({ name, source: readFileSync(join(workflowDir, name), "utf8") }))
  .filter(({ source }) => source.includes("oven-sh/setup-bun@"))

/** `"./src/lib/socket.ts"` / `"src/lib/socket.ts"` -> `"src/lib/socket.ts"` */
function stripLeadingDotSlash(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path
}

/**
 * The dev `exports` value is the source file; the published dist stem is
 * that path with the `src/` prefix and `.ts` suffix removed, e.g.
 * `"./src/lib/socket.ts"` -> `"lib/socket"`, `"./src/index.ts"` -> `"index"`.
 */
function srcExportToDistStem(srcExportValue: string): string {
  const normalized = stripLeadingDotSlash(srcExportValue)
  if (!normalized.startsWith("src/")) {
    throw new Error(`export source "${srcExportValue}" is not under src/ — cannot derive its dist stem`)
  }
  if (!normalized.endsWith(".ts")) {
    throw new Error(`export source "${srcExportValue}" does not end in .ts — cannot derive its dist stem`)
  }
  return normalized.slice("src/".length, -".ts".length)
}

describe("packages/wire package.json export manifest consistency", () => {
  it("gives every dev exports key a matching publishConfig.exports key", () => {
    const missing = Object.keys(devExports).filter((key) => !(key in publishedExports))
    expect(missing).toEqual([])
  })

  it("has no publishConfig.exports key without a matching dev exports key", () => {
    // The inverse of the above: a stale published subpath with no dev source
    // is the same drift, just discovered from the other end.
    const orphaned = Object.keys(publishedExports).filter((key) => !(key in devExports))
    expect(orphaned).toEqual([])
  })

  it("points every dev export at a source file that actually exists", () => {
    const missing = Object.entries(devExports)
      .filter(([, value]) => !existsSync(join(packageDir, stripLeadingDotSlash(value))))
      .map(([key, value]) => `${key} -> ${value} (file not found)`)
    expect(missing).toEqual([])
  })

  it("includes every dev export's source file in tsdown.entry", () => {
    const entrySet = new Set(tsdownEntries.map(stripLeadingDotSlash))
    const missing = Object.entries(devExports)
      .filter(([, value]) => !entrySet.has(stripLeadingDotSlash(value)))
      .map(([key, value]) => `${key} -> ${value} missing from tsdown.entry`)
    expect(missing).toEqual([])
  })

  it("has no tsdown.entry that isn't reachable through some dev export", () => {
    // An entry the build produces but no `exports` key points at would build
    // dist output that publishConfig.exports can never legitimately reference.
    const referenced = new Set(Object.values(devExports).map(stripLeadingDotSlash))
    const orphaned = tsdownEntries.map(stripLeadingDotSlash).filter((entry) => !referenced.has(entry))
    expect(orphaned).toEqual([])
  })

  it("derives every publishConfig.exports dist path from its export's source file", () => {
    const mismatches: string[] = []
    for (const [key, srcValue] of Object.entries(devExports)) {
      const stem = srcExportToDistStem(srcValue)
      const expectedTypes = `./dist/${stem}.d.mts`
      const expectedImport = `./dist/${stem}.mjs`
      const published = publishedExports[key]
      if (!published) {
        mismatches.push(`${key}: no publishConfig.exports entry (source ${srcValue})`)
        continue
      }
      if (published.types !== expectedTypes) {
        mismatches.push(`${key}: expected types "${expectedTypes}", got "${published.types}"`)
      }
      if (published.import !== expectedImport) {
        mismatches.push(`${key}: expected import "${expectedImport}", got "${published.import}"`)
      }
    }
    expect(mismatches).toEqual([])
  })
})

describe("repository Bun runtime manifest consistency", () => {
  it("declares one exact repository Bun version", () => {
    const versionPath = join(repoDir, ".bun-version")
    expect(existsSync(versionPath), ".bun-version must declare the hosted-tooling Bun runtime").toBe(true)
    if (!existsSync(versionPath)) return

    const version = readFileSync(versionPath, "utf8").trim()
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it.each(setupBunWorkflows)("$name installs the repository Bun version", ({ source }) => {
    expect(source.match(/^\s*bun-version-file:\s*["']?\.bun-version["']?\s*$/gm)).toHaveLength(1)
    expect(source).not.toMatch(/^\s*bun-version:\s/m)
  })
})
