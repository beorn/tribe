/**
 * 22967 — the live pre-compact hook emits the checkpoint context.
 *
 * @failure  a PreCompact-shaped payload produces an empty exit 0 (the pre-2026-10-13 behaviour: the payload reached
 *           the UserPromptSubmit handler, which needs `prompt`, so it emitted nothing) instead of the RESUME
 *           directive and the session state the retired tools/agent-rig/hooks/pre-compact.sh printed.
 * @level    l2 — the real cmdPreCompact over a fixture vault; only stdin, stdout and process.exit are stubbed.
 * @consumer `tribe hook pre-compact` (root .claude/settings.json PreCompact row) → dispatchHook("pre-compact").
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { Database } from "bun:sqlite"
import { safeRemoveSync } from "removely"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

// Capture the git argv the handler runs so the read-only flag it inherited from the retired shell
// (tools/agent-rig/hooks/pre-compact.sh, deleted 22967) is asserted, not just assumed; the real
// command still runs.
const bounded = vi.hoisted(() => ({ calls: [] as string[][] }))
vi.mock("../src/lib/bounded-process.ts", async (original) => {
  const actual = await original<typeof import("../src/lib/bounded-process.ts")>()
  return {
    ...actual,
    runBoundedProcessCommand: (argv: readonly string[], bounds: unknown) => {
      bounded.calls.push([...argv])
      return actual.runBoundedProcessCommand(argv as never, bounds as never)
    },
  }
})

// drainOutput ends the process's stdout and stderr before the hook exits; a test must keep them open, and it may be
// drained only once per process (a second drain throws "Cannot call end after a stream was finished").
vi.mock("loggily", async (original) => ({
  ...(await original<typeof import("loggily")>()),
  drainOutput: async () => {},
}))

let dir: string
let vault: string
let logSpy: ReturnType<typeof vi.spyOn>
let exitSpy: ReturnType<typeof vi.spyOn>
let prevStdin: PropertyDescriptor | undefined

/** A minimal external-content vault: `nodes` + `nodes_fts` in the shape recall's searchVault reads. */
function seedVault(sessionId: string): void {
  const shortId = sessionId.slice(0, 8)
  const db = new Database(vault)
  db.run(
    "CREATE TABLE nodes (id TEXT PRIMARY KEY, parent_id TEXT, item INTEGER, parent_idx REAL, fs_path TEXT, name TEXT, title TEXT, content TEXT, task_status TEXT)",
  )
  db.run(
    "CREATE VIRTUAL TABLE nodes_fts USING fts5(id, name, title, content, content='nodes', content_rowid='rowid', tokenize='unicode61 tokenchars ''@#+~''')",
  )
  db.run(
    "INSERT INTO nodes (id, parent_id, item, parent_idx, fs_path, name, title, content, task_status) VALUES (?,?,?,?,?,?,?,?,?)",
    ["n1", "@dev", 1, 0, `@dev/${shortId}-fixture-bead.md`, shortId, "fixture bead", shortId, "wip"],
  )
  db.run("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')")
  db.close()
}

function feedStdin(payload: unknown): void {
  Object.defineProperty(process, "stdin", {
    value: Readable.from([Buffer.from(JSON.stringify(payload))]),
    configurable: true,
  })
}

beforeEach(() => {
  vi.resetModules()
  bounded.calls.length = 0
  dir = mkdtempSync(join(realpathSync(tmpdir()), "recall-pre-compact-"))
  vault = join(dir, "state.db")
  prevStdin = Object.getOwnPropertyDescriptor(process, "stdin")
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
})

afterEach(() => {
  logSpy.mockRestore()
  exitSpy.mockRestore()
  vi.unstubAllEnvs()
  if (prevStdin !== undefined) Object.defineProperty(process, "stdin", prevStdin)
  safeRemoveSync(dir, { within: realpathSync(tmpdir()), allowMissing: true })
})

const stdout = () => logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n")

async function run(payload: unknown, boundVault: string | null): Promise<void> {
  feedStdin(payload)
  if (boundVault !== null) {
    const { bindVaultDb } = await import("../src/history/vault-fts.ts")
    bindVaultDb(boundVault)
  }
  const { cmdPreCompact } = await import("../src/lib/hooks.ts")
  await cmdPreCompact()
  expect(exitSpy).toHaveBeenCalledWith(0)
}

