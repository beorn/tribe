/**
 * session-discovery — regression coverage for the chief-recovery bug where
 * `recall current-brief` picked an unrelated, stale Claude transcript instead
 * of the live Codex / ag-profile session (km-bead @km/bearly/19925).
 *
 * Hermetic: builds a fake HOME with both a stale Claude session (in the
 * project slug) and a fresh Codex ag-profile session for the same cwd, then
 * asserts discovery + current-brief pick the Codex session and explain why.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { discoverActiveSession, cwdMatches, renderDiscoveryDiagnostics } from "../src/lib/session-discovery.ts"
import { getCurrentSessionContextWithDiagnostics, renderSessionBriefResult } from "../src/lib/session-context.ts"

let home: string
const CWD = "/Users/test/Code/pim/km"
const CLAUDE_SLUG = CWD.replaceAll("/", "-")

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString()
}

/** Write a Claude-format transcript and set its mtime. */
function writeClaudeSession(sessionId: string, contentAgeMs: number, mtimeAgeMs: number): string {
  const dir = join(home, ".claude", "projects", CLAUDE_SLUG)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sessionId}.jsonl`)
  const lines = [
    JSON.stringify({
      type: "user",
      timestamp: iso(contentAgeMs + 1000),
      message: { role: "user", content: "stale claude session editing old-thing.ts" },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: iso(contentAgeMs),
      message: { role: "assistant", content: [{ type: "text", text: "working the staleTask in old-thing.ts" }] },
    }),
  ]
  writeFileSync(file, lines.join("\n") + "\n", "utf8")
  const t = new Date(Date.now() - mtimeAgeMs)
  utimesSync(file, t, t)
  return file
}

/** Write a Codex rollout transcript under an ag-profile root and set its mtime. */
function writeCodexSession(opts: {
  account: string
  sessionId: string
  cwd: string
  contentAgeMs: number
  mtimeAgeMs: number
}): string {
  const dir = join(home, ".config", "ag", "profiles", "codex", opts.account, "sessions", "2026", "06", "15")
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-2026-06-15T01-09-19-${opts.sessionId}.jsonl`)
  const lines = [
    JSON.stringify({
      timestamp: iso(opts.contentAgeMs + 2000),
      type: "session_meta",
      payload: { id: opts.sessionId, timestamp: iso(opts.contentAgeMs + 2000), cwd: opts.cwd, originator: "codex-tui" },
    }),
    JSON.stringify({
      timestamp: iso(opts.contentAgeMs + 1000),
      type: "response_item",
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "<permissions> ignore me" }],
      },
    }),
    JSON.stringify({
      timestamp: iso(opts.contentAgeMs + 500),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "chief recovery: recall current-brief for previous context" }],
      },
    }),
    JSON.stringify({
      timestamp: iso(opts.contentAgeMs),
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "resuming the recall-reliability epic on session-discovery.ts" }],
        phase: "commentary",
      },
    }),
  ]
  writeFileSync(file, lines.join("\n") + "\n", "utf8")
  const t = new Date(Date.now() - opts.mtimeAgeMs)
  utimesSync(file, t, t)
  return file
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "recall-disco-"))
  delete process.env.CLAUDE_SESSION_ID
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe("cwdMatches", () => {
  test("exact + ancestor relationships match, unrelated does not", () => {
    expect(cwdMatches("/a/b/c", "/a/b/c")).toBe(true)
    expect(cwdMatches("/a/b", "/a/b/c")).toBe(true) // session is ancestor of cwd
    expect(cwdMatches("/a/b/c", "/a/b")).toBe(true) // cwd is ancestor of session
    expect(cwdMatches("/a/b/c", "/a/b/cd")).toBe(false) // sibling-prefix, not ancestor
    expect(cwdMatches("/x/y", "/a/b")).toBe(false)
    expect(cwdMatches(null, "/a/b")).toBe(false)
  })
})

