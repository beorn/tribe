/**
 * @km/tribe pin-direction primitives — real git path, temp repo.
 *
 * Live specimen 2026-08-13: a daemon health report showed on-disk checkout
 * c15f7d1bb7aa and superproject_pin 60a5c3c8816a, with 60a5c3c8816a an
 * ANCESTOR of c15f7d1bb7aa (checkout 6 commits ahead). The stale-pin remedy
 * text assumed the checkout was always the one behind and told an operator
 * to `git submodule update --init` — which would have rolled a good checkout
 * backward onto the stale pin. These tests pin down the ancestry primitives
 * that the direction-aware fix (code-pin.ts, cli/read.ts) is built on, against
 * real git rather than fabricated strings, mirroring code-pin.test.ts's
 * "real git path, temp repo" style.
 */

import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { realpathSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { probeIsAncestor, resolvePinDirection } from "../src/lib/code-identity.ts"

describe("probeIsAncestor / resolvePinDirection (real git, temp repo)", () => {
  let repo: string
  let base: string
  let child: string
  let other: string

  function gitc(args: string[]): string {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()
  }
  function commit(msg: string): string {
    gitc(["commit", "--allow-empty", "-m", msg])
    return gitc(["rev-parse", "HEAD"])
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "pin-direction-"))
    execFileSync("git", ["-C", repo, "init", "-q"], { encoding: "utf8" })
    gitc(["config", "user.email", "t@example.com"])
    gitc(["config", "user.name", "t"])
    base = commit("base")
    child = commit("child, one ahead of base")
    gitc(["checkout", "-q", "-b", "other-line", base])
    other = commit("other, a sibling of child — diverged from it")
  })

  afterEach(() => {
    const within = realpathSync(tmpdir())
    safeRemoveSync(repo, { within, allowMissing: true })
  })

  describe("probeIsAncestor", () => {
    it("exit 0 (base IS an ancestor of child) → ok:true, isAncestor:true", () => {
      expect(probeIsAncestor(repo, base, child)).toEqual({ ok: true, isAncestor: true })
    })

    it("exit 1 (child is NOT an ancestor of base) → ok:true, isAncestor:false — a definitive negative, not a failure", () => {
      expect(probeIsAncestor(repo, child, base)).toEqual({ ok: true, isAncestor: false })
    })

    it("exit 1 for two diverged commits, checked both directions", () => {
      expect(probeIsAncestor(repo, child, other)).toEqual({ ok: true, isAncestor: false })
      expect(probeIsAncestor(repo, other, child)).toEqual({ ok: true, isAncestor: false })
    })

    it("an object unknown to this checkout is a real failure (exit >1), never folded into isAncestor:false", () => {
      const bogus = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
      const probe = probeIsAncestor(repo, base, bogus)
      expect(probe.ok).toBe(false)
      if (probe.ok) throw new Error("unreachable")
      expect(probe.failure.errno).not.toBe("exit-1")
      expect(probe.failure.message).toContain(bogus)
    })
  })

  describe("resolvePinDirection", () => {
    it("onDisk ahead of pin (pin is an ancestor of onDisk) → checkout-ahead", () => {
      expect(resolvePinDirection(repo, child, base)).toBe("checkout-ahead")
    })

    it("onDisk behind pin (onDisk is an ancestor of pin) → checkout-behind", () => {
      expect(resolvePinDirection(repo, base, child)).toBe("checkout-behind")
    })

    it("neither is an ancestor of the other → divergent", () => {
      expect(resolvePinDirection(repo, child, other)).toBe("divergent")
    })

    it("pin references an object this checkout doesn't have → unknown, never guessed", () => {
      expect(resolvePinDirection(repo, child, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).toBe("unknown")
    })
  })
})
