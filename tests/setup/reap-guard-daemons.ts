/**
 * Reap daemons that tests spawned on the hermetic guard socket.
 *
 * `tmpdir-redirect.ts` points the TRIBE_SOCKET default at a unique, never-
 * created path per test file so nothing can reach the live per-user daemon.
 * That keeps tests OFF the real rail, but it does not stop a test that reaches
 * `connectOrStart` from SPAWNING a daemon on that default — and the standalone
 * launcher spawns detached and unref'd, so the supervisor/daemon pair outlives
 * the vitest run, reparents to init, and keeps its source watcher armed. Every
 * later edit to a daemon source file then hot-reloads every leaked generation
 * at once (nine were observed restarting in the same second after one
 * `git checkout`). Killing the daemon alone does not help: the supervisor is
 * the half that outlives the run.
 *
 * This runs as a globalSetup teardown, not a setup-file `afterAll` — a
 * top-level `afterAll` in a setupFiles module is never invoked, so a reaper
 * written there is silent dead code.
 *
 * Scope: a process is reaped only when its argv names BOTH the guard socket
 * root AND this repository's own daemon sources. The live daemon
 * (/run/user/<uid>/tribe.sock) can never match the first; a concurrent run from
 * a different checkout can never match the second.
 */

import { execFileSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

function guardSocketRoot(): string {
  return `/tmp/tribe-vitest-${process.getuid?.() ?? 0}/tribe-guard/`
}

/**
 * Pick the guard-socket processes out of `ps -eo pid=,args=` output.
 *
 * Split out from the reaping so the matching rules — the part that must never
 * be too broad — are testable without spawning anything.
 */
export function findGuardSocketProcesses(
  psOutput: string,
  opts: { guardRoot: string; repoRoot: string; selfPid: number },
): Array<{ pid: number; isSupervisor: boolean }> {
  const found: Array<{ pid: number; isSupervisor: boolean }> = []
  for (const line of psOutput.split("\n")) {
    if (!line.includes(opts.guardRoot)) continue
    if (!line.includes(opts.repoRoot)) continue
    const pid = Number(line.trimStart().split(/\s+/)[0])
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === opts.selfPid) continue
    found.push({ pid, isSupervisor: line.includes("__standalone-supervisor") })
  }
  return found
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

export function setup(): void {
  /* Nothing to prepare — the work is all in teardown. */
}

export function teardown(): void {
  const guardRoot = guardSocketRoot()
  let psOutput: string
  try {
    psOutput = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" })
  } catch (error) {
    // An unreadable process table means we cannot know whether anything leaked.
    // Say so — a quiet return here is indistinguishable from a clean run.
    console.error(
      `tribe guard: cannot scan for leaked guard-socket daemons ` +
        `(${error instanceof Error ? error.message : String(error)}). If this run spawned any, they are still alive.`,
    )
    return
  }

  const leaked = findGuardSocketProcesses(psOutput, { guardRoot, repoRoot: REPO_ROOT, selfPid: process.pid })
  if (leaked.length === 0) return

  // A test spawning a real daemon on the hermetic guard socket is itself a bug.
  // Reaping it quietly would hide the thing worth fixing, so name it.
  console.error(
    `tribe guard: ${leaked.length} process(es) were left on the hermetic guard socket under ${guardRoot} — ` +
      `pids ${leaked.map((p) => p.pid).join(", ")}. Reaping them so they do not outlive this run. ` +
      `A test that needs a daemon should pass an explicit --socket rather than fall back to the guard default.`,
  )

  // Supervisors first: a supervisor outlives its child by design, and is the
  // half that keeps respawning across source edits.
  const ordered = [...leaked.filter((p) => p.isSupervisor), ...leaked.filter((p) => !p.isSupervisor)]
  for (const { pid } of ordered) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      /* raced to exit between the scan and the signal */
    }
  }

  const deadline = Date.now() + 2_000
  while (Date.now() < deadline && ordered.some(({ pid }) => alive(pid))) {
    try {
      execFileSync("sleep", ["0.05"])
    } catch {
      break
    }
  }
  for (const { pid } of ordered) {
    if (!alive(pid)) continue
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      /* raced to exit */
    }
  }

  const survivors = ordered.filter(({ pid }) => alive(pid)).map(({ pid }) => pid)
  if (survivors.length > 0) {
    console.error(`tribe guard: pids ${survivors.join(", ")} survived SIGKILL and are still holding a guard socket.`)
  }
}
