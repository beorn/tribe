import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  clearReaperExempt,
  isReaperExempt,
  listReaperExempt,
  reaperExemptMarkerPath,
  resolveReaperExemptDir,
  setReaperExempt,
} from "../src/reaper-exempt.ts"

// @km/infra/reaper-and-cwd-guard-hardening-followons gap 1 — a live #undead repro
// must be EXEMPT from the health-reaper's unclaimed-after-60s auto-kill.

describe("reaper-exempt markers (gap 1)", () => {
  let dir: string
  let env: NodeJS.ProcessEnv
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reaper-exempt-"))
    env = { XDG_RUNTIME_DIR: dir }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("dir + marker path live under the XDG runtime dir (daemon + CLI compute the same)", () => {
    expect(resolveReaperExemptDir(env)).toBe(join(dir, "reaper-exempt"))
    expect(reaperExemptMarkerPath(7, env)).toBe(join(dir, "reaper-exempt", "7"))
  })

  it("a fresh pid is NOT exempt; set → exempt; clear → not exempt (round-trip)", () => {
    expect(isReaperExempt(4242, env)).toBe(false)
    setReaperExempt(4242, "flicker repro 20341", env)
    expect(isReaperExempt(4242, env)).toBe(true)
    expect(clearReaperExempt(4242, env)).toBe(true)
    expect(isReaperExempt(4242, env)).toBe(false)
  })

  it("clear returns false when there was no marker (caller surfaces it loudly, never silent)", () => {
    expect(clearReaperExempt(9999, env)).toBe(false)
  })

  it("set is idempotent and stores the reason for --list provenance", () => {
    setReaperExempt(7, "under investigation", env)
    setReaperExempt(7, "under investigation", env) // idempotent — no throw, no dup
    setReaperExempt(13, "", env)
    expect(listReaperExempt(env).sort((a, b) => a.pid - b.pid)).toEqual([
      { pid: 7, reason: "under investigation" },
      { pid: 13, reason: "" },
    ])
  })

  it("list is empty when nothing is marked (no dir yet) and ignores non-pid files", () => {
    expect(listReaperExempt(env)).toEqual([])
    setReaperExempt(5, "x", env)
    writeFileSync(join(resolveReaperExemptDir(env), "README"), "noise") // stray non-pid file
    expect(listReaperExempt(env).map((e) => e.pid)).toEqual([5])
  })
})
