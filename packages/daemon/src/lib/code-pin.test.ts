/**
 * @km/tribe/20033 — stale daemon code detector.
 *
 * Reproduces the @km/tribe/20032 stale-code class deterministically: a process
 * that loaded commit A keeps running while the checkout advances to commit B.
 * The pure decision is unit-tested; the real git path is exercised against a
 * throwaway temp repo (mirrors name-claim-replay-clamp.test.ts temp-dir style).
 */

import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { evaluateCodePin, gatherCodePin } from "./code-pin.ts"

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
  function gitc(args: string[]): string {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()
  }
  function commit(msg: string): string {
    gitc(["commit", "--allow-empty", "-m", msg])
    return gitc(["rev-parse", "HEAD"])
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "code-pin-"))
    execFileSync("git", ["-C", repo, "init", "-q"], { encoding: "utf8" })
    gitc(["config", "user.email", "t@example.com"])
    gitc(["config", "user.name", "t"])
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
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
})
