/**
 * @km/tribe/20033 — stale daemon code detector.
 *
 * Reproduces the @km/tribe/20032 stale-code class deterministically: a process
 * that loaded commit A keeps running while the checkout advances to commit B.
 * The pure decision is unit-tested; the real git path is exercised against a
 * throwaway temp repo (mirrors name-claim-replay-clamp.test.ts temp-dir style).
 */

import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync } from "node:fs"
import { safeRemoveSync } from "removely"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { evaluateCodePin, gatherCodePin } from "./code-pin.ts"

const tribeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")

function cleanGitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
}

function cleanGit(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: cleanGitEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return null
  }
}

describe("evaluateCodePin (pure decision)", () => {
  it("reports STALE when the running code differs from the on-disk checkout", () => {
    const r = evaluateCodePin({ running: "aaaaaaaa1111", onDisk: "bbbbbbbb2222", superprojectPin: "bbbbbbbb2222" })
    expect(r.stale).toBe(true)
    expect(r.reason).toMatch(/restart the daemon/)
    expect(r.reason).toContain("aaaaaaaa1111")
    expect(r.reason).toContain("bbbbbbbb2222")
  })

  it("reports STALE when the checkout differs from the superproject pin", () => {
    const r = evaluateCodePin({ running: "cccc", onDisk: "cccc", superprojectPin: "dddd" })
    expect(r.stale).toBe(true)
    expect(r.reason).toMatch(/submodule update/)
  })

  it("is fresh when running == on-disk == pin", () => {
    expect(evaluateCodePin({ running: "eeee", onDisk: "eeee", superprojectPin: "eeee" })).toEqual({
      stale: false,
      reason: null,
    })
  })

  it("never false-alarms when a SHA is indeterminate (null)", () => {
    expect(evaluateCodePin({ running: null, onDisk: "ffff", superprojectPin: null }).stale).toBe(false)
    expect(evaluateCodePin({ running: "ffff", onDisk: null, superprojectPin: null }).stale).toBe(false)
  })
})

describe("gatherCodePin (real git path, temp repo)", () => {
  let repo: string
  let fakeRepo: string
  function gitc(args: string[]): string {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()
  }
  function fakeGit(args: string[]): string {
    return execFileSync("git", ["-C", fakeRepo, ...args], { encoding: "utf8" }).trim()
  }
  function commit(msg: string): string {
    gitc(["commit", "--allow-empty", "-m", msg])
    return gitc(["rev-parse", "HEAD"])
  }

  function pollutedGitEnv(): NodeJS.ProcessEnv {
    return {
      ...cleanGitEnv(),
      GIT_DIR: join(fakeRepo, ".git"),
      GIT_WORK_TREE: fakeRepo,
      GIT_INDEX_FILE: join(fakeRepo, ".git", "index"),
      GIT_OBJECT_DIRECTORY: join(fakeRepo, ".git", "objects"),
    }
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "code-pin-"))
    fakeRepo = mkdtempSync(join(tmpdir(), "code-pin-pollution-"))
    execFileSync("git", ["-C", repo, "init", "-q"], { encoding: "utf8" })
    gitc(["config", "user.email", "t@example.com"])
    gitc(["config", "user.name", "t"])
    execFileSync("git", ["-C", fakeRepo, "init", "-q"], { encoding: "utf8" })
    fakeGit(["config", "user.email", "t@example.com"])
    fakeGit(["config", "user.name", "t"])
  })
  afterEach(() => {
    const within = realpathSync(tmpdir())
    safeRemoveSync(repo, { within, allowMissing: true })
    safeRemoveSync(fakeRepo, { within, allowMissing: true })
  })

  it("reproduces the stale-code class: process loaded A, checkout advanced to B", () => {
    const shaA = commit("integrated fix landed elsewhere; this process loaded A")
    const shaB = commit("checkout advanced to B after the daemon started")
    expect(shaA).not.toBe(shaB)

    const status = gatherCodePin(repo, shaA) // startupSha = the old commit the process loaded
    expect(status.running).toBe(shaA)
    expect(status.on_disk).toBe(shaB)
    expect(status.stale).toBe(true)
    expect(status.reason).toMatch(/restart the daemon/)
  })

  it("is fresh when the process loaded the current on-disk commit", () => {
    const sha = commit("only commit")
    const status = gatherCodePin(repo, sha)
    expect(status.running).toBe(sha)
    expect(status.on_disk).toBe(sha)
    // Standalone temp repo: no superproject, so superproject_pin is null (visible, not masked).
    expect(status.superproject_pin).toBeNull()
    expect(status.stale).toBe(false)
  })

  it("reports the requested checkout rather than a caller-selected GIT_* repository", () => {
    const sourceSha = commit("actual daemon source")
    fakeGit(["commit", "--allow-empty", "-m", "caller-selected fake source"])
    const fakeSha = fakeGit(["rev-parse", "HEAD"])
    expect(fakeSha).not.toBe(sourceSha)

    const expectedLiveSha = cleanGit(tribeRoot, "rev-parse", "HEAD")
    const superproject = cleanGit(tribeRoot, "rev-parse", "--show-superproject-working-tree")
    const top = cleanGit(tribeRoot, "rev-parse", "--show-toplevel")
    const expectedPin =
      superproject && top ? cleanGit(superproject, "rev-parse", `HEAD:${relative(superproject, top)}`) : null
    const script = `import { STARTUP_SHA, gatherCodePin } from "./packages/daemon/src/lib/code-pin.ts"; process.stdout.write(JSON.stringify({ startup: STARTUP_SHA, live: gatherCodePin(), requested: gatherCodePin(${JSON.stringify(repo)}, ${JSON.stringify(sourceSha)}) }))`
    const result = JSON.parse(
      execFileSync("bun", ["-e", script], {
        cwd: tribeRoot,
        encoding: "utf8",
        env: pollutedGitEnv(),
      }),
    ) as {
      startup: string | null
      live: ReturnType<typeof gatherCodePin>
      requested: ReturnType<typeof gatherCodePin>
    }

    expect(result.startup).toBe(expectedLiveSha)
    expect(result.live.running).toBe(expectedLiveSha)
    expect(result.live.on_disk).toBe(expectedLiveSha)
    expect(result.live.superproject_pin).toBe(expectedPin)
    expect(result.live.stale).toBe(Boolean(expectedLiveSha && expectedPin && expectedLiveSha !== expectedPin))

    const status = result.requested
    expect(status.running).toBe(sourceSha)
    expect(status.on_disk).toBe(sourceSha)
    expect(status.superproject_pin).toBeNull()
    expect(status.stale).toBe(false)
    expect(status.reason).toBeNull()
  })
})
