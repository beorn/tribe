/**
 * The launch's durable adapter-exit record (G9 P0 row 7).
 *
 * A dead adapter used to leave one stderr line in the host's MCP log, which is
 * gone or unfindable by the time anyone asks why a seat reads disconnected. The
 * supervisor appends one JSON line per adapter exit (time, pid, code, signal,
 * restart decision) to `tribe-adapter-exits.jsonl` in the launch's existing
 * state directory, which ag projects as AG_HOST_SESSION_STATE_DIR. It hands the
 * path to its adapter, which registers it, so `tribe members` names the file on
 * the seat's row after the adapter is gone.
 *
 * There is no other store. A line that cannot be written, including a launch
 * with no state directory, is reported on the supervisor's own stderr.
 */

import { appendFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"

const LAUNCH_STATE_DIR_ENV = "AG_HOST_SESSION_STATE_DIR"
const ADAPTER_EXIT_RECORD_FILE = "tribe-adapter-exits.jsonl"

export type AdapterExitRecordTarget = { readonly path: string } | { readonly path: null; readonly reason: string }

export function resolveAdapterExitRecord(env: Readonly<NodeJS.ProcessEnv>): AdapterExitRecordTarget {
  const stateDir = env[LAUNCH_STATE_DIR_ENV]?.trim() ?? ""
  if (stateDir.length === 0) {
    return { path: null, reason: `${LAUNCH_STATE_DIR_ENV} is unset, so this launch has no state directory` }
  }
  if (!isAbsolute(stateDir)) return { path: null, reason: `${LAUNCH_STATE_DIR_ENV} is not absolute: ${stateDir}` }
  return { path: join(stateDir, ADAPTER_EXIT_RECORD_FILE) }
}

export type AdapterExitDecision = "retry" | "stop" | "host-stop" | "clean-exit"

export interface AdapterExit {
  readonly adapterPid: number | undefined
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly error?: Error | undefined
  readonly decision: AdapterExitDecision
  readonly retryDelayMs?: number
  readonly attempt?: number
}

export function recordAdapterExit(target: AdapterExitRecordTarget, exit: AdapterExit): void {
  let failure = target.path === null ? target.reason : undefined
  if (target.path !== null) {
    const line = {
      at: new Date().toISOString(),
      adapter_pid: exit.adapterPid ?? null,
      code: exit.code,
      signal: exit.signal,
      ...(exit.error === undefined ? {} : { error: exit.error.message }),
      decision: exit.decision,
      ...(exit.retryDelayMs === undefined ? {} : { retry_delay_ms: exit.retryDelayMs }),
      ...(exit.attempt === undefined ? {} : { attempt: exit.attempt }),
    }
    try {
      appendFileSync(target.path, `${JSON.stringify(line)}\n`)
    } catch (error) {
      failure = `${target.path}: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (failure === undefined) return
  process.stderr.write(
    `tribe plugin supervisor: could not record adapter exit (${failure}): adapter pid ${String(exit.adapterPid)}, ` +
      `exit=${String(exit.code)} signal=${String(exit.signal)}, decision=${exit.decision}\n`,
  )
}
