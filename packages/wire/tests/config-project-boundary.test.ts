/**
 * @failure Tribe inherits project identity or migrates a legacy DB from beyond
 *          the current Git/superproject boundary.
 * @level l0
 * @consumer tribe-wire project identity and legacy database migration
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, expect, test } from "vitest"
import { tempTree } from "removely"
import { findBeadsDir, migrateLegacyTribeDbIfNeeded, resolveProjectName } from "../src/lib/config.ts"

describe("Tribe project-boundary discovery", () => {
  test("an independent nested Git project cannot inherit or migrate an outer .beads directory", async () => {
    await using fixture = await tempTree("tribe-project-boundary-")
    const outer = fixture.resolve("outer")
    const inner = join(outer, "inner")
    const nested = join(inner, "nested")
    const outerBeads = join(outer, ".beads")
    const legacyDb = join(outerBeads, "tribe.db")
    const xdgDb = fixture.resolve("xdg", "tribe", "tribe.db")

    mkdirSync(outerBeads, { recursive: true })
    mkdirSync(nested, { recursive: true })
    mkdirSync(dirname(xdgDb), { recursive: true })
    writeFileSync(join(outerBeads, "config.yaml"), "project: outer-project\n", "utf8")
    writeFileSync(legacyDb, "outer legacy database", "utf8")
    execFileSync("git", ["init", "--quiet", inner])

    expect(findBeadsDir(nested)).toBeNull()
    expect(resolveProjectName(nested)).toBe("nested")

    migrateLegacyTribeDbIfNeeded(xdgDb, nested)
    expect(readFileSync(legacyDb, "utf8")).toBe("outer legacy database")
    expect(existsSync(xdgDb)).toBe(false)
  })

  test("nested directories discover .beads inside the same Git project", async () => {
    await using fixture = await tempTree("tribe-same-project-")
    const project = fixture.resolve("project")
    const nested = join(project, "one", "two")
    const beads = join(project, ".beads")
    mkdirSync(nested, { recursive: true })
    mkdirSync(beads)
    writeFileSync(join(beads, "config.yaml"), "project: same-project\n", "utf8")
    execFileSync("git", ["init", "--quiet", project])

    expect(findBeadsDir(nested)).toBe(beads)
    expect(resolveProjectName(nested)).toBe("same")
  })

  test("a product submodule inherits its superproject boundary", async () => {
    await using fixture = await tempTree("tribe-superproject-")
    const source = fixture.resolve("source")
    const superproject = fixture.resolve("superproject")
    const beads = join(superproject, ".beads")
    const submodule = join(superproject, "vendor", "child")
    const nested = join(submodule, "nested")

    initCommittedRepo(source, "source.md")
    initCommittedRepo(superproject, "root.md")
    mkdirSync(beads)
    writeFileSync(join(beads, "config.yaml"), "project: super-project\n", "utf8")
    execFileSync(
      "git",
      ["-c", "protocol.file.allow=always", "-C", superproject, "submodule", "add", "--quiet", source, "vendor/child"],
      { stdio: "ignore" },
    )
    mkdirSync(nested)

    expect(findBeadsDir(nested)).toBe(beads)
    expect(resolveProjectName(nested)).toBe("super")
  })

  test("a missing prospective directory can discover project config from its parent", async () => {
    await using fixture = await tempTree("tribe-project-prospective-")
    const beads = fixture.resolve(".beads")
    mkdirSync(beads)

    expect(findBeadsDir(fixture.resolve("missing"))).toBe(beads)
  })

  test("a prospective path in a nested Git island cannot inherit outer project config", async () => {
    await using fixture = await tempTree("tribe-project-prospective-island-")
    const outer = fixture.resolve("outer")
    const nestedRepo = join(outer, "nested")
    const beads = join(outer, ".beads")
    mkdirSync(nestedRepo, { recursive: true })
    mkdirSync(beads)
    execFileSync("git", ["init", "--quiet", outer])
    execFileSync("git", ["init", "--quiet", nestedRepo])

    expect(findBeadsDir(join(nestedRepo, "future", "child"))).toBeNull()
  })

  test("an operational Git probe failure does not widen discovery to filesystem root", async () => {
    await using fixture = await tempTree("tribe-project-probe-failure-")
    const file = fixture.resolve("not-a-directory")
    writeFileSync(file, "fixture\n", "utf8")

    expect(() => findBeadsDir(file)).toThrow(/git project boundary probe failed/u)
  })
})

function initCommittedRepo(root: string, fileName: string): void {
  mkdirSync(root, { recursive: true })
  execFileSync("git", ["init", "--quiet", root])
  execFileSync("git", ["-C", root, "config", "user.name", "Tribe Test"])
  execFileSync("git", ["-C", root, "config", "user.email", "tribe-test@example.invalid"])
  writeFileSync(join(root, fileName), "fixture\n", "utf8")
  execFileSync("git", ["-C", root, "add", fileName])
  execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "fixture"])
}
