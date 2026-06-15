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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { discoverActiveSession, cwdMatches, renderDiscoveryDiagnostics } from "../src/lib/session-discovery.ts"
import { getCurrentSessionContextWithDiagnostics } from "../src/lib/session-context.ts"

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
  })

  test("empty home: reports missing roots and no candidate", () => {
    const { candidate, diagnostics } = discoverActiveSession({ cwd: CWD, homeDir: home })
    expect(candidate).toBeNull()
    expect(diagnostics.candidateCount).toBe(0)
    expect(diagnostics.missingRoots.length).toBeGreaterThan(0)
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