describe("pre-compact handler (22967)", () => {
  test("a PreCompact-shaped payload emits the RESUME directive and the session state on stdout", async () => {
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    seedVault(sessionId)
    await run(
      { session_id: sessionId, transcript_path: join(dir, "t.jsonl"), cwd: dir, hook_event_name: "PreCompact" },
      vault,
    )
    const out = stdout()
    expect(out).toContain("# RESUME: km bd show @dev/aaaaaaaa-fixture-bead.md")
    expect(out).toContain("# Session State at Compact Time (session: aaaaaaaa)")
    expect(out).toContain("## In-Progress Beads")
    expect(out).toContain("@dev/aaaaaaaa-fixture-bead.md")
    expect(out).toContain("## Recent Commits")
    expect(out).toContain("## Uncommitted Changes")
  })

  test("no session id: the context still prints and names the missing tracking bead", async () => {
    seedVault("beefbeef")
    await run({ cwd: dir, hook_event_name: "PreCompact" }, vault)
    const out = stdout()
    expect(out).toContain("(session: unknown)")
    expect(out).toContain("no session id on the PreCompact payload")
  })

  test("no --vault-db bound: the in-progress list says so rather than printing an empty list", async () => {
    await run({ session_id: "aaaaaaaa-bbbb", cwd: dir, hook_event_name: "PreCompact" }, null)
    expect(stdout()).toContain("beads unavailable")
  })

  test("the git reads are real, bounded and --no-optional-locks (the retired shell's read-only probes)", async () => {
    const git = (args: string[]) => spawnSync("git", args, { encoding: "utf8" })
    git(["init", "-q", dir])
    git(["-C", dir, "config", "user.email", "fixture@example.invalid"])
    git(["-C", dir, "config", "user.name", "fixture"])
    writeFileSync(join(dir, "committed.txt"), "x\n")
    git(["-C", dir, "add", "committed.txt"])
    git(["-C", dir, "-c", "commit.gpgsign=false", "commit", "-qm", "FIXTURE COMMIT"])
    writeFileSync(join(dir, "dirty.txt"), "y\n")
    seedVault("aaaaaaaa")
    await run({ session_id: "aaaaaaaa-bbbb", cwd: dir, hook_event_name: "PreCompact" }, vault)
    const out = stdout()
    expect(out).toContain("FIXTURE COMMIT")
    expect(out).toContain("dirty.txt")
    expect(bounded.calls.length).toBeGreaterThanOrEqual(2)
    for (const argv of bounded.calls) {
      expect(argv.slice(0, 2)).toEqual(["git", "--no-optional-locks"])
    }
  })

  test("a STATE-rooted seat reads its dev/ CODE child, never the container's Git (hook-roots parity)", async () => {
    const git = (args: string[]) => spawnSync("git", args, { encoding: "utf8" })
    const commit = (repo: string, subject: string) => {
      git(["init", "-q", repo])
      git(["-C", repo, "config", "user.email", "fixture@example.invalid"])
      git(["-C", repo, "config", "user.name", "fixture"])
      writeFileSync(join(repo, "f.txt"), subject)
      git(["-C", repo, "add", "f.txt"])
      git(["-C", repo, "-c", "commit.gpgsign=false", "commit", "-qm", subject])
    }
    // The container is the seat's project dir (/hh-like); its CODE checkout is the dev/ child.
    commit(dir, "STATE CONTAINER COMMIT")
    const code = join(dir, "dev")
    mkdirSync(join(code, "tools", "agent-rig", "hooks"), { recursive: true })
    commit(code, "CODE CHILD COMMIT")

    vi.stubEnv("CLAUDE_PROJECT_DIR", dir)
    seedVault("aaaaaaaa")
    await run({ session_id: "aaaaaaaa-bbbb", cwd: dir, hook_event_name: "PreCompact" }, vault)
    const out = stdout()
    expect(out).toContain("CODE CHILD COMMIT")
    expect(out).not.toContain("STATE CONTAINER COMMIT")
  })
})
