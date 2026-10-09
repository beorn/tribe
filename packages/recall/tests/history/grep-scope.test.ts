/**
 * Regex mode must never answer wider than asked (28427).
 *
 * @failure  `recall -g <pattern> --session <id>` silently scanned every session and `--json` printed human
 *           text where a caller asked for JSON: cmdSearch handed cmdGrep only { project, limit }, so a scoped
 *           regex query answered wider than asked — the no-silent-errors rule. A refused id must refuse loud.
 * @level    l2 — drives the real cmdSearch/cmdGrep read path against a temp transcript tree; no index rows,
 *           no network, no LLM.
 * @consumer @i/20-search-and-memory/28427; the /recall skill and every scoped regex search.
 * @reach    fs-walk <fixture-only: regex mode scans a temporary CLAUDE_DIR transcript tree>
 * @testonly none
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs"
import { safeRemoveSync } from "removely"
import { join } from "node:path"
import { tmpdir } from "node:os"

process.env.RECALL_DB_PATH = ":memory:"

const { cmdSearch } = await import("../../src/lib/search")

const TOKEN = "grep_scope_needle_9f13"
const SESSION_A = "9e0d1a2b-1111-4c2d-8e3f-555555555555"
const SESSION_B = "9e0d1a2b-2222-4c2d-8e3f-666666666666"

function writeTranscript(root: string, project: string, sessionId: string, text: string): string {
  const dir = join(root, "projects", project)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sessionId}.jsonl`)
  const lines = [
    JSON.stringify({
      type: "user",
      timestamp: "2026-10-09T19:00:00.000Z",
      message: { role: "user", content: `${TOKEN} ${text}` },
    }),
  ]
  writeFileSync(file, lines.join("\n") + "\n", "utf8")
  return file
}

describe("recall regex mode scope", () => {
  let claudeDir: string
  let previousClaudeDir: string | undefined
  let previousExitCode: typeof process.exitCode
  let logSpy: ReturnType<typeof vi.spyOn>
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    previousClaudeDir = process.env.CLAUDE_DIR
    previousExitCode = process.exitCode
    process.exitCode = undefined
    claudeDir = mkdtempSync(join(tmpdir(), "recall-grep-scope-"))
    process.env.CLAUDE_DIR = claudeDir
    writeTranscript(claudeDir, "proj-alpha", SESSION_A, "alpha session body")
    writeTranscript(claudeDir, "proj-beta", SESSION_B, "beta session body")
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    errSpy.mockRestore()
    if (previousClaudeDir === undefined) delete process.env.CLAUDE_DIR
    else process.env.CLAUDE_DIR = previousClaudeDir
    process.exitCode = previousExitCode
    safeRemoveSync(claudeDir, { within: realpathSync(tmpdir()), allowMissing: true })
  })

  const stdout = () => logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n")
  const stderr = () => errSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n")

  test("honours --session in regex mode: a scoped query never answers wider than asked", async () => {
    await cmdSearch(TOKEN, { grep: true, raw: true, session: SESSION_A, limit: "50", refresh: false })

    const out = stdout()
    expect(out).toContain(SESSION_A.slice(0, 12))
    expect(out).not.toContain(SESSION_B.slice(0, 12))
  })

  test("honours --json in regex mode: stdout is one parseable JSON envelope", async () => {
    await cmdSearch(TOKEN, { grep: true, raw: true, session: SESSION_A, json: true, limit: "50", refresh: false })

    const envelope = JSON.parse(stdout()) as {
      query: string
      mode: string
      total: number
      results: { sessionId: string }[]
    }
    expect(envelope.query).toBe(TOKEN)
    expect(envelope.mode).toBe("regex")
    expect(envelope.results.map((r) => r.sessionId)).toEqual([SESSION_A])
  })

  test("scopes a subagent to its compound id and reports that id, never its parent's", async () => {
    const parent = "3b1c2d4e-3333-4a5b-9c6d-777777777777"
    const subDir = join(claudeDir, "projects", "proj-alpha", parent, "subagents")
    mkdirSync(subDir, { recursive: true })
    // The transcript shape the indexer documents: the RECORD carries the
    // parent's sessionId and the basename carries only the agent name. Neither
    // is the file's canonical identity, which is `<parent>:<agent>`.
    writeFileSync(
      join(subDir, "agent-sub1.jsonl"),
      JSON.stringify({
        type: "assistant",
        sessionId: parent,
        timestamp: "2026-10-09T19:05:00.000Z",
        message: { role: "assistant", content: `${TOKEN} subagent body` },
      }) + "\n",
      "utf8",
    )

    await cmdSearch(TOKEN, {
      grep: true,
      raw: true,
      session: `${parent}:agent-sub1`,
      json: true,
      limit: "50",
      refresh: false,
    })

    const envelope = JSON.parse(stdout()) as { results: { sessionId: string }[] }
    expect(envelope.results.map((r) => r.sessionId)).toEqual([`${parent}:agent-sub1`])
  })

  test("refuses by name when the scoped session has no Claude transcript, never widening", async () => {
    await cmdSearch(TOKEN, {
      grep: true,
      raw: true,
      session: "codex:1c3d5e7f-0000-4000-8000-999999999999",
      limit: "50",
      refresh: false,
    })

    expect(process.exitCode).not.toBe(0)
    expect(stderr()).toContain("regex mode")
    expect(stdout()).not.toContain(SESSION_A.slice(0, 12))
    expect(stdout()).not.toContain(SESSION_B.slice(0, 12))
  })
})
