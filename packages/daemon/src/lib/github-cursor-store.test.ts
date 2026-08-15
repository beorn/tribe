/**
 * @failure GitHub polling persisted a machine-local cursor in the current
 *   project's `.beads/` directory. A poll racing `tent bead create` therefore
 *   appeared as a second PM-state mutation and rolled every create back.
 * @level l2 — real files, Git porcelain, and legacy-to-XDG adoption.
 * @consumer githubPlugin.start cursor persistence.
 */
import { execFileSync, spawn } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { safeRemoveSync } from "removely"
import { afterEach, describe, expect, test } from "vitest"

import { openGitHubCursorStore, resolveGitHubCursorPath, type GitHubCursorState } from "./github-cursor-store.ts"

const tempRoot = realpathSync(tmpdir())
const tribeRoot = realpathSync(join(dirname(new URL(import.meta.url).pathname), "../../../.."))
const roots: Array<{ path: string; within: string }> = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    safeRemoveSync(root.path, {
      within: root.within,
      allowedRoots: [root.within],
      allowMissing: true,
    })
  }
})

function fixture(
  label: string,
  parent = tempRoot,
): { repo: string; stateDir: string; legacyPath: string; targetPath: string } {
  const root = realpathSync(mkdtempSync(join(parent, `tribe-github-cursor-${label}-`)))
  roots.push({ path: root, within: parent })
  const repo = join(root, "project")
  const stateDir = join(root, "xdg-data", "tribe")
  const legacyPath = join(repo, ".beads", "github-cursor.json")
  mkdirSync(dirname(legacyPath), { recursive: true })
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo })
  execFileSync("git", ["config", "user.name", "tribe test"], { cwd: repo })
  execFileSync("git", ["config", "user.email", "tribe-test@example.com"], { cwd: repo })
  writeFileSync(join(repo, "README.md"), "# fixture\n")
  execFileSync("git", ["add", "README.md"], { cwd: repo })
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: repo })
  return { repo, stateDir, legacyPath, targetPath: join(stateDir, "github-cursor.json") }
}

const state: GitHubCursorState = {
  repos: {
    "beorn/hh": { lastEventId: "event-42", lastPollAt: "2026-08-12T19:00:00.000Z" },
  },
}

