/**
 * @failure two commits between polls or a linked worktree commit disappear behind a HEAD-only Git poll.
 * @level l1
 * @consumer the Git connector publishing typed commit facts into Wire's journal.
 * @testonly none
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { observeGitSource } from "./git-connector.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

function commit(cwd: string, subject: string): string {
  git(cwd, "commit", "--allow-empty", "-m", subject)
  return git(cwd, "rev-parse", "HEAD")
}

function fact(content: string): { oid: string; subjects: { binds: string[]; refs: string[]; closes: string[] } } {
  return JSON.parse(content) as { oid: string; subjects: { binds: string[]; refs: string[]; closes: string[] } }
}

describe("typed Git source observation", () => {
  it("enumerates every retained commit in parent order across polls and linked worktrees", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-git-connector-"))
    dirs.push(dir)
    const repo = join(dir, "repo")
    const worktree = join(dir, "feature")
    git(dir, "init", "-q", repo)
    git(repo, "config", "user.name", "Connector Test")
    git(repo, "config", "user.email", "connector@example.invalid")
    commit(repo, "baseline")
    const source = {
      logicalSourceId: "code",
      contractVersion: "git.commit.v1",
      bindings: [{ id: "main", checkout: repo }],
      selectedRefs: ["refs/heads/*"],
      start: { kind: "baseline-now" },
      decoder: { version: "1", trailers: { binds: ["Binds"], refs: ["Refs"], closes: ["Resolves"] } },
    } as const

    const baseline = await observeGitSource(source, null)
    expect(baseline.kind).toBe("observed")
    if (baseline.kind !== "observed") return
    expect(baseline.events).toEqual([])

    const first = commit(repo, "one\n\nRefs: #25045")
    const second = commit(repo, "two\n\nResolves: #25045")
    const burst = await observeGitSource(source, baseline.frontier)
    expect(burst.kind).toBe("observed")
    if (burst.kind !== "observed") return
    expect(burst.events.map((event) => fact(event.content).oid)).toEqual([first, second])
    const compact = JSON.parse(burst.frontier) as {
      bindings: { main: { tips: Record<string, string>; reflogs: Record<string, { count: number }> } }
    }
    expect(Object.keys(compact.bindings.main.tips).some((key) => key.startsWith("reflog:"))).toBe(false)
    expect(
      Object.entries(compact.bindings.main.reflogs).some(
        ([ref, cursor]) => ref.startsWith("refs/heads/") && cursor.count >= 3,
      ),
    ).toBe(true)
    expect(fact(burst.events[0]!.content).subjects.refs).toEqual(["#25045"])
    expect(fact(burst.events[1]!.content).subjects.closes).toEqual(["#25045"])

    git(repo, "worktree", "add", "-q", "-b", "feature", worktree)
    const third = commit(worktree, "feature\n\nBinds: #25045")
    const next = await observeGitSource(source, burst.frontier)
    expect(next.kind).toBe("observed")
    if (next.kind !== "observed") return
    expect(next.events.map((event) => fact(event.content).oid)).toEqual([third])
    expect(fact(next.events[0]!.content).subjects.binds).toEqual(["#25045"])
    const replay = await observeGitSource(source, next.frontier)
    expect(replay.kind).toBe("observed")
    if (replay.kind === "observed") expect(replay.events).toEqual([])
  })

  it("names a gap instead of moving past a previously recorded missing object", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-git-gap-"))
    dirs.push(dir)
    const repo = join(dir, "repo")
    git(dir, "init", "-q", repo)
    git(repo, "config", "user.name", "Connector Test")
    git(repo, "config", "user.email", "connector@example.invalid")
    commit(repo, "baseline")
    const source = {
      logicalSourceId: "code",
      contractVersion: "git.commit.v1",
      bindings: [{ id: "main", checkout: repo }],
      selectedRefs: ["refs/heads/*"],
      start: { kind: "baseline-now" },
      decoder: { version: "1", trailers: { binds: ["Binds"], refs: ["Refs"], closes: ["Resolves"] } },
    } as const
    const baseline = await observeGitSource(source, null)
    expect(baseline.kind).toBe("observed")
    if (baseline.kind !== "observed") return
    const missing = JSON.parse(baseline.frontier) as { bindings: Record<string, { tips: Record<string, string> }> }
    missing.bindings.main!.tips["refs/heads/missing"] = "f".repeat(40)
    const result = await observeGitSource(source, JSON.stringify(missing))
    expect(result).toMatchObject({ kind: "source-gap", sourceId: "code" })
  })

  it("keeps each declared linked worktree's HEAD reflog even when both share one Git store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-git-linked-head-"))
    dirs.push(dir)
    const repo = join(dir, "repo")
    const worktree = join(dir, "detached")
    git(dir, "init", "-q", repo)
    git(repo, "config", "user.name", "Connector Test")
    git(repo, "config", "user.email", "connector@example.invalid")
    const base = commit(repo, "baseline")
    git(repo, "worktree", "add", "-q", "--detach", worktree, base)
    const source = {
      logicalSourceId: "code",
      contractVersion: "git.commit.v1",
      bindings: [
        { id: "a-main", checkout: repo },
        { id: "z-detached", checkout: worktree },
      ],
      selectedRefs: ["refs/heads/*"],
      start: { kind: "baseline-now" },
      decoder: { version: "1", trailers: { binds: ["Binds"], refs: ["Refs"], closes: ["Resolves"] } },
    } as const
    const baseline = await observeGitSource(source, null)
    expect(baseline.kind).toBe("observed")
    if (baseline.kind !== "observed") return
    const detached = commit(worktree, "unbranched worktree commit")
    git(worktree, "switch", "-q", "--detach", base)
    const observed = await observeGitSource(source, baseline.frontier)
    expect(observed.kind).toBe("observed")
    if (observed.kind === "observed") {
      expect(observed.events.map((event) => fact(event.content).oid)).toEqual([detached])
    }
  })

  it("reads separately declared nested repositories without mixing their source identities", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-git-nested-"))
    dirs.push(dir)
    const outer = join(dir, "outer")
    const inner = join(outer, "inner")
    git(dir, "init", "-q", outer)
    git(outer, "config", "user.name", "Connector Test")
    git(outer, "config", "user.email", "connector@example.invalid")
    commit(outer, "outer baseline")
    git(outer, "init", "-q", inner)
    git(inner, "config", "user.name", "Connector Test")
    git(inner, "config", "user.email", "connector@example.invalid")
    commit(inner, "inner baseline")
    const source = (id: string, checkout: string) =>
      ({
        logicalSourceId: id,
        contractVersion: "git.commit.v1",
        bindings: [{ id: "main", checkout }],
        selectedRefs: ["refs/heads/*"],
        start: { kind: "baseline-now" },
        decoder: { version: "1", trailers: { binds: ["Binds"], refs: ["Refs"], closes: ["Resolves"] } },
      }) as const
    const outerStart = await observeGitSource(source("outer", outer), null)
    const innerStart = await observeGitSource(source("inner", inner), null)
    expect(outerStart.kind).toBe("observed")
    expect(innerStart.kind).toBe("observed")
    if (outerStart.kind !== "observed" || innerStart.kind !== "observed") return
    const outerOid = commit(outer, "outer next")
    const innerOid = commit(inner, "inner next")
    const outerNext = await observeGitSource(source("outer", outer), outerStart.frontier)
    const innerNext = await observeGitSource(source("inner", inner), innerStart.frontier)
    expect(outerNext.kind).toBe("observed")
    expect(innerNext.kind).toBe("observed")
    if (outerNext.kind === "observed" && innerNext.kind === "observed") {
      expect(outerNext.events.map((event) => fact(event.content).oid)).toEqual([outerOid])
      expect(innerNext.events.map((event) => fact(event.content).oid)).toEqual([innerOid])
    }
  })

  it("deduplicates one logical source across explicitly declared clones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-git-clones-"))
    dirs.push(dir)
    const original = join(dir, "original")
    const clone = join(dir, "clone")
    git(dir, "init", "-q", original)
    git(original, "config", "user.name", "Connector Test")
    git(original, "config", "user.email", "connector@example.invalid")
    commit(original, "baseline")
    git(dir, "clone", "-q", original, clone)
    git(clone, "config", "user.name", "Connector Test")
    git(clone, "config", "user.email", "connector@example.invalid")
    const source = {
      logicalSourceId: "shared",
      contractVersion: "git.commit.v1",
      bindings: [
        { id: "original", checkout: original },
        { id: "clone", checkout: clone },
      ],
      selectedRefs: ["refs/heads/*"],
      start: { kind: "baseline-now" },
      decoder: { version: "1", trailers: { binds: ["Binds"], refs: ["Refs"], closes: ["Resolves"] } },
    } as const
    const baseline = await observeGitSource(source, null)
    expect(baseline.kind).toBe("observed")
    if (baseline.kind !== "observed") return
    const fromOriginal = commit(original, "original next")
    const fromClone = commit(clone, "clone next")
    const observed = await observeGitSource(source, baseline.frontier)
    expect(observed.kind).toBe("observed")
    if (observed.kind === "observed") {
      expect(new Set(observed.events.map((event) => fact(event.content).oid))).toEqual(
        new Set([fromOriginal, fromClone]),
      )
    }
  })

  it("imports only after an explicit starting revision on first observation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-git-after-"))
    dirs.push(dir)
    const repo = join(dir, "repo")
    git(dir, "init", "-q", repo)
    git(repo, "config", "user.name", "Connector Test")
    git(repo, "config", "user.email", "connector@example.invalid")
    const baseline = commit(repo, "baseline")
    const first = commit(repo, "first")
    const second = commit(repo, "second")
    const observed = await observeGitSource(
      {
        logicalSourceId: "code",
        contractVersion: "git.commit.v1",
        bindings: [{ id: "main", checkout: repo }],
        selectedRefs: ["refs/heads/*"],
        start: { kind: "after", revision: baseline },
        decoder: { version: "1", trailers: { binds: ["Binds"], refs: ["Refs"], closes: ["Resolves"] } },
      },
      null,
    )
    expect(observed.kind).toBe("observed")
    if (observed.kind === "observed") {
      expect(observed.events.map((event) => fact(event.content).oid)).toEqual([first, second])
    }
  })

  it("publishes a rewritten branch's new commit once without replaying its former tip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-git-rewrite-"))
    dirs.push(dir)
    const repo = join(dir, "repo")
    git(dir, "init", "-q", repo)
    git(repo, "config", "user.name", "Connector Test")
    git(repo, "config", "user.email", "connector@example.invalid")
    const base = commit(repo, "baseline")
    const branch = git(repo, "symbolic-ref", "--short", "HEAD")
    const source = {
      logicalSourceId: "code",
      contractVersion: "git.commit.v1",
      bindings: [{ id: "main", checkout: repo }],
      selectedRefs: ["refs/heads/*"],
      start: { kind: "baseline-now" },
      decoder: { version: "1", trailers: { binds: ["Binds"], refs: ["Refs"], closes: ["Resolves"] } },
    } as const
    const baseline = await observeGitSource(source, null)
    expect(baseline.kind).toBe("observed")
    if (baseline.kind !== "observed") return

    const formerTip = commit(repo, "former tip")
    const first = await observeGitSource(source, baseline.frontier)
    expect(first.kind).toBe("observed")
    if (first.kind !== "observed") return
    expect(first.events.map((event) => fact(event.content).oid)).toEqual([formerTip])

    git(repo, "switch", "-q", "--detach", base)
    const replacement = commit(repo, "replacement tip")
    git(repo, "switch", "-q", branch)
    git(repo, "update-ref", "-m", "rewrite branch", `refs/heads/${branch}`, replacement, formerTip)
    const rewritten = await observeGitSource(source, first.frontier)
    expect(rewritten.kind).toBe("observed")
    if (rewritten.kind !== "observed") return
    expect(rewritten.events.map((event) => fact(event.content).oid)).toEqual([replacement])
    expect(rewritten.events[0]?.id).not.toBe(first.events[0]?.id)
    expect(rewritten.frontier).not.toBe(first.frontier)

    const replay = await observeGitSource(source, rewritten.frontier)
    expect(replay.kind).toBe("observed")
    if (replay.kind === "observed") {
      expect(replay.events).toEqual([])
      expect(replay.frontier).toBe(rewritten.frontier)
    }
  })

  it("refuses a changed ref selection before reusing the old frontier", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-git-config-drift-"))
    dirs.push(dir)
    const repo = join(dir, "repo")
    git(dir, "init", "-q", repo)
    git(repo, "config", "user.name", "Connector Test")
    git(repo, "config", "user.email", "connector@example.invalid")
    commit(repo, "baseline")
    const branch = git(repo, "symbolic-ref", "--short", "HEAD")
    const source = {
      logicalSourceId: "code",
      contractVersion: "git.commit.v1",
      bindings: [{ id: "main", checkout: repo }],
      selectedRefs: [`refs/heads/${branch}`],
      start: { kind: "baseline-now" },
      decoder: { version: "1", trailers: { binds: ["Binds"], refs: ["Refs"], closes: ["Resolves"] } },
    } as const
    const baseline = await observeGitSource(source, null)
    expect(baseline.kind).toBe("observed")
    if (baseline.kind !== "observed") return

    const changed = await observeGitSource({ ...source, selectedRefs: ["refs/heads/*"] }, baseline.frontier)
    expect(changed).toMatchObject({ kind: "source-gap", sourceId: "code" })
    if (changed.kind === "source-gap") expect(changed.detail).toMatch(/declaration.*replay policy/u)

    const changedSchema = { ...(JSON.parse(baseline.frontier) as Record<string, unknown>), schemaDigest: "new-schema" }
    expect(await observeGitSource(source, JSON.stringify(changedSchema))).toMatchObject({
      kind: "source-gap",
      sourceId: "code",
    })
  })

  it("recovers a created-and-deleted branch commit from the declared checkout's retained HEAD reflog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tribe-git-deleted-ref-"))
    dirs.push(dir)
    const repo = join(dir, "repo")
    git(dir, "init", "-q", repo)
    git(repo, "config", "user.name", "Connector Test")
    git(repo, "config", "user.email", "connector@example.invalid")
    commit(repo, "baseline")
    const main = git(repo, "symbolic-ref", "--short", "HEAD")
    const source = {
      logicalSourceId: "code",
      contractVersion: "git.commit.v1",
      bindings: [{ id: "main", checkout: repo }],
      selectedRefs: ["refs/heads/*"],
      start: { kind: "baseline-now" },
      decoder: { version: "1", trailers: { binds: ["Binds"], refs: ["Refs"], closes: ["Resolves"] } },
    } as const
    const baseline = await observeGitSource(source, null)
    expect(baseline.kind).toBe("observed")
    if (baseline.kind !== "observed") return
    git(repo, "switch", "-q", "-c", "ephemeral")
    const escaped = commit(repo, "ephemeral work")
    git(repo, "switch", "-q", main)
    git(repo, "branch", "-D", "ephemeral")
    const observed = await observeGitSource(source, baseline.frontier)
    expect(observed.kind).toBe("observed")
    if (observed.kind === "observed") expect(observed.events.map((event) => fact(event.content).oid)).toEqual([escaped])
  })
})