describe("discoverActiveSession", () => {
  test("prefers the fresh Codex session over a stale Claude session in the same project slug", () => {
    // The bug: a stale Claude transcript sits in ~/.claude/projects/<slug>/,
    // while the live session is a fresher Codex ag-profile run for the same cwd.
    writeClaudeSession("b4f1e419-stale-claude", 18 * 60_000, 18 * 60_000)
    const codexFile = writeCodexSession({
      account: "d@delei.org",
      sessionId: "019eca53-codex-fresh",
      cwd: CWD,
      contentAgeMs: 2 * 60_000,
      mtimeAgeMs: 2 * 60_000,
    })

    const { candidate, diagnostics } = discoverActiveSession({ cwd: CWD, homeDir: home })

    expect(candidate).not.toBeNull()
    expect(candidate!.sessionId).toBe("019eca53-codex-fresh")
    expect(candidate!.format).toBe("codex")
    expect(candidate!.path).toBe(codexFile)

    // Diagnostics are always populated and explain the choice.
    expect(diagnostics.matchedCount).toBeGreaterThanOrEqual(2)
    expect(diagnostics.chosen?.sessionId).toBe("019eca53-codex-fresh")
    expect(diagnostics.searchedRoots.some((r) => r.startsWith("claude"))).toBe(true)
    expect(diagnostics.searchedRoots.some((r) => r.startsWith("ag-codex:d@delei.org"))).toBe(true)
    expect(diagnostics.exclusions.join(" ")).toMatch(/older matching session/i)
    expect(renderDiscoveryDiagnostics(diagnostics)).toContain("chosen:")
    // 19988: a real match is NOT cwd-unmatched and carries no remediation.
    expect(diagnostics.cwdUnmatched).toBe(false)
    expect(diagnostics.remediation).toBeNull()
  })

  test("covers ~/.codex/sessions root, not just ag-profile codex", () => {
    const dir = join(home, ".codex", "sessions", "2026", "06", "15")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "rollout-2026-06-15T02-00-00-019ec000-plaincodex.jsonl")
    writeFileSync(
      file,
      JSON.stringify({
        timestamp: iso(60_000),
        type: "session_meta",
        payload: { id: "019ec000-plaincodex", cwd: CWD, originator: "codex-tui" },
      }) +
        "\n" +
        JSON.stringify({
          timestamp: iso(30_000),
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "plain codex cli session" }],
          },
        }) +
        "\n",
      "utf8",
    )
    const t = new Date(Date.now() - 30_000)
    utimesSync(file, t, t)

    const { candidate, diagnostics } = discoverActiveSession({ cwd: CWD, homeDir: home })
    expect(candidate?.sessionId).toBe("019ec000-plaincodex")
    expect(diagnostics.searchedRoots.some((r) => r.startsWith("codex "))).toBe(true)
  })

  test("excludes codex sessions whose cwd does not match, with a reason", () => {
    writeCodexSession({
      account: "d@delei.org",
      sessionId: "019ec111-otherdir",
      cwd: "/Users/test/Code/other/project",
      contentAgeMs: 60_000,
      mtimeAgeMs: 60_000,
    })
    const { candidate, diagnostics } = discoverActiveSession({ cwd: CWD, homeDir: home })
    expect(candidate).toBeNull()
    expect(diagnostics.matchedCount).toBe(0)
    expect(diagnostics.exclusions.join(" ")).toMatch(/cwd mismatch/i)
    // 19988: sessions EXIST but none for this cwd → flag the temp/clean-root
    // shape distinctly, with an actionable remediation.
    expect(diagnostics.candidateCount).toBeGreaterThan(0)
    expect(diagnostics.cwdUnmatched).toBe(true)
    expect(diagnostics.remediation).toMatch(/not a recorded session root/i)
    expect(diagnostics.remediation).toMatch(/live repo root/i)
  })

  test("empty home: reports missing roots and no candidate (NOT cwd-unmatched)", () => {
    const { candidate, diagnostics } = discoverActiveSession({ cwd: CWD, homeDir: home })
    expect(candidate).toBeNull()
    expect(diagnostics.candidateCount).toBe(0)
    expect(diagnostics.missingRoots.length).toBeGreaterThan(0)
    // 19988: a genuine no-session result (0 candidates) is NOT cwd-unmatched —
    // the distinction the temp-root diagnostic depends on.
    expect(diagnostics.cwdUnmatched).toBe(false)
    expect(diagnostics.remediation).toBeNull()
  })
})

