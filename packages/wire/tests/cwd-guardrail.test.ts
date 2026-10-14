import { describe, expect, it } from "vitest"
import { evaluateCwdPolicy, migrationOneLiner } from "../src/lib/cwd-guardrail.ts"
import type { CwdProbe } from "../src/lib/cwd-guardrail.ts"

// 29355 — the main-CWD warning must name the CURRENT remedy (/worktree plus an
// owned Yrd environment) and must not advertise a retired worktree command or a
// permanent policy bypass. Read-only main coordination stays explicit.

const mainOnMainWithPool: CwdProbe = {
  cwd: "/repo",
  gitRoot: "/repo",
  headBranch: "main",
  siblingPoolSlots: ["repo-wt0"],
}

function warnText(): string {
  const ev = evaluateCwdPolicy("warn", mainOnMainWithPool)
  if (ev.kind !== "warn") throw new Error(`expected kind=warn, got ${ev.kind}`)
  return ev.message
}

describe("cwd-guardrail warn text (29355)", () => {
  it("names /worktree and the owned Yrd environment route", () => {
    const message = warnText()
    expect(message).toContain("/worktree")
    expect(message).toContain("owned Yrd environment")
    expect(message).toContain("yrd env open --issue")
  })

  it("drops the retired worktree command and the permanent bypass advice", () => {
    const message = warnText()
    expect(message).not.toContain("bun worktree create")
    expect(message).not.toContain("BEARLY_ALLOW_MAIN_REPO_CWD")
    expect(message).not.toContain("TRIBE_MAIN_REPO_POLICY")
  })

  it("keeps legitimate read-only main coordination explicit", () => {
    expect(warnText()).toMatch(/read-only for coordination/i)
  })

  it("carries the corrected remedy into the refuse variant", () => {
    const ev = evaluateCwdPolicy("refuse", mainOnMainWithPool)
    if (ev.kind !== "refuse") throw new Error(`expected kind=refuse, got ${ev.kind}`)
    expect(ev.message).toContain("/worktree")
    expect(ev.message).not.toContain("bun worktree create")
  })

  it("migrationOneLiner points at /worktree and the owned environment route", () => {
    const line = migrationOneLiner("/repo")
    expect(line).toContain("/worktree")
    expect(line).toContain("yrd env open --issue")
  })
})
