/**
 * Deadline-bounded single-shot daemon call. Used by short-lived callers
 * (Claude Code hooks, CLI one-shots) that can't tolerate blocking.
 *
 * The caller supplies the per-client RPC body via `fn(client)`. On deadline
 * or socket error the function returns a discriminated outcome rather than
 * throwing — hooks want structured failure, not exception plumbing.
 */

import { type DaemonClient } from "./client.ts"
import * as daemonClient from "./client.ts"

export type DaemonCallOutcome<T> =
  | { kind: "ok"; value: T }
  /** How long the caller waited and what it was reading; describeDaemonOutcome writes the sentence (33937). */
  | { kind: "timeout"; afterMs: number; reading: string }
  | { kind: "no-daemon" }
  | { kind: "error"; message: string }

export type WithDaemonCallOpts = {
  socketPath: string
  /** Hard deadline for the whole connect+call+close cycle. */
  deadlineMs: number
  /** The daemon call this read is for, as a timeout names it (e.g. `tribe.pending`). */
  reading: string
  /** Per-call timeout for the underlying client. Defaults to `deadlineMs`. */
  callTimeoutMs?: number
}

export async function withDaemonCall<T>(
  opts: WithDaemonCallOpts,
  fn: (client: DaemonClient) => Promise<T>,
): Promise<DaemonCallOutcome<T>> {
  const deadline = Date.now() + opts.deadlineMs
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  let client: DaemonClient | undefined
  let timedOut = false
  const timeout: DaemonCallOutcome<never> = { kind: "timeout", afterMs: opts.deadlineMs, reading: opts.reading }
  const closeClient = (): void => {
    const open = client
    client = undefined
    open?.close()
  }
  try {
    const racePromise = (async (): Promise<DaemonCallOutcome<T>> => {
      const connected = await daemonClient.connectToDaemon(opts.socketPath, {
        callTimeoutMs: opts.callTimeoutMs ?? opts.deadlineMs,
      })
      if (timedOut) {
        connected.close()
        return timeout
      }
      client = connected
      try {
        return { kind: "ok", value: await fn(client) }
      } finally {
        closeClient()
      }
    })()
    const deadlineReached = new Promise<DaemonCallOutcome<T>>((resolve) => {
      timeoutHandle = setTimeout(
        () => {
          timedOut = true
          closeClient()
          resolve(timeout)
        },
        Math.max(50, deadline - Date.now()),
      )
    })
    return await Promise.race([racePromise, deadlineReached])
  } catch (err) {
    closeClient()
    if (daemonClient.isDaemonCallTimeoutError(err)) return { ...timeout, afterMs: err.timeoutMs }
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ECONNREFUSED" || code === "ENOENT") return { kind: "no-daemon" }
    return { kind: "error", message: err instanceof Error ? err.message : String(err) }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}
