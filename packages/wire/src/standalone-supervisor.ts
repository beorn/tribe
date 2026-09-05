/**
 * Stable lifecycle owner for standalone Tribe daemons.
 *
 * The supervisor may itself be detached from a short-lived launcher, but the
 * daemon is always its ordinary child. A daemon generation requests reload by
 * exiting with the private code projected in its environment; the same
 * supervisor then starts the successor. Clean shutdown and other failures end
 * the supervisor instead of creating an unbounded restart loop.
 *
 * The supervisor is also the only witness to why a daemon generation died, so
 * it must never swallow that. Until 2026-08-13 it spawned the child with
 * `stdio: "ignore"`, which sent the daemon's stderr — the ONLY copy of its
 * startup refusal — to /dev/null, and mapped a signal-killed child onto
 * `exit 0`. The recovery path for that outage sat for hours on an exit-0
 * supervisor with a zero-byte log while the real cause was visible only by
 * running the daemon bare, outside its supervisor.
 *
 * So: the child's stderr is piped, streamed onward to the supervisor's own
 * stderr as it arrives, and retained as a bounded tail that is replayed in the
 * death summary. The exit code is the child's, and a child that died to a
 * signal we did not ask for exits `128 + signum` — never 0.
 *
 * @ag/tribe/24159 — "streamed onward to the supervisor's own stderr" is only
 * a log when something is reading that stderr. `tribe restart` detaches the
 * supervisor from a terminal (parent pid 1), so its own stderr is /dev/null
 * and every daemon log line landed there was discarded — no file anywhere
 * held it. The child's stderr is now ALSO teed to a dated file
 * (daemonStderrLogPath, `$TRIBE_DAEMON_STDERR_LOG` override) independent of
 * where the supervisor's own forwarded stderr goes; `tribe doctor` names it.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { spawn, type ChildProcess } from "node:child_process"
import { dirname } from "node:path"
import { constants as osConstants } from "node:os"
import {
  sanitizeStandaloneDaemonEnvironment,
  TRIBE_DAEMON_RELOAD_EXIT_CODE_ENV,
  TRIBE_DAEMON_SUPERVISOR_PID_ENV,
  TRIBE_OPERATOR_CAPABILITY_ENV,
  TRIBE_OPERATOR_CAPABILITY_FD_ENV,
} from "./daemon-environment.ts"
import { daemonStderrLogPath } from "./lib/daemon-stderr-log.ts"

export const STANDALONE_SUPERVISOR_PID_ENV = TRIBE_DAEMON_SUPERVISOR_PID_ENV
export const STANDALONE_RELOAD_EXIT_CODE_ENV = TRIBE_DAEMON_RELOAD_EXIT_CODE_ENV
export const STANDALONE_RELOAD_EXIT_CODE = 75

const DEFAULT_WAIT_TIMEOUT_MS = 30_000

/**
 * How much of a dying child's stderr to retain for the death summary. The
 * stream is forwarded in full as it arrives; this only bounds the replay, so a
 * daemon that logs steadily for a week cannot grow the supervisor's heap.
 */
const STDERR_TAIL_LIMIT_BYTES = 64 * 1024

/** Everything the supervisor says goes to its own stderr — that IS its log. */
function report(line: string): void {
  process.stderr.write(`tribe-supervisor: ${line}\n`)
}

let daemonStderrLogParentEnsuredFor: string | null = null

/** Create the tee file's parent dir once per path (cheap re-check on day rollover). */
function ensureDaemonStderrLogParent(path: string): void {
  if (daemonStderrLogParentEnsuredFor === path) return
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  daemonStderrLogParentEnsuredFor = path
}

let daemonStderrLogWarned = false

/**
 * Append the child's raw stderr bytes to the daemon-stderr tee file, ALSO
 * (not instead of) forwarding to the supervisor's own stderr. Synchronous so
 * `tail -f` readers see lines as they land, matching the activity log's own
 * discipline. A write failure is reported once on the supervisor's own
 * stderr and never kills the child — this tee is a bonus copy, not the
 * child's lifeline.
 */
