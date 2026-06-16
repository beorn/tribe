/**
 * checkHookConfig localConfigPresent (@km/bearly/19221/19988) — a root WITHOUT a
 * local `.claude/settings.json` (the clean/temp integration-root shape) must
 * report hook config as UNKNOWN-for-this-root, not absent: localConfigPresent
 * false, the probed path surfaced, and NO misleading "not configured"
 * recommendations (which would imply all hooks are globally absent).
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { checkHookConfig } from "../src/history/scanner.ts"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "recall-hookcfg-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("checkHookConfig — localConfigPresent (19988)", () => {
  test("no local .claude/settings.json → unknown-not-absent, no 'not configured' noise", () => {
    const recs: string[] = []
    const hk = checkHookConfig(root, recs)

    expect(hk.localConfigPresent).toBe(false)
    expect(hk.localConfigPath).toBe(join(root, ".claude", "settings.json"))
    // The configured-flags are unknown for this root — DO NOT emit the misleading
    // "hook not configured" recommendations that imply global absence.
    expect(recs.join("\n")).not.toMatch(/not configured/i)
    expect(recs.join("\n")).toMatch(/UNKNOWN for this root/i)
  })

  test("present local config → localConfigPresent true and flags are judged", () => {
    mkdirSync(join(root, ".claude"), { recursive: true })
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ hooks: { UserPromptSubmit: [], SessionEnd: [] } }),
    )
    const recs: string[] = []
    const hk = checkHookConfig(root, recs)

    expect(hk.localConfigPresent).toBe(true)
    expect(hk.userPromptSubmitConfigured).toBe(true)
    expect(hk.sessionEndConfigured).toBe(true)
  })
})
