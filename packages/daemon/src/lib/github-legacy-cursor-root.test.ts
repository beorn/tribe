/**
 * @failure The GitHub plugin located its LEGACY cursor by walking up from
 *   `process.cwd()` — `findBeadsDir()` with no argument. The daemon therefore
 *   hunted for legacy cursors wherever its launcher happened to start it, and
 *   any stray `.beads/github-cursor.json` on that path became input to the
 *   adoption. 93 stale copies of the old writer exist on this machine and can
 *   mint more, so an unrelated directory could hand the daemon a conflicting
 *   cursor — which, before the blast-radius fix, refused startup outright.
 * @level l2 — real directories and a real cursor store.
 * @consumer githubPlugin.start legacy cursor adoption.
 *
 * The refusal to choose/merge/reset conflicting cursors is correct and stays.
 * What is fixed is WHERE the daemon looks: an explicitly declared root, or
 * nowhere at all. Never the working directory.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { findBeadsDir } from "tribe-wire/lib/config"
import { openGitHubCursorStore, resolveLegacyGitHubCursorPath, TRIBE_PROJECT_ROOT_ENV } from "./github-cursor-store.ts"

let fixture: string
let originalCwd: string

/** A directory that looks exactly like a project with a stale legacy cursor. */
function plantStrayStub(root: string, lastEventId: string): string {
  const beads = join(root, ".beads")
  mkdirSync(beads, { recursive: true })
  // A git boundary, so findBeadsDir() would happily resolve inside it.
  mkdirSync(join(root, ".git"), { recursive: true })
  const cursor = join(beads, "github-cursor.json")
  writeFileSync(cursor, JSON.stringify({ repos: { "o/r": { lastEventId, lastPollAt: "2026-08-13T00:00:00Z" } } }))
  return cursor
}

beforeEach(() => {
  originalCwd = process.cwd()
  fixture = mkdtempSync(join(tmpdir(), "github-legacy-root-"))
})

afterEach(() => {
  process.chdir(originalCwd)
})

describe("legacy GitHub cursor root resolution", () => {
  it("returns null when no project root is declared, however tempting the cwd looks", () => {
    const stray = join(fixture, "somebody-elses-repo")
    mkdirSync(stray, { recursive: true })
    plantStrayStub(stray, "stray-1")
    process.chdir(stray)

    // The hazard, pinned: the call the plugin used to make DOES find the stub.
    // This is not the assertion — it is the reason the assertion below matters.
    expect(findBeadsDir()).toBe(join(stray, ".beads"))

    expect(resolveLegacyGitHubCursorPath({})).toBeNull()
  })

  it("resolves from the declared root, not from the cwd", () => {
    const declared = join(fixture, "declared-root")
    mkdirSync(declared, { recursive: true })
    plantStrayStub(declared, "declared-1")

    const stray = join(fixture, "stray-cwd")
    mkdirSync(stray, { recursive: true })
    plantStrayStub(stray, "stray-2")
    process.chdir(stray)

    expect(resolveLegacyGitHubCursorPath({ [TRIBE_PROJECT_ROOT_ENV]: declared })).toBe(
      resolve(declared, ".beads", "github-cursor.json"),
    )
  })

  it("does not wander upward from the declared root", () => {
    // An ancestor .beads must not be adopted: the declared root IS the search,
    // not its starting point. The resolver returns that root's own path even
    // when nothing is there — absence is the store's existence check to make,
    // and conflating "no root declared" with "root declared, nothing to adopt"
    // would make the skip note lie.
    const outer = join(fixture, "outer")
    const outerCursor = plantStrayStub(outer, "outer-1")
    const inner = join(outer, "packages", "inner")
    mkdirSync(inner, { recursive: true })

    const resolved = resolveLegacyGitHubCursorPath({ [TRIBE_PROJECT_ROOT_ENV]: inner })
    expect(resolved).toBe(resolve(inner, ".beads", "github-cursor.json"))
    expect(resolved).not.toBe(outerCursor)

    // The claim that matters, through the real consumer: the ancestor's cursor
    // is not adopted and not removed.
    const stateDir = join(fixture, "outer-state")
    mkdirSync(stateDir, { recursive: true })
    const store = openGitHubCursorStore({ stateDir, legacyPath: resolved })
    expect(store.state.repos["o/r"]).toBeUndefined()
    const outerState = JSON.parse(readFileSync(outerCursor, "utf8")) as {
      repos: Record<string, { lastEventId: string }>
    }
    expect(outerState.repos["o/r"]?.lastEventId).toBe("outer-1")
  })

  it("treats a blank declared root as undeclared", () => {
    const stray = join(fixture, "blank-cwd")
    mkdirSync(stray, { recursive: true })
    plantStrayStub(stray, "blank-1")
    process.chdir(stray)

    expect(resolveLegacyGitHubCursorPath({ [TRIBE_PROJECT_ROOT_ENV]: "   " })).toBeNull()
  })

  it("neither adopts nor dies on a stray stub that conflicts with the real cursor", () => {
    // The end-to-end claim from the rider, on the real store: a daemon started
    // in an arbitrary directory holding a conflicting stub must open cleanly
    // and keep its own state.
    const stray = join(fixture, "hostile-cwd")
    mkdirSync(stray, { recursive: true })
    const strayCursor = plantStrayStub(stray, "stray-conflicting")
    process.chdir(stray)

    const stateDir = join(fixture, "state")
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(
      join(stateDir, "github-cursor.json"),
      JSON.stringify({ repos: { "o/r": { lastEventId: "real-cursor", lastPollAt: "2026-08-13T01:00:00Z" } } }),
    )

    const store = openGitHubCursorStore({
      stateDir,
      legacyPath: resolveLegacyGitHubCursorPath({}),
    })

    expect(store.state.repos["o/r"]?.lastEventId).toBe("real-cursor")
    // Not adopted, and — just as important — not deleted: the stub is not ours
    // to remove, and a daemon that silently ate it would be worse.
    const strayState = JSON.parse(readFileSync(strayCursor, "utf8")) as {
      repos: Record<string, { lastEventId: string }>
    }
    expect(strayState.repos["o/r"]?.lastEventId).toBe("stray-conflicting")
  })
})