function teeDaemonStderr(chunk: Buffer): void {
  const path = daemonStderrLogPath()
  try {
    ensureDaemonStderrLogParent(path)
    appendFileSync(path, chunk)
  } catch (error) {
    if (daemonStderrLogWarned) return
    daemonStderrLogWarned = true
    report(
      `could not write daemon stderr to ${path}: ${error instanceof Error ? error.message : String(error)} — further write failures to this file are silenced`,
    )
  }
}

/** Signal name → wait-status convention (128 + signum), so a crash is never 0. */
function exitCodeForSignal(signal: NodeJS.Signals): number {
  const signals = osConstants.signals as unknown as Record<string, number | undefined>
  const signum = signals[signal]
  // An unrecognized signal name still must not read as success.
  return signum === undefined ? 1 : 128 + signum
}

/** Bounded FIFO over the child's stderr, kept for the death summary. */
function createStderrTail(): { append(chunk: Buffer): void; text(): string } {
  let buffer = Buffer.alloc(0)
  return {
    append(chunk) {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > STDERR_TAIL_LIMIT_BYTES) {
        buffer = buffer.subarray(buffer.length - STDERR_TAIL_LIMIT_BYTES)
      }
    },
    text() {
      return buffer.toString("utf8").trimEnd()
    },
  }
}

function readInheritedOperatorCapability(env: NodeJS.ProcessEnv): string | null {
  const raw = env[TRIBE_OPERATOR_CAPABILITY_FD_ENV]
  delete env[TRIBE_OPERATOR_CAPABILITY_ENV]
  delete env[TRIBE_OPERATOR_CAPABILITY_FD_ENV]
  if (raw === undefined) return null
  const fd = Number(raw)
  if (!Number.isSafeInteger(fd) || fd < 3) {
    throw new Error(
      `${TRIBE_OPERATOR_CAPABILITY_FD_ENV} must name an inherited fd >= 3, received ${JSON.stringify(raw)}`,
    )
  }
  const capability = readFileSync(fd, "utf8").trim()
  if (!capability) throw new Error(`${TRIBE_OPERATOR_CAPABILITY_FD_ENV} contained an empty operator capability`)
  return capability
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

async function waitForProcessExit(pid: number, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (pidExists(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`standalone supervisor timed out waiting for predecessor ${pid} to exit`)
    }
    await new Promise((resolveTick) => setTimeout(resolveTick, 25))
  }
}

type ParsedSupervisorArgs = {
  command: string[]
  waitForPid: number | null
}

function parseSupervisorArgs(argv: string[]): ParsedSupervisorArgs {
  const args = [...argv]
  let waitForPid: number | null = null
  if (args[0] === "--wait-for-pid") {
    const raw = args[1]
    const parsed = Number(raw)
    if (!Number.isSafeInteger(parsed) || parsed <= 1) {
      throw new Error(`--wait-for-pid requires a process id greater than 1, received ${JSON.stringify(raw)}`)
    }
    waitForPid = parsed
    args.splice(0, 2)
  }
  if (args.shift() !== "--" || args.length === 0) {
    throw new Error("standalone supervisor requires `-- <daemon-script> [args...]`")
  }
  return { command: args, waitForPid }
}

function spawnGeneration(command: string[], capability: string | null): ChildProcess {
  const env = sanitizeStandaloneDaemonEnvironment(process.env)
  env[STANDALONE_SUPERVISOR_PID_ENV] = String(process.pid)
  env[STANDALONE_RELOAD_EXIT_CODE_ENV] = String(STANDALONE_RELOAD_EXIT_CODE)
  if (capability) env[TRIBE_OPERATOR_CAPABILITY_FD_ENV] = "3"
  const child = spawn(process.execPath, command, {
    detached: false,
    env,
    // stderr is piped, never ignored: it carries the daemon's startup refusal,
    // and the supervisor is the only process positioned to keep it.
    stdio: capability ? ["ignore", "ignore", "pipe", "pipe"] : ["ignore", "ignore", "pipe"],
  })
  if (capability) {
    const capabilityPipe = child.stdio[3]
    if (!capabilityPipe || !("end" in capabilityPipe)) {
      child.kill()
      throw new Error("standalone supervisor did not expose the daemon operator capability pipe")
    }
    capabilityPipe.on("error", () => {
      /* child exit is the authoritative lifecycle outcome */
    })
    capabilityPipe.end(capability)
  }
  return child
}

