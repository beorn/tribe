/**
 * resolveHostProjectRoot (@km/bearly/19221/19990) — hook-config / memory lookups
 * must resolve the project root from the CALLER's cwd, not the recall package /
 * submodule location. Walks up for `.claude/` (the hook-config home), then
 * `.git`, else cwd.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { resolveHostProjectRoot } from "../src/lib/project-root.ts"

let base: string
beforeEach(() => {
  // realpath so macOS /var → /private/var symlink doesn't break equality.
  base = realpathSync(mkdtempSync(join(tmpdir(), "recall-projroot-")))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe("resolveHostProjectRoot (19990)", () => {
  test("returns the cwd itself when it holds .claude/", () => {
    mkdirSync(join(base, ".claude"), { recursive: true })
    expect(resolveHostProjectRoot(base)).toBe(base)
  })

  test("walks UP to the nearest ancestor with .claude/ from a subdir", () => {
    mkdirSync(join(base, ".claude"), { recursive: true })
    const sub = join(base, "apps", "silvercode", "src")
    mkdirSync(sub, { recursive: true })
    expect(resolveHostProjectRoot(sub)).toBe(base)
  })

  test("prefers .claude/ over a deeper-but-.git-only ancestor", () => {
    // repo root has .git; a nested package dir has its own .claude/ → the
    // nested .claude wins because that is where hook config actually lives.
    mkdirSync(join(base, ".git"), { recursive: true })
    const pkg = join(base, "packages", "thing")
    mkdirSync(join(pkg, ".claude"), { recursive: true })
    const sub = join(pkg, "src")
    mkdirSync(sub, { recursive: true })
    expect(resolveHostProjectRoot(sub)).toBe(pkg)
  })

  test("falls back to the .git repo root when no .claude/ exists anywhere", () => {
    mkdirSync(join(base, ".git"), { recursive: true })
    const sub = join(base, "src", "lib")
    mkdirSync(sub, { recursive: true })
    expect(resolveHostProjectRoot(sub)).toBe(base)
  })

  test("returns cwd when there are no project markers (the clean/temp-root shape)", () => {
    const bare = join(base, "nowhere")
    mkdirSync(bare, { recursive: true })
    // No .claude or .git up to base; base itself has none either → cwd.
    expect(resolveHostProjectRoot(bare)).toBe(bare)
  })
})
