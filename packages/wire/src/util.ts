/**
 * Deadline-bounded single-shot daemon call. Used by short-lived callers
 * (Claude Code hooks, CLI one-shots) that can't tolerate blocking.
 *
 * The caller supplies the per-client RPC body via `fn(client)`. On deadline
 * or socket error the function returns a discriminated outcome rather than
 * throwing — hooks want structured failure, not exception plumbing.
 */

import { type ConnectToDaemonOpts, type DaemonClient } from "./client.ts"
import * as daemonClient from "./client.ts"

export type DaemonCallOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "timeout" }
  | { kind: "no-daemon" }
  | { kind: "error"; message: string }

export type WithDaemonCallOpts = {
  socketPath: string
  /** Hard deadline for the whole connect+call+close cycle. */
  deadlineMs: number
  /** Per-call timeout for the underlying client. Defaults to `deadlineMs`. */
  callTimeoutMs?: number
  /** @internal test seam — override the connect primitive. */
  connectFn?: (socketPath: string, opts?: ConnectToDaemonOpts) => Promise<DaemonClient>
}

export async function withDaemonCall<T>(
  opts: WithDaemonCallOpts,
  fn: (client: DaemonClient) => Promise<T>,
): Promise<DaemonCallOutcome<T>> {
  const deadline = Date.now() + opts.deadlineMs
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  let client: DaemonClient | undefined
  let timedOut = false
  const closeClient = (): void => {
    const open = client
    client = undefined
    open?.close()
  }
  const connect = opts.connectFn ?? daemonClient.connectToDaemon
  try {
    const racePromise = (async (): Promise<DaemonCallOutcome<T>> => {
      const connected = await connect(opts.socketPath, {
        callTimeoutMs: opts.callTimeoutMs ?? opts.deadlineMs,
      })
      if (timedOut) {
        connected.close()
        return { kind: "timeout" }
      }
      client = connected
      try {
        return { kind: "ok", value: await fn(client) }
      } finally {
        closeClient()
      }
    })()
    const timeout = new Promise<DaemonCallOutcome<T>>((resolve) => {
      timeoutHandle = setTimeout(
        () => {
          timedOut = true
          closeClient()
          resolve({ kind: "timeout" })
        },
        Math.max(50, deadline - Date.now()),
      )
    })
    return await Promise.race([racePromise, timeout])
  } catch (err) {
    closeClient()
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ECONNREFUSED" || code === "ENOENT") return { kind: "no-daemon" }
    return { kind: "error", message: err instanceof Error ? err.message : String(err) }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}
