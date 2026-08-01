import { spawnSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

import { slugFromText, emitHookJson } from "../src/qmd-export.ts"

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

// emitHookJson builds the hook response envelope. The schema Claude Code
// enforces is event-specific and strict:
//
//   - UserPromptSubmit: hookSpecificOutput.additionalContext is REQUIRED
//     when hookSpecificOutput is present. No additionalContext → don't
//     emit hookSpecificOutput → emit plain `{}`.
//   - SessionEnd: has no event-specific hookSpecificOutput schema. Always
//     emit `{}`.
//
// Any deviation trips the validator and raises a 500 on the next turn.

type HookEnvelope = {
  hookSpecificOutput?: {
    hookEventName: string
    additionalContext?: string
  }
}

describe("emitHookJson", () => {
  test("UserPromptSubmit with additionalContext emits full envelope", () => {
    const out = JSON.parse(emitHookJson("UserPromptSubmit", "## Memory")) as HookEnvelope
    expect(out.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit")
    expect(out.hookSpecificOutput?.additionalContext).toBe("## Memory")
  })

  test("UserPromptSubmit with no context emits empty object", () => {
    const out = JSON.parse(emitHookJson("UserPromptSubmit")) as HookEnvelope
    expect(out).toEqual({})
  })

  test("SessionEnd always emits empty object (schema forbids hookSpecificOutput)", () => {
    expect(JSON.parse(emitHookJson("SessionEnd"))).toEqual({})
    expect(JSON.parse(emitHookJson("SessionEnd", "ignored"))).toEqual({})
  })

  test("unknown event emits empty object", () => {
    expect(JSON.parse(emitHookJson("Whatever"))).toEqual({})
  })

  // Schema invariant: if hookSpecificOutput is present on UserPromptSubmit,
  // additionalContext MUST be present too (it's required by the validator).
  test("never emits hookSpecificOutput without additionalContext (UserPromptSubmit)", () => {
    const out = JSON.parse(emitHookJson("UserPromptSubmit")) as HookEnvelope
    if (out.hookSpecificOutput !== undefined) {
      expect(out.hookSpecificOutput.additionalContext).toBeDefined()
    }
  })
})

describe("qmd export boundary", () => {
  test("rejects the retired shadow query CLI", () => {
    const script = fileURLToPath(new URL("../src/qmd-export.ts", import.meta.url))
    const result = spawnSync("bun", [script, "shadow-query-must-not-run"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain("qmd export adapter")
    expect(result.stderr).toContain("use `recall <query>`")
  })

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
      "node",
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