describe("provider-agnostic ag profile discovery (19933)", () => {
  /** Write a Claude-format transcript under an explicit projects root (e.g. an ag-profile). */
  function writeClaudeSessionAt(projectsRoot: string, sessionId: string, ageMs: number): string {
    const dir = join(projectsRoot, CLAUDE_SLUG)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${sessionId}.jsonl`)
    writeFileSync(
      file,
      JSON.stringify({
        type: "user",
        timestamp: iso(ageMs),
        message: { role: "user", content: "ag-profile claude work on session-discovery.ts" },
      }) + "\n",
      "utf8",
    )
    const t = new Date(Date.now() - ageMs)
    utimesSync(file, t, t)
    return file
  }

  test("enumerates supported ag providers generically and labels each profile root", () => {
    // A Claude profile with its OWN projects dir (distinct path — not the shared symlink).
    const agClaudeProjects = join(home, ".config", "ag", "profiles", "claude", "work@x.com", "projects")
    writeClaudeSessionAt(agClaudeProjects, "aaaa1111-agclaude", 4 * 60_000)
    // A Codex profile, fresher — should win across providers.
    writeCodexSession({
      account: "work@x.com",
      sessionId: "bbbb2222-agcodex",
      cwd: CWD,
      contentAgeMs: 1 * 60_000,
      mtimeAgeMs: 1 * 60_000,
    })

    const { candidate, diagnostics } = discoverActiveSession({ cwd: CWD, homeDir: home })
    expect(diagnostics.searchedRoots.some((r) => r.startsWith("ag-claude:work@x.com"))).toBe(true)
    expect(diagnostics.searchedRoots.some((r) => r.startsWith("ag-codex:work@x.com"))).toBe(true)
    // Newest relevant session across native + ag-profile roots wins.
    expect(candidate?.sessionId).toBe("bbbb2222-agcodex")
    expect(diagnostics.unsupportedProviders.length).toBe(0)
  })

  test("fails loud on a configured-but-unsupported provider instead of silently ignoring it", () => {
    // grok is a real ag provider (AccountProfileProvider) but recall has no session adapter.
    const grokProfile = join(home, ".config", "ag", "profiles", "grok", "k@x.com")
    mkdirSync(grokProfile, { recursive: true })
    writeFileSync(join(grokProfile, "auth.json"), "{}", "utf8")

    const { diagnostics } = discoverActiveSession({ cwd: CWD, homeDir: home })
    const grok = diagnostics.unsupportedProviders.find((p) => p.provider === "grok")
    expect(grok).toBeDefined()
    expect(grok!.accountCount).toBeGreaterThanOrEqual(1)
    expect(grok!.reason).toMatch(/adapter/i)

    const rendered = renderDiscoveryDiagnostics(diagnostics)
    expect(rendered).toMatch(/grok/)
    expect(rendered).toMatch(/unsupported/i)
  })

  test("an empty provider dir with no configured accounts is not flagged as unsupported", () => {
    mkdirSync(join(home, ".config", "ag", "profiles", "grok"), { recursive: true })
    const { diagnostics } = discoverActiveSession({ cwd: CWD, homeDir: home })
    expect(diagnostics.unsupportedProviders.length).toBe(0)
  })

  test("shared Claude store reached via an ag-profile symlink is scanned once, not double-counted", () => {
    // Native shared store with one session for CWD.
    writeClaudeSession("dddd4444-shared", 5 * 60_000, 5 * 60_000)
    // ag Claude profile whose projects/ symlinks back to the shared stock store (@ag/accounts-core 19850).
    const agClaudeDir = join(home, ".config", "ag", "profiles", "claude", "shared@x.com")
    mkdirSync(agClaudeDir, { recursive: true })
    symlinkSync(join(home, ".claude", "projects"), join(agClaudeDir, "projects"))

    const { candidate, diagnostics } = discoverActiveSession({ cwd: CWD, homeDir: home })
    expect(candidate?.sessionId).toBe("dddd4444-shared")
    expect(diagnostics.candidateCount).toBe(1) // counted once
    expect(diagnostics.matchedCount).toBe(1)
    expect(diagnostics.dedupedRoots.length).toBeGreaterThanOrEqual(1)
    // No phantom "older matching session" line from the symlinked duplicate.
    expect(diagnostics.exclusions.join(" ")).not.toMatch(/older matching session/i)
  })
})

describe("getCurrentSessionContextWithDiagnostics", () => {
  test("regression: current-brief resolves the fresh Codex session, extracting its content", () => {
    writeClaudeSession("b4f1e419-stale-claude", 18 * 60_000, 18 * 60_000)
    writeCodexSession({
      account: "d@delei.org",
      sessionId: "019eca53-codex-fresh",
      cwd: CWD,
      contentAgeMs: 2 * 60_000,
      mtimeAgeMs: 2 * 60_000,
    })

    const result = getCurrentSessionContextWithDiagnostics({ cwdOverride: CWD, homeOverride: home })

    expect(result.reason).toBeNull()
    expect(result.context).not.toBeNull()
    expect(result.context!.sessionId).toBe("019eca53-codex-fresh")
    // Codex user/assistant text is extracted; the `developer` record is skipped.
    expect(result.context!.recentMessages).toContain("chief recovery")
    expect(result.context!.recentMessages).toContain("recall-reliability epic")
    expect(result.context!.recentMessages).not.toContain("ignore me")
  })

  test("19933 residual: surfaces unsupported providers even when a session IS found", () => {
    // The fail-loud must be visible on the common (session-found) path too — not
    // only when discovery finds nothing. A configured grok profile must warn.
    writeCodexSession({
      account: "d@delei.org",
      sessionId: "019eca53-codex-fresh",
      cwd: CWD,
      contentAgeMs: 2 * 60_000,
      mtimeAgeMs: 2 * 60_000,
    })
    const grokProfile = join(home, ".config", "ag", "profiles", "grok", "k@x.com")
    mkdirSync(grokProfile, { recursive: true })
    writeFileSync(join(grokProfile, "auth.json"), "{}", "utf8")

    const result = getCurrentSessionContextWithDiagnostics({ cwdOverride: CWD, homeOverride: home })
    expect(result.context).not.toBeNull() // a session WAS found
    expect(result.diagnostics.unsupportedProviders.some((p) => p.provider === "grok")).toBe(true)

    const rendered = renderSessionBriefResult(result)
    // The brief itself is present...
    expect(rendered).toContain(result.context!.sessionId.slice(0, 8))
    // ...AND the unsupported-provider notice is visible, not swallowed.
    expect(rendered).toMatch(/grok/)
    expect(rendered).toMatch(/unsupported/i)
  })

  test("stale-only: returns no context but explains the staleness via diagnostics", () => {
    // Content is 45m old (beyond the 30m freshness window) but mtime is recent
    // enough to be discovered — so it is chosen, then dropped as stale.
    writeClaudeSession("c0ffee00-old", 45 * 60_000, 45 * 60_000)
    const result = getCurrentSessionContextWithDiagnostics({ cwdOverride: CWD, homeOverride: home })
    expect(result.context).toBeNull()
    expect(result.reason).toBe("stale")
    expect(result.diagnostics.chosen?.sessionId).toBe("c0ffee00-old")
  })

  test("no session anywhere: reason is no-candidate with searched-root diagnostics", () => {
    const result = getCurrentSessionContextWithDiagnostics({ cwdOverride: CWD, homeOverride: home })
    expect(result.context).toBeNull()
    expect(result.reason).toBe("no-candidate")
    expect(result.diagnostics.missingRoots.length).toBeGreaterThan(0)
  })
})