describe("GitHub cursor machine-state ownership", () => {
  test("resolves inside Tribe's XDG data root, never the project checkout", () => {
    expect(resolveGitHubCursorPath({ XDG_DATA_HOME: "/machine/data", HOME: "/home/test" })).toBe(
      "/machine/data/tribe/github-cursor.json",
    )
    expect(resolveGitHubCursorPath({ HOME: "/home/test" })).toBe("/home/test/.local/share/tribe/github-cursor.json")
  })

  test("adopts a legacy .beads cursor and leaves the project worktree clean", () => {
    const f = fixture("legacy")
    writeFileSync(f.legacyPath, `${JSON.stringify(state, null, 2)}\n`)

    const store = openGitHubCursorStore({ stateDir: f.stateDir, legacyPath: f.legacyPath })

    expect(store.path).toBe(f.targetPath)
    expect(store.state).toEqual(state)
    expect(existsSync(f.legacyPath)).toBe(false)
    expect(JSON.parse(readFileSync(f.targetPath, "utf8"))).toEqual(state)
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: f.repo, encoding: "utf8" })).toBe("")
  })

  test("an absent cursor initializes in memory without writing a default file", () => {
    const f = fixture("absent")

    const store = openGitHubCursorStore({ stateDir: f.stateDir, legacyPath: f.legacyPath })

    expect(store.state).toEqual({ repos: {} })
    expect(existsSync(f.targetPath)).toBe(false)
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: f.repo, encoding: "utf8" })).toBe("")
  })

  test("uses destination-only state without recreating or consulting the legacy carrier", () => {
    const f = fixture("destination")
    mkdirSync(f.stateDir, { recursive: true })
    writeFileSync(f.targetPath, `${JSON.stringify(state)}\n`)

    const store = openGitHubCursorStore({ stateDir: f.stateDir, legacyPath: f.legacyPath })

    expect(store.state).toEqual(state)
    expect(existsSync(f.legacyPath)).toBe(false)
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: f.repo, encoding: "utf8" })).toBe("")
  })

  test("identical dual state converges by removing the legacy runtime carrier", () => {
    const f = fixture("identical")
    mkdirSync(f.stateDir, { recursive: true })
    writeFileSync(f.legacyPath, `${JSON.stringify(state)}\n`)
    writeFileSync(f.targetPath, `${JSON.stringify(state, null, 2)}\n`)

    const store = openGitHubCursorStore({ stateDir: f.stateDir, legacyPath: f.legacyPath })

    expect(store.state).toEqual(state)
    expect(existsSync(f.legacyPath)).toBe(false)
    expect(JSON.parse(readFileSync(f.targetPath, "utf8"))).toEqual(state)
  })

  test.each([
    { label: "legacy adoption", destinationExists: false },
    { label: "identical dual state", destinationExists: true },
  ])("$label removes a legacy cursor outside the default /tmp safety root", ({ label, destinationExists }) => {
    const f = fixture(`outside-tmp-${label.replaceAll(" ", "-")}`, tribeRoot)
    writeFileSync(f.legacyPath, `${JSON.stringify(state)}\n`)
    if (destinationExists) {
      mkdirSync(f.stateDir, { recursive: true })
      writeFileSync(f.targetPath, `${JSON.stringify(state, null, 2)}\n`)
    }

    const store = openGitHubCursorStore({ stateDir: f.stateDir, legacyPath: f.legacyPath })

    expect(store.state).toEqual(state)
    expect(existsSync(f.legacyPath)).toBe(false)
    expect(JSON.parse(readFileSync(f.targetPath, "utf8"))).toEqual(state)
  })

  test("corrupt legacy state fails loudly with the inspected path", () => {
    const f = fixture("corrupt")
    writeFileSync(f.legacyPath, "{ not json")

    expect(() => openGitHubCursorStore({ stateDir: f.stateDir, legacyPath: f.legacyPath })).toThrow(
      new RegExp(`GitHub cursor.*${f.legacyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"),
    )
    expect(existsSync(f.targetPath)).toBe(false)
    expect(readFileSync(f.legacyPath, "utf8")).toBe("{ not json")
  })

  test("a migration-lock permission failure names both paths and preserves legacy state", () => {
    const f = fixture("permission")
    writeFileSync(f.legacyPath, `${JSON.stringify(state)}\n`)
    mkdirSync(f.stateDir, { recursive: true })
    chmodSync(f.stateDir, 0o500)
    try {
      expect(() => openGitHubCursorStore({ stateDir: f.stateDir, legacyPath: f.legacyPath })).toThrow(
        new RegExp(
          `${f.targetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*${f.legacyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
          "i",
        ),
      )
      expect(readFileSync(f.legacyPath, "utf8")).toBe(`${JSON.stringify(state)}\n`)
      expect(existsSync(f.targetPath)).toBe(false)
    } finally {
      chmodSync(f.stateDir, 0o700)
    }
  })

  test("conflicting legacy and XDG states fail loudly without changing either", () => {
    const f = fixture("conflict")
    const other: GitHubCursorState = {
      repos: { "beorn/km": { lastEventId: "other", lastPollAt: "2026-08-12T20:00:00.000Z" } },
    }
    mkdirSync(f.stateDir, { recursive: true })
    writeFileSync(f.legacyPath, `${JSON.stringify(state)}\n`)
    writeFileSync(f.targetPath, `${JSON.stringify(other)}\n`)

    expect(() => openGitHubCursorStore({ stateDir: f.stateDir, legacyPath: f.legacyPath })).toThrow(
      /conflicting GitHub cursor states/i,
    )
    expect(JSON.parse(readFileSync(f.legacyPath, "utf8"))).toEqual(state)
    expect(JSON.parse(readFileSync(f.targetPath, "utf8"))).toEqual(other)
  })

  test("concurrent legacy adoption serializes through the process-shared migration lock", async () => {
    const f = fixture("concurrent")
    writeFileSync(f.legacyPath, `${JSON.stringify(state)}\n`)
    const modulePath = new URL("./github-cursor-store.ts", import.meta.url).pathname
    const script = [
      `import { openGitHubCursorStore } from ${JSON.stringify(modulePath)}`,
      "const options = JSON.parse(process.env.TRIBE_CURSOR_TEST_OPTIONS ?? '')",
      "openGitHubCursorStore(options)",
    ].join(";\n")
    const run = (): Promise<void> =>
      new Promise((resolveProcess, rejectProcess) => {
        const child = spawn(process.execPath, ["-e", script], {
          cwd: f.repo,
          env: { ...process.env, TRIBE_CURSOR_TEST_OPTIONS: JSON.stringify(f) },
          stdio: ["ignore", "pipe", "pipe"],
        })
        let output = ""
        child.stdout.on("data", (chunk) => (output += String(chunk)))
        child.stderr.on("data", (chunk) => (output += String(chunk)))
        child.on("error", rejectProcess)
        child.on("close", (code) => {
          if (code === 0) resolveProcess()
          else rejectProcess(new Error(`cursor adoption child exited ${code ?? "null"}: ${output}`))
        })
      })

    await Promise.all([run(), run()])

    expect(existsSync(f.legacyPath)).toBe(false)
    expect(JSON.parse(readFileSync(f.targetPath, "utf8"))).toEqual(state)
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: f.repo, encoding: "utf8" })).toBe("")
  })

  test("save atomically replaces the XDG cursor without temporary survivors", () => {
    const f = fixture("save")
    const store = openGitHubCursorStore({ stateDir: f.stateDir, legacyPath: f.legacyPath })

    store.save(state)

    expect(JSON.parse(readFileSync(f.targetPath, "utf8"))).toEqual(state)
    expect(readdirSync(f.stateDir).filter((name) => name.includes(".tmp"))).toEqual([])
  })
})
