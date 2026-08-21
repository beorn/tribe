/**
 * @failure Recall indexes only <code>/docs, or gives code/container documents
 *          the same source id, so moved agent docs disappear or overwrite
 *          product docs with the same relative path.
 * @level l2
 * @consumer Recall project-source search in a nested habitat/container layout
 */

import { Database } from "bun:sqlite"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { safeRemoveSync } from "removely"
import { afterEach, describe, expect, test } from "vitest"

import { initSchema } from "../../src/history/db.ts"
import { indexProjectSources } from "../../src/history/indexer.ts"

const fixtures: string[] = []

function habitatFixture(): { container: string; code: string } {
  const container = mkdtempSync(join(realpathSync(tmpdir()), "recall-habitat-docs-"))
  fixtures.push(container)
  const code = join(container, "dev")
  mkdirSync(join(container, "docs"), { recursive: true })
  mkdirSync(join(code, "docs"), { recursive: true })
  execFileSync("git", ["init", "-q", container])
  execFileSync("git", ["init", "-q", code])
  return { container, code }
}

function addCodeProject(container: string, name: string): string {
  const code = join(container, name)
  mkdirSync(join(code, "docs"), { recursive: true })
  execFileSync("git", ["init", "-q", code])
  return code
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    safeRemoveSync(fixture, { within: realpathSync(tmpdir()), allowMissing: true })
  }
})

describe("Recall project documentation roots", () => {
  test("indexes code and enclosing-container docs with collision-free identities", () => {
    const { container, code } = habitatFixture()
    writeFileSync(join(code, "docs", "shared.md"), "# Product shared\n\ncode-only phrase\n")
    writeFileSync(join(container, "docs", "shared.md"), "# Agent shared\n\ncontainer-only phrase\n")
    const db = new Database(":memory:")
    initSchema(db)

    expect(indexProjectSources(db, code).docs).toBe(2)
    const rows = db
      .query("SELECT source_id, content FROM content WHERE content_type = 'doc' ORDER BY content")
      .all() as Array<{ source_id: string; content: string }>
    expect(rows.map(({ content }) => content)).toEqual([
      "# Agent shared\n\ncontainer-only phrase\n",
      "# Product shared\n\ncode-only phrase\n",
    ])
    expect(new Set(rows.map(({ source_id: sourceId }) => sourceId)).size).toBe(2)
    expect(rows[0]?.source_id).toMatch(/^doc:container:[a-f0-9]{64}:docs\/shared\.md$/u)
    expect(rows[1]?.source_id).toMatch(/^doc:[a-f0-9]{64}:docs\/shared\.md$/u)
    db.close()
  })

  test("keeps shared container docs searchable from every nested code project", () => {
    const { container, code } = habitatFixture()
    const sibling = addCodeProject(container, "other")
    writeFileSync(join(container, "docs", "shared.md"), "# Agent shared\n\ncontainer-only phrase\n")
    writeFileSync(join(code, "docs", "product.md"), "# First product\n")
    writeFileSync(join(sibling, "docs", "product.md"), "# Second product\n")
    const db = new Database(":memory:")
    initSchema(db)

    expect(indexProjectSources(db, code).docs).toBe(2)
    expect(indexProjectSources(db, sibling).docs).toBe(2)

    for (const projectPath of [code, sibling]) {
      expect(
        db
          .query("SELECT title, content FROM content WHERE content_type = 'doc' AND project_path = ? ORDER BY title")
          .all(projectPath),
      ).toEqual([
        { title: "Agent shared", content: "# Agent shared\n\ncontainer-only phrase\n" },
        {
          title: projectPath === code ? "First product" : "Second product",
          content: projectPath === code ? "# First product\n" : "# Second product\n",
        },
      ])
    }
    db.close()
  })

  test("removes a stale code-doc row after that document moves to the container", () => {
    const { container, code } = habitatFixture()
    const codeFile = join(code, "docs", "moved.md")
    writeFileSync(codeFile, "# Before move\n")
    const db = new Database(":memory:")
    initSchema(db)
    indexProjectSources(db, code)

    unlinkSync(codeFile)
    writeFileSync(join(container, "docs", "moved.md"), "# After move\n")
    indexProjectSources(db, code)

    const rows = db.query("SELECT source_id FROM content WHERE content_type = 'doc'").all() as Array<{
      source_id: string
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0]?.source_id).toMatch(/^doc:container:[a-f0-9]{64}:docs\/moved\.md$/u)
    db.close()
  })

  test("ignores ambient Git root overrides while discovering both documentation homes", () => {
    const { container, code } = habitatFixture()
    const foreign = mkdtempSync(join(realpathSync(tmpdir()), "recall-foreign-git-"))
    fixtures.push(foreign)
    execFileSync("git", ["init", "-q", foreign])
    writeFileSync(join(code, "docs", "product.md"), "# Product\n")
    writeFileSync(join(container, "docs", "agent.md"), "# Agent\n")
    const db = new Database(":memory:")
    initSchema(db)
    const previous = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
    }
    process.env.GIT_DIR = join(foreign, ".git")
    process.env.GIT_WORK_TREE = foreign
    process.env.GIT_INDEX_FILE = join(foreign, ".git", "index")
    try {
      expect(indexProjectSources(db, code).docs).toBe(2)
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      db.close()
    }
  })
})