export async function runStandaloneSupervisor(argv = process.argv.slice(2)): Promise<number> {
  const { command, waitForPid } = parseSupervisorArgs(argv)
  const inheritedEnv = { ...process.env }
  const capability = readInheritedOperatorCapability(inheritedEnv)
  const supervisorEnv = sanitizeStandaloneDaemonEnvironment(inheritedEnv)
  for (const key of Object.keys(process.env)) {
    if (!(key in supervisorEnv)) delete process.env[key]
  }
  Object.assign(process.env, supervisorEnv)
  if (waitForPid !== null) await waitForProcessExit(waitForPid)

  return new Promise<number>((resolveSupervisor) => {
    let active: ChildProcess | null = null
    let stopping = false
    let settled = false

    const cleanup = () => {
      process.off("SIGHUP", onSighup)
      process.off("SIGINT", onSigint)
      process.off("SIGTERM", onSigterm)
    }
    const finish = (code: number) => {
      if (settled) return
      settled = true
      cleanup()
      resolveSupervisor(code)
    }
    const relay = (signal: NodeJS.Signals, stop: boolean) => {
      if (stop) stopping = true
      if (active && !active.killed) active.kill(signal)
      else if (stop) finish(0)
    }
    const onSighup = () => relay("SIGHUP", false)
    const onSigint = () => relay("SIGINT", true)
    const onSigterm = () => relay("SIGTERM", true)

    const launch = () => {
      let child: ChildProcess
      try {
        child = spawnGeneration(command, capability)
      } catch (error) {
        report(`could not spawn ${command[0]}: ${error instanceof Error ? error.message : String(error)}`)
        finish(1)
        return
      }
      active = child
      const stderrTail = createStderrTail()
      // Forward as it arrives so a daemon that hangs after complaining still
      // gets its complaint out, then retain a bounded tail for the summary.
      // Also tee to a file on disk (24159): the supervisor's own stderr may
      // be /dev/null when detached, but the file survives regardless.
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail.append(chunk)
        process.stderr.write(chunk)
        teeDaemonStderr(chunk)
      })
      child.stderr?.on("error", () => {
        /* child exit is the authoritative lifecycle outcome */
      })

      /** Name the death and replay what the child said about it. */
      const reportAbnormalExit = (how: string) => {
        report(`daemon generation ${child.pid ?? "(unspawned)"} ${how}`)
        report(`daemon command was: ${command.join(" ")}`)
        const tail = stderrTail.text()
        report(tail ? `daemon stderr follows:\n${tail}` : "daemon produced no stderr before dying")
      }

      let generationSettled = false
      child.once("error", (error) => {
        if (generationSettled) return
        generationSettled = true
        reportAbnormalExit(`failed: ${error instanceof Error ? error.message : String(error)}`)
        finish(1)
      })
      child.once("exit", (code, signal) => {
        if (generationSettled) return
        generationSettled = true
        active = null
        if (!stopping && code === STANDALONE_RELOAD_EXIT_CODE) {
          launch()
          return
        }
        if (signal !== null) {
          // A signal death we did not ask for is a crash (OOM kill, SIGSEGV,
          // an external kill). `code` is null here, and the old `code ?? 0`
          // reported every one of them as a clean exit.
          if (stopping) {
            finish(0)
            return
          }
          reportAbnormalExit(`was killed by ${signal}`)
          finish(exitCodeForSignal(signal))
          return
        }
        if (code !== 0) reportAbnormalExit(`exited with code ${code}`)
        finish(code ?? 0)
      })
    }

    process.on("SIGHUP", onSighup)
    process.on("SIGINT", onSigint)
    process.on("SIGTERM", onSigterm)
    launch()
  })
}

if (import.meta.main) {
  process.exit(await runStandaloneSupervisor())
}
