import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

import { slugFromText } from "../src/qmd-export.ts"

/**
 * Bun ships its own `node -> bun` compatibility shim in a temp directory
 * (`/tmp/bun-node-*`) and prepends it to PATH for every process it spawns —
 * including this test's own runner (`bunx --bun vitest`). A plain
 * `spawnSync("node", ...)` resolves to that shim, not a real Node.js
 * runtime, and Bun's argv handling for `-e --input-type=module <arg>`
 * leaves `process.argv[1]` undefined where real Node populates it — hence
 * "Cannot find package 'undefined'". This probe's entire point is proving a
 * REAL Node runtime can load qmd's native SQLite binding, so it must resolve
 * past Bun's self-shim rather than trust PATH order
 * (@km/tribe/ci-green-round3).
 */
function realNodeBinary(): string {
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, "node")
    if (!existsSync(candidate)) continue
    let resolved: string
    try {
      resolved = realpathSync(candidate)
    } catch {
      continue
    }
    if (basename(resolved) === "bun") continue
    return candidate
  }
  throw new Error("no real (non-Bun) node binary found on PATH — qmd's native SQLite binding needs one to load under")
}

// slugFromText becomes a filesystem filename. It must never produce path
// separators, dots, or anything that would break out of the target directory.

describe("slugFromText", () => {
  test("returns 'session' for empty input", () => {
    expect(slugFromText("")).toBe("session")
  })

  test("lowercases input", () => {
    expect(slugFromText("HELLO World")).toBe("hello-world")
  })

  test("replaces special chars with spaces then dashes", () => {
    expect(slugFromText("hello, world!")).toBe("hello-world")
  })

  test("never contains path separators", () => {
    expect(slugFromText("../../../etc/passwd")).not.toContain("/")
    expect(slugFromText("foo/bar/baz")).not.toContain("/")
    expect(slugFromText("foo\\bar\\baz")).not.toContain("\\")
  })

  test("truncates long input", () => {
    const long = "word ".repeat(100)
    expect(slugFromText(long).length).toBeLessThanOrEqual(50)
  })

  test("handles first 8 words max", () => {
    expect(slugFromText("one two three four five six seven eight nine ten")).toBe(
      "one-two-three-four-five-six-seven-eight",
    )
  })
})

describe("qmd export boundary", () => {
  test("ships qmd with a Node-loadable native SQLite module", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies?.["@tobilu/qmd"]).toBe("2.5.3")

    const qmdRoot = realpathSync(fileURLToPath(new URL("../node_modules/@tobilu/qmd/", import.meta.url)))
    const qmdNodeModules = dirname(dirname(qmdRoot))
    const betterSqliteRoot = realpathSync(join(qmdNodeModules, "better-sqlite3"))
    const betterSqliteEntry = join(betterSqliteRoot, "lib", "index.js")

    const nativeProbe = spawnSync(
      realNodeBinary(),
      [
        "--input-type=module",
        "-e",
        'const { default: Database } = await import(process.argv[1]); const db = new Database(":memory:"); const row = db.prepare("select 1 as value").get(); db.close(); process.stdout.write(String(row.value));',
        betterSqliteEntry,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )
    expect(nativeProbe.status, nativeProbe.stderr).toBe(0)
    expect(nativeProbe.stdout).toBe("1")

    const versionProbe = spawnSync(join(qmdRoot, "bin", "qmd"), ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    expect(versionProbe.status, versionProbe.stderr).toBe(0)
    expect(versionProbe.stdout.trim()).toMatch(/^qmd 2\.5\.3(?:\s|$)/)
  })
})
