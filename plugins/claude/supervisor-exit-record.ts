/**
 * The launch's durable adapter-exit record (G9 P0 row 7).
 *
 * A dead adapter used to leave one stderr line in the host's MCP log, which is
 * gone or unfindable by the time anyone asks why a seat reads disconnected. The
 * supervisor appends one JSON line per adapter exit (launch instance, time, pid, code, signal,
 * restart decision, and for a decided refusal its reason) to
 * `tribe-adapter-exits.jsonl` in the launch's existing state directory, which ag
 * projects as AG_HOST_SESSION_STATE_DIR. It hands the path to its adapter, which
 * registers it, so `tribe members` names the file on the seat's row after the
 * adapter is gone. A terminal refusal that never spawned a child - a cold-start
 * give-up - records the same row with a null pid, code and signal, so a darkened
 * endpoint is never only a host stderr line (28920).
 *
 * There is no other store. A line that cannot be written, including a launch
 * with no state directory, is reported on the supervisor's own stderr.
 */

import { appendFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { AG_HOST_SESSION_STATE_DIR_ENV } from "tribe-wire/lib/ag-host-env"
import {
  HAB_ID_TOKEN_ENV,
  HAB_ID_TOKEN_FILE_ENV,
  readIdentityTokenFromEnvironment,
  readUnverifiedTokenClaims,
} from "tribe-wire/lib/identity-token"
import { formatInstanceId } from "tribe-wire/lib/persona-launch-identity"

const LAUNCH_STATE_DIR_ENV = AG_HOST_SESSION_STATE_DIR_ENV
const ADAPTER_EXIT_RECORD_FILE = "tribe-adapter-exits.jsonl"

export type AdapterExitRecordTarget =
  | { readonly path: string; readonly instanceId: string | null }
  | { readonly path: null; readonly reason: string }

export function resolveAdapterExitRecord(env: Readonly<NodeJS.ProcessEnv>): AdapterExitRecordTarget {
  const stateDir = env[LAUNCH_STATE_DIR_ENV]?.trim() ?? ""
  if (stateDir.length === 0) {
    return { path: null, reason: `${LAUNCH_STATE_DIR_ENV} is unset, so this launch has no state directory` }
  }
  if (!isAbsolute(stateDir)) return { path: null, reason: `${LAUNCH_STATE_DIR_ENV} is not absolute: ${stateDir}` }
  // Capture once before the supervisor's early refusals or child replacements.
  // These are diagnostic self-claims; only the daemon verifies authority.
  let instanceId: string | null = null
  let identityProblem = `${HAB_ID_TOKEN_FILE_ENV} / ${HAB_ID_TOKEN_ENV} is unset`
  let identityStep = `${HAB_ID_TOKEN_FILE_ENV} unreadable`
  try {
    const token = readIdentityTokenFromEnvironment(env)
    if (token !== null) {
      identityStep = `${HAB_ID_TOKEN_ENV} claims unreadable`
      const claims = readUnverifiedTokenClaims(token, { generation: true })
      identityStep = "instance id refused"
      instanceId = formatInstanceId(claims.sid, claims.gen)
    }
  } catch {
    // catch-cause-allow: credential/codec failures can quote paths or claim values; name the required sources/claims instead.
    identityProblem = identityStep
  }
  if (instanceId === null) {
    process.stderr.write(
      `tribe plugin supervisor: adapter exit instance_id null: ${identityProblem}; emitted rows have no provable launch instance\n`,
    )
  }
  return { path: join(stateDir, ADAPTER_EXIT_RECORD_FILE), instanceId }
}

/**
 * A supervisor refused as a provider nested inside this seat (29567) records its own decision, so the row never reads
 * as an exit of the seat's own adapter: nothing counts it as a host-stop or a clean exit.
 */
export const NESTED_HOST_REFUSED_DECISION = "nested-host-refused"

export type AdapterExitDecision = "retry" | "stop" | "host-stop" | "clean-exit" | typeof NESTED_HOST_REFUSED_DECISION

export interface AdapterExit {
  readonly adapterPid: number | undefined
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly error?: Error | undefined
  readonly decision: AdapterExitDecision
  readonly retryDelayMs?: number
  readonly attempt?: number
  /** Why this exit happened. A terminal refusal names itself, never only its decision. */
  readonly reason?: string | undefined
}

export function recordAdapterExit(target: AdapterExitRecordTarget, exit: AdapterExit): void {
  let failure = target.path === null ? target.reason : undefined
  if (target.path !== null) {
    const line = {
      at: new Date().toISOString(),
      instance_id: target.instanceId,
      adapter_pid: exit.adapterPid ?? null,
      code: exit.code,
      signal: exit.signal,
      ...(exit.error === undefined ? {} : { error: exit.error.message }),
      decision: exit.decision,
      ...(exit.retryDelayMs === undefined ? {} : { retry_delay_ms: exit.retryDelayMs }),
      ...(exit.attempt === undefined ? {} : { attempt: exit.attempt }),
      ...(exit.reason === undefined ? {} : { reason: exit.reason }),
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
