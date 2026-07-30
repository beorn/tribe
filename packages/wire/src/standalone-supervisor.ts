/**
 * Stable lifecycle owner for standalone Tribe daemons.
 *
 * The supervisor may itself be detached from a short-lived launcher, but the
 * daemon is always its ordinary child. A daemon generation requests reload by
 * exiting with the private code projected in its environment; the same
 * supervisor then starts the successor. Clean shutdown and other failures end
 * the supervisor instead of creating an unbounded restart loop.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { readFileSync } from "node:fs"
import {
  sanitizeStandaloneDaemonEnvironment,
  TRIBE_DAEMON_RELOAD_EXIT_CODE_ENV,
  TRIBE_DAEMON_SUPERVISOR_PID_ENV,
  TRIBE_OPERATOR_CAPABILITY_ENV,
  TRIBE_OPERATOR_CAPABILITY_FD_ENV,
} from "./daemon-environment.ts"

export const STANDALONE_SUPERVISOR_PID_ENV = TRIBE_DAEMON_SUPERVISOR_PID_ENV
export const STANDALONE_RELOAD_EXIT_CODE_ENV = TRIBE_DAEMON_RELOAD_EXIT_CODE_ENV
export const STANDALONE_RELOAD_EXIT_CODE = 75

const DEFAULT_WAIT_TIMEOUT_MS = 30_000

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
    stdio: capability ? ["ignore", "ignore", "ignore", "pipe"] : "ignore",
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
      } catch {
        finish(1)
        return
      }
      active = child
      let generationSettled = false
      child.once("error", () => {
        if (generationSettled) return
        generationSettled = true
        finish(1)
      })
      child.once("exit", (code) => {
        if (generationSettled) return
        generationSettled = true
        active = null
        if (!stopping && code === STANDALONE_RELOAD_EXIT_CODE) {
          launch()
          return
        }
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
