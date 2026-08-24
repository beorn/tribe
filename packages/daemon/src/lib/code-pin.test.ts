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
    const r = evaluateCodePin({
      running: "aaaaaaaa1111",
      onDisk: "bbbbbbbb2222",
      superprojectPin: "bbbbbbbb2222",
      pinDirection: null,
    })
    expect(r.stale).toBe(true)
    expect(r.reason).toMatch(/restart the daemon/)
    expect(r.reason).toContain("aaaaaaaa1111")
    expect(r.reason).toContain("bbbbbbbb2222")
  })

  it("reports STALE when the checkout differs from the superproject pin, checkout-behind", () => {
    const r = evaluateCodePin({
      running: "cccc",
      onDisk: "cccc",
      superprojectPin: "dddd",
      pinDirection: "checkout-behind",
    })
    expect(r.stale).toBe(true)
    expect(r.reason).toMatch(/submodule update/)
    expect(r.pin_direction).toBe("checkout-behind")
  })

  it("checkout-ahead of the pin must NOT emit the rollback remedy (live specimen 2026-08-13)", () => {
    // Live specimen: on-disk/running were c15f7d1bb7aa, superproject_pin was
    // 60a5c3c8816a, and 60a5c3c8816a was an ANCESTOR of c15f7d1bb7aa — the
    // checkout was 6 commits AHEAD, not behind. The un-fixed code cannot tell
    // direction apart from a raw SHA inequality and always emits the
    // "run `git submodule update --init`" remedy, which would have rolled the
    // running daemon backward by 6 commits and reintroduced a fixed bug.
    const r = evaluateCodePin({
      running: "c15f7d1bb7aa",
      onDisk: "c15f7d1bb7aa",
      superprojectPin: "60a5c3c8816a",
      pinDirection: "checkout-ahead",
    })
    expect(r.stale).toBe(true)
    expect(r.pin_direction).toBe("checkout-ahead")
    // The old, dangerous IMPERATIVE ("run `git submodule update --init`
    // for the tribe path") must be gone — but the fixed text is allowed,
    // and expected, to name the command while explicitly warning against
    // running it, so assert on the imperative phrasing, not the bare words.
    expect(r.reason).not.toMatch(/run `git submodule update --init`/)
    expect(r.reason).toMatch(/do not run `git submodule update`/i)
    expect(r.reason).toMatch(/no daemon action/i)
    expect(r.reason).toMatch(/lags/i)
  })

  it("divergent checkout vs pin recommends investigation, no command", () => {
    const r = evaluateCodePin({
      running: "1111",
      onDisk: "1111",
      superprojectPin: "2222",
      pinDirection: "divergent",
    })
    expect(r.stale).toBe(true)
    expect(r.pin_direction).toBe("divergent")
    expect(r.reason).toMatch(/diverged/i)
    expect(r.reason).not.toMatch(/run `git submodule update --init`/)
    expect(r.reason).not.toMatch(/no daemon action/i)
  })

  it("unresolvable ancestry (unknown-object) fails loud instead of guessing", () => {
    const r = evaluateCodePin({
      running: "3333",
      onDisk: "3333",
      superprojectPin: "4444",
      pinDirection: "unknown",
    })
    expect(r.stale).toBe(true)
    expect(r.pin_direction).toBe("unknown")
    expect(r.reason).toMatch(/unknown-direction/i)
    expect(r.reason).not.toMatch(/run `git submodule update --init`/)
    expect(r.reason).not.toMatch(/no daemon action/i)
  })

  it("is fresh when running == on-disk == pin", () => {
    expect(evaluateCodePin({ running: "eeee", onDisk: "eeee", superprojectPin: "eeee", pinDirection: null })).toEqual({
      stale: false,
      pin_direction: null,
      reason: null,
    })
  })

  it("reports UNKNOWN when a SHA is indeterminate (null)", () => {
    expect(
      evaluateCodePin({ running: null, onDisk: "ffff", superprojectPin: null, pinDirection: null }).stale,
    ).toBeNull()
    expect(
      evaluateCodePin({ running: "ffff", onDisk: null, superprojectPin: null, pinDirection: null }).stale,
    ).toBeNull()
  })

  it("reports UNKNOWN when health cannot resolve any code-pin operand", () => {
    // Live specimen: health.code_pin reported stale:false while all three
    // identity probes were NULL. Equality over unresolved operands is not a
    // freshness proof and must remain visible to the doctor.
    expect(evaluateCodePin({ running: null, onDisk: null, superprojectPin: null, pinDirection: null })).toEqual({
      stale: null,
      pin_direction: null,
      reason: "cannot compare daemon code identity: unresolved running, on_disk, superproject_pin",
    })
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
    expect(status.stale).toBeNull()
    expect(status.reason).toContain("unresolved superproject_pin")
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
    // Mirrors the "is fresh when the process loaded the current on-disk
    // commit" contract above: when there is no superproject pin to compare
    // against (this checkout's own tree, like CI's, is standalone), staleness
    // is unresolved (null), never a certified `false`. The old
    // `Boolean(... && expectedPin && ...)` formula collapsed "unresolved"
    // and "fresh" into the same `false`, which only matched by accident when
    // a real pin happened to be present (@km/tribe/ci-green-wire-codepin).
    expect(result.live.stale).toBe(expectedPin === null ? null : expectedLiveSha !== expectedPin)

    const status = result.requested
    expect(status.running).toBe(sourceSha)
    expect(status.on_disk).toBe(sourceSha)
    expect(status.superproject_pin).toBeNull()
    expect(status.stale).toBeNull()
    expect(status.reason).toContain("unresolved superproject_pin")
  })

  it("resolves checkout-ahead end-to-end against a real submodule pin (live specimen 2026-08-13 shape)", () => {
    // Build the real submodule topology the live specimen came from: a
    // superproject that pins a submodule at commit A, whose checkout has
    // since advanced locally to commit B (a descendant of A) without the
    // superproject's pin being bumped yet — the exact "checkout ahead of
    // pin" shape, constructed with real git rather than fabricated SHAs, to
    // prove the resolvePinDirection wiring in gatherCodePin itself (not just
    // the pure evaluateCodePin decision above).
    const shaA = commit("submodule source, commit A")
    const superRepo = mkdtempSync(join(tmpdir(), "code-pin-super-"))
    try {
      execFileSync("git", ["-C", superRepo, "init", "-q"], { encoding: "utf8" })
      execFileSync("git", ["-C", superRepo, "config", "user.email", "t@example.com"], { encoding: "utf8" })
      execFileSync("git", ["-C", superRepo, "config", "user.name", "t"], { encoding: "utf8" })
      execFileSync(
        "git",
        ["-C", superRepo, "-c", "protocol.file.allow=always", "submodule", "add", repo, "vendor/sub"],
        { encoding: "utf8", stdio: "pipe" },
      )
      execFileSync("git", ["-C", superRepo, "commit", "-q", "-m", "add submodule pinned at A"], { encoding: "utf8" })

      const subCheckout = join(superRepo, "vendor", "sub")
      // `git submodule add` gives subCheckout its own embedded gitdir
      // (superRepo/.git/modules/vendor/sub) — a separate local-config
      // namespace from both `repo` (configured in beforeEach) and `superRepo`
      // (configured just above). Without its own identity here, the commit
      // below falls through to whatever global identity happens to be
      // present in the environment — absent on a bare CI runner, which dies
      // with "Author identity unknown" (@km/tribe/ci-green-wire-codepin).
      // Repo-scoped only, never --global.
      execFileSync("git", ["-C", subCheckout, "config", "user.email", "t@example.com"], { encoding: "utf8" })
      execFileSync("git", ["-C", subCheckout, "config", "user.name", "t"], { encoding: "utf8" })
      execFileSync("git", ["-C", subCheckout, "commit", "-q", "--allow-empty", "-m", "checkout advances to B"], {
        encoding: "utf8",
      })
      const shaB = execFileSync("git", ["-C", subCheckout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
      expect(shaB).not.toBe(shaA)

      const status = gatherCodePin(subCheckout, shaB) // running == on-disk == B; superproject pin still A
      expect(status.on_disk).toBe(shaB)
      expect(status.superproject_pin).toBe(shaA)
      expect(status.pin_direction).toBe("checkout-ahead")
      expect(status.stale).toBe(true)
      expect(status.reason).toMatch(/no daemon action/i)
      expect(status.reason).not.toMatch(/run `git submodule update --init`/)
    } finally {
      const within = realpathSync(tmpdir())
      safeRemoveSync(superRepo, { within, allowMissing: true })
    }
  })
})
