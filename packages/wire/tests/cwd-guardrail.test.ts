/**
 * @ag/tribe/21669 — the cwd-guardrail warn/refuse message pointed agents at
 * `bun worktree create wtN`, a retired command, and carried no session
 * identity. This module had no test coverage at all before this change (it
 * was moved in from another repo per the wire CHANGELOG, and the move
 * apparently dropped its tests) — this file is new, not an update.
 *
 * Two things pinned here:
 *   1. `evaluateCwdPolicy`'s warn/refuse message names the current entry
 *      points (`yrd env open`, `hab up`) instead of the retired one-liner.
 *   2. `describeGuardrailEvent` prefixes a message with session identity, so
 *      a burst of these on the fleet event log can be told apart by session
 *      instead of looking like one session repeating itself.
 */
import { describe, expect, it } from "vitest"
import {
  describeGuardrailEvent,
  evaluateCwdPolicy,
  migrationGuidance,
  type CwdProbe,
} from "../src/lib/cwd-guardrail.ts"

const MAIN_REPO_PROBE: CwdProbe = {
  cwd: "/repo/km",
  gitRoot: "/repo/km",
  headBranch: "main",
  siblingPoolSlots: ["km-wt0", "km-wt1"],
}

describe("migrationGuidance", () => {
  it("names the current entry points, not the retired worktree one-liner", () => {
    const guidance = migrationGuidance()
    expect(guidance).toContain("yrd env open --issue <bead>")
    expect(guidance).toContain("hab up <seat>")
    expect(guidance).not.toContain("bun worktree create")
  })
})

describe("evaluateCwdPolicy warn/refuse message", () => {
  it("warn message carries the current guidance and no retired command", () => {
    const result = evaluateCwdPolicy("warn", MAIN_REPO_PROBE)
    expect(result.kind).toBe("warn")
    if (result.kind !== "warn") throw new Error("unreachable")
    expect(result.message).toContain("yrd env open --issue <bead>")
    expect(result.message).toContain("hab up <seat>")
    expect(result.message).not.toContain("bun worktree create")
    expect(result.message).not.toContain("bun worktree clean")
    // Silence hint must survive — it's the documented escape hatch.
    expect(result.message).toContain("TRIBE_MAIN_REPO_POLICY=ignore")
    expect(result.message).toContain("BEARLY_ALLOW_MAIN_REPO_CWD=1")
  })

  it("refuse message is REFUSE-prefixed and carries the same current guidance", () => {
    const result = evaluateCwdPolicy("refuse", MAIN_REPO_PROBE)
    expect(result.kind).toBe("refuse")
    if (result.kind !== "refuse") throw new Error("unreachable")
    expect(result.message).toMatch(/^REFUSE:/)
    expect(result.message).toContain("yrd env open --issue <bead>")
    expect(result.message).not.toContain("bun worktree create")
  })
})

describe("describeGuardrailEvent", () => {
  it("prefixes the message with session identity so a fleet-log reader can tell sessions apart", () => {
    const described = describeGuardrailEvent({
      name: "@dev/5",
      pid: 4242,
      cwd: "/repo/km",
      message: "tribe: standalone session running in main repo (km) on branch main.",
    })
    expect(described).toBe(
      "[session=@dev/5 pid=4242 cwd=/repo/km] tribe: standalone session running in main repo (km) on branch main.",
    )
  })

  it("two different sessions describing the identical underlying message produce distinguishable output", () => {
    const base = { message: "identical guardrail text for both sessions" }
    const a = describeGuardrailEvent({ name: "@dev/5", pid: 100, cwd: "/repo/km", ...base })
    const b = describeGuardrailEvent({ name: "@dev/9", pid: 200, cwd: "/repo/km", ...base })
    expect(a).not.toBe(b)
  })
})
