/**
 * @failure Invalid GitHub watch URLs are silently accepted or mangled; watchlist grows past
 *   the 100-item cap; corrupt watchlist files silently reset to empty; or `tribe watch` CLI
 *   omits machine-clean `--json` output (#38449, @cto 99ecd337).
 * @level L2 — target grammar, locked atomic store, cap enforcement, CLI contract.
 * @consumer `tribe watch add|list|remove` and `githubPlugin` watchlist poller.
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import {
  addGitHubWatchEntry,
  GITHUB_WATCHLIST_MAX_ITEMS,
  parseGitHubWatchTarget,
  readGitHubWatchlist,
  removeGitHubWatchEntry,
  removeGitHubWatchEntriesByKey,
} from "../src/lib/github-watchlist.ts"

const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../src/cli.ts")

const tempDirs: string[] = []
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("parseGitHubWatchTarget — URL & shorthand grammar (#38449)", () => {
  test("parses all accepted repo and issue/PR forms", () => {
    expect(parseGitHubWatchTarget("ahpio/ahpd#463")).toEqual({
      kind: "item",
      repo: "ahpio/ahpd",
      number: 463,
      canonical: "ahpio/ahpd#463",
      key: "ahpio/ahpd#463",
    })
    expect(parseGitHubWatchTarget("https://github.com/ahpio/ahpd/pull/463")).toMatchObject({
      kind: "item",
      repo: "ahpio/ahpd",
      number: 463,
      canonical: "ahpio/ahpd#463",
    })
    expect(parseGitHubWatchTarget("https://github.com/ahpio/ahpd/issues/463#issuecomment-999")).toMatchObject({
      kind: "item",
      repo: "ahpio/ahpd",
      number: 463,
      canonical: "ahpio/ahpd#463",
    })
    expect(parseGitHubWatchTarget("https://github.com/ahpio/ahpd/pull/463/files?w=1")).toMatchObject({
      kind: "item",
      repo: "ahpio/ahpd",
      number: 463,
      canonical: "ahpio/ahpd#463",
    })
    expect(parseGitHubWatchTarget("https://github.com/ahpio/ahpd")).toEqual({
      kind: "repo",
      repo: "ahpio/ahpd",
      canonical: "ahpio/ahpd",
      key: "ahpio/ahpd",
    })
    expect(parseGitHubWatchTarget("https://github.com/ahpio/ahpd.git")).toMatchObject({
      kind: "repo",
      repo: "ahpio/ahpd",
      canonical: "ahpio/ahpd",
    })
    expect(parseGitHubWatchTarget("ahpio/ahpd")).toMatchObject({
      kind: "repo",
      repo: "ahpio/ahpd",
      canonical: "ahpio/ahpd",
    })
  })

  test("refuses malformed, non-github, or unsupported paths by name", () => {
    expect(() => parseGitHubWatchTarget("")).toThrow(/target is empty/i)
    expect(() => parseGitHubWatchTarget("https://gitlab.com/ahpio/ahpd/issues/1")).toThrow(/gitlab\.com/i)
    expect(() => parseGitHubWatchTarget("http://github.com/ahpio/ahpd/issues/1")).toThrow(/http:/i)
    expect(() => parseGitHubWatchTarget("https://github.com/ahpio/ahpd/issues/abc")).toThrow(/"abc"/i)
    expect(() => parseGitHubWatchTarget("https://github.com/ahpio/ahpd/blob/main/README.md")).toThrow(/blob/i)
    expect(() => parseGitHubWatchTarget("ahpio/ahpd#0")).toThrow(/"0"/i)
    expect(() => parseGitHubWatchTarget("just-a-word")).toThrow(/just-a-word/i)
  })
})

describe("github watchlist store — persistence, cap, and fail-loud (#38449)", () => {
  test("missing file reads as empty; corrupt file throws loud", () => {
    const dir = makeTempDir("tribe-watch-store-")
    const path = join(dir, "github-watchlist.json")
    expect(readGitHubWatchlist(path)).toEqual({ entries: [] })

    writeFileSync(path, "{not valid json", "utf8")
    expect(() => readGitHubWatchlist(path)).toThrow(/not valid JSON/i)
  })

  test("adds, updates idempotently, and removes entries", () => {
    const dir = makeTempDir("tribe-watch-crud-")
    const path = join(dir, "github-watchlist.json")

    const added = addGitHubWatchEntry(path, {
      target: "https://github.com/ahpio/ahpd/pull/463",
      owner: "@dev/15",
      now: "2026-11-25T05:00:00Z",
    })
    expect(added.action).toBe("added")
    expect(added.entry).toEqual({
      kind: "item",
      target: "ahpio/ahpd#463",
      repo: "ahpio/ahpd",
      number: 463,
      owner: "@dev/15",
      operatorFollows: false,
      addedAt: "2026-11-25T05:00:00Z",
    })

    const updated = addGitHubWatchEntry(path, {
      target: "ahpio/ahpd#463",
      owner: "@dev/15",
      operatorFollows: true,
      now: "2026-11-25T06:00:00Z",
    })
    expect(updated.action).toBe("updated")
    expect(updated.entry.operatorFollows).toBe(true)
    expect(updated.entry.addedAt).toBe("2026-11-25T05:00:00Z")
    expect(readGitHubWatchlist(path).entries).toHaveLength(1)

    const removed = removeGitHubWatchEntry(path, "https://github.com/ahpio/ahpd/issues/463")
    expect(removed.removed.target).toBe("ahpio/ahpd#463")
    expect(readGitHubWatchlist(path).entries).toHaveLength(0)
    expect(() => removeGitHubWatchEntry(path, "ahpio/ahpd#463")).toThrow(/not watching ahpio\/ahpd#463/i)
  })

  test("enforces the 100-item cap and refuses additions by name listing the oldest", () => {
    const dir = makeTempDir("tribe-watch-cap-")
    const path = join(dir, "github-watchlist.json")
    expect(GITHUB_WATCHLIST_MAX_ITEMS).toBe(100)

    for (let i = 1; i <= 100; i++) {
      const day = String(Math.floor((i - 1) / 4) + 1).padStart(2, "0")
      const hour = String((i - 1) % 24).padStart(2, "0")
      addGitHubWatchEntry(path, {
        target: `org/repo#${i}`,
        owner: "@dev/15",
        now: `2026-11-${day}T${hour}:00:00Z`,
      })
    }

    expect(() =>
      addGitHubWatchEntry(path, {
        target: "org/repo#101",
        owner: "@dev/15",
        now: "2026-11-26T00:00:00Z",
      }),
    ).toThrow(
      /cap reached \(100\/100 watched items\).*refusing to add org\/repo#101.*Oldest watched items: org\/repo#1/i,
    )

    // Updating an existing item at the cap still succeeds
    const updated = addGitHubWatchEntry(path, {
      target: "org/repo#1",
      owner: "@dev/15",
      operatorFollows: true,
    })
    expect(updated.action).toBe("updated")

    // Batch key removal frees space
    const removed = removeGitHubWatchEntriesByKey(path, new Set(["org/repo#1"]))
    expect(removed).toHaveLength(1)
    expect(
      addGitHubWatchEntry(path, {
        target: "org/repo#101",
        owner: "@dev/15",
      }).action,
    ).toBe("added")
  })
})

describe("tribe watch CLI — add / list / remove (--json and bare)", () => {
  test("round-trips add, list, and remove with clean JSON stdout and loud errors", () => {
    const dir = makeTempDir("tribe-watch-cli-")
    const env = { ...process.env, XDG_DATA_HOME: dir }
    const run = (args: string[]) => spawnSync("bun", [CLI_PATH, "watch", ...args], { env, encoding: "utf8" })

    const addRes = run(["add", "https://github.com/ahpio/ahpd/pull/463", "--owner", "@dev/15", "--operator", "--json"])
    expect(addRes.status).toBe(0)
    const addJson = JSON.parse(addRes.stdout) as {
      ok: boolean
      action: string
      entry: { target: string; operatorFollows: boolean }
    }
    expect(addJson.ok).toBe(true)
    expect(addJson.action).toBe("added")
    expect(addJson.entry.target).toBe("ahpio/ahpd#463")
    expect(addJson.entry.operatorFollows).toBe(true)

    const listRes = run(["list", "--json"])
    expect(listRes.status).toBe(0)
    const listJson = JSON.parse(listRes.stdout) as { count: number; itemCount: number; maxItems: number }
    expect(listJson.count).toBe(1)
    expect(listJson.itemCount).toBe(1)
    expect(listJson.maxItems).toBe(100)

    const badRes = run(["add", "https://gitlab.com/foo/bar/issues/1", "--owner", "@dev/15"])
    expect(badRes.status).toBe(1)
    expect(badRes.stderr).toContain("gitlab.com")

    const removeRes = run(["remove", "ahpio/ahpd#463", "--json"])
    expect(removeRes.status).toBe(0)
    const removeJson = JSON.parse(removeRes.stdout) as { ok: boolean; removed: { target: string } }
    expect(removeJson.ok).toBe(true)
    expect(removeJson.removed.target).toBe("ahpio/ahpd#463")
  })
})
